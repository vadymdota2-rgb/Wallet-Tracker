"""Скринер под нагрузкой и под атакой (npm test): маршрут /api/screener через
whale_api целиком, без сокета, и злые ответы источников.

- только подписчикам (403 без Премиума), один ответ на всех: готовые байты,
  ETag и «304», только на телефоне подписчика (private);
- запрос человека к Binance не ходит и сборку не начинает — даже с
  тысячами разных ?tf=; в память попадают только известные таймфреймы;
- в адрес Binance уходят только известные таймфреймы и тикеры из букв и
  цифр; ответ источника длиннее RESP_MAX, не-200, битый и вложенный бомбой
  JSON — «нет свечей», соединение — заново;
- огромный список монет и огромные свечи стоят немного.
"""
import io
import json
import os
import sys
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402
import wt_screen as sc  # noqa: E402

NOW = 1_794_100_000
GOOD = {"ok": True, "at": NOW, "tfs": ["15m"], "by": "Binance",
        "rows": [{"s": "BTC", "px": 1.0, "ch": 0.0, "vol": 1, "r": {"15m": [0.3, 0.2, 0.4, 50.0, 20.0, 1.0, 1.0, 2.0, -1.0, 0.5, 3]}}]}


def get(query: str = "", prem: bool = True, inm: str = "") -> tuple[int, dict, bytes, str]:
    """GET /api/screener (do_GET целиком): код, заголовки, тело, журнал."""
    h = api.Handler.__new__(api.Handler)
    extra = f"If-None-Match: {inm}\r\n" if inm else ""
    req = f"GET /api/screener{query} HTTP/1.1\r\nHost: x\r\nX-Api-Key: k\r\n{extra}\r\n".encode()
    h.rfile, h.wfile = io.BytesIO(req), io.BytesIO()
    h.client_address, h.request, h.close_connection = ("127.0.0.1", 1), None, True
    h.server = mock.Mock()
    with mock.patch.object(api, "API_KEY", "k"), mock.patch.object(api, "chat_premium", lambda chat: prem), \
            mock.patch.object(api.sys, "stderr", io.StringIO()) as err:
        h.handle_one_request()
    head, _, body = h.wfile.getvalue().partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    hdr = dict(x.split(": ", 1) for x in lines[1:] if ": " in x)
    return int(lines[0].split()[1]), hdr, body, err.getvalue()


class RouteTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(api._PUBLIC.pop, "screener", None)
        self.addCleanup(setattr, sc, "_st", sc._st)
        self.addCleanup(sc._src.update, dict(sc._src))
        sc._st = sc._State()
        sc._st.hit = GOOD
        self.asked: list = []

        def boom(*a):
            self.asked.append(a)
            raise AssertionError("запрос человека пошёл к Binance")

        sc.set_sources(universe=boom, klines=boom, futures=boom)
        p = mock.patch.object(sc, "_now", return_value=NOW)
        p.start()
        self.addCleanup(p.stop)

    def test_shared_bytes_etag_private_quiet(self):
        code, hdr, body, log = get("?tf=1m")
        self.assertEqual((code, json.loads(body)), (200, GOOD))
        self.assertEqual(hdr["Cache-Control"], "private, no-cache")
        self.assertTrue(hdr["ETag"].startswith('W/"'))
        self.assertNotIn("/api/screener", log)  # удачный ответ — без строки в журнале
        first = api._PUBLIC["screener"]
        get()
        self.assertIs(api._PUBLIC["screener"], first)  # те же байты — не кодируются заново
        code, _, body, _ = get(inm=hdr["ETag"])
        self.assertEqual((code, body), (304, b""))
        self.assertEqual(self.asked, [])
        self.assertIs(sc._st.job, None)  # и сборку не начал

    def test_subscribers_only(self):
        code, _, body, _ = get(prem=False)
        self.assertEqual((code, json.loads(body)), (403, {"ok": False, "error": "premium"}))
        self.assertNotIn("1m", sc._st.want)
        for path in ("/api/screener", "/screener"):
            self.assertIn(path, api.PAID_PATHS)

    def test_no_data(self):
        sc._st.hit = None
        code, _, body, log = get()
        self.assertEqual((code, json.loads(body)), (200, {"ok": False, "error": "no_data"}))
        self.assertIn('"GET /api/screener HTTP/1.1" 200', log)

    def test_tf_param_only_marks_known_timeframes(self):
        evil = ",".join(["1m", "../x", "<b>", "1M", "15m", "1h"] + ["x" * 50] * 1000)
        for q in (f"?tf={evil}", "?tf=" + "1m," * 10_000, "?tf=%00%ff", "?tf=1m&tf=1w", "?tf=" + "1w" + "," * 500 + "3d"):
            code, _, _, _ = get(q)
            self.assertIn(code, (200, 400, 414))  # слишком длинный адрес сервер отклоняет сам
        self.assertEqual(get("?tf=1m,zz,%3Cb%3E,1M,15m,1h," + ",".join(["x" * 10] * 5))[0], 200)
        # WARM не отмечаются, мусор — мимо, второй ?tf — мимо, дальше 120 знаков (3d) — мимо.
        self.assertEqual(set(sc._st.want), {"1m", "1M", "1w"})
        self.assertEqual(self.asked, [])
        for _ in range(2000):
            sc.want([f"{i}m" for i in range(100)])
        self.assertLessEqual(len(sc._st.want), len(sc.TFS))  # память не растёт от мусора

    def test_timeframes_beyond_the_120_chars_are_ignored(self):
        get("?tf=" + "x" * 119 + ",1w")
        self.assertNotIn("1w", sc._st.want)


class SourceTest(unittest.TestCase):
    def test_only_known_values_go_into_the_binance_address(self):
        urls: list = []
        with mock.patch.object(api, "_screen_get", side_effect=lambda path, *a: urls.append(path)), \
                mock.patch.object(api, "get_json", side_effect=lambda url, *a, **k: urls.append(url)):
            for base, tf in (("BTC", "1x"), ("../BTC", "1h"), ("BTC&limit=1000", "1h"), ("ВТС", "1h"), ("B" * 17, "1h"),
                             ("BTC", "1h&x=1"), ("", "1h"), ("BTC USDT", "1h"), ("BTC", "")):
                self.assertIsNone(api._screen_klines(base, tf))
                self.assertIsNone(api._screen_klines(base, tf, "f"))
            self.assertEqual(urls, [])
            api._screen_klines("1000SATS", "1M")
            api._screen_klines("NEW", "3d", "f")
        self.assertEqual(urls, [f"/api/v3/klines?symbol=1000SATSUSDT&interval=1M&limit={sc.BARS}",
                                f"{api.SCREEN_FUT}klines?symbol=NEWUSDT&interval=3d&limit={sc.FUT_BARS}"])
        self.assertLess(sc.FUT_BARS, 500)  # до 500 свечей — вес 2

    def test_bad_answers_are_none_and_reconnect(self):
        class Resp:
            def __init__(self, status, body):
                self.status, self._b = status, body

            def read(self, n=-1):
                return self._b if n < 0 else self._b[:n]

        made: list = []

        class Conn:
            def __init__(self, *a, **k):
                made.append(self)
                self.closed = False

            def request(self, *a, **k):
                if Conn.fail:
                    raise OSError("сеть")

            def getresponse(self):
                return Resp(*Conn.answer)

            def close(self):
                self.closed = True

        Conn.fail, Conn.answer = False, (200, b"[]")
        self.addCleanup(lambda: setattr(api._screen_tls, "conn", None))
        api._screen_tls.conn = None
        with mock.patch.object(api.http.client, "HTTPSConnection", Conn), \
                mock.patch.object(api.urllib.request, "getproxies", return_value={}):
            self.assertEqual(api._screen_get("/x"), [])
            api._screen_get("/x")
            self.assertEqual(len(made), 1)  # постоянное соединение
            for status, body in ((429, b"[]"), (418, b"{}"), (200, b"x" * (sc.RESP_MAX + 1)), (200, b"[" * 100_000),
                                 (200, b"{bad"), (200, b"\xff\xfe")):
                Conn.answer = (status, body)
                self.assertIsNone(api._screen_get("/x"), (status, body[:10]))
            Conn.fail = True
            self.assertIsNone(api._screen_get("/x"))
            self.assertTrue(made[-1].closed)  # сбой — соединение закрыто, следующее — новое
            Conn.fail, Conn.answer = False, (200, b"[1]")
            self.assertEqual(api._screen_get("/x"), [1])

    def test_huge_inputs_cost_little(self):
        tick = [{"symbol": f"C{i}USDT", "quoteVolume": str(i)} for i in range(200_000)]
        t0 = time.process_time()
        got = sc.parse_universe(tick, tick)
        self.assertLess(time.process_time() - t0, 3.0)
        self.assertEqual(len(got), sc.COINS_MAX)
        t0 = time.process_time()
        sc.parse_bars([[1, "1", "1", "1", "1", "1"]] * 2_000_000)
        self.assertLess(time.process_time() - t0, 2.0)  # разбираем только хвост BARS

    def test_nan_price_is_not_a_candle(self):
        good = [1, "1", "2", "0.5", "1.5", "10"]
        for i in range(1, 6):
            row = list(good)
            row[i] = "nan"
            self.assertEqual(sc.parse_bars([row]), [], i)
        self.assertEqual(len(sc.parse_bars([good])), 1)


if __name__ == "__main__":
    unittest.main()

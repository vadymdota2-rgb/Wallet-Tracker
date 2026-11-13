"""/api/markets через whale_api — целиком, без сокета (npm test).

Рынки в меню спрашивает каждый подписчик раз в минуту, пока меню открыто:
- ответ одинаковый для всех — кодируется раз на ответ модуля, с ETag;
  телефон с той же копией получает «304 не изменилось» без тела;
- хранится только на телефоне подписчика (private, no-cache): общий кэш
  по пути (прокси, CDN) не держит платные данные и не отдаёт другим;
- удачный ответ не пишет строку в журнал (это самый частый запрос меню —
  как у халвинга), «нет данных» — пишет;
- без Премиума — 403, данных нет.
"""
import io
import json
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модули лежат в корне репозитория

GOOD = {"ok": True, "at": 1_794_100_000, "items": [{"k": "GOLD", "px": 4066.2, "prev": 4079.9}]}


def get(reply: dict, prem: bool = True, inm: str = "") -> tuple[int, dict, bytes, str]:
    """GET /api/markets (do_GET целиком): код, заголовки, тело, журнал."""
    h = api.Handler.__new__(api.Handler)
    extra = f"If-None-Match: {inm}\r\n" if inm else ""
    req = f"GET /api/markets HTTP/1.1\r\nHost: x\r\nX-Api-Key: k\r\n{extra}\r\n".encode()
    h.rfile, h.wfile = io.BytesIO(req), io.BytesIO()
    h.client_address, h.request, h.close_connection = ("127.0.0.1", 1), None, True
    h.server = mock.Mock()
    with mock.patch.object(api, "markets_data", lambda: reply), mock.patch.object(api, "API_KEY", "k"), \
         mock.patch.object(api, "chat_premium", lambda chat: prem), \
         mock.patch.object(api.sys, "stderr", io.StringIO()) as err:
        h.handle_one_request()
    head, _, body = h.wfile.getvalue().partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    hdr = dict(x.split(": ", 1) for x in lines[1:] if ": " in x)
    return int(lines[0].split()[1]), hdr, body, err.getvalue()


class MarketsRouteTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(api._PUBLIC.pop, "markets", None)

    def test_good_answer_shared_bytes_etag_private_and_quiet(self):
        code, hdr, body, log = get(GOOD)
        self.assertEqual((code, json.loads(body)), (200, GOOD))
        self.assertEqual(hdr["Cache-Control"], "private, no-cache")
        self.assertTrue(hdr["ETag"].startswith('W/"'))
        self.assertNotIn("/api/markets", log)
        # Тот же ответ модуля — те же байты из памяти (не кодируется заново).
        first = api._PUBLIC["markets"]
        get(GOOD)
        self.assertIs(api._PUBLIC["markets"], first)
        # Телефон с той же копией — «304» без тела.
        code, hdr2, body, _ = get(GOOD, inm=hdr["ETag"])
        self.assertEqual((code, body), (304, b""))
        self.assertEqual(hdr2["ETag"], hdr["ETag"])

    def test_no_data_is_logged(self):
        code, _, body, log = get({"ok": False, "error": "no_data"})
        self.assertEqual((code, json.loads(body)), (200, {"ok": False, "error": "no_data"}))
        self.assertIn('"GET /api/markets HTTP/1.1" 200', log)

    def test_candles_route_shared_bytes_and_disk_copy(self):
        # /api/markets/candles — из памяти модуля, готовые байты и ETag; копия
        # своих свечей на диске переживает перезапуск, чужой файл не принимается.
        import tempfile  # noqa: PLC0415 — нужен только здесь

        import wt_markets as mk  # noqa: PLC0415
        day = 1_794_100_000 - 1_794_100_000 % 86400
        cand = {"ok": True, "at": 1_794_100_000, "days": {"GOLD": [[day - 86400, 4000.0, 4010.0, 3990.0, 4005.0],
                                                                  [day, 4005.0, 4020.0, 4000.0, 4010.0]]}}
        self.addCleanup(api._PUBLIC.pop, "markets_candles", None)
        h = api.Handler.__new__(api.Handler)
        req = b"GET /api/markets/candles HTTP/1.1\r\nHost: x\r\nX-Api-Key: k\r\n\r\n"
        h.rfile, h.wfile = io.BytesIO(req), io.BytesIO()
        h.client_address, h.request, h.close_connection = ("127.0.0.1", 1), None, True
        h.server = mock.Mock()
        with mock.patch.object(api, "markets_candles", lambda: cand), mock.patch.object(api, "API_KEY", "k"), \
             mock.patch.object(api, "chat_premium", lambda chat: True), mock.patch.object(api.sys, "stderr", io.StringIO()):
            h.handle_one_request()
        head, _, body = h.wfile.getvalue().partition(b"\r\n\r\n")
        self.assertIn(b" 200 ", head.split(b"\r\n")[0])
        self.assertIn(b"ETag: W/", head)
        self.assertEqual(json.loads(body), cand)
        for path in ("/api/markets/candles", "/markets/candles"):
            self.assertIn(path, api.PAID_PATHS)
        self.assertIs(api.markets_candles, mk.candles)
        own = {"ok": True, "days": cand["days"]}
        with tempfile.TemporaryDirectory() as d, mock.patch.object(api, "CACHE_DIR", d), \
                mock.patch.object(mk, "_st", mk._State()), mock.patch.object(mk, "_now", return_value=1_794_100_000):
            api.markets_disk_save(own)
            self.assertEqual(api.markets_disk_load(), 2)
            self.assertEqual(mk.days_snapshot(), own)
            api.markets_disk_save({"ok": False, "error": "no_data"})  # пустую не пишет поверх
            mk._st.days.clear()
            self.assertEqual(api.markets_disk_load(), 2)
            with open(os.path.join(d, api.MARKETS_DISK), "w", encoding="utf-8") as f:
                f.write("x" * (api.MARKETS_DISK_MAX + 1))
            mk._st.days.clear()
            self.assertEqual(api.markets_disk_load(), 0)  # чужой огромный файл — мимо
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            self.assertIn("markets_disk_load()", f.read().split("def wire(")[1][:3000])  # при запуске службы

    def test_for_subscribers_only(self):
        code, _, body, _ = get(GOOD, prem=False)
        self.assertEqual((code, json.loads(body)), (403, {"ok": False, "error": "premium"}))
        for path in ("/api/markets", "/markets"):
            self.assertIn(path, api.PAID_PATHS)


if __name__ == "__main__":
    unittest.main()

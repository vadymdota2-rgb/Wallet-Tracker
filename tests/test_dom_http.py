"""/api/dom и /api/mcap по HTTP: готовые байты и ETag (npm test).

Ответ одинаковый для всех и меняется раз в час (альтсезон — раз в сутки):
тот же объект из кэша модуля не кодируется на каждый запрос заново, а
телефон с той же копией получает «304 не изменилось» без тела.
"""
import gzip
import io
import json
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модули лежат в корне репозитория

REPLY = {"ok": True, "rows": [[1_700_000_000, 40, 101.5, 0.05, 60_000.0, 100]], "n": 100, "at": 1}


class Fake:
    """Обработчик без сокета: что отправлено — в sent."""

    def __init__(self, inm: str = "", enc: str = ""):
        self.h = api.Handler.__new__(api.Handler)
        self.h.headers = {k: v for k, v in (("If-None-Match", inm), ("Accept-Encoding", enc)) if v}
        self.h.wfile = io.BytesIO()
        self.code, self.hdr = 0, {}
        self.h.send_response = lambda c: setattr(self, "code", c)
        self.h.send_header = self.hdr.__setitem__
        self.h.end_headers = lambda: None
        self.h._cors = lambda: None

    def get(self, name, obj):
        self.h._json_public(name, obj)
        return self


class PublicJsonTest(unittest.TestCase):
    def setUp(self):
        api._PUBLIC.clear()

    def test_body_etag_and_revalidation(self):
        first = Fake().get("dom", REPLY)
        self.assertEqual(first.code, 200)
        self.assertEqual(json.loads(first.h.wfile.getvalue()), REPLY)
        tag = first.hdr["ETag"]
        self.assertRegex(tag, r'^W/"[0-9a-f]{24}"$')
        self.assertEqual(first.hdr["Cache-Control"], "private, no-cache")
        self.assertEqual(first.hdr["Content-Length"], str(len(first.h.wfile.getvalue())))
        # Та же копия у телефона — 304 без тела (и без длины тела).
        again = Fake(f'"x", {tag}').get("dom", REPLY)
        self.assertEqual(again.code, 304)
        self.assertEqual(again.h.wfile.getvalue(), b"")
        self.assertNotIn("Content-Length", again.hdr)
        self.assertEqual(again.hdr["ETag"], tag)
        # Чужая или старая — полный ответ.
        self.assertEqual(Fake('W/"old"').get("dom", REPLY).code, 200)

    def test_same_object_is_encoded_once_new_one_again(self):
        top = []
        real = api._json_clean
        with mock.patch.object(api, "_json_clean", side_effect=lambda o: (top.append(o) if o is REPLY or o is fresh else None, real(o))[1]):
            fresh = {**REPLY, "at": 2}
            Fake().get("mcap", REPLY)
            Fake().get("mcap", REPLY)
            self.assertEqual(len([o for o in top if o is REPLY]), 1)
            got = Fake().get("mcap", fresh)
            self.assertEqual(len([o for o in top if o is fresh]), 1)
        self.assertEqual(json.loads(got.h.wfile.getvalue())["at"], 2)
        # Новый ответ — новый ETag: старая копия телефона больше не «та же».
        self.assertNotEqual(got.hdr["ETag"], Fake().get("mcap", REPLY).hdr["ETag"])

    def test_dom_and_mcap_do_not_share_a_slot(self):
        a, b = Fake().get("dom", REPLY), Fake().get("mcap", {"ok": False, "error": "no_key"})
        self.assertNotEqual(a.hdr["ETag"], b.hdr["ETag"])
        self.assertEqual(Fake(a.hdr["ETag"]).get("dom", REPLY).code, 304)

    def test_nan_never_leaves_the_server(self):
        got = Fake().get("dom", {"ok": True, "v": float("nan"), "w": float("inf")})
        self.assertEqual(json.loads(got.h.wfile.getvalue()), {"ok": True, "v": 0.0, "w": 0.0})

    def test_gzip_is_compressed_once_and_sent_only_to_who_accepts_it(self):
        big = {**REPLY, "rows": REPLY["rows"] * 400}
        with mock.patch.object(api.gzip, "compress", wraps=gzip.compress) as comp:
            z = Fake(enc="br, gzip;q=0.8").get("etf", big)
            Fake(enc="gzip").get("etf", big)
            # Сжатие — одно на сводку, не на каждого человека.
            self.assertEqual(comp.call_count, 1)
        body = z.h.wfile.getvalue()
        self.assertEqual(z.hdr["Content-Encoding"], "gzip")
        self.assertEqual(z.hdr["Content-Length"], str(len(body)))
        self.assertEqual(z.hdr["Vary"], "Accept-Encoding")
        self.assertEqual(json.loads(gzip.decompress(body)), big)
        self.assertLess(len(body), len(json.dumps(big)) // 4)
        # Без gzip, с gzip;q=0 или с чужим сжатием — обычный JSON.
        for enc in ("", "identity", "gzip;q=0", "br", "gzip;q=x"):
            p = Fake(enc=enc).get("etf", big)
            self.assertNotIn("Content-Encoding", p.hdr, enc)
            self.assertEqual(p.hdr["Vary"], "Accept-Encoding")
            self.assertEqual(json.loads(p.h.wfile.getvalue()), big, enc)
        self.assertIn("Content-Encoding", Fake(enc="*").get("etf", big).hdr)
        # ETag у обоих один: телефон со сжатой копией тоже получает 304.
        self.assertEqual(p.hdr["ETag"], z.hdr["ETag"])
        again = Fake(z.hdr["ETag"], enc="gzip").get("etf", big)
        self.assertEqual((again.code, again.h.wfile.getvalue()), (304, b""))
        self.assertNotIn("Content-Encoding", again.hdr)
        # Те же данные — те же сжатые байты (без даты сжатия внутри).
        api._PUBLIC.clear()
        with mock.patch.object(gzip.time, "time", return_value=4_000_000_000.0):
            self.assertEqual(Fake(enc="gzip").get("etf", big).h.wfile.getvalue(), body)

    def test_good_public_answer_is_not_logged_twice_errors_are(self):
        # Обращение пишет nginx; строка на каждое открытие экрана в journald —
        # гигабайты при миллионах людей. Ошибки — по-прежнему в журнал.
        h = api.Handler.__new__(api.Handler)
        h.requestline, h.client_address = "GET /api/etf HTTP/1.1", ("127.0.0.1", 1)
        with mock.patch.object(api.sys, "stderr", io.StringIO()) as err:
            h._quiet = True
            h.log_request(200)
            self.assertEqual(err.getvalue(), "")
            h.log_request(500)
            self.assertIn('"GET /api/etf HTTP/1.1" 500', err.getvalue())
            # Флаг — на один ответ: следующий удачный пишется как обычно.
            h.log_request(200)
            self.assertIn('"GET /api/etf HTTP/1.1" 200', err.getvalue())
            # Сбой при тихом флаге — всё равно в журнал.
            h._quiet = True
            h.log_request(500)
            self.assertEqual(err.getvalue().count('" 500'), 2)
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            src = f.read()
        body = src.split("    def _json_public(")[1].split("\n    def ")[0]
        self.assertLess(body.index("self._quiet = True"), body.index("self.send_response(304 if same else 200)"))
        self.assertNotIn("_quiet = True", src.replace(body, ""))

    def test_signature_is_checked_once_per_request(self):
        h = api.Handler.__new__(api.Handler)
        h.headers = {"X-Telegram-Init-Data": "x"}
        t = [100]
        with mock.patch.object(api, "verify_init_data", return_value={"id": "7"}) as v, \
             mock.patch.object(api, "now", lambda: t[0]):
            self.assertEqual((h._user({}), h._rate_key({})), ("7", "u:7"))
            self.assertEqual(v.call_count, 1)
            # Следующая секунда (тот же keep-alive) — проверка заново: срок подписи по часам.
            t[0] += 1
            h._user({})
            self.assertEqual(v.call_count, 2)
            # Другая подпись — другой ответ.
            v.return_value = None
            h.headers = {"X-Telegram-Init-Data": "y"}
            self.assertEqual(h._user({}), "")

    def test_dominance_and_altseason_are_for_subscribers_only(self):
        # Экран без Премиума закрыт, а доминация CoinMarketCap — данные внутри
        # продукта: без подписки ни /api/dom, ни /api/mcap не отдаются.
        def get(path, prem):
            h = api.Handler.__new__(api.Handler)
            req = f"GET {path} HTTP/1.1\r\nHost: x\r\nX-Api-Key: k\r\n\r\n".encode()
            h.rfile, h.wfile = io.BytesIO(req), io.BytesIO()
            h.client_address, h.request, h.close_connection = ("127.0.0.1", 1), None, True
            h.server = mock.Mock()
            with mock.patch.object(api, "API_KEY", "k"), mock.patch.object(api, "chat_premium", lambda chat: prem), \
                 mock.patch.object(api, "dom_data", lambda: REPLY), mock.patch.object(api, "mcap_data", lambda: REPLY), \
                 mock.patch.object(api.sys, "stderr", io.StringIO()):
                h.handle_one_request()
            head, _, body = h.wfile.getvalue().partition(b"\r\n\r\n")
            return int(head.split()[1]), body
        for path in ("/api/dom", "/api/mcap", "/dom", "/mcap"):
            self.assertIn(path, api.PAID_PATHS)
            code, body = get(path, False)
            self.assertEqual((code, json.loads(body)), (403, {"ok": False, "error": "premium"}), path)
            code, body = get(path, True)
            self.assertEqual((code, json.loads(body)), (200, REPLY), path)

    def test_routes_use_the_shared_bytes(self):
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('self._json_public("dom" if dom else "mcap", dom_data() if dom else mcap_data())', src)
        # /api/etf — самый большой общий ответ: тоже готовыми байтами.
        self.assertIn('self._json_public("etf", etf_data())', src)


if __name__ == "__main__":
    unittest.main()

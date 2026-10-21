"""/api/dom и /api/mcap по HTTP: готовые байты и ETag (npm test).

Ответ одинаковый для всех и меняется раз в час (альтсезон — раз в сутки):
тот же объект из кэша модуля не кодируется на каждый запрос заново, а
телефон с той же копией получает «304 не изменилось» без тела.
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

REPLY = {"ok": True, "rows": [[1_700_000_000, 40, 101.5, 0.05, 60_000.0, 100]], "n": 100, "at": 1}


class Fake:
    """Обработчик без сокета: что отправлено — в sent."""

    def __init__(self, inm: str = ""):
        self.h = api.Handler.__new__(api.Handler)
        self.h.headers = {"If-None-Match": inm} if inm else {}
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
        self.assertEqual(first.hdr["Cache-Control"], "no-cache")
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

    def test_routes_use_the_shared_bytes(self):
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('self._json_public("dom" if dom else "mcap", dom_data() if dom else mcap_data())', src)


if __name__ == "__main__":
    unittest.main()

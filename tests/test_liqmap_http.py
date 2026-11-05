"""/api/liqmap по HTTP: готовые байты, ETag и «304», ограниченный запас (npm test).

Карта одна для всех (монета × окно) и меняется вместе с ценой: тот же ответ
не кодируется на каждый запрос заново, телефон с той же копией получает
«304 не изменилось» без тела, а готовых байтов в памяти — не больше
PUBLIC_LIQ_MAX: монет сотни, общий запас рос бы без конца.
"""
import gzip
import io
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модули лежат в корне репозитория


def reply(sym="BTC", px=100.0):
    return {"ok": True, "sym": sym, "range": "1d", "px": px, "step": 0.25, "lo": 0.0, "ex": ["OKX"],
            "levs": [10, 25, 50, 100, 500], "buckets": [{"p": 99.0, "L": [1, 0, 0, 0, 0], "S": [0, 0, 0, 0, 0]}],
            "cum": {"2": {"L": 1, "S": 0}}, "path": [px], "oi": 10, "seen": 1, "ohlc": [[px, px, px, px]], "at": 1}


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

    def get(self, res):
        """Как маршрут /api/liqmap: удачная карта — готовыми байтами, ошибка — обычным ответом."""
        if res.get("ok"):
            self.h._json_public(f"liqmap:{res['sym']}:{res['range']}", res, api._PUBLIC_LIQ, api.PUBLIC_LIQ_MAX)
        else:
            self.h._json(200, res)
        return self


class LiqHttpTest(unittest.TestCase):
    def setUp(self):
        api._PUBLIC_LIQ.clear()

    def test_body_etag_revalidation_and_gzip(self):
        r = reply()
        first = Fake().get(r)
        self.assertEqual(first.code, 200)
        self.assertEqual(json.loads(first.h.wfile.getvalue()), r)
        tag = first.hdr["ETag"]
        self.assertEqual(first.hdr["Cache-Control"], "private, no-cache")
        again = Fake(tag).get(r)
        self.assertEqual((again.code, again.h.wfile.getvalue()), (304, b""))
        # Цена сменилась — новый ответ, новый ETag.
        moved = Fake(tag).get(reply(px=101.0))
        self.assertEqual(moved.code, 200)
        self.assertNotEqual(moved.hdr["ETag"], tag)
        z = Fake(enc="gzip, br").get(r)
        self.assertEqual(z.hdr["Content-Encoding"], "gzip")
        self.assertEqual(json.loads(gzip.decompress(z.h.wfile.getvalue())), r)

    def test_store_is_bounded_and_oldest_goes_first(self):
        for i in range(api.PUBLIC_LIQ_MAX + 30):
            Fake().get(reply(sym=f"C{i}"))
        self.assertEqual(len(api._PUBLIC_LIQ), api.PUBLIC_LIQ_MAX)
        self.assertNotIn("liqmap:C0:1d", api._PUBLIC_LIQ)
        self.assertIn(f"liqmap:C{api.PUBLIC_LIQ_MAX + 29}:1d", api._PUBLIC_LIQ)
        self.assertFalse(any(k.startswith("liqmap:") for k in api._PUBLIC))  # общий запас не тронут

    def test_route_uses_the_bounded_store_and_errors_are_not_kept(self):
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            src = f.read()
        route = src.split('if path in ("/liqmap", "/api/liqmap"):')[1].split("return")[0]
        self.assertIn('self._json_public(f"liqmap:{res[\'sym\']}:{res[\'range\']}", res, _PUBLIC_LIQ, PUBLIC_LIQ_MAX)', route)
        self.assertIn('if res.get("ok"):', route)
        Fake().get({"ok": False, "error": "no_data"})
        self.assertEqual(api._PUBLIC_LIQ, {})


if __name__ == "__main__":
    unittest.main()

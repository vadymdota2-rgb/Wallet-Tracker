"""/api/halving через whale_api: удачный ответ — без строки в journald (npm test).

Карточка халвинга внизу меню у всех: это самый частый запрос приложения.
Обращение и так пишет nginx; строка API на каждый запрос при миллионах
людей — сотни мегабайт одинаковых строк в день. «Нет данных» и сбои — в
журнал, как раньше.
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

GOOD = {"ok": True, "height": 900_000, "next": 1_050_000, "every": 210_000, "avg": 600.0, "src": "epoch",
        "tip": 1_790_000_000, "eta": 1_880_000_000, "at": 1_790_000_100, "now": 1_790_000_120}


def get(reply: dict) -> tuple[int, dict, str]:
    """GET /api/halving целиком (do_GET), без сокета: код, тело, журнал."""
    h = api.Handler.__new__(api.Handler)
    req = b"GET /api/halving HTTP/1.1\r\nHost: x\r\nX-Api-Key: k\r\n\r\n"
    h.rfile, h.wfile = io.BytesIO(req), io.BytesIO()
    h.client_address, h.request, h.close_connection = ("127.0.0.1", 1), None, True
    h.server = mock.Mock()
    with mock.patch.object(api.halving, "reply", return_value=reply), mock.patch.object(api, "API_KEY", "k"), \
         mock.patch.object(api.sys, "stderr", io.StringIO()) as err:
        h.handle_one_request()
    head, _, body = h.wfile.getvalue().partition(b"\r\n\r\n")
    return int(head.split()[1]), json.loads(body), err.getvalue()


class HalvingRouteLogTest(unittest.TestCase):
    def test_good_answer_is_sent_but_not_logged(self):
        code, body, log = get(GOOD)
        self.assertEqual((code, body), (200, GOOD))
        self.assertNotIn("/api/halving", log)

    def test_no_data_is_still_logged(self):
        code, body, log = get({"ok": False, "error": "no_data"})
        self.assertEqual((code, body["ok"]), (200, False))
        self.assertIn('"GET /api/halving HTTP/1.1" 200', log)

    def test_quiet_flag_never_hides_a_failure(self):
        h = api.Handler.__new__(api.Handler)
        h.requestline, h.client_address = "GET /api/halving HTTP/1.1", ("127.0.0.1", 1)
        with mock.patch.object(api.sys, "stderr", io.StringIO()) as err:
            h._quiet = True
            h.log_request(500)
            self.assertIn('"GET /api/halving HTTP/1.1" 500', err.getvalue())
            # Флаг — на один ответ: следующий пишется как обычно.
            h.log_request(200)
            self.assertEqual(err.getvalue().count("/api/halving"), 2)
            h._quiet = True
            h.log_request(304)
            self.assertEqual(err.getvalue().count("/api/halving"), 2)


if __name__ == "__main__":
    unittest.main()

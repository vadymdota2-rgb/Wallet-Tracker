"""Человек ушёл, не дождавшись ответа (whale_api.Handler._fail): npm test.

BrokenPipeError и сброс соединения — не сбой сервера: приложение закрыли,
или nginx оборвал запрос. Раньше это шло в журнал как «GET fail #…», и
сервер пытался отправить 500 в уже закрытое соединение.
"""
import io
import unittest
from unittest import mock

import whale_api as api


def handler(path: str) -> api.Handler:
    h = api.Handler.__new__(api.Handler)
    h.path = path
    h.close_connection = False
    return h


class DisconnectTest(unittest.TestCase):
    def test_client_gone_is_one_quiet_line_without_reply(self):
        for err in (BrokenPipeError(32, "Broken pipe"), ConnectionResetError(104, "reset"), ConnectionAbortedError()):
            h = handler("/api/halving?init=query_id%3Dsecret&tg=1")
            with mock.patch.object(h, "_json", side_effect=AssertionError("ответ в закрытое соединение")), \
                    mock.patch("sys.stderr", new_callable=io.StringIO) as log:
                h._fail(err, "GET")
            line = log.getvalue()
            self.assertEqual(line, "[api] GET: клиент ушёл, не дождавшись ответа: /api/halving\n")
            self.assertNotIn("secret", line)  # строка запроса с подписью Telegram — не в журнал
            self.assertTrue(h.close_connection)

    def test_real_failure_is_still_logged_and_answered(self):
        h = handler("/api/halving")
        with mock.patch.object(h, "_json") as reply, mock.patch("sys.stderr", new_callable=io.StringIO) as log:
            h._fail(ValueError("boom"), "GET")
        self.assertIn("[api] GET fail #", log.getvalue())
        self.assertEqual(reply.call_args[0][0], 500)


if __name__ == "__main__":
    unittest.main()

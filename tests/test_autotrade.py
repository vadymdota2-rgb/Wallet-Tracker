"""Автокопирование китов — закрытый модуль владельца (wt_autotrade, маршруты API).

Вкладка и её данные — только владельцу: чужому (даже с верной подписью) —
тот же 404, что у несуществующего адреса, и строка «[AUTO] чужой запрос» в
журнал; поле owner в /api/me — только у владельца. Ночной прогон: удачный
итог становится latest, неудачный — не портит прежний; второй прогон,
пока идёт первый, не начинается; бэктест зовётся с паузой между запросами и
кешем вне каталога бота.
"""
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api
import wt_autotrade as at

OWNER = "546348566"
SUMMARY = {"verdict": False, "top": [], "full": None, "equity": [], "trades": []}


def request(method: str, path: str, chat: str) -> tuple[int, dict, str]:
    """Запрос целиком через Handler, без сокета: код, тело, журнал."""
    h = api.Handler.__new__(api.Handler)
    body = b"{}" if method == "POST" else b""
    req = (f"{method} {path} HTTP/1.1\r\nHost: x\r\nX-Api-Key: k\r\nX-Telegram-Init-Data: sig\r\n"
           f"Content-Length: {len(body)}\r\n\r\n").encode() + body
    h.rfile, h.wfile = io.BytesIO(req), io.BytesIO()
    h.client_address, h.request, h.close_connection = ("127.0.0.1", 1), None, True
    h.server = mock.Mock()
    out = io.StringIO()
    with mock.patch.object(api, "API_KEY", "k"), mock.patch.object(api, "OWNER_CHAT_ID", OWNER), \
            mock.patch.object(api.Handler, "_user", lambda _self, _qs: chat), \
            mock.patch.object(api.autotrade, "status", return_value={"ok": True, "backtest": SUMMARY}), \
            mock.patch.object(api.autotrade, "trigger", return_value={"ok": True, "started": True}) as trig, \
            mock.patch.object(api.sys, "stderr", io.StringIO()), mock.patch("sys.stdout", out):
        h.handle_one_request()
    head, _, raw = h.wfile.getvalue().partition(b"\r\n\r\n")
    request.triggered = trig.call_count  # type: ignore[attr-defined]
    return int(head.split()[1]), json.loads(raw), out.getvalue()


class OwnerOnlyTest(unittest.TestCase):
    def test_owner_sees_stats(self):
        code, body, _ = request("GET", "/api/owner/autotrade", OWNER)
        self.assertEqual((code, body["backtest"]), (200, SUMMARY))

    def test_stranger_gets_plain_404_and_a_log_line(self):
        for chat in ("123", "5463485660", " " + OWNER):
            code, body, log = request("GET", "/api/owner/autotrade", chat)
            self.assertEqual((code, body), (404, {"ok": False, "error": "not_found"}))
            self.assertIn("[AUTO] чужой запрос /api/owner/autotrade", log)
        # Без подписи — тоже 404 (как неизвестный адрес), без строки: подписи нет — некого записать.
        code, body, log = request("GET", "/api/owner/autotrade", "")
        self.assertEqual((code, body), (404, {"ok": False, "error": "not_found"}))
        self.assertEqual(log, "")
        # Ответ чужому неотличим от несуществующего адреса.
        self.assertEqual(request("GET", "/api/owner/nothing", "123")[:2], (404, {"ok": False, "error": "not_found"}))

    def test_run_now_only_for_owner(self):
        code, _, _ = request("POST", "/api/owner/autotrade/run", "123")
        self.assertEqual((code, request.triggered), (404, 0))  # type: ignore[attr-defined]
        code, body, _ = request("POST", "/api/owner/autotrade/run", OWNER)
        self.assertEqual((code, body["started"], request.triggered), (200, True, 1))  # type: ignore[attr-defined]

    def test_owner_flag_only_for_owner(self):
        with mock.patch.object(api, "OWNER_CHAT_ID", OWNER):
            self.assertTrue(api.is_owner(OWNER))
            for chat in ("", "1", OWNER + "0"):
                self.assertFalse(api.is_owner(chat))
        with mock.patch.object(api, "OWNER_CHAT_ID", ""):
            self.assertFalse(api.is_owner(""))


class NightlyRunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ws = os.path.join(self.tmp.name, "WhaleScanner")
        os.makedirs(os.path.join(self.ws, "tools"))
        open(at.script_path(self.ws), "w").close()
        self.db = os.path.join(self.ws, "hyperliquid.db")
        open(self.db, "w").close()
        self.data = os.path.join(self.tmp.name, "data")

    def tearDown(self):
        self.tmp.cleanup()

    def fake(self, verdict: bool, code: int = 0):
        calls = []

        def runner(cmd, **kw):
            calls.append((cmd, kw))
            out = cmd[cmd.index("--out") + 1]
            if code == 0:
                os.makedirs(out, exist_ok=True)
                with open(os.path.join(out, "summary.json"), "w", encoding="utf-8") as f:
                    json.dump({**SUMMARY, "verdict": verdict}, f)
            return subprocess.CompletedProcess(cmd, code)

        return runner, calls

    def test_success_becomes_latest_failure_keeps_it(self):
        runner, calls = self.fake(True)
        self.assertTrue(at.run_once(self.ws, self.db, self.data, runner))
        self.assertTrue(at.latest(self.data)["verdict"])
        cmd, kw = calls[0]
        self.assertIn("-I", cmd)
        self.assertEqual(cmd[cmd.index("--pause") + 1], str(at.PAUSE_SEC))
        cache = cmd[cmd.index("--cache") + 1]
        self.assertFalse(os.path.realpath(cache).startswith(os.path.realpath(self.ws)))
        self.assertEqual(kw["timeout"], at.RUN_TIMEOUT_SEC)
        # Следующий — неудачный: прежний итог на месте, причина — в состоянии.
        runner, _ = self.fake(False, code=2)
        with mock.patch("sys.stdout", io.StringIO()):
            self.assertFalse(at.run_once(self.ws, self.db, self.data, runner))
        self.assertTrue(at.latest(self.data)["verdict"])
        self.assertIn("кодом 2", at.status(self.data)["error"])
        # Удачный — становится latest, прежний уходит в prev.
        runner, _ = self.fake(False)
        self.assertTrue(at.run_once(self.ws, self.db, self.data, runner))
        self.assertFalse(at.latest(self.data)["verdict"])
        self.assertTrue(os.path.isfile(os.path.join(self.data, "prev", "summary.json")))
        self.assertEqual(at.status(self.data)["error"], "")

    def test_no_script_or_db_is_an_error_not_a_crash(self):
        os.remove(at.script_path(self.ws))
        with mock.patch("sys.stdout", io.StringIO()):
            self.assertFalse(at.run_once(self.ws, self.db, self.data, self.fake(True)[0]))
        self.assertIsNone(at.latest(self.data))
        self.assertIn("нет скрипта", at.status(self.data)["error"])

    def test_one_run_at_a_time(self):
        with at._lock:
            at._state["running"] = True
        try:
            runner, calls = self.fake(True)
            self.assertFalse(at.run_once(self.ws, self.db, self.data, runner))
            self.assertEqual(calls, [])
            self.assertFalse(at.trigger(self.ws, self.db, self.data)["started"])
        finally:
            with at._lock:
                at._state["running"] = False

    def test_garbage_summary_is_none(self):
        os.makedirs(os.path.join(self.data, "latest"))
        for raw in ("", "[1]", "{bad"):
            with open(os.path.join(self.data, "latest", "summary.json"), "w") as f:
                f.write(raw)
            self.assertIsNone(at.latest(self.data))

    def test_next_run_is_nightly_utc(self):
        day = 1_800_000_000 // 86400 * 86400
        at_ = day + at.RUN_HOUR_UTC * 3600 + at.RUN_MINUTE * 60
        self.assertEqual(at.next_run(day), at_)
        self.assertEqual(at.next_run(at_), at_ + 86400)
        self.assertEqual(at.next_run(at_ - 1), at_)


if __name__ == "__main__":
    unittest.main()

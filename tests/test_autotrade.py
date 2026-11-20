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
            mock.patch.object(api.autotrade, "start_cmd", return_value={"ok": True, "on": True}) as on, \
            mock.patch.object(api.autotrade, "stop_cmd", return_value={"ok": True, "on": False}) as off, \
            mock.patch.object(api.sys, "stderr", io.StringIO()), mock.patch("sys.stdout", out):
        h.handle_one_request()
    head, _, raw = h.wfile.getvalue().partition(b"\r\n\r\n")
    request.triggered = trig.call_count  # type: ignore[attr-defined]
    request.switched = (on.call_count, off.call_count)  # type: ignore[attr-defined]
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

    def test_start_stop_only_for_owner(self):
        for path in ("/api/owner/autotrade/start", "/api/owner/autotrade/stop"):
            code, body, log = request("POST", path, "123")
            self.assertEqual((code, body, request.switched), (404, {"ok": False, "error": "not_found"}, (0, 0)))  # type: ignore[attr-defined]
            self.assertIn("[AUTO] чужой запрос", log)
        code, body, _ = request("POST", "/api/owner/autotrade/start", OWNER)
        self.assertEqual((code, body["on"], request.switched), (200, True, (1, 0)))  # type: ignore[attr-defined]
        code, body, _ = request("POST", "/api/owner/autotrade/stop", OWNER)
        self.assertEqual((code, body["on"], request.switched), (200, False, (0, 1)))  # type: ignore[attr-defined]

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
        at._set_on(True, self.data)

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
        self.assertEqual(cmd[cmd.index("--max-mem-mb") + 1], str(at.MAX_MEM_MB))
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

    def test_memory_cap_is_reported(self):
        runner, _ = self.fake(True, code=3)
        with mock.patch("sys.stdout", io.StringIO()):
            self.assertFalse(at.run_once(self.ws, self.db, self.data, runner))
        self.assertIn("предела памяти", at.status(self.data)["error"])

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

    def test_live_trading_state_and_stats(self):
        # Службы реальной торговли нет — live нет, этап — бэктест.
        self.assertIsNone(at.live(self.data))
        self.assertEqual(at.status(self.data)["stage"], "backtest")
        d = os.path.join(self.data, "live")
        os.makedirs(d, exist_ok=True)
        now = 1_800_000_000
        st = {"heartbeat": now * 1000 - 30_000, "simulated": False, "equity": 10_088.5, "error": "",
              "open": {"inst": "ETH-USDT-SWAP", "side": -1, "px": 3000, "tp": 2970, "upl": -12.0},
              "positions": [{"instId": "ETH-USDT-SWAP", "pos": "-3"}], "events": [f"e{i}" for i in range(30)]}
        with open(os.path.join(d, "state.json"), "w") as f:
            json.dump(st, f)
        with open(os.path.join(d, "trades.jsonl"), "w") as f:
            f.writelines(json.dumps({"coin": "BTC", "pnl": p, "opened": (now - 86_400 * 2) * 1000 + i,
                                     "closed": (now - 86_400) * 1000 + i, "fee": -9, "funding": -1}) + "\n"
                         for i, p in enumerate([77.0, 77.0, -270.0, 77.0]))
            f.write("испорчено\n")
        lv = at.live(self.data, now=now)
        self.assertTrue(lv["alive"])
        self.assertFalse(lv["simulated"])
        s = lv["stats"]
        self.assertEqual((s["trades"], s["wins"], s["win_pct"], s["net"], s["max_dd"]), (4, 3, 75.0, -39.0, 270.0))
        self.assertAlmostEqual(s["pf"], 231 / 270, places=3)
        self.assertEqual((s["per_day"], s["fees"], s["funding"]), (2.0, -36.0, -4.0))
        self.assertEqual(len(lv["events"]), 20)
        self.assertEqual(lv["open"]["inst"], "ETH-USDT-SWAP")
        self.assertEqual(at.status(self.data)["stage"], "live")
        self.assertFalse(at.live(self.data, now=now + 600)["alive"])  # служба молчит 10 минут — не жива
        # В ответе — ни одного ключа: их в каталоге модуля нет по устройству.
        self.assertNotIn("OKX_API", json.dumps(at.status(self.data)))

    def test_switch_is_off_by_default_and_persists(self):
        other = os.path.join(self.tmp.name, "fresh")
        self.assertFalse(at.is_on(other))
        self.assertFalse(at.status(other)["on"])
        self.assertEqual(at.trigger(self.ws, self.db, other), {"ok": False, "error": "stopped"})
        os.makedirs(other)
        with open(os.path.join(other, "switch.json"), "w") as f:
            f.write("{bad")
        self.assertFalse(at.is_on(other))
        with mock.patch("sys.stdout", io.StringIO()):
            at.stop_cmd(self.data)
        self.assertFalse(at.is_on(self.data))
        with mock.patch.object(at, "trigger") as trig, mock.patch("sys.stdout", io.StringIO()):
            self.assertTrue(at.start_cmd(self.ws, self.db, self.data)["on"])
            trig.assert_called_once()  # итога ещё нет — сразу пересчёт
        self.assertTrue(at.is_on(self.data))

    def test_unwritable_dir_is_a_reason_not_a_crash(self):
        # На сервере у whale-api домашний каталог только на чтение: кнопка
        # должна получить причину, а не 500 («нет связи» в приложении).
        out = io.StringIO()
        with mock.patch.object(at, "_set_on", side_effect=PermissionError(13, "Read-only file system")), \
                mock.patch("sys.stdout", out):
            for got in (at.start_cmd(self.ws, self.db, self.data), at.stop_cmd(self.data)):
                self.assertEqual((got["ok"], got["error"]), (False, "no_write"))
        self.assertIn("[AUTO] старт: не записать", out.getvalue())

    def test_default_dir_is_next_to_api_not_home(self):
        # whale-api может писать только в ReadWritePaths — каталог API среди них.
        self.assertTrue(os.environ.get("WT_AUTOTRADE_DIR") or at.DATA_DIR.startswith(ROOT + os.sep))
        with open(os.path.join(ROOT, "whale-api.service"), encoding="utf-8") as f:
            unit = f.read()
        rw = next(ln for ln in unit.splitlines() if ln.startswith("ReadWritePaths="))
        self.assertIn("/WalletTracker", rw)
        mem = next(ln for ln in unit.splitlines() if ln.startswith("MemoryMax="))
        self.assertLess(at.MAX_MEM_MB, int(mem.split("=")[1].rstrip("M")))

    def test_stop_interrupts_a_running_backtest(self):
        """«Стоп» посреди пересчёта: процесс прерван, итог не подменён,
        причина — «остановлено»."""
        runner, _ = self.fake(True)
        self.assertTrue(at.run_once(self.ws, self.db, self.data, runner))
        killed = []

        class Proc:
            def terminate(self):
                killed.append(True)

        def slow(cmd, **kw):
            with at._lock:
                at._state["proc"] = Proc()
            with mock.patch("sys.stdout", io.StringIO()):
                at.stop_cmd(self.data)
            with at._lock:
                at._state["proc"] = None
            out = cmd[cmd.index("--out") + 1]
            os.makedirs(out, exist_ok=True)
            with open(os.path.join(out, "summary.json"), "w", encoding="utf-8") as f:
                json.dump({**SUMMARY, "verdict": False}, f)
            return subprocess.CompletedProcess(cmd, -15)

        with mock.patch("sys.stdout", io.StringIO()):
            self.assertFalse(at.run_once(self.ws, self.db, self.data, slow))
        self.assertEqual(killed, [True])
        self.assertTrue(at.latest(self.data)["verdict"])
        self.assertIn("Стоп", at.status(self.data)["error"])

    def test_real_process_runner(self):
        """_popen — настоящий процесс: код возврата и тайм-аут."""
        r = at._popen([sys.executable, "-c", "raise SystemExit(3)"], stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL, timeout=30, check=False)
        self.assertEqual(r.returncode, 3)
        with self.assertRaises(subprocess.TimeoutExpired):
            at._popen([sys.executable, "-c", "import time; time.sleep(30)"], stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL, timeout=0.5, check=False)
        self.assertIsNone(at._state["proc"])

    def test_next_run_is_nightly_utc(self):
        day = 1_800_000_000 // 86400 * 86400
        at_ = day + at.RUN_HOUR_UTC * 3600 + at.RUN_MINUTE * 60
        self.assertEqual(at.next_run(day), at_)
        self.assertEqual(at.next_run(at_), at_ + 86400)
        self.assertEqual(at.next_run(at_ - 1), at_)


if __name__ == "__main__":
    unittest.main()

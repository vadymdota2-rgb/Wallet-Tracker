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
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — после sys.path
import wt_autotrade as at  # noqa: E402

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


class ModuleFilesTest(unittest.TestCase):
    """API сам ничего не считает: «Пересчитать» — запрос службе
    whale-autotrade (run.request), ход пересчёта — из её backtest_status.json."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = os.path.join(self.tmp.name, "data")
        at._set_on(True, self.data)

    def tearDown(self):
        self.tmp.cleanup()

    def test_run_now_is_a_request_to_the_service(self):
        req = os.path.join(self.data, "run.request")
        with mock.patch("sys.stdout", io.StringIO()):
            self.assertEqual(at.trigger(data_dir=self.data), {"ok": True, "running": True, "started": True})
        self.assertTrue(os.path.isfile(req))
        self.assertTrue(at.status(self.data)["running"])  # запрос подан — вкладка видит «считается»
        os.remove(req)
        with open(os.path.join(self.data, "backtest_status.json"), "w") as f:
            json.dump({"running": True, "started": 100, "next": 200, "error": ""}, f)
        self.assertFalse(at.trigger(data_dir=self.data)["started"])  # уже идёт — второго нет
        st = at.status(self.data)
        self.assertEqual((st["running"], st["started"], st["next"]), (True, 100, 200))
        with open(os.path.join(self.data, "backtest_status.json"), "w") as f:
            json.dump({"running": True, "started": 100, "next": 200, "error": "", "progress": "повтор: 40 %"}, f)
        self.assertEqual(at.status(self.data)["progress"], "повтор: 40 %", "ход пересчёта — во вкладку")
        with open(os.path.join(self.data, "backtest_status.json"), "w") as f:
            json.dump({"running": False, "finished": 300, "error": "бэктесту не хватило памяти", "progress": "старое"}, f)
        self.assertEqual(at.status(self.data)["progress"], "", "не идёт — хода нет")
        self.assertIn("памяти", at.status(self.data)["error"])
        with mock.patch("sys.stdout", io.StringIO()):
            at.stop_cmd(self.data)
        self.assertEqual(at.trigger(data_dir=self.data), {"ok": False, "error": "stopped"})

    def test_api_never_starts_processes(self):
        # Бэктест в API ронял её по памяти (oom-kill): в модуле API нет ни
        # процессов, ни потоков — только файлы.
        with open(at.__file__, encoding="utf-8") as f:
            code = f.read()
        for word in ("subprocess", "threading", "Popen"):
            self.assertNotIn(word, code)

    def test_garbage_summary_is_none(self):
        os.makedirs(os.path.join(self.data, "latest"))
        # Итог прежней сетки (служба её больше не запускает) — тоже None: вкладка
        # покажет «итога ещё нет» до первого повтора, а не мусор.
        for raw in ("", "[1]", "{bad", '{"top": [], "full": null}', '{"top": [], "last": {}}'):
            with open(os.path.join(self.data, "latest", "summary.json"), "w") as f:
                f.write(raw)
            self.assertIsNone(at.latest(self.data))
        with open(os.path.join(self.data, "latest", "summary.json"), "w") as f:
            f.write('{"last": {}, "full": {}}')
        self.assertEqual(at.latest(self.data), {"last": {}, "full": {}})

    def test_live_trading_state_and_stats(self):
        # Службы реальной торговли нет — live нет, этап — бэктест.
        self.assertIsNone(at.live(self.data))
        self.assertEqual(at.status(self.data)["stage"], "backtest")
        d = os.path.join(self.data, "live")
        os.makedirs(d, exist_ok=True)
        now = 1_800_000_000
        st = {"heartbeat": now * 1000 - 30_000, "simulated": False, "equity": 10_088.5, "error": "",
              "open": {"coin": "ETH", "inst": "ETH-USDT-SWAP", "side": -1, "opened": now * 1000 - 3_600_000, "px": 3000,
                       "size": 33.3, "notional": 9990, "tp": 2970, "tp_s": "2970", "whales": 2, "upl": -12.0},
              "positions": [{"instId": "ETH-USDT-SWAP", "pos": "-3"}], "events": [f"e{i}" for i in range(30)]}
        with open(os.path.join(d, "state.json"), "w") as f:
            json.dump(st, f)
        with open(os.path.join(d, "trades.jsonl"), "w") as f:
            # Как пишет служба (autotrade_live._track_open).
            f.writelines(json.dumps({"coin": "BTC", "inst": "BTC-USDT-SWAP", "side": 1, "pnl": p,
                                     "opened": (now - 86_400 * 2) * 1000 + i, "closed": (now - 86_400) * 1000 + i,
                                     "px_in": 100_000.0, "px_out": 101_000.0, "tp": 101_000.0, "size": 10, "notional": 10_000,
                                     "fee": -9, "funding": -1, "why": "тейк"}) + "\n"
                         for i, p in enumerate([77.0, 77.0, -270.0, 77.0]))
            f.write(json.dumps({"coin": "BTC", "pnl": "77"}) + "\n")  # не по договору — пропускается
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

    def test_live_keeps_last_50_trades_and_only_week_long_exclusions(self):
        d = os.path.join(self.data, "live")
        os.makedirs(d, exist_ok=True)
        now = 1_800_000_000
        st = {"heartbeat": now * 1000, "blocked": {
            "STX-USDT-SWAP": {"at": now * 1000, "why": "50124", "permanent": True},
            "BTC-USDT-SWAP": {"at": now * 1000, "why": "51008 мало маржи", "permanent": False}}}
        with open(os.path.join(d, "state.json"), "w") as f:
            json.dump(st, f)
        with open(os.path.join(d, "trades.jsonl"), "w") as f:
            f.writelines(json.dumps({"coin": "BTC", "inst": "BTC-USDT-SWAP", "side": 1, "pnl": 1.0, "opened": i,
                                     "closed": i + 1, "px_in": 1.0, "px_out": 1.01, "why": "тейк"}) + "\n" for i in range(60))
        lv = at.live(self.data, now=now)
        self.assertEqual((len(lv["trades"]), lv["trades"][-1]["opened"], lv["stats"]["trades"]), (50, 59, 60))
        self.assertEqual(list(lv["blocked"]), ["STX-USDT-SWAP"])  # 15-минутная пауза — не «исключена»
        self.assertEqual(at.live(self.data, now=now + 8 * 86_400)["blocked"], {}, "неделя прошла — не исключена")

    def test_open_position_shows_whale_exit(self):
        """Кит сигнала закрыл в убыток — у открытой позиции причина выхода."""
        d = os.path.join(self.data, "live")
        os.makedirs(d, exist_ok=True)
        op = {"coin": "BTC", "inst": "BTC-USDT-SWAP", "side": 1, "opened": 1, "px": 100.0, "size": 1.0, "notional": 100.0,
              "tp": 101.0, "tp_s": "101", "wallets": {"0xa": 1}}
        for ex, want in (({"at": 1, "why": "кит 0xa… закрыл в убыток -120 $"}, "кит 0xa… закрыл в убыток -120 $"),
                         ("мусор", None), ({"why": 5}, None), (None, None)):
            with open(os.path.join(d, "state.json"), "w") as f:
                json.dump({"heartbeat": 1, "open": {**op, **({"exit": ex} if ex is not None else {})}}, f)
            got = at.live(self.data, now=1)["open"]
            self.assertEqual(got.get("exit_why"), want, ex)
            self.assertNotIn("wallets", got, "кошельки китов во вкладку не уходят")
        for av, want in (({"why": "кит добрал", "filled": 10.1, "done": True}, "кит добрал"),
                         ({"why": "кит добрал", "filled": 0, "done": True, "skipped": "мало"}, None),
                         ({"why": 5, "filled": 1}, None), ("мусор", None)):
            with open(os.path.join(d, "state.json"), "w") as f:
                json.dump({"heartbeat": 1, "open": {**op, "avg": av}}, f)
            self.assertEqual(at.live(self.data, now=1)["open"].get("avg_why"), want, av)
        with open(os.path.join(d, "state.json"), "w") as f:
            json.dump({"heartbeat": 1, "open": {**op, "usd": 42000, "usd_against": "мусор"}}, f)
        got = at.live(self.data, now=1)["open"]
        self.assertEqual((got["usd"], "usd_against" in got), (42000.0, False))

    def test_key_problem_and_skips_of_the_day(self):
        """Запрет ключу (50124) — строкой во вкладку; пропуски по причинам —
        сумма часов за последние сутки, мусор и старше суток — не считаются."""
        d = os.path.join(self.data, "live")
        os.makedirs(d, exist_ok=True)
        now = 1_800_000_000
        h = now * 1000 // 3_600_000 * 3_600_000
        with open(os.path.join(d, "state.json"), "w") as f:
            json.dump({"heartbeat": now * 1000, "key_problem": {"at": now * 1000, "why": "OKX 50124: закрыт рынок"},
                       "skips": {str(h): {"market": 5, "chase": 1}, str(h - 3_600_000): {"market": 2, "bad": "x"},
                                 str(h - 30 * 3_600_000): {"market": 50}, "мусор": {"market": 9}, str(h - 1): 5}}, f)
        lv = at.live(self.data, now=now)
        self.assertEqual(lv["key_problem"], "OKX 50124: закрыт рынок")
        self.assertEqual(lv["skips_24h"], {"market": 7, "chase": 1})
        self.assertEqual(list(lv["skips_24h"]), ["market", "chase"], "по убыванию")
        with open(os.path.join(d, "state.json"), "w") as f:
            json.dump({"heartbeat": now * 1000, "key_problem": "строка", "skips": [1]}, f)
        lv = at.live(self.data, now=now)
        self.assertEqual((lv["key_problem"], lv["skips_24h"]), ("", {}))

    def test_corrupted_service_files_are_not_500(self):
        """Файлы службы испорчены (обрыв записи, правка руками): ответ —
        по договору, без 500 («нет связи» во вкладке)."""
        with open(os.path.join(self.data, "backtest_status.json"), "w") as f:
            json.dump({"running": "yes", "started": "вчера", "finished": 1e300,
                       "next": [1], "error": 5}, f)
        bs = at.backtest_status(self.data)
        self.assertEqual((bs["running"], bs["started"], bs["finished"], bs["next"], bs["error"]), (False, 0, 0, 0, ""))
        d = os.path.join(self.data, "live")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "state.json"), "w") as f:
            json.dump({"heartbeat": "x", "positions": [{"instId": "BTC-USDT-SWAP", "pos": None},
                                                       {"instId": "ETH-USDT-SWAP", "pos": -3, "upl": 1.5, "avgPx": None}]}, f)
        lv = at.live(self.data, now=1_800_000_000)
        self.assertEqual(lv["heartbeat"], 0)
        self.assertEqual(lv["positions"], [{"instId": "ETH-USDT-SWAP", "pos": "-3.0", "upl": "1.5"}])
        at.status(self.data)

    def test_switch_is_off_by_default_and_persists(self):
        other = os.path.join(self.tmp.name, "fresh")
        self.assertFalse(at.is_on(other))
        self.assertFalse(at.status(other)["on"])
        self.assertEqual(at.trigger(other), {"ok": False, "error": "stopped"})
        os.makedirs(other)
        with open(os.path.join(other, "switch.json"), "w") as f:
            f.write("{bad")
        self.assertFalse(at.is_on(other))
        with mock.patch("sys.stdout", io.StringIO()):
            at.stop_cmd(self.data)
        self.assertFalse(at.is_on(self.data))
        with mock.patch.object(at, "trigger") as trig, mock.patch("sys.stdout", io.StringIO()):
            self.assertTrue(at.start_cmd(self.data)["on"])
            trig.assert_called_once()  # итога ещё нет — сразу пересчёт
        self.assertTrue(at.is_on(self.data))

    def test_unwritable_dir_is_a_reason_not_a_crash(self):
        # На сервере у whale-api домашний каталог только на чтение: кнопка
        # должна получить причину, а не 500 («нет связи» в приложении).
        out = io.StringIO()
        with mock.patch.object(at, "_set_on", side_effect=PermissionError(13, "Read-only file system")), \
                mock.patch("sys.stdout", out):
            for got in (at.start_cmd(self.data), at.stop_cmd(self.data)):
                self.assertEqual((got["ok"], got["error"]), (False, "no_write"))
        self.assertIn("[AUTO] старт: не записать", out.getvalue())

    def test_default_dir_is_next_to_api_not_home(self):
        # whale-api может писать только в ReadWritePaths — каталог API среди них.
        self.assertTrue(os.environ.get("WT_AUTOTRADE_DIR") or at.DATA_DIR.startswith(ROOT + os.sep))
        with open(os.path.join(ROOT, "whale-api.service"), encoding="utf-8") as f:
            unit = f.read()
        rw = next(ln for ln in unit.splitlines() if ln.startswith("ReadWritePaths="))
        self.assertIn("/WalletTracker", rw)


if __name__ == "__main__":
    unittest.main()

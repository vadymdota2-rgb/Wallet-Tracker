"""Скринер графика (wt_screen.py, /api/screener): npm test.

Проверяем: разбор свечей и списка монет (стейблкоины, мусор, повторы),
ответ (порядок, старые рейтинги, монеты без рейтинга), кэш (люди только
читают, те же цифры — тот же объект), расписание пересчёта и бюджет
запросов Binance (Hyperliquid не трогаем вовсе), сбои и враждебные ответы
источника, правила кода и подключение к серверу. Что рейтинг тот же, что у
графика, — test_screen_contract.py.
"""
import ast
import io
import json
import math
import os
import sys
import threading
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_screen as sc  # noqa: E402

NOW = 1_794_100_000


def kl(n: int = 300, start: float = 100.0, step: float = 0.002, t0: int = 1_700_000_000_000) -> list:
    """Свечи Binance (klines): [время, o, h, l, c, v, …] строками, как у биржи."""
    out = []
    px = start
    for i in range(n):
        o = px
        c = px * (1 + step * (1 if i % 7 else -3))
        out.append([t0 + i * 900_000, f"{o}", f"{max(o, c) * 1.001}", f"{min(o, c) * 0.999}", f"{c}", "1000", 0, "0", 1, "0", "0", "0"])
        px = c
    return out


TICKER = [
    {"symbol": "BTCUSDT", "quoteVolume": "1500000000"},
    {"symbol": "ETHUSDT", "quoteVolume": "600000000"},
    {"symbol": "USDCUSDT", "quoteVolume": "900000000"},  # стейблкоин — мимо
    {"symbol": "ETHBTC", "quoteVolume": "1e12"},  # не к USDT — мимо
    {"symbol": "BTCUPUSDT", "quoteVolume": "5e6"},  # плечевой токен — мимо
    {"symbol": "SOLUSDT", "quoteVolume": "300000000"},
    {"symbol": "DEADUSDT", "quoteVolume": "10"},  # мёртвая пара — мимо
    {"symbol": "<b>USDT", "quoteVolume": "1e9"},
    {"symbol": "BTCUSDT", "quoteVolume": "1"},  # повтор — первый
]


class ParseTest(unittest.TestCase):
    def test_universe(self):
        self.assertEqual(sc.parse_universe(TICKER), [("BTC", 1.5e9), ("ETH", 6e8), ("SOL", 3e8)])
        for bad in (None, "x", {}, [1, None, {"symbol": 5}], [{"symbol": "XUSDT", "quoteVolume": "NaN"}]):
            self.assertEqual(sc.parse_universe(bad), [], bad)
        many = [{"symbol": f"C{i}USDT", "quoteVolume": str(1e7 + i)} for i in range(500)]
        got = sc.parse_universe(many)
        self.assertEqual(len(got), sc.TOP)
        self.assertEqual(got[0][0], "C499")  # крупнейшие — первыми

    def test_bars(self):
        bars = sc.parse_bars(kl(10))
        self.assertEqual(len(bars), 10)
        self.assertTrue(all(isinstance(x, float) for b in bars for x in b))
        raw = kl(5)
        raw[1][2] = "1"  # максимум ниже тела
        raw[2][0] = raw[0][0]  # время назад
        raw[3] = ["x"]
        raw.append([raw[-1][0] + 1, "1e999", "1", "1", "1", "1"])
        self.assertEqual(len(sc.parse_bars(raw)), 2)
        self.assertEqual(len(sc.parse_bars(kl(sc.BARS + 100))), sc.BARS)  # хвост — последние
        for bad in (None, "x", {}, [None, 1, "x"]):
            self.assertEqual(sc.parse_bars(bad), [])

    def test_rating_needs_enough_bars(self):
        self.assertIsNone(sc.rating(sc.parse_bars(kl(sc.MIN_BARS - 1))))
        r = sc.rating(sc.parse_bars(kl(300)))
        self.assertIsNotNone(r)
        for x in r:
            self.assertTrue(-1 <= x <= 1)
        # Ровный рост — скользящие «за покупку», ровное падение — «за продажу».
        up = sc.rating(sc.parse_bars(kl(300, step=0.01)))
        self.assertGreater(up[1], 0.5)
        self.assertLess(sc.rating([(i * 1000.0, 100 - i * 0.1, 100 - i * 0.1 + 0.05, 100 - i * 0.1 - 0.15, 100 - i * 0.1 - 0.1, 1.0)
                                   for i in range(300)])[1], -0.5)

    def test_change_24h(self):
        bars = sc.parse_bars(kl(200, step=0.0))
        self.assertEqual(sc.change_24h(bars), 0.0)
        self.assertIsNone(sc.change_24h(bars[:96]))


class ReplyTest(unittest.TestCase):
    def test_order_stale_and_empty(self):
        uni = [("BTC", 2e9), ("ETH", 1e9), ("SOL", 5e8)]
        rates = {"15m": {"BTC": (0.6, NOW), "ETH": (-0.2, NOW - 3 * 300 - 1)},
                 "1h": {"BTC": (-0.4, NOW), "ETH": (0.31234, NOW)}}
        px = {"BTC": (100000.0, 1.25)}
        rep = sc.reply(uni, rates, px, NOW)
        self.assertEqual(rep["tfs"], list(sc.TFS))
        self.assertEqual(rep["by"], "Binance")
        self.assertEqual([r["s"] for r in rep["rows"]], ["BTC", "ETH"])  # у SOL рейтингов нет — мимо
        self.assertEqual(rep["rows"][0], {"s": "BTC", "px": 100000.0, "ch": 1.25, "vol": 2000000000,
                                          "r": {"15m": 0.6, "1h": -0.4, "4h": None, "1d": None}})
        self.assertEqual(rep["rows"][1]["r"], {"15m": None, "1h": 0.312, "4h": None, "1d": None})  # старый 15m — None
        self.assertIsNone(rep["rows"][1]["px"])
        self.assertEqual(sc.reply(uni, {}, {}, NOW), {"ok": False, "error": "no_data"})
        json.dumps(rep, allow_nan=False)


class CacheTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, sc, "_st", sc._st)
        self.addCleanup(sc._src.clear)
        sc._st = sc._State()
        self.calls: list = []

        def uni():
            self.calls.append("universe")
            return TICKER

        def klines(base, tf):
            self.calls.append((base, tf))
            return kl(300, step=0.002 if base == "BTC" else -0.002)

        sc.set_sources(universe=uni, klines=klines)

    def test_people_only_read_the_cache(self):
        self.assertEqual(sc.screener_data(), {"ok": False, "error": "no_data"})
        self.assertEqual(self.calls, [])  # запрос человека к источникам не ходит
        with mock.patch.object(sc, "_now", return_value=NOW):
            res = sc.build()
            self.assertTrue(res["ok"])
            self.assertEqual([r["s"] for r in res["rows"]], ["BTC", "ETH", "SOL"])
            for _ in range(1000):
                self.assertIs(sc.screener_data(), res)
        self.assertEqual(len(self.calls), 1 + 3 * len(sc.TFS))

    def test_schedule_and_budget(self):
        # Час работы сервера, сборка раз в минуту: список монет — раз, 15 минут —
        # раз в 5 минут, час — раз в 15, 4 часа — раз в 30, день — раз в час.
        t, mono = [NOW], [1000.0]
        with mock.patch.object(sc, "_now", side_effect=lambda: t[0]), \
                mock.patch.object(sc.time, "monotonic", side_effect=lambda: mono[0]):
            for _ in range(60):
                sc.build()
                t[0] += 60
                mono[0] += 60
        by_tf = {tf: sum(1 for c in self.calls if isinstance(c, tuple) and c[1] == tf) for tf in sc.TFS}
        self.assertEqual(self.calls.count("universe"), 1)
        self.assertEqual(by_tf, {"15m": 3 * 12, "1h": 3 * 4, "4h": 3 * 2, "1d": 3 * 1})
        # На 80 монетах: запросов в минуту в среднем ~25, вес Binance (2 за
        # свечи, 80 за список) — меньше 1 % от 6000.
        per_min = sum(sc.TOP * 60 / sc.EVERY[tf] for tf in sc.TFS) / 60
        self.assertLess(per_min, 30)
        self.assertLess(per_min * 2 + 80 / 60, 0.01 * 6000)

    def test_same_numbers_same_object_and_stale(self):
        with mock.patch.object(sc, "_now", return_value=NOW):
            a = sc.build()
            sc._st.done.clear()
            b = sc.build()
        self.assertIs(a, b)
        # Binance молчит дольше STALE_X дней — ответа нет.
        with mock.patch.object(sc, "_now", return_value=NOW + sc.STALE_X * 86400 + 1):
            self.assertEqual(sc.screener_data(), {"ok": False, "error": "no_data"})

    def test_failures(self):
        err = io.StringIO()
        # Список монет не получен — пауза FAIL_WAIT, а не запрос каждую минуту.
        sc.set_sources(universe=lambda: (self.calls.append("universe"), None)[1], klines=lambda b, tf: 1 / 0)
        mono = [1000.0]
        with mock.patch.object(sc, "_now", return_value=NOW), mock.patch.object(sc.time, "monotonic", side_effect=lambda: mono[0]), \
                mock.patch.object(sc.sys, "stderr", err):
            self.assertEqual(sc.build(), {"ok": False, "error": "no_data"})
            mono[0] += 30
            sc.build()
            self.assertEqual(self.calls.count("universe"), 1)
            mono[0] += sc.FAIL_WAIT
            sc.build()
            self.assertEqual(self.calls.count("universe"), 2)
        # Свечи одной монеты не пришли — остальные на месте; сбой — в журнал типом ошибки.
        sc._st = sc._State()
        sc.set_sources(universe=lambda: TICKER, klines=lambda b, tf: (1 / 0) if b == "ETH" else kl(300))
        with mock.patch.object(sc, "_now", return_value=NOW), mock.patch.object(sc.sys, "stderr", err):
            res = sc.build()
        self.assertEqual([r["s"] for r in res["rows"]], ["BTC", "SOL"])
        self.assertIn("screener: источник klines не ответил (ZeroDivisionError)", err.getvalue())

    def test_dropped_coins_leave_memory(self):
        with mock.patch.object(sc, "_now", return_value=NOW):
            sc.build()
            sc.set_sources(universe=lambda: TICKER[:2], klines=lambda b, tf: kl(300))
            sc._st.done.clear()
            sc._st.uni_at = -math.inf
            res = sc.build()
        self.assertEqual([r["s"] for r in res["rows"]], ["BTC", "ETH"])
        for tf in sc.TFS:
            self.assertNotIn("SOL", sc._st.rates[tf])
        self.assertNotIn("SOL", sc._st.px)

    def test_refresh_runs_in_background_once(self):
        gate = threading.Event()

        def slow(b, tf):
            gate.wait(5)
            return kl(300)

        sc.set_sources(universe=lambda: TICKER, klines=slow)
        with mock.patch.object(sc, "_now", return_value=NOW):
            sc.refresh()
            job = sc._st.job
            self.assertIsNotNone(job)
            for _ in range(50):
                sc.refresh()
            self.assertIs(sc._st.job, job)  # одна сборка, не пятьдесят
            gate.set()
            job.join(10)
            self.assertTrue(sc.screener_data()["ok"])
        self.assertIsNone(sc._st.job)

    def test_hostile_source(self):
        evil = '<img src=x onerror=alert(1)>'
        sc.set_sources(universe=lambda: [{"symbol": evil + "USDT", "quoteVolume": "1e12"}, {"symbol": "BTCUSDT", "quoteVolume": 10**400},
                                         {"symbol": "ETHUSDT", "quoteVolume": "2e9", "x": evil}],
                       klines=lambda b, tf: [[1, evil, "1e999", 10**400, "nan", "1"], *kl(300)])
        with mock.patch.object(sc, "_now", return_value=NOW):
            res = sc.build()
        out = json.dumps(res, allow_nan=False)
        self.assertNotIn("<img", out)
        self.assertEqual([r["s"] for r in res["rows"]], ["ETH"])
        t0 = time.process_time()
        sc.parse_bars([["1", "1", "1", "1", "1", "1"]] * 1_000_000)
        self.assertLess(time.process_time() - t0, 2.0)  # огромный ответ — разбираем только хвост


class PolicyTest(unittest.TestCase):
    def read(self, *p: str) -> str:
        with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
            return f.read()

    def test_module_is_pure(self):
        tree = ast.parse(self.read("wt_screen.py"))
        found = set()
        for n in ast.walk(tree):
            if isinstance(n, ast.Import):
                found |= {a.name for a in n.names}
            elif isinstance(n, ast.ImportFrom):
                found.add(n.module or "")
        self.assertLessEqual(found, {"__future__", "contextlib", "math", "sys", "threading", "time", "collections.abc", "typing"})
        self.assertEqual([n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str) and "://" in n.value], [])

    def test_server_wiring(self):
        import whale_api as api  # noqa: PLC0415
        src = self.read("whale_api.py")
        block = src.split("# --- Скринер графика (wt_screen.py)")[1].split("# --- Дайджест")[0]
        # Только Binance spot через публичное зеркало; Hyperliquid — ни запроса.
        self.assertNotIn("hl_post", block)
        self.assertNotIn("hyperliquid.xyz", block)
        self.assertEqual(set(__import__("re").findall(r"https://([a-z0-9.-]+)/", block)), {"data-api.binance.vision"})
        self.assertEqual(block.count("max_bytes=wt_screen.RESP_MAX"), block.count("get_json("))
        self.assertIn('if tf not in wt_screen.TFS or not (base.isascii() and base.isalnum() and len(base) <= 16):', block)
        self.assertIsNone(api._screen_klines("BTC/../x", "15m"))
        self.assertIsNone(api._screen_klines("BTC", "1m"))
        for p in ("/api/screener", "/screener"):
            self.assertIn(p, api.PAID_PATHS)
        self.assertIs(api.screener_data, sc.screener_data)
        self.assertIn('        ("screener", lambda: screener_refresh()),\n', src.split("def _cache_modules() -> tuple:")[1].split("\ndef ")[0])
        route = src.split('if path in ("/screener", "/api/screener"):')[1].split("return\n")[0]
        self.assertNotIn("refresh", route)
        self.assertIn('self._json_public("screener", scr)', route)

    def test_app_and_server_agree(self):
        ts = self.read("src", "lib", "screener.ts")
        self.assertIn(f"export const SCREEN_TFS = {json.dumps(list(sc.TFS)).replace(', ', ', ')} as const;".replace('", "', '", "'), ts)


if __name__ == "__main__":
    unittest.main()

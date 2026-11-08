"""Рынки для криптотрейдера в меню (wt_markets.py, /api/markets).

Проверяем: разбор каждого источника (Hyperliquid, курсы ЕЦБ, DVOL Deribit,
доминация CoinMarketCap), формулу DXY, что снятые с торгов рынки не
берутся, что сбой или мусор одного источника не роняет остальные, что в
ответе — только наши ключи и правдоподобные числа, кэш и сборку в фоне,
правила модуля (без сети, без опасного) и что маршрут — для подписчиков.
"""
import ast
import json
import math
import os
import random
import sys
import threading
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модули лежат в корне репозитория
import wt_markets as mk  # noqa: E402

NOW = 1_794_100_000
T = NOW * 1000


def hl(markets: dict, delisted: tuple = ()) -> list:
    uni = [{"name": n, **({"isDelisted": True} if n.split(":")[-1] in delisted else {})} for n in markets]
    return [{"universe": uni}, [{"markPx": str(a), "prevDayPx": str(b)} for a, b in markets.values()]]


XYZ = hl({"xyz:SP500": (7373.1, 7392.9), "xyz:XYZ100": (26925, 26996), "xyz:GOLD": (4066.2, 4079.9),
          "xyz:EUR": (1.1157, 1.1156), "xyz:JPY": (158.36, 158.29), "xyz:SILVER": (52, 52),
          "xyz:DXY": (97.15, 97.15), "xyz:VIX": (20, 20)}, delisted=("DXY", "VIX"))
PARA = hl({"para:10Y": (4.875, 4.8777), "para:BTCD": (60.4, 60.3)})
MAIN = hl({"BTC": (100_000, 99_000), "ETH": (3300, 3200)})
ECB = {"rates": {"2026-11-05": {"EUR": 0.89095, "JPY": 158.46, "GBP": 0.74299, "CAD": 1.3966, "SEK": 9.7866, "CHF": 0.81789},
                 "2026-11-06": {"EUR": 0.89566, "JPY": 158.33, "GBP": 0.74711, "CAD": 1.4066, "SEK": 9.8755, "CHF": 0.8189}}}
DVOL = {"result": {"data": [[T - h * 3_600_000, 0, 0, 0, 40 - h * 0.05] for h in range(26, -1, -1)]}}
MCAP = {"ok": True, "btc": [60.44, 60.35], "usdt": 4.1, "cap": [3.4e12, 3.3e12]}
PARTS = {"xyz": XYZ, "para": PARA, "main": MAIN, "ecb": ECB, "dvol": DVOL, "mcap": MCAP}


def items(res: dict) -> dict:
    return {it["k"]: (it["px"], it["prev"]) for it in res["items"]} if res.get("ok") else {}


class ComputeTest(unittest.TestCase):
    def test_all_nine_in_screen_order(self):
        res = mk.compute(PARTS, NOW)
        self.assertTrue(res["ok"])
        self.assertEqual(res["at"], NOW)
        self.assertEqual([it["k"] for it in res["items"]], list(mk.KEYS))
        got = items(res)
        self.assertEqual(got["SP500"], (7373.1, 7392.9))
        self.assertEqual(got["NDX"], (26925, 26996))
        self.assertEqual(got["GOLD"], (4066.2, 4079.9))
        self.assertEqual(got["US10Y"], (4.875, 4.8777))
        self.assertEqual(got["DVOL"], (40.0, 38.8))  # сейчас и ровно сутки назад
        self.assertEqual(got["BTCD"], (60.44, 60.35))
        self.assertEqual(got["ETHBTC"], (0.033, round(3200 / 99_000, 8)))
        json.dumps(res, allow_nan=False)

    def test_dxy_by_ice_formula(self):
        r = {"EUR": 1 / 1.1157, "JPY": 158.36, "GBP": 0.74711, "CAD": 1.4066, "SEK": 9.8755, "CHF": 0.8189}
        want = 50.14348112 * 1.1157 ** -0.576 * 158.36 ** 0.136 * (1 / 0.74711) ** -0.119 * 1.4066 ** 0.091 \
            * 9.8755 ** 0.042 * 0.8189 ** 0.036
        self.assertAlmostEqual(mk.dxy(r), want, places=9)
        self.assertAlmostEqual(sum(abs(w) for _, w in mk.DXY_W), 1.0, places=9)
        px, prev = items(mk.compute(PARTS, NOW))["DXY"]
        self.assertAlmostEqual(px, round(want, 3), places=6)
        # Сутки назад: EUR и JPY — у Hyperliquid сутки назад, остальное — прошлый день ЕЦБ.
        self.assertAlmostEqual(prev, round(mk.dxy(dict(ECB["rates"]["2026-11-05"], EUR=1 / 1.1156, JPY=158.29)), 3), places=6)
        self.assertTrue(95 < px < 110)

    def test_usdt_dominance_yesterday_by_market_cap(self):
        # Вчерашней доли USDT CoinMarketCap не отдаёт: та же капитализация USDT
        # к вчерашней капитализации рынка.
        px, prev = items(mk.compute(PARTS, NOW))["USDTD"]
        self.assertEqual(px, 4.1)
        self.assertAlmostEqual(prev, 4.1 * 3.4e12 / 3.3e12)
        for bad in ({"ok": False}, {**MCAP, "usdt": None}, {**MCAP, "usdt": 150}, {**MCAP, "cap": [3.4e12, None]},
                    {**MCAP, "cap": "x"}, "x", None):
            self.assertNotIn("USDTD", items(mk.compute({**PARTS, "mcap": bad}, NOW)), bad)
        for bad in ({**MCAP, "btc": [120, 60]}, {**MCAP, "btc": [60, None]}, {**MCAP, "btc": "x"}, {"ok": False}):
            self.assertNotIn("BTCD", items(mk.compute({**PARTS, "mcap": bad}, NOW)), bad)

    def test_delisted_markets_are_not_taken(self):
        got = items(mk.compute(PARTS, NOW))
        self.assertNotAlmostEqual(got["DXY"][0], 97.15, places=1)  # застывший DXY Hyperliquid — мимо
        self.assertEqual(set(mk.hl_markets(XYZ)) & {"DXY", "VIX"}, set())
        self.assertNotIn("SILVER", got)  # не из набора

    def test_one_silent_source_drops_only_its_items(self):
        cases = {"ecb": {"DXY"}, "dvol": {"DVOL"}, "mcap": {"BTCD", "USDTD"}, "main": {"ETHBTC"}, "para": {"US10Y"},
                 "xyz": {"SP500", "NDX", "GOLD", "DXY"}}
        for name, gone in cases.items():
            self.assertEqual(set(items(mk.compute({**PARTS, name: None}, NOW))), set(mk.KEYS) - gone, name)
        self.assertEqual(mk.compute({}, NOW), {"ok": False, "error": "no_data"})

    def test_poisoned_sources(self):
        rnd = random.Random(7)  # noqa: S311 — повторяемая отрава, не тайна
        junk = [None, "x", 0, -1, 1e400, float("nan"), float("inf"), [], {}, "1e999", True, "<b>", 1e8, 2**70, "NaN"]

        def poison(v: object, depth: int = 0) -> object:
            if rnd.random() < 0.15 or depth > 5:
                return rnd.choice(junk)
            if isinstance(v, dict):
                return {k: poison(x, depth + 1) for k, x in v.items() if rnd.random() < 0.9}
            if isinstance(v, list):
                return [poison(x, depth + 1) for x in v if rnd.random() < 0.9]
            return v

        for _ in range(500):
            res = mk.compute({k: poison(v) for k, v in PARTS.items()}, NOW)
            json.dumps(res, allow_nan=False)
            for it in res.get("items", []):
                self.assertIn(it["k"], mk.KEYS)
                self.assertEqual(set(it), {"k", "px", "prev"})
                for v in (it["px"], it["prev"]):
                    self.assertTrue(isinstance(v, float) and math.isfinite(v) and 0 < v < mk.PX_MAX, it)


class CacheTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, mk, "_st", mk._st)
        mk._st = mk._State()

    def wait(self):
        job = mk._st.job
        if job is not None:
            job.join(5)

    def test_cold_then_cached_then_background(self):
        calls: list = []
        mk.set_sources({name: (lambda v=v, n=name: calls.append(n) or v) for name, v in PARTS.items()})
        with mock.patch.object(mk, "_now", return_value=NOW):
            first = mk.markets_data(5)
            self.assertTrue(first["ok"])
            self.assertEqual(len(calls), len(PARTS))
            self.assertIs(mk.markets_data(5), first)  # свежий — из кэша
            self.assertEqual(len(calls), len(PARTS))
            # Старый — сразу, а свежий собирается в фоне.
            mk._st.hit = (time.monotonic() - mk.TTL - 1, first)
            self.assertIs(mk.markets_data(0), first)
            self.wait()
            self.assertEqual(len(calls), 2 * len(PARTS))
            self.assertIsNot(mk._st.hit[1], first)

    def test_failing_sources(self):
        def boom():
            raise OSError("нет сети")

        mk.set_sources({name: boom for name in PARTS})
        self.assertEqual(mk.markets_data(5), {"ok": False, "error": "no_data"})
        self.wait()
        self.assertIsNone(mk._start())  # после сбоя — пауза FAIL_WAIT
        mk._st.fail = time.monotonic() - mk.FAIL_WAIT - 1
        mk.set_sources({})
        self.assertEqual(mk.markets_data(5), {"ok": False, "error": "no_data"})

    def test_slow_source_waits_no_longer_than_asked(self):
        gate = threading.Event()
        self.addCleanup(gate.set)
        mk.set_sources({"xyz": lambda: XYZ, "dvol": lambda: gate.wait(10) and DVOL})
        with mock.patch.object(mk, "_now", return_value=NOW):
            t0 = time.monotonic()
            self.assertEqual(mk.markets_data(0.2), {"ok": False, "error": "no_data"})
            self.assertLess(time.monotonic() - t0, 2)
            gate.set()
            self.wait()
            self.assertTrue(mk.markets_data(0)["ok"])


class PolicyTest(unittest.TestCase):
    def tree(self) -> ast.Module:
        with open(os.path.join(ROOT, "wt_markets.py"), encoding="utf-8") as f:
            return ast.parse(f.read())

    def test_module_has_no_network_files_or_eval(self):
        found = set()
        for n in ast.walk(self.tree()):
            if isinstance(n, ast.Import):
                found |= {a.name for a in n.names}
            elif isinstance(n, ast.ImportFrom):
                found.add(n.module or "")
        self.assertLessEqual(found, {"__future__", "math", "re", "threading", "time", "collections.abc", "typing"})
        bad = [n.func.id for n in ast.walk(self.tree()) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
               and n.func.id in {"eval", "exec", "compile", "__import__", "open", "getattr", "setattr"}]
        self.assertEqual(bad, [])
        self.assertEqual([n.value for n in ast.walk(self.tree()) if isinstance(n, ast.Constant)
                          and isinstance(n.value, str) and "://" in n.value], [])

    def test_server_wiring_and_paid_route(self):
        self.assertIn("/api/markets", api.PAID_PATHS)
        self.assertIn("/markets", api.PAID_PATHS)
        self.assertIs(api.markets_data, mk.markets_data)
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('if path in ("/markets", "/api/markets"):\n                self._json(200, markets_data())', src)
        for name in PARTS:
            self.assertIn(f'    "{name}": ', src.split("wt_markets.set_sources({")[1].split("})")[0])
        self.assertIn('"mcap": lambda: wt_mcap.mcap_data(0),', src)  # доминация — из кэша, без ожидания

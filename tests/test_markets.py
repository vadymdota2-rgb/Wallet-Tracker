"""Рынки в меню (wt_markets.py, /api/markets): S&P 500, XYZ100, DXY, золото,
US 10Y, нефть WTI.

Проверяем: разбор каждого источника (Hyperliquid, курсы ЕЦБ), формулу DXY
и сверку EUR и JPY с ЕЦБ, что снятые с торгов
рынки не берутся, что сбой или мусор одного источника не роняет остальные,
что в ответе — только наши ключи и правдоподобные числа (рамки, скачок за
сутки), кэш, сборку в фоне и что старый ответ не отдаётся, правила модуля
(без сети, без опасного), права (ни Deribit, ни VIX, ни TradingView, ни
имени Nasdaq-100) и
что маршрут — для подписчиков.
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


XYZ_M = {"xyz:SP500": (7373.1, 7392.9), "xyz:XYZ100": (26925, 26996), "xyz:GOLD": (4066.2, 4079.9),
         "xyz:CL": (90.205, 89.617), "xyz:EUR": (1.1157, 1.1156), "xyz:JPY": (158.36, 158.29),
         "xyz:SILVER": (52, 52), "xyz:DXY": (97.15, 97.15), "xyz:VIX": (20, 20)}
XYZ = hl(XYZ_M, delisted=("DXY", "VIX"))
PARA = hl({"para:10Y": (4.875, 4.8777), "para:BTCD": (60.4, 60.3)})
ECB = {"rates": {"2026-11-05": {"EUR": 0.89095, "JPY": 158.46, "GBP": 0.74299, "CAD": 1.3966, "SEK": 9.7866, "CHF": 0.81789},
                 "2026-11-06": {"EUR": 0.89566, "JPY": 158.33, "GBP": 0.74711, "CAD": 1.4066, "SEK": 9.8755, "CHF": 0.8189}}}
PARTS = {"xyz": XYZ, "para": PARA, "ecb": ECB}


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
        self.assertEqual(got["XYZ100"], (26925, 26996))
        self.assertEqual(got["GOLD"], (4066.2, 4079.9))
        self.assertEqual(got["US10Y"], (4.875, 4.8777))
        self.assertEqual(got["OIL"], (90.205, 89.617))  # WTI — рынок CL
        self.assertNotIn("BTCD", got)  # BTCD на Paragon — не из набора
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

    def test_hyperliquid_fx_must_agree_with_ecb(self):
        # Hyperliquid перевернул котировку (иены за доллар → доллары за иену) или
        # курс сорвался — DXY не считаем, остальное на месте.
        for name, px in (("xyz:JPY", (1 / 158.36, 1 / 158.29)), ("xyz:EUR", (0.8963, 0.8962)), ("xyz:EUR", (1.2, 1.2))):
            xyz = hl({**XYZ_M, name: px}, delisted=("DXY", "VIX"))
            got = items(mk.compute({**PARTS, "xyz": xyz}, NOW))
            self.assertNotIn("DXY", got, name)
            self.assertIn("SP500", got)
        self.assertIn("DXY", items(mk.compute(PARTS, NOW)))

    def test_ranges_and_daily_jump(self):
        self.assertTrue(mk.sane("SP500", (7373.1, 7392.9)))
        self.assertFalse(mk.sane("SP500", (7373.1, 3000)))  # больше чем вдвое за сутки — сбой
        self.assertFalse(mk.sane("GOLD", (4000, 9000)))
        self.assertFalse(mk.sane("US10Y", (48.75, 48.77)))  # процент не в тех единицах
        self.assertFalse(mk.sane("DXY", (9.7, 9.7)))

        para = hl({"para:10Y": (487.5, 487.77)})
        self.assertNotIn("US10Y", items(mk.compute({**PARTS, "para": para}, NOW)))
        xyz = hl({**XYZ_M, "xyz:CL": (90.2, 30.1)}, delisted=("DXY", "VIX"))
        self.assertNotIn("OIL", items(mk.compute({**PARTS, "xyz": xyz}, NOW)))

    def test_delisted_markets_are_not_taken(self):
        got = items(mk.compute(PARTS, NOW))
        self.assertNotAlmostEqual(got["DXY"][0], 97.15, places=1)  # застывший DXY Hyperliquid — мимо
        self.assertEqual(set(mk.hl_markets(XYZ)) & {"DXY", "VIX"}, set())
        self.assertNotIn("SILVER", got)  # не из набора

    def test_one_silent_source_drops_only_its_items(self):
        cases = {"ecb": {"DXY"}, "para": {"US10Y"}, "xyz": {"SP500", "XYZ100", "GOLD", "OIL", "DXY"}}
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

    def test_old_answer_is_not_served(self):
        # Источники молчат дольше STALE_MAX — меню возвращается к заголовку,
        # а не показывает вчерашние цены.
        mk.set_sources({})
        with mock.patch.object(mk, "_now", return_value=NOW):
            res = mk.compute(PARTS, NOW)
        mk._st.hit = (time.monotonic() - mk.STALE_MAX - 1, res)
        mk._st.fail = time.monotonic()  # и новая сборка пока не начнётся
        self.assertEqual(mk.markets_data(0), {"ok": False, "error": "no_data"})
        mk._st.hit = (time.monotonic() - mk.STALE_MAX + 60, res)
        self.assertIs(mk.markets_data(0), res)

    def test_late_source_does_not_change_built_answer(self):
        gate, late = threading.Event(), threading.Event()
        self.addCleanup(gate.set)

        def slow():
            gate.wait(10)
            late.set()
            return PARA

        mk.set_sources({"xyz": lambda: XYZ, "para": slow})
        with mock.patch.object(mk, "SOURCE_WAIT", 0.2), mock.patch.object(mk, "_now", return_value=NOW):
            res = mk.build()
        self.assertNotIn("US10Y", items(res))
        gate.set()
        late.wait(5)
        self.assertNotIn("US10Y", items(res))

    def test_slow_source_waits_no_longer_than_asked(self):
        gate = threading.Event()
        self.addCleanup(gate.set)
        mk.set_sources({"xyz": lambda: XYZ, "para": lambda: gate.wait(10) and PARA})
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
        self.assertEqual(src.split("wt_markets.set_sources({")[1].split("})")[0].count('\n    "'), len(PARTS))

    def test_rights(self):
        # Deribit (DVOL) — только для личного пользования; VIX — индекс Cboe по
        # лицензии; XYZ100 — не Nasdaq-100; котировки TradingView брать нельзя
        # (только их окна): ни в источниках, ни в ключах.
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            block = f.read().split("# --- Рынки в меню (wt_markets.py)")[1].split("markets_data = wt_markets")[0]
        self.assertNotIn("deribit.com", block)
        self.assertNotIn("cboe", block.lower())
        self.assertNotIn("tradingview", block.lower())
        self.assertEqual(set(mk.KEYS) & {"DVOL", "VIX", "NDX"}, set())
        self.assertNotIn("dvol", "".join(mk.KEYS).lower())
        with open(os.path.join(ROOT, "tools", "i18n.json"), encoding="utf-8") as f:
            tr = json.load(f)
        for lang, v in tr["mk_src"].items():
            self.assertNotIn("Deribit", v, lang)
            self.assertIn("ЕЦБ" if lang == "ru" else "Hyperliquid", v, lang)
        for lang in tr["mk_sp_hint"]:
            self.assertIn("S&P Dow Jones Indices", tr["mk_sp_hint"][lang], lang)
            self.assertIn("Standard & Poor’s Financial Services LLC", tr["mk_sp_hint"][lang], lang)
            self.assertIn("Nasdaq-100", tr["mk_xyz_hint"][lang], lang)
            self.assertIn("ICE", tr["mk_dxy_hint"][lang], lang)
            self.assertIn("WTI", tr["mk_oil_hint"][lang], lang)

"""Рынки в меню (wt_markets.py, /api/markets): S&P 500, XYZ100, DXY, золото,
нефть WTI, US 10Y, BVIV, BTC.D, USDT.D.

Проверяем: разбор каждого источника (Hyperliquid, курсы ЕЦБ, доминация
CoinMarketCap), формулу DXY
и сверку EUR и JPY с ЕЦБ, что снятые с торгов
рынки не берутся, что сбой или мусор одного источника не роняет остальные,
что в ответе — только наши ключи и правдоподобные числа (рамки, скачок за
сутки), кэш, сборку в фоне и что старый ответ не отдаётся, правила модуля
(без сети, без опасного), права (ни Deribit, ни VIX, ни TradingView, ни
имени Nasdaq-100) и
что маршрут — для подписчиков.
"""
import ast
import calendar
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
         "xyz:CL": (90.205, 89.617), "xyz:EUR": (1.1157, 1.1156), "xyz:JPY": (158.36, 158.29), "xyz:GBP": (1.3349, 1.3338),
         "xyz:SILVER": (52, 52), "xyz:DXY": (97.15, 97.15), "xyz:VIX": (20, 20)}
XYZ = hl(XYZ_M, delisted=("DXY", "VIX"))
PARA = hl({"para:10Y": (4.875, 4.8777), "para:BTCD": (60.4, 60.3)})
MKTS = hl({"mkts:BVIV": (42.399, 41.0), "mkts:OLD": (5, 5)}, delisted=("OLD",))
MCAP = {"ok": True, "btc": [60.44, 60.35], "usdt": 4.1, "cap": [3.4e12, 3.3e12]}
ECB = {"rates": {"2026-11-05": {"EUR": 0.89095, "JPY": 158.46, "GBP": 0.74299, "CAD": 1.3966, "SEK": 9.7866, "CHF": 0.81789},
                 "2026-11-06": {"EUR": 0.89566, "JPY": 158.33, "GBP": 0.74711, "CAD": 1.4066, "SEK": 9.8755, "CHF": 0.8189}}}
# NOW — воскресенье 01:06 UTC: валютный рынок закрыт. Закрытия (17:00 по
# Нью-Йорку, зимой — 22:00 UTC): пятница и четверг.
FRI, THU = 1_794_002_400, 1_793_916_000
WD = FRI - 7 * 3600  # пятница 15:00 UTC — рынок открыт
CLOSE = {FRI: {"EUR": 1.115, "JPY": 158.35, "GBP": 1.3349}, THU: {"EUR": 1.1227, "JPY": 157.65, "GBP": 1.345}}
DRIFT = {"EUR": 1.1301, "JPY": 157.1, "GBP": 1.3401}  # прочие часы, в том числе выходные


def candles(cur: str, close: dict | None = None) -> list:
    close = CLOSE if close is None else close
    return [{"t": (end - 3600) * 1000, "c": str(close.get(end, {}).get(cur, DRIFT[cur]))}
            for end in range(THU - 30 * 3600, NOW, 3600)]


FX = {c: candles(c) for c in ("EUR", "JPY", "GBP")}
PARTS = {"xyz": XYZ, "para": PARA, "mkts": MKTS, "fx": FX, "ecb": ECB, "mcap": MCAP}


def want_dxy(day: str, eur: float, jpy: float, gbp: float) -> float:
    return round(mk.dxy(dict(ECB["rates"][day], EUR=1 / eur, JPY=jpy, GBP=1 / gbp)), 3)


def items(res: dict) -> dict:
    return {it["k"]: (it["px"], it["prev"]) for it in res["items"]} if res.get("ok") else {}


class ComputeTest(unittest.TestCase):
    def test_all_in_screen_order(self):
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
        self.assertEqual(got["BVIV"], (42.399, 41.0))  # волатильность BTC — рынок Kinetiq
        self.assertEqual(got["BTCD"], (60.44, 60.35))  # CoinMarketCap, не рынок BTCD Paragon
        json.dumps(res, allow_nan=False)

    def test_dxy_by_ice_formula(self):
        r = {"EUR": 1 / 1.1157, "JPY": 158.36, "GBP": 0.74711, "CAD": 1.4066, "SEK": 9.8755, "CHF": 0.8189}
        want = 50.14348112 * 1.1157 ** -0.576 * 158.36 ** 0.136 * (1 / 0.74711) ** -0.119 * 1.4066 ** 0.091 \
            * 9.8755 ** 0.042 * 0.8189 ** 0.036
        self.assertAlmostEqual(mk.dxy(r), want, places=9)
        self.assertAlmostEqual(sum(abs(w) for _, w in mk.DXY_W), 1.0, places=9)


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
        # Капитализация рынка за сутки «упала» в десять раз — USDT.D за 40 % не пишем.
        self.assertNotIn("USDTD", items(mk.compute({**PARTS, "mcap": {**MCAP, "cap": [3.4e11, 3.3e12]}}, NOW)))

    def test_dxy_weekend_is_friday_close_against_thursday(self):
        # Как у TradingView: в выходные — закрытие пятницы и изменение за
        # пятницу; выходные цены Hyperliquid (DRIFT) не берутся. EUR, JPY, GBP —
        # свечи закрытия, CAD, SEK, CHF — фиксация ЕЦБ того же дня.
        px, prev = items(mk.compute(PARTS, NOW))["DXY"]
        self.assertEqual(px, want_dxy("2026-11-06", 1.115, 158.35, 1.3349))
        self.assertEqual(prev, want_dxy("2026-11-05", 1.1227, 157.65, 1.345))
        self.assertTrue(101 < prev < px < 103)

    def test_dxy_weekday_is_live_against_last_close(self):
        # Рынок открыт: сейчас — живые цены Hyperliquid и последняя фиксация ЕЦБ,
        # против прошлого закрытия (четверг 17:00 по Нью-Йорку).
        px, prev = items(mk.compute(PARTS, WD))["DXY"]
        self.assertEqual(px, want_dxy("2026-11-06", 1.1157, 158.36, 1.3349))
        self.assertEqual(prev, want_dxy("2026-11-05", 1.1227, 157.65, 1.345))
        # Утром, до фиксации ЕЦБ, — фиксация прошлого дня.
        early = {**ECB, "rates": {"2026-11-05": ECB["rates"]["2026-11-05"]}}
        px, _ = items(mk.compute({**PARTS, "ecb": early}, WD))["DXY"]
        self.assertEqual(px, want_dxy("2026-11-05", 1.1157, 158.36, 1.3349))

    def test_fx_session(self):
        cases = {  # UTC → (открыт, последнее закрытие, прошлое)
            "2026-11-06 15:00": (True, "Thu 05 22:00", "Wed 04 22:00"),
            "2026-11-06 22:00": (False, "Fri 06 22:00", "Thu 05 22:00"),
            "2026-11-08 21:59": (False, "Fri 06 22:00", "Thu 05 22:00"),
            "2026-11-08 22:00": (True, "Fri 06 22:00", "Thu 05 22:00"),  # воскресенье 17:00 — открытие
            "2026-11-09 23:00": (True, "Mon 09 22:00", "Fri 06 22:00"),
            "2026-07-10 20:30": (True, "Thu 09 21:00", "Wed 08 21:00"),  # летом — 21:00 UTC
            "2026-07-10 21:00": (False, "Fri 10 21:00", "Thu 09 21:00"),
            "2026-03-09 12:00": (True, "Fri 06 22:00", "Thu 05 22:00"),  # первый день летнего времени
        }
        fmt = "%a %d %H:%M"
        for when, (is_open, close, prev) in cases.items():
            t = calendar.timegm(time.strptime(when, "%Y-%m-%d %H:%M"))
            o, c, p = mk.fx_session(t)
            self.assertEqual((o, time.strftime(fmt, time.gmtime(c)), time.strftime(fmt, time.gmtime(p))),
                             (is_open, close, prev), when)

    def test_candle_close(self):
        self.assertEqual(mk.candle_close(FX["EUR"], FRI), 1.115)
        self.assertEqual(mk.candle_close(FX["EUR"], FRI + 1800), 1.115)  # свеча ещё не закрылась
        old = [c for c in FX["EUR"] if c["t"] < (FRI - 4 * 3600) * 1000]
        self.assertEqual(mk.candle_close(old, FRI), 0.0)  # последняя — старше трёх часов
        for bad in (None, "x", [None, {"t": "x"}, {"t": (FRI - 3600) * 1000, "c": "nan"}], {}):
            self.assertEqual(mk.candle_close(bad, FRI), 0.0)

    def test_hyperliquid_fx_must_agree_with_ecb(self):
        # Hyperliquid перевернул котировку (иены за доллар → доллары за иену) или
        # курс сорвался — DXY не считаем, остальное на месте. В выходные — по
        # свечам закрытия, в будни — по живым ценам.
        for cur, v in (("JPY", 1 / 158.35), ("EUR", 0.8963), ("EUR", 1.2), ("GBP", 0.749)):
            fx = {**FX, cur: candles(cur, {FRI: {cur: v}, THU: CLOSE[THU]})}
            got = items(mk.compute({**PARTS, "fx": fx}, NOW))
            self.assertNotIn("DXY", got, cur)
            self.assertIn("SP500", got)
        for name, px in (("xyz:JPY", (1 / 158.36, 1 / 158.29)), ("xyz:EUR", (0.8963, 0.8962)), ("xyz:GBP", (0.749, 0.749))):
            xyz = hl({**XYZ_M, name: px}, delisted=("DXY", "VIX"))
            got = items(mk.compute({**PARTS, "xyz": xyz}, WD))
            self.assertNotIn("DXY", got, name)
            self.assertIn("SP500", got)
        self.assertIn("DXY", items(mk.compute(PARTS, NOW)))
        self.assertIn("DXY", items(mk.compute(PARTS, WD)))

    def test_ranges_and_daily_jump(self):
        self.assertTrue(mk.sane("SP500", (7373.1, 7392.9)))
        self.assertFalse(mk.sane("SP500", (7373.1, 3000)))  # больше чем вдвое за сутки — сбой
        self.assertFalse(mk.sane("GOLD", (4000, 9000)))
        self.assertFalse(mk.sane("US10Y", (48.75, 48.77)))  # процент не в тех единицах
        self.assertFalse(mk.sane("DXY", (9.7, 9.7)))
        self.assertFalse(mk.sane("BTCD", (100.5, 99)))
        self.assertFalse(mk.sane("BVIV", (0.42, 0.41)))  # доля вместо процентов

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
        cases = {"ecb": {"DXY"}, "fx": {"DXY"}, "para": {"US10Y"}, "xyz": {"SP500", "XYZ100", "GOLD", "OIL"},
                 "mkts": {"BVIV"}, "mcap": {"BTCD", "USDTD"}}
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
        self.assertLessEqual(found, {"__future__", "calendar", "math", "re", "threading", "time", "collections.abc", "typing"})
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
        self.assertIn('"mcap": lambda: wt_mcap.mcap_data(0),', src)  # доминация — из кэша, без ожидания

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
            self.assertIn("CoinMarketCap", v, lang)  # ссылку ставит экран — по этому слову
        for lang in tr["mk_sp_hint"]:
            self.assertIn("S&P Dow Jones Indices", tr["mk_sp_hint"][lang], lang)
            self.assertIn("Standard & Poor’s Financial Services LLC", tr["mk_sp_hint"][lang], lang)
            self.assertIn("Nasdaq-100", tr["mk_xyz_hint"][lang], lang)
            self.assertIn("ICE", tr["mk_dxy_hint"][lang], lang)
            self.assertIn("WTI", tr["mk_oil_hint"][lang], lang)
            self.assertIn("Volmex", tr["mk_bviv_hint"][lang], lang)
            self.assertIn("Kinetiq", tr["mk_bviv_hint"][lang], lang)

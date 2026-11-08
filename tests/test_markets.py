"""Рынки в меню (wt_markets.py, /api/markets): S&P 500, XYZ100, DXY, золото,
нефть WTI, US 10Y, BVIV, BTC.D, USDT.D.

Проверяем: разбор каждого источника (Hyperliquid, курсы ЕЦБ, доминация
CoinMarketCap), формулу DXY по валютному дню и сверку курсов с ЕЦБ, что
снятые с торгов рынки не берутся, что сбой или мусор одного источника не
роняет остальные, правдоподобие (рамки, скачок за сутки), кэш, сборку в фоне,
память источников с запасом на сбой и бюджет запросов Hyperliquid. Правила
кода и права — test_markets_policy.py, случайные входы и договор с
приложением — test_markets_fuzz.py, атаки — test_markets_security.py.
"""
import calendar
import gc
import io
import json
import math
import os
import random
import sys
import threading
import time
import tracemalloc
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
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
# Запас золота и нефти — ответ Aster ticker/24hr, который берёт модуль фандинга.
ASTER = {"at": NOW - 300, "rows": [{"symbol": "BTCUSDT", "lastPrice": "100000", "openPrice": "99000"},
                                   {"symbol": "XAUUSDT", "lastPrice": "4072.07", "openPrice": "4081.61"},
                                   {"symbol": "CLUSDT", "lastPrice": "90.62", "openPrice": "90.02"}]}
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
PARTS = {"xyz": XYZ, "para": PARA, "mkts": MKTS, "fx": FX, "ecb": ECB, "mcap": MCAP, "aster": ASTER}


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


    def test_aster_is_only_a_backup_for_gold_and_oil(self):
        # Hyperliquid дал золото и нефть — берём его, Aster не смотрим.
        got = items(mk.compute(PARTS, NOW))
        self.assertEqual((got["GOLD"], got["OIL"]), ((4066.2, 4079.9), (90.205, 89.617)))
        # Hyperliquid молчит — золото и нефть с Aster (цена и открытие суток).
        got = items(mk.compute({**PARTS, "xyz": None}, NOW))
        self.assertEqual((got["GOLD"], got["OIL"]), ((4072.07, 4081.61), (90.62, 90.02)))
        self.assertNotIn("SP500", got)  # остальное Aster не заменяет
        # Снятое с торгов на Hyperliquid — тоже с Aster.
        xyz = hl(XYZ_M, delisted=("DXY", "VIX", "GOLD"))
        self.assertEqual(items(mk.compute({**PARTS, "xyz": xyz}, NOW))["GOLD"], (4072.07, 4081.61))
        # Неправдоподобная цена Hyperliquid (втрое за сутки) уступает Aster;
        # неправдоподобный Aster — не замена, пункта нет.
        xyz = hl({**XYZ_M, "xyz:GOLD": (12000, 4000), "xyz:CL": (90.2, 30.1)}, delisted=("DXY", "VIX"))
        got = items(mk.compute({**PARTS, "xyz": xyz}, NOW))
        self.assertEqual((got["GOLD"], got["OIL"]), ((4072.07, 4081.61), (90.62, 90.02)))
        wild = {**ASTER, "rows": [{"symbol": "XAUUSDT", "lastPrice": "12000", "openPrice": "4000"}]}
        self.assertNotIn("GOLD", items(mk.compute({**PARTS, "xyz": xyz, "aster": wild}, NOW)))
        # Ответ Aster старше получаса, из будущего, кривой — мимо.
        for bad in ({**ASTER, "at": NOW - mk.ASTER_AGE - 1}, {**ASTER, "at": NOW + 3600}, {**ASTER, "rows": "x"},
                    {"rows": ASTER["rows"]}, [ASTER], None, "x"):
            self.assertEqual(mk.aster_markets(bad, NOW), {}, bad)
        self.assertEqual(set(mk.aster_markets({**ASTER, "at": NOW - mk.ASTER_AGE}, NOW)), {"GOLD", "OIL"})
        # Повтор рынка — первый; чужие рынки и битые цены — мимо.
        rows = [{"symbol": "XAUUSDT", "lastPrice": "x", "openPrice": "1"}, {"symbol": "XAUUSDT", "lastPrice": "4000", "openPrice": "4010"},
                {"symbol": "XAUUSDT", "lastPrice": "1", "openPrice": "1"}, {"symbol": "SPXUSDT", "lastPrice": "0.35", "openPrice": "0.36"}]
        self.assertEqual(mk.aster_markets({"at": NOW, "rows": rows}, NOW), {"GOLD": (4000.0, 4010.0)})

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
        self.assertFalse(mk.sane("BTCD", (60, 100.5)))  # вчера — тоже в рамках
        self.assertFalse(mk.sane("US10Y", (4.8, 31)))
        self.assertFalse(mk.sane("BTCD", (100.5, 99)))
        self.assertFalse(mk.sane("BVIV", (0.42, 0.41)))  # доля вместо процентов

        para = hl({"para:10Y": (487.5, 487.77)})
        self.assertNotIn("US10Y", items(mk.compute({**PARTS, "para": para}, NOW)))
        xyz = hl({**XYZ_M, "xyz:CL": (90.2, 30.1)}, delisted=("DXY", "VIX"))
        self.assertNotIn("OIL", items(mk.compute({**PARTS, "xyz": xyz, "aster": None}, NOW)))

    def test_delisted_markets_are_not_taken(self):
        got = items(mk.compute(PARTS, NOW))
        self.assertNotAlmostEqual(got["DXY"][0], 97.15, places=1)  # застывший DXY Hyperliquid — мимо
        self.assertEqual(set(mk.hl_markets(XYZ)) & {"DXY", "VIX"}, set())
        self.assertNotIn("SILVER", got)  # не из набора

    def test_one_silent_source_drops_only_its_items(self):
        cases = {"ecb": {"DXY"}, "fx": {"DXY"}, "para": {"US10Y"}, "xyz": {"SP500", "XYZ100"},  # золото и нефть — с Aster
                 "mkts": {"BVIV"}, "mcap": {"BTCD", "USDTD"}, "aster": set()}
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


def join_new_threads(before: set) -> None:
    """Дождаться потоков, начатых тестом: опоздавший источник пишет в память
    модуля и после ответа сборки — без этого запись попадала в состояние
    следующего теста (гонка, ловилась только на медленной машине CI)."""
    for th in threading.enumerate():
        if th not in before and th is not threading.current_thread():
            th.join(5)


class CacheTest(unittest.TestCase):
    def setUp(self):
        quiet = mock.patch.object(mk.sys, "stderr", io.StringIO())  # журнал модуля — не в вывод тестов
        quiet.start()
        self.addCleanup(quiet.stop)
        self.addCleanup(setattr, mk, "_st", mk._st)
        self.addCleanup(join_new_threads, set(threading.enumerate()))
        mk._st = mk._State()

    def wait(self):
        job = mk._st.job
        if job is not None:
            job.join(5)

    def test_no_threads_left_builds_itself(self):
        # Потоков не хватило (как у карточки халвинга): сборка не падает и не
        # остаётся без ответа — источники спрашиваются по очереди в том же потоке.
        mk.set_sources({name: (lambda v=v: v) for name, v in PARTS.items()})
        with mock.patch.object(mk.threading.Thread, "start", side_effect=RuntimeError("can't start new thread")):
            res = mk.refresh()
        self.assertTrue(res["ok"])
        self.assertEqual(len(res["items"]), len(mk.KEYS))
        self.assertIsNone(mk._st.job)

    def test_cold_start_race_builds_once(self):
        # Сотня человек открывает меню на холодном сервере: одна сборка,
        # каждый источник спрошен один раз, у всех — один и тот же ответ.
        calls: list = []

        def slow(name, v):
            def fn():
                calls.append(name)
                time.sleep(0.2)
                return v
            return fn

        mk.set_sources({name: slow(name, v) for name, v in PARTS.items()})
        out: list = []
        mk.refresh()  # запуск сервера: сборка в фоне
        ts = [threading.Thread(target=lambda: out.append(mk.markets_data(5))) for _ in range(100)]
        ts += [threading.Thread(target=mk.refresh) for _ in range(20)]  # и круги обновления разом
        for t in ts:
            t.start()
        for t in ts:
            t.join(10)
        self.assertEqual(len(out), 100)
        self.assertTrue(out[0]["ok"])
        self.assertTrue(all(r is out[0] for r in out))
        self.assertEqual(sorted(calls), sorted(PARTS))

    def test_answer_time_is_when_prices_were_taken(self):
        # Время ответа — когда получены цены площадок, а не когда собран ответ:
        # из памяти — то же время и тот же объект (те же байты, «304»).
        mk.set_sources({name: (lambda v=v: v) for name, v in PARTS.items()})
        t, mono = [NOW], [1000.0]
        with mock.patch.object(mk, "_now", side_effect=lambda: t[0]), \
             mock.patch.object(mk.time, "monotonic", side_effect=lambda: mono[0]):
            first = mk.build()
            self.assertEqual(first["at"], NOW)
            t[0] += 300
            mono[0] += 300
            self.assertIs(mk.build(), first)  # цены из памяти — ответ тот же
            # Сменилась только доминация — новые цифры, но время цен прежнее.
            mk.set_sources({**{n: (lambda v=v: v) for n, v in PARTS.items()},
                            "mcap": lambda: {**PARTS["mcap"], "btc": [61.0, 60.35]}})
            second = mk.build()
            self.assertIsNot(second, first)
            self.assertEqual(second["at"], NOW)
            # Срок памяти площадок прошёл — цены спрошены заново: время новое.
            t[0] += 301
            mono[0] += 301
            self.assertEqual(mk.build()["at"], NOW + 601)
            # Площадка молчит — её прошлые цены, и время ответа честно прошлое
            # (самые старые из взятых), хотя другие площадки свежие.
            t[0] += 700
            mono[0] += 700
            mk.set_sources({**{n: (lambda v=v: v) for n, v in PARTS.items()}, "para": lambda: None})
            res = mk.build()
            self.assertEqual(res["at"], NOW + 601)
            self.assertEqual(mk._st.slow["xyz"][2], NOW + 1301)
            self.assertEqual(len(res["items"]), len(mk.KEYS))
            # Нет ни одной площадки — только доминация: время — сейчас.
            mk._st.slow.clear()
            only = mk.build()
            self.assertEqual(only["at"], t[0])

    def test_memory_and_threads_do_not_grow(self):
        # Тысячи ответов и сотни сборок (как у карточки халвинга): память и
        # потоки — те же. Растёт — значит модуль что-то копит.
        mk.set_sources({name: (lambda v=v: v) for name, v in PARTS.items()})
        threads = threading.active_count()
        for _ in range(100):  # разогрев: кэши самого Python
            mk.build()
        gc.collect()
        tracemalloc.start()
        before = tracemalloc.get_traced_memory()[0]
        for i in range(20_000):
            mk.markets_data(0)
            if i % 50 == 0:
                mk.build()
        gc.collect()
        grown = tracemalloc.get_traced_memory()[0] - before
        tracemalloc.stop()
        self.wait()
        self.assertLess(grown, 64 * 1024, f"память выросла на {grown} байт")
        self.assertLessEqual(threading.active_count(), threads)
        self.assertLessEqual(set(mk._st.slow), set(mk.SLOW))

    def test_journal_only_on_state_changes(self):
        # Источник замолчал — одна строка (с типом ошибки, без её текста: в
        # нём бывает адрес запроса), сколько бы сборок он ни молчал; ответил —
        # одна строка «снова отвечает». Пустой ответ — тоже одна строка.
        state = {"down": True}

        def ecb():
            if state["down"]:
                raise TimeoutError("https://secret.example/?key=SECRET\nподделка")
            return PARTS["ecb"]

        mk.set_sources({**{n: (lambda v=v: v) for n, v in PARTS.items()}, "ecb": ecb})
        err = io.StringIO()
        with mock.patch.object(mk.sys, "stderr", err), mock.patch.object(mk, "_now", return_value=NOW):
            for _ in range(5):
                mk._st.slow.pop("ecb", None)
                mk.build()
            state["down"] = False
            for _ in range(3):
                mk._st.slow.pop("ecb", None)
                mk.build()
            mk.set_sources({})
            mk._st.slow.clear()
            for _ in range(3):
                mk.build()
            mk.set_sources({n: (lambda v=v: v) for n, v in PARTS.items()})
            mk.build()
        lines = err.getvalue().splitlines()
        self.assertEqual(lines, ["markets: источник ecb молчит (TimeoutError)",
                                 "markets: источник ecb снова отвечает (молчал 0 мин)",
                                 "markets: ответа нет: ни одного пункта",
                                 "markets: ответ снова есть"])
        self.assertNotIn("SECRET", err.getvalue())
        # Ответил по делу: модуль доминации — не своим «нет данных», Aster — не пустотой.
        self.assertFalse(mk._answered("mcap", {"ok": False, "error": "no_key"}))
        self.assertTrue(mk._answered("mcap", PARTS["mcap"]))
        self.assertFalse(mk._answered("aster", None))
        self.assertFalse(mk._answered("xyz", [{"universe": []}, []]))

    def test_journal_line_is_one_clean_short_line(self):
        err = io.StringIO()
        with mock.patch.object(mk.sys, "stderr", err):
            mk._log("строка\nподделка\x1b[31m" + "я" * 1000)
        out = err.getvalue()
        self.assertEqual(out.count("\n"), 1)
        self.assertNotIn("\x1b", out)
        self.assertLessEqual(len(out), len("markets: ") + mk.LOG_MAX + 1)
        with mock.patch.object(mk.sys, "stderr", None):
            mk._log("журнал закрыт")  # не падает

    def test_people_only_read_the_cache(self):
        # Все видят кэш: запросы людей — даже тысяча, даже со старым ответом
        # — сборку не начинают и к источникам не ходят. Обновляет только сервер.
        calls: list = []
        mk.set_sources({name: (lambda v=v, n=name: calls.append(n) or v) for name, v in PARTS.items()})
        self.assertEqual(mk.markets_data(0), {"ok": False, "error": "no_data"})  # кэша нет — сборку не начинает
        self.assertIsNone(mk._st.job)
        self.assertEqual(calls, [])
        with mock.patch.object(mk, "_now", return_value=NOW):
            first = mk.refresh(5)
            self.assertTrue(first["ok"])
            self.assertEqual(len(calls), len(PARTS))
            mk._st.hit = (time.monotonic() - 20 * 60, first)  # двадцать минут без обновления
            for _ in range(1000):
                self.assertIs(mk.markets_data(), first)
            self.assertIsNone(mk._st.job)
            self.assertEqual(len(calls), len(PARTS))

    def test_cold_then_cached_then_background(self):
        calls: list = []
        mk.set_sources({name: (lambda v=v, n=name: calls.append(n) or v) for name, v in PARTS.items()})
        with mock.patch.object(mk, "_now", return_value=NOW):
            first = mk.refresh(5)
            self.assertTrue(first["ok"])
            self.assertEqual(len(calls), len(PARTS))
            self.assertIs(mk.markets_data(5), first)  # из кэша
            self.assertEqual(len(calls), len(PARTS))
            # Круг обновления: старый ответ — сразу, свежий собирается в фоне.
            self.assertIs(mk.refresh(), first)
            self.wait()
            # Источники из памяти (площадки Hyperliquid, ЕЦБ, свечи) свежи — их не спрашиваем.
            self.assertEqual(len(calls), 2 * len(PARTS) - len(mk.SLOW))
            self.assertEqual(sorted(calls[len(PARTS):]), sorted(set(PARTS) - set(mk.SLOW)))
            # Цифры те же — тот же объект: сервер отдаёт те же байты (и «304»).
            self.assertIs(mk._st.hit[1], first)

    def test_slow_sources_cached_then_kept_on_failure(self):
        calls: list = []
        live = {"ok": True}

        def src(name):
            def fn():
                calls.append(name)
                return PARTS[name] if live["ok"] else None
            return fn

        mk.set_sources({name: src(name) for name in PARTS})
        with mock.patch.object(mk, "_now", return_value=NOW):
            self.assertIn("DXY", items(mk.build()))
            self.assertEqual(set(mk._st.slow), set(mk.SLOW))
            # Срок свежести прошёл: спрашиваем снова (кроме свечей — в памяти
            # есть нужные закрытия), а источники молчат — берём прошлые годные
            # ответы, все пункты на месте.
            for name in mk.SLOW:
                at, raw, wall = mk._st.slow[name]
                mk._st.slow[name] = (at - mk.SLOW[name][0] - 1, raw, wall)
            live["ok"] = False
            calls.clear()
            res = mk.build()
            self.assertEqual(set(calls), set(PARTS) - {"fx"})
            # Все пункты на месте, кроме доминации: у неё свой кэш в модуле доминации.
            self.assertEqual(set(items(res)), set(mk.KEYS) - {"BTCD", "USDTD"})
            # Прошлый ответ старше запаса — пунктов без него нет (свечи с нужными
            # закрытиями годны в любом возрасте, но без курсов ЕЦБ DXY нет).
            for name in mk.SLOW:
                at, raw, wall = mk._st.slow[name]
                mk._st.slow[name] = (at - mk.SLOW[name][1], raw, wall)
            self.assertEqual(mk.build(), {"ok": False, "error": "no_data"})
            # Мусор вместо ответа не запоминается.
            live["ok"] = True
            mk._st.slow.clear()
            mk.set_sources({**{n: src(n) for n in PARTS}, "ecb": lambda: {"rates": "x"}, "fx": lambda: {"EUR": [1, {"t": "x", "c": "1"}], "JPY": [{"t": T}], "GBP": "x"},
                            "xyz": lambda: [{"universe": []}, []], "para": lambda: "x", "mkts": lambda: None})
            mk.build()
            self.assertEqual(mk._st.slow, {})
            # Свечи без одной из валют — тоже не запоминаются (а с ней — да).
            for bad in ({**FX, "GBP": []}, {c: [{"t": "x", "c": "1"}, {"t": T}, {"t": T, "c": "-1"}] for c in mk.FX_HL}):
                mk.set_sources({**{n: src(n) for n in PARTS}, "fx": lambda bad=bad: bad})
                mk.build()
                self.assertNotIn("fx", mk._st.slow)
            mk.set_sources({n: src(n) for n in PARTS})
            mk.build()
            self.assertIn("fx", mk._st.slow)

    def test_hyperliquid_budget(self):
        # Бюджет Hyperliquid общий для сервера: цены площадок — не чаще раза в
        # 10 минут, свечи — только когда в памяти нет нужного закрытия.
        calls: list = []
        mk.set_sources({name: (lambda v=v, n=name: calls.append(n) or v) for name, v in PARTS.items()})
        hl_names = {"xyz", "para", "mkts", "fx"}
        t, mono = [NOW], [1000.0]
        with mock.patch.object(mk, "_now", side_effect=lambda: t[0]), \
             mock.patch.object(mk.time, "monotonic", side_effect=lambda: mono[0]):
            for _ in range(60):  # час, раз в минуту
                mk.build()
                t[0] += 60
                mono[0] += 60
        asked = [c for c in calls if c in hl_names]
        self.assertEqual(asked.count("fx"), 1)  # выходные: закрытия пятницы и четверга уже в памяти
        for dex in ("xyz", "para", "mkts"):
            self.assertEqual(asked.count(dex), 6, dex)  # раз в 10 минут
        self.assertEqual(mk.SLOW["xyz"][0], 600.0)
        # Вес запросов Hyperliquid в минуту — около 0,5 % от 1200.
        self.assertLessEqual((3 * 6 * 20 + 22) / 60, 7)

    def test_fx_candles_asked_again_only_after_new_close(self):
        self.assertTrue(mk.fx_covers(FX, NOW))
        self.assertTrue(mk.fx_covers(FX, WD))  # будни: нужно только прошлое закрытие (четверг)
        self.assertFalse(mk.fx_covers(FX, FRI + 7 * 86400))  # неделя прошла — закрытий нет
        self.assertFalse(mk.fx_covers({**FX, "GBP": []}, NOW))
        self.assertFalse(mk.fx_covers(None, NOW))
        # Выходные: нужны оба закрытия — пятницы и четверга; в будни — только
        # последнее (вчерашнее), позавчерашнего может и не быть.
        only_fri = {c: [x for x in v if x["t"] >= (FRI - 3600) * 1000] for c, v in FX.items()}
        self.assertFalse(mk.fx_covers(only_fri, NOW))
        since_thu = {c: [x for x in v if x["t"] >= (THU - 3600) * 1000] for c, v in FX.items()}
        self.assertTrue(mk.fx_covers(since_thu, WD))
        self.assertTrue(mk.fx_covers(since_thu, NOW))
        # Понедельник после закрытия (22:00 UTC): нужно закрытие понедельника — его нет.
        self.assertFalse(mk.fx_covers(FX, FRI + 3 * 86400 + 60))

    def test_parse_edges(self):
        # Логическое — не число (JSON true), цена за пределом — не цена.
        self.assertIsNone(mk.pair(True, True))
        self.assertIsNone(mk.pair(mk.PX_MAX, 1))
        self.assertEqual(mk.pair("7373.1", 7392.9), (7373.1, 7392.9))
        self.assertEqual(mk.hl_markets(hl({"xyz:SP500": (mk.PX_MAX * 2, 7000), "xyz:GOLD": (4066, 4079)})), {"GOLD": (4066.0, 4079.0)})
        bad = hl({"xyz:SP500": (7373, 7392)})
        bad[1][0] = {"markPx": True, "prevDayPx": True}
        self.assertEqual(mk.hl_markets(bad), {})
        # День ЕЦБ — только дата «ГГГГ-ММ-ДД».
        day = ECB["rates"]["2026-11-06"]
        self.assertEqual(set(mk.ecb_rates({"rates": {"x": day, "2026-11-06T00": day, " 2026-11-06": day, "2026-11-06": day}})),
                         {"2026-11-06"})
        # Доминация — только из годного ответа модуля.
        for ok in (False, None, "true", 1):
            self.assertEqual(mk.dominance({**MCAP, "ok": ok}), {}, ok)

    def test_ny_offset_edges(self):
        # Летнее время Нью-Йорка: с 2:00 второго воскресенья марта до 2:00
        # первого воскресенья ноября (местных) — и ни днём раньше.
        def at(s):
            return calendar.timegm(time.strptime(s, "%Y-%m-%d %H:%M"))
        for when, off in (("2026-03-07 12:00", -5), ("2026-03-08 06:59", -5), ("2026-03-08 07:00", -4),
                          ("2026-10-31 12:00", -4), ("2026-11-01 05:59", -4), ("2026-11-01 06:00", -5),
                          ("2027-03-14 07:00", -4), ("2027-03-13 12:00", -5), ("2027-11-06 12:00", -4)):
            self.assertEqual(mk.ny_offset(at(when)), off * 3600, when)

    def test_parse_limits(self):
        # Огромные ответы: хвост за пределом не смотрим — и не падаем.
        big = [{"universe": [{"name": f"xyz:M{i}"} for i in range(mk.UNI_MAX)] + [{"name": "xyz:SP500"}]},
               [{"markPx": "1", "prevDayPx": "1"}] * mk.UNI_MAX + [{"markPx": "7000", "prevDayPx": "7000"}]]
        self.assertNotIn("SP500", mk.hl_markets(big))
        many = {"rates": {f"2026-{m:02d}-{d:02d}": ECB["rates"]["2026-11-06"] for m in range(1, 13) for d in range(1, 29)}}
        self.assertEqual(len(mk.ecb_rates(many)), mk.DAYS_MAX)
        tail = FX["EUR"] + [{"t": 0, "c": "1"}] * mk.CANDLES_MAX
        self.assertEqual(mk.candle_close(tail, FRI), 0.0)

    def test_failing_sources(self):
        def boom():
            raise OSError("нет сети")

        mk.set_sources({name: boom for name in PARTS})
        self.assertEqual(mk.refresh(5), {"ok": False, "error": "no_data"})
        self.wait()
        # После сбоя — пауза FAIL_WAIT: новая сборка не начинается, источники не трогаем.
        calls: list = []
        mk.set_sources({name: (lambda: calls.append(1)) for name in PARTS})
        self.assertEqual(mk.refresh(5), {"ok": False, "error": "no_data"})
        self.assertIsNone(mk._st.job)
        self.assertEqual(calls, [])
        mk._st.fail = time.monotonic() - mk.FAIL_WAIT - 1
        mk.set_sources({})
        self.assertEqual(mk.refresh(5), {"ok": False, "error": "no_data"})

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
        before = set(threading.enumerate())
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
        join_new_threads(before)
        self.assertNotIn("US10Y", items(res))
        self.assertIn("para", mk._st.slow)  # опоздавший ответ запомнен — для следующей сборки

    def test_slow_source_waits_no_longer_than_asked(self):
        gate = threading.Event()
        self.addCleanup(gate.set)
        mk.set_sources({"xyz": lambda: XYZ, "para": lambda: gate.wait(10) and PARA})
        with mock.patch.object(mk, "_now", return_value=NOW):
            t0 = time.monotonic()
            mk.refresh()
            self.assertEqual(mk.markets_data(0.2), {"ok": False, "error": "no_data"})
            self.assertLess(time.monotonic() - t0, 2)
            gate.set()
            self.wait()
            self.assertTrue(mk.markets_data(0)["ok"])

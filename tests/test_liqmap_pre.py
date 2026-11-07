"""Карта ликвидаций: предыстория (wt_liqmap.PRE) и источник Kraken Futures.

Без предыстории модель видела только позиции, открытые за окно: у суток —
десятую часть интереса. Теперь каждое окно начинается с дневных свечей бирж
до своего начала. Проверяем: склейку рядов, что предыстория одна на монету
для всех окон, обновляется в фоне, сбой бирж не ломает карту, кэш ограничен;
и разбор ответов Kraken.
"""
import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модули лежат в корне репозитория
import wt_liqmap as lm  # noqa: E402

DAY = 86400
T0 = 400 * DAY  # начало окна


def window(n=96, px=100.0, oi=1e9):
    """Окно 15-минутных свечей у цены px, интерес чуть растёт."""
    return [(T0 + i * 900, px * 1.002, px * 0.998, px, oi + 1e6 * i, 0.5) for i in range(n)]


def history(days=300, px=80.0, oi0=2e8, oi1=1e9):
    """Дневные свечи до окна у цены px: интерес растёт от oi0 до oi1 (в монетах — тоже)."""
    return [(T0 - (days - d) * DAY, px * 1.01, px * 0.99, px, oi0 + (oi1 - oi0) * d / days, 0.6) for d in range(days)]


class Base(unittest.TestCase):
    def setUp(self):
        lm._st = lm._State()
        self.addCleanup(setattr, lm, "_st", lm._State())
        self.calls = []

    def use(self, pre=None, win=None, delay=0.0, fail=False):
        def fn(sym, period, n):
            self.calls.append((sym, period, n))
            if (period, n) == lm.PRE:
                if delay:
                    time.sleep(delay)
                if fail:
                    raise OSError("биржи молчат")
                return (pre if pre is not None else {"OKX": history()}), None
            r = win or window()
            return {"OKX": r}, r
        lm.set_gather(fn)

    def pre_calls(self):
        return [c for c in self.calls if (c[1], c[2]) == lm.PRE]


class PrependTest(unittest.TestCase):
    def test_only_days_that_ended_before_the_window(self):
        rows = window(4)
        pre = [(T0 - 2 * DAY, 1, 1, 1, 1, 0.5), (T0 - DAY, 1, 1, 1, 1, 0.5), (T0 - DAY + 1, 1, 1, 1, 1, 0.5), (T0, 1, 1, 1, 1, 0.5)]
        out = lm.prepend(pre, rows)
        self.assertEqual(out[:2], pre[:2])  # день, что кончился ровно к началу окна, — берётся
        self.assertEqual(out[2:], rows)  # заходящий в окно — нет
        self.assertIs(lm.prepend(None, rows), rows)
        self.assertIs(lm.prepend([], rows), rows)
        self.assertEqual(lm.prepend(pre, []), [])


class PreBuildTest(Base):
    def test_window_shows_only_positions_opened_in_it(self):
        self.use(pre={})
        bare = lm.build("BTC", "1d")
        lm._st = lm._State()
        self.use()
        full = lm.build("BTC", "1d")
        self.assertTrue(bare["ok"] and full["ok"])
        # Предыстория (позиции у 80, лонги 10× — около 72) на карту окна не идёт.
        self.assertFalse([b for b in full["buckets"] if 70 <= b["p"] <= 74 and sum(b["L"])])
        self.assertAlmostEqual(full["seen"] / bare["seen"], 1.0, delta=0.05)
        # Интерес, биржи и путь цены — по окну.
        self.assertEqual(full["oi"], bare["oi"])
        self.assertEqual(full["ex"], ["OKX"])
        self.assertEqual(full["path"], bare["path"])

    def test_history_still_explains_the_fall_of_interest(self):
        # До окна — лонги 500× на 100 (ликвидация у 99,9); в окне открылись
        # шорты 500× на 100 (ликвидация у 100,1); свеча сходила до 99,5 и
        # сожгла старые лонги, интерес упал на столько же. С историей падение
        # объяснено ликвидациями — шорты окна живы; без неё модель закрыла бы их.
        only500 = ((500, 1.0, 4),)
        lo, step = 0.0, 0.25
        rows = [(0, 100, 100, 100, 0, 1.0), (900, 100, 100, 100, 0, 1.0), (1800, 100, 100, 100, 1000, 0.0),
                (2700, 100, 100, 100, 2000, 0.0), (3600, 100, 99.5, 100, 2000, 0.0), (4500, 100, 100, 100, 1000, 0.0)]
        since = 1800  # окно: шаги со свечи 1800 — шорты; лонги шага 2 (свеча 900) — история
        _, shorts, seen = lm.model(rows, lo, step, only500, since=since)
        self.assertAlmostEqual(seen, 10.0, places=6)
        self.assertAlmostEqual(sum(map(sum, shorts)), 10.0, places=6)
        _, shorts_bare, seen_bare = lm.model(rows[2:], lo, step, only500, since=since)
        self.assertLess(seen_bare, 0.5)
        self.assertLess(sum(map(sum, shorts_bare)), 0.5)

    def test_without_cutoff_everything_counts(self):
        rows = [(i * 900, 100, 99, 100, 1000 + 100 * i, 0.6) for i in range(20)]
        a = lm.model(rows, 0.0, 0.25)
        b = lm.model(rows, 0.0, 0.25, since=0)
        self.assertAlmostEqual(a[2], b[2], places=6)
        for side in (0, 1):
            for g in range(len(lm.GROUPS)):
                for k in range(lm.BUCKETS):
                    self.assertAlmostEqual(a[side][g][k], b[side][g][k], places=6)
        late = lm.model(rows, 0.0, 0.25, since=rows[10][0])
        self.assertLess(late[2], a[2])
        self.assertGreater(late[2], 0)

    def test_history_keeps_window_positions_when_old_ones_are_liquidated(self):
        # Сборка целиком: до окна — лонги у 100 (интерес растёт до $50 млн); в
        # окне открылись шорты, потом свеча сходила до 95 и сожгла старые
        # лонги, а интерес упал меньше сгоревшего. С историей падение
        # объяснено ликвидациями — шорты окна живы; без истории модель
        # закрыла бы их (самые свежие — первыми).
        pre = {"OKX": history(days=300, px=100.0, oi0=1e7, oi1=5e7)}
        win = [(T0 + i * 900, 100.1, 99.9, 100.0, 5e7 + 2.5e4 * min(i, 40), 0.0) for i in range(60)]
        win[40] = (T0 + 40 * 900, 100.0, 95.0, 100.0, 5.1e7, 0.0)
        for i in range(41, 60):
            win[i] = (T0 + i * 900, 100.1, 99.9, 100.0, 5.1e7 - 5e5, 0.0)
        self.use(pre={}, win=win)
        bare = lm.build("BTC", "1d")
        lm._st = lm._State()
        self.use(pre=pre, win=win)
        full = lm.build("BTC", "1d")
        self.assertTrue(bare["ok"] and full["ok"])
        self.assertGreater(full["seen"], bare["seen"] * 1.5)
        shorts = sum(sum(b["S"]) for b in full["buckets"])
        self.assertGreater(shorts, sum(sum(b["S"]) for b in bare["buckets"]) * 1.5)

    def test_exchange_only_in_history_is_not_on_the_map(self):
        self.use(pre={"OKX": history(), "Gone": history()})
        self.assertEqual(lm.build("BTC", "1d")["ex"], ["OKX"])

    def test_one_history_per_coin_for_all_windows(self):
        self.use()
        for rng in ("1d", "7d", "30d"):
            self.assertTrue(lm.build("BTC", rng)["ok"])
        self.assertEqual(self.pre_calls(), [("BTC", *lm.PRE)])
        lm.build("ETH", "1d")
        self.assertEqual(len(self.pre_calls()), 2)

    def test_dirty_history_is_cleaned(self):
        bad = [*history(), (T0 - 5, float("nan"), 1, 1, 1, 0.5), "x"]
        self.use(pre={"OKX": bad, "Short": history()[:3]})
        self.assertTrue(lm.build("BTC", "1d")["ok"])
        got = lm._st.pre["BTC"][1]
        self.assertEqual(sorted(got), ["OKX"])  # меньше восьми строк — не ряд
        self.assertEqual(len(got["OKX"]), len(history()))

    def test_exchanges_silent_map_still_builds_and_asks_later(self):
        self.use(fail=True)
        r = lm.build("BTC", "1d")
        self.assertTrue(r["ok"])
        self.assertNotIn("BTC", lm._st.pre)
        # Снова спросим через PRE_RETRY, а не через PRE_TTL и не на каждой сборке.
        self.assertLess(time.monotonic() - lm._st.pre_retry["BTC"], 5)
        lm.build("BTC", "7d")
        self.assertEqual(len(self.pre_calls()), 1)
        lm._st.pre_retry["BTC"] -= lm.PRE_RETRY
        self.use()
        lm.build("BTC", "30d")
        self.assertEqual(len(self.pre_calls()), 2)  # пауза прошла — спросили снова
        self.assertIn("BTC", lm._st.pre)
        self.assertNotIn("BTC", lm._st.pre_retry)

    def test_silent_exchanges_do_not_make_old_history_young(self):
        # Сбой не обновляет время прежней предыстории: старше PRE_STALE она не
        # берётся, сколько бы биржи ни молчали (раньше «молодела» с каждым сбоем).
        self.use()
        lm.build("BTC", "1d")
        born, rows = lm._st.pre["BTC"]
        lm._st.pre["BTC"] = (born - lm.PRE_TTL - 1, rows)
        self.use(fail=True)
        lm._pre_fetch("BTC")
        self.assertEqual(lm._st.pre["BTC"], (born - lm.PRE_TTL - 1, rows))
        lm._st.pre["BTC"] = (time.monotonic() - lm.PRE_STALE - 1, rows)
        lm._pre_fetch("BTC")
        self.assertEqual(lm._pre("BTC", 0), {})  # слишком старая — окно без неё

    def test_failure_keeps_the_previous_history(self):
        self.use()
        lm.build("BTC", "1d")
        old = lm._st.pre["BTC"][1]
        self.use(fail=True)
        lm._pre_fetch("BTC")
        self.assertIs(lm._st.pre["BTC"][1], old)

    def test_old_history_served_at_once_and_refreshed_in_background(self):
        self.use()
        lm.build("BTC", "1d")
        _, rows = lm._st.pre["BTC"]
        lm._st.pre["BTC"] = (time.monotonic() - lm.PRE_TTL - 1, rows)
        self.use(pre={"OKX": history(oi1=3e9)}, delay=0.5)
        t = time.monotonic()
        self.assertIs(lm._pre("BTC", lm.PRE_WAIT), rows)  # не ждёт
        self.assertLess(time.monotonic() - t, 0.3)
        for _ in range(100):
            if "BTC" not in lm._st.pre_jobs:
                break
            time.sleep(0.02)
        self.assertIsNot(lm._st.pre["BTC"][1], rows)

    def test_too_old_history_is_not_used_first_build_waits(self):
        self.use()
        lm.build("BTC", "1d")
        _, rows = lm._st.pre["BTC"]
        lm._st.pre["BTC"] = (time.monotonic() - lm.PRE_STALE - 1, rows)
        self.use(pre={"OKX": history(oi1=3e9)}, delay=0.2)
        got = lm._pre("BTC", lm.PRE_WAIT)
        self.assertIsNot(got, rows)
        self.assertTrue(got)
        # Не дождались — пусто, а не протухшая.
        lm._st.pre["BTC"] = (time.monotonic() - lm.PRE_STALE - 1, rows)
        self.use(delay=0.5)
        self.assertEqual(lm._pre("BTC", 0.05), {})

    def test_one_fetch_however_many_builds_ask(self):
        gate = threading.Event()

        def fn(sym, period, n):
            self.calls.append((sym, period, n))
            if (period, n) == lm.PRE:
                gate.wait(5)
                return {"OKX": history()}, None
            return {"OKX": window()}, window()
        lm.set_gather(fn)
        for _ in range(5):
            lm._pre("BTC", 0)
        gate.set()
        lm._pre("BTC", lm.PRE_WAIT)
        self.assertEqual(len(self.pre_calls()), 1)

    def test_cache_bounded(self):
        self.use()
        for i in range(lm.PRE_MAX + 5):
            lm._pre_fetch(f"C{i}")
        self.assertEqual(len(lm._st.pre), lm.PRE_MAX)
        self.assertNotIn("C0", lm._st.pre)  # вытесняются самые старые
        self.assertIn(f"C{lm.PRE_MAX + 4}", lm._st.pre)

    def test_without_source_nothing_starts(self):
        lm.set_gather(None)
        self.assertEqual(lm._pre("BTC", 1.0), {})
        self.assertEqual(lm._st.pre_jobs, {})

    def test_constants(self):
        self.assertEqual(lm.PRE, ("1d", 1000))
        self.assertEqual(lm.PRE_SEC, 86400)
        self.assertLess(lm.PRE_RETRY, lm.PRE_TTL)
        self.assertLess(lm.PRE_TTL, lm.PRE_STALE)


class KrakenTest(unittest.TestCase):
    def reply(self, kl, oi, ad):
        def fake(url, timeout=10.0):
            if "/trade/" in url:
                return {"candles": kl} if kl is not None else None
            if "open-interest" in url:
                return {"result": oi} if oi is not None else None
            if "aggressor-differential" in url:
                return {"result": ad} if ad is not None else None
            raise AssertionError(url)
        return mock.patch.object(api, "get_json", side_effect=fake)

    def test_rows(self):
        kl = [{"time": 900_000, "open": "100", "high": "110", "low": "90", "close": "105", "volume": "10"},
              {"time": 1_800_000, "open": "105", "high": "106", "low": "104", "close": "105", "volume": "0"},
              {"time": 2_700_000, "open": "105", "high": "106", "low": "104", "close": "105", "volume": "4"},
              {"time": 3_600_000, "open": "1", "high": "1", "low": "1", "close": "1", "volume": "1"}]
        oi = {"timestamp": [900, 1800, 2700], "data": [["2", "3", "1", "2.5"], ["3", "3", "3", "3"], ["4", "4", "4", "4"]]}
        ad = {"timestamp": [900, 2700], "data": ["-4", "-100"]}  # продажи минус покупки: покупали больше
        with self.reply(kl, oi, ad) as get:
            rows = api._liq_kraken("BTC", "15m", 3)
        self.assertIn("PF_XBTUSD", get.call_args_list[0].args[0])
        self.assertEqual(rows, [
            (900, 110.0, 90.0, 105.0, 200.0, 0.7),  # интерес — монеты на начало × открытие; покупки 0,5 − (−4)/20
            (1800, 106.0, 104.0, 105.0, 315.0, 0.5),  # без объёма — поровну
            (2700, 106.0, 104.0, 105.0, 420.0, 1.0),  # доля не больше единицы
        ])  # свеча без интереса — не строка

    def test_differential_is_sells_minus_buys(self):
        # Kraken: на растущей свече «aggressor differential» отрицательный.
        kl = [{"time": 900_000, "open": "100", "high": "110", "low": "99", "close": "109", "volume": "10"},
              {"time": 1_800_000, "open": "109", "high": "110", "low": "95", "close": "96", "volume": "10"}]
        oi = {"timestamp": [900, 1800], "data": [["2"], ["2"]]}
        with self.reply(kl, oi, {"timestamp": [900, 1800], "data": ["-6", "6"]}):
            rows = api._liq_kraken("BTC", "15m", 2)
        self.assertEqual([r[5] for r in rows], [0.8, 0.2])  # рост — покупали, падение — продавали

    def test_alt_symbol_and_bad_replies(self):
        with self.reply([], {"timestamp": [], "data": []}, None) as get:
            self.assertIsNone(api._liq_kraken("SOL", "1d", 5))
        self.assertIn("PF_SOLUSD", get.call_args_list[0].args[0])
        for kl, oi in ((None, {"timestamp": [], "data": []}), ([], None), ([], {"timestamp": "x", "data": []}),
                       (["x", 1], {"timestamp": [1], "data": ["bad"]})):
            with self.reply(kl, oi, None):
                self.assertIsNone(api._liq_kraken("BTC", "1h", 5))

    def test_in_sources_with_cap(self):
        self.assertIn("Kraken", dict(api.LIQ_SOURCES))
        self.assertEqual(lm.CAPS["Kraken"], 50)


class OkxTest(unittest.TestCase):
    """OKX: интерес USDT-контракта и бессрочного с расчётом в монете (BTC-USD-SWAP) — вместе."""

    def run_okx(self, inv_ts):
        ts = [str(t * 900_000) for t in (3, 2, 1)]  # OKX отдаёт от новых к старым

        def fake(url, timeout=10.0):
            if "end=" in url or "after=" in url:
                return {"data": []}
            if "open-interest-history" in url and "-USDT-SWAP" in url:
                return {"data": [[t, "0", "0", "100"] for t in ts]}
            if "open-interest-history" in url and "-USD-SWAP" in url:
                return {"data": [[t, "0", "0", "40"] for t in ts if int(t) // 900_000 in inv_ts]}
            if "history-candles" in url:
                return {"data": [[t, "1", "2", "0.5", "1.5"] for t in ts]}
            if "taker-volume" in url:
                return {"data": [[t, "1", "3"] for t in ts]}
            raise AssertionError(url)
        with mock.patch.object(api, "get_json", side_effect=fake):
            return api._liq_okx("BTC", "15m", 3)

    def test_coin_margined_added_on_common_times(self):
        rows = self.run_okx({1, 2, 3})
        self.assertEqual([r[4] for r in rows], [140.0, 140.0, 140.0])
        self.assertEqual(rows[0], (900, 2.0, 0.5, 1.5, 140.0, 0.75))

    def test_short_coin_margined_series_is_not_glued(self):
        # Ряд с расчётом в монете короче — его начало стало бы ложным «открытием позиций».
        rows = self.run_okx({3})
        self.assertEqual([r[4] for r in rows], [100.0, 100.0, 100.0])
        rows = self.run_okx(set())
        self.assertEqual([r[4] for r in rows], [100.0, 100.0, 100.0])


class InverseTest(unittest.TestCase):
    """Binance COIN-M и Bybit inverse — к основному контракту, по общим отметкам."""

    TS = (900, 1800, 2700)

    def binance(self, cm_ts, usdc_ts=()):
        def fake(url, timeout=10.0):
            if "fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDC&" in url:
                if not usdc_ts:
                    return {"code": -1121, "msg": "Invalid symbol."}
                return [{"timestamp": t * 1000, "sumOpenInterestValue": "400"} for t in usdc_ts]
            if "fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&" in url:
                return [{"timestamp": t * 1000, "sumOpenInterestValue": "1000"} for t in self.TS]
            if "dapi.binance.com/futures/data/openInterestHist" in url:
                return [{"timestamp": t * 1000, "sumOpenInterestValue": "2"} for t in cm_ts]  # в монетах
            if "klines" in url:
                return [[t * 1000, "50", "60", "40", "55"] for t in self.TS]
            if "takerlongshortRatio" in url:
                return [{"timestamp": t * 1000, "buySellRatio": "3"} for t in self.TS]
            raise AssertionError(url)
        with mock.patch.object(api, "get_json", side_effect=fake):
            return api._liq_binance("BTC", "15m", 3)

    def test_binance_coin_m_in_dollars_at_the_snapshot_price(self):
        rows = self.binance(self.TS)
        self.assertEqual(rows[0], (900, 60.0, 40.0, 55.0, 1100.0, 0.75))  # 1000 + 2 монеты × открытие 50
        self.assertEqual(len(rows), 3)
        self.assertEqual([r[4] for r in self.binance((2700,))], [1000.0] * 3)  # короткий ряд — не клеим
        self.assertEqual([r[4] for r in self.binance(())], [1000.0] * 3)

    def test_binance_usdc_margined_added(self):
        # BTCUSDC и ETHUSDC — отдельные рынки Binance: у ETH треть интереса.
        self.assertEqual([r[4] for r in self.binance(self.TS, self.TS)], [1500.0] * 3)
        self.assertEqual([r[4] for r in self.binance((), self.TS)], [1400.0] * 3)
        self.assertEqual([r[4] for r in self.binance((), (2700,))], [1000.0] * 3)  # короткий ряд — не клеим

    def bybit(self, inv_ts):
        def fake(url, timeout=10.0):
            if "cursor=" in url:
                return {"result": {"list": []}}
            if "open-interest?category=linear" in url:
                # Как отвечает Bybit: openInterest — обе стороны, single… — одна.
                return {"result": {"list": [{"timestamp": str(t * 1000), "openInterest": "20", "singleOpenInterest": "10"} for t in self.TS]}}
            if "open-interest?category=inverse" in url:
                self.assertIn("symbol=BTCUSD&", url)
                return {"result": {"list": [{"timestamp": str(t * 1000), "openInterest": "600", "singleOpenInterest": "300"} for t in inv_ts]}}  # в долларах
            if "kline" in url:
                return {"result": {"list": [[str(t * 1000), "50", "60", "40", "55"] for t in self.TS]}}
            if "account-ratio" in url:
                return {"result": {"list": [{"timestamp": str(t * 1000), "buyRatio": "0.6"} for t in self.TS]}}
            raise AssertionError(url)
        with mock.patch.object(api, "get_json", side_effect=fake):
            return api._liq_bybit("BTC", "15m", 3)

    def test_bybit_inverse_already_in_dollars(self):
        rows = self.bybit(self.TS)
        self.assertEqual(rows[0], (900, 60.0, 40.0, 55.0, 850.0, 0.6))  # 10 монет × 55 + $300
        self.assertEqual([r[4] for r in self.bybit((900,))], [550.0] * 3)
        self.assertEqual([r[4] for r in self.bybit(())], [550.0] * 3)

    def test_bybit_open_interest_is_one_side(self):
        # Сервер: singleOpenInterest ровно вдвое меньше openInterest — и сейчас,
        # и в истории, у USDT- и у инверсных контрактов.
        self.assertEqual(api._bybit_oi({"openInterest": "70608.123", "singleOpenInterest": "35304.062"}), 35304.062)
        self.assertEqual(api._bybit_oi({"openInterest": "100"}), 50.0)  # поля нет — половина
        self.assertEqual(api._bybit_oi({"openInterest": "100", "singleOpenInterest": "0"}), 50.0)
        self.assertEqual(api._bybit_oi({}), 0.0)

    def test_glue(self):
        self.assertEqual(api._glue_inverse({1: 1.0, 2: 1.0}, {1: 5.0, 2: 5.0}), {1: 6.0, 2: 6.0})
        self.assertEqual(api._glue_inverse({}, {1: 5.0}), {})
        many = {t: 1.0 for t in range(40)}
        self.assertEqual(len(api._glue_inverse(many, {t: 1.0 for t in range(39)})), 39)  # 97,5 % — клеим общие
        self.assertIs(api._glue_inverse(many, {t: 1.0 for t in range(37)}), many)  # 92,5 % — нет


class StockTest(unittest.TestCase):
    """Акции под разными именами бирж — одна бумага на карте."""

    def test_names(self):
        for raw, want in (("TSLAX", "TSLA"), ("TSLASTOCK", "TSLA"), ("TSLA", "TSLA"), ("AAPLSTOCK", "AAPL"),
                          ("NFLX", "NFLX"), ("NFLXX", "NFLX"), ("COINX", "COIN"), ("SPYX", "SPY")):
            self.assertEqual(api._stock_base(raw), want, raw)
        # Криптовалюты с хвостом X — не акции (MUX — не Micron, HDX — не Home Depot).
        for raw in ("MUX", "HDX", "MAX", "VX", "TRX", "SNX", "IMX", "BTCX", "XSTOCK"):
            self.assertEqual(api._stock_base(raw), raw, raw)
        self.assertEqual(api._liq_sym("TSLAX"), "TSLA")
        self.assertEqual(api._liq_sym("1000PEPE"), "PEPE")
        self.assertEqual(api._snap_sym("tslastock"), "TSLA")
        self.assertEqual(api._snap_sym("XBT"), "BTC")

    def test_xstocks_asked_when_the_plain_name_is_empty(self):
        rows = [(i * 900, 1.0, 1.0, 1.0, 5.0, 0.5) for i in range(10)]
        asked = []

        def fn(sym, period, n):
            asked.append(sym)
            return rows if sym.endswith("X") else None
        wrapped = api._liq_stock(fn)
        self.assertEqual(wrapped("TSLA", "1h", 10), rows)
        self.assertEqual(asked, ["TSLA", "TSLAX"])
        asked.clear()
        self.assertIsNone(wrapped("BTC", "1h", 10))  # не акция — без второго запроса
        self.assertIsNone(wrapped("MU", "1h", 10))  # короткий тикер — MUX чужая монета
        self.assertEqual(asked, ["BTC", "MU"])
        # Под своим именем есть — второго запроса нет.
        asked.clear()
        self.assertEqual(api._liq_stock(lambda s, p, n: asked.append(s) or rows)("TSLA", "1h", 10), rows)
        self.assertEqual(asked, ["TSLA"])
        names = dict(api.LIQ_SOURCES)
        for ex in ("HTX", "Kraken", "dYdX"):
            self.assertIn("_liq_stock", names[ex].__qualname__, ex)


class NewSnapTest(unittest.TestCase):
    def test_bitmex(self):
        inst = [
            {"symbol": "XBTUSD", "typ": "FFWCSX", "state": "Open", "underlying": "XBT", "quoteCurrency": "USD",
             "settlCurrency": "XBt", "openValue": 2e8, "markPrice": 50000},  # 2 BTC — $100 000
            {"symbol": "XBTUSDT", "typ": "FFWCSX", "state": "Open", "underlying": "XBT", "quoteCurrency": "USDT",
             "settlCurrency": "USDt", "openValue": 3e10, "markPrice": 50010},  # $30 000
            {"symbol": "ETHUSD", "typ": "FFWCSX", "state": "Open", "underlying": "ETH", "quoteCurrency": "USD",
             "settlCurrency": "XBt", "openValue": 1e8, "markPrice": 3000},  # квантовый: 1 BTC — $50 000
            {"symbol": "XBTZ26", "typ": "FFCCSX", "state": "Open", "underlying": "XBT", "quoteCurrency": "USD",
             "settlCurrency": "XBt", "openValue": 9e9, "markPrice": 51000},  # срочный — не бессрочный
            {"symbol": "SOLUSD", "typ": "FFWCSX", "state": "Unlisted", "underlying": "SOL", "quoteCurrency": "USD",
             "settlCurrency": "XBt", "openValue": 9e9, "markPrice": 100},
            {"symbol": "XBTEUR", "typ": "FFWCSX", "state": "Open", "underlying": "XBT", "quoteCurrency": "EUR",
             "settlCurrency": "XBt", "openValue": 9e9, "markPrice": 46000},
            "мусор",
        ]
        with mock.patch.object(api, "get_json", return_value=inst):
            out = api._snap_bitmex()
        self.assertEqual(set(out), {"BTC", "ETH"})
        self.assertAlmostEqual(out["BTC"][0], 130000.0)
        self.assertEqual(out["BTC"][1], 50000)
        self.assertAlmostEqual(out["ETH"][0], 50000.0)
        with mock.patch.object(api, "get_json", return_value=None):
            self.assertEqual(api._snap_bitmex(), {})

    def test_apex(self):
        def fake(url, timeout=10.0):
            sym = url.split("symbol=")[1].removesuffix("USDT")
            if sym == "BTC":
                return {"data": [{"openInterest": "2", "markPrice": "50000"}]}
            if sym == "ETH":
                raise OSError("сеть")
            return {"data": []}
        with mock.patch.object(api, "get_json", side_effect=fake) as get:
            out = api._snap_apex()
        self.assertEqual(out, {"BTC": (100000.0, 50000.0)})
        self.assertEqual(get.call_count, len(api.LIQ_APEX))
        self.assertLessEqual(len(api.LIQ_APEX), 20)

    def test_phemex_counts_inverse_and_usdc(self):
        # Сверка с CoinGecko: у Phemex BTC брался только USDT ($178M из $1209M) —
        # инверсный BTCUSD (контракт $1) держит больше половины интереса.
        v3 = {"result": [
            {"symbol": "BTCUSDT", "markRp": "50000", "openInterestRv": "2"},
            {"symbol": "BTCUSDC", "markRp": "50010", "openInterestRv": "1"},
            {"symbol": "ETHUSDT", "markRp": "3000", "openInterestRv": "10"},
            {"symbol": "1000PEPEUSDT", "markRp": "0.01", "openInterestRv": "9e9"},
        ]}
        v1 = {"result": [
            {"symbol": "BTCUSD", "markPrice": 500000000, "openInterest": 400000},
            {"symbol": "cETHUSD", "markPrice": 30000000, "openInterest": 7000},
            {"symbol": "cSOLUSD", "markPrice": 0, "openInterest": 5},  # без цены — нет
        ]}
        with mock.patch.object(api, "get_json", side_effect=lambda url, t=10: v3 if "/v3/" in url else v1):
            out = api._snap_phemex()
        self.assertEqual(set(out), {"BTC", "ETH"})
        self.assertAlmostEqual(out["BTC"][0], 100000 + 50010 + 400000)
        self.assertEqual(out["BTC"][1], 50000)
        self.assertAlmostEqual(out["ETH"][0], 37000)

    def test_top_slots_go_only_to_mapped_markets(self):
        # Места в «60 самых торгуемых» занимали 1000PEPE, обёртки и
        # мёртвые рынки — настоящие монеты в снимок не попадали.
        rows = [{"s": f"junk{i}", "v": 1e9 - i, "c": 1} for i in range(5)]
        rows += [{"s": f"C{i}USDT", "v": 1e6 - i, "c": 2} for i in range(5)] + ["мусор"]
        rows.append({"s": "C9USDT", "v": 2e6, "c": 0})  # без цены — места не занимает
        rows.append({"s": "C0USDC", "v": 5e5, "c": 2.01})

        def pick(r):
            sym = api._snap_sym(api._quote_cut(r["s"], ("USDT", "USDC")))
            return (sym, r["s"], r["c"]) if sym else None

        def oi(s, px):
            if s == "C3USDT":
                raise OSError("сеть")
            return 10.0 * px

        out = api._snap_top(rows, "v", 5, pick, oi)
        self.assertEqual(set(out), {"C0", "C1", "C2", "C4"})
        self.assertEqual(out["C0"], (20.0, 2))  # C0USDC — шестой, за пределом
        both = api._snap_top(rows, "v", 6, pick, oi)["C0"]
        self.assertAlmostEqual(both[0], 20.0 + 20.1)
        self.assertEqual(both[1], 2)
        self.assertEqual(api._snap_top(None, "v", 6, pick, oi), {})

    def test_xt_skips_dead_markets(self):
        now_ms = time.time() * 1000
        ticks = {"result": [
            {"s": "alpaca_usdt", "v": "9e9", "c": "1", "t": now_ms - 500 * 86_400_000},
            {"s": "btc_usdt_230331", "v": "8e9", "c": "1", "t": now_ms},
            {"s": "btc_usdt", "v": "1e9", "c": "50000", "t": now_ms - 1000},
        ]}
        asked = []

        def fake(url, timeout=10.0):
            if "agg-tickers" in url:
                return ticks
            asked.append(url.split("symbol=")[1])
            return {"result": {"openInterestUsd": "123"}}

        with mock.patch.object(api, "get_json", side_effect=fake):
            self.assertEqual(api._snap_xt(), {"BTC": (123.0, 50000.0)})
        self.assertEqual(asked, ["btc_usdt"])

    def test_aster_and_bingx_sum_quotes(self):
        aster = [{"symbol": "BTCUSDT", "quoteVolume": "9", "lastPrice": "50000"},
                 {"symbol": "BTCUSD1", "quoteVolume": "5", "lastPrice": "50020"},
                 {"symbol": "NVDAUSD1", "quoteVolume": "4", "lastPrice": "200"},
                 {"symbol": "BTCU", "quoteVolume": "8", "lastPrice": "50000"}]

        def fa(url, timeout=10.0):
            return aster if "ticker" in url else {"openInterest": "2"}

        with mock.patch.object(api, "get_json", side_effect=fa):
            self.assertEqual(api._snap_aster(), {"BTC": (200040.0, 50000.0), "NVDA": (400.0, 200.0)})
        bingx = {"data": [{"symbol": "BTC-USDT", "quoteVolume": "9", "lastPrice": "50000"},
                          {"symbol": "BTC-USDC", "quoteVolume": "1", "lastPrice": "50010"},
                          {"symbol": "NCCO1OILWTI2USD-USDT", "quoteVolume": "99", "lastPrice": "60"}]}

        def fb(url, timeout=10.0):
            return bingx if "ticker" in url else {"data": {"openInterest": "700" if "USDT" in url else "30"}}

        with mock.patch.object(api, "get_json", side_effect=fb):
            self.assertEqual(api._snap_bingx(), {"BTC": (730.0, 50000.0)})

    def test_bitget_usdt_and_usdc(self):
        data = {"usdt-futures": [{"symbol": "BTCUSDT", "holdingAmount": "2", "markPrice": "50000"}],
                "usdc-futures": [{"symbol": "BTCPERP", "holdingAmount": "1", "markPrice": "50010"},
                                 {"symbol": "ETHPERP", "holdingAmount": "3", "markPrice": "3000"},
                                 {"symbol": "BTCUSDC", "holdingAmount": "9", "markPrice": "50000"}]}

        def fake(url, timeout=10.0):
            return {"data": data[url.split("productType=")[1]]}

        with mock.patch.object(api, "get_json", side_effect=fake):
            self.assertEqual(api._snap_bitget(), {"BTC": (150010.0, 50000.0), "ETH": (9000.0, 3000.0)})

    def test_mexc_all_quotes_and_inverse(self):
        # Сверка с CoinGecko: у MEXC брался только _USDT; инверсный BTC_USD —
        # контракт в долларах ($100), USDC и USD1 — в монетах.
        ticks = {"data": [
            {"symbol": "BTC_USDC", "holdVol": "1000", "fairPrice": "50010"},
            {"symbol": "BTC_USD", "holdVol": "30", "fairPrice": "49990"},
            {"symbol": "BTC_USDT", "holdVol": "20000", "fairPrice": "50000"},
            {"symbol": "BTC_USD1", "holdVol": "100", "fairPrice": "50020"},
            {"symbol": "ETH_USDT", "holdVol": "5", "fairPrice": "3000"},  # размера нет — нет
        ]}
        sizes = {"BTC_USDT": 0.0001, "BTC_USDC": 0.0001, "BTC_USD1": 0.0001, "BTC_USD": 100}
        with mock.patch.object(api, "get_json", return_value=ticks), \
             mock.patch.dict(api._mexc_size, {"at": time.monotonic(), "map": sizes}):
            out = api._snap_mexc()
        self.assertEqual(set(out), {"BTC"})
        self.assertAlmostEqual(out["BTC"][0], 100000 + 5001 + 3000 + 500.2)
        self.assertEqual(out["BTC"][1], 50000.0)  # цена — с USDT

    def test_kucoin_usdc_and_inverse_not_dated(self):
        rows = [
            {"symbol": "XBTUSDCM", "status": "Open", "isInverse": False, "openInterest": "100", "multiplier": 0.0001, "markPrice": 50010, "baseCurrency": "XBT"},
            {"symbol": "XBTUSDTM", "status": "Open", "isInverse": False, "openInterest": "1000", "multiplier": 0.001, "markPrice": 50000, "baseCurrency": "XBT"},
            {"symbol": "XBTUSDM", "status": "Open", "isInverse": True, "openInterest": "7000", "multiplier": -1.0, "markPrice": 49990, "baseCurrency": "XBT"},
            {"symbol": "XBTMZ26", "status": "Open", "isInverse": True, "openInterest": "9e9", "multiplier": -1.0, "markPrice": 51000, "baseCurrency": "XBT"},
            {"symbol": "ETHUSDTM", "status": "Paused", "isInverse": False, "openInterest": "1", "multiplier": 0.01, "markPrice": 3000, "baseCurrency": "ETH"},
        ]
        with mock.patch.object(api, "get_json", return_value={"data": rows}):
            out = api._snap_kucoin()
        self.assertEqual(set(out), {"BTC"})
        self.assertAlmostEqual(out["BTC"][0], 50000 + 500.1 + 7000)
        self.assertEqual(out["BTC"][1], 50000)

    def test_versions_cover_changed_snapshots(self):
        self.assertTrue({"Phemex", "MEXC", "KuCoin", "Bitget", "Aster", "BingX"} <= set(api.LIQ_SNAP_VER))
        self.assertTrue(set(api.LIQ_SNAP_VER) <= set(dict(api.LIQ_SNAPS)))

    def test_listed_with_caps(self):
        names = dict(api.LIQ_SNAPS)
        self.assertIs(names["BitMEX"], api._snap_bitmex)
        self.assertIs(names["ApeX"], api._snap_apex)
        self.assertEqual((lm.CAPS["BitMEX"], lm.CAPS["ApeX"]), (100, 100))


class RescaleTest(unittest.TestCase):
    """В снимок биржи добавились рынки — её прошлый ряд пересчитывается,
    иначе скачок интереса в момент выката стал бы «открытием позиций»."""

    T = 1_800_000_000 // 900 * 900

    def setUp(self):
        d = tempfile.mkdtemp()
        self.snap = {"Phemex": {"BTC": (700e6, 50000.0), "ETH": (90e6, 3000.0)}, "OKX": {"BTC": (5e8, 50000.0)}}
        for name, value in (("LIQ_OI_DB", os.path.join(d, "liq_oi.db")), ("now", lambda: self.T),
                            ("LIQ_SNAPS", (("Phemex", lambda: self.snap["Phemex"]), ("OKX", lambda: self.snap["OKX"])))):
            patcher = mock.patch.object(api, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        con = api._liq_oi_con()
        rows = [("Phemex", "BTC", self.T - k * 900, 100e6, 50000.0) for k in range(1, 6)]
        rows += [("Phemex", "ETH", self.T - 86400 - k * 900, 30e6, 3000.0) for k in range(5)]  # служба стояла сутки
        rows += [("OKX", "BTC", self.T - k * 900, 4e8, 50000.0) for k in range(1, 6)]
        con.executemany("INSERT INTO oi_snap VALUES (?,?,?,?,?)", rows)
        con.commit()
        con.close()

    def series(self, ex, coin):
        con = sqlite3.connect(api.LIQ_OI_DB)
        try:
            return [oi for (oi,) in con.execute("SELECT oi FROM oi_snap WHERE ex=? AND coin=? ORDER BY t", (ex, coin))]
        finally:
            con.close()

    def test_old_history_is_rescaled_once(self):
        api.liq_oi_sample()
        self.assertEqual(self.series("Phemex", "BTC"), [700e6] * 6)  # без скачка в момент выката
        self.assertEqual(self.series("Phemex", "ETH"), [90e6])  # старый ряд не стыкуется — начат заново
        self.assertEqual(self.series("OKX", "BTC"), [4e8] * 5 + [5e8])  # версия не менялась — не трогаем
        self.T += 900
        self.snap["Phemex"]["BTC"] = (1400e6, 50000.0)
        api.liq_oi_sample()  # второй раз — уже не пересчитывается
        self.assertEqual(self.series("Phemex", "BTC"), [700e6] * 6 + [1400e6])

    def test_silent_exchange_waits_for_next_sample(self):
        self.snap["Phemex"] = {}
        api.liq_oi_sample()
        self.assertEqual(self.series("Phemex", "BTC"), [100e6] * 5)
        self.T += 900
        self.snap["Phemex"] = {"BTC": (700e6, 50000.0)}
        api.liq_oi_sample()
        self.assertEqual(self.series("Phemex", "BTC"), [700e6] * 6)

class SampledTest(unittest.TestCase):
    """Снимки бирж без своей истории — к свечам опоры."""

    T = 1_800_000_000 // 3600 * 3600

    def setUp(self):
        d = tempfile.mkdtemp()
        for name, value in (("LIQ_OI_DB", os.path.join(d, "liq_oi.db")), ("now", lambda: self.T + 3 * 3600 + 120)):
            patcher = mock.patch.object(api, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        con = api._liq_oi_con()
        # Снимок каждые 15 минут, интерес = номер снимка × $1 млн.
        con.executemany("INSERT INTO oi_snap VALUES (?,?,?,?,?)",
                        [("Bitget", "BTC", self.T - 10 * 3600 + k * 900, (k + 1) * 1e6, 100.0) for k in range(13 * 4 + 1)])
        con.commit()
        con.close()
        self.ref = [(self.T - 9 * 3600 + h * 3600, 101.0, 99.0, 100.0, 5e9, 0.7) for h in range(13)]

    def test_interest_is_at_the_start_of_the_candle(self):
        # Свеча t — снимок на её начало (t), как у бирж со своей историей; раньше
        # брался снимок на конец свечи, и рост ложился на свечу раньше.
        got = api._liq_sampled("BTC", "1h", 13, self.ref, 100.0)["Bitget"]
        self.assertEqual([r[0] for r in got], [r[0] for r in self.ref])
        start = self.T - 10 * 3600
        for r in got:
            self.assertEqual(r[4], ((r[0] - start) // 900 + 1) * 1e6, r[0])
        # Доля покупок — опорной биржи, а не «поровну».
        self.assertTrue(all(r[5] == 0.7 for r in got))

    def test_no_snapshot_yet_or_too_old_is_skipped(self):
        early = [(self.T - 20 * 3600 + h * 3600, 101.0, 99.0, 100.0, 5e9, 0.5) for h in range(13)]
        got = api._liq_sampled("BTC", "1h", 13, early, 100.0)
        rows = got.get("Bitget", [])
        self.assertTrue(all(r[0] >= self.T - 10 * 3600 for r in rows))  # до первого снимка — нет строк
        con = api._liq_oi_con()
        con.execute("DELETE FROM oi_snap WHERE t > ?", (self.T - 3600,))
        con.commit()
        con.close()
        got = api._liq_sampled("BTC", "1h", 13, self.ref, 100.0)["Bitget"]
        self.assertEqual(max(r[0] for r in got), self.T - 3600)  # снимок старше свечи — не берётся


class GmxTest(unittest.TestCase):
    def test_pool_interest_is_halved_like_one_side(self):
        m = {"markets": [{"name": "BTC/USD [BTC-USDC]", "isListed": True, "openInterestLong": 6e37, "openInterestShort": 4e37},
                         {"name": "BTC/USD [WBTC]", "isListed": True, "openInterestLong": 1e37, "openInterestShort": 1e37},
                         {"name": "ETH/USD", "isListed": False, "openInterestLong": 9e37, "openInterestShort": 0}]}
        with mock.patch.object(api, "get_json", return_value=m):
            self.assertEqual(api._snap_gmx(), {"BTC": (6e7, 0.0)})  # ($60M + $40M + $10M + $10M) / 2
        self.assertEqual(api.LIQ_SNAP_VER["GMX"], 2)  # старая история — пересчитать по стыку


class RealTest(unittest.TestCase):
    """Настоящие ликвидации бирж — к свечам карты (liq_map, real)."""

    def setUp(self):
        d = tempfile.mkdtemp()
        patcher = mock.patch.object(api, "LIQ_OI_DB", os.path.join(d, "liq_oi.db"))
        patcher.start()
        self.addCleanup(patcher.stop)
        for cache in (api._liq_real, api._liq_comp):
            cache.clear()
            self.addCleanup(cache.clear)
        self.res = {"ok": True, "sym": "BTC", "range": "1d", "ohlc": [[1, 1, 1, 1]] * 3, "ohlc_t": [1000, 2000, 3000, 4000]}
        patcher = mock.patch.object(api.wt_liqmap, "liq_map", side_effect=lambda *a, **k: self.res)
        patcher.start()
        self.addCleanup(patcher.stop)

    def put(self, rows):
        con = api._liqs_con()
        con.executemany("INSERT INTO liq_ev VALUES (?,?,?,?,?,?)", rows)
        con.commit()
        con.close()

    def test_events_go_to_their_candles(self):
        self.put([("OKX", "BTC", 1500_000, 1, 99.0, 100.0), ("Gate", "BTC", 1999_000, 1, 99.0, 50.0),
                  ("OKX", "BTC", 2000_000, 0, 101.0, 70.0), ("OKX", "BTC", 3999_000, 0, 101.0, 30.0),
                  ("OKX", "BTC", 4000_000, 1, 99.0, 999.0),  # после последней свечи — нет
                  ("OKX", "BTC", 500_000, 1, 99.0, 999.0),  # до первой — нет
                  ("OKX", "ETH", 1500_000, 1, 99.0, 999.0)])  # чужая монета — нет
        r = api.liq_map("BTC", "1d")
        self.assertEqual(r["real"], [[150, 0], [0, 70], [0, 30]])  # side 1 — ликвидирован лонг
        self.assertEqual(r["real_from"], 500)
        self.assertIsNot(r, self.res)
        self.assertEqual({k: v for k, v in r.items() if k not in ("real", "real_from")}, self.res)

    def test_same_map_same_object_until_it_changes(self):
        self.put([("OKX", "BTC", 1500_000, 1, 99.0, 100.0)])
        a = api.liq_map("BTC", "1d")
        self.assertIs(api.liq_map("BTC", "1d"), a)  # маршрут не кодирует заново
        self.res = {**self.res}
        self.assertIsNot(api.liq_map("BTC", "1d"), a)  # карта сменилась — новый ответ

    def test_no_feed_or_no_edges_map_as_is(self):
        self.assertIs(api.liq_map("BTC", "1d"), self.res)  # базы нет
        self.res = {"ok": True, "sym": "BTC", "range": "1d"}
        self.put([("OKX", "BTC", 1500_000, 1, 99.0, 100.0)])
        self.assertIs(api.liq_map("BTC", "1d"), self.res)  # старая сборка без границ
        self.res = {"ok": False, "error": "building"}
        self.assertIs(api.liq_map("BTC", "1d"), self.res)

    def test_feed_has_index_by_coin_and_time(self):
        con = api._liqs_con()
        idx = {r[1] for r in con.execute("PRAGMA index_list(liq_ev)")}
        con.close()
        self.assertIn("liq_ev_st", idx)


class DayKeepTest(unittest.TestCase):
    """Дневные ряды бирж копятся у нас: история Binance (30 дней у биржи)
    растёт на день в день."""

    def setUp(self):
        d = tempfile.mkdtemp()
        for name, value in (("LIQ_OI_DB", os.path.join(d, "liq_oi.db")), ("LIQ_DAY_WRITE", True),
                            ("_liq_sampled", lambda *a: {}), ("_liq_hl_candles", lambda *a: None)):
            patcher = mock.patch.object(api, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.days = range(100, 131)
        self.base = int(time.time()) // DAY - 200  # день 100 — сто дней назад

    def gather(self, n=1000, period="1d"):
        rows = [((self.base + d) * DAY, 101.0, 99.0, 100.0, 1e6 + d, 0.5) for d in self.days]
        with mock.patch.object(api, "LIQ_SOURCES", (("Binance", lambda s, p, k: rows),)):
            return api._liq_gather("BTC", period, n)[0]

    def test_kept_days_are_glued_before_what_the_exchange_gives(self):
        first = self.gather()["Binance"]
        self.assertEqual([r[0] // DAY - self.base for r in first], list(range(100, 131)))
        self.days = range(120, 151)  # биржа отдаёт уже только последние 30 дней
        second = self.gather()["Binance"]
        self.assertEqual([r[0] // DAY - self.base for r in second], list(range(100, 151)))
        self.assertEqual(second[0], ((self.base + 100) * DAY, 101.0, 99.0, 100.0, 1e6 + 100, 0.5))

    def test_changed_definition_leaves_no_step(self):
        # Интерес Binance стал больше (добавились USDC-рынки): сохранённые дни
        # пересчитываются по общему дню, на стыке нет ступеньки.
        self.gather()
        self.days = range(120, 151)
        rows = [((self.base + d) * DAY, 101.0, 99.0, 100.0, 2 * (1e6 + d), 0.5) for d in self.days]
        with mock.patch.object(api, "LIQ_SOURCES", (("Binance", lambda s, p, k: rows),)):
            got = api._liq_gather("BTC", "1d", 1000)[0]["Binance"]
        self.assertEqual([r[0] // DAY - self.base for r in got], list(range(100, 151)))
        for d, r in zip(range(100, 151), got, strict=True):
            self.assertAlmostEqual(r[4], 2 * (1e6 + d), delta=1e-3)
        # В базе — уже пересчитанные дни: назавтра стык не возвращается.
        self.days = range(121, 152)
        rows = [((self.base + d) * DAY, 101.0, 99.0, 100.0, 2 * (1e6 + d), 0.5) for d in self.days]
        with mock.patch.object(api, "LIQ_SOURCES", (("Binance", lambda s, p, k: rows),)):
            got = api._liq_gather("BTC", "1d", 1000)[0]["Binance"]
        for d, r in zip(range(100, 152), got, strict=True):
            self.assertAlmostEqual(r[4], 2 * (1e6 + d), delta=1e-3)

    def test_seam_uses_the_median_of_common_days(self):
        # Самый старый день биржи — выброс: по нему одному копилка уехала бы
        # вдесятеро; и выброс вниз — по самому малому уехала бы вдесятеро вниз.
        self.gather()
        self.days = range(120, 151)
        odd = {120: 10.0, 121: 0.1}
        rows = [((self.base + d) * DAY, 101.0, 99.0, 100.0, (1e6 + d) * odd.get(d, 1.0), 0.5) for d in self.days]
        with mock.patch.object(api, "LIQ_SOURCES", (("Binance", lambda s, p, k: rows),)):
            got = api._liq_gather("BTC", "1d", 1000)[0]["Binance"]
        self.assertAlmostEqual(got[0][4], 1e6 + 100, delta=1e-3)  # сохранённые дни — как были

    def test_reader_rescales_only_in_memory(self):
        self.gather()
        before = Path(api.LIQ_OI_DB).read_bytes()
        rows = [((self.base + d) * DAY, 101.0, 99.0, 100.0, 3 * (1e6 + d), 0.5) for d in range(120, 151)]
        with mock.patch.object(api, "LIQ_DAY_WRITE", False), \
             mock.patch.object(api, "LIQ_SOURCES", (("Binance", lambda s, p, k: rows),)):
            got = api._liq_gather("BTC", "1d", 1000)[0]["Binance"]
        self.assertAlmostEqual(got[0][4], 3 * (1e6 + 100), delta=1e-3)
        self.assertEqual(Path(api.LIQ_OI_DB).read_bytes(), before)

    def test_running_day_is_not_kept(self):
        self.gather()
        con = api._liq_oi_con()
        try:
            kept = [t // DAY - self.base for (t,) in con.execute("SELECT t FROM liq_day ORDER BY t")]
        finally:
            con.close()
        self.assertEqual(kept, list(range(100, 130)))  # день 130 — идущий

    def test_only_the_history_load_not_the_windows(self):
        self.gather(n=365)  # окно «год» — без базы и без удлинения
        con = api._liq_oi_con()
        try:
            self.assertFalse(con.execute("SELECT 1 FROM sqlite_master WHERE name='liq_day'").fetchone())
        finally:
            con.close()
        self.gather()
        self.days = range(120, 151)
        self.assertEqual(len(self.gather(n=365)["Binance"]), 31)
        self.assertEqual(len(self.gather(period="4h")["Binance"]), 31)

    def test_old_days_are_cleaned(self):
        with mock.patch.object(api, "LIQ_DAY_KEEP", 0):
            self.gather()
        con = api._liq_oi_con()
        try:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM liq_day").fetchone()[0], 0)
        finally:
            con.close()

    def test_other_processes_only_read(self):
        # Проверка или бэктест на сервере — отдельный процесс: копилку
        # читает (дни подклеиваются), но в боевую базу не пишет ничего.
        self.gather()  # служба
        self.days = range(120, 151)
        db = api.LIQ_OI_DB
        before = Path(db).read_bytes()
        with mock.patch.object(api, "LIQ_DAY_WRITE", False):
            got = self.gather()["Binance"]
        self.assertEqual([r[0] // DAY - self.base for r in got], list(range(100, 151)))
        self.assertEqual(Path(db).read_bytes(), before)
        # Базы нет вовсе — ряды как были, файл не создаётся.
        with mock.patch.object(api, "LIQ_DAY_WRITE", False), mock.patch.object(api, "LIQ_OI_DB", db + ".none"):
            self.assertEqual(len(self.gather()["Binance"]), 31)
        self.assertFalse(os.path.exists(db + ".none"))

    def test_only_the_service_writes(self):
        self.assertIsInstance(api.LIQ_DAY_WRITE, bool)
        src = Path(ROOT, "whale_api.py").read_text(encoding="utf-8")
        self.assertIn("LIQ_DAY_WRITE = False", src)
        wire = src.split("def wire() -> None:")[1].split("\ndef ")[0]
        self.assertIn("LIQ_DAY_WRITE = True", wire)

    def test_broken_database_keeps_the_rows(self):
        with mock.patch.object(api, "_liq_oi_con", side_effect=sqlite3.OperationalError("locked")):
            got = self.gather()
        self.assertEqual(len(got["Binance"]), 31)


class ReadOnlyTest(unittest.TestCase):
    """Сторож, как у проверки на сервере: отдельный процесс собирает ряды
    бирж, снимки, копилку и список монет — и открывает боевую базу только
    на чтение (mode=ro), ничего в ней не меняя."""

    def setUp(self):
        d = tempfile.mkdtemp()
        self.db = os.path.join(d, "liq_oi.db")
        for name, value in (("LIQ_OI_DB", self.db), ("LIQ_DAY_WRITE", False)):
            patcher = mock.patch.object(api, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        con = api._liq_oi_con()  # база, как у службы: снимки Lighter по BTC
        con.executemany("INSERT INTO oi_snap VALUES (?,?,?,?,?)",
                        [("Lighter", "BTC", T0 + i * 900, 1e6 + i, 100.0) for i in range(-2, 60)])
        con.commit()
        con.close()

    def test_gather_and_snapshots_only_read(self):
        before = Path(self.db).read_bytes()
        real = sqlite3.connect
        opened = []

        def guard(target, *a, **kw):
            opened.append(str(target))
            return real(target, *a, **kw)
        rows = window(60)
        with mock.patch.object(api, "LIQ_SOURCES", (("OKX", lambda s, p, n: rows),)), \
             mock.patch.object(api, "_liq_hl_candles", return_value=None), \
             mock.patch("sqlite3.connect", side_effect=guard), mock.patch.object(api, "now", return_value=T0 + 60 * 900):
            got, _ = api._liq_gather("BTC", "15m", 60)  # окно: ряды + снимки
            api._liq_gather("BTC", *lm.PRE)  # предыстория: копилка
        self.assertIn("Lighter", got)  # снимки прочитаны
        self.assertTrue(opened)
        self.assertTrue(all("mode=ro" in u for u in opened), opened)
        self.assertEqual(Path(self.db).read_bytes(), before)

    def test_coin_list_only_reads(self):
        before = Path(self.db).read_bytes()
        real = sqlite3.connect
        opened = []

        def guard(target, *a, **kw):
            opened.append(str(target))
            return real(target, *a, **kw)

        def fake(url, timeout=10.0):
            if "fapi.binance.com/fapi/v1/ticker/24hr" in url:
                return [{"symbol": "BTCUSDT", "quoteVolume": "5e9"}]
            return None
        with mock.patch.object(api, "get_json", side_effect=fake), mock.patch.object(api, "hl_post", return_value=None), \
             mock.patch("sqlite3.connect", side_effect=guard), mock.patch.object(api, "now", return_value=T0 + 60 * 900):
            res = api._liq_coins_build()
        btc = next(c for c in res["coins"] if c["s"] == "BTC")
        self.assertIn("Lighter", btc["ex"])  # метка из снимков прочитана
        self.assertTrue(opened)
        self.assertTrue(all("mode=ro" in u for u in opened), opened)
        self.assertEqual(Path(self.db).read_bytes(), before)

    def test_no_database_no_file(self):
        missing = self.db + ".none"
        with mock.patch.object(api, "LIQ_OI_DB", missing), \
             mock.patch.object(api, "LIQ_SOURCES", (("OKX", lambda s, p, n: window(60)),)):
            got, _ = api._liq_gather("BTC", "15m", 60)
        self.assertEqual(sorted(got), ["OKX"])
        self.assertFalse(os.path.exists(missing))


class GatherTest(unittest.TestCase):
    def test_snapshot_does_not_replace_a_history_source(self):
        mine = [(i * 900, 1.0, 1.0, 1.0, 5.0, 0.5) for i in range(10)]
        snap = [(i * 900, 1.0, 1.0, 1.0, 9.0, 0.5) for i in range(10)]
        with mock.patch.object(api, "LIQ_SOURCES", (("Kraken", lambda s, p, n: mine),)), \
             mock.patch.object(api, "_liq_sampled", return_value={"Kraken": snap, "Bitget": snap}):
            got, ref = api._liq_gather("BTC", "15m", 10)
        self.assertEqual(got["Kraken"], mine)
        self.assertEqual(got["Bitget"], snap)
        self.assertEqual(ref, mine)

    def gather_thin(self, thin):
        # Опора (больше интереса) — живой рынок; второй ряд — как dYdX на DOT.
        ref = [(i * 900, 1.01 + 0.001 * i, 0.99, 1.0 + 0.001 * i, 100.0, 0.6) for i in range(20)]
        with mock.patch.object(api, "LIQ_SOURCES", (("OKX", lambda s, p, n: ref), ("dYdX", lambda s, p, n: thin))), \
             mock.patch.object(api, "_liq_sampled", return_value={}):
            return api._liq_gather("DOT", "15m", 20)

    def test_thin_market_rides_on_the_reference_candles(self):
        # Сделок почти нет: свеча — одна цена, и та на 1,5 % в стороне.
        thin = [(i * 900, 1.015, 1.015, 1.015, 5.0 + i, 0.3) for i in range(20)]
        got, ref = self.gather_thin(thin)
        self.assertEqual([r[1:4] for r in got["dYdX"]], [r[1:4] for r in ref])
        self.assertEqual([r[4] for r in got["dYdX"]], [r[4] for r in thin])  # интерес — свой
        self.assertTrue(all(r[5] == 0.6 for r in got["dYdX"]))  # доля покупок — рыночная (своей у dYdX нет)
        self.assertEqual(got["OKX"], ref)

    def test_live_market_keeps_its_own_candles(self):
        live = [(i * 900, 1.012 + 0.001 * i, 0.991, 1.0005 + 0.001 * i, 5.0, 0.3) for i in range(20)]
        got, _ = self.gather_thin(live)
        self.assertEqual([r[:5] for r in got["dYdX"]], [r[:5] for r in live])

    def test_thin_by_empty_candles_or_by_distance(self):
        ref = [(i * 900, 1.01, 0.99, 1.0, 100.0, 0.5) for i in range(20)]
        empty = [(t, 1.0, 1.0, 1.0, 5.0, 0.5) if i % 4 == 0 else (t, 1.01, 0.99, 1.0, 5.0, 0.5) for i, (t, *_r) in enumerate(ref)]
        self.assertTrue(api._liq_thin(empty, ref))  # 25 % пустых
        away = [(t, 1.01, 0.99, 1.004, 5.0, 0.5) for t, *_r in ref]
        self.assertTrue(api._liq_thin(away, ref))  # медиана 0,4 %
        near = [(t, 1.01, 0.99, 1.002, 5.0, 0.5) for t, *_r in ref]
        self.assertFalse(api._liq_thin(near, ref))
        self.assertFalse(api._liq_thin(away[:7], ref))  # общих свечей мало — не судим
        # Свеча без пары у опоры остаётся своей.
        self.assertEqual(api._liq_on_ref([(5, 2.0, 1.0, 1.5, 7.0, 0.4)], ref), [(5, 2.0, 1.0, 1.5, 7.0, 0.4)])

    def test_same_coin_in_another_price_scale_is_kept(self):
        # OKX котирует ANTHROPIC в десять раз дешевле — и держит 81 % его интереса.
        okx = [(i * 900, 13.8, 13.6, 13.7, 7e6, 0.6) for i in range(10)]
        gate = [(i * 900, 1385.0, 1360.0, 1372.0, 1.7e6, 0.5) for i in range(10)]
        htx = [(i * 900, 1380.0, 1365.0, 1371.0, 6e4, 0.5) for i in range(10)]
        other = [(i * 900, 5.0, 4.9, 4.95, 9e6, 0.5) for i in range(10)]  # чужая монета под тем же тикером
        src = (("OKX", lambda s, p, n: okx), ("Gate", lambda s, p, n: gate), ("HTX", lambda s, p, n: htx), ("dYdX", lambda s, p, n: other))
        with mock.patch.object(api, "LIQ_SOURCES", src), mock.patch.object(api, "_liq_sampled", return_value={}):
            got, ref = api._liq_gather("ANTHROPIC", "15m", 10)
        self.assertEqual(set(got), {"OKX", "Gate", "HTX"})
        self.assertAlmostEqual(got["OKX"][-1][3], 1370.0)
        self.assertEqual(got["OKX"][-1][4], 7e6)  # интерес в долларах — как был
        self.assertEqual(ref[-1][4], 7e6)

    def test_price_scale(self):
        self.assertEqual(api._liq_scale(137.0, 1372.0), 10.0)
        self.assertEqual(api._liq_scale(1372.0, 137.0), 0.1)
        self.assertEqual(api._liq_scale(0.00137, 1372.0), 1e6)
        self.assertEqual(api._liq_scale(1372.0, 1372.0), 0.0)  # тот же масштаб — нечего менять
        self.assertEqual(api._liq_scale(130.0, 1372.0), 0.0)  # ×10,55 — не ровно 10ᵏ
        self.assertEqual(api._liq_scale(1.372e-5, 1372.0), 0.0)  # дальше 10⁶ — не берём
        self.assertEqual(api._liq_scale(0.0, 1372.0), 0.0)

    def test_exchanges_without_taker_share_get_the_market_one(self):
        # Bybit, HTX, dYdX своей доли агрессивных покупок не отдают — им
        # рыночная (по интересу) у Binance/OKX/Gate/Kraken; снимки — через опору.
        ts = range(0, 9000, 900)
        okx = [(t, 101.0, 99.0, 100.0, 300.0, 0.8) for t in ts]
        gate = [(t, 101.0, 99.0, 100.0, 100.0, 0.4) for t in ts]
        htx = [(t, 101.0, 99.0, 100.0, 900.0, 0.2) for t in ts]  # больше всех интереса — опора
        bybit = [(t, 101.0, 99.0, 100.0, 50.0, 0.65) for t in ts]
        src = (("OKX", lambda s, p, n: okx), ("Gate", lambda s, p, n: gate), ("HTX", lambda s, p, n: htx), ("Bybit", lambda s, p, n: bybit))
        seen = {}

        def sampled(sym, period, n, ref, px):
            seen["ref"] = ref
            return {}
        with mock.patch.object(api, "LIQ_SOURCES", src), mock.patch.object(api, "_liq_sampled", side_effect=sampled):
            got, ref = api._liq_gather("BTC", "15m", 10)
        self.assertEqual({r[5] for r in got["OKX"]}, {0.8})  # свои — как были
        self.assertEqual({r[5] for r in got["Gate"]}, {0.4})
        for name in ("HTX", "Bybit"):
            self.assertTrue(all(abs(r[5] - 0.7) < 1e-12 for r in got[name]), name)  # (300·0,8 + 100·0,4) / 400
        self.assertIs(ref, got["HTX"])
        self.assertIs(seen["ref"], ref)
        # Нет ни одной биржи с настоящей долей — свои остаются.
        with mock.patch.object(api, "LIQ_SOURCES", (("HTX", lambda s, p, n: htx),)), mock.patch.object(api, "_liq_sampled", return_value={}):
            got, _ = api._liq_gather("BTC", "15m", 10)
        self.assertEqual({r[5] for r in got["HTX"]}, {0.2})
        self.assertEqual(api.LIQ_TAKER, {"Binance", "OKX", "Gate", "Kraken"})

    def test_long_history_gets_a_longer_budget(self):
        seen = []

        def fake_wait(fs, timeout=None):
            seen.append(timeout)
            return set(fs), set()
        with mock.patch.object(api, "LIQ_SOURCES", (("X", lambda s, p, n: None),)), \
             mock.patch.object(api, "wait", side_effect=fake_wait), \
             mock.patch.object(api, "_liq_hl_candles", return_value=None):
            api._liq_gather("BTC", "1d", 365)
            api._liq_gather("BTC", *lm.PRE)
        self.assertEqual(seen, [api.LIQ_BUDGET, api.LIQ_PRE_BUDGET])
        self.assertGreater(api.LIQ_PRE_BUDGET, api.LIQ_BUDGET)


if __name__ == "__main__":
    unittest.main()

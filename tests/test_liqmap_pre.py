"""Карта ликвидаций: предыстория (wt_liqmap.PRE) и источник Kraken Futures.

Без предыстории модель видела только позиции, открытые за окно: у суток —
десятую часть интереса. Теперь каждое окно начинается с дневных свечей бирж
до своего начала. Проверяем: склейку рядов, что предыстория одна на монету
для всех окон, обновляется в фоне, сбой бирж не ломает карту, кэш ограничен;
и разбор ответов Kraken.
"""
import os
import sys
import threading
import time
import unittest
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
    def test_history_makes_older_positions_visible(self):
        self.use(pre={})
        bare = lm.build("BTC", "1d")
        lm._st = lm._State()
        self.use()
        full = lm.build("BTC", "1d")
        self.assertTrue(bare["ok"] and full["ok"])
        self.assertGreater(full["seen"], bare["seen"] * 5)
        self.assertLessEqual(full["seen"], full["oi"] * 1.01)
        # Позиции предыстории открыты у 80: лонги 10× ликвидируются около 72,
        # шорты — около 88; у окна (цена 100) их не было бы.
        lows = [b for b in full["buckets"] if 70 <= b["p"] <= 74 and sum(b["L"])]
        self.assertTrue(lows)
        self.assertFalse([b for b in bare["buckets"] if 70 <= b["p"] <= 74 and sum(b["L"])])
        # Интерес, биржи и путь цены — по окну, не по предыстории.
        self.assertEqual(full["oi"], bare["oi"])
        self.assertEqual(full["ex"], ["OKX"])
        self.assertEqual(full["path"], bare["path"])

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
        born, rows = lm._st.pre["BTC"]
        self.assertEqual(rows, {})
        # Снова спросим через PRE_RETRY, а не через PRE_TTL и не на каждой сборке.
        age = time.monotonic() - born
        self.assertAlmostEqual(age, lm.PRE_TTL - lm.PRE_RETRY, delta=5)
        lm.build("BTC", "7d")
        self.assertEqual(len(self.pre_calls()), 1)

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
        ad = {"timestamp": [900, 2700], "data": ["4", "100"]}
        with self.reply(kl, oi, ad) as get:
            rows = api._liq_kraken("BTC", "15m", 3)
        self.assertIn("PF_XBTUSD", get.call_args_list[0].args[0])
        self.assertEqual(rows, [
            (900, 110.0, 90.0, 105.0, 200.0, 0.7),  # интерес — монеты на начало × открытие; покупки 0,5 + 4/20
            (1800, 106.0, 104.0, 105.0, 315.0, 0.5),  # без объёма — поровну
            (2700, 106.0, 104.0, 105.0, 420.0, 1.0),  # доля не больше единицы
        ])  # свеча без интереса — не строка

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

    def binance(self, cm_ts):
        def fake(url, timeout=10.0):
            if "fapi.binance.com/futures/data/openInterestHist" in url:
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

    def bybit(self, inv_ts):
        def fake(url, timeout=10.0):
            if "cursor=" in url:
                return {"result": {"list": []}}
            if "open-interest?category=linear" in url:
                return {"result": {"list": [{"timestamp": str(t * 1000), "openInterest": "10"} for t in self.TS]}}
            if "open-interest?category=inverse" in url:
                self.assertIn("symbol=BTCUSD&", url)
                return {"result": {"list": [{"timestamp": str(t * 1000), "openInterest": "300"} for t in inv_ts]}}  # в долларах
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

    def test_glue(self):
        self.assertEqual(api._glue_inverse({1: 1.0, 2: 1.0}, {1: 5.0, 2: 5.0}), {1: 6.0, 2: 6.0})
        self.assertEqual(api._glue_inverse({}, {1: 5.0}), {})
        many = {t: 1.0 for t in range(40)}
        self.assertEqual(len(api._glue_inverse(many, {t: 1.0 for t in range(39)})), 39)  # 97,5 % — клеим общие
        self.assertIs(api._glue_inverse(many, {t: 1.0 for t in range(37)}), many)  # 92,5 % — нет


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

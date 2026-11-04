"""Карта ликвидаций (wt_liqmap): модель, ответ, кэш и правила кода."""
import ast
import inspect
import itertools
import os
import re
import sys
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_liqmap as lm  # noqa: E402 — модуль лежит в корне репозитория

PX = 100.0
LO = PX * (1 - lm.SPAN)
STEP = PX * lm.SPAN * 2 / lm.BUCKETS


def row(t, hi, low, c, oi, bs=0.5):  # noqa: PLR0913 — ряд биржи целиком
    return (t, float(hi), float(low), float(c), float(oi), bs)


def mids():
    return [LO + STEP * (b + 0.5) for b in range(lm.BUCKETS)]


def total(side):
    return sum(sum(g) for g in side)


class Base(unittest.TestCase):
    def setUp(self):
        lm._st = lm._State()
        self.addCleanup(setattr, lm, "_st", lm._State())


class ModelTest(unittest.TestCase):
    def test_leverage_shares_sum_to_one_and_groups_are_four(self):
        self.assertAlmostEqual(sum(w for _, w, _ in lm.LEVS), 1.0)
        self.assertEqual(lm.GROUPS, (10, 25, 50, 100))
        self.assertEqual({g for _, _, g in lm.LEVS}, {0, 1, 2, 3})
        # Плечо группы — не выше её границы и выше границы предыдущей.
        for lev, _, g in lm.LEVS:
            self.assertLessEqual(lev, lm.GROUPS[g])
            if g:
                self.assertGreater(lev, lm.GROUPS[g - 1])
        self.assertAlmostEqual(sum(lm.SMOOTH), 1.0)

    def test_new_interest_lands_below_for_longs_and_above_for_shorts_split_by_buyers(self):
        rows = [row(0, 100, 100, 100, 1000), row(1, 100.2, 99.8, 100, 2000, bs=0.7)]
        longs, shorts = lm.model(rows, LO, STEP)
        self.assertAlmostEqual(total(longs) + total(shorts), 1000 * sum(
            w for lev, w, _ in lm.LEVS if 1 / lev - lm.MMR <= lm.SPAN), delta=1)
        self.assertAlmostEqual(total(longs) / (total(longs) + total(shorts)), 0.7, places=6)
        m = mids()
        for g in range(4):
            self.assertTrue(all(m[b] < PX for b, v in enumerate(longs[g]) if v))
            self.assertTrue(all(m[b] > PX for b, v in enumerate(shorts[g]) if v))
        # 3× ликвидируется за −33 %: дальше окна ±15 % — его на карте нет.
        self.assertEqual(longs[0][0], 0.0)

    def test_entry_is_spread_over_the_candle_range_not_one_comb_tooth(self):
        # Свеча в 2 %: каждый уровень плеча — не одна корзина, а полоса.
        rows = [row(0, 100, 100, 100, 1000), row(1, 101, 99, 100, 2000)]
        longs, _ = lm.model(rows, LO, STEP)
        filled = sum(1 for g in longs for v in g if v > 0)
        self.assertGreaterEqual(filled, 6 * lm.ENTRY // 2)
        # 25×: ликвидация на ~−3,5 % от входа; вход — от 99 до 101.
        hit = [b for b, v in enumerate(longs[1]) if v]
        lo_p, hi_p = mids()[min(hit)], mids()[max(hit)]
        self.assertLess(lo_p, 99 * (1 - 1 / 25 + lm.MMR) + STEP)
        self.assertGreater(hi_p, 101 * (1 - 1 / 20 + lm.MMR) - STEP)

    def test_a_candle_through_the_level_liquidates_it(self):
        rows = [row(0, 100, 100, 100, 1000), row(1, 100, 100, 100, 2000), row(2, 100, 97, 98, 2000)]
        longs, shorts = lm.model(rows, LO, STEP)
        m = mids()
        # Минимум свечи 97: всё у лонгов не ниже 97 сгорело, ниже — живо.
        for g in range(4):
            self.assertTrue(all(m[b] < 97 for b, v in enumerate(longs[g]) if v), g)
        self.assertGreater(total(longs), 0)
        before = lm.model(rows[:2], LO, STEP)[1]
        self.assertAlmostEqual(total(shorts), total(before))

    def test_falling_interest_closes_positions_by_the_same_share(self):
        rows = [row(0, 100, 100, 100, 1000), row(1, 100, 100, 100, 2000)]
        a = lm.model(rows, LO, STEP)
        b = lm.model([*rows, row(2, 100, 100, 100, 1500)], LO, STEP)
        self.assertAlmostEqual(total(b[0]), total(a[0]) * 0.75, places=6)
        self.assertAlmostEqual(total(b[1]), total(a[1]) * 0.75, places=6)

    def test_smoothing_keeps_the_mass(self):
        a = [0.0] * 10
        a[4], a[0], a[9] = 8.0, 4.0, 2.0
        self.assertAlmostEqual(sum(lm._smooth(a)), sum(a))
        self.assertEqual(lm._smooth(a)[4], 4.0)

    def test_each_leverage_lands_in_its_exact_bucket(self):
        # Ровная свеча на 100: ликвидация лонга — 100·(1 − 1/плечо + MMR),
        # шорта — 100·(1 + 1/плечо − MMR); корзина — ровно эта цена.
        self.assertEqual((lm.MMR, lm.ENTRY), (0.005, 5))
        rows = [row(0, 100, 100, 100, 1000), row(1, 100, 100, 100, 2000)]
        longs, shorts = lm.model(rows, LO, STEP)
        want_l = [[0.0] * lm.BUCKETS for _ in range(4)]
        want_s = [[0.0] * lm.BUCKETS for _ in range(4)]
        for lev, w, g in lm.LEVS:
            bl = int((100 * (1 - 1 / lev + 0.005) - LO) // STEP)
            bs = int((100 * (1 + 1 / lev - 0.005) - LO) // STEP)
            if 0 <= bl < lm.BUCKETS:
                want_l[g][bl] += 1000 * w * 0.5
            if 0 <= bs < lm.BUCKETS:
                want_s[g][bs] += 1000 * w * 0.5
        for g in range(4):
            for b in range(lm.BUCKETS):
                self.assertAlmostEqual(longs[g][b], want_l[g][b], places=6, msg=(g, b))
                self.assertAlmostEqual(shorts[g][b], want_s[g][b], places=6, msg=(g, b))
        # 10×: лонг — 90,5, шорт — 109,5.
        self.assertGreater(longs[0][int((90.5 - LO) // STEP)], 0)
        self.assertGreater(shorts[0][int((109.5 - LO) // STEP)], 0)

    def test_entry_points_are_the_middles_of_five_equal_parts(self):
        # Свеча 99–101: входы 99,2 / 99,6 / 100 / 100,4 / 100,8; у 50× лонг
        # ликвидируется на вход·0,985 — пять разных корзин по 1/5 прироста.
        rows = [row(0, 100, 100, 100, 1000), row(1, 101, 99, 100, 2000)]
        longs, _ = lm.model(rows, LO, STEP)
        w50 = next(w for lev, w, _ in lm.LEVS if lev == 50)
        want = [0.0] * lm.BUCKETS
        for p in (99.2, 99.6, 100.0, 100.4, 100.8):
            want[int((p * 0.985 - LO) // STEP)] += 1000 * w50 * 0.5 / 5
        for b in range(lm.BUCKETS):
            self.assertAlmostEqual(longs[2][b], want[b], places=6, msg=b)

    def test_buyer_share_is_clamped_to_zero_one(self):
        rows = [row(0, 100, 100, 100, 1000), row(1, 100, 100, 100, 2000, bs=1.5)]
        longs, shorts = lm.model(rows, LO, STEP)
        self.assertEqual(total(shorts), 0.0)
        self.assertTrue(all(v >= 0 for g in longs + shorts for v in g))
        rows[1] = row(1, 100, 100, 100, 2000, bs=-0.5)
        longs, shorts = lm.model(rows, LO, STEP)
        self.assertEqual(total(longs), 0.0)

    def test_the_lowest_bucket_of_the_window_counts(self):
        # Лонг 10× со входа 85,1/0,905 ликвидируется на 85,1 — корзина 0.
        p = 85.1 / 0.905
        longs, _ = lm.model([row(0, p, p, p, 1000), row(1, p, p, p, 2000)], LO, STEP)
        self.assertGreater(longs[0][0], 0)

    def test_a_candle_up_through_the_level_liquidates_shorts(self):
        rows = [row(0, 100, 100, 100, 1000), row(1, 100, 100, 100, 2000), row(2, 103, 100, 102, 2000)]
        longs, shorts = lm.model(rows, LO, STEP)
        m = mids()
        for g in range(4):
            self.assertTrue(all(m[b] > 103 for b, v in enumerate(shorts[g]) if v), g)
        self.assertGreater(total(shorts), 0)
        self.assertAlmostEqual(total(longs), total(lm.model(rows[:2], LO, STEP)[0]))

    def test_candles_open_at_the_previous_close(self):
        rows = [row(i, 110 + i, 90 - i, 100 + i, 1) for i in range(6)]
        out = lm.candles(rows, n=6)
        self.assertEqual(out[0][0], 100.0)
        for a, b in itertools.pairwise(out):
            self.assertEqual(b[0], a[3])


def market(n=60, oi0=1e9, grow=1e7):
    """Опора: цена ходит ±1 % вокруг 100, интерес растёт."""
    out = []
    for i in range(n):
        c = 100 + (i % 7 - 3) * 0.3
        out.append(row(i * 900, c + 0.4, c - 0.4, c, oi0 + grow * i, 0.55))
    out[-1] = row((n - 1) * 900, 100.3, 99.7, 100.0, oi0 + grow * (n - 1), 0.55)
    return out


class BuildMapTest(unittest.TestCase):
    def test_reply_shape_sides_and_cumulative(self):
        ref = market()
        got = {"OKX": ref, "Gate": market(grow=5e6)}
        r = lm.build_map("BTC", "1d", got, ref, 1_800_000_000)
        self.assertTrue(r["ok"])
        self.assertEqual((r["px"], r["levs"], r["ex"], r["range"]), (100.0, [10, 25, 50, 100], ["Gate", "OKX"], "1d"))
        self.assertAlmostEqual(r["lo"], LO)
        self.assertAlmostEqual(r["step"], STEP)
        for b in r["buckets"]:
            self.assertEqual((len(b["L"]), len(b["S"])), (4, 4))
            self.assertTrue(LO <= b["p"] <= PX * (1 + lm.SPAN))
            if sum(b["L"]):
                self.assertLess(b["p"], r["px"])
            if sum(b["S"]):
                self.assertGreater(b["p"], r["px"])
        # Накоплено растёт с удалением от цены.
        for side in ("L", "S"):
            self.assertLessEqual(r["cum"][2][side], r["cum"][5][side])
            self.assertLessEqual(r["cum"][5][side], r["cum"][10][side])
        self.assertEqual(r["oi"], round(ref[-1][4] + got["Gate"][-1][4]))
        self.assertEqual(r["path"][-1], 100.0)
        self.assertLessEqual(len(r["path"]), 62)
        self.assertLessEqual(len(r["ohlc"]), 48)
        self.assertEqual(r["at"], 1_800_000_000)
        # Корзины без денег не отдаются; накопленное — ровно до своего процента.
        self.assertTrue(all(sum(b["L"]) + sum(b["S"]) >= 1 for b in r["buckets"]))
        self.assertLess(len(r["buckets"]), lm.BUCKETS)
        for k in (2, 5, 10):
            self.assertEqual(r["cum"][k]["L"], sum(sum(b["L"]) for b in r["buckets"] if 100 * (1 - k / 100) <= b["p"] < 100))
            self.assertEqual(r["cum"][k]["S"], sum(sum(b["S"]) for b in r["buckets"] if 100 < b["p"] <= 100 * (1 + k / 100)))
        self.assertLess(r["cum"][2]["L"], r["cum"][10]["L"])

    def test_levels_on_the_wrong_side_of_the_price_are_cleared(self):
        # Позиции набраны на 102, сейчас цена 100: лонги 50× (≈100,5) и
        # выше уже сгорели бы, шорты ниже цены — тоже.
        flat = [row(i * 900, 102, 102, 102, 1e9 + 1e7 * i) for i in range(20)]
        ref = [*flat[:-1], row(19 * 900, 100, 100, 100, 1e9 + 1.9e8)]
        r = lm.build_map("BTC", "1d", {"OKX": flat}, ref, 1)
        self.assertTrue(r["buckets"])
        for b in r["buckets"]:
            if b["p"] >= 100:
                self.assertEqual(sum(b["L"]), 0, b)
            if b["p"] <= 100:
                self.assertEqual(sum(b["S"]), 0, b)

    def test_price_path_ends_at_the_price(self):
        ref = market(n=168)
        r = lm.build_map("BTC", "7d", {"OKX": ref}, ref, 1)
        self.assertNotEqual(ref[::2][-1][3], 100.0)
        self.assertEqual(r["path"][-1], 100.0)

    def test_map_is_a_density_not_a_comb(self):
        # Раньше — четыре плеча и одна точка входа: уровни ложились зубцами.
        r = lm.build_map("BTC", "1d", {"OKX": market()}, market(), 1)
        near = [b for b in r["buckets"] if abs(b["p"] / 100 - 1) < 0.08 and sum(b["L"]) + sum(b["S"]) > 0]
        self.assertGreater(len(near), 40)


class CacheTest(Base):
    def gather(self, calls, rows=None, delay=0.0):
        def fn(sym, period, n):
            calls.append((sym, period, n))
            if delay:
                time.sleep(delay)
            r = rows if rows is not None else market()
            return ({"OKX": r}, r) if r else ({}, None)
        return fn

    def test_bad_args(self):
        for sym, rng in (("", "1d"), ("BTC", "2d"), ("!!!", "1d"), (None, "1d")):
            self.assertEqual(lm.liq_map(sym, rng), {"ok": False, "error": "bad_args"})
        self.assertEqual(lm._clean("btc-usd"), "BTCUSD")

    def test_cold_start_waits_for_one_build_then_serves_from_memory(self):
        calls: list = []
        lm.set_gather(self.gather(calls))
        r = lm.liq_map("btc", "7d")
        self.assertTrue(r["ok"])
        self.assertEqual(calls, [("BTC", "1h", 168)])
        self.assertIs(lm.liq_map("BTC", "7d"), r)
        self.assertEqual(len(calls), 1)

    def test_cold_request_waits_no_longer_than_wait(self):
        calls: list = []
        lm.set_gather(self.gather(calls, delay=0.5))
        t0 = time.monotonic()
        self.assertEqual(lm.liq_map("BTC", "1d", wait=0.05), {"ok": False, "error": "building"})
        self.assertLess(time.monotonic() - t0, 0.4)
        for _ in range(100):
            if not lm._st.jobs:
                break
            time.sleep(0.02)
        self.assertTrue(lm.liq_map("BTC", "1d")["ok"])

    def test_stale_map_is_served_at_once_and_rebuilt_in_background(self):
        calls: list = []
        lm.set_gather(self.gather(calls))
        old = {"ok": True, "v": 1}
        lm._st.hits[("BTC", "1d")] = (time.monotonic() - lm.TTL - 1, old)
        self.assertIs(lm.liq_map("BTC", "1d"), old)
        for _ in range(100):
            if not lm._st.jobs:
                break
            time.sleep(0.02)
        self.assertEqual(len(calls), 1)
        self.assertIsNot(lm.liq_map("BTC", "1d"), old)
        # Старше STALE — не отдаётся.
        lm._st.hits[("ETH", "1d")] = (time.monotonic() - lm.STALE - 1, old)
        self.assertIsNot(lm.liq_map("ETH", "1d"), old)

    def test_empty_exchanges_rest_and_are_not_asked_by_every_request(self):
        calls: list = []
        lm.set_gather(self.gather(calls, rows=[]))
        for _ in range(5):
            self.assertEqual(lm.liq_map("NOPE", "1d"), {"ok": False, "error": "no_data"})
        self.assertEqual(len(calls), 1)
        self.assertEqual(lm.FAIL_WAIT, 120.0)

    def test_no_more_than_jobs_max_builds_at_once(self):
        gate = threading.Event()
        started = []

        def slow(sym, period, n):
            started.append(sym)
            gate.wait(5)
            return {}, None
        lm.set_gather(slow)
        out = [lm.liq_map(f"C{i}", "1d", wait=0) for i in range(lm.JOBS_MAX + 3)]
        self.assertEqual(len(lm._st.jobs), lm.JOBS_MAX)
        self.assertEqual(out[-1], {"ok": False, "error": "busy"})
        gate.set()
        for _ in range(100):
            if not lm._st.jobs:
                break
            time.sleep(0.02)
        self.assertEqual(len(started), lm.JOBS_MAX)

    def test_too_old_map_is_not_served_when_the_rebuild_fails(self):
        old = {"ok": True, "v": 1}
        lm.set_gather(self.gather([], rows=[]))
        lm._st.hits[("BTC", "1d")] = (time.monotonic() - lm.STALE - 1, old)
        self.assertEqual(lm.liq_map("BTC", "1d"), {"ok": False, "error": "no_data"})

    def test_one_build_per_map_however_many_ask(self):
        gate = threading.Event()
        started = []

        def slow(sym, period, n):
            started.append(sym)
            gate.wait(5)
            return {}, None
        lm.set_gather(slow)
        for _ in range(3):
            lm.liq_map("BTC", "1d", wait=0)
        time.sleep(0.05)
        self.assertEqual(started, ["BTC"])
        gate.set()
        for _ in range(100):
            if not lm._st.jobs:
                break
            time.sleep(0.02)

    def test_successful_build_lifts_the_rest(self):
        lm.set_gather(self.gather([]))
        lm._st.fails[("BTC", "1d")] = time.monotonic()
        self.assertTrue(lm.build("BTC", "1d")["ok"])
        self.assertNotIn(("BTC", "1d"), lm._st.fails)

    def test_crashing_gather_does_not_stick(self):
        lm.set_gather(lambda s, p, n: 1 / 0)
        self.assertEqual(lm.liq_map("BTC", "1d"), {"ok": False, "error": "no_data"})
        self.assertEqual(lm._st.jobs, {})

    def test_cache_is_bounded(self):
        lm.set_gather(self.gather([]))
        for i in range(lm.CACHE_MAX + 5):
            lm.build(f"C{i}", "1d")
        self.assertEqual(len(lm._st.hits), lm.CACHE_MAX)
        self.assertNotIn(("C0", "1d"), lm._st.hits)

    def test_warm_builds_only_when_due(self):
        calls: list = []
        lm.set_gather(self.gather(calls))
        lm.warm("BTC", "1d")
        lm.warm("BTC", "1d")
        self.assertEqual(len(calls), 1)
        lm._st.hits[("BTC", "1d")] = (time.monotonic() - lm.TTL, lm._st.hits[("BTC", "1d")][1])
        lm.warm("BTC", "1d")
        self.assertEqual(len(calls), 2)
        # Сборка этой карты уже идёт — прогрев не начинает вторую.
        lm._st.hits.clear()
        lm._st.jobs[("BTC", "1d")] = threading.current_thread()
        lm.warm("BTC", "1d")
        self.assertEqual(len(calls), 2)


class PolicyTest(unittest.TestCase):
    def tree(self):
        with open(os.path.join(ROOT, "wt_liqmap.py"), encoding="utf-8") as f:
            return ast.parse(f.read())

    def test_pure_module_no_network_no_files(self):
        found = set()
        for n in ast.walk(self.tree()):
            if isinstance(n, ast.Import):
                found |= {a.name for a in n.names}
            elif isinstance(n, ast.ImportFrom):
                found.add(n.module or "")
        self.assertLessEqual(found, {"__future__", "bisect", "re", "threading", "time", "collections.abc", "typing"})
        bad = [n.func.id for n in ast.walk(self.tree()) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
               and n.func.id in {"eval", "exec", "compile", "__import__", "open", "setattr"}]
        self.assertEqual(bad, [])
        with open(os.path.join(ROOT, "wt_liqmap.py"), encoding="utf-8") as f:
            code = re.sub(r'"""[\s\S]*?"""|#[^\n]*', "", f.read())
        for word in ("urllib", "socket", "http", "sqlite3", "subprocess", "whale_api", "requests"):
            self.assertNotIn(word, code, word)

    def test_endpoint_takes_only_coin_and_window(self):
        self.assertEqual(list(inspect.signature(lm.liq_map).parameters), ["sym", "rng", "wait"])
        self.assertEqual(lm.SYM.pattern, "[A-Z0-9]{1,12}")

    def test_wired_into_the_server(self):
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            api = f.read()
        self.assertIn("wt_liqmap.set_gather(_liq_gather)", api)
        self.assertIn("liq_map = wt_liqmap.liq_map", api)
        self.assertIn("wt_liqmap.warm(sym, rng)", api)
        self.assertIn("LIQ_RANGES = wt_liqmap.RANGES", api)
        for old in ("def _liq_model(", "def _liq_build(", "def _liq_build_bg(", "_liq_cache"):
            self.assertNotIn(old, api, old)

    def test_screen_labels_match_the_groups(self):
        with open(os.path.join(ROOT, "src/screens/LiqMapScreen.tsx"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('const LEV_NAME = ["3–10×", "20–25×", "50×", "75–100×"];', src)
        lo = {g: min(lev for lev, _, gg in lm.LEVS if gg == g) for g in range(4)}
        names = [f"{lo[g]}–{lm.GROUPS[g]}×" if lo[g] != lm.GROUPS[g] else f"{lm.GROUPS[g]}×" for g in range(4)]
        self.assertEqual(names, ["3–10×", "20–25×", "50×", "75–100×"])


if __name__ == "__main__":
    unittest.main()

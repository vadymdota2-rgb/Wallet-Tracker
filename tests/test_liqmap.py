"""Карта ликвидаций (wt_liqmap): модель, ответ, живая цена, кэш и правила кода."""
import ast
import inspect
import itertools
import os
import random
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


def series(closes, coins, bs=0.5, ranges=None):
    """Ряды биржи по закрытиям свечей и интересу в монетах на момент снимка
    каждой свечи: снимок j — на начало свечи j, по цене закрытия свечи j−1."""
    out = []
    for j, (c, q) in enumerate(zip(closes, coins, strict=True)):
        hi, low = ranges[j] if ranges else (c, c)
        out.append(row(j * 900, hi, low, c, q * (closes[j - 1] if j else c), bs))
    return out


def mids():
    return [LO + STEP * (b + 0.5) for b in range(lm.BUCKETS)]


def total(side):
    return sum(sum(g) for g in side)


def where(side):
    m = mids()
    return [m[b] for g in side for b, v in enumerate(g) if v > 1e-12]


class Base(unittest.TestCase):
    def setUp(self):
        lm._st = lm._State()
        self.addCleanup(setattr, lm, "_st", lm._State())


class ModelTest(unittest.TestCase):
    def test_leverage_shares_sum_to_one_and_groups_are_four(self):
        self.assertAlmostEqual(sum(w for _, w, _ in lm.LEVS), 1.0)
        self.assertEqual(lm.GROUPS, (10, 25, 50, 100, 500))
        self.assertEqual({g for _, _, g in lm.LEVS}, set(range(len(lm.GROUPS))))
        self.assertEqual(max(lev for lev, _, _ in lm.LEVS), 500)
        for lev, _, g in lm.LEVS:
            self.assertLessEqual(lev, lm.GROUPS[g])
            if g:
                self.assertGreater(lev, lm.GROUPS[g - 1])
        self.assertAlmostEqual(sum(lm.SMOOTH), 1.0)
        self.assertEqual((lm.MMR, lm.ENTRY), (0.005, 5))

    def test_grid_reaches_zero_and_double(self):
        self.assertEqual((lm.SPAN, lm.BUCKETS), (1.0, 800))
        self.assertAlmostEqual(STEP, 0.25)  # шаг — 0,25 % цены, как и был
        self.assertEqual(LO, 0.0)

    def test_burn_touches_only_the_filled_band_and_is_fast(self):
        rnd = random.Random(3)  # noqa: S311 — выдуманный рынок, не тайна
        px, q, closes, coins, ranges = 100.0, 100.0, [], [], []
        for _ in range(400):
            px *= 1 + rnd.gauss(0, 0.01)
            q = max(1.0, q * (1 + rnd.gauss(0.002, 0.02)))
            closes.append(px)
            coins.append(q)
            ranges.append((px * 1.01, px * 0.99))
        rows = series(closes, coins, ranges=ranges)
        t0 = time.monotonic()
        longs, shorts, _ = lm.model(rows, LO, STEP)
        self.assertLess(time.monotonic() - t0, 2.0)
        self.assertTrue(where(longs) and where(shorts))
        self.assertTrue(all(p < rows[-1][2] for p in where(longs)))
        self.assertTrue(all(p > rows[-1][1] for p in where(shorts)))
        self.assertTrue(all(v >= 0 for side in (longs, shorts) for g in side for v in g))

    def test_leverage_is_capped_by_the_exchange(self):
        self.assertEqual(lm.max_lev("dYdX", "BTC"), 20)
        self.assertEqual(lm.max_lev("MEXC", "BTC"), 500)
        self.assertEqual(lm.max_lev("MEXC", "PEPE"), lm.ALT_CAP)
        self.assertEqual(lm.max_lev("Нет такой", "BTC"), lm.CAP_OTHER)
        levs = lm.levs_upto(20)
        self.assertEqual([lev for lev, _, _ in levs], [3, 5, 10, 20])
        self.assertAlmostEqual(sum(w for _, w, _ in levs), 1.0)
        # Доли оставшихся — в той же пропорции.
        self.assertAlmostEqual(levs[0][1] / levs[1][1], 0.10 / 0.20)
        self.assertEqual(lm.levs_upto(500), lm.LEVS)
        self.assertEqual([lev for lev, _, _ in lm.levs_upto(1)], [3])
        # На dYdX нет 50× и выше: на карте их полос нет.
        rows = series([100, 100, 100], [0, 10, 20])
        r = lm.build_map("BTC", "1d", {"dYdX": rows}, rows, 1)
        self.assertTrue(r["buckets"])
        self.assertTrue(all(b["L"][2] == b["L"][3] == b["L"][4] == 0 for b in r["buckets"]))
        r = lm.build_map("BTC", "1d", {"MEXC": rows}, rows, 1)
        self.assertTrue(any(b["L"][4] > 0 for b in r["buckets"]))

    def test_maintenance_margin_is_below_the_initial_one(self):
        # Иначе 200× ликвидировалось бы на самой цене входа.
        for lev, _, _ in lm.LEVS:
            self.assertLess(lm.mmr(lev), 1 / lev, lev)
            self.assertGreater(1 / lev - lm.mmr(lev), 0)
        self.assertEqual((lm.mmr(10), lm.mmr(100), lm.mmr(200), lm.mmr(500)), (0.005, 0.005, 0.0025, 0.001))
        # 500×: лонг со входа 100 — на 99,9.
        rows = series([100, 100, 100], [0, 10, 20])
        longs, _, _ = lm.model(rows, LO, STEP)
        self.assertGreater(longs[4][int((99.9 - LO) // STEP)], 0)

    def test_price_moves_alone_open_nothing(self):
        # Интерес в долларах растёт с ценой, а монет — столько же: позиций нет.
        rows = series([100, 101, 102, 101, 103, 102], [10] * 6)
        longs, shorts, seen = lm.model(rows, LO, STEP)
        self.assertEqual((total(longs), total(shorts), seen), (0.0, 0.0, 0.0))

    def test_growth_between_snapshots_opens_in_the_candle_between_them(self):
        # Снимок 1 — 10 монет, снимок 2 — 20: прирост случился в свече 1
        # (99–101), а не в свече 2 (ровно 100).
        rows = series([100, 100, 100], [10, 10, 20], ranges=[(100, 100), (101, 99), (100, 100)])
        longs, shorts, seen = lm.model(rows, LO, STEP)
        # Шорт 100× со входа 99,2 ликвидируется на 99,7 — цена сейчас 100:
        # он уже сгорел.
        self.assertGreater(seen, 9.5)
        self.assertLess(seen, 10.0)
        w50 = next(w for lev, w, _ in lm.LEVS if lev == 50)
        want = [0.0] * lm.BUCKETS
        for p in (99.2, 99.6, 100.0, 100.4, 100.8):
            want[int((p * (1 - (1 / 50 - lm.mmr(50))) - LO) // STEP)] += 10 * w50 * 0.5 / 5
        for b in range(lm.BUCKETS):
            self.assertAlmostEqual(longs[2][b], want[b], places=9, msg=b)
        self.assertAlmostEqual(total(longs) / (total(longs) + total(shorts)), 0.5, delta=0.01)

    def test_each_leverage_lands_in_its_exact_bucket(self):
        rows = series([100, 100, 100], [0, 10, 20])
        longs, shorts, _ = lm.model(rows, LO, STEP)
        g_n = len(lm.GROUPS)
        want_l = [[0.0] * lm.BUCKETS for _ in range(g_n)]
        want_s = [[0.0] * lm.BUCKETS for _ in range(g_n)]
        for lev, w, g in lm.LEVS:
            keep = 1 / lev - min(0.005, 0.5 / lev)
            bl = int((100 * (1 - keep) - LO) // STEP)
            bs = int((100 * (1 + keep) - LO) // STEP)
            if 0 <= bl < lm.BUCKETS:
                want_l[g][bl] += 10 * w * 0.5
            if 0 <= bs < lm.BUCKETS:
                want_s[g][bs] += 10 * w * 0.5
        for g in range(g_n):
            for b in range(lm.BUCKETS):
                self.assertAlmostEqual(longs[g][b], want_l[g][b], places=9, msg=(g, b))
                self.assertAlmostEqual(shorts[g][b], want_s[g][b], places=9, msg=(g, b))
        # 10×: лонг — 90,5, шорт — 109,5; 3× (−33 %) — за краем окна.
        self.assertGreater(longs[0][int((90.5 - LO) // STEP)], 0)
        self.assertGreater(shorts[0][int((109.5 - LO) // STEP)], 0)

    def test_buyer_share_is_clamped_to_zero_one(self):
        longs, shorts, _ = lm.model(series([100, 100, 100], [0, 10, 20], bs=1.5), LO, STEP)
        self.assertEqual(total(shorts), 0.0)
        self.assertTrue(all(v >= 0 for g in longs + shorts for v in g))
        longs, _, _ = lm.model(series([100, 100, 100], [0, 10, 20], bs=-0.5), LO, STEP)
        self.assertEqual(total(longs), 0.0)

    def test_the_lowest_bucket_of_the_window_counts(self):
        p = 0.3  # лонг 3× ликвидируется на ~0,2 — корзина 0 (сетка от нуля, шаг 0,25)
        longs, _, _ = lm.model(series([p, p, p], [0, 10, 20]), LO, STEP)
        self.assertGreater(longs[0][0], 0)

    def test_out_of_window_positions_count_in_the_total(self):
        # Вход на 160: шорт 3× ликвидируется на ~212 — выше края окна (200).
        rows = series([160, 160, 160], [0, 10, 20])
        longs, shorts, seen = lm.model(rows, LO, STEP)
        self.assertAlmostEqual(seen, 10.0)
        self.assertLess(total(longs) + total(shorts), 10.0)
        # Закрыли половину — половина и тех, что за краем, и видимых.
        _, _, half = lm.model([*rows, row(3 * 900, 160, 160, 160, 2400)], LO, STEP)
        self.assertAlmostEqual(half, 5.0, places=9)

    def test_longs_far_above_the_window_still_count(self):
        # Вход на 300, а сетка — до 200: лонги ликвидируются на 201–299 — за
        # краем, на карте их нет, но в «видно» и в закрытиях они есть.
        longs, _, seen = lm.model(series([300, 300, 300], [0, 10, 20], bs=1.0), LO, STEP)
        self.assertEqual(total(longs), 0.0)
        self.assertAlmostEqual(seen, 10.0)

    def test_a_candle_down_through_the_level_burns_longs(self):
        # Лонги открыты на 100; свеча 3 сходила до 97 — все оставшиеся лонги
        # ниже 97. Интерес стоит — новых позиций нет (сгоревшее не замещается).
        rows = series([100, 100, 100, 98, 98], [0, 10, 20, 20, 20], bs=1.0,
                      ranges=[(100, 100), (100, 100), (100, 100), (100, 97), (98, 98)])
        rows[3] = (*rows[3][:5], 0.0)
        longs, shorts, _ = lm.model(rows, LO, STEP)
        self.assertTrue(where(longs))
        self.assertTrue(all(p < 97 for p in where(longs)))
        self.assertEqual(total(shorts), 0.0)

    def test_a_candle_up_through_the_level_burns_shorts(self):
        rows = series([100, 100, 100, 102, 102], [0, 10, 20, 20, 20], bs=0.0,
                      ranges=[(100, 100), (100, 100), (100, 100), (103, 100), (102, 102)])
        rows[3] = (*rows[3][:5], 1.0)
        longs, shorts, _ = lm.model(rows, LO, STEP)
        self.assertTrue(where(shorts))
        self.assertTrue(all(p > 103 for p in where(shorts)))
        self.assertEqual(total(longs), 0.0)

    def test_the_running_candle_burns_too(self):
        rows = series([100, 100, 100], [0, 10, 20], ranges=[(100, 100), (100, 100), (100, 96)])
        longs, _, _ = lm.model(rows, LO, STEP)
        self.assertTrue(where(longs))
        self.assertTrue(all(p < 96 for p in where(longs)))

    def test_burnt_levels_are_not_replaced_when_interest_stands(self):
        rows = series([100, 100, 100, 100], [0, 10, 20, 20], bs=1.0,
                      ranges=[(100, 100), (100, 100), (100, 100), (100, 95)])
        before = lm.model(rows[:3], LO, STEP)[2]
        burnt = lm.model([*rows[:3], row(3 * 900, 100, 95, 100, 2000, 1.0)], LO, STEP)
        _, _, seen = lm.model([*rows, row(4 * 900, 100, 100, 100, 2000, 1.0)], LO, STEP)
        # Свеча до 95 сожгла часть лонгов, интерес не изменился — новых
        # позиций нет: открылись бы — интерес вырос бы. Видно меньше, чем было.
        self.assertLess(seen, before - 0.5)
        self.assertAlmostEqual(seen, burnt[2], places=9)

    def test_liquidations_explain_the_fall_only_up_to_the_fall(self):
        # Свеча 3 сходила до 95 и сожгла лонги от 20× и выше; к снимку 4
        # интерес упал ровно на столько же — это и были ликвидации: свежие
        # позиции сверх того не закрываются. (Шаг i — свеча i−1 и интерес на i.)
        base = series([100, 100, 100], [0, 10, 20], bs=1.0)
        burn = row(3 * 900, 100, 95, 100, 2000, 1.0)
        after_burn = lm.model([*base, burn], LO, STEP)[2]
        gone = lm.model(base, LO, STEP)[2] - after_burn
        self.assertGreater(gone, 0.5)
        fell = lm.model([*base, burn, row(4 * 900, 100, 100, 100, 2000 - gone * 100, 1.0)], LO, STEP)[2]
        self.assertAlmostEqual(fell, after_burn, places=6)
        # Упал вдвое больше сгоревшего — остаток закрывают свежие позиции.
        more = lm.model([*base, burn, row(4 * 900, 100, 100, 100, 2000 - gone * 200, 1.0)], LO, STEP)[2]
        self.assertAlmostEqual(more, after_burn - gone, places=6)

    def test_falling_interest_closes_the_newest_positions_first(self):
        # A — 10 монет на 100, B — 10 монет на 110; интерес падает на 10 —
        # закрывается B, A цела.
        closes = [100, 100, 100, 110, 110, 110]
        rows = series(closes, [0, 10, 20, 20, 30, 20], bs=1.0)
        longs, _, seen = lm.model(rows, LO, STEP)
        only_a = lm.model(series(closes[:3], [0, 10, 20], bs=1.0), LO, STEP)
        self.assertAlmostEqual(seen, 10.0, places=9)
        for g in range(len(lm.GROUPS)):
            for b in range(lm.BUCKETS):
                self.assertAlmostEqual(longs[g][b], only_a[0][g][b], places=9)
        # Падение меньше пачки — пачка уменьшается на долю.
        _, _, part = lm.model(series(closes, [0, 10, 20, 20, 30, 25], bs=1.0), LO, STEP)
        self.assertAlmostEqual(part, 15.0, places=9)

    def test_closing_more_than_the_window_holds_empties_it(self):
        longs, shorts, seen = lm.model(series([100] * 5, [0, 10, 20, 15, 5]), LO, STEP)
        self.assertEqual(seen, 0.0)
        self.assertAlmostEqual(total(longs) + total(shorts), 0.0, places=9)

    def test_churn_does_not_depend_on_the_candle_size(self):
        # Открыли и закрыли внутри часа: на 15-минутных свечах — как на часовой.
        fine = series([100] * 7, [0, 10, 14, 10, 14, 10, 12])
        self.assertAlmostEqual(lm.model(fine, LO, STEP)[2], 2.0, places=9)

    def test_shorter_window_sees_no_more_than_the_longer(self):
        rnd = random.Random(7)  # noqa: S311 — выдуманный рынок, не тайна
        for _ in range(20):
            px, q, closes, coins = 100.0, 100.0, [], []
            for _ in range(80):
                px *= 1 + rnd.gauss(0, 0.004)
                q = max(1.0, q * (1 + rnd.gauss(0.002, 0.02)))
                closes.append(px)
                coins.append(q)
            full = series(closes, coins)
            self.assertLessEqual(lm.model(full[-30:], LO, STEP)[2], lm.model(full, LO, STEP)[2] + 1e-6)

    def test_bad_prices_are_skipped(self):
        rows = series([100, 0, 100, 100], [0, 10, 20, 30])
        self.assertGreaterEqual(lm.model(rows, LO, STEP)[2], 0)

    def test_smoothing_keeps_the_mass(self):
        a = [0.0] * 10
        a[4], a[0], a[9] = 8.0, 4.0, 2.0
        self.assertAlmostEqual(sum(lm._smooth(a)), sum(a))
        self.assertEqual(lm._smooth(a)[4], 4.0)

    def test_candles_open_at_the_previous_close(self):
        rows = [row(i, 110 + i, 90 - i, 100 + i, 1) for i in range(6)]
        out = lm.candles(rows, n=6)
        self.assertEqual(out[0][0], 100.0)
        for a, b in itertools.pairwise(out):
            self.assertEqual(b[0], a[3])
        self.assertLessEqual(len(lm.candles([row(i, 1, 1, 1, 1) for i in range(100)], n=48)), 48)


class SpliceTest(unittest.TestCase):
    def test_tail_replaces_the_running_candle(self):
        main = [row(t, 1, 1, 1, 1) for t in (0, 3600, 7200)]
        tail = [row(t, 2, 2, 2, 2) for t in range(3600, 9000, 900)]
        out = lm.splice(main, tail)
        self.assertEqual([r[0] for r in out], [0, 3600, 7200, 8100])
        self.assertEqual(out[0], main[0])
        self.assertEqual(out[1], main[1])
        self.assertEqual(out[2], tail[4])

    def test_tail_that_does_not_reach_back_is_ignored(self):
        main = [row(t, 1, 1, 1, 1) for t in (0, 3600, 7200)]
        self.assertIs(lm.splice(main, [row(8100, 2, 2, 2, 2)]), main)
        self.assertIs(lm.splice(main, None), main)
        self.assertEqual(lm.splice([], [row(0, 1, 1, 1, 1)]), [])

    def test_every_long_window_has_a_finer_tail(self):
        sec = {"15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
        for rng, (period, _) in lm.RANGES.items():
            if rng == "1d":
                self.assertNotIn(rng, lm.TAIL)
                continue
            tp, tn = lm.TAIL[rng]
            self.assertLess(sec[tp], sec[period], rng)
            # Хвост накрывает идущую крупную свечу с запасом.
            self.assertGreater(tn * sec[tp], sec[period], rng)


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
        self.assertEqual((r["px"], r["levs"], r["ex"], r["range"]), (100.0, [10, 25, 50, 100, 500], ["Gate", "OKX"], "1d"))
        self.assertAlmostEqual(r["lo"], LO)
        self.assertAlmostEqual(r["step"], STEP)
        self.assertTrue(r["buckets"])
        for b in r["buckets"]:
            self.assertEqual((len(b["L"]), len(b["S"])), (5, 5))
            self.assertTrue(LO <= b["p"] <= PX * (1 + lm.SPAN))
            self.assertGreaterEqual(sum(b["L"]) + sum(b["S"]), 1)
            if sum(b["L"]):
                self.assertLess(b["p"], 99.7)  # ниже минимума идущей свечи
            if sum(b["S"]):
                self.assertGreater(b["p"], 100.3)
        self.assertLess(len(r["buckets"]), lm.BUCKETS)
        for k in (2, 5, 10):
            self.assertEqual(r["cum"][k]["L"], sum(sum(b["L"]) for b in r["buckets"] if 100 * (1 - k / 100) <= b["p"] < 100))
            self.assertEqual(r["cum"][k]["S"], sum(sum(b["S"]) for b in r["buckets"] if 100 < b["p"] <= 100 * (1 + k / 100)))
        self.assertLess(r["cum"][2]["L"] + r["cum"][2]["S"], r["cum"][10]["L"] + r["cum"][10]["S"])
        self.assertEqual(r["oi"], round(ref[-1][4] + got["Gate"][-1][4]))
        self.assertLessEqual(r["seen"], r["oi"])
        self.assertGreater(r["seen"], 0)
        self.assertEqual(r["path"][-1], 100.0)
        self.assertLessEqual(len(r["path"]), 62)
        self.assertLessEqual(len(r["ohlc"]), 48)
        self.assertEqual(r["at"], 1_800_000_000)

    def test_dollars_are_coins_times_the_liquidation_price(self):
        rows = series([100, 100, 100], [0, 10, 20], bs=1.0)
        r = lm.build_map("BTC", "1d", {"OKX": rows}, rows, 1)
        coins = total(lm.model(rows, LO, STEP)[0])
        usd = sum(sum(b["L"]) for b in r["buckets"])
        # Лонги 5–100× ликвидируются на 80,5–99,5: доллар за монету — между ними.
        self.assertGreater(usd / coins, 85)
        self.assertLess(usd / coins, 99.5)
        self.assertEqual(r["seen"], 10 * 100)

    def test_price_is_the_given_one_for_every_window(self):
        ref = market()
        for rng in ("1d", "7d", "30d", "90d"):
            r = lm.build_map("BTC", rng, {"OKX": ref}, ref, 1, px=100.4)
            self.assertEqual(r["px"], 100.4)
            self.assertEqual(r["path"][-1], 100.4)
            self.assertEqual(r["ohlc"][-1][3], 100.4)

    def test_map_is_a_density_not_a_comb(self):
        r = lm.build_map("BTC", "1d", {"OKX": market()}, market(), 1)
        near = [b for b in r["buckets"] if abs(b["p"] / 100 - 1) < 0.08 and sum(b["L"]) + sum(b["S"]) > 0]
        self.assertGreater(len(near), 25)

    def test_price_path_ends_at_the_price(self):
        ref = market(n=168)
        r = lm.build_map("BTC", "7d", {"OKX": ref}, ref, 1)
        self.assertNotEqual(ref[::2][-1][3], 100.0)
        self.assertEqual(r["path"][-1], 100.0)


class LiveTest(unittest.TestCase):
    def test_levels_the_price_reached_burn_at_once_and_stay_burnt(self):
        ref = market()
        st = lm.make_state("BTC", "1d", {"OKX": ref}, ref, 100.0, 1)
        r0 = lm.render(st, 100.0)
        self.assertTrue(any(b["p"] > 98 for b in r0["buckets"] if sum(b["L"])))
        st["low"] = min(st["low"], 98.0)
        r1 = lm.render(st, 98.0)
        self.assertTrue(all(b["p"] < 98 for b in r1["buckets"] if sum(b["L"])))
        self.assertEqual((r1["px"], r1["path"][-1], r1["ohlc"][-1][3]), (98.0, 98.0, 98.0))
        self.assertLessEqual(r1["ohlc"][-1][2], 98.0)
        # Цена вернулась — сгоревшие лонги не воскресают.
        r2 = lm.render(st, 100.0)
        self.assertTrue(all(b["p"] < 98 for b in r2["buckets"] if sum(b["L"])))
        self.assertEqual(st["oi"], r2["oi"])

    def test_render_burns_by_the_price_itself_too(self):
        ref = market()
        st = lm.make_state("BTC", "1d", {"OKX": ref}, ref, 100.0, 1)
        r = lm.render(st, 98.0)  # края ещё не расширены — а цена уже там
        self.assertTrue(all(b["p"] < 98 for b in r["buckets"] if sum(b["L"])))


class CacheTest(Base):
    def gather(self, calls, rows=None, delay=0.0):
        def fn(sym, period, n):
            if (period, n) == lm.PRE:
                return {}, None  # предыстория — свои тесты (PreTest), здесь — только окно
            calls.append((sym, period, n))
            if delay:
                time.sleep(delay)
            r = rows if rows is not None else market()
            return ({"OKX": r}, r) if r else ({}, None)
        return fn

    def test_old_cache_cleans_itself(self):
        lm.set_gather(self.gather([]))
        lm.build("OLD", "1d")
        _, st, res = lm._st.hits[("OLD", "1d")]
        lm._st.hits[("OLD", "1d")] = (time.monotonic() - lm.STALE - 1, st, res)
        lm._st.fails[("GONE", "1d")] = time.monotonic() - lm.FAIL_WAIT - 1
        lm._st.fails[("RECENT", "1d")] = time.monotonic()
        lm.build("BTC", "1d")
        self.assertNotIn(("OLD", "1d"), lm._st.hits)
        self.assertNotIn(("GONE", "1d"), lm._st.fails)
        self.assertIn(("RECENT", "1d"), lm._st.fails)
        self.assertIn(("BTC", "1d"), lm._st.hits)
        # И прогрев чистит, даже если ничего не собирает.
        lm._st.hits[("OLD", "7d")] = (time.monotonic() - lm.STALE - 1, st, res)
        lm.warm("BTC", "1d")
        self.assertNotIn(("OLD", "7d"), lm._st.hits)

    def test_bad_args(self):
        for sym, rng in (("", "1d"), ("BTC", "2d"), ("!!!", "1d"), (None, "1d")):
            self.assertEqual(lm.liq_map(sym, rng), {"ok": False, "error": "bad_args"})
        self.assertEqual(lm._clean("btc-usd"), "BTCUSD")

    def test_windows_and_their_life(self):
        self.assertEqual(list(lm.RANGES), ["1d", "7d", "30d", "90d", "180d", "365d"])
        self.assertEqual(set(lm.TTL), set(lm.RANGES))
        self.assertTrue(all(lm.TTL[k] < lm.STALE for k in lm.TTL))
        self.assertEqual(lm.RANGES["365d"], ("1d", 365))
        self.assertEqual(lm.TTL["1d"], 120.0)

    def test_cold_start_waits_for_one_build_then_serves_from_memory(self):
        calls: list = []
        lm.set_gather(self.gather(calls))
        r = lm.liq_map("btc", "1d")
        self.assertTrue(r["ok"])
        self.assertEqual(calls, [("BTC", "15m", 96)])
        self.assertIs(lm.liq_map("BTC", "1d"), r)
        self.assertEqual(len(calls), 1)

    def test_long_window_also_asks_the_finer_tail(self):
        calls: list = []
        lm.set_gather(self.gather(calls))
        self.assertTrue(lm.liq_map("BTC", "90d")["ok"])
        self.assertEqual(sorted(calls), sorted([("BTC", "1d", 90), ("BTC", "1h", 30)]))

    def test_tail_rows_go_into_the_model(self):
        # Окно: интерес стоит; хвост (идущая свеча мелко): вырос втрое.
        main = series([100] * 10, [0] + [10] * 9)
        tail = [row(8100, 100, 100, 100, 1000), row(9000, 100, 100, 100, 3000)]
        seen = {}

        def fn(sym, period, n):
            r = tail if period == "15m" else main
            return {"OKX": r}, r
        lm.set_gather(fn)
        seen["with"] = lm.build("BTC", "7d")["seen"]
        self.assertGreater(seen["with"], 0)  # прирост в хвосте — виден

    def test_failing_tail_does_not_break_the_map(self):
        def fn(sym, period, n):
            if period == "1h":
                raise RuntimeError("boom")
            r = market()
            return {"OKX": r}, r
        lm.set_gather(fn)
        self.assertTrue(lm.build("BTC", "90d")["ok"])

    def test_live_price_moves_the_map_between_builds(self):
        calls: list = []
        lm.set_gather(self.gather(calls))
        price = {"v": 100.0}
        lm.set_price(lambda s: price["v"])
        r0 = lm.liq_map("BTC", "1d")
        self.assertEqual(r0["px"], 100.0)
        price["v"] = 98.0
        r1 = lm.liq_map("BTC", "1d")
        self.assertEqual(r1["px"], 98.0)
        self.assertTrue(all(b["p"] < 98 for b in r1["buckets"] if sum(b["L"])))
        self.assertEqual(len(calls), 1)  # без новой сборки
        self.assertIs(lm.liq_map("BTC", "1d"), r1)  # цена та же — тот же ответ
        price["v"] = 100.0
        r2 = lm.liq_map("BTC", "1d")
        self.assertTrue(all(b["p"] < 98 for b in r2["buckets"] if sum(b["L"])))

    def test_price_far_off_or_broken_is_not_taken(self):
        lm.set_gather(self.gather([]))
        for bad in (150.0, 0.0, -1.0, True, "100", None):
            lm._st.hits.clear()
            lm.set_price(lambda s, v=bad: v)
            self.assertEqual(lm.liq_map("BTC", "1d")["px"], 100.0, bad)
        lm._st.hits.clear()

        def boom(s):
            raise OSError("down")
        lm.set_price(boom)
        self.assertEqual(lm.liq_map("BTC", "1d")["px"], 100.0)
        self.assertEqual(lm.PX_GAP, 0.03)

    def test_true_is_not_a_price(self):
        cheap = [(*r[:1], r[1] / 99, r[2] / 99, r[3] / 99, *r[4:]) for r in market()]  # цена ≈ 1,01
        lm.set_gather(self.gather([], rows=cheap))
        lm.set_price(lambda s: True)
        self.assertEqual(lm.liq_map("PEPE", "1d")["px"], cheap[-1][3])

    def test_build_is_made_around_the_current_price(self):
        lm.set_gather(self.gather([]))
        lm.set_price(lambda s: 100.5)
        r = lm.liq_map("BTC", "1d")
        self.assertEqual(r["px"], 100.5)
        self.assertAlmostEqual(r["lo"], 100.5 * (1 - lm.SPAN))
        self.assertAlmostEqual(r["step"], 100.5 * lm.SPAN * 2 / lm.BUCKETS)

    def test_failing_tail_is_caught_not_left_to_the_thread(self):
        caught = []
        old = threading.excepthook
        threading.excepthook = caught.append
        self.addCleanup(setattr, threading, "excepthook", old)

        def fn(sym, period, n):
            if period == "1h":
                raise RuntimeError("boom")
            r = market()
            return {"OKX": r}, r
        lm.set_gather(fn)
        self.assertTrue(lm.build("BTC", "90d")["ok"])
        self.assertEqual(caught, [])

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
        lm.build("BTC", "1d")
        calls.clear()
        _, st, res = lm._st.hits[("BTC", "1d")]
        lm._st.hits[("BTC", "1d")] = (time.monotonic() - lm.TTL["1d"] - 1, st, res)
        self.assertIs(lm.liq_map("BTC", "1d"), res)
        for _ in range(100):
            if not lm._st.jobs:
                break
            time.sleep(0.02)
        self.assertEqual(len(calls), 1)
        self.assertIsNot(lm.liq_map("BTC", "1d"), res)

    def test_fresh_map_is_not_rebuilt(self):
        calls: list = []
        lm.set_gather(self.gather(calls))
        lm.build("BTC", "90d")
        n = len(calls)
        _, st, res = lm._st.hits[("BTC", "90d")]
        # 10 минут — для 1d уже пора, для 90d — нет.
        lm._st.hits[("BTC", "90d")] = (time.monotonic() - 600, st, res)
        lm.liq_map("BTC", "90d")
        time.sleep(0.05)
        self.assertEqual(len(calls), n)

    def test_too_old_map_is_not_served(self):
        lm.set_gather(self.gather([]))
        lm.build("BTC", "1d")
        _, st, res = lm._st.hits[("BTC", "1d")]
        lm.set_gather(self.gather([], rows=[]))
        lm._st.hits[("BTC", "1d")] = (time.monotonic() - lm.STALE - 1, st, res)
        self.assertEqual(lm.liq_map("BTC", "1d"), {"ok": False, "error": "no_data"})

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
            if (period, n) != lm.PRE:  # предыстория — отдельный поток, не сборка
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

    def test_one_build_per_map_however_many_ask(self):
        gate = threading.Event()
        started = []

        def slow(sym, period, n):
            if (period, n) != lm.PRE:  # предыстория — отдельный поток, не сборка
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
        _, st, res = lm._st.hits[("BTC", "1d")]
        lm._st.hits[("BTC", "1d")] = (time.monotonic() - lm.TTL["1d"], st, res)
        lm.warm("BTC", "1d")
        self.assertEqual(len(calls), 2)
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
        self.assertLessEqual(found, {"__future__", "bisect", "math", "re", "threading", "time", "collections.abc", "typing"})
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
        for s in ("wt_liqmap.set_gather(_liq_gather)", "wt_liqmap.set_price(_liq_price)", "liq_map = wt_liqmap.liq_map",
                  "wt_liqmap.warm(sym, rng)", "LIQ_RANGES = wt_liqmap.RANGES",
                  'OIH_RANGES = {k: wt_liqmap.RANGES[k] for k in ("1d", "7d", "30d")}'):
            self.assertIn(s, api)
        # Каждой свече окна и хвоста — свой период у каждой биржи.
        for period in {p for p, _ in lm.RANGES.values()} | {p for p, _ in lm.TAIL.values()}:
            self.assertIn(f'"{period}": ', api.split("def _liq_okx(")[1].split("def _liq_gate(")[0], period)
            self.assertIn(f'"{period}": ', api.split("def _liq_bybit(")[1].split("def _liq_htx(")[0], period)
            self.assertIn(f'"{period}": ', api.split("def _liq_htx(")[1].split("def _liq_dydx(")[0], period)
            self.assertIn(f'"{period}": ', api.split("def _liq_dydx(")[1].split("# Истории")[0], period)
            self.assertIn(f'"{period}": ', api.split("_LIQ_SEC = ")[1].split("\n")[0], period)
        for old in ("def _liq_model(", "def _liq_build(", "def _liq_build_bg(", "_liq_cache"):
            self.assertNotIn(old, api, old)

    def test_screen_offers_every_window_and_labels_match_the_groups(self):
        with open(os.path.join(ROOT, "src/screens/LiqMapScreen.tsx"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('const LEV_NAME = ["3–10×", "20–25×", "50×", "75–100×", "125–500×"];', src)
        self.assertEqual(len(re.findall(r'"#[0-9a-f]{6}"', src.split("const LEV_C = ")[1].split("\n")[0])), len(lm.GROUPS))
        self.assertEqual(len(re.findall(r'"#[0-9a-f]{6}"', src.split("const LEV_HOT = ")[1].split("\n")[0])), len(lm.GROUPS))
        for rng in lm.RANGES:
            self.assertIn(f'{{ id: "{rng}", key: ', src, rng)
        n = len(lm.GROUPS)
        lo = {g: min(lev for lev, _, gg in lm.LEVS if gg == g) for g in range(n)}
        names = [f"{lo[g]}–{lm.GROUPS[g]}×" if lo[g] != lm.GROUPS[g] else f"{lm.GROUPS[g]}×" for g in range(n)]
        self.assertEqual(names, ["3–10×", "20–25×", "50×", "75–100×", "125–500×"])


if __name__ == "__main__":
    unittest.main()

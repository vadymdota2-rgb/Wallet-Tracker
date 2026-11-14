"""Фаззинг скринера (wt_screen.py): тысячи случайных и битых ответов Binance.

Что бы ни прислал источник — разбор не падает, свечи и монеты годные, а
ответ /api/screener — строгий JSON (без NaN и бесконечностей), каждое число
в своих рамках: те же рамки проверяет приложение (validScreener), и годная
цифра сервера не должна выпадать у телефона.
"""
import json
import math
import os
import random
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_screen as sc  # noqa: E402

SEED = 0x5C2EE7
NOW = 1_794_100_000

JUNK = [None, True, False, 0, -1, 1, 1e308, -1e308, 10**400, float("nan"), float("inf"), "", "x", "nan", "Infinity",
        "-0", "1e999", "  5 ", "٣", [], {}, [1, 2], {"a": 1}, "<script>", "../../etc", "\x00", "1" * 400]


def junk(r: random.Random) -> object:
    return r.choice(JUNK)


def bar(r: random.Random, t: float, px: float) -> list:
    """Свеча Binance — чаще годная, иногда битая в одном поле."""
    o = px
    c = max(px * (1 + r.gauss(0, 0.02)), 1e-9)
    h = max(o, c) * (1 + abs(r.gauss(0, 0.01)))
    lo = min(o, c) * (1 - abs(r.gauss(0, 0.01)))
    row: list = [t, str(o), str(h), str(lo), str(c), str(r.uniform(0, 1e7)), 0, "0", 1, "0", "0", "0"]
    if r.random() < 0.05:
        row[r.randrange(6)] = junk(r)
    if r.random() < 0.01:
        row = row[: r.randrange(6)]
    return row


def klines(r: random.Random) -> object:
    kind = r.random()
    if kind < 0.05:
        return junk(r)
    n = r.choice([0, 1, 30, 59, 60, 61, 120, 300, 600, 700])
    t = 1_700_000_000_000.0
    px = 10 ** r.uniform(-8, 6)
    out = []
    for _ in range(n):
        out.append(bar(r, t, px))
        px = max(px * (1 + r.gauss(0, 0.02)), 1e-9)
        t += r.choice([900_000, 900_000, 900_000, 0, -900_000])  # иногда повтор или назад
    if r.random() < 0.05:
        out.insert(r.randrange(len(out) + 1), junk(r))
    return out


def ticker(r: random.Random) -> object:
    if r.random() < 0.05:
        return junk(r)
    rows: list = []
    for _ in range(r.randrange(0, 60)):
        sym = r.choice(["BTC", "ETH", "1000SATS", "btc", "币安", "A" * 30, "<b>", "BTCUP", "USDC", "X1", ""]) + r.choice(
            ["USDT", "USDT", "BUSD", "", "USDT_250328"])
        rows.append(r.choice([{"symbol": sym, "quoteVolume": r.choice([str(r.uniform(0, 1e10)), junk(r)])}, junk(r)]))
    return rows


def check_metrics(tc: unittest.TestCase, m: sc.Metrics) -> None:
    t, ma, osc, rsi, adx, volx, atrp, tp, sl, mv, age = m
    for v in (t, ma, osc):
        tc.assertTrue(math.isfinite(v) and -1 <= v <= 1, m)
    for v, lo, hi in ((rsi, 0, 100), (adx, 0, 100), (volx, 0, 1e4), (atrp, 0, 1e3), (tp, 0, 1e4), (sl, -100, 0),
                      (mv, -100, 1e5)):
        if v is not None:
            tc.assertTrue(math.isfinite(v), m)
            if lo <= v <= hi:
                continue
            # Вне рамок приложения — только у немыслимых рядов (цена ×1000 за свечу).
            tc.assertTrue(v > hi, m)
    if age is not None:
        tc.assertTrue(isinstance(age, int) and 0 <= age <= sc.SINCE_MAX + 1, m)
        tc.assertEqual(mv is None, age > sc.SINCE_MAX, m)
    if mv is not None:
        tc.assertIsNotNone(age, m)


class FuzzTest(unittest.TestCase):
    def test_bars(self):
        r = random.Random(SEED)  # noqa: S311 — повторяемость, а не криптостойкость
        for _ in range(3000):
            bars = sc.parse_bars(klines(r))
            self.assertLessEqual(len(bars), sc.BARS)
            for i, b in enumerate(bars):
                t, o, h, lo, c, v = b
                self.assertTrue(all(math.isfinite(x) for x in b), b)
                self.assertTrue(t > 0 and 0 < lo <= min(o, c) and max(o, c) <= h < sc.PX_MAX and v >= 0, b)
                if i:
                    self.assertGreater(t, bars[i - 1][0])  # строго по возрастанию времени

    def test_universe(self):
        r = random.Random(SEED + 1)  # noqa: S311 — повторяемость, а не криптостойкость
        for _ in range(3000):
            got = sc.parse_universe(ticker(r), ticker(r))
            names = [c[0] for c in got]
            self.assertEqual(len(names), len(set(names)))  # монета — один раз
            self.assertEqual([c[1] for c in got], sorted((c[1] for c in got), reverse=True))
            for base, vol, venue in got:
                self.assertTrue(base.isascii() and base.isalnum() and base.isupper() and 1 <= len(base) <= 16, base)
                self.assertNotIn(base, sc.SKIP)
                self.assertTrue(math.isfinite(vol), vol)
                self.assertIn(venue, ("s", "f"))
                self.assertGreaterEqual(vol, sc.VOL_MIN if venue == "s" else sc.FUT_VOL_MIN)
            self.assertLessEqual(sum(1 for c in got if c[2] == "s"), sc.COINS_MAX)
            self.assertLessEqual(sum(1 for c in got if c[2] == "f"), sc.FUT_MAX)

    def test_metrics_in_bounds(self):
        r = random.Random(SEED + 2)  # noqa: S311 — повторяемость, а не криптостойкость
        rated = 0
        for _ in range(500):
            bars = sc.parse_bars(klines(r))
            m = sc.metrics(bars)
            if m is None:
                self.assertLess(len(bars), sc.MIN_BARS)
                continue
            rated += 1
            check_metrics(self, m)
            json.dumps(sc.pack(m), allow_nan=False)
        self.assertGreater(rated, 100)

    def test_reply_is_strict_json(self):
        r = random.Random(SEED + 3)  # noqa: S311 — повторяемость, а не криптостойкость
        for _ in range(200):
            uni = sc.parse_universe(ticker(r), ticker(r))
            rates: dict = {}
            px: dict = {}
            for base, _, _ in uni:
                for tf in r.sample(sc.TFS, r.randrange(0, 4)):
                    bars = sc.parse_bars(klines(r))
                    m = sc.metrics(bars)
                    if m:
                        rates.setdefault(tf, {})[base] = (m, NOW - r.choice([0, 30, 10**5]))
                        if tf == "15m":
                            px[base] = (bars[-1][4], sc.change_24h(bars))
            res = sc.reply(uni, rates, px, NOW)
            out = json.dumps(res, allow_nan=False)
            self.assertLess(len(out), 4 << 20)
            if not res["ok"]:
                self.assertEqual(res, {"ok": False, "error": "no_data"})
                continue
            self.assertLessEqual(res["at"], NOW)
            for row in res["rows"]:
                self.assertTrue(row["r"])
                for tf, packed in row["r"].items():
                    self.assertIn(tf, sc.TFS)
                    self.assertEqual(len(packed), 11)
                    self.assertTrue(-1 <= packed[0] <= 1)

    def test_since_matches_brute_force(self):
        # Начало сигнала — то же, что перебором рейтинга по каждой прошлой свече.
        r = random.Random(SEED + 4)  # noqa: S311 — повторяемость, а не криптостойкость
        checked = 0
        for _ in range(60):
            n = r.choice([60, 80, 130, 200])
            t, px, raw = 1_700_000_000_000.0, 10 ** r.uniform(-3, 4), []
            drift = r.choice([-0.01, 0.0, 0.01])
            for _ in range(n):
                raw.append(bar(r, t, px)[:6])
                px = max(px * (1 + drift + r.gauss(0, 0.01)), 1e-9)
                t += 900_000
            bars = sc.parse_bars(raw)
            if len(bars) < sc.MIN_BARS:
                continue
            at = sc._rater(bars)
            mv, age = sc.since(bars, at)
            last = len(bars) - 1
            side = sc.side(at(last)[0])
            if not side:
                self.assertEqual((mv, age), (None, None))
                continue
            j = last
            while j - 1 >= sc.MIN_BARS - 1 and last - j <= sc.SINCE_MAX and sc.side(at(j - 1)[0]) == side:
                j -= 1
            checked += 1
            if last - j > sc.SINCE_MAX or j <= sc.MIN_BARS - 1:
                self.assertEqual((mv, age), (None, sc.SINCE_MAX + 1))
            else:
                self.assertEqual(age, last - j)
                self.assertAlmostEqual(mv, (bars[last][4] / bars[j][4] - 1) * 100)
        self.assertGreater(checked, 20)


if __name__ == "__main__":
    unittest.main()

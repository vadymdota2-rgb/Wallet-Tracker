"""Карта ликвидаций: мусор от бирж (wt_liqmap.clean_rows, fresh, build).

Биржа может отдать что угодно: NaN, бесконечность, строки, bool, нули,
отрицательные числа, повторы и перепутанный порядок свечей, выброс интереса
на один снимок, замершие данные. Карта не падает, ответ — конечные числа,
которые сериализуются в строгий JSON, и мусор не рисует уровней.
"""
import json
import math
import os
import random
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_liqmap as lm  # noqa: E402 — модуль лежит в корне репозитория

JUNK = [float("nan"), float("inf"), -float("inf"), True, False, None, "100", -1.0, 0, 1e308, [], {}]


def good(n=60, t0=1_000_000, step=900, px=100.0, oi=1e6):
    return [(t0 + i * step, px * 1.002, px * 0.998, px, oi * (1 + 0.01 * i), 0.5) for i in range(n)]


class CleanTest(unittest.TestCase):
    def test_junk_values_and_shapes_are_dropped(self):
        base = good(10)
        bad = [
            (base[0][0], float("nan"), 99, 100, 1e6, 0.5), (base[1][0], 101, 99, 100, -5.0, 0.5),
            (base[2][0], 99, 101, 100, 1e6, 0.5), (base[3][0], 101, 99, 0, 1e6, 0.5), (True, 101, 99, 100, 1e6, 0.5),
            ("t", 101, 99, 100, 1e6, 0.5), (base[4][0], 101, 99, 100), "строка", None, [base[5][0], 101, 99, "100", 1e6, 0.5],
        ]
        self.assertEqual(lm.clean_rows(bad), [])
        self.assertEqual(lm.clean_rows([(1, 2e9, 99, 100, 1e6, 0.5), (2, 101, 99, 100, 2e13, 0.5), (3, 1001, 99, 100, 1e6, 0.5),
                                        (4, 101, 99, 2e9, 1e6, 0.5)]), [])
        self.assertEqual(len(lm.clean_rows([(1, 101, 99, 100, 0, 0.5), (2, 990, 99, 100, 1e13, 0.5)])), 2)
        self.assertEqual(lm.clean_rows(None), [])
        self.assertEqual(lm.clean_rows("мусор"), [])

    def test_order_duplicates_and_share(self):
        rows = list(reversed(good(5)))
        rows.append((rows[0][0], 101, 99, 100, 7e6, 2.0))  # повтор последней свечи, доля за 1
        out = lm.clean_rows(rows)
        self.assertEqual([r[0] for r in out], sorted({r[0] for r in rows}))
        self.assertEqual(out[-1][4], 7e6)
        self.assertEqual(out[-1][5], 0.5)

    def test_close_outside_the_candle_widens_it(self):
        out = lm.clean_rows([(1, 101.0, 99.0, 105.0, 1e6, 0.5)])
        self.assertEqual(out[0][1:4], (105.0, 99.0, 105.0))

    def test_one_snapshot_spike_or_zero_is_replaced_by_neighbours(self):
        for odd in (0.0, 1e9):
            rows = good(5)
            rows[2] = (*rows[2][:4], odd, 0.5)
            out = lm.clean_rows(rows)
            q = [r[4] / r[3] for r in out]
            self.assertAlmostEqual(q[2], math.sqrt(q[1] * q[3]), places=6)
        # Настоящий сдвиг (интерес вырос и остался) — не выброс.
        rows = good(5)
        rows[2:] = [(*r[:4], r[4] * 2, 0.5) for r in rows[2:]]
        self.assertEqual(lm.clean_rows(rows)[2][4], rows[2][4])

    def test_spike_is_replaced_at_the_snapshot_price(self):
        # Цена скачет, монет — 100 у всех снимков, у третьего — ноль.
        cl = [100.0, 120.0, 90.0, 130.0, 110.0]
        rows = [(i + 1, c * 1.001, c * 0.999, c, 100 * (cl[i - 1] if i else c), 0.5) for i, c in enumerate(cl)]
        rows[2] = (*rows[2][:4], 0.0, 0.5)
        out = lm.clean_rows(rows)
        self.assertEqual(len(out), 5)
        # В монетах по цене снимка (закрытие прошлой свечи) — снова 100.
        self.assertAlmostEqual(out[2][4] / out[1][3], 100.0, places=6)

    def test_rows_are_bounded(self):
        self.assertEqual(len(lm.clean_rows(good(lm.ROWS_MAX + 50))), lm.ROWS_MAX)

    def test_lagging_exchange_is_left_out(self):
        ref = good(60)
        got = {"live": good(60), "stuck": good(50), "late1": good(58)}
        self.assertEqual(sorted(lm.fresh(got, ref)), ["late1", "live"])
        self.assertEqual(lm.fresh(got, ref[:1]), got)


class BuildCleanTest(unittest.TestCase):
    def setUp(self):
        lm._st = lm._State()
        self.addCleanup(setattr, lm, "_st", lm._State())

    def test_bool_is_not_a_number(self):
        rows = good(10)
        rows[3] = (rows[3][0], True, 99.0, 100.0, 1e6, 0.5)
        rows[4] = (rows[4][0], 101.0, 99.0, 100.0, True, 0.5)
        rows[5] = (rows[5][0], 101.0, 99.0, 100.0, 1e6, True)
        out = lm.clean_rows(rows)
        self.assertEqual([r[0] for r in out], [r[0] for i, r in enumerate(rows) if i not in (3, 4)])
        self.assertEqual(out[3][5], 0.5)

    def test_lagging_exchange_is_left_out_of_the_map(self):
        ref = good(60)
        lm.set_gather(lambda s, p, n: ({"live": ref, "stuck": ref[:-10]}, ref))
        self.assertEqual(lm.build("BTC", "1d")["ex"], ["live"])

    def test_burnt_edge_is_the_fine_running_candle_not_the_whole_day(self):
        # Окно — дневные свечи; сегодня цена падала до 90, потом вернулась к
        # 100, и после этого открылись лонги (хвост — часовые свечи). Край
        # сгорания — по последней часовой свече, а не по всему дню: лонги,
        # открытые после минимума, на карте есть.
        day = 86_400
        main = [(i * day, 100.5, 99.5, 100.0, 1e6, 0.9) for i in range(20)]
        main[-1] = (19 * day, 101.0, 90.0, 100.0, 1e6, 0.9)
        tail = [(19 * day + h * 3600, 100.2, 99.8, 100.0, 1e6 * (1 + 0.2 * h), 0.9) for h in range(10)]
        tail[0] = (19 * day, 100.2, 90.0, 95.0, 1e6, 0.9)

        def gather(sym, period, n):
            rows = tail if period == "1h" else main
            return {"OKX": rows}, rows
        lm.set_gather(gather)
        r = lm.build("BTC", "90d")
        near = [b for b in r["buckets"] if sum(b["L"]) and 95 < b["p"] < 100]
        self.assertTrue(near, "лонги, открытые после минимума дня, сожжены всем днём")


class FuzzTest(unittest.TestCase):
    def setUp(self):
        lm._st = lm._State()
        self.addCleanup(setattr, lm, "_st", lm._State())

    def test_random_garbage_never_breaks_the_map(self):
        rnd = random.Random(11)  # noqa: S311 — выдуманный рынок, не тайна
        for case in range(300):
            rows = good(rnd.randint(1, 80), px=rnd.choice([0.0001, 1.0, 100.0, 1e5]))
            rows = [list(r) for r in rows]
            for _ in range(rnd.randint(0, 20)):
                r = rnd.choice(rows)
                r[rnd.randint(0, 5)] = rnd.choice([*JUNK, rnd.uniform(-1e3, 1e9)])
            rnd.shuffle(rows) if rnd.random() < 0.2 else None
            ref = [tuple(r) for r in rows]
            lm.set_gather(lambda s, p, n, r=ref: ({"A": r, "B": r[: len(r) // 2]}, r))
            lm._st.hits.clear()
            lm._st.fails.clear()
            res = lm.build(f"C{case}", "1d")
            text = json.dumps(res, allow_nan=False)  # строгий JSON: ни NaN, ни бесконечностей
            self.assertTrue(text)
            if res["ok"]:
                self.assertGreater(res["px"], 0)
                for b in res["buckets"]:
                    self.assertTrue(all(isinstance(v, int) and v >= 0 for v in b["L"] + b["S"]), b)
                    self.assertTrue(math.isfinite(b["p"]) and b["p"] > 0)
                self.assertLessEqual(res["seen"], max(res["oi"], 0))
            else:
                self.assertIn(res["error"], ("no_data",))


if __name__ == "__main__":
    unittest.main()

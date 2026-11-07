"""Карта ликвидаций: фандинг сдвигает уровни платящей стороны (npm test).

Платящая сторона отдаёт «цена × ставка» с монеты позиции из маржи — её
ликвидация подходит к цене. Проверяем: сдвиг на заплаченное, сгорание по
сдвинутому уровню (и только по ставкам, что уже были), получающая сторона
не двигается, горизонт FUND_HOLD, мусор в ставках, без ставок — как было;
кэш и сбои источника; подключение на сервере.
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

H = 3600
T0 = 1_700_000_000 // H * H
N = 200  # часовых свечей
END = T0 + N * H
LO, STEP = 0.0, 100 * lm.SPAN * 2 / lm.FINE  # сетка у цены 100


def rows(spike: tuple[int, float, float] | None = None) -> list[lm.Row]:
    """Цена 100, свеча ±0,1; на свече 9 открылся миллион монет (поровну)."""
    out = []
    for i in range(N):
        hi, low = 100.1, 99.9
        if spike and spike[0] == i:
            hi, low = spike[1], spike[2]
        coins = 1e6 if i < 10 else 2e6
        out.append((T0 + i * H, hi, low, 100.0, coins * 100.0, 0.5))
    return out


def run(fund=None, data=None):
    return lm.model(data or rows(), LO, STEP, lm.LEVS, since=T0, fund=(fund, END) if fund is not None else None)


def where(side: list[list[float]]) -> tuple[float, float]:
    """(монеты, средняя цена уровня по монетам)."""
    mids = lm.mids(LO, STEP)
    tot = sum(sum(g) for g in side)
    avg = sum(q * mids[b] for g in side for b, q in enumerate(g)) / tot if tot else 0.0
    return tot, avg


def every_hour(rate: float, start: int = T0, stop: int = END) -> list[lm.FundPoint]:
    return [(t, rate) for t in range(start, stop, 8 * H)]


class CleanTest(unittest.TestCase):
    def test_garbage_is_dropped(self):
        nan, inf = float("nan"), float("inf")
        got = lm.clean_fund([(T0 + 2, 0.001), (T0, -0.01), (T0, -0.02), [T0 + 1, 0.0], (T0 + 3, nan), (T0 + 4, inf),
                             (T0 + 5, 0.3), (T0 + 6, -0.21), (True, 0.01), (0, 0.01), (-5, 0.01), (1.5, 0.01),
                             (T0 + 7, "0.01"), (T0 + 8, True), (T0 + 9,), "x", None, (T0 + 10, 0.2, 1)])
        self.assertEqual(got, [(T0, -0.02), (T0 + 1, 0.0), (T0 + 2, 0.001)])
        for junk in (None, "x", 5, {}, {"a": 1}):
            self.assertEqual(lm.clean_fund(junk), [])

    def test_paid_by_side_and_horizon(self):
        pts = [(T0, 0.01), (T0 + 8 * H, -0.02)]
        end = T0 + 16 * H
        self.assertEqual(lm._fund_paid(pts, T0, T0 + 4 * H, end), (0.005, 0.0))
        long_p, short_p = lm._fund_paid(pts, T0, end, end)
        self.assertAlmostEqual(long_p, 0.01)
        self.assertAlmostEqual(short_p, 0.02)
        # Последняя ставка действует до end, не дальше.
        self.assertEqual(lm._fund_paid(pts, end, end + 8 * H, end), (0.0, 0.0))
        # И не дольше своего периода: источник отстал — ставка не тянется.
        stale = [(T0, -0.02)]
        self.assertEqual(lm._fund_paid(stale, T0, T0 + 30 * H, T0 + 30 * H), (0.0, 0.02))
        # Старше FUND_HOLD до end — не считается.
        far = end + lm.FUND_HOLD
        self.assertEqual(lm._fund_paid(pts, T0, end, far), (0.0, 0.0))
        self.assertEqual(lm._fund_paid([], T0, end, end), (0.0, 0.0))


class ModelTest(unittest.TestCase):
    def test_without_rates_nothing_changes(self):
        base = run()
        for fund in ([], every_hour(0.0), every_hour(0.01, END + H, END + 9 * H)):
            self.assertEqual(run(fund), base)
        self.assertEqual(lm.model(rows(), LO, STEP, lm.LEVS, since=T0), base)

    def test_shorts_pay_their_levels_come_down(self):
        base_l, base_s, _ = run()
        got_l, got_s, mass = run(every_hour(-0.01))
        self.assertEqual(got_l, base_l)  # лонги получают — уровни на месте
        # За FUND_HOLD (168 ч) шорт заплатил 100 × 1 % × 21 = 21 в цене:
        # у 3× ликвидация с ~132,8 сошла к ~111,8, а 5× и выше (119,5 → 98,5)
        # цена уже прошла — ликвидированы.
        coins, avg = where(got_s)
        self.assertAlmostEqual(coins, 1e6 * 0.5 * 0.10, delta=1)
        b_coins, _ = where([[q if abs(lm.mids(LO, STEP)[b] - 132.8) < 1 else 0 for b, q in enumerate(g)] for g in base_s])
        self.assertAlmostEqual(b_coins, coins, delta=1)
        self.assertAlmostEqual(avg, 132.8 - 21, delta=0.5)
        self.assertAlmostEqual(mass, where(base_l)[0] + coins, delta=1)

    def test_longs_pay_their_levels_go_up(self):
        base_l, base_s, _ = run()
        got_l, got_s, _ = run(every_hour(0.01))
        self.assertEqual(got_s, base_s)
        coins, avg = where(got_l)
        self.assertAlmostEqual(coins, 1e6 * 0.5 * 0.10, delta=1)
        self.assertAlmostEqual(avg, 100 * (1 - (1 / 3 - lm.mmr(3))) + 21, delta=0.5)
        self.assertLess(coins, where(base_l)[0])

    def test_burn_counts_only_what_was_already_paid(self):
        # Ставка −1 % с 100-го часа: к концу сдвиг 12,5. Скачок до 125 на
        # 50-м часу (ещё без фандинга) уровень 3× (132,8) не задел — он жив и
        # сдвинут к ~120,3; тот же скачок на 190-м часу (сдвиг уже ~11,3,
        # уровень ~121,5) — ликвидировал.
        fund = every_hour(-0.01, T0 + 100 * H)
        _, early, _ = run(fund, rows((50, 125.0, 99.9)))
        _, late, _ = run(fund, rows((190, 125.0, 99.9)))
        coins, avg = where(early)
        self.assertAlmostEqual(coins, 1e6 * 0.5 * 0.10, delta=1)
        self.assertAlmostEqual(avg, 132.8 - 12.5, delta=0.5)
        self.assertEqual(where(late)[0], 0.0)

    def test_old_rates_beyond_the_horizon_do_not_count(self):
        old = every_hour(-0.05, T0, END - lm.FUND_HOLD - 8 * H)
        self.assertEqual(run(old), run())

    def test_state_and_reply_carry_the_shift(self):
        data = rows()
        st0 = lm.make_state("BTC", "7d", {"OKX": data}, data, 100.0, END)
        st1 = lm.make_state("BTC", "7d", {"OKX": data}, data, 100.0, END, None, every_hour(-0.01))
        self.assertEqual(st0["L"], st1["L"])
        self.assertLess(sum(map(sum, st1["S"])), sum(map(sum, st0["S"])))
        self.assertLess(st1["seen"], st0["seen"])
        res = lm.render(st1, 100.0)
        self.assertTrue(res["ok"])


class CacheTest(unittest.TestCase):
    def setUp(self):
        lm._st = lm._State()
        self.addCleanup(setattr, lm, "_st", lm._State())

    def wait_jobs(self):
        for job in list(lm._st.fund_jobs.values()):
            if job is not threading.current_thread():
                job.join(5)

    def test_fetch_cache_and_failure(self):
        calls = []

        def fn(sym):
            calls.append(sym)
            return [(T0, -0.01), (T0 + 8 * H, "x")]

        lm.set_funding(fn)
        self.assertEqual(lm._fund("BTC", 5), [(T0, -0.01)])
        self.assertEqual(lm._fund("BTC", 5), [(T0, -0.01)])
        self.assertEqual(calls, ["BTC"])  # свежие — из кэша
        # Сбой источника: уровни без сдвига, повтор не раньше FUND_RETRY.
        lm.set_funding(lambda _s: 1 / 0)
        self.assertEqual(lm._fund("ETH", 5), [])
        self.wait_jobs()
        self.assertIn("ETH", lm._st.fund_retry)
        self.assertEqual(lm._fund("ETH", 0), [])
        self.assertNotIn("ETH", lm._st.fund_jobs)
        # Не список — тоже сбой, а пустой список — «ставок нет».
        lm.set_funding(lambda _s: {"bars": []})
        self.assertEqual(lm._fund("SOL", 5), [])
        self.assertIn("SOL", lm._st.fund_retry)
        lm.set_funding(lambda _s: [])
        self.assertEqual(lm._fund("XRP", 5), [])
        self.assertIn("XRP", lm._st.fund)
        lm.set_funding(None)
        self.assertEqual(lm._fund("ADA", 5), [])

    def test_stale_is_served_while_refreshing_and_dropped_when_too_old(self):
        lm.set_funding(lambda _s: [(T0, 0.01)])
        lm._st.fund["BTC"] = (time.monotonic() - lm.FUND_TTL - 1, [(T0, -0.02)])
        self.assertEqual(lm._fund("BTC", 0), [(T0, -0.02)])  # старая — сразу
        self.wait_jobs()
        self.assertEqual(lm._fund("BTC", 0), [(T0, 0.01)])  # а свежая уже в кэше
        lm.set_funding(lambda _s: 1 / 0)
        lm._st.fund["ETH"] = (time.monotonic() - lm.FUND_STALE - 1, [(T0, -0.02)])
        self.assertEqual(lm._fund("ETH", 5), [])

    def test_cache_is_bounded(self):
        lm.set_funding(lambda _s: [(T0, 0.001)])
        for i in range(lm.FUND_KEEP + 5):
            lm._fund(f"C{i}", 5)
        self.wait_jobs()
        self.assertLessEqual(len(lm._st.fund), lm.FUND_KEEP)
        self.assertIn(f"C{lm.FUND_KEEP + 4}", lm._st.fund)

    def test_build_uses_the_rates(self):
        now = lm._now() // H * H
        data = [(now - (N - 1 - i) * H, r[1], r[2], r[3], r[4], r[5]) for i, r in enumerate(rows())]

        def gather(_sym, period, _n):
            return ({"OKX": data}, data) if period == "1h" else ({}, None)

        lm.set_gather(gather)
        self.addCleanup(lm.set_gather, None)
        plain = lm.build("BTC", "7d", pre_wait=0.0)
        lm.set_funding(lambda _s: every_hour(-0.01, now - 10 * 86400, now + H))
        self.addCleanup(lm.set_funding, None)
        lm._fund("BTC", 5)
        shifted = lm.build("BTC", "7d", pre_wait=0.0)
        s0 = sum(sum(b["S"]) for b in plain["buckets"])
        s1 = sum(sum(b["S"]) for b in shifted["buckets"])
        self.assertLess(s1, s0)
        self.assertEqual(sum(sum(b["L"]) for b in plain["buckets"]), sum(sum(b["L"]) for b in shifted["buckets"]))


class ServerTest(unittest.TestCase):
    def test_server_rates_are_fractions_per_8h(self):
        bars = {"bars": [[T0, -1.5], [T0 + 28800, 0.01], [T0 + 57600, None], ["x", 1], [T0 + 86400, True]]}
        with mock.patch.object(api, "_fund_hist", return_value=bars) as fh:
            got = api._liq_funding("HUMA")
        fh.assert_called_once_with("HUMA", lm.FUND_HOLD // 86400 + 1)
        self.assertEqual(got, [(T0, -0.015), (T0 + 28800, 0.0001)])
        with mock.patch.object(api, "_fund_hist", return_value={}):
            self.assertEqual(api._liq_funding("HUMA"), [])

    def test_wired(self):
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            self.assertIn("wt_liqmap.set_funding(_liq_funding)", f.read())

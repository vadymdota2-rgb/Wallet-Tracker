"""Экран «Институциональные потоки»: фонды, найденные по цепочке, — своими
потоками (wt_etf.set_chain), остальные — по отчётам (npm test).

В цепочке деньги фонда приходят на следующий рабочий день после торгов:
заявка во вторник — в среду, в пятницу — в понедельник. Итоги дня правятся
на разницу, чтобы экран всегда был полным.
"""
import copy
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_etf as e  # noqa: E402 — модуль лежит в корне репозитория

DAY = 86400
MON = 20_710 * DAY  # понедельник, 14 сентября 2026
PX = 80_000.0


def cmc_days() -> dict:
    """Пять торговых дней: BITB и IBIT по отчётам ($ и BTC), итог дня."""
    out = {}
    for i, (b, ib) in enumerate(((10.0, 100.0), (0.0, -50.0), (-20.0, 30.0), (5.0, 0.0), (7.0, 70.0))):
        by = {"BITB": {"usd": b * PX, "btc": b}, "IBIT": {"usd": ib * PX, "btc": ib}}
        out[MON + i * DAY] = (by, (b + ib) * PX, b + ib)
    return out


class ChainMergeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.px = {MON + i * DAY: PX for i in range(5)}

    def tearDown(self) -> None:
        e.set_chain(None)

    def run_merge(self, chain: dict, today: int) -> tuple[dict, dict, dict]:
        days = cmc_days()
        orig = copy.deepcopy(days)
        e.set_chain(lambda: chain)
        with mock.patch.object(e, "_now", lambda: today):
            used = e._apply_chain(days, self.px)
        return days, orig, used

    def test_substitutes_settled_days_with_t_plus_1(self) -> None:
        # Сделки пн…пт; в цепочке — вт, ср, чт, пт и следующий понедельник.
        chain = {"BITB": {"from": MON - 7 * DAY, "hold": 37_000.0,
                          "days": {MON + 1 * DAY: 11.0, MON + 3 * DAY: -19.0, MON + 4 * DAY: 5.5,
                                   MON + 7 * DAY: 6.0}}}
        days, orig, used = self.run_merge(chain, MON + 30 * DAY)
        self.assertEqual(list(used), ["BITB"])
        got = [days[MON + i * DAY][0]["BITB"]["btc"] for i in range(5)]
        # вторник — первый день без «предыдущего окна»: остаётся по отчёту.
        self.assertEqual(got, [10.0, 0.0, -19.0, 5.5, 6.0])
        # Итог дня — на разницу; другой фонд не тронут.
        d = MON + 2 * DAY
        self.assertAlmostEqual(days[d][1] - orig[d][1], (-19.0 - -20.0) * PX)
        self.assertAlmostEqual(days[d][2] - orig[d][2], 1.0)
        self.assertEqual(days[d][0]["IBIT"], orig[d][0]["IBIT"])

    def test_before_coverage_and_unsettled_day_keep_reports(self) -> None:
        chain = {"BITB": {"from": MON + 3 * DAY, "hold": None,
                          "days": {MON + 2 * DAY: 99.0, MON + 4 * DAY: 1.0, MON + 7 * DAY: 2.0}}}
        # «Сегодня» — понедельник следующей недели: деньги пятницы ещё в пути.
        days, _, _ = self.run_merge(chain, MON + 7 * DAY)
        got = [days[MON + i * DAY][0]["BITB"]["btc"] for i in range(5)]
        # Пн–ср — до начала наблюдения; чт — по цепочке; пт — ещё не дошёл.
        self.assertEqual(got, [10.0, 0.0, -20.0, 1.0, 7.0])

    def test_broken_source_changes_nothing(self) -> None:
        def boom() -> dict:
            raise RuntimeError("база занята")

        days = cmc_days()
        orig = copy.deepcopy(days)
        e.set_chain(boom)
        self.assertEqual(e._apply_chain(days, self.px), {})
        self.assertEqual(days, orig)

    def test_coin_marks_chain_funds(self) -> None:
        chain = {"BITB": {"from": MON - 7 * DAY, "hold": 37_000.0, "days": {MON + 2 * DAY: 1.0}}}
        e.set_chain(lambda: chain)
        pts = [{"date": d * 1000, "total": {"usd": v[1]}, **v[0]} for d, v in cmc_days().items()]
        with mock.patch.object(e, "_points", lambda cat: pts), \
                mock.patch.object(e, "_prices", lambda sym, days: dict(self.px)), \
                mock.patch.object(e, "_get", lambda url, timeout=20: {}), \
                mock.patch.object(e, "_share", lambda cat: {}), \
                mock.patch.object(e, "_now", lambda: MON + 30 * DAY):
            c = e._coin("btc", "BTCUSDT")
        self.assertIsNotNone(c)
        funds = {f["t"]: f for f in (c or {}).get("funds", [])}
        self.assertEqual(funds["BITB"].get("src"), "chain")
        self.assertEqual(funds["BITB"]["aum"], round(37_000.0 * PX))
        self.assertNotIn("src", funds["IBIT"])


if __name__ == "__main__":
    unittest.main()

"""Экран кошелька «как у терминалов»: счёт, позиции и результат сделок (npm test).

Бюджет Hyperliquid не тратится: счёт (маржа, свободно, объём позиций) — из
того же ответа clearinghouseState, что и позиции, а результат закрытых
сделок (кривая PnL, винрейт, профит-фактор, просадка) — из нашей базы
(hl_fills), по тем же правилам, что доска рейтинга.
"""
import random
import sqlite3
import sys
import unittest
from unittest import mock

from test_hl_wallet_index import SCHEMA, Spy, plan

import whale_api as api

N = 1_000_000_000
A = "0x" + "a" * 40
B = "0x" + "b" * 40
T = 1_794_300_000  # «сейчас», секунды
DAY = 86_400

PERP = {
    "marginSummary": {"accountValue": "20580262.69", "totalNtlPos": "96557167.81", "totalMarginUsed": "7427474.45"},
    "withdrawable": "10924545.9", "crossMaintenanceMarginUsed": "1203000.5",
    "assetPositions": [
        # Шорт при положительной ставке получает фандинг: у Hyperliquid
        # cumFunding отрицательный (сверено с живыми позициями).
        {"position": {"coin": "BTC", "szi": "-1290.85397", "entryPx": "75355.3", "positionValue": "96557167.81",
                      "unrealizedPnl": "715638.53", "returnOnEquity": "0.0964", "liquidationPx": "89623.8",
                      "marginUsed": "7427474.45", "leverage": {"type": "cross", "value": 13},
                      "cumFunding": {"allTime": "-900000", "sinceOpen": "-561645.75", "sinceChange": "0"}}},
        # Лонг при положительной ставке платит: cumFunding положительный.
        {"position": {"coin": "ETH", "szi": "2", "entryPx": "3000", "positionValue": "6200",
                      "unrealizedPnl": "200", "liquidationPx": None, "marginUsed": "620",
                      "leverage": {"type": "isolated", "value": 10},
                      "cumFunding": {"allTime": "12", "sinceOpen": "3.5", "sinceChange": "0"}}},
    ],
}
SPOT = {"balances": []}


def hl_db(rows):
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    con.executemany(
        "INSERT INTO hl_fills (tid, wallet, coin, dir, side, dir_code, px, sz, closed_pnl_nanos, fee_nanos, ts)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
    return con


def close(tid, wallet, pnl, fee, ts_s):
    return (tid, wallet, "BTC", "Close Long", "A", 3, "100", "1", int(pnl * N), int(fee * N), ts_s * 1000)


class AccountTest(unittest.TestCase):
    def setUp(self):
        api._hl_cache.pop(A, None)
        self.addCleanup(api._hl_cache.pop, A, None)

    def test_account_and_positions_from_one_answer(self):
        calls = []

        def post(p, timeout=6.0, max_bytes=0):
            calls.append(p["type"])
            return PERP if p["type"] == "clearinghouseState" else SPOT

        with mock.patch.object(api, "hl_post", post):
            pos, _, _ = api.parse_positions(A)
            before = list(calls)
            acct = api.hl_account(A)
        # Счёт — из той же памяти: ни одного нового запроса к Hyperliquid.
        self.assertEqual(calls, before)
        self.assertEqual(sorted(c for c in calls if "Clearinghouse" in c or "clearinghouse" in c),
                         ["clearinghouseState", "spotClearinghouseState"])
        self.assertEqual(acct, {"equity": 20580262.69, "margin": 7427474.45, "free": 10924545.9,
                                "ntl": 96557167.81, "maint": 1203000.5})
        btc, eth = pos
        self.assertEqual((btc["long"], btc["lev"], btc["liq"], btc["margin"]), (False, 13, 89623.8, 7427474.45))
        # Фандинг — влиянием на результат: шорт получил (+), лонг заплатил (−).
        self.assertAlmostEqual(btc["funding"], 561645.75)
        self.assertAlmostEqual(eth["funding"], -3.5)
        self.assertEqual((eth["liq"], eth["isolated"]), (0, True))  # ликвидации нет — 0, а не ошибка

    def test_junk_account_numbers_are_zero(self):
        bad = {"marginSummary": {"accountValue": "nan", "totalNtlPos": "x"}, "withdrawable": None, "assetPositions": []}
        with mock.patch.object(api, "hl_post", lambda p, timeout=6.0, max_bytes=0: bad if p["type"] == "clearinghouseState" else SPOT):
            self.assertEqual(api.hl_account(A), {"equity": 0.0, "margin": 0.0, "free": 0.0, "ntl": 0.0, "maint": 0.0})


class PerfTest(unittest.TestCase):
    def test_numbers_match_the_rank_board_rules(self):
        rows = [close(1, A, 500, 5, T - 2 * DAY), close(2, A, -200, 2, T - DAY), close(3, A, 300, 3, T - 3600),
                close(4, A, 1000, 10, T - 20 * DAY),
                # Открытие (код 1, closed_pnl 0) — не сделка; чужой кошелёк — не наш.
                (5, A, "BTC", "Open Long", "A", 1, "100", "1", 0, 1 * N, (T - 3600) * 1000),
                close(6, B, 9999, 0, T - 3600)]
        perf = api.wallet_perf(hl_db(rows), A, T)
        w7, w30 = perf["7"], perf["30"]
        self.assertEqual((w7["trades"], w7["wins"], w7["win"]), (3, 2, 66.7))
        self.assertAlmostEqual(w7["pnl"], 500 - 5 - 200 - 2 + 300 - 3)
        self.assertAlmostEqual(w7["pf"], round((495 + 297) / 202, 2))
        self.assertEqual((w7["best"], w7["worst"]), (495, -202))
        self.assertAlmostEqual(w7["dd"], 202)  # с вершины 495 вниз до 293
        self.assertEqual(w30["trades"], 4)
        self.assertAlmostEqual(w30["pnl"], 990 + 590)

    def test_curve_by_days_starts_at_zero_and_ends_now(self):
        rows = [close(i + 1, A, 100, 0, T - (6 - i) * DAY - 3600) for i in range(7)]
        pts = api.wallet_perf(hl_db(rows), A, T)["7"]["pts"]
        self.assertEqual(len(pts), 8)
        self.assertEqual(pts[0], [T - 7 * DAY, 0.0])
        self.assertEqual(pts[-1], [T, 700.0])
        self.assertEqual([p[1] for p in pts], sorted(p[1] for p in pts))  # только прибыль — кривая не падает
        self.assertEqual([p[0] for p in pts], [T - 7 * DAY + d * DAY for d in range(8)])

    def test_no_losses_no_profit_factor_and_no_trades_no_window(self):
        perf = api.wallet_perf(hl_db([close(1, A, 100, 0, T - 20 * DAY)]), A, T)
        self.assertNotIn("7", perf)  # за неделю сделок нет — окна нет
        self.assertIsNone(perf["30"]["pf"])
        self.assertEqual(api.wallet_perf(hl_db([]), A, T), {})
        self.assertEqual(api.wallet_perf(None, A, T), {})
        self.assertEqual(api.wallet_perf(hl_db([]), "не адрес", T), {})

    def test_query_uses_the_wallet_index_and_is_bounded(self):
        rnd = random.Random(3)  # noqa: S311 — повторяемые данные теста, не тайна
        rows = [close(i + 1, A, rnd.uniform(-50, 60), 0.1, T - rnd.randrange(30 * DAY)) for i in range(500)]
        con = hl_db(rows)
        spy = Spy(con)
        with mock.patch.object(api, "PERF_ROWS", 100):
            perf = api.wallet_perf(spy, A, T)
        self.assertEqual(perf["30"]["trades"], 100)  # не больше PERF_ROWS — последние
        (sql, params), = spy.seen
        self.assertNotIn("lower(", sql.lower())
        self.assertIn("idx_hl_fills_wallet", plan(con, sql, params))

    def test_wallet_answer_has_account_and_perf(self):
        cur = sqlite3.connect(":memory:")
        cur.row_factory = sqlite3.Row
        cur.executescript(
            "CREATE TABLE whale_addresses (id INTEGER PRIMARY KEY, address TEXT);"
            "CREATE TABLE user_whales (user_id TEXT, whale_id INTEGER, label TEXT, created_at INTEGER);")
        cur.execute("INSERT INTO whale_addresses VALUES (1, ?)", (A,))
        cur.execute("INSERT INTO user_whales VALUES ('42', 1, '', 1)")
        hl = hl_db([close(1, A, 100, 1, api.now() - 3600)])
        api._hl_cache.pop(A, None)
        self.addCleanup(api._hl_cache.pop, A, None)
        with mock.patch.object(api, "hl_post", lambda p, timeout=6.0, max_bytes=0: PERP if p["type"] == "clearinghouseState" else SPOT):
            rep = api.wallet_live(cur, "42", A, hl)
            # Чужой кошелёк — ни счёта, ни сделок.
            self.assertEqual(api.wallet_live(cur, "43", A, hl), {"ok": False, "error": "not_found"})
        self.assertTrue(rep["ok"])
        self.assertEqual(rep["acct"]["free"], 10924545.9)
        self.assertEqual(rep["perf"]["7"]["trades"], 1)


if __name__ == "__main__":
    sys.exit(unittest.main())

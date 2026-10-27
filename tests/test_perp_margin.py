"""Знаменатель ROI доски перпов (whale_api.perp_margin): npm test.

Закрытий за 30 дней — сотни тысяч, и разом в памяти (fetchall) они стоили
службе ~400 МБ: вместе с остальными кешами она упиралась в MemoryMax и
падала. Проверяем и счёт, и то, что строки идут из базы по одной.
"""
import sqlite3
import unittest

import whale_api as api

SINCE = 1_000
N = 1_000_000_000


def fills(rows):
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.execute(
        "CREATE TABLE hl_fills (wallet TEXT, side TEXT DEFAULT '', dir_code INTEGER DEFAULT 0,"
        " px TEXT DEFAULT '', sz TEXT DEFAULT '', closed_pnl_nanos INTEGER DEFAULT 0,"
        " notional_nanos INTEGER DEFAULT 0, margin_nanos INTEGER DEFAULT 0,"
        " leverage INTEGER DEFAULT 0, ts INTEGER DEFAULT 0, flat INTEGER DEFAULT 0,"
        " start_pos_nanos INTEGER)")
    cols = ("wallet", "side", "px", "sz", "start_pos_nanos", "leverage", "margin_nanos", "ts", "closed_pnl_nanos")
    defaults = {"side": "", "start_pos_nanos": None, "margin_nanos": 0, "ts": SINCE, "closed_pnl_nanos": N}
    con.executemany(
        "INSERT INTO hl_fills (wallet, side, px, sz, start_pos_nanos, leverage, margin_nanos, ts, closed_pnl_nanos)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        [tuple({**defaults, **r}[c] for c in cols) for r in rows])
    return con


class NoFetchall:
    """Соединение, у которого fetchall() запрещён: строки — только по одной."""

    def __init__(self, con):
        self.con = con

    def execute(self, *a):
        cur = self.con.execute(*a)

        class Cur:
            def __iter__(self):
                return iter(cur)

            def fetchall(self):
                raise AssertionError("fetchall — все строки разом в памяти")

        return Cur()


class PerpMarginTest(unittest.TestCase):
    def test_closed_notional_over_leverage(self):
        con = fills([
            # Закрыл весь лонг 2 по 100 при плече 10 — маржа 20.
            {"wallet": "a", "side": "A", "px": "100", "sz": "2", "start_pos_nanos": 2 * N, "leverage": 10},
            # Переворот: был лонг 1, продал 3 — закрыта только единица.
            {"wallet": "b", "side": "A", "px": "50", "sz": "3", "start_pos_nanos": 1 * N, "leverage": 5},
            # Долив в ту же сторону ничего не закрыл.
            {"wallet": "b", "side": "B", "px": "50", "sz": "3", "start_pos_nanos": 1 * N, "leverage": 5},
        ])
        self.assertEqual(api.perp_margin(con, None, SINCE), {"a": 20.0, "b": 10.0})

    def test_missing_leverage_takes_wallet_average_then_margin(self):
        con = fills([
            {"wallet": "a", "px": "10", "sz": "1", "leverage": 5},
            {"wallet": "a", "px": "10", "sz": "1", "leverage": 15},
            # Плеча нет — среднее по кошельку, 10.
            {"wallet": "a", "px": "30", "sz": "1", "leverage": 0},
            # У кошелька плеча нет нигде — снимок маржи позиции.
            {"wallet": "c", "px": "30", "sz": "1", "leverage": 0, "margin_nanos": 7 * N},
        ])
        self.assertEqual(api.perp_margin(con, None, SINCE), {"a": 10 / 5 + 10 / 15 + 30 / 10, "c": 7.0})

    def test_only_closes_in_window_and_listed_wallets(self):
        con = fills([
            {"wallet": "a", "px": "10", "sz": "1", "leverage": 1},
            {"wallet": "a", "px": "10", "sz": "1", "leverage": 1, "ts": SINCE - 1},
            # Не закрытие: ни прибыли, ни flat, ни кода закрытия.
            {"wallet": "a", "px": "10", "sz": "1", "leverage": 1, "closed_pnl_nanos": 0},
            # Плечо незакрывающей строки не входит в среднее.
            {"wallet": "a", "px": "10", "sz": "1", "leverage": 0},
            {"wallet": "z", "px": "10", "sz": "1", "leverage": 1},
        ])
        self.assertEqual(api.perp_margin(con, ["a"], SINCE), {"a": 20.0})
        self.assertEqual(api.perp_margin(con, [], SINCE), {})

    def test_rows_are_streamed_not_loaded_at_once(self):
        con = fills([{"wallet": "a", "px": "10", "sz": "1", "leverage": 2}])
        self.assertEqual(api.perp_margin(NoFetchall(con), None, SINCE), {"a": 5.0})

    def test_broken_db_gives_empty(self):
        con = fills([{"wallet": "a", "px": "10", "sz": "1", "leverage": 2}])
        con.execute("DROP TABLE hl_fills")
        con.execute("CREATE TABLE hl_fills (wallet TEXT, leverage INTEGER)")
        self.assertEqual(api.perp_margin(con, None, SINCE), {})


if __name__ == "__main__":
    unittest.main()

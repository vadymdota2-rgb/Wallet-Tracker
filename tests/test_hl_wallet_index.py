"""Запросы по одному кошельку к hl_fills идут по индексу: npm test.

В hl_fills — сотни тысяч сделок Hyperliquid. Пока API искал кошелёк через
lower(wallet)=?, индекс (wallet, ts) не работал, и каждый запрос читал всю
таблицу: /api/deals отвечал по 20+ секунд, приложение не дожидалось
(«клиент ушёл, не дождавшись ответа» в журнале), а список кошельков читал
таблицу целиком при каждом открытии приложения. Бот пишет адреса строчными
(toLower в hyperliquid_core.cpp), поэтому точное сравнение — то же самое.
"""
import sqlite3
import unittest

import whale_api as api

N = 1_000_000_000
A = "0x" + "a" * 40
B = "0x" + "b" * 40

# Схема и индексы — как у бота (hyperliquid_core.cpp): план запроса зависит от них.
SCHEMA = """
CREATE TABLE hl_fills (
  tid INTEGER PRIMARY KEY, wallet TEXT NOT NULL, coin TEXT NOT NULL DEFAULT '',
  dir TEXT NOT NULL DEFAULT '', side TEXT NOT NULL DEFAULT '', dir_code INTEGER NOT NULL DEFAULT 0,
  px TEXT NOT NULL DEFAULT '', sz TEXT NOT NULL DEFAULT '', closed_pnl_nanos INTEGER NOT NULL DEFAULT 0,
  fee_nanos INTEGER NOT NULL DEFAULT 0, notional_nanos INTEGER NOT NULL DEFAULT 0,
  margin_nanos INTEGER NOT NULL DEFAULT 0, leverage INTEGER NOT NULL DEFAULT 0,
  oid INTEGER NOT NULL DEFAULT 0, account_value_nanos INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL DEFAULT 0, hash TEXT NOT NULL DEFAULT '', flat INTEGER NOT NULL DEFAULT 0,
  start_pos_nanos INTEGER);
CREATE INDEX idx_hl_fills_wallet_ts ON hl_fills(wallet, ts);
CREATE INDEX idx_hl_fills_ts ON hl_fills(ts);
CREATE INDEX idx_hl_fills_code_ts ON hl_fills(dir_code, ts);
CREATE INDEX idx_hl_fills_wallet_coin_ts ON hl_fills(wallet, coin, ts);
"""


class Spy:
    """Соединение, которое запоминает каждый запрос к hl_fills."""

    def __init__(self, con):
        self.con, self.seen = con, []

    def execute(self, sql, params=()):
        if "hl_fills" in sql and "sqlite_master" not in sql and "PRAGMA" not in sql:
            self.seen.append((sql, tuple(params)))
        return self.con.execute(sql, params)


def hl_db():
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    rows = []
    for i in range(300):
        w = A if i % 3 == 0 else B
        # Каждая третья строка кошелька A — закрытие с прибылью.
        pnl = N if w == A and i % 9 == 0 else 0
        rows.append((i + 1, w, "BTC", "Close Long" if pnl else "Open Long", "A", 3 if pnl else 1,
                     "100", "1", pnl, 100 * N, 10, 1_700_000_000_000 + i))
    con.executemany(
        "INSERT INTO hl_fills (tid, wallet, coin, dir, side, dir_code, px, sz, closed_pnl_nanos,"
        " notional_nanos, leverage, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    return con


def plan(con, sql, params):
    return " | ".join(r[-1] for r in con.execute("EXPLAIN QUERY PLAN " + sql, params).fetchall())


class WalletIndexTest(unittest.TestCase):
    def assert_indexed(self, con, seen):
        self.assertTrue(seen)
        for sql, params in seen:
            p = plan(con, sql, params)
            self.assertNotIn("lower(", sql.lower())
            self.assertRegex(p, r"USING (COVERING )?INDEX idx_hl_fills_wallet", f"{sql}\n{p}")
            self.assertNotRegex(p, r"\bSCAN hl_fills\b(?! USING)", f"{sql}\n{p}")

    def test_perp_deals_use_the_wallet_index(self):
        con = hl_db()
        spy = Spy(con)
        deals = api._perp_deals(spy, A, 5)
        self.assertEqual(len(deals), 5)
        ts = [d["ts"] for d in deals]
        self.assertEqual(ts, sorted(ts, reverse=True))  # последние сначала
        self.assert_indexed(con, spy.seen)

    def test_wallet_list_marks_hyperliquid_by_index(self):
        cur = sqlite3.connect(":memory:")
        cur.row_factory = sqlite3.Row
        cur.executescript(
            "CREATE TABLE whale_addresses (id INTEGER PRIMARY KEY, address TEXT);"
            "CREATE TABLE user_whales (user_id TEXT, whale_id INTEGER, label TEXT, created_at INTEGER);")
        c = "0x" + "c" * 40
        for i, addr in enumerate((A, B.upper().replace("0X", "0x"), c), 1):
            cur.execute("INSERT INTO whale_addresses VALUES (?, ?)", (i, addr))
            cur.execute("INSERT INTO user_whales VALUES ('42', ?, '', ?)", (i, i))
        con = hl_db()
        spy = Spy(con)
        got = {w["addr"]: w["hlActive"] for w in api.load_wallets(cur, "42", spy)}
        # Адрес у человека могли записать в любом регистре — у бота он строчный.
        self.assertEqual(got, {A: True, B: True, c: False})
        self.assert_indexed(con, spy.seen)


if __name__ == "__main__":
    unittest.main()

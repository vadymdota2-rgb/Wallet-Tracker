"""«Кто держит биткоин» — свой блок из сканера бота (npm test).

Биржи — остатки их адресов, сверенные с цепочкой; фонды — запас по своим
кошелькам; киты — частные адреса от 100 BTC. Ни одного чужого списка.
"""
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модуль лежит в корне репозитория

SAT = 100_000_000
NOW = 1_792_100_000
DAY = NOW - NOW % 86400
SCHEMA = """
CREATE TABLE btc_labels (address TEXT PRIMARY KEY, ex TEXT NOT NULL, how TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE btc_ex_bal (address TEXT PRIMARY KEY, bal_sats INTEGER NOT NULL DEFAULT 0,
  bal_height INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE btc_ex_day (day INTEGER NOT NULL, ex TEXT NOT NULL, sats INTEGER NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (day, ex));
CREATE TABLE btc_etf_addr (address TEXT PRIMARY KEY, fund TEXT NOT NULL, how TEXT NOT NULL,
  at INTEGER NOT NULL DEFAULT 0, bal_sats INTEGER NOT NULL DEFAULT 0, bal_height INTEGER NOT NULL DEFAULT 0,
  bal_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE btc_etf_hold (day INTEGER NOT NULL, fund TEXT NOT NULL, sats INTEGER NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (day, fund));
CREATE TABLE btc_cust_vault (address TEXT PRIMARY KEY, fee_wallet TEXT, at INTEGER, height INTEGER, read INTEGER);
CREATE TABLE btc_addr (address TEXT PRIMARY KEY, txs INTEGER, bal_sats INTEGER, at INTEGER);
CREATE TABLE btc_moves (id INTEGER PRIMARY KEY AUTOINCREMENT, txid TEXT NOT NULL, height INTEGER NOT NULL,
  ts INTEGER NOT NULL, kind INTEGER NOT NULL, wallet TEXT NOT NULL, ex TEXT NOT NULL DEFAULT '',
  sats INTEGER NOT NULL, usd_nanos INTEGER NOT NULL DEFAULT 0, price_nanos INTEGER NOT NULL DEFAULT 0);
CREATE TABLE btc_blocks (height INTEGER PRIMARY KEY, hash TEXT NOT NULL, ts INTEGER NOT NULL,
  price_nanos INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL DEFAULT 0);
"""
WHALE = "bc1qwhale0000000000000000000000000000000"


class BtcHoldersTest(unittest.TestCase):
    def setUp(self):
        fd, self.db = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        con = sqlite3.connect(self.db)
        con.executescript(SCHEMA)
        con.executemany("INSERT INTO btc_labels VALUES(?,?,'seed',0)",
                        [("1bin", "Binance"), ("3bin", "Binance"), ("1okx", "OKX"), ("1new", "OKX")])
        con.executemany("INSERT INTO btc_ex_bal VALUES(?,?,0,?)", [
            ("1bin", 500 * SAT, NOW - 10), ("3bin", 300 * SAT, -1), ("1okx", 120 * SAT, NOW - 10),
            ("1new", 999 * SAT, 0),  # ещё не сверен — в резервы не идёт
        ])
        con.execute("INSERT INTO btc_ex_day VALUES(?, 'Binance', ?, 2)", (DAY - 8 * 86400, 750 * SAT))
        con.executemany("INSERT INTO btc_etf_addr(address, fund, how, bal_sats, bal_at) VALUES(?,?,?,?,?)", [
            ("bc1qa", "BITB", "seed", 37_000 * SAT, NOW - 50), ("bc1qg", "#3", "fee", 5 * SAT, NOW)])
        con.execute("INSERT INTO btc_etf_hold VALUES(?, 'BITB', ?, 1)", (DAY - 7 * 86400, 36_900 * SAT))
        con.execute("INSERT INTO btc_cust_vault VALUES('bc1qvault', '3fee', 0, 0, 1)")
        con.executemany("INSERT INTO btc_addr VALUES(?,?,?,?)", [
            (WHALE, 12, 400 * SAT, NOW - 3600),
            ("bc1qsvc", 5000, 900 * SAT, NOW),  # сервис — не кит
            ("bc1qvault", 3, 800 * SAT, NOW),  # хранилище хранителя — не кит
            ("1bin", 9, 500 * SAT, NOW),  # биржа — не кит
            ("bc1qold", 3, 700 * SAT, NOW - 40 * 86400),  # давно не видели
            ("bc1qsmall", 3, 50 * SAT, NOW),
        ])
        con.executemany("INSERT INTO btc_moves(txid, height, ts, kind, wallet, ex, sats, price_nanos) "
                        "VALUES(?,0,?,?,?,?,?,?)", [
                            ("t1", NOW - 30 * 86400, 1, WHALE, "Binance", 300 * SAT, 60_000 * 10**9),
                            ("t2", NOW - 2 * 86400, 1, WHALE, "OKX", 100 * SAT, 80_000 * 10**9),
                            ("t3", NOW - 86400, 2, WHALE, "OKX", 20 * SAT, 81_000 * 10**9)])
        con.execute("INSERT INTO btc_blocks VALUES(1, 'x', ?, ?, ?)", (NOW, 82_000 * 10**9, NOW))
        con.commit()
        con.close()

    def tearDown(self):
        os.unlink(self.db)

    def build(self):
        reply = {"coins": {"btc": {"funds": [{"t": "BITB", "n": "Bitwise Bitcoin ETF"}]}}}
        with mock.patch.object(api, "BTC_DB", self.db), mock.patch.object(api, "now", lambda: NOW), \
                mock.patch.object(api.etf, "peek", lambda: reply):
            return api._btc_holders_build()

    def test_groups_and_rows(self):
        r = self.build()
        rows = {x[4] or x[0]: x for x in r["top"]}
        self.assertEqual(set(rows), {"Binance", "OKX", "BITB", WHALE})
        # Биржа: сверенные и сметённые адреса; неделя — к снимку суток.
        self.assertEqual(rows["Binance"][1:2] + rows["Binance"][5:7], ["EXCHANGE", 800.0, 50.0])
        self.assertEqual(rows["OKX"][5:7], [120.0, 0.0])
        self.assertEqual(rows["BITB"][:2] + rows["BITB"][5:7], ["Bitwise Bitcoin ETF", "FUND", 37_000.0, 100.0])
        w = rows[WHALE]
        self.assertEqual(w[1], "WHALE")
        self.assertEqual(w[5:7], [400.0, 80.0])
        # Цена входа — средняя по выводам: (300×60k + 100×80k) / 400.
        self.assertEqual(w[7], 65_000 * 400)
        self.assertEqual([x[5] for x in r["top"]], sorted((x[5] for x in r["top"]), reverse=True))
        self.assertEqual(r["groups"][0][:3], ["FUND", 1, 37_000.0])
        self.assertEqual({g[0] for g in r["groups"]}, {"FUND", "EXCHANGE", "WHALE"})
        self.assertEqual([m[4] or m[0] for m in r["movers"]], ["BITB", WHALE, "Binance"])

    def test_no_db(self):
        with mock.patch.object(api, "BTC_DB", self.db + ".missing"):
            self.assertEqual(api._btc_holders_build(), {})

    def test_screen_hook(self):
        self.assertIs(api.etf._st.holders, api.btc_holders)


if __name__ == "__main__":
    unittest.main()

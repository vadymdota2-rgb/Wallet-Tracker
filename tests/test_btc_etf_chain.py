"""/api/etf/chain: потоки фондов по своей разметке сканера (npm test).

Таблицы пишет бот (WhaleScanner/btc_etf.cpp), API их только читает: запас
фонда — сумма остатков его кошельков, поток — по суткам UTC, плата фонду —
отдельной графой, а не оттоком инвесторов.
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

SCHEMA = """
CREATE TABLE btc_etf_addr (address TEXT PRIMARY KEY, fund TEXT NOT NULL, how TEXT NOT NULL,
  at INTEGER NOT NULL DEFAULT 0, bal_sats INTEGER NOT NULL DEFAULT 0, bal_height INTEGER NOT NULL DEFAULT 0,
  bal_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE btc_etf_flow (day INTEGER NOT NULL, fund TEXT NOT NULL, in_sats INTEGER NOT NULL DEFAULT 0,
  out_sats INTEGER NOT NULL DEFAULT 0, fee_sats INTEGER NOT NULL DEFAULT 0, in_n INTEGER NOT NULL DEFAULT 0,
  out_n INTEGER NOT NULL DEFAULT 0, fee_n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, fund));
CREATE TABLE btc_etf_hold (day INTEGER NOT NULL, fund TEXT NOT NULL, sats INTEGER NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (day, fund));
CREATE TABLE btc_blocks (height INTEGER PRIMARY KEY, hash TEXT NOT NULL, ts INTEGER NOT NULL);
"""
SAT = 100_000_000
NOW = 1_792_100_000
DAY = NOW - NOW % 86400


class BtcEtfChainTest(unittest.TestCase):
    def setUp(self):
        fd, self.db = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        con = sqlite3.connect(self.db)
        con.executescript(SCHEMA)
        con.executemany(
            "INSERT INTO btc_etf_addr(address, fund, how, bal_sats, bal_at) VALUES(?,?,?,?,?)",
            [("bc1qa", "BITB", "seed", 600 * SAT, NOW - 100), ("bc1qb", "BITB", "seed", 400 * SAT, NOW - 100),
             ("bc1qc", "BITB", "cospend", 5 * SAT, 0)],
        )
        con.executemany(
            "INSERT INTO btc_etf_flow(day, fund, in_sats, out_sats, fee_sats) VALUES(?,?,?,?,?)",
            [(DAY - 86400 * 70, "BITB", SAT, 0, 0),  # старше окна — не идёт
             (DAY - 86400, "BITB", 27 * SAT, 0, 6 * SAT), (DAY, "BITB", 0, 81 * SAT, 0)],
        )
        con.execute("INSERT INTO btc_etf_hold VALUES(?, 'BITB', ?, 3)", (DAY, 1005 * SAT))
        con.execute("INSERT INTO btc_blocks VALUES(971600, 'x', ?)", (NOW - 300,))
        con.commit()
        con.close()

    def tearDown(self):
        os.unlink(self.db)

    def build(self):
        with mock.patch.object(api, "BTC_DB", self.db), mock.patch.object(api, "now", lambda: NOW):
            return api._btc_etf_build()

    def test_fund(self):
        r = self.build()
        self.assertTrue(r["ok"])
        self.assertEqual(r["block"], {"h": 971600, "ts": NOW - 300})
        (f,) = r["funds"]
        self.assertEqual((f["t"], f["n"], f["seed"], f["checked"]), ("BITB", 3, 2, 2))
        self.assertAlmostEqual(f["hold"], 1005.0)
        # Окно — 60 суток: запись 70-дневной давности не попадает.
        self.assertEqual(f["days"], [[DAY - 86400, 27.0, 0.0, 6.0], [DAY, 0.0, 81.0, 0.0]])
        self.assertEqual(f["hist"], [[DAY, 1005.0]])

    def test_no_tables(self):
        con = sqlite3.connect(self.db)
        con.executescript("DROP TABLE btc_etf_addr; DROP TABLE btc_etf_flow;")
        con.close()
        self.assertEqual(self.build(), {"ok": False, "error": "no_data"})

    def test_no_db(self):
        with mock.patch.object(api, "BTC_DB", self.db + ".missing"):
            self.assertEqual(api._btc_etf_build(), {"ok": False, "error": "no_data"})

    def test_route(self):
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('if path in ("/etf/chain", "/api/etf/chain"):', src)


if __name__ == "__main__":
    unittest.main()

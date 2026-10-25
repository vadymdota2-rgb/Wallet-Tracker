"""Суммы в нано-долларах не переполняются (npm test).

25 октября окно «30 дней» крупных ордеров BTC не открывалось: SUM по
usd_nanos за месяц (десятки миллиардов долларов × 10⁹) больше предела
целого SQLite (9,2·10¹⁸), и запрос падал «integer overflow». Доллары
теперь складываются TOTAL — дробным, без предела. То же у потоков бирж BSC.
"""
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
from test_btc_stale import SCHEMA  # noqa: E402 — схема, как у бота

import whale_api as api  # noqa: E402
import wt_btc as btc  # noqa: E402

NOW = 1_792_800_000
SAT = 10**8
NANO = 10**9
# Каждое движение — $5 млрд: три уже больше предела целого SQLite.
BIG_USD = 5_000_000_000


class SumOverflowTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(lambda: [os.unlink(os.path.join(self.dir, f)) for f in os.listdir(self.dir)]
                        and os.rmdir(self.dir))

    def test_btc_month_of_big_orders_does_not_overflow(self):
        db = os.path.join(self.dir, "btc.db")
        con = sqlite3.connect(db)
        con.executescript(SCHEMA)
        con.execute("INSERT INTO btc_blocks(height, hash, ts, price_nanos, at) VALUES(1, 'h', ?, ?, ?)",
                    (NOW - 60, 80_000 * NANO, NOW))
        con.executemany(
            "INSERT INTO btc_moves(txid, height, ts, kind, wallet, ex, sats, usd_nanos, price_nanos) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            [(f"{i:064x}", 1, NOW - (i + 1) * 86400, 1, "bc1qwhale", "Binance", 62_500 * SAT,
              BIG_USD * NANO, 80_000 * NANO) for i in range(3)])
        con.commit()
        con.close()
        with mock.patch.object(btc, "BTC_DB", db), mock.patch.object(btc, "now", lambda: NOW):
            r = btc._btc_big_build("30d", "buy", 0.2)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["tot"]["buy"]["v"], 3 * BIG_USD)
        self.assertEqual(r["rows"][0]["v"], 3 * BIG_USD)
        self.assertEqual(r["byEx"][0]["v"], 3 * BIG_USD)
        self.assertEqual(r["rows"][0]["px"], 80_000.0)

    def test_bsc_exchange_flow_month_does_not_overflow(self):
        db = os.path.join(self.dir, "bsc_ex.db")
        con = sqlite3.connect(db)
        con.execute("CREATE TABLE bsc_ex_flow (ts INTEGER NOT NULL, ex TEXT NOT NULL, token TEXT NOT NULL, "
                    "in_usd INTEGER NOT NULL DEFAULT 0, out_usd INTEGER NOT NULL DEFAULT 0, "
                    "in_n INTEGER NOT NULL DEFAULT 0, out_n INTEGER NOT NULL DEFAULT 0, "
                    "in_qty REAL NOT NULL DEFAULT 0, out_qty REAL NOT NULL DEFAULT 0, PRIMARY KEY (ts, ex, token))")
        usdt = "0x55d398326f99059ff775485246999027b3197955"
        con.executemany("INSERT INTO bsc_ex_flow VALUES(?,?,?,?,?,?,?,?,?)",
                        [(NOW - (i + 1) * 86400, "Binance", usdt, BIG_USD * NANO, 0, 1, 0, 1.0, 0.0)
                         for i in range(3)])
        con.commit()
        con.close()
        with mock.patch.object(api, "BSCX_DB", db), mock.patch.object(api, "DB", db + ".none"), \
                mock.patch.object(api, "now", lambda: NOW):
            r = api._bscx_flow_build()
        self.assertTrue(r["ok"], r)
        w = r["wins"]["720"]
        self.assertEqual((w["in"], w["net"]), (3.0 * BIG_USD, -3.0 * BIG_USD))
        self.assertEqual(w["coins"][0]["sym"], "USDT")
        self.assertEqual(w["tr"][-1], -3.0 * BIG_USD)


if __name__ == "__main__":
    unittest.main()

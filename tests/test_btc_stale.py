"""BTC-сканер стоит — экран говорит об этом прямо (npm test).

23–24 октября сканер бота полтора дня не записывал блоки (застрявшая
транзакция btc.db), а экран показывал нули и «пока ничего, собираем» — как
спокойный рынок. Теперь и потоки бирж, и крупные ордера отдают время
последнего записанного блока (at), и приложение пишет «сканер не записывал
новых блоков N ч».
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

# Схема — как у бота (WhaleScanner/btc_chain.cpp, openDb).
SCHEMA = """
CREATE TABLE btc_labels (address TEXT PRIMARY KEY, ex TEXT NOT NULL, how TEXT NOT NULL, at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE btc_moves (id INTEGER PRIMARY KEY AUTOINCREMENT, txid TEXT NOT NULL, height INTEGER NOT NULL,
  ts INTEGER NOT NULL, kind INTEGER NOT NULL, wallet TEXT NOT NULL, ex TEXT NOT NULL DEFAULT '',
  sats INTEGER NOT NULL, usd_nanos INTEGER NOT NULL DEFAULT 0, price_nanos INTEGER NOT NULL DEFAULT 0,
  UNIQUE(txid, wallet, kind));
CREATE TABLE btc_flow (ts INTEGER NOT NULL, ex TEXT NOT NULL, in_sats INTEGER NOT NULL DEFAULT 0,
  out_sats INTEGER NOT NULL DEFAULT 0, in_n INTEGER NOT NULL DEFAULT 0, out_n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ts, ex));
CREATE TABLE btc_watch (address TEXT PRIMARY KEY, src TEXT NOT NULL DEFAULT 'import', at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE btc_addr (address TEXT PRIMARY KEY, txs INTEGER NOT NULL DEFAULT 0, bal_sats INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE btc_blocks (height INTEGER PRIMARY KEY, hash TEXT NOT NULL, ts INTEGER NOT NULL,
  txs INTEGER NOT NULL DEFAULT 0, moves INTEGER NOT NULL DEFAULT 0, learned INTEGER NOT NULL DEFAULT 0,
  price_nanos INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL DEFAULT 0, flow TEXT);
"""
NOW = 1_792_800_000


class BtcStaleTest(unittest.TestCase):
    def setUp(self):
        fd, self.db = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        con = sqlite3.connect(self.db)
        con.executescript(SCHEMA)
        # Последний записанный блок — 36 часов назад, движений за сутки нет.
        last = NOW - 36 * 3600
        con.executemany("INSERT INTO btc_blocks(height, hash, ts, price_nanos, at) VALUES(?,?,?,?,?)",
                        [(972710, "a", last - 600, 81_000 * 10**9, last), (972711, "b", last, 81_000 * 10**9, last)])
        con.execute("INSERT INTO btc_flow VALUES(?, 'Binance', 100000000, 0, 1, 0)", (last,))
        con.commit()
        con.close()
        for p in (mock.patch.object(api, "BTC_DB", self.db), mock.patch.object(api, "now", lambda: NOW)):
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        os.unlink(self.db)

    def test_big_orders_and_flows_tell_when_the_last_block_was(self):
        big = api._btc_big_build("24h", "sell", 0.2)
        self.assertTrue(big["ok"])
        self.assertEqual(big["rows"], [])
        self.assertEqual(big["at"], NOW - 36 * 3600)
        flow = api._btc_flow_build()
        self.assertEqual(flow["at"], NOW - 36 * 3600)
        self.assertEqual(flow["wins"]["24"]["in"], 0)

    def test_empty_base_is_zero_not_a_crash(self):
        con = sqlite3.connect(self.db)
        con.execute("DELETE FROM btc_blocks")
        con.commit()
        con.close()
        self.assertEqual(api._btc_big_build("24h", "buy", 0.2)["at"], 0)

    def test_app_shows_the_stale_note_on_both_cards(self):
        with open(os.path.join(ROOT, "src/screens/BtcViews.tsx"), encoding="utf-8") as f:
            src = f.read()
        self.assertEqual(src.count("<Stale at={data.at} />"), 2)
        self.assertIn("const BTC_STALE_SEC = 3 * 3600;", src)
        self.assertIn('t(lang, "btc_stale", { n: num(h) })', src)


if __name__ == "__main__":
    unittest.main()

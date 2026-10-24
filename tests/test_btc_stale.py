"""BTC: потоки бирж и крупные ордера отдают время последнего записанного
блока (at) — видно, когда сканер стоит (npm test).

23–24 октября сканер бота полтора дня не записывал блоки (застрявшая
транзакция btc.db, исправлено в WhaleScanner).
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
import wt_btc as btc  # noqa: E402 — биткоин-часть сервера

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
        # Время — и модулю, и дайджесту whale_api (_dg_btc).
        for p in (mock.patch.object(btc, "BTC_DB", self.db), mock.patch.object(btc, "now", lambda: NOW),
                  mock.patch.object(api, "now", lambda: NOW)):
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        os.unlink(self.db)

    def test_big_orders_and_flows_tell_when_the_last_block_was(self):
        big = btc._btc_big_build("24h", "sell", 0.2)
        self.assertTrue(big["ok"])
        self.assertEqual(big["rows"], [])
        self.assertEqual(big["at"], NOW - 36 * 3600)
        flow = btc._btc_flow_build()
        self.assertEqual(flow["at"], NOW - 36 * 3600)
        self.assertEqual(flow["wins"]["24"]["in"], 0)

    def test_empty_base_is_zero_not_a_crash(self):
        con = sqlite3.connect(self.db)
        con.execute("DELETE FROM btc_blocks")
        con.commit()
        con.close()
        self.assertEqual(btc._btc_big_build("24h", "buy", 0.2)["at"], 0)

    def test_price_age_is_the_block_time_not_the_write_time(self):
        # Догоняя простой, сканер пишет вчерашний блок сейчас (at = NOW) —
        # его цена вчерашняя, нынешняя стоимость запасов по ней неверна.
        con = sqlite3.connect(self.db)
        con.execute("UPDATE btc_blocks SET at = ?", (NOW,))
        con.commit()
        con.close()
        with mock.patch.object(btc, "get_json", return_value={"data": {"amount": "95000.5"}}) as g:
            c = btc._btc_open()
            try:
                self.assertEqual(btc._btc_price(c), 95000.5)
            finally:
                c.close()
        g.assert_called_once()
        # Свежий блок — его цена, без запроса наружу.
        con = sqlite3.connect(self.db)
        con.execute("UPDATE btc_blocks SET ts = ? WHERE height = 972711", (NOW - 600,))
        con.commit()
        con.close()
        with mock.patch.object(btc, "get_json") as g:
            c = btc._btc_open()
            try:
                self.assertEqual(btc._btc_price(c), 81_000.0)
            finally:
                c.close()
        g.assert_not_called()

    def test_exchange_filter_takes_only_names_from_the_scanner_labels(self):
        con = sqlite3.connect(self.db)
        con.execute("INSERT INTO btc_labels VALUES('34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo', 'Binance', 'seed', 0)")
        con.commit()
        con.close()
        btc._BTC.clear()
        self.addCleanup(btc._BTC.clear)
        seen = []
        with mock.patch.object(btc, "cached_bg", lambda store, key, ttl, build: seen.append(key) or {"ok": True}):
            btc.btc_big("24h", "buy", 1, "Binance")
            btc.btc_big("24h", "buy", 1, "x' OR 1=1 --")
            btc.btc_big("24h", "buy", 1, "Нет такой")
        self.assertEqual([k[-1] for k in seen], ["Binance", "", ""])

    def test_digest_has_no_bitcoin_section_while_the_scanner_stands(self):
        # Последний блок — 36 часов назад: «0 BTC за сутки» в канал не идёт.
        stale = btc._btc_flow_build()
        with mock.patch.object(api, "btc_flow", return_value=stale), \
                mock.patch.object(api, "btc_big", side_effect=AssertionError("не нужен")):
            self.assertEqual(api._dg_btc(), {})
        # Сканер живой — раздел есть, с суточным итогом.
        con = sqlite3.connect(self.db)
        con.execute("UPDATE btc_blocks SET ts = ? WHERE height = 972711", (NOW - 600,))
        con.execute("INSERT INTO btc_flow VALUES(?, 'OKX', 0, 300000000, 0, 2)", (NOW - 600,))
        con.commit()
        con.close()
        live = btc._btc_flow_build()
        with mock.patch.object(api, "btc_flow", return_value=live), \
                mock.patch.object(api, "btc_big", return_value={"rows": []}):
            got = api._dg_btc()
        self.assertEqual(got["out"], 3.0)
        self.assertEqual(got["buy"], [])


if __name__ == "__main__":
    unittest.main()

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

    def test_extra_tags_etf_wallets(self):
        con = sqlite3.connect(self.db)
        con.execute("INSERT INTO btc_etf_addr(address, fund, how) VALUES('bc1qgroup', '#7', 'fee')")
        con.commit()
        con.close()
        ro = api.open_db(self.db)
        try:
            ex = api._btc_extra(ro, ["bc1qa", "bc1qc", "bc1qgroup", "bc1qnone"])
        finally:
            ro.close()
        # Кошельки фонда подписаны тикером; группа без имени и чужой адрес — нет.
        self.assertEqual(ex["bc1qa"].get("etf"), "BITB")
        self.assertEqual(ex["bc1qc"].get("etf"), "BITB")
        self.assertNotIn("etf", ex["bc1qgroup"])
        self.assertNotIn("etf", ex["bc1qnone"])

    def test_custody_without_tables(self):
        with mock.patch.object(api, "BTC_DB", self.db), mock.patch.object(api, "now", lambda: NOW):
            self.assertEqual(api._btc_custody_build(), {"ok": False, "error": "no_data"})

    def test_custody_build(self):
        con = sqlite3.connect(self.db)
        con.executescript(
            "CREATE TABLE btc_cust_vault (address TEXT PRIMARY KEY, fee_wallet TEXT, at INTEGER, height INTEGER,"
            " read INTEGER);"
            "CREATE TABLE btc_cust_xfer (txid TEXT, n INTEGER, height INTEGER, ts INTEGER, src TEXT, dst TEXT,"
            " sats INTEGER, sv INTEGER, dv INTEGER, PRIMARY KEY (txid, n));")
        q = 542_593_761
        rows = []
        for i, k in enumerate((7, 15, 3, 11, 5, 9)):
            day = DAY - 86400 * (i // 2)
            rows.append((f"t{i}", 0, 0, day, "3APx", "bc1qa", k * q, 0, 1))
        con.executemany("INSERT INTO btc_cust_xfer VALUES(?,?,?,?,?,?,?,?,?)", rows)
        con.execute("INSERT INTO btc_cust_vault VALUES('bc1qa', '3fee', 0, 0, 1)")
        con.commit()
        con.close()
        with mock.patch.object(api, "BTC_DB", self.db), mock.patch.object(api, "now", lambda: NOW):
            r = api._btc_custody_build()
        self.assertTrue(r["ok"])
        self.assertEqual((r["vaults"], r["xfers"]), (1, 6))
        # bc1qa — опубликованный кошелёк BITB (setUp), значит фонд назван.
        self.assertEqual([f["t"] for f in r["funds"]], ["BITB"])

    def make_custody(self, vault: str = "bc1qnew"):
        """Хранилище без имени, в которое шесть дней шли корзины 5,42593761 BTC."""
        con = sqlite3.connect(self.db)
        con.executescript(
            "CREATE TABLE btc_cust_vault (address TEXT PRIMARY KEY, fee_wallet TEXT, at INTEGER, height INTEGER,"
            " read INTEGER);"
            "CREATE TABLE btc_cust_xfer (txid TEXT, n INTEGER, height INTEGER, ts INTEGER, src TEXT, dst TEXT,"
            " sats INTEGER, sv INTEGER, dv INTEGER, PRIMARY KEY (txid, n));")
        q = 542_593_761
        rows = []
        # NOW — четверг: шесть рабочих дней (ср…пт и вт…чт), у каждого торговый
        # день — вчера. Шесть дней — столько нужно, чтобы снять имя.
        for i, k in enumerate((7, 15, 3, 11, 5, 9, 4, 13, 6, 17, 8, 19)):
            rows.append((f"t{i}", 0, 0, DAY - 86400 * (8, 7, 6, 2, 1, 0)[i // 2], "3APx", vault, k * q, 0, 1))
        con.executemany("INSERT INTO btc_cust_xfer VALUES(?,?,?,?,?,?,?,?,?)", rows)
        con.execute("INSERT INTO btc_cust_vault VALUES(?, '3fee', ?, 0, 0)", (vault, DAY - 86400 * 20))
        con.commit()
        con.close()
        return rows

    def etf_reply(self, rows, ticker: str = "IBIT", scale: float = 1.0):
        """Ответ /api/etf: те же потоки фонда днём раньше (T+1), $ тыс. по цене."""
        px = 80_000.0
        by_day: dict[int, float] = {}
        for r in rows:
            by_day[r[3] // 86400 - 1] = by_day.get(r[3] // 86400 - 1, 0) + r[6] / 1e8 * scale
        days = [[d * 86400, 0, 0, px, [round(v * px / 1000)]] for d, v in sorted(by_day.items())]
        return {"ok": True, "coins": {"btc": {"funds": [{"t": ticker, "fee": None}], "days": days}}}

    def custody(self, reply):
        with mock.patch.object(api, "BTC_DB", self.db), mock.patch.object(api, "now", lambda: NOW + 3600), \
                mock.patch.object(api, "etf_data", lambda: reply):
            return api._btc_custody_build()

    def test_custody_learns_name_by_flows(self):
        rows = self.make_custody()
        r = self.custody(self.etf_reply(rows))
        self.assertEqual([f["t"] for f in r["funds"]], ["IBIT"])
        self.assertNotIn("_vaults", r["funds"][0])
        ro = api.open_db(self.db)
        try:
            self.assertEqual(ro.execute("SELECT fund FROM btc_etf_learned WHERE address='bc1qnew'").fetchone()[0],
                             "IBIT")
            # Имя держится само и подписывает кошелёк в рейтинге.
            self.assertEqual(api._btc_extra(ro, ["bc1qnew"])["bc1qnew"].get("etf"), "IBIT")
        finally:
            ro.close()
        r = self.custody({"ok": False})
        self.assertEqual([f["t"] for f in r["funds"]], ["IBIT"])

    def test_custody_unlearns_when_flows_diverge(self):
        rows = self.make_custody()
        self.custody(self.etf_reply(rows))
        # Фонд стал отчитываться втрое большими потоками — это не он.
        r = self.custody(self.etf_reply(rows, scale=3.0))
        ro = api.open_db(self.db)
        try:
            self.assertEqual(ro.execute("SELECT COUNT(*) FROM btc_etf_learned").fetchone()[0], 0)
        finally:
            ro.close()
        self.assertTrue(r["ok"])

    def test_route(self):
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('if path in ("/etf/chain", "/api/etf/chain"):', src)
        self.assertIn('{**btc_etf_chain(), "custody": btc_custody()}', src)


if __name__ == "__main__":
    unittest.main()

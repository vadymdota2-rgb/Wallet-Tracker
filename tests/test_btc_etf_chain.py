"""Разметка кошельков фондов (npm test): метки в рейтинге, корзины
хранителя и сверка с «Институциональными потоками».

Таблицы пишет бот (WhaleScanner/btc_etf.cpp), API их читает; корзины
с размеченным кошельком уходят в очередь разметки бота, а сверка только
проверяет разметку (btc_etf_check) и ничего в ней не меняет.
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
                mock.patch.object(api.etf, "peek", lambda: reply):
            return api._btc_custody_build()

    def test_flows_never_name_a_basket(self):
        # Потоки фонда совпали с безымянной корзиной — имени она не получает:
        # имена даёт только своя разметка.
        rows = self.make_custody()
        r = self.custody(self.etf_reply(rows))
        self.assertTrue(r["funds"][0]["t"].startswith("#"))
        self.assertNotIn("_vaults", r["funds"][0])
        ro = api.open_db(self.db)
        try:
            self.assertIsNone(ro.execute("SELECT 1 FROM sqlite_master WHERE name = 'btc_etf_learned'").fetchone())
            self.assertNotIn("etf", api._btc_extra(ro, ["bc1qnew"])["bc1qnew"])
        finally:
            ro.close()

    def flows(self, scale: float):
        """BITB: десять торговых дней; в цепочке — те же монеты × scale на
        следующий рабочий день. Ответ /api/etf — потоки торговых дней."""
        px = 80_000.0
        settle = api.etfchain.settle_day
        today = NOW // 86400
        trade = [d for d in range(today - 20, today - 2) if (d + 3) % 7 < 5][-10:]
        con = sqlite3.connect(self.db)
        con.execute("DELETE FROM btc_etf_flow")
        for i, d in enumerate(trade):
            v = (40 + 13 * i) * (1 if i % 3 else -1)
            con.execute("INSERT INTO btc_etf_flow(day, fund, in_sats, out_sats) VALUES(?, 'BITB', ?, ?)",
                        (settle(d) * 86400, max(v, 0) * scale * SAT, max(-v, 0) * scale * SAT))
        con.commit()
        con.close()
        days = [[d * 86400, 0, 0, px, [round((40 + 13 * i) * (1 if i % 3 else -1) * px / 1000)]]
                for i, d in enumerate(trade)]
        return {"ok": True, "coins": {"btc": {"funds": [{"t": "BITB", "fee": 0.2}], "days": days}}}

    def check(self, reply):
        con = sqlite3.connect(self.db)
        try:
            with mock.patch.object(api, "now", lambda: NOW), mock.patch.object(api.etf, "peek", lambda: reply):
                n = api._btc_check(con)
            con.commit()
            rows = con.execute("SELECT fund, v, days, share FROM btc_etf_check").fetchall() if n else []
        finally:
            con.close()
        return n, rows

    def test_check_labels_against_institutional_flows(self):
        n, rows = self.check(self.flows(1.0))
        self.assertEqual(n, 1)
        self.assertEqual(rows[0][:3], ("BITB", "ok", 9))  # первые сутки разметки — неполные, без них
        _, rows = self.check(self.flows(0.4))  # размечена часть кошельков
        self.assertEqual(rows[0][1], "part")
        self.assertAlmostEqual(rows[0][3], 0.4, delta=0.02)
        # Разметка при этом не меняется.
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM btc_etf_addr").fetchone()[0], 3)
        con.close()

    def test_check_without_flows_does_nothing(self):
        self.assertEqual(self.check({"ok": False}), (0, []))
        self.assertEqual(self.check({}), (0, []))

    def test_basket_with_labeled_wallet_spreads_to_its_vaults(self):
        # Корзина «IBIT» (в ней размеченный кошелёк) — её хранилища в
        # очередь разметки бота; уже размеченные и безымянные — нет.
        con = sqlite3.connect(self.db)
        con.execute("INSERT INTO btc_etf_addr(address, fund, how) VALUES('bc1qlab', 'IBIT', 'list')")
        con.commit()
        groups = [{"t": "IBIT", "_vaults": ["bc1qlab", "bc1qv1", "bc1qv2", "bc1qa"]},
                  {"t": "#7c1f", "_vaults": ["bc1qx"]}]
        with mock.patch.object(api, "now", lambda: NOW):
            self.assertEqual(api._btc_spread(con, groups), 2)
            con.commit()
            self.assertEqual(api._btc_spread(con, groups), 0)  # уже в очереди
        got = sorted(con.execute("SELECT address, fund, at FROM btc_etf_import").fetchall())
        con.close()
        self.assertEqual(got, [("bc1qv1", "IBIT", NOW), ("bc1qv2", "IBIT", NOW)])

    def test_no_dead_route(self):
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("/api/etf/chain", src)
        self.assertNotIn("btc_etf_learned(address, fund, at) VALUES", src)


if __name__ == "__main__":
    unittest.main()

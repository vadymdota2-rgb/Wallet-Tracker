"""«Кто держит биткоин»: государства по своему сканеру бота (npm test).

Адреса — те, что государство раскрыло само (бот, btc_gov.cpp), остатки —
сверкой с цепочкой. Пока сверены не все адреса государства, его запас
неполон и не показывается. Фонды к ним добавляет экран ETF (wt_etf).
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
CREATE TABLE btc_gov_addr (address TEXT PRIMARY KEY, gov TEXT NOT NULL, how TEXT NOT NULL, at INTEGER NOT NULL DEFAULT 0,
  bal_sats INTEGER NOT NULL DEFAULT 0, bal_height INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE btc_gov_day (day INTEGER NOT NULL, gov TEXT NOT NULL, sats INTEGER NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (day, gov));
"""


class BtcHoldersTest(unittest.TestCase):
    def setUp(self):
        fd, self.db = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        con = sqlite3.connect(self.db)
        con.executescript(SCHEMA)
        con.executemany("INSERT INTO btc_gov_addr(address, gov, how, bal_sats, checked_at) VALUES(?,?,?,?,?)", [
            ("bc1qus", "US", "seed", 69_370 * SAT, NOW - 60),
            ("3sv1", "SV", "seed", 500 * SAT, NOW - 60), ("3sv2", "SV", "official", 7_306 * SAT, NOW - 60),
            ("bc1qxx", "XX", "seed", 10 * SAT, 0),  # ещё не сверен — государства пока нет
        ])
        con.execute("INSERT INTO btc_gov_day VALUES(?, 'SV', ?, 2)", (DAY - 8 * 86400, 7_800 * SAT))
        con.commit()
        con.close()

    def tearDown(self):
        os.unlink(self.db)

    def build(self):
        with mock.patch.object(api, "BTC_DB", self.db), mock.patch.object(api, "now", lambda: NOW):
            return api._btc_holders_build()

    def test_governments(self):
        rows = {r[4]: r for r in self.build()["top"]}
        self.assertEqual(set(rows), {"US", "SV"})
        self.assertEqual(rows["US"], ["United States", "GOVERNMENT", "", "🇺🇸", "US", 69_370.0, 0.0, 0])
        # Неделя — к суточному снимку: было 7 800, стало 7 806.
        self.assertEqual(rows["SV"], ["El Salvador", "GOVERNMENT", "", "🇸🇻", "SV", 7_806.0, 6.0, 0])

    def test_no_tables_or_db(self):
        con = sqlite3.connect(self.db)
        con.executescript("DROP TABLE btc_gov_addr;")
        con.close()
        self.assertEqual(self.build(), {})
        with mock.patch.object(api, "BTC_DB", self.db + ".missing"):
            self.assertEqual(api._btc_holders_build(), {})

    def test_screen_hook(self):
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            self.assertIn("etf.set_holders(btc_holders)", f.read())


if __name__ == "__main__":
    unittest.main()

"""«Кто держит биткоин»: государства (npm test).

База — снимок CoinGecko, взятый один раз (data/gov_base.json); к ней —
движения адресов, которые знает наш сканер (бот, btc_gov.cpp), с первой
встречи с базой. Где наш список адресов полный (Сальвадор), запас — точно по нему.
Пока сверены не все адреса государства, наших цифр по нему нет.
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
        fd, self.main = tempfile.mkstemp(suffix=".db")
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
        os.unlink(self.main)

    def build(self, cg=None):
        govs = [
            {"name": "United States", "country": "US", "btc": 329_693.0},
            {"name": "China", "country": "CN", "btc": 190_000.0},
            {"name": "El Salvador", "country": "SV", "btc": 7_474.37},
            {"name": "Texas", "country": "US", "btc": 57.47},
            {"name": "Germany", "country": "DE", "btc": 0.0},
            "мусор",
        ] if cg is None else cg
        with mock.patch.object(api, "BTC_DB", self.db), mock.patch.object(api, "DB", self.main), \
                mock.patch.object(api, "now", lambda: NOW), \
                mock.patch.object(api, "_gov_list", lambda: govs or None):
            return api._btc_holders_build()

    def setBal(self, addr, btc):
        con = sqlite3.connect(self.db)
        con.execute("UPDATE btc_gov_addr SET bal_sats = ? WHERE address = ?", (round(btc * SAT), addr))
        con.commit()
        con.close()

    def test_base_plus_own_moves(self):
        rows = {(r[0]): r for r in self.build()["top"]}
        self.assertEqual(set(rows), {"United States", "China", "El Salvador", "Texas"})
        # Первый раз: база снимка как есть, наш остаток — точка отсчёта.
        self.assertEqual(rows["United States"], ["United States", "GOVERNMENT", "", "🇺🇸", "US", 329_693.0, 0.0, 0])
        self.assertEqual(rows["China"][4:6], ["CN", 190_000.0])
        # Сальвадор — наш список полный: точно по нему (7 806), неделя — к снимку.
        self.assertEqual(rows["El Salvador"][4:7], ["SV", 7_806.0, 6.0])
        # Штат — не страна: без кода (приложение не переведёт его как «США»), флаг страны.
        self.assertEqual(rows["Texas"][3:6], ["🇺🇸", "", 57.47])
        # Адрес США отдал 70 BTC — запас США меньше на столько же.
        self.setBal("bc1qus", 69_300)
        us = next(r for r in self.build()["top"] if r[4] == "US")
        self.assertEqual(us[5], 329_623.0)
        # Сменили снимок-базу — отсчёт заново.
        us = next(r for r in self.build([{"name": "United States", "country": "US", "btc": 330_000.0}])["top"])
        self.assertEqual(us[5], 330_000.0)

    def test_no_base_file(self):
        # Снимка нет — только то, что видим сами.
        rows = {r[4]: r[5] for r in self.build([])["top"]}
        self.assertEqual(rows, {"US": 69_370.0, "SV": 7_806.0})
        with mock.patch.object(api, "BTC_GOV_FILE", self.db + ".missing"):
            self.assertIsNone(api._gov_list())

    def test_base_file_is_in_repo(self):
        govs = api._gov_list()
        self.assertTrue(govs)
        self.assertTrue(all({"name", "country", "btc"} <= set(g) for g in govs))

    def test_no_bot_tables(self):
        con = sqlite3.connect(self.db)
        con.executescript("DROP TABLE btc_gov_addr;")
        con.close()
        self.assertEqual(self.build([]), {})
        rows = {r[4]: r[5] for r in self.build()["top"]}
        self.assertEqual(rows["US"], 329_693.0)

    def test_screen_hook(self):
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            self.assertIn("etf.set_holders(btc_holders)", f.read())


if __name__ == "__main__":
    unittest.main()

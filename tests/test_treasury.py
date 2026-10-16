"""Биткоины компаний по отчётам в SEC (wt_treasury.py): npm test.

Сеть подменена (_fetch); подпись запроса — переменная окружения WT_SEC_UA.
"""
import io
import json
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_treasury as tr  # noqa: E402 — модуль лежит в корне репозитория

UA = "WalletTracker admin@example.com"
Q1, Q2 = 1_774_915_200, 1_782_777_600  # 2026-03-31, 2026-06-30 (UTC)


def row(end, val, form="10-Q", filed="2026-08-01"):
    return {"end": end, "val": val, "form": form, "filed": filed}


class TreasuryTest(unittest.TestCase):
    def setUp(self):
        tr._st = tr._State()

    def test_latest_report_in_bitcoin_units(self):
        c = {"units": {"Bitcoin": [row("2025-12-31", 672_500, "10-K"), row("2026-03-31", 762_099),
                                   row("2026-06-30", 846_000)],
                       "USD": [row("2026-06-30", 63_939_306_000)]}}
        self.assertEqual(tr.holding(c), (846_000.0, Q2))

    def test_scale_typo_is_skipped(self):
        # Отчёт, который скачет больше чем в JUMP раз, не берём — остаётся прошлый.
        c = {"units": {"Bitcoin": [row("2025-12-31", 1648), row("2026-03-31", 1641), row("2026-06-30", 1_719_000)]}}
        self.assertEqual(tr.holding(c), (1641.0, Q1))
        # Прошлое — случайная мелочь (меньше JUMP_FLOOR): скачок от неё не ошибка.
        c = {"units": {"bitcoin": [row("2026-01-31", 1, "10-K"), row("2026-03-31", 4709)]}}
        self.assertEqual(tr.holding(c), (4709.0, Q1))

    def test_only_annual_and_quarterly_reports_and_known_units(self):
        c = {"units": {"pure": [row("2026-06-30", 999)], "item": [row("2026-03-31", 15_679),
                                                                  row("2026-06-30", 11_380, "S-1")]}}
        self.assertEqual(tr.holding(c), (15_679.0, Q1))

    def test_amendment_filed_later_wins(self):
        c = {"units": {"BTC": [row("2026-06-30", 100, "10-Q", "2026-08-01"),
                               row("2026-06-30", 120, "10-Q/A", "2026-09-01")]}}
        self.assertEqual(tr.holding(c), (120.0, Q2))

    def test_junk(self):
        for c in (None, [], {"units": "x"}, {"units": {"Bitcoin": "x"}},
                  {"units": {"Bitcoin": [None, row("x", 5), row("2026-06-30", True), row("2026-06-30", -1),
                                         row("2026-06-30", "5"), row("2026-06-30", 5e9)]}}):
            self.assertIsNone(tr.holding(c))

    def test_companies_need_contact_and_are_cached(self):
        urls = []

        def fetch(url, timeout):
            urls.append(url)
            return json.dumps({"units": {"Bitcoin": [row("2026-06-30", 846_000)]}}).encode() if "1050446" in url else None

        with mock.patch.object(tr, "_fetch", fetch), mock.patch.object(tr, "PAUSE", 0), \
                mock.patch("sys.stderr", io.StringIO()):
            with mock.patch.dict(os.environ, {"WT_SEC_UA": ""}):
                self.assertEqual(tr.companies(), [])
            self.assertEqual(urls, [])
            with mock.patch.dict(os.environ, {"WT_SEC_UA": UA}):
                got = tr.companies()
                self.assertEqual(got, [["Strategy", "COMPANY", "US", "MSTR", 846_000.0, Q2]])
                self.assertEqual(len(urls), len(tr.COMPANIES))
                self.assertIn("/api/xbrl/companyconcept/CIK0001050446/us-gaap/CryptoAssetNumberOfUnits.json", urls[0])
                tr.companies()
                self.assertEqual(len(urls), len(tr.COMPANIES))

    def test_fetch_only_sec_https_with_contact(self):
        with mock.patch.dict(os.environ, {"WT_SEC_UA": UA}), mock.patch.object(tr._opener, "open") as op:
            for bad in ("http://data.sec.gov/x", "https://evil.com/x", "https://u:p@data.sec.gov/x"):
                self.assertIsNone(tr._fetch(bad, 5))
            op.assert_not_called()
        with mock.patch.dict(os.environ, {"WT_SEC_UA": "no contact"}), mock.patch.object(tr._opener, "open") as op:
            self.assertIsNone(tr._fetch("https://data.sec.gov/x", 5))
            op.assert_not_called()

    def test_hostile_json(self):
        self.assertIsNone(tr._parse(b'{"units": NaN}'))
        self.assertIsNone(tr._parse(b"[" * 100_000))


if __name__ == "__main__":
    unittest.main()

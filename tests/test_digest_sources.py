"""Дайджест: подпись источника данных рядом с цифрами (npm test).

Потоки ETF — открытый набор TFTC под лицензией CC BY 4.0: где дайджест
показывает их цифры (картинки альбома для канала и подпись к посту), там же
стоит подпись источника со ссылкой и лицензией. Снятые сигналы (премия
Coinbase — её условия запрещают показывать их данные) у старых выпусков не
показываются.
"""
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_digest_img as dgi  # noqa: E402 — модуль лежит в корне репозитория

DAY = 1_792_108_800
ETF = {"etf": [{"c": "btc", "day": DAY, "v": 5_060_000, "n": 61.6}],
       "top": [{"t": "IBIT", "v": 4_000_000}], "bot": []}


def item(**over):
    it = {"v": 2, "to": DAY + 86_400, "sig": [{"k": "etf", "d": 1, "v": 5_060_000}], "inst": ETF}
    it.update(over)
    return it


class DigestSourcesTest(unittest.TestCase):
    def test_caption_names_tftc_with_link_and_license(self):
        for lang in ("ru", "en", "ar"):
            cap = dgi.caption(item(), lang)
            self.assertIn(dgi.TFTC_BY, cap, lang)
            self.assertIn("tftc.io/bitcoin-etf-flows", cap)
            self.assertIn("CC BY 4.0", cap)
            self.assertLessEqual(len(cap), 1024)
        # Нет потоков ETF в выпуске — нет и подписи TFTC.
        self.assertNotIn("TFTC", dgi.caption(item(inst={}, sig=[]), "ru"))

    def test_long_caption_keeps_the_source(self):
        # Подпись к фото — до 1024 знаков: режутся выводы, а не подпись источника.
        many = [(f"вывод номер {i} " + "х" * 60, None) for i in range(40)]
        with mock.patch.object(dgi, "lines", lambda it, lang: many):
            cap = dgi.caption(item(), "ru")
        self.assertLessEqual(len(cap), 1024)
        self.assertIn(dgi.TFTC_BY, cap)
        self.assertTrue(cap.endswith(dgi.BOT_AT))

    def test_flows_page_shows_the_source_under_etf_rows(self):
        notes = []
        orig = dgi._Page.note

        def note(self, s):
            notes.append(s)
            return orig(self, s)

        with mock.patch.object(dgi._Page, "note", note):
            png = dgi._page_flows(item(), "ru", 3, 4)
        self.assertTrue(png)
        self.assertEqual(notes, [f"{dgi.tr('ru', 'dg_etf_by')} {dgi.TFTC_BY}"])

    def test_dropped_signals_of_old_issues_are_hidden(self):
        old = item(sig=[{"k": "cbp", "d": 1, "v": 0.1}, {"k": "etf", "d": 1, "v": 5e6}, {"k": "x", "d": -1, "v": 1}, "мусор"])
        self.assertEqual([s["k"] for s in dgi.sigs(old)], ["etf"])
        self.assertNotIn("cbp", dgi.SIG_KEY)
        self.assertEqual(dgi.verdict(old, "ru")[0], "up")


if __name__ == "__main__":
    unittest.main()

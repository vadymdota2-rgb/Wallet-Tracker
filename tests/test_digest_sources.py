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
            self.assertIn(dgi.TFTC_BY_POST, cap, lang)
            self.assertIn("https://www.tftc.io/bitcoin-etf-flows", cap)
            # CC BY 4.0, п. 3(a)(1)(C): название лицензии и её адрес.
            self.assertIn("CC BY 4.0", cap)
            self.assertIn("https://creativecommons.org/licenses/by/4.0/", cap)
            self.assertLessEqual(len(cap), 1024)
        # Нет потоков ETF в выпуске — нет и подписи TFTC.
        self.assertNotIn("TFTC", dgi.caption(item(inst={}, sig=[]), "ru"))

    def test_long_caption_keeps_the_source(self):
        # Подпись к фото — до 1024 знаков: режутся выводы, а не подпись источника.
        many = [(f"вывод номер {i} " + "х" * 60, None) for i in range(40)]
        with mock.patch.object(dgi, "lines", lambda it, lang: many):
            cap = dgi.caption(item(), "ru")
        self.assertLessEqual(len(cap), 1024)
        self.assertIn(dgi.TFTC_BY_POST, cap)
        self.assertTrue(cap.endswith(dgi.BOT_AT))

    def test_flows_page_shows_the_source_under_etf_rows(self):
        # Страница рисуется через _Page; здесь — запись её вызовов (рисовать
        # Pillow в CI нечем): под строками ETF — строка источника.
        calls = []
        subs = {}

        class Page:
            y = 0

            def __init__(self, *a):
                pass

            def section(self, title):
                calls.append(("section", title))
                return True

            def row(self, label, value="", color=None, sub="", arrow=None):
                calls.append(("row", label))
                subs[label] = sub
                return True

            def note(self, s):
                calls.append(("note", s))
                return True

            def png(self):
                return b"png"

        with mock.patch.object(dgi, "_Page", Page):
            self.assertEqual(dgi._page_flows(item(), "ru", 3, 4), b"png")
        note = ("note", f"{dgi.tr('ru', 'dg_etf_by')} {dgi.TFTC_BY}")
        self.assertIn(note, calls)
        self.assertEqual(calls[calls.index(note) - 1], ("row", dgi.tr("ru", "dg_etf_coin", c="BTC")))
        # Отчётный день подписан под строкой ETF: в выходные выпуски повторяют
        # пятничный поток, и без даты он читался бы как вчерашний.
        self.assertEqual(subs[dgi.tr("ru", "dg_etf_coin", c="BTC")], dgi.tr("ru", "dg_etf_day", d=dgi.date_word("ru", DAY)))
        self.assertIn("2026", subs[dgi.tr("ru", "dg_etf_coin", c="BTC")])

    @unittest.skipUnless(dgi.Image is not None, "нужен Pillow")
    def test_note_is_drawn(self):
        png = dgi._page_flows(item(), "ru", 3, 4)
        self.assertTrue(png and png.startswith(b"\x89PNG"))

    def test_dropped_signals_of_old_issues_are_hidden(self):
        old = item(sig=[{"k": "cbp", "d": 1, "v": 0.1}, {"k": "etf", "d": 1, "v": 5e6}, {"k": "x", "d": -1, "v": 1}, "мусор"])
        self.assertEqual([s["k"] for s in dgi.sigs(old)], ["etf"])
        self.assertNotIn("cbp", dgi.SIG_KEY)
        self.assertEqual(dgi.verdict(old, "ru")[0], "up")


if __name__ == "__main__":
    unittest.main()


class DigestEtfDayTest(unittest.TestCase):
    """Дайджест берёт поток ETF только свежего дня: набор TFTC не обновлялся
    дольше STALE_DAYS суток — раздела ETF в выпуске нет, а не старый день."""

    def inst(self, age_days):
        import whale_api as api
        import wt_etf as etf
        last = DAY - DAY % 86_400
        rep = {"ok": True, "coins": {"btc": {"funds": [{"t": "IBIT"}, {"t": "FBTC"}],
                                             "days": [[last, 5060, 61.6, 82_000, [4000, -1000]]]}}}
        with mock.patch.object(api, "etf_data", lambda: rep), mock.patch.object(api, "now", lambda: last + age_days * 86_400 + 3600):
            return api._dg_inst(), etf.STALE_DAYS

    def test_fresh_day_is_taken(self):
        got, _ = self.inst(1)
        self.assertEqual(got["etf"], [{"c": "btc", "day": DAY - DAY % 86_400, "v": 5_060_000, "n": 61.6}])
        self.assertEqual(got["top"], [{"t": "IBIT", "v": 4_000_000}])
        self.assertEqual(got["bot"], [{"t": "FBTC", "v": -1_000_000}])

    def test_long_weekend_is_still_fresh_but_a_stale_dataset_is_dropped(self):
        _, stale = self.inst(0)
        self.assertTrue(self.inst(stale)[0]["etf"])
        self.assertEqual(self.inst(stale + 1)[0], {"etf": []})

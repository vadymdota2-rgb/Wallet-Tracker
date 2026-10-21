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
import whale_api as api  # noqa: E402 — модули лежат в корне репозитория
import wt_digest_img as dgi  # noqa: E402
import wt_etf as etf  # noqa: E402

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


class DigestEtfDayTest(unittest.TestCase):
    """Дайджест берёт поток ETF только свежего дня: набор TFTC не обновлялся
    дольше STALE_DAYS суток — раздела ETF в выпуске нет, а не старый день."""

    def inst(self, age_days):
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


# Ответ wt_mcap.mcap_data: сейчас и вчера.
MC = {"ok": True, "btc": [58.1, 57.9], "eth": [11.0, 11.1], "alt": [41.9, 42.1], "alt_ns": 35.0,
      "cap": [2_900_000_000_000, 2_877_000_000_000], "usdt": 5.6, "hist": [], "by": "CoinMarketCap", "at": 0}


class DigestMarketTest(unittest.TestCase):
    """Капитализация и доминация в разделе «Рынок» — из кэша вкладки
    (wt_mcap.mcap_data): выпуск сам в CoinMarketCap не ходит."""

    def market(self, mc):
        with mock.patch.object(api, "fng_data", lambda: {}), mock.patch.object(api, "_dg_px", lambda p: None), \
                mock.patch.object(api, "dom_data", lambda: {}), mock.patch.object(api, "mcap_data", lambda: mc), \
                mock.patch.object(api.wt_mcap, "_fetch", side_effect=AssertionError("сеть")):
            return api._dg_market()

    def test_cap_and_dominance_come_from_the_tab_cache(self):
        got = self.market(MC)
        self.assertEqual(got["cap"], {"v": 2_900_000_000_000, "ch": 0.8})
        self.assertEqual(got["dom"], {"btc": 58.1, "d1": 0.2, "eth": 11.0})

    def test_no_data_or_no_yesterday_leaves_the_cell_out(self):
        self.assertEqual(self.market({"ok": False, "error": "no_key"}), {})
        part = self.market({**MC, "cap": [2_900_000_000_000, None], "btc": [58.1, None]})
        self.assertNotIn("cap", part)
        self.assertNotIn("dom", part)

    def test_channel_does_not_carry_coinmarketcap_numbers(self):
        # Данные CoinMarketCap — только внутри приложения (лицензия: в своём
        # продукте, не отдельной рассылкой): пост и картинки канала их не берут.
        it = {"v": 2, "to": DAY + 86_400, "sig": [], "mkt": {"btc": {"px": 82_016, "ch": 1.2}}}
        with_cmc = {**it, "mkt": {**it["mkt"], "cap": {"v": 2.9e12, "ch": 0.8}, "dom": {"btc": 58.1, "d1": 0.2, "eth": 11.0}}}
        for lang in ("en", "ru"):
            self.assertEqual(dgi.caption(with_cmc, lang), dgi.caption(it, lang))
        with open(os.path.join(ROOT, "wt_digest_img.py"), encoding="utf-8") as f:
            src = f.read()
        for k in ('"cap"', '"dom"', "'cap'", "'dom'"):
            self.assertNotIn(k, src)

    def test_app_names_coinmarketcap_next_to_the_cells(self):
        with open(os.path.join(ROOT, "src/screens/DigestMore.tsx"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("m.cap || m.dom ? <> <CmcBy lang={lang} /></> : null", src)


if __name__ == "__main__":
    unittest.main()

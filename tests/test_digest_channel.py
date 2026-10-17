"""Дайджест в Telegram-канал — только на английском (npm test).

Язык канала не настраивается: в коде он один — "en". Каждая строка словаря,
из которой собираются картинки альбома и подпись к посту, есть по-английски
(без подмены русским), и в готовой подписи нет ни одной кириллической буквы.
"""
import os
import re
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_digest_img as dgi  # noqa: E402 — модуль лежит в корне репозитория

CYR = re.compile("[Ѐ-ӿ]")
DAY = 1_792_108_800


def read(name: str) -> str:
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        return f.read()


def item() -> dict:
    """Выпуск со всеми разделами, какие бывают у канала."""
    return {
        "v": 2, "to": DAY + 86_400,
        "sig": [{"k": "fng", "d": 1, "v": 62}, {"k": "etf", "d": 1, "v": 5_060_000}, {"k": "btcx", "d": -1, "v": -1200},
                {"k": "whales", "d": 1, "v": 3e6}, {"k": "liq", "d": -1, "v": 61}, {"k": "oi", "d": 1, "v": 2.1},
                {"k": "fund", "d": 0, "v": 0.0001}, {"k": "pcr", "d": -1, "v": 1.2}],
        "mkt": {"fng": {"v": 62, "d1": 3, "d7": -5}, "btc": {"px": 82_016, "ch": 1.2}, "eth": {"px": 3_100, "ch": -0.4},
                "cap": {"v": 2.9e12, "ch": 0.8}, "dom": {"btc": 58.1, "d1": 0.2, "eth": 11.0}, "alt": {"v": 31, "d1": -2}},
        "inst": {"etf": [{"c": "btc", "day": DAY, "v": 5_060_000, "n": 61.6}],
                 "top": [{"t": "IBIT", "v": 4_000_000}], "bot": [{"t": "FBTC", "v": -1_000_000}]},
        "btc": {"in": 5000, "out": 6200, "net": -1200},
        "opt": {"btc": {"n": 4.2e9, "pcr": 1.2}},
        "cal": [{"k": "fomc", "t": DAY + 3 * 86_400}, {"k": "unl", "t": DAY + 86_400, "sym": "ARB"},
                {"k": "macro", "t": DAY + 2 * 86_400, "title": "CPI"}],
    }


class ChannelEnglishTest(unittest.TestCase):
    def test_language_is_fixed_to_english(self):
        api = read("whale_api.py")
        self.assertIn('DIGEST_CHANNEL_LANG = "en"', api)
        self.assertNotIn("WHALE_DIGEST_CHANNEL_LANG", api)
        # И подпись, и картинки — на этом языке.
        body = api[api.index("def digest_channel_post()"):]
        body = body[:body.index("\ndef ")]
        self.assertIn("dgi.caption(body, DIGEST_CHANNEL_LANG)", body)
        self.assertIn("dgi.render_album(body, DIGEST_CHANNEL_LANG)", body)
        self.assertEqual(len(re.findall(r"dgi\.\w+\(", body)), 2)

    def test_every_dictionary_line_of_the_channel_is_english(self):
        # Ключи, из которых строится выпуск: прямые tr(lang, "…"), сигналы,
        # зоны страха и жадности, события календаря.
        src = read("wt_digest_img.py")
        keys = set(re.findall(r'tr\(lang, "([a-z0-9_]+)"', src))
        keys |= set(dgi.SIG_KEY.values()) | {k for _, k in dgi.FNG_ZONES} | {k for _, k in dgi.MACRO}
        keys |= {f"cal_{k}" for k in ("opt", "unl", "earn")}
        self.assertGreater(len(keys), 40)
        dgi.tr("en", "dg_img_title")  # словарь читается при первом обращении
        for k in sorted(keys):
            en = dgi._I18N.get(k, {}).get("en")
            self.assertTrue(en, f"нет английской строки: {k}")
            self.assertIsNone(CYR.search(en), f"кириллица в английской строке {k}: {en}")

    def test_caption_and_pages_have_no_cyrillic(self):
        said = []
        orig = dgi.tr

        def tr(lang, key, **kw):
            s = orig(lang, key, **kw)
            said.append((lang, key, s))
            return s

        class Page:
            y = 0

            def __init__(self, it, lang, title, *a):
                said.append((lang, "title", title))

            def section(self, title):
                said.append(("en", "section", title))
                return True

            def row(self, label, value="", color=None, sub="", arrow=None):
                said.append(("en", "row", f"{label} {value} {sub}"))
                return True

            def note(self, s):
                said.append(("en", "note", s))
                return True

            def para(self, s, tone=None):
                said.append(("en", "para", s))
                return True

            def png(self):
                return b"png"

        it = item()
        with mock.patch.object(dgi, "tr", tr), mock.patch.object(dgi, "_Page", Page):
            cap = dgi.caption(it, "en")
            for page in (dgi._page_deriv, dgi._page_pos, dgi._page_flows, dgi._page_week):
                page(it, "en", 2, 5)
        self.assertIsNone(CYR.search(cap), cap)
        self.assertTrue(said)
        self.assertEqual({lang for lang, _, _ in said}, {"en"})
        bad = [(k, s) for _, k, s in said if CYR.search(s)]
        self.assertEqual(bad, [])
        self.assertIsNone(CYR.search(dgi.date_word("en", DAY)))

    @unittest.skipUnless(dgi.Image is not None, "нужен Pillow")
    def test_album_draws_in_english(self):
        said = []
        orig = dgi.tr

        def tr(lang, key, **kw):
            said.append(lang)
            return orig(lang, key, **kw)

        with mock.patch.object(dgi, "tr", tr):
            pages = dgi.render_album(item(), "en")
        self.assertGreaterEqual(len(pages), 2)
        self.assertEqual(set(said), {"en"})

    def test_page_numbers_skip_empty_pages(self):
        # Пустой раздел не попадает в альбом, и номера «N/всего» на
        # остальных страницах и обложке — по числу настоящих картинок.
        seen = []

        def page(name, empty=False):
            def fn(it, lang, n, total):
                seen.append((name, n, total))
                return None if empty else f"{name} {n}/{total}".encode()
            return fn

        with mock.patch.object(dgi, "Image", object()), \
                mock.patch.object(dgi, "_page_deriv", page("deriv")), mock.patch.object(dgi, "_page_pos", page("pos", True)), \
                mock.patch.object(dgi, "_page_flows", page("flows")), mock.patch.object(dgi, "_page_week", page("week")), \
                mock.patch.object(dgi, "render", lambda it, lang, pg="": f"cover {pg}".encode()):
            got = dgi.render_album(item(), "en")
        self.assertEqual(got, [b"cover 1/4", b"deriv 2/4", b"flows 3/4", b"week 4/4"])
        with mock.patch.object(dgi, "Image", object()), \
                mock.patch.object(dgi, "_page_deriv", page("deriv")), mock.patch.object(dgi, "_page_pos", page("pos")), \
                mock.patch.object(dgi, "_page_flows", page("flows")), mock.patch.object(dgi, "_page_week", page("week")), \
                mock.patch.object(dgi, "render", lambda it, lang, pg="": f"cover {pg}".encode()):
            seen.clear()
            got = dgi.render_album(item(), "en")
        self.assertEqual(got, [b"cover 1/5", b"deriv 2/5", b"pos 3/5", b"flows 4/5", b"week 5/5"])
        self.assertEqual(len(seen), 4)  # всё на месте — без перерисовки


if __name__ == "__main__":
    unittest.main()

"""Алерт о крупном дне ETF (whale_api: etfd_*): npm test.

Один переключатель на экране «Институциональные потоки»: когда спотовые
биткоин-ETF за день купят или продадут на $500 млн и больше, подписанным с
Премиумом уходит сообщение в Telegram — на их языке и с подписью источника
(TFTC, CC BY 4.0, адрес лицензии). Один день — одна рассылка, только свежий
день. Telegram и Премиум подменены, база — временная.
"""
import os
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модули лежат в корне репозитория
import wt_digest_img as dgi  # noqa: E402

DAY = 1_792_108_800  # 16 октября 2026 г., начало суток UTC
NOW = DAY + 30 * 3600  # итог дня вышел вечером, проверяем на следующие сутки


def reply(v_k: float, per: list, day: int = DAY) -> dict:
    """Ответ /api/etf с одним днём: поток всех фондов ($ тыс.) и по фондам."""
    funds = [{"t": t} for t in ("IBIT", "FBTC", "GBTC", "ARKB")]
    return {"ok": True, "coins": {"btc": {"funds": funds, "days": [[day, v_k, 0, 82_000, per]]}}}


class EtfDayAlertTest(unittest.TestCase):
    def setUp(self):
        fd, self.db = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.addCleanup(os.remove, self.db)
        self.sent: list = []
        self.premium = {"1", "2", "3"}
        self.fail: set = set()

        def tg(method, data, timeout=15.0):
            self.sent.append((data["chat_id"], data["text"]))
            return None if data["chat_id"] in self.fail else {"ok": True}
        for name, val in (("DB", self.db), ("now", lambda: NOW), ("tg_api", tg),
                          ("chat_premium", lambda chat: chat in self.premium)):
            p = mock.patch.object(api, name, val)
            p.start()
            self.addCleanup(p.stop)
        self.rep = reply(1_234_000, [800_000, 310_000, -50_000, None])
        p = mock.patch.object(api, "etf_data", lambda: self.rep)
        p.start()
        self.addCleanup(p.stop)

    # ── Переключатель ────────────────────────────────────────────────────

    def test_switch_on_off_and_language(self):
        self.assertEqual(api.etfd_get("1"), {"ok": True, "on": False, "min": 500_000_000})
        self.assertEqual(api.etfd_set("1", {"on": True, "lang": "ru"})["on"], True)
        self.assertTrue(api.etfd_get("1")["on"])
        self.assertEqual(api.etfd_set("1", {"on": False})["on"], False)
        self.assertFalse(api.etfd_get("1")["on"])
        # Не булево — отказ; язык не из шестнадцати — английский.
        for bad in ({"on": 1}, {"on": "true"}, {}, {"on": None}):
            self.assertEqual(api.etfd_set("1", bad), {"ok": False, "error": "bad_args"}, bad)
        api.etfd_set("2", {"on": True, "lang": "<script>"})
        api.etfd_check()
        self.assertTrue(self.sent[-1][1].startswith("🏦 Big inflow into bitcoin ETFs"))

    # ── Какой день — крупный ─────────────────────────────────────────────

    def test_big_fresh_day_with_top_funds_in_the_same_direction(self):
        ts, v, top = api.etfd_day()
        self.assertEqual((ts, v), (DAY, 1_234_000_000))
        # Только фонды в ту же сторону, по убыванию; GBTC с оттоком — мимо.
        self.assertEqual(top, [("IBIT", 800_000_000), ("FBTC", 310_000_000)])
        self.rep = reply(-650_000, [-500_000, 20_000, -150_000, -10_000])
        self.assertEqual(api.etfd_day()[2], [("IBIT", -500_000_000), ("GBTC", -150_000_000), ("ARKB", -10_000_000)])
        # Больше трёх в ту же сторону — только три крупнейших.
        self.rep = reply(1_000_000, [100_000, 400_000, 50_000, 450_000])
        self.assertEqual(api.etfd_day()[2], [("ARKB", 450_000_000), ("FBTC", 400_000_000), ("IBIT", 100_000_000)])

    def test_small_or_old_day_is_not_an_alert(self):
        self.rep = reply(499_000, [499_000, None, None, None])
        self.assertIsNone(api.etfd_day())
        self.rep = reply(-499_999, [None, None, None, None])
        self.assertIsNone(api.etfd_day())
        # Ровно порог — уже алерт.
        self.rep = reply(500_000, [500_000, None, None, None])
        self.assertIsNotNone(api.etfd_day())
        # День старше ETFD_FRESH (простой сервера, долгие праздники) — не рассылаем.
        self.rep = reply(2_000_000, [2_000_000, None, None, None], day=NOW - api.ETFD_FRESH - 1)
        self.assertIsNone(api.etfd_day())
        for broken in ({}, {"ok": False}, {"coins": {"btc": {"days": []}}}, None):
            self.rep = broken
            self.assertIsNone(api.etfd_day(), broken)

    # ── Рассылка ─────────────────────────────────────────────────────────

    def test_one_message_per_day_to_premium_subscribers_in_their_language(self):
        api.etfd_set("1", {"on": True, "lang": "ru"})
        api.etfd_set("2", {"on": True, "lang": "en"})
        api.etfd_set("9", {"on": True, "lang": "en"})  # без Премиума
        self.assertEqual(api.etfd_check(), 2)
        texts = dict(self.sent)
        self.assertEqual(sorted(texts), ["1", "2"])
        ru = texts["1"]
        self.assertTrue(ru.startswith("🏦 Крупный приток в биткоин-ETF: +$1,23B за 16 октября 2026 г."))
        self.assertIn("Больше всех: IBIT +$800M, FBTC +$310M.", ru)
        # Условие CC BY 4.0: источник и адрес лицензии — в каждом сообщении.
        self.assertIn(dgi.TFTC_BY_POST, ru)
        self.assertIn("https://creativecommons.org/licenses/by/4.0/", texts["2"])
        # Как выключить — с именем экрана из меню того же языка.
        self.assertTrue(ru.endswith("Выключить — на экране «Институциональные потоки» в приложении."))
        self.assertTrue(texts["2"].endswith("To turn this off, open Institutional Flows in the app."))
        # Тот же день второй раз — тишина.
        self.assertEqual(api.etfd_check(), 0)
        self.assertEqual(len(self.sent), 2)
        # Без Премиума подписка остаётся: продлит — следующий крупный день придёт.
        self.assertTrue(api.etfd_get("9")["on"])

    def test_undelivered_three_times_unsubscribes(self):
        api.etfd_set("3", {"on": True, "lang": "en"})
        self.fail = {"3"}
        for i in range(api.ETFD_FAILS):
            self.rep = reply(900_000, [900_000, None, None, None], day=DAY + i * 86_400)
            self.assertTrue(api.etfd_get("3")["on"], i)
            api.etfd_check()
        self.assertFalse(api.etfd_get("3")["on"])

    def test_delivery_resets_the_failure_count(self):
        api.etfd_set("3", {"on": True, "lang": "en"})
        for i, broken in enumerate((True, True, False, True, True)):
            self.fail = {"3"} if broken else set()
            self.rep = reply(900_000, [900_000, None, None, None], day=DAY + i * 86_400)
            api.etfd_check()
        self.assertTrue(api.etfd_get("3")["on"])

    def test_turning_back_on_clears_failures(self):
        api.etfd_set("3", {"on": True, "lang": "en"})
        self.fail = {"3"}
        for i in range(api.ETFD_FAILS - 1):
            self.rep = reply(900_000, [900_000, None, None, None], day=DAY + i * 86_400)
            api.etfd_check()
        api.etfd_set("3", {"on": True, "lang": "en"})
        self.rep = reply(900_000, [900_000, None, None, None], day=DAY + 5 * 86_400)
        api.etfd_check()
        self.assertTrue(api.etfd_get("3")["on"])

    def test_outflow_text(self):
        self.rep = reply(-650_000, [-500_000, None, -150_000, None])
        text = api.etfd_text("ru", DAY, -650_000_000, [("IBIT", -500_000_000), ("GBTC", -150_000_000)])
        self.assertTrue(text.startswith("🏦 Крупный отток из биткоин-ETF: -$650M за 16 октября 2026 г."))
        self.assertIn("Больше всех: IBIT -$500M, GBTC -$150M.", text)
        # Без фондов — без строки «больше всех».
        self.assertNotIn("Больше всех", api.etfd_text("ru", DAY, -650_000_000, []))

    def test_every_language_has_all_parts(self):
        for lang in sorted(api.LANG_CODES):
            text = api.etfd_text(lang, DAY, 1_234_000_000, [("IBIT", 8e8)])
            self.assertNotRegex(text, r"\bef_al_|\{[a-z]\}", lang)
            self.assertIn("IBIT +$800M", text, lang)
            self.assertIn(dgi.tr(lang, "ef_title"), text, lang)
            self.assertIn(dgi.TFTC_BY_POST, text, lang)
            self.assertLess(len(text), 1000, lang)


if __name__ == "__main__":
    unittest.main()

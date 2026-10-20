"""Алерт о крупном дне ETF (whale_api: etfd_*): npm test.

Один переключатель на экране «Институциональные потоки»: когда спотовые
биткоин-ETF за день купят или продадут на $500 млн и больше, подписанным с
Премиумом уходит сообщение в Telegram — на их языке и с подписью источника
(TFTC, CC BY 4.0, адрес лицензии). Один день — одна рассылка, только свежий
день и только когда его цифры устоялись (фонды отчитываются в разное время).
Telegram и Премиум подменены, база — временная.
"""
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import urllib.error
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
        self.fail: set = set()  # Telegram: человека нет (бот заблокирован)
        self.down: set = set()  # сбой по пути: сеть, лимит
        self.t = NOW

        def send(chat, text):
            self.sent.append((chat, text))
            return None if chat in self.down else chat not in self.fail
        for name, val in (("DB", self.db), ("now", lambda: self.t), ("etfd_send", send),
                          ("chat_premium", lambda chat: chat in self.premium)):
            p = mock.patch.object(api, name, val)
            p.start()
            self.addCleanup(p.stop)
        self.rep = reply(1_234_000, [800_000, 310_000, -50_000, None])
        p = mock.patch.object(api, "etf_data", lambda: self.rep)
        p.start()
        self.addCleanup(p.stop)

    def check(self) -> int:
        """Проход, в котором день впервые увиден, и проход после ETFD_STABLE."""
        self.assertEqual(api.etfd_check(), 0)
        self.t += api.ETFD_STABLE
        return api.etfd_check()

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
        self.check()
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
        self.assertEqual(self.check(), 2)
        texts = dict(self.sent)
        self.assertEqual(sorted(texts), ["1", "2"])
        ru = texts["1"]
        self.assertTrue(ru.startswith("🏦 Крупный приток в биткоин-ETF: +$1,23B за 16 октября 2026 г.\n"))
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
            self.check()
        self.assertFalse(api.etfd_get("3")["on"])

    def test_delivery_resets_the_failure_count(self):
        api.etfd_set("3", {"on": True, "lang": "en"})
        for i, broken in enumerate((True, True, False, True, True)):
            self.fail = {"3"} if broken else set()
            self.rep = reply(900_000, [900_000, None, None, None], day=DAY + i * 86_400)
            self.check()
        self.assertTrue(api.etfd_get("3")["on"])

    def test_turning_back_on_clears_failures(self):
        api.etfd_set("3", {"on": True, "lang": "en"})
        self.fail = {"3"}
        for i in range(api.ETFD_FAILS - 1):
            self.rep = reply(900_000, [900_000, None, None, None], day=DAY + i * 86_400)
            self.check()
        api.etfd_set("3", {"on": True, "lang": "en"})
        self.rep = reply(900_000, [900_000, None, None, None], day=DAY + 5 * 86_400)
        self.check()
        self.assertTrue(api.etfd_get("3")["on"])

    def test_network_failure_is_not_the_persons_fault_and_is_retried(self):
        api.etfd_set("3", {"on": True, "lang": "en"})
        self.down = {"3"}
        for _ in range(api.ETFD_FAILS + 2):
            self.check()
        # Сколько бы раз ни лежала сеть — подписка на месте, сообщение не потеряно.
        self.assertTrue(api.etfd_get("3")["on"])
        self.down = set()
        self.t += api.ETFD_EVERY
        self.assertEqual(api.etfd_check(), 1)
        # Дошло — больше этот день не шлём.
        self.t += api.ETFD_EVERY
        self.assertEqual(api.etfd_check(), 0)

    def test_telegram_down_stops_the_pass(self):
        for c in "12345":
            self.premium.add(c)
            api.etfd_set(c, {"on": True, "lang": "en"})
            self.t += 1  # порядок рассылки — по времени включения
        self.down = set("12345")
        self.check()
        self.assertEqual([c for c, _ in self.sent], ["1", "2", "3"])
        # Telegram ожил: следующий проход дошлёт всем, никого не отписав.
        self.down = set()
        self.sent = []
        self.t += api.ETFD_EVERY
        self.assertEqual(api.etfd_check(), 5)

    def test_one_bad_chat_does_not_block_the_rest(self):
        for c in "123":
            api.etfd_set(c, {"on": True, "lang": "en"})
            self.t += 1
        self.down = {"1"}
        self.assertEqual(self.check(), 2)

    def test_scattered_failures_do_not_stop_the_pass(self):
        # Сбой, доставка, два сбоя, доставка: три сбоя есть, но не подряд.
        for c in "12345":
            self.premium.add(c)
            api.etfd_set(c, {"on": True, "lang": "en"})
            self.t += 1
        self.down = {"1", "3", "4"}
        self.assertEqual(self.check(), 2)
        self.assertEqual([c for c, _ in self.sent], list("12345"))

    def test_turned_on_after_the_day_was_sent_gets_only_the_next_day(self):
        api.etfd_set("1", {"on": True, "lang": "en"})
        self.check()
        api.etfd_set("2", {"on": True, "lang": "en"})
        self.t += api.ETFD_EVERY
        self.assertEqual(api.etfd_check(), 0)
        self.assertEqual([c for c, _ in self.sent], ["1"])
        self.rep = reply(-700_000, [-700_000, None, None, None], day=DAY + 86_400)
        self.assertEqual(self.check(), 2)

    def test_old_table_gets_last_day_and_old_subscribers_are_not_sent_again(self):
        con = sqlite3.connect(self.db)
        con.executescript("""
            CREATE TABLE etf_day_subs (chat_id TEXT PRIMARY KEY, lang TEXT NOT NULL DEFAULT 'en',
                                       at INTEGER NOT NULL, fails INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE etf_day_sent (day INTEGER PRIMARY KEY, v REAL NOT NULL, at INTEGER NOT NULL,
                                       n INTEGER NOT NULL DEFAULT 0);
        """)
        con.execute("INSERT INTO etf_day_subs(chat_id, lang, at) VALUES('1', 'ru', 1)")
        con.execute("INSERT INTO etf_day_sent(day, v, at, n) VALUES(?, 1.234e9, 1, 1)", (DAY,))
        con.commit()
        con.close()
        self.assertEqual(self.check(), 0)
        self.assertTrue(api.etfd_get("1")["on"])
        self.rep = reply(900_000, [900_000, None, None, None], day=DAY + 86_400)
        self.assertEqual(self.check(), 1)

    # ── Неполный день ────────────────────────────────────────────────────

    def test_waits_until_the_day_settles(self):
        api.etfd_set("1", {"on": True, "lang": "en"})
        self.assertEqual(api.etfd_check(), 0)
        self.t += api.ETFD_STABLE - 1
        self.assertEqual(api.etfd_check(), 0)
        self.assertEqual(self.sent, [])
        self.t += 1
        self.assertEqual(api.etfd_check(), 1)

    def test_late_fund_restarts_the_wait_and_the_message_has_the_full_day(self):
        api.etfd_set("1", {"on": True, "lang": "en"})
        self.rep = reply(600_000, [None, 400_000, None, 200_000])
        api.etfd_check()
        # Через два часа отчитался IBIT: итог другой — ждём заново.
        self.t += 2 * 3600
        self.rep = reply(1_000_000, [400_000, 400_000, None, 200_000])
        self.assertEqual(api.etfd_check(), 0)
        self.t += api.ETFD_STABLE - 1
        self.assertEqual(api.etfd_check(), 0)
        self.t += 1
        self.assertEqual(api.etfd_check(), 1)
        self.assertIn("+$1B", self.sent[0][1])

    def test_day_that_shrank_below_the_threshold_is_never_sent(self):
        api.etfd_set("1", {"on": True, "lang": "en"})
        self.rep = reply(600_000, [None, 600_000, None, None])
        api.etfd_check()
        # IBIT принёс отток: итог дня меньше порога — крупного дня не было.
        self.rep = reply(200_000, [-400_000, 600_000, None, None])
        for _ in range(3):
            self.t += api.ETFD_STABLE
            self.assertEqual(api.etfd_check(), 0)
        self.assertEqual(self.sent, [])

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
            # Дата — словами, без двух точек подряд («2026 г..»).
            self.assertNotIn("..", text, lang)
            self.assertNotIn("2026-10-16", text, lang)


class DateWordTest(unittest.TestCase):
    """Дата словами на всех шестнадцати языках — в алерте и на картинке дайджеста."""

    def test_every_language_in_words(self):
        want = {"ru": "16 октября 2026 г.", "uk": "16 жовтня 2026 р.", "en": "October 16, 2026",
                "de": "16. Oktober 2026", "fr": "16 octobre 2026", "es": "16 de octubre de 2026",
                "pt": "16 de outubro de 2026", "pl": "16 października 2026", "tr": "16 Ekim 2026",
                "id": "16 Oktober 2026", "vi": "16 tháng 10 năm 2026", "ko": "2026년 10월 16일",
                "zh": "2026年10月16日", "ja": "2026年10月16日", "hi": "16 अक्टूबर 2026", "ar": "16 أكتوبر 2026"}
        self.assertEqual(set(want), set(api.LANG_CODES))
        for lang, s in want.items():
            self.assertEqual(dgi.date_word(lang, DAY), s, lang)
            short = dgi.date_word(lang, DAY, year=False)
            self.assertNotIn("2026", short, lang)
            self.assertIn("16", short, lang)
        # Язык не из списка — по-английски, а не цифрами.
        self.assertEqual(dgi.date_word("xx", DAY), "October 16, 2026")
        # Все двенадцать месяцев есть у каждого языка с названиями месяцев.
        for lang, names in dgi._MONTHS.items():
            self.assertEqual(len(names), 12, lang)
            self.assertEqual(len(set(names)), 12, lang)


class NewFundTest(unittest.TestCase):
    """Новый фонд в наборе TFTC — владельцу один раз, и после перезапуска тоже."""

    def test_once_per_ticker_across_restarts(self):
        fd, db = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.addCleanup(os.remove, db)
        sent: list = []
        with mock.patch.object(api, "DB", db), \
             mock.patch.object(api, "tg_api", lambda m, d, timeout=15.0: sent.append((d["chat_id"], d["text"]))):
            api.etf_new_fund("NEWB")
            api.etf_new_fund("NEWB")  # тот же тикер после перезапуска (память процесса пуста)
            api.etf_new_fund("ABCD")
        self.assertEqual([t for _, t in sent if "NEWB" in t], [sent[0][1]])
        self.assertEqual(len(sent), 2)
        self.assertEqual({c for c, _ in sent}, {api.OWNER_CHAT_ID})
        self.assertIn("wt_treasury.ETFS", sent[0][1])

    def test_without_database_still_tells(self):
        sent: list = []
        with mock.patch.object(api, "DB", "/nonexistent/x.db"), \
             mock.patch.object(api, "tg_api", lambda m, d, timeout=15.0: sent.append(d)):
            api.etf_new_fund("NEWB")
        self.assertEqual(len(sent), 1)


class EtfSendTest(unittest.TestCase):
    """etfd_send: что считать «человека нет», а что — сбоем по пути."""

    def setUp(self):
        p = mock.patch.object(api, "BOT_TOKEN", "1:x")
        p.start()
        self.addCleanup(p.stop)
        self.sleep = mock.patch.object(api.time, "sleep").start()
        self.addCleanup(mock.patch.stopall)

    @staticmethod
    def http(code: int, body: dict) -> urllib.error.HTTPError:
        return urllib.error.HTTPError("https://api.telegram.org", code, "x", None, io.BytesIO(json.dumps(body).encode()))

    def answer(self, *replies):
        def urlopen(req, timeout):
            r = replies[min(self.n, len(replies) - 1)]
            self.n += 1
            if isinstance(r, Exception):
                raise r
            return io.BytesIO(json.dumps(r).encode())
        self.n = 0
        return mock.patch.object(api.urllib.request, "urlopen", urlopen)

    def test_delivered(self):
        with self.answer({"ok": True, "result": {}}):
            self.assertIs(api.etfd_send("1", "hi"), True)

    def test_blocked_or_deleted_is_gone(self):
        for err in (self.http(403, {"ok": False, "description": "Forbidden: bot was blocked by the user"}),
                    self.http(403, {"ok": False, "description": "Forbidden: user is deactivated"}),
                    self.http(400, {"ok": False, "description": "Bad Request: chat not found"})):
            with self.answer(err):
                self.assertIs(api.etfd_send("1", "hi"), False, err)

    def test_path_failures_are_not_the_persons_fault(self):
        for err in (self.http(400, {"ok": False, "description": "Bad Request: message is too long"}),
                    self.http(500, {"ok": False, "description": "Internal Server Error"}),
                    self.http(502, "<html>"),  # nginx Telegram, не JSON
                    urllib.error.URLError("down"), TimeoutError(), OSError("reset")):
            with self.answer(err):
                self.assertIsNone(api.etfd_send("1", "hi"), err)
        with self.answer({"ok": False}):
            self.assertIsNone(api.etfd_send("1", "hi"))
        # Ждать — только по ответу «слишком часто» (429), не по любой ошибке.
        with self.answer(self.http(500, {"ok": False, "parameters": {"retry_after": 3}}), {"ok": True}):
            self.assertIsNone(api.etfd_send("1", "hi"))
        self.sleep.assert_not_called()

    def test_rate_limit_waits_once(self):
        # Тело ответа читается один раз: на каждый вызов — своя ошибка.
        def limit():
            return self.http(429, {"ok": False, "parameters": {"retry_after": 3}})
        with self.answer(limit(), {"ok": True}):
            self.assertIs(api.etfd_send("1", "hi"), True)
        self.sleep.assert_called_once_with(3)
        # Второй раз лимит — сбой, а не бесконечное ожидание; огромное ожидание не ждём.
        with self.answer(limit(), limit()):
            self.assertIsNone(api.etfd_send("1", "hi"))
        with self.answer(self.http(429, {"ok": False, "parameters": {"retry_after": 3600}}), {"ok": True}):
            self.assertIsNone(api.etfd_send("1", "hi"))
        self.assertEqual(self.sleep.call_count, 2)

    def test_no_token(self):
        with mock.patch.object(api, "BOT_TOKEN", ""):
            self.assertIsNone(api.etfd_send("1", "hi"))


if __name__ == "__main__":
    unittest.main()

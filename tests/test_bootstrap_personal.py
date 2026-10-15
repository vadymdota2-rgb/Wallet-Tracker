"""Выгрузка /api/bootstrap: личное не теряется на холодном сервере (npm test).

Сразу после перезапуска общий кэш пуст и собирается секунды. Раньше он шёл
первым, личное не укладывалось в бюджет 18 с — и приложение получало пустую
историю алертов и ноль новых, хотя в базе их сотни (так и было 15.10.2026).
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

ME = {"plan": "premium", "unread": 11, "lang": "ru"}
WALLETS = [{"addr": "0xabc", "name": "Кит"}]
ALERTS = ([{"id": 1, "sym": "AGT"}], [{"sym": "AGT"}])


class SlowClock:
    """Часы, которые прыгают на 30 с, когда собирается общий кэш."""

    def __init__(self):
        self.t = 1000.0

    def monotonic(self):
        return self.t

    def slow_public(self, cur, hl):
        self.t += 30.0
        return {}


class BootstrapPersonalTest(unittest.TestCase):
    def setUp(self):
        fd, self.db = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        sqlite3.connect(self.db).close()

    def tearDown(self):
        os.unlink(self.db)

    def run_boot(self, **patches):
        clock = SlowClock()
        base = {
            "DB": self.db, "HL_DB": "", "load_me": lambda cur, chat: dict(ME),
            "load_wallets": lambda cur, chat, hl: list(WALLETS),
            "load_alerts": lambda cur, chat, wallets: ALERTS, "get_public": clock.slow_public,
            "coins_cached": lambda *a: {}, "usdt_ready": lambda cur: False, "intro_until": lambda cur, chat: 0,
        }
        base.update(patches)
        with mock.patch.multiple(api, **base), mock.patch.object(api.time, "monotonic", clock.monotonic), \
                mock.patch("sys.stderr"):
            return api.bootstrap("546348566")

    def test_slow_public_cache_does_not_drop_personal_data(self):
        r = self.run_boot()
        self.assertTrue(r["ok"])
        self.assertEqual(r["alerts"], ALERTS[0])
        self.assertEqual(r["wallets"], WALLETS)
        self.assertEqual(r["me"]["unread"], 11)
        self.assertFalse([p for p in r.get("partial", []) if p.startswith(("me:", "wallets:", "alerts:"))])

    def test_failed_personal_piece_is_left_out_not_sent_empty(self):
        # Не собрались алерты — ключа нет: приложение оставит показанное,
        # а не сотрёт его пустым списком.
        def boom(cur, chat, wallets):
            raise sqlite3.OperationalError("database is locked")

        r = self.run_boot(load_alerts=boom)
        self.assertTrue(r["ok"])
        self.assertNotIn("alerts", r)
        self.assertNotIn("feed", r)
        self.assertEqual(r["wallets"], WALLETS)
        self.assertTrue(any(p.startswith("alerts:") for p in r["partial"]))


if __name__ == "__main__":
    unittest.main()

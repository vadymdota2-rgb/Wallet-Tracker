"""Баны за промахи ключом (wt_shield.Bans): npm test."""
import io
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_shield as shield  # noqa: E402 — модуль лежит в корне репозитория


class BansTest(unittest.TestCase):
    def test_stranger_is_banned_after_many_fails(self):
        b = shield.Bans()
        with mock.patch("sys.stderr", io.StringIO()):
            for _ in range(shield.BAN_FAILS):
                b.fail("203.0.113.5")
        self.assertTrue(b.banned("203.0.113.5"))
        self.assertFalse(b.banned("203.0.113.6"))

    def test_own_machine_is_never_banned(self):
        # С 127.0.0.1 ходит nginx: бан закрыл бы приложение всем.
        b = shield.Bans()
        for ip in ("127.0.0.1", "127.0.0.53", "::1"):
            for _ in range(shield.BAN_FAILS * 3):
                b.fail(ip)
            self.assertFalse(b.banned(ip))

    def test_junk_address_is_not_loopback(self):
        self.assertFalse(shield._loopback("nginx"))
        self.assertFalse(shield._loopback(""))


if __name__ == "__main__":
    unittest.main()

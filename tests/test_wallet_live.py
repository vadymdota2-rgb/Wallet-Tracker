"""Живой кошелёк Hyperliquid (whale_api.hl_state, wallet_live): npm test.

Перпы и спот — двумя запросами разом: по очереди кошелёк отвечал до 12 с,
и приложение (15 с, четыре кошелька в работе) не дожидалось — «клиент ушёл»
про /api/wallet. И не ответил Hyperliquid — это ошибка, а не пустой кошелёк:
раньше на месте ответа кэшировался пустой словарь, и кошелёк 20 секунд
показывал ноль на балансе и ни одной позиции.
"""
import sqlite3
import threading
import time
import unittest
from unittest import mock

import whale_api as api

ADDR = "0x" + "a" * 40
PERP = {"marginSummary": {"accountValue": "1000"}, "assetPositions": []}
SPOT = {"balances": []}


def answer(payload, timeout=6.0):
    return PERP if payload["type"] == "clearinghouseState" else SPOT


class HlStateTest(unittest.TestCase):
    def setUp(self):
        api._hl_cache.pop(ADDR, None)
        self.addCleanup(api._hl_cache.pop, ADDR, None)

    def test_perp_and_spot_are_asked_at_once(self):
        live, peak = [0], [0]
        lock = threading.Lock()

        def slow(payload, timeout=6.0):
            with lock:
                live[0] += 1
                peak[0] = max(peak[0], live[0])
            time.sleep(0.3)
            with lock:
                live[0] -= 1
            return answer(payload)

        with mock.patch.object(api, "hl_post", slow):
            t0 = time.monotonic()
            self.assertEqual(api.hl_state(ADDR), {"perp": PERP, "spot": SPOT})
            took = time.monotonic() - t0
        self.assertEqual(peak[0], 2)
        self.assertLess(took, 0.5)  # не 0,6 с по очереди

    def test_no_answer_is_an_error_not_an_empty_wallet(self):
        for dead in ("clearinghouseState", "spotClearinghouseState"):
            def flaky(payload, timeout=6.0, dead=dead):
                return None if payload["type"] == dead else answer(payload)

            with mock.patch.object(api, "hl_post", flaky), self.assertRaises(api.HLDown):
                api.hl_state(ADDR)
            self.assertNotIn(ADDR, api._hl_cache, f"сбой {dead} не кэшируется")

    def test_good_answer_is_cached(self):
        calls = []
        with mock.patch.object(api, "hl_post", lambda p, timeout=6.0: (calls.append(p), answer(p))[1]):
            api.hl_state(ADDR)
            api.hl_state(ADDR)
        self.assertEqual(len(calls), 2)  # два запроса на первый раз, второй — из кэша

    def test_wallet_says_upstream_when_hyperliquid_is_silent(self):
        cur = sqlite3.connect(":memory:")
        cur.row_factory = sqlite3.Row
        cur.executescript(
            "CREATE TABLE whale_addresses (id INTEGER PRIMARY KEY, address TEXT);"
            "CREATE TABLE user_whales (user_id TEXT, whale_id INTEGER, label TEXT, created_at INTEGER);")
        cur.execute("INSERT INTO whale_addresses VALUES (1, ?)", (ADDR,))
        cur.execute("INSERT INTO user_whales VALUES ('42', 1, '', 1)")
        with mock.patch.object(api, "hl_post", lambda p, timeout=6.0: None), \
                mock.patch("sys.stderr"):
            self.assertEqual(api.wallet_live(cur, "42", ADDR), {"ok": False, "error": "upstream"})


if __name__ == "__main__":
    unittest.main()

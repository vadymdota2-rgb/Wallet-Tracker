"""Доска фандинга: открытый интерес Bybit — с одной стороны, как у всех бирж.

openInterestValue у Bybit — сумма обеих сторон, вдвое больше настоящего
(сверено на сервере); с июня 2026 рядом есть singleOpenInterestValue.
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import whale_api as api


class FundBybitTest(unittest.TestCase):
    def run_board(self, tick):
        def fake(url, timeout=10.0):
            if "tickers" in url:
                return {"result": {"list": [tick]}}
            return {"result": {"list": [{"symbol": "BTCUSDT", "fundingInterval": 480}]}}
        with mock.patch.object(api, "get_json", side_effect=fake):
            return api.fund_bybit()

    def tick(self, **oi):
        return {"symbol": "BTCUSDT", "fundingRate": "0.0001", "turnover24h": "9000000000",
                "nextFundingTime": "1794009600000", **oi}

    def test_one_side_when_bybit_gives_it(self):
        rows = self.run_board(self.tick(openInterestValue="5357432991.42", singleOpenInterestValue="2678716533.65"))
        self.assertEqual(len(rows), 1)
        self.assertIn(2678716533.65, rows[0].values())
        self.assertNotIn(5357432991.42, rows[0].values())

    def test_half_when_only_the_two_sided_field(self):
        rows = self.run_board(self.tick(openInterestValue="4000000000"))
        self.assertIn(2000000000.0, rows[0].values())

    def test_helper(self):
        self.assertEqual(api._bybit_oi({"openInterestValue": "10", "singleOpenInterestValue": "5"}, value=True), 5.0)
        self.assertEqual(api._bybit_oi({"openInterestValue": "10"}, value=True), 5.0)
        self.assertEqual(api._bybit_oi({"openInterest": "8", "singleOpenInterest": "4"}), 4.0)
        self.assertEqual(api._bybit_oi({"openInterest": "8"}), 4.0)


if __name__ == "__main__":
    unittest.main()

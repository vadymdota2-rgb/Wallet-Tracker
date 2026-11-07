"""Карта ликвидаций: наибольшее плечо монеты по биржам (npm test).

У альткоинов биржи дают обычно 10–25× (медиана — 20×), а модель без
справочника давала всем до 75×. Проверяем: разбор справочников бирж,
кривые ответы, кэш в фоне, проверку значений в модуле и что карта ими
пользуется (у монеты с пределом 10× нет уровней ближе ~9,5 % от цены).
"""
import os
import sys
import threading
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модули лежат в корне репозитория
import wt_liqmap as lm  # noqa: E402

REPLIES = {
    "www.okx.com": {"data": [{"instId": "BEAT-USDT-SWAP", "lever": "10"}, {"instId": "BTC-USDT-SWAP", "lever": "100"},
                             {"instId": "BTC-USD-SWAP", "lever": "125"}, {"instId": "X-USDT-SWAP", "lever": "abc"}]},
    "api.gateio.ws": [{"name": "BEAT_USDT", "leverage_max": "20"}, {"name": "ETH_USD", "leverage_max": "100"}, "мусор",
                      # Два рынка одной бумаги: плечо монеты — наибольшее.
                      {"name": "TSLA_USDT", "leverage_max": "20"}, {"name": "TSLAX_USDT", "leverage_max": "10"}],
    "api.bitget.com": {"data": [{"baseCoin": "BEAT", "maxLever": "10"}, {"baseCoin": "<b>", "maxLever": "10"}]},
    "contract.mexc.com": {"data": [{"symbol": "BEAT_USDT", "maxLeverage": 100}, {"symbol": "DOT_USDT", "maxLeverage": 1e9}]},
    "api-futures.kucoin.com": {"data": [{"baseCurrency": "XBT", "quoteCurrency": "USDT", "maxLeverage": 125},
                                        {"baseCurrency": "BEAT", "quoteCurrency": "USDC", "maxLeverage": 50}]},
    "indexer.dydx.trade": {"markets": {"BEAT-USD": {"initialMarginFraction": "0.2"}, "BTC-USD": {"initialMarginFraction": "0"},
                                       "ETH-USD": "x"}},
    "openapi.blofin.com": {"data": [{"instId": "BEAT-USDT", "maxLeverage": "10"}]},
    "api.orangex.com": {"result": [{"instrument_name": "BEAT-USDT-PERPETUAL", "leverage": 25}]},
    "api.phemex.com": {"data": {"perpProductsV2": [{"symbol": "BEATUSDT", "settleCurrency": "USDT", "maxLeverage": 20},
                                                   {"symbol": "BTCUSD", "settleCurrency": "BTC", "maxLeverage": 100}]}},
    "api.bybit.com": {"result": {"list": [{"baseCoin": "BEAT", "quoteCoin": "USDT", "contractType": "LinearPerpetual",
                                           "leverageFilter": {"maxLeverage": "25.00"}},
                                          {"baseCoin": "ETH", "quoteCoin": "USDT", "contractType": "LinearFutures",
                                           "leverageFilter": {"maxLeverage": "100"}}], "nextPageCursor": ""}},
}


def fake_get(url, *_a, **_k):
    host = url.split("/")[2]
    return REPLIES.get(host)


def fake_post(body, *_a, **_k):
    return {"universe": [{"name": "BEAT", "maxLeverage": 5}, {"name": "kPEPE", "maxLeverage": 10}, "x"]}


class BuildTableTest(unittest.TestCase):
    def setUp(self):
        api._liq_levs_cache.clear()
        self.addCleanup(api._liq_levs_cache.clear)

    def test_every_exchange_is_read(self):
        with mock.patch.object(api, "get_json", fake_get), mock.patch.object(api, "hl_post", fake_post):
            tab = api._liq_levs_build()
        beat = {ex: book["BEAT"] for ex, book in tab.items() if "BEAT" in book}
        self.assertEqual(beat, {"OKX": 10, "Gate": 20, "Bitget": 10, "MEXC": 100, "dYdX": 5, "BloFin": 10,
                                "OrangeX": 25, "Phemex": 20, "Bybit": 25, "Hyperliquid": 5})
        self.assertEqual(tab["OKX"]["BTC"], 100)  # инверсный BTC-USD-SWAP не в счёт
        self.assertEqual(tab["KuCoin"], {"BTC": 125})  # XBT → BTC, USDC — мимо
        self.assertNotIn("ETH", tab.get("Gate", {}))
        self.assertEqual(tab["Gate"]["TSLA"], 20)
        self.assertNotIn("DOT", tab["MEXC"])  # 1e9× — не плечо
        self.assertNotIn("ETH", tab.get("Bybit", {}))  # срочный — мимо
        self.assertNotIn("BTC", tab.get("dYdX", {}))  # доля маржи 0 — мимо
        for book in tab.values():
            for sym, v in book.items():
                self.assertRegex(sym, r"^[A-Z][A-Z0-9]{1,11}$")
                self.assertTrue(type(v) is int and 1 <= v <= 1000)
        self.assertIs(api._liq_levs_cache["all"][1], tab)

    def test_silent_or_broken_exchanges(self):
        def boom(*_a, **_k):
            raise OSError("нет сети")

        for get in (lambda *_a, **_k: None, lambda *_a, **_k: "x", boom):
            api._liq_levs_cache.clear()
            with mock.patch.object(api, "get_json", get), mock.patch.object(api, "hl_post", get):
                self.assertEqual(api._liq_levs_build(), {})
            self.assertNotIn("all", api._liq_levs_cache)  # пустую таблицу не кэшируем


class LookupTest(unittest.TestCase):
    def setUp(self):
        api._liq_levs_cache.clear()
        self.addCleanup(api._liq_levs_cache.clear)

    def test_never_waits_and_refreshes_in_background(self):
        started = threading.Event()

        def slow():
            with api._liq_lock:
                api._liq_levs_cache["all"] = (time.monotonic(), {"OKX": {"BEAT": 10}})
                api._liq_busy.discard("levs")
            started.set()  # последним: дальше тест ждёт и таблицу, и снятый флаг

        with mock.patch.object(api, "_liq_levs_bg", slow):
            self.assertEqual(api._liq_levs("BEAT"), {})  # таблицы нет — сразу пусто
            self.assertTrue(started.wait(5))
        self.assertEqual(api._liq_levs("BEAT"), {"OKX": 10})
        self.assertEqual(api._liq_levs("XYZ"), {})
        # Старая таблица — отдаётся, а свежая собирается в фоне.
        api._liq_levs_cache["all"] = (time.monotonic() - api.LIQ_LEVS_TTL - 1, {"OKX": {"BEAT": 20}})
        refreshed = threading.Event()

        def bg():
            with api._liq_lock:
                api._liq_busy.discard("levs")
            refreshed.set()

        with mock.patch.object(api, "_liq_levs_bg", bg):
            self.assertEqual(api._liq_levs("BEAT"), {"OKX": 20})
            # Поток — фоновый: на занятой машине CI он стартует не сразу.
            self.assertTrue(refreshed.wait(5))

    def test_wired(self):
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            self.assertIn("wt_liqmap.set_levs(_liq_levs)", f.read())


class ModuleTest(unittest.TestCase):
    def setUp(self):
        lm._st = lm._State()
        self.addCleanup(setattr, lm, "_st", lm._State())

    def test_caps_are_checked(self):
        lm.set_levs(lambda _s: {"OKX": 10, "Gate": 0, "MEXC": 2000, "KuCoin": 25.0, "Bybit": True, 5: 20, "BloFin": "10"})
        self.assertEqual(lm._caps("BEAT"), {"OKX": 10})
        for bad in (lambda _s: None, lambda _s: [("OKX", 10)], lambda _s: 1 / 0):
            lm.set_levs(bad)
            self.assertEqual(lm._caps("BEAT"), {})
        lm.set_levs(None)
        self.assertEqual(lm._caps("BEAT"), {})

    def test_map_has_no_levels_closer_than_the_cap_allows(self):
        now = lm._now() // 3600 * 3600
        # Цена 1, на свече 9 открылся миллион монет.
        rows = [(now - (99 - i) * 3600, 1.001, 0.999, 1.0, (1e6 if i < 10 else 2e6) * 1.0, 0.5) for i in range(100)]

        def gather(_sym, period, _n):
            return ({"OKX": rows}, rows) if period == "1h" else ({}, None)

        lm.set_gather(gather)
        lm.set_levs(lambda _s: {"OKX": 10})
        res = lm.build("BEAT", "7d", pre_wait=0.0)
        near = [b for b in res["buckets"] if abs(b["p"] / res["px"] - 1) < 0.09]
        self.assertEqual(near, [])
        self.assertTrue(res["buckets"])
        # Без справочника — до 75×: уровни у самой цены есть.
        lm._st.hits.clear()
        lm.set_levs(None)
        res = lm.build("BEAT", "7d", pre_wait=0.0)
        self.assertTrue([b for b in res["buckets"] if abs(b["p"] / res["px"] - 1) < 0.03])

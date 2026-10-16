"""Институциональные потоки (wt_etf.py): npm test.

Сеть подменена (_fetch): каждый источник отвечает тем, что задал тест, —
поэтому проверяются и сборка, и сбои каждого источника по отдельности.
"""
import io
import json
import os
import sys
import threading
import time
import unittest
import urllib.parse
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_etf as etf  # noqa: E402 — модуль лежит в корне репозитория

NOW = 1_792_000_000
TODAY = NOW - NOW % 86400
D1, D2, D3 = TODAY - 3 * 86400, TODAY - 2 * 86400, TODAY - 86400  # три полных дня до сегодняшнего


def day_ms(ts):
    return ts * 1000


def chain():
    """Свой сканер: BITB — с D1, есть запас; IBIT найден у хранителя с D2, запаса нет.
    Сегодняшние сутки ещё идут — на экран не попадают."""
    return {
        "BITB": {"from": D1, "days": {D1 + 3600: 10.0, D2 + 7200: -2.0, TODAY + 100: 5.0}, "hold": 37_000.0},
        "IBIT": {"from": D2, "days": {D2: 100.0, D3: 50.0}, "hold": None},
    }


def cmc_points():
    """Ключ сверки: сводка потоков фондов, $."""
    return [
        {"date": day_ms(D1), "total": {"usd": 1}, "IBIT": {"usd": 200_000_000}, "FBTC": {"usd": -50_000_000}},
        {"date": day_ms(D2), "total": {}, "IBIT": {"usd": None}, "FBTC": {"usd": -40_000_000}},
        {"date": day_ms(D3), "total": {}, "IBIT": {"usd": None}, "FBTC": {"usd": None}},
    ]


class Net:
    """Подставная сеть. routes: часть адреса → ответ (bytes, объект или вызов)."""

    def __init__(self, **over):
        self.urls = []
        self.routes = {
            "netflow/list?category=btc&size=100&page=1": {"data": {"totalCount": 3, "points": cmc_points()}},
            "etf/list?category=btc": {"data": [{"ticker": "IBIT", "netFee": 0.25}, {"ticker": ""}, "мусор"]},
            "binance.vision/api/v3/klines": [[day_ms(D1), 0, 0, 0, "60000.5"], [day_ms(D2), 0, 0, 0, "61000"],
                                             [day_ms(D3), 0, 0, 0, "62000"], [day_ms(TODAY), 0, 0, 0, "63000"]],
            "ticker/price": {"price": "61000"},
            "publicreporting.cftc.gov": [
                {"cftc_contract_market_code": "133741", "report_date_as_yyyy_mm_dd": "2026-10-06T00:00:00.000",
                 **dict.fromkeys(etf.CME_FIELDS, "10")},
                {"cftc_contract_market_code": "133742", "report_date_as_yyyy_mm_dd": "2026-10-06T00:00:00.000",
                 **dict.fromkeys(etf.CME_FIELDS, "100")},
                {"cftc_contract_market_code": "999999"}, "мусор",
            ],
            "products/BTC-USD/candles": [[D1, 0, 0, 0, 60060.5], [D2, 0, 0, 0, 61061], "мусор"],
            "products/BTC-USD/ticker": {"price": "61061"},
        }
        self.routes.update(over)

    def fetch(self, url, timeout, data=None):
        self.urls.append(url)
        # Самый точный подходящий адрес — первым.
        for part, ans in sorted(self.routes.items(), key=lambda kv: -len(kv[0])):
            if part in url:
                got = ans(url) if callable(ans) else ans
                return got if got is None or isinstance(got, bytes) else json.dumps(got).encode()
        return None


class EtfTest(unittest.TestCase):
    def setUp(self):
        etf._st = etf._State()
        etf._busy.clear()
        etf.set_chain(chain)
        etf._check = etf._Check()

    def build(self, net=None):
        net = net or Net()
        with mock.patch.object(etf, "_fetch", net.fetch), mock.patch.object(etf, "_now", lambda: NOW), \
                mock.patch("sys.stderr", io.StringIO()):
            return etf.build()

    # ── Потоки фондов — свой сканер ──────────────────────────────────────

    def test_days_funds_and_prices_from_chain(self):
        net = Net()
        r = self.build(net)
        self.assertTrue(r["ok"])
        btc = r["coins"]["btc"]
        # Сутки UTC от начала наблюдения до вчера; $ тыс. по закрытию дня Binance.
        # IBIT до своего начала наблюдения — None, а не ноль.
        self.assertEqual(btc["days"], [[D1, 600, 10.0, 60000.5, [600, None]],
                                       [D2, 5978, 98.0, 61000.0, [-122, 6100]],
                                       [D3, 3100, 50.0, 62000.0, [0, 3100]]])
        bitb, ibit = btc["funds"]
        self.assertEqual(bitb, {"t": "BITB", "n": "Bitwise Bitcoin ETF", "c": "US", "aum": 37_000 * 62000,
                                "fee": None, "cum": 478_005, "cumc": 8.0, "src": "chain"})
        # Запаса нет — активов нет, а не чужая цифра.
        self.assertEqual((ibit["t"], ibit["aum"], ibit["c"]), ("IBIT", 0, "US"))
        self.assertEqual(btc["share"], round(37_000 / etf.supply_at(NOW) * 100, 3))
        # На экран — ни одного запроса к сводкам.
        self.assertFalse(any("coinmarketcap" in u for u in net.urls))

    def test_no_chain_no_coin(self):
        etf.set_chain(lambda: {})
        self.assertEqual(self.build(), {"ok": False, "error": "no_data"})
        etf.set_chain(lambda: {"BITB": {"from": TODAY, "days": {TODAY: 1.0}, "hold": None}})
        self.assertEqual(self.build(), {"ok": False, "error": "no_data"})

    def test_broken_chain_is_no_coin(self):
        def boom():
            raise RuntimeError("база занята")

        etf.set_chain(boom)
        self.assertEqual(self.build(), {"ok": False, "error": "no_data"})

    # ── Ключ сверки имён ─────────────────────────────────────────────────

    def test_check_reply_is_key_only(self):
        net = Net()
        with mock.patch.object(etf, "_fetch", net.fetch), mock.patch("sys.stderr", io.StringIO()):
            r = etf.check_reply()
            n = len(net.urls)
            self.assertIs(etf.check_reply(), r)  # живёт TTL
            self.assertEqual(len(net.urls), n)
        btc = r["coins"]["btc"]
        self.assertEqual(btc["funds"], [{"t": "FBTC", "fee": None}, {"t": "IBIT", "fee": 0.25}])
        self.assertEqual(btc["days"], [[D1, 0, 0, 60000.5, [-50_000, 200_000]], [D2, 0, 0, 61000.0, [-40_000, None]]])

    def test_check_reply_missing_page_keeps_old(self):
        def pages(url):
            n = int(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["page"][0])
            return {"data": {"totalCount": 250, "points": cmc_points() if n != 2 else []}}

        net = Net(**{"netflow/list?category=btc": pages, "netflow/list?category=btc&size=100&page=1": pages})
        with mock.patch.object(etf, "_fetch", net.fetch), \
                mock.patch.object(etf.time, "sleep"), mock.patch("sys.stderr", io.StringIO()):
            self.assertIsNone(etf.check_reply())

    # ── Держатели ────────────────────────────────────────────────────────

    def test_holders_are_funds_and_governments(self):
        gov = [["United States", "GOVERNMENT", "", "🇺🇸", "US", 69370.18, 0.0, 0],
               ["El Salvador", "GOVERNMENT", "", "🇸🇻", "SV", 7806.37, 7.0, 0]]
        etf.set_holders(lambda: {"top": gov})
        try:
            h = self.build()["holders"]
        finally:
            etf.set_holders(None)
        # Фонд: свой запас по цене последнего дня; неделя — его дневные потоки,
        # каждый по своей цене. IBIT без запаса в держатели не идёт.
        bitb = ["Bitwise Bitcoin ETF", "FUND", "", "🇺🇸", "BITB", 37_000.0,
                round(600_000 / 60000.5 - 122_000 / 61000, 2), 0]
        self.assertEqual(h["top"], [gov[0], bitb, gov[1]])
        self.assertEqual([g[:2] for g in h["groups"]], [["GOVERNMENT", 2], ["FUND", 1]])
        self.assertEqual([m[4] for m in h["movers"]], ["BITB", "SV"])
        # Биржи и киты — не на этой вкладке, даже если источник их пришлёт.
        etf.set_holders(lambda: {"top": [["Binance", "EXCHANGE", "", "", "", 1e5, 0.0, 0]]})
        try:
            self.assertEqual([r[1] for r in self.build()["holders"]["top"]], ["FUND"])
        finally:
            etf.set_holders(None)

    def test_holders_crash_keeps_funds_and_old_governments(self):
        etf.set_holders(lambda: {"top": [["El Salvador", "GOVERNMENT", "", "🇸🇻", "SV", 7806.37, 0.0, 0]]})
        try:
            self.build()
        finally:
            etf.set_holders(None)

        def boom():
            raise RuntimeError("база занята")

        etf.set_holders(boom)
        try:
            r = self.build()
        finally:
            etf.set_holders(None)
        self.assertTrue(r["ok"])
        self.assertEqual([x[4] for x in r["holders"]["top"]], ["BITB", "SV"])

    def test_only_bitcoin_is_asked(self):
        net = Net()
        self.build(net)
        for other in ("category=", "ETH-USD", "hyperliquid", "bitcointreasuries", "coinmarketcap"):
            self.assertFalse(any(other in u for u in net.urls), other)

    def test_supply_by_schedule(self):
        self.assertEqual(etf.supply_at(etf.TS_840K), 19_687_500.0)
        self.assertEqual(etf.supply_at(etf.TS_840K + 600 * 1000), 19_687_500.0 + 3.125 * 1000)
        # После пятого халвинга (блок 1 050 000) награда вдвое меньше.
        self.assertEqual(etf.supply_at(etf.TS_840K + 600 * 210_010),
                         19_687_500.0 + 3.125 * 210_000 + 1.5625 * 10)

    # ── CME и премия Coinbase ────────────────────────────────────────────

    def test_cme_sums_big_and_micro_in_coins(self):
        rows = self.build()["cme"]["btc"]
        self.assertEqual(rows, [[1_791_244_800, *[10 * 5.0 + 100 * 0.1] * len(etf.CME_FIELDS)]])

    def test_coinbase_premium(self):
        cbp = self.build()["cbp"]
        self.assertEqual(cbp["btc"]["days"], [[D1, 0.1], [D2, 0.1]])
        self.assertEqual(cbp["btc"]["now"], 0.1)
        self.assertNotIn("eth", cbp)

    # ── Сбои частей и кэш ────────────────────────────────────────────────

    def test_failed_coin_comes_from_previous_build(self):
        first = self.build()
        etf._st.hit = (time.monotonic() - 99_999, first)
        etf.set_chain(lambda: {})
        r = self.build()
        self.assertTrue(r["ok"])
        self.assertEqual(r["coins"]["btc"], first["coins"]["btc"])

    def test_part_crash_does_not_break_the_rest(self):
        with mock.patch.object(etf, "_cme", side_effect=RuntimeError("boom")):
            r = self.build()
        self.assertTrue(r["ok"])
        self.assertEqual(r["cme"], {})
        self.assertIn("btc", r["coins"])

    def test_cache_and_single_background_build(self):
        net = Net()
        calls = []
        with mock.patch.object(etf, "_fetch", net.fetch), mock.patch.object(etf, "_now", lambda: NOW), \
                mock.patch("sys.stderr", io.StringIO()):
            a = etf.etf_data()
            n = len(net.urls)
            self.assertIs(etf.etf_data(), a)  # свежий — из кэша, сеть не трогаем
            self.assertEqual(len(net.urls), n)
            etf._st.hit = (time.monotonic() - etf.TTL - 1, a)
            with mock.patch.object(etf, "build", lambda: calls.append(1) or time.sleep(0.2)):
                outs = [etf.etf_data() for _ in range(5)]
                for _ in range(50):
                    if not etf._busy.is_set():
                        break
                    time.sleep(0.02)
        self.assertTrue(all(o is a for o in outs))  # устаревший отдаётся сразу
        self.assertEqual(calls, [1])  # и собирается заново один раз

    def test_cold_start_race_builds_once(self):
        net = Net()
        orig = net.fetch

        def slow(url, timeout, data=None):
            time.sleep(0.01)
            return orig(url, timeout, data)

        out = []
        with mock.patch.object(etf, "_fetch", slow), mock.patch.object(etf, "_now", lambda: NOW), \
                mock.patch("sys.stderr", io.StringIO()):
            ts = [threading.Thread(target=lambda: out.append(etf.etf_data())) for _ in range(4)]
            for t in ts:
                t.start()
            for t in ts:
                t.join(30)
        self.assertEqual(len(out), 4)
        self.assertTrue(all(o is out[0] for o in out))
        self.assertEqual(sum("publicreporting.cftc.gov" in u for u in net.urls), 1)

    # ── Защита ───────────────────────────────────────────────────────────

    def test_only_https_to_known_hosts(self):
        self.assertTrue(etf._allowed("https://api.coinmarketcap.com/data-api/v3/etf/list"))  # только ключ сверки
        for url in ("http://api.coinmarketcap.com/", "https://169.254.169.254/", "https://evil.com/",
                    "https://user@api.coinmarketcap.com/", "https://api.coinmarketcap.com.evil.com/", "https://[",
                    "https://bitcointreasuries.net/", "https://api.hyperliquid.xyz/info"):
            self.assertFalse(etf._allowed(url), url)
        with mock.patch.object(etf._opener, "open") as op:
            self.assertIsNone(etf._fetch("https://evil.com/", 5))
            op.assert_not_called()

    def test_hostile_json_is_rejected(self):
        for raw in (b"NaN", b"1e400", b'{"data":{"totalCount":Infinity}}', b"[" * 100_000 + b"]" * 100_000, b"\xff", b""):
            self.assertIsNone(etf._parse(raw), raw[:20])
        self.assertEqual(etf._num("1.5"), 1.5)
        for v in (None, True, "x", [], float("nan"), float("inf")):
            self.assertEqual(etf._num(v), 0.0, v)

    def test_body_limit(self):
        class Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        with mock.patch.object(etf._opener, "open", lambda req, timeout=0: Resp(b"x" * (etf.BODY_MAX + 1))):
            self.assertIsNone(etf._fetch("https://api.coinmarketcap.com/x", 5))
        with mock.patch.object(etf._opener, "open", lambda req, timeout=0: Resp(b"[1]")):
            self.assertEqual(etf._fetch("https://api.coinmarketcap.com/x", 5), b"[1]")

    def test_log_is_one_short_line(self):
        err = io.StringIO()
        with mock.patch("sys.stderr", err):
            etf._log("a\nb\x1b" + "x" * 1000)
        self.assertEqual(err.getvalue().count("\n"), 1)
        self.assertNotIn("\x1b", err.getvalue())


    # ── Мусор от источников: каждая ветка разбора ───────────────────────

    def test_klines_stop_after_six_pages(self):
        calls = []

        def kl(url):
            calls.append(url)
            return [[day_ms(D1), 0, 0, 0, "1"]] * 1000

        with mock.patch.object(etf, "_fetch", Net(**{"binance.vision/api/v3/klines": kl}).fetch):
            self.assertEqual(etf._klines("BTCUSDT", 0), {D1: 1.0})
        self.assertEqual(len(calls), 6)

    def test_junk_everywhere_is_skipped(self):
        r = self.build(Net(**{
            "publicreporting.cftc.gov": [{"cftc_contract_market_code": "133741", "report_date_as_yyyy_mm_dd": 5},
                                         {"cftc_contract_market_code": "133741", "report_date_as_yyyy_mm_dd": "не дата"}],
            "products/BTC-USD/candles": {"message": "rate limited"},
            "binance.vision/api/v3/klines": ["мусор", [1]],
        }))
        btc = r["coins"]["btc"]
        # Без цены дня потоки в $ — нули, монеты — свои; активов и доли нет.
        self.assertEqual([d[2] for d in btc["days"]], [10.0, 98.0, 50.0])
        self.assertEqual([d[1] for d in btc["days"]], [0, 0, 0])
        self.assertIsNone(btc["share"])
        self.assertEqual((r["cme"], r["cbp"]), ({}, {}))

    def test_bad_cme_is_empty(self):
        r = self.build(Net(**{"publicreporting.cftc.gov": []}))
        self.assertEqual(r["cme"], {})

    def test_previous_cme_and_premium_are_kept(self):
        first = self.build()
        etf._st.hit = (time.monotonic() - 99_999, first)
        r = self.build(Net(**{"publicreporting.cftc.gov": None, "products/BTC-USD/candles": None}))
        self.assertEqual((r["cme"], r["cbp"]), (first["cme"], first["cbp"]))

    def test_background_crash_is_logged_and_releases_the_flag(self):
        etf._busy.set()
        err = io.StringIO()
        with mock.patch.object(etf, "build", side_effect=RuntimeError("boom")), mock.patch("sys.stderr", err):
            etf._bg()
        self.assertFalse(etf._busy.is_set())
        self.assertIn("etf: сборка: RuntimeError: boom", err.getvalue())

    def test_thread_start_failure_releases_the_flag(self):
        etf._st.hit = (time.monotonic() - etf.TTL - 1, {"ok": True})
        with mock.patch.object(etf.threading.Thread, "start", side_effect=RuntimeError("no threads")), \
                mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(etf.etf_data(), {"ok": True})
        self.assertFalse(etf._busy.is_set())

    def test_network_errors_are_none(self):
        for exc in (OSError("x"), ValueError("x"), etf.http.client.IncompleteRead(b"")):
            with mock.patch.object(etf._opener, "open", side_effect=exc):
                self.assertIsNone(etf._fetch("https://api.coinmarketcap.com/x", 5))

    def test_redirect_is_not_followed(self):
        self.assertIsNone(etf._NoRedirect().redirect_request(None, None, 302, "Found", {}, "https://evil.com/"))

    def test_clock_is_unix_seconds(self):
        self.assertLessEqual(abs(etf._now() - time.time()), 1)


if __name__ == "__main__":
    unittest.main()

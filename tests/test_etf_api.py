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
D1, D2, D3 = 1_791_590_400, 1_791_676_800, 1_791_763_200  # три торговых дня подряд (UTC)


def day_ms(ts):
    return ts * 1000


def btc_points():
    """Три дня потоков: IBIT +, FBTC −; третий день — фонды ещё не отчитались."""
    return [
        {"date": day_ms(D1), "total": {"usd": 150_000_000, "btc": 999}, "IBIT": {"usd": 200_000_000, "btc": 2000},
         "FBTC": {"usd": -50_000_000, "btc": -500}},
        {"date": day_ms(D2), "total": {"usd": -30_000_000}, "IBIT": {"usd": 10_000_000, "btc": 100},
         "FBTC": {"usd": -40_000_000, "btc": -400}},
        {"date": day_ms(D3), "total": {}, "IBIT": {"usd": None}, "FBTC": {"usd": None}},
    ]


class Net:
    """Подставная сеть. routes: часть адреса → ответ (bytes, объект или вызов)."""

    def __init__(self, **over):
        self.urls = []
        self.routes = {
            "netflow/list?category=btc&size=100&page=1": {"data": {"totalCount": 3, "points": btc_points()}},
            "netflow/list?category=": {"data": {"totalCount": 0, "points": []}},  # остальные монеты — пусто
            "etf/list?category=btc": {"data": [{"ticker": "IBIT", "name": "iShares Bitcoin Trust", "aum": 9e10, "country": "us",
                                                "volume": 1e9, "premiumDiscount": "0.02", "netFee": 0.25}]},
            "etf/list?category=": {"data": []},
            "netflow/metrics": {"data": {"strongestMonth": {"timestamp": D1, "value": 5e9}, "weakestMonth": {}}},
            "market-cap/ratio": {"data": {"configs": [{"value": 6.6}], "points": [{"timestamp": D1, "points": [6.5]}]}},
            "binance.vision/api/v3/klines": [[day_ms(D1), 0, 0, 0, "60000.5"], [day_ms(D2), 0, 0, 0, "61000"]],
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

    def build(self, net=None):
        net = net or Net()
        with mock.patch.object(etf, "_fetch", net.fetch), mock.patch.object(etf, "_now", lambda: NOW), \
                mock.patch("sys.stderr", io.StringIO()):
            return etf.build()

    # ── Потоки фондов ────────────────────────────────────────────────────

    def test_btc_days_funds_and_prices(self):
        r = self.build()
        self.assertTrue(r["ok"])
        btc = r["coins"]["btc"]
        # Дни в тыс. $; монеты — сумма по фондам (в итоге источника у биткоина доллары);
        # третий день без отчётов — не день; цена — закрытие Binance.
        self.assertEqual(btc["days"], [[D1, 150_000, 1500.0, 60000.5, [200_000, -50_000]],
                                       [D2, -30_000, -300.0, 61000.0, [10_000, -40_000]]])
        # Фонды — по убыванию итога «с запуска» (сумма дней, а не строка источника).
        self.assertEqual([f["t"] for f in btc["funds"]], ["IBIT", "FBTC"])
        # Страна фонда — из списка фондов; FBTC в списке нет — без страны.
        self.assertEqual([f["c"] for f in btc["funds"]], ["US", ""])
        ibit = btc["funds"][0]
        self.assertEqual((ibit["cum"], ibit["cumc"], ibit["n"], ibit["fee"]),
                         (210_000_000, 2100.0, "iShares Bitcoin Trust", 0.25))
        # Биржевые цифры источника (премия, оборот акций) не берутся: в цепочке
        # их нет, проверить нечем.
        self.assertNotIn("prem", ibit)
        self.assertNotIn("vol", ibit)
        # Доля в обращении — своя арифметика: активы в монетах к добытому по
        # расписанию, а не готовая цифра источника.
        want = round(9e10 / 61000 / etf.supply_at(NOW) * 100, 3)
        self.assertEqual(btc["share"], want)
        self.assertEqual(set(btc), {"funds", "days", "share"})
        self.assertEqual(list(r["coins"]), ["btc"])  # только биткоин

    def test_missing_page_means_no_coin_not_a_hole(self):
        def pages(url):
            n = int(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["page"][0])
            return {"data": {"totalCount": 250, "points": btc_points() if n != 2 else []}}

        with mock.patch.object(etf.time, "sleep"):
            r = self.build(Net(**{"netflow/list?category=btc&size=100&page=1": pages, "netflow/list?category=btc": pages}))
        self.assertEqual(r, {"ok": False, "error": "no_data"})

    # ── Держатели ────────────────────────────────────────────────────────

    def test_holders_are_funds_and_governments(self):
        gov = [["United States", "GOVERNMENT", "", "🇺🇸", "US", 69370.18, 0.0, 0],
               ["El Salvador", "GOVERNMENT", "", "🇸🇻", "SV", 7806.37, 7.0, 0]]
        etf.set_holders(lambda: {"top": gov})
        try:
            h = self.build()["holders"]
        finally:
            etf.set_holders(None)
        # Фонд: активы по цене последнего дня; неделя — его дневные потоки,
        # каждый по своей цене: 200 млн / 60 000,5 + 10 млн / 61 000.
        # Флаг — по стране, где фонд торгуется.
        ibit = ["iShares Bitcoin Trust", "FUND", "", "🇺🇸", "IBIT", round(9e10 / 61000, 2),
                round(2e8 / 60000.5 + 1e7 / 61000, 2), 0]
        self.assertEqual(h["top"], [ibit, *gov])
        self.assertEqual([g[:2] for g in h["groups"]], [["FUND", 1], ["GOVERNMENT", 2]])
        self.assertEqual([m[4] for m in h["movers"]], ["IBIT", "SV"])
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
        self.assertEqual([x[4] for x in r["holders"]["top"]], ["IBIT", "SV"])

    def test_only_bitcoin_is_asked(self):
        net = Net()
        self.build(net)
        for other in ("category=eth", "category=sol", "category=xrp", "category=hype", "ETH-USD", "hyperliquid",
                      "bitcointreasuries"):
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
        r = self.build(Net(**{"netflow/list?category=btc&size=100&page=1": None}))
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
        self.assertEqual(sum("etf/list?category=btc" in u for u in net.urls), 1)

    # ── Защита ───────────────────────────────────────────────────────────

    def test_only_https_to_known_hosts(self):
        self.assertTrue(etf._allowed("https://api.coinmarketcap.com/data-api/v3/etf/list"))
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

    def test_two_pages_and_paged_klines(self):
        def pages(url):
            n = int(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["page"][0])
            return {"data": {"totalCount": 150, "points": btc_points()[:2] if n == 1 else
                             [{"date": day_ms(D3), "IBIT": {"usd": 1_000_000, "btc": 10}}]}}

        klines = []
        for i in range(1000):
            klines.append([day_ms(D1 - 86400 * (999 - i)), 0, 0, 0, "1"])

        def kl(url):
            start = int(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["startTime"][0])
            return klines if start < day_ms(D2) else [[day_ms(D2), 0, 0, 0, "2"], [day_ms(D3), 0, 0, 0, "3"], "мусор"]

        r = self.build(Net(**{"netflow/list?category=btc": pages, "netflow/list?category=btc&size=100&page=1": pages,
                              "binance.vision/api/v3/klines": kl}))
        self.assertEqual([d[0] for d in r["coins"]["btc"]["days"]], [D1, D2, D3])
        self.assertEqual([d[3] for d in r["coins"]["btc"]["days"]], [1.0, 2.0, 3.0])

    def test_klines_stop_after_six_pages(self):
        calls = []

        def kl(url):
            calls.append(url)
            return [[day_ms(D1), 0, 0, 0, "1"]] * 1000

        with mock.patch.object(etf, "_fetch", Net(**{"binance.vision/api/v3/klines": kl}).fetch):
            self.assertEqual(etf._klines("BTCUSDT", 0), {D1: 1.0})
        self.assertEqual(len(calls), 6)

    def test_junk_everywhere_is_skipped(self):
        pts = {"data": {"totalCount": 2, "points": [*btc_points()[:2], {"date": 0, "IBIT": {"usd": 1}}, "мусор"]}}
        r = self.build(Net(**{
            "netflow/list?category=btc&size=100&page=1": pts,
            "etf/list?category=btc": {"data": [{"ticker": ""}, {"ticker": 5}, "мусор"]},
            "market-cap/ratio": {"data": {"configs": [], "points": ["x", {"points": []}]}},
            "publicreporting.cftc.gov": [{"cftc_contract_market_code": "133741", "report_date_as_yyyy_mm_dd": 5},
                                         {"cftc_contract_market_code": "133741", "report_date_as_yyyy_mm_dd": "не дата"}],
            "products/BTC-USD/candles": {"message": "rate limited"},
        }))
        btc = r["coins"]["btc"]
        self.assertEqual(len(btc["days"]), 2)
        self.assertEqual(btc["funds"][0]["n"], "")
        self.assertIsNone(btc["share"])
        self.assertEqual((r["cme"], r["cbp"], r["holders"]), ({}, {}, {}))

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

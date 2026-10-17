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
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_etf as etf  # noqa: E402 — модуль лежит в корне репозитория

NOW = 1_792_000_000
D1, D2, D3 = 1_791_590_400, 1_791_676_800, 1_791_763_200  # три торговых дня подряд (UTC)


def day_ms(ts):
    return ts * 1000


# Концы кварталов: 31 декабря 2025, 31 марта и 30 июня 2026 (UTC).
Q0, Q1, Q2 = 1_767_139_200, 1_774_915_200, 1_782_777_600

# Отчёты фондов в SEC (wt_treasury.etf_funds): у IBIT — монеты и стоимость,
# у FBTC — только стоимость (монеты — по цене отчётов IBIT на ту же дату).
SEC = {
    "IBIT": {"n": "iShares Bitcoin Trust", "fee": None,
             "q": {Q0: [700_000.0, 63e9], Q1: [750_000.0, 60e9], Q2: [734_261.0, 734_261.0 * 60_000]}},
    "FBTC": {"n": "Fidelity Wise Origin Bitcoin Fund", "fee": None, "q": {Q1: [None, 12e9], Q2: [None, 9e9]}},
}


# Набор TFTC: праздник биржи (без разбивки по фондам) и три дня подряд.
TFTC = {
    "license": "https://creativecommons.org/licenses/by/4.0/", "updatedThrough": "2026-10-12",
    "days": [
        {"date": "2026-10-09", "netFlowUsd": 0, "btcCloseUsd": 59_000, "perEtfUsd": None},
        {"date": "2026-10-10", "netFlowUsd": 105e6, "btcCloseUsd": 60_000,
         "perEtfUsd": {"IBIT": 100e6, "BITB": 5e6, "MSBT": None}},
        {"date": "2026-10-11", "netFlowUsd": -17e6, "btcCloseUsd": 61_000, "perEtfUsd": {"IBIT": -20e6, "BITB": 3e6}},
        {"date": "2026-10-12", "netFlowUsd": None, "btcCloseUsd": 62_000,
         "perEtfUsd": {"IBIT": 62e6, "bad ticker": 1e9, "<b>": 1e9}},
    ],
}


class Net:
    """Подставная сеть. routes: часть адреса → ответ (bytes, объект или вызов)."""

    def __init__(self, **over):
        self.urls = []
        self.routes = {
            "binance.vision/api/v3/klines": [[day_ms(Q0), 0, 0, 0, "90000"], [day_ms(Q1), 0, 0, 0, "80000"],
                                             [day_ms(Q2), 0, 0, 0, "60000"], [day_ms(D1), 0, 0, 0, "60000.5"],
                                             [day_ms(D2), 0, 0, 0, "61000"], [day_ms(D3), 0, 0, 0, "62000"]],
            "ticker/price": {"price": "61000"},
            "tftc.io/bitcoin-etf-flows/data.json": TFTC,
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
        self.sec(SEC)
        p = mock.patch.object(etf.wt_treasury, "companies", list)
        p.start()
        self.addCleanup(p.stop)

    def sec(self, data):
        p = mock.patch.object(etf.wt_treasury, "etf_funds", lambda: data)
        p.start()
        self.addCleanup(p.stop)

    def build(self, net=None):
        net = net or Net()
        with mock.patch.object(etf, "_fetch", net.fetch), mock.patch.object(etf, "_now", lambda: NOW), \
                mock.patch("sys.stderr", io.StringIO()):
            return etf.build()

    # ── Потоки фондов ────────────────────────────────────────────────────

    def test_days_from_tftc_holdings_from_sec(self):
        net = Net()
        r = self.build(net)
        self.assertTrue(r["ok"])
        btc = r["coins"]["btc"]
        # Фонды — по модулю итога «с запуска»: IBIT, BITB (его нет в SEC —
        # запаса нет), FBTC (дней нет, запас из отчёта).
        order = [f["t"] for f in btc["funds"]]
        self.assertEqual(order, ["IBIT", "BITB", "FBTC"])
        ibit, bitb, fbtc = btc["funds"]
        # Запас — отчёт за 30.06 плюс потоки дней после него (в монетах по
        # закрытию Binance), комиссии нет.
        after = 100e6 / 60_000.5 - 20e6 / 61_000 + 62e6 / 62_000
        self.assertEqual(ibit["hold"], round(734_261.0 + after, 2))
        self.assertEqual(ibit["aum"], round((734_261.0 + after) * 62_000))
        self.assertEqual((ibit["cum"], ibit["n"], ibit["c"], ibit["fee"]), (142_000_000, "iShares Bitcoin Trust", "US", None))
        self.assertEqual((bitb["hold"], bitb["aum"], bitb["cum"], bitb["n"]), (0.0, 0, 8_000_000, ""))
        # Только стоимость в отчёте — монеты по цене отчётов IBIT на ту дату.
        self.assertEqual((fbtc["hold"], fbtc["cum"]), (round(9e9 / 60_000, 2), 0))
        # Дни: итог дня — сумма фондов, монеты — по цене дня; праздник биржи
        # (без фондов и с нулём) — не торговый день; мусорные тикеры отброшены.
        self.assertEqual(btc["days"], [
            [D1, 105_000, round(105e6 / 60_000.5, 2), 60_000.5, [100_000, 5_000, None]],
            [D2, -17_000, round(-17e6 / 61_000, 2), 61_000.0, [-20_000, 3_000, None]],
            [D3, 62_000, 1_000.0, 62_000.0, [62_000, None, None]],
        ])
        self.assertEqual((btc["px"], btc["through"]), (62_000.0, "2026-10-12"))
        self.assertEqual(btc["share"], round((734_261.0 + after + 9e9 / 60_000) / etf.supply_at(NOW) * 100, 3))
        self.assertNotIn("quarters", btc)
        # Только открытый набор TFTC: сводок CoinMarketCap и CoinGecko нет.
        self.assertFalse(any("coinmarketcap" in u or "coingecko" in u for u in net.urls))
        self.assertFalse(hasattr(etf, "set_chain"))

    def test_implausible_rows_are_skipped(self):
        bad = {"days": [
            {"date": "2023-12-29", "netFlowUsd": 5e6, "perEtfUsd": {"IBIT": 5e6}},  # до запуска фондов
            {"date": "2026-11-30", "netFlowUsd": 5e6, "perEtfUsd": {"IBIT": 5e6}},  # из будущего
            {"date": "2026-10-10<script>", "netFlowUsd": 5e6, "perEtfUsd": {"IBIT": 5e6}},
            {"date": "2026-10-10", "netFlowUsd": 1e12, "perEtfUsd": None},  # $1 трлн за день
            {"date": "2026-10-11", "netFlowUsd": 1e6, "perEtfUsd": {"IBIT": 3e10}},  # фонд — $30 млрд
            {"date": "2026-10-12", "netFlowUsd": 9e6, "btcCloseUsd": 5, "perEtfUsd": {"IBIT": 7e6, "BITB": 1e6}},
        ], "updatedThrough": "2026-10-12"}
        btc = self.build(Net(**{"tftc.io/bitcoin-etf-flows/data.json": bad}))["coins"]["btc"]
        # Осталась одна строка: итог — сумма фондов (8, а не 9 из сводки), цена
        # 5 $ — не цена биткоина, берётся Binance.
        self.assertEqual([d[:2] for d in btc["days"]], [[D3, 8_000]])
        self.assertEqual(btc["days"][0][3], 62_000.0)

    def test_implausible_prices_and_holdings_are_dropped(self):
        # Цена со свечи за пределами правдоподобного — мусор; запас фонда
        # больше 5 млн BTC — ошибка в отчёте, запаса нет; дата с не-ASCII
        # цифрами — не дата (приложение её не приняло бы).
        kl = [[day_ms(D1), 0, 0, 0, "1e300"], [day_ms(D2), 0, 0, 0, "-5"], [day_ms(D3), 0, 0, 0, "62000"]]
        self.sec(dict(SEC, BITB={"n": "Bitwise", "fee": None, "q": {Q2: [9e9, None]}}))
        bad = dict(TFTC, updatedThrough="２０２６-10-12")
        btc = self.build(Net(**{"binance.vision/api/v3/klines": kl, "tftc.io/bitcoin-etf-flows/data.json": bad}))["coins"]["btc"]
        self.assertEqual([d[3] for d in btc["days"]], [60_000.0, 61_000.0, 62_000.0])  # цена из набора
        self.assertEqual(next(f for f in btc["funds"] if f["t"] == "BITB")["hold"], 0.0)
        self.assertEqual(btc["through"], "")

    def test_report_day_flow_is_already_in_the_report(self):
        # Поток самого дня отчёта уже в запасе на конец дня — второй раз не прибавляется.
        on_report = dict(TFTC, days=[{"date": "2026-06-30", "netFlowUsd": 6e8, "btcCloseUsd": 60_000,
                                      "perEtfUsd": {"IBIT": 6e8}}, *TFTC["days"]])
        kl = [*Net().routes["binance.vision/api/v3/klines"]]
        btc = self.build(Net(**{"tftc.io/bitcoin-etf-flows/data.json": on_report, "binance.vision/api/v3/klines": kl}))["coins"]["btc"]
        after = 100e6 / 60_000.5 - 20e6 / 61_000 + 62e6 / 62_000
        self.assertEqual(btc["funds"][0]["hold"], round(734_261.0 + after, 2))

    def test_fee_taken_in_coins_lowers_holdings(self):
        sec = {"X": {"n": "", "fee": 0.01, "q": {Q2: [1000.0, None]}}}
        self.sec(sec)
        x = self.build()["coins"]["btc"]["funds"][-1]
        self.assertEqual(x["t"], "X")
        self.assertEqual(x["fee"], 1.0)
        self.assertAlmostEqual(x["hold"], 1000.0 * (1 - 0.01 * (NOW - Q2) / (365 * 86400)), places=1)

    def test_tftc_price_when_binance_has_no_candle(self):
        kl = [[day_ms(Q2), 0, 0, 0, "60000"]]
        btc = self.build(Net(**{"binance.vision/api/v3/klines": kl}))["coins"]["btc"]
        self.assertEqual([d[3] for d in btc["days"]], [60_000.0, 61_000.0, 62_000.0])

    def test_holders_funds_and_companies(self):
        co = [["Strategy", "COMPANY", "US", "MSTR", 846_000.0, 1_782_777_600], "мусор"]
        with mock.patch.object(etf.wt_treasury, "companies", lambda: co):
            r = self.build()
        # Фонды — по запасу на сегодня (дата 0), компании — из SEC с датой отчёта.
        ibit = r["coins"]["btc"]["funds"][0]["hold"]
        self.assertEqual(r["holders"], [["Strategy", "COMPANY", "US", "MSTR", 846_000.0, 1_782_777_600],
                                        ["iShares Bitcoin Trust", "FUND", "US", "IBIT", ibit, 0],
                                        ["Fidelity Wise Origin Bitcoin Fund", "FUND", "US", "FBTC", 150_000.0, 0]])

    def test_companies_failure_keeps_funds(self):
        def boom():
            raise RuntimeError("sec")
        with mock.patch.object(etf.wt_treasury, "companies", boom):
            r = self.build()
        self.assertEqual([h[3] for h in r["holders"]], ["IBIT", "FBTC"])

    def test_no_tftc_is_no_coin_and_no_sec_keeps_flows(self):
        for bad in (None, b"{", {"days": "x"}, {"days": []}, ["x"]):
            etf._st = etf._State()
            self.assertEqual(self.build(Net(**{"tftc.io/bitcoin-etf-flows/data.json": bad})), {"ok": False, "error": "no_data"})
        # SEC недоступен — потоки есть, запасов нет.
        self.sec({})
        btc = self.build()["coins"]["btc"]
        self.assertEqual([f["t"] for f in btc["funds"]], ["IBIT", "BITB"])
        self.assertEqual(sum(f["hold"] for f in btc["funds"]), 0)

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

    def test_cme_implausible_rows_are_skipped(self):
        good = {"cftc_contract_market_code": "133741", "report_date_as_yyyy_mm_dd": "2026-10-06T00:00:00.000",
                **dict.fromkeys(etf.CME_FIELDS, "10")}
        rows = [good,
                {**good, "report_date_as_yyyy_mm_dd": "2016-01-05T00:00:00.000"},  # до фьючерсов CME
                {**good, "report_date_as_yyyy_mm_dd": "2027-01-05T00:00:00.000"},  # из будущего
                {**good, "report_date_as_yyyy_mm_dd": "2026-09-29T00:00:00.000", "open_interest_all": "-5"},
                {**good, "report_date_as_yyyy_mm_dd": "2026-09-22T00:00:00.000", "open_interest_all": "1e12"}]
        r = self.build(Net(**{"publicreporting.cftc.gov": rows}))
        self.assertEqual([w[0] for w in r["cme"]["btc"]], [1_791_244_800])
        etf._st = etf._State()  # без прошлой сборки: иначе её CME осталась бы на экране
        self.assertEqual(self.build(Net(**{"publicreporting.cftc.gov": rows[1:]}))["cme"], {})

    def test_coinbase_premium_without_broken_prices(self):
        # Цена-мусор на одной из бирж или «премия» в десятки процентов — сбой
        # цены: такого дня нет; живой премии нет, если одна из цен — мусор.
        candles = [[D1, 0, 0, 0, 60060.5], [D2, 0, 0, 0, 1e9], [D3, 0, 0, 0, 80_000], [D3 + 3600, 0, 0, 0, 62000]]
        r = self.build(Net(**{"products/BTC-USD/candles": candles, "products/BTC-USD/ticker": {"price": "0"}}))
        self.assertEqual(r["cbp"]["btc"]["days"], [[D1, 0.1]])
        self.assertIsNone(r["cbp"]["btc"]["now"])
        self.assertEqual(etf._premium(60_000, 50_000), None)  # 20 % — не премия
        self.assertEqual(etf._premium(60_060, 60_000), 0.1)
        self.assertIsNone(etf._premium(5.0, 5.0))  # «цена» 5 $ — не цена биткоина, хоть премия и 0
        self.assertIsNone(etf._premium(60_000, 2e7))

    def test_total_assets_by_day_from_tftc(self):
        days = [dict(d) for d in TFTC["days"]]
        days[1]["totalNetAssetsUsd"] = 105e9
        days[2]["totalNetAssetsUsd"] = 1e20  # мусор — мимо
        days[3]["totalNetAssetsUsd"] = 104e9
        btc = self.build(Net(**{"tftc.io/bitcoin-etf-flows/data.json": dict(TFTC, days=days)}))["coins"]["btc"]
        self.assertEqual(btc["tna"], [[D1, 105_000_000_000], [D3, 104_000_000_000]])
        # Доля — от свежих активов набора (D3 — последний день), по цене сейчас.
        self.assertEqual(btc["share"], round(104e9 / 62_000 / etf.supply_at(NOW) * 100, 3))

    def test_own_estimate_far_from_total_assets_is_logged(self):
        days = [dict(d) for d in TFTC["days"]]
        days[3]["totalNetAssetsUsd"] = 5e9  # сводка: ~80 тыс. BTC, своя оценка — ~890 тыс.
        logs = []
        with mock.patch.object(etf, "_log", logs.append):
            self.build(Net(**{"tftc.io/bitcoin-etf-flows/data.json": dict(TFTC, days=days)}))
        self.assertTrue(any(m.startswith("запас: свой") for m in logs), logs)

    def test_stale_total_assets_fall_back_to_own_estimate(self):
        days = [dict(d) for d in TFTC["days"]]
        days.insert(0, {"date": "2026-09-01", "netFlowUsd": 1e6, "btcCloseUsd": 60_000, "perEtfUsd": {"IBIT": 1e6},
                        "totalNetAssetsUsd": 99e9})
        btc = self.build(Net(**{"tftc.io/bitcoin-etf-flows/data.json": dict(TFTC, days=days)}))["coins"]["btc"]
        own = sum(f["aum"] for f in btc["funds"])
        self.assertEqual(btc["share"], round(own / 62_000 / etf.supply_at(NOW) * 100, 3))

    # ── Сбои частей и кэш ────────────────────────────────────────────────

    def test_failed_coin_comes_from_previous_build(self):
        first = self.build()
        etf._st.hit = (time.monotonic() - 99_999, first)
        r = self.build(Net(**{"tftc.io/bitcoin-etf-flows/data.json": None}))
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
        self.assertTrue(etf._allowed("https://data-api.binance.vision/api/v3/klines"))
        self.assertTrue(etf._allowed(etf.TFTC))
        for url in ("http://data-api.binance.vision/", "https://api.coinmarketcap.com/data-api/v3/",
                    "https://tftc.io/", "https://evil.tftc.io/", "http://www.tftc.io/bitcoin-etf-flows/data.json",
                    "https://api.coingecko.com/api/v3/", "https://169.254.169.254/", "https://evil.com/",
                    "https://user@data-api.binance.vision/", "https://data-api.binance.vision.evil.com/", "https://[",
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
            self.assertIsNone(etf._fetch("https://data-api.binance.vision/x", 5))
        with mock.patch.object(etf._opener, "open", lambda req, timeout=0: Resp(b"[1]")):
            self.assertEqual(etf._fetch("https://data-api.binance.vision/x", 5), b"[1]")

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
            return [[day_ms(D1), 0, 0, 0, "60000"]] * 1000

        with mock.patch.object(etf, "_fetch", Net(**{"binance.vision/api/v3/klines": kl}).fetch):
            self.assertEqual(etf._klines("BTCUSDT", 0), {D1: 60_000.0})
        self.assertEqual(len(calls), 6)

    def test_junk_everywhere_is_skipped(self):
        r = self.build(Net(**{
            "publicreporting.cftc.gov": [{"cftc_contract_market_code": "133741", "report_date_as_yyyy_mm_dd": 5},
                                         {"cftc_contract_market_code": "133741", "report_date_as_yyyy_mm_dd": "не дата"}],
            "products/BTC-USD/candles": {"message": "rate limited"},
            "binance.vision/api/v3/klines": ["мусор", [1], *Net().routes["binance.vision/api/v3/klines"]],
        }))
        self.assertEqual(len(r["coins"]["btc"]["days"]), 3)
        self.assertEqual((r["cme"], r["cbp"]), ({}, {}))
        # Мусор в наборе TFTC: строки без даты и не-словари пропускаются.
        junk = {"days": ["x", {"date": 5}, {"date": "не дата"}, {"date": "2026-10-10", "perEtfUsd": [1],
                                                                   "netFlowUsd": "1e6"}], "updatedThrough": "<b>"}
        etf._st = etf._State()
        btc = self.build(Net(**{"tftc.io/bitcoin-etf-flows/data.json": junk}))["coins"]["btc"]
        self.assertEqual([d[:2] for d in btc["days"]], [[D1, 1_000]])
        self.assertEqual(btc["through"], "")
        # Мусор в отчётах SEC: фонд без отчётов не попадает в фонды.
        self.sec(dict(SEC, BAD={"n": 5, "fee": None, "q": {}}))
        self.assertNotIn("BAD", [f["t"] for f in self.build()["coins"]["btc"]["funds"]])

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
                self.assertIsNone(etf._fetch("https://data-api.binance.vision/x", 5))

    def test_redirect_is_not_followed(self):
        self.assertIsNone(etf._NoRedirect().redirect_request(None, None, 302, "Found", {}, "https://evil.com/"))

    def test_clock_is_unix_seconds(self):
        self.assertLessEqual(abs(etf._now() - time.time()), 1)


if __name__ == "__main__":
    unittest.main()

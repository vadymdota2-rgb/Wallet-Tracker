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


class Net:
    """Подставная сеть. routes: часть адреса → ответ (bytes, объект или вызов)."""

    def __init__(self, **over):
        self.urls = []
        self.routes = {
            "binance.vision/api/v3/klines": [[day_ms(Q0), 0, 0, 0, "90000"], [day_ms(Q1), 0, 0, 0, "80000"],
                                             [day_ms(Q2), 0, 0, 0, "60000"], [day_ms(D1), 0, 0, 0, "60000.5"],
                                             [day_ms(D2), 0, 0, 0, "61000"], [day_ms(D3), 0, 0, 0, "62000"]],
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

    def test_quarters_and_holdings_from_sec(self):
        net = Net()
        r = self.build(net)
        self.assertTrue(r["ok"])
        btc = r["coins"]["btc"]
        # Цена отчётов — стоимость / монеты у IBIT; монеты FBTC — его стоимость по ней.
        fbtc_q2 = 9e9 / 60_000
        # Поток квартала — изменение запаса (первый отчёт — от нуля) по средней
        # цене квартала; концы 31.12 — 90 000, 31.03 — 80 000, 30.06 — 60 000.
        self.assertEqual(btc["quarters"], [
            [Q0, round(700_000 * 90_000 / 1000), 700_000.0, 90_000.0, [63_000_000, None]],
            [Q1, round((50_000 + 150_000) * 80_000 / 1000), 200_000.0, 80_000.0, [4_000_000, 12_000_000]],
            [Q2, round((-15_739 + fbtc_q2 - 150_000) * 60_000 / 1000), round(-15_739 + fbtc_q2 - 150_000, 2), 60_000.0,
             [-15_739 * 60, round((fbtc_q2 - 150_000) * 60)]],
        ])
        ibit, fbtc = btc["funds"]
        self.assertEqual((ibit["t"], ibit["hold"], ibit["asof"], ibit["c"], ibit["fee"]), ("IBIT", 734_261.0, Q2, "US", None))
        self.assertEqual(ibit["aum"], round(734_261.0 * 62_000))
        self.assertEqual(ibit["cumc"], 734_261.0)
        self.assertEqual(fbtc["hold"], round(fbtc_q2, 2))
        self.assertNotIn("src", ibit)
        # По дням — только своя цепочка; её нет — дней нет.
        self.assertEqual(btc["days"], [])
        self.assertEqual((btc["asof"], btc["px"]), (Q2, 62_000.0))
        self.assertEqual(btc["share"], round((734_261.0 + fbtc_q2) / etf.supply_at(NOW) * 100, 3))
        # Снимка-базы нет; сводка CMC — только за днями (её нет — дней нет).
        self.assertFalse(any("coingecko" in u for u in net.urls))
        self.assertFalse(hasattr(etf, "BASE_FILE"))
        self.assertFalse(os.path.exists(os.path.join(ROOT, "data", "etf_base.json")))

    def cmc_net(self):
        pts = [{"date": "0", "IBIT": {"usd": 9e9, "btc": 1}},  # строка итогов — не день
               {"date": str(D1 * 1000), "IBIT": {"usd": 100e6, "btc": 1600.0}, "BITB": {"usd": 5e6, "btc": 80.0},
                "CHINAAMC": {"usd": 7e6, "btc": 1.0}},
               {"date": str(D2 * 1000), "IBIT": {"usd": -20e6, "btc": -320.0}, "BITB": {"usd": 3e6, "btc": 50.0}},
               {"date": str(D3 * 1000), "IBIT": {"usd": None}}]  # фонды ещё не отчитались
        return Net(**{"etf/detail/netflow/list": {"data": {"points": pts, "totalCount": len(pts)}}})

    def test_days_from_cmc_until_wallets_are_labeled(self):
        sec = dict(SEC, BITB={"n": "Bitwise Bitcoin ETF", "fee": None, "q": {Q2: [36_000.0, None]}})
        self.sec(sec)
        btc = self.build(self.cmc_net())["coins"]["btc"]
        order = [f["t"] for f in btc["funds"]]
        # Дни — из сводки, только фонды США из SEC (гонконгского нет), пустой день — нет.
        self.assertEqual([d[0] for d in btc["days"]], [D1, D2])
        self.assertEqual(btc["days"][0][1], 105_000)
        self.assertEqual(btc["days"][0][4][order.index("BITB")], 5_000)
        self.assertEqual({f["t"]: f["days"] for f in btc["funds"]}, {"IBIT": "cmc", "FBTC": "cmc", "BITB": "cmc"})

    def test_fully_labeled_fund_days_come_from_chain(self):
        # BITB размечен целиком (опубликованные кошельки): его дни — цепочка,
        # с T+1; IBIT размечен на часть — дни из сводки.
        tue, wed = 20_732 * 86400, 20_733 * 86400  # вторник и среда за неделю до «сейчас»
        thu = etf.settle_day(wed // 86400) * 86400  # деньги среды доходят в четверг
        sec = dict(SEC, BITB={"n": "Bitwise Bitcoin ETF", "fee": None, "q": {Q2: [36_000.0, None]}})
        self.sec(sec)
        chain = {"BITB": {"from": tue - 10 * 86400, "exact": True, "hold": 36_000.0, "days": {thu: 7.0}},
                 "IBIT": {"from": tue - 10 * 86400, "hold": 1_000.0, "days": {thu: 500.0}}}
        etf.set_chain(lambda: chain)
        self.addCleanup(etf.set_chain, None)
        pts = [{"date": str(tue * 1000), "IBIT": {"usd": 100e6, "btc": 1600.0}, "BITB": {"usd": 5e6, "btc": 80.0}},
               {"date": str(wed * 1000), "IBIT": {"usd": -20e6, "btc": -320.0}, "BITB": {"usd": 3e6, "btc": 50.0}}]
        net = Net(**{"etf/detail/netflow/list": {"data": {"points": pts, "totalCount": 2}},
                     "binance.vision/api/v3/klines": [[day_ms(Q0), 0, 0, 0, "90000"], [day_ms(Q1), 0, 0, 0, "80000"],
                                                      [day_ms(Q2), 0, 0, 0, "60000"], [day_ms(tue), 0, 0, 0, "61000"],
                                                      [day_ms(wed), 0, 0, 0, "62000"]]})
        with mock.patch.object(etf.wt_treasury, "companies", list):
            btc = self.build(net)["coins"]["btc"]
        order = [f["t"] for f in btc["funds"]]
        src = {f["t"]: f["days"] for f in btc["funds"]}
        self.assertEqual((src["BITB"], src["IBIT"]), ("chain", "cmc"))
        d1, d2, *after = btc["days"]
        # Первый день истории (без «прошлого окна») — по сводке; среда — по
        # цепочке: монеты, дошедшие в четверг (T+1), по цене среды.
        self.assertEqual(d1[4][order.index("BITB")], 5_000)
        self.assertEqual(d2[4][order.index("BITB")], round(7.0 * 62_000 / 1000))
        self.assertEqual(d2[4][order.index("IBIT")], -20_000)  # размечен на часть — из сводки
        # После сводки — только цепочка: у остальных фондов пусто.
        self.assertTrue(all(v is None for d in after for j, v in enumerate(d[4]) if j != order.index("BITB")))

    def test_fee_taken_in_coins_is_not_an_outflow(self):
        # Запас упал ровно на комиссию — потока нет.
        fee = 0.01
        q0, q1 = 1000.0, 1000.0 * (1 - fee * (Q1 - Q0) / (365 * 86400))
        sec = {"X": {"n": "", "fee": fee, "q": {Q0: [q0, None], Q1: [q1, None]}}}
        flows, _, last = etf._quarters(sec, {Q0: 80_000.0, Q1: 80_000.0})
        self.assertAlmostEqual(flows[Q1]["X"][1], 0.0, delta=0.05)
        self.assertEqual(last["X"], (q1, Q1))

    def test_gbtc_before_etf_is_the_starting_point(self):
        start = etf.calendar.timegm(etf.time.strptime(etf.wt_treasury.ETF_FROM, "%Y-%m-%d"))
        sec = {"GBTC": {"n": "", "fee": None, "q": {start: [619_525.9, None], Q0: [200_000.0, None]}}}
        flows, _, _ = etf._quarters(sec, {start: 42_000.0, Q0: 90_000.0})
        self.assertNotIn(start, flows)  # запас траста до ETF — точка отсчёта, не приток
        self.assertAlmostEqual(flows[Q0]["GBTC"][1], 200_000.0 - 619_525.9)

    def test_chain_holdings_count_before_any_trading_day(self):
        # BITB разметили только что: торговых дней по цепочке ещё нет, а запас
        # уже по его кошелькам.
        sec = dict(SEC, BITB={"n": "Bitwise Bitcoin ETF", "fee": None, "q": {Q2: [36_000.0, None]}})
        self.sec(sec)
        etf.set_chain(lambda: {"BITB": {"from": NOW, "exact": True, "hold": 36_400.0, "days": {}}})
        self.addCleanup(etf.set_chain, None)
        btc = self.build()["coins"]["btc"]
        bitb = next(f for f in btc["funds"] if f["t"] == "BITB")
        self.assertEqual((bitb["hold"], bitb["src"]), (36_400.0, "chain"))
        self.assertEqual(btc["days"], [])

    def test_partial_labels_add_to_report(self):
        # IBIT: размечено несколько кошельков (мало от запаса) — их движения
        # после отчёта прибавляются, фонд помечен «по части кошельков».
        chain = {"IBIT": {"from": D1 - 10 * 86400, "hold": 1_200.0, "days": {D2: 10.0, Q2 - 86400: 999.0}}}
        etf.set_chain(lambda: chain)
        self.addCleanup(etf.set_chain, None)
        ibit = self.build()["coins"]["btc"]["funds"][0]
        self.assertEqual((ibit["t"], ibit["src"], ibit.get("part")), ("IBIT", "chain", True))
        self.assertEqual(ibit["hold"], 734_261.0 + 10.0)  # до отчёта — не прибавляется
        # Разметка явно неверна (монет больше запаса) — не прибавляется.
        chain["IBIT"]["hold"] = 2_000_000.0
        etf._st = etf._State()
        ibit = self.build()["coins"]["btc"]["funds"][0]
        self.assertEqual((ibit["hold"], ibit.get("src")), (734_261.0, None))

    def test_chain_fund_has_days_and_holdings_after_report(self):
        # BITB публикует кошельки сам: запас — по ним, дни — по цепочке.
        sec = dict(SEC, BITB={"n": "Bitwise Bitcoin ETF", "fee": None, "q": {Q2: [None, 36_000 * 60_000]}})
        self.sec(sec)
        chain = {"BITB": {"from": D1 - 10 * 86400, "exact": True, "hold": 36_500.0,
                          "days": {D2: 12.0, D3: -2.0}}}
        etf.set_chain(lambda: chain)
        self.addCleanup(etf.set_chain, None)
        btc = self.build()["coins"]["btc"]
        bitb = next(f for f in btc["funds"] if f["t"] == "BITB")
        self.assertEqual((bitb["src"], bitb["hold"]), ("chain", 36_500.0))
        i = [f["t"] for f in btc["funds"]].index("BITB")
        self.assertTrue(btc["days"])
        self.assertTrue(all(len(d[4]) == len(btc["funds"]) for d in btc["days"]))
        self.assertTrue(all(v is None for d in btc["days"] for j, v in enumerate(d[4]) if j != i))

    def test_holders_funds_and_companies(self):
        co = [["Strategy", "COMPANY", "US", "MSTR", 846_000.0, 1_782_777_600], "мусор"]
        with mock.patch.object(etf.wt_treasury, "companies", lambda: co):
            r = self.build()
        # Фонды — по запасу из отчёта (с датой отчёта), компании — из SEC.
        self.assertEqual(r["holders"], [["Strategy", "COMPANY", "US", "MSTR", 846_000.0, 1_782_777_600],
                                        ["iShares Bitcoin Trust", "FUND", "US", "IBIT", 734_261.0, Q2],
                                        ["Fidelity Wise Origin Bitcoin Fund", "FUND", "US", "FBTC", 150_000.0, Q2]])

    def test_companies_failure_keeps_funds(self):
        def boom():
            raise RuntimeError("sec")
        with mock.patch.object(etf.wt_treasury, "companies", boom):
            r = self.build()
        self.assertEqual([h[3] for h in r["holders"]], ["IBIT", "FBTC"])

    def test_no_sec_or_no_prices_is_no_coin(self):
        self.sec({})
        self.assertEqual(self.build(), {"ok": False, "error": "no_data"})
        self.sec(SEC)
        self.assertEqual(self.build(Net(**{"binance.vision/api/v3/klines": []})), {"ok": False, "error": "no_data"})

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
        self.sec({})
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
        self.assertTrue(etf._allowed("https://data-api.binance.vision/api/v3/klines"))
        self.assertTrue(etf._allowed("https://api.coinmarketcap.com/data-api/v3/etf/detail/netflow/list"))
        for url in ("http://data-api.binance.vision/", "https://coinmarketcap.com/", "https://evil.coinmarketcap.com/",
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
            return [[day_ms(D1), 0, 0, 0, "1"]] * 1000

        with mock.patch.object(etf, "_fetch", Net(**{"binance.vision/api/v3/klines": kl}).fetch):
            self.assertEqual(etf._klines("BTCUSDT", 0), {D1: 1.0})
        self.assertEqual(len(calls), 6)

    def test_junk_everywhere_is_skipped(self):
        r = self.build(Net(**{
            "publicreporting.cftc.gov": [{"cftc_contract_market_code": "133741", "report_date_as_yyyy_mm_dd": 5},
                                         {"cftc_contract_market_code": "133741", "report_date_as_yyyy_mm_dd": "не дата"}],
            "products/BTC-USD/candles": {"message": "rate limited"},
            "binance.vision/api/v3/klines": ["мусор", [1], *Net().routes["binance.vision/api/v3/klines"]],
        }))
        self.assertEqual(len(r["coins"]["btc"]["quarters"]), 3)
        self.assertEqual((r["cme"], r["cbp"]), ({}, {}))
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

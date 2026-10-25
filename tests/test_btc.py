"""Биткоин-часть сервера (wt_btc.py) на настоящей SQLite со схемой бота
(npm test): потоки бирж, крупные ордера, рейтинг, карточка кошелька,
написание адресов и проверка параметров маршрутов.

Числа в проверках посчитаны вручную — тест сверяет смысл, а не повторяет
формулу модуля.
"""
import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
from test_btc_stale import SCHEMA  # noqa: E402 — схема, как у бота

import whale_api as api  # noqa: E402 — подключает модуль (setup)
import wt_btc as btc  # noqa: E402

NOW = 1_792_800_000
SAT = 10**8
NANO = 10**9


def _tx(n: int) -> str:
    return f"{n:064x}"


class BtcBase(unittest.TestCase):
    def setUp(self):
        fd, self.db = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.con = sqlite3.connect(self.db)
        self.con.executescript(SCHEMA)
        self.con.execute("CREATE TABLE btc_etf_addr (address TEXT PRIMARY KEY, fund TEXT NOT NULL, how TEXT NOT NULL,"
                         " at INTEGER NOT NULL DEFAULT 0)")
        self.con.execute("CREATE TABLE btc_case (lower TEXT PRIMARY KEY, addr TEXT NOT NULL)")
        # Свежий блок с ценой $80 000: сервер берёт её, а не Coinbase.
        self.con.execute("INSERT INTO btc_blocks(height, hash, ts, price_nanos, at) VALUES(900000, 'h', ?, ?, ?)",
                         (NOW - 300, 80_000 * NANO, NOW))
        self.con.execute("INSERT INTO btc_labels VALUES('3Binance', 'Binance', 'seed', 0)")
        self.con.execute("INSERT INTO btc_labels VALUES('3OKX', 'OKX', 'seed', 0)")
        self.con.commit()
        self.n = 0
        for p in (mock.patch.object(btc, "BTC_DB", self.db), mock.patch.object(btc, "now", lambda: NOW),
                  mock.patch.object(btc, "get_json", side_effect=AssertionError("в сеть не ходим"))):
            p.start()
            self.addCleanup(p.stop)
        btc._BTC.clear()
        self.addCleanup(btc._BTC.clear)

    def tearDown(self):
        self.con.close()
        os.unlink(self.db)

    def move(self, wallet, kind, sats, ago, ex="Binance", price=80_000, height=1):
        self.n += 1
        self.con.execute(
            "INSERT INTO btc_moves(txid, height, ts, kind, wallet, ex, sats, usd_nanos, price_nanos) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (_tx(self.n), height, NOW - ago, kind, wallet, ex, sats, sats * price * NANO // SAT, price * NANO))
        self.con.commit()
        return _tx(self.n)

    def flow(self, ago, ex, in_btc, out_btc, nin=1, nout=1):
        self.con.execute("INSERT INTO btc_flow VALUES(?,?,?,?,?,?)",
                         (NOW - ago, ex, round(in_btc * SAT), round(out_btc * SAT), nin, nout))
        self.con.commit()


class FlowTest(BtcBase):
    def test_windows_sum_only_their_own_blocks(self):
        self.flow(600, "Binance", 1, 4)            # 10 минут назад: во всех окнах
        self.flow(2 * 3600, "OKX", 3, 0)           # 2 часа: не в часовом
        self.flow(2 * 86400, "Binance", 0, 10)     # 2 суток: только неделя и месяц
        self.flow(40 * 86400, "Binance", 50, 50)   # за месяцем: нигде
        r = btc._btc_flow_build()
        self.assertTrue(r["ok"])
        w1, w6, w24, w7d, w30 = (r["wins"][k] for k in ("1", "6", "24", "168", "720"))
        self.assertEqual((w1["in"], w1["out"], w1["net"]), (1.0, 4.0, 3.0))
        self.assertEqual((w6["in"], w6["out"], w6["net"]), (4.0, 4.0, 0.0))
        self.assertEqual((w24["in"], w24["out"]), (4.0, 4.0))
        self.assertEqual((w7d["in"], w7d["out"], w7d["net"]), (4.0, 14.0, 10.0))
        self.assertEqual(w30["net"], 10.0)
        self.assertEqual((w6["nin"], w6["nout"]), (2, 2))
        # Биржи — крупнейшие по обороту первыми.
        self.assertEqual([e["ex"] for e in w7d["ex"]], ["Binance", "OKX"])
        self.assertEqual(w7d["ex"][0], {"ex": "Binance", "in": 1.0, "out": 14.0})

    def test_trend_line_starts_at_zero_and_ends_at_the_net(self):
        self.flow(20 * 3600, "Binance", 0, 2)
        self.flow(3 * 3600, "Binance", 5, 0)
        w = btc._btc_flow_build()["wins"]["24"]
        self.assertEqual(len(w["tr"]), 25)
        self.assertEqual(w["tr"][0], 0.0)
        self.assertEqual(w["tr"][-1], w["net"])
        self.assertEqual(w["net"], -3.0)
        # Сначала вывод (+2), потом завод (−5): линия поднимается, потом падает.
        self.assertEqual(max(w["tr"]), 2.0)
        # Месяц из суток данных: линия — от первого блока, а не плоская черта
        # с обрывом в самом конце.
        m = btc._btc_flow_build()["wins"]["720"]
        self.assertEqual(m["tr"][1], 2.0)

    def test_window_longer_than_the_scanner_is_marked_partial(self):
        self.flow(3 * 86400, "Binance", 1, 1)
        r = btc._btc_flow_build()
        self.assertEqual(r["since"], NOW - 3 * 86400)
        self.assertTrue(r["wins"]["24"]["full"])
        self.assertTrue(r["wins"]["168"]["full"] is False)
        self.assertFalse(r["wins"]["720"]["full"])

    def test_reply_tells_the_last_block_price_and_labels(self):
        r = btc._btc_flow_build()
        self.assertEqual((r["height"], r["at"], r["price"], r["labels"]), (900000, NOW - 300, 80_000.0, 2))

    def test_no_database_is_no_data(self):
        with mock.patch.object(btc, "BTC_DB", self.db + ".none"):
            self.assertEqual(btc._btc_flow_build(), {"ok": False, "error": "no_data"})


class PriceTest(BtcBase):
    def test_stale_block_asks_coinbase(self):
        self.con.execute("UPDATE btc_blocks SET ts = ?", (NOW - 3 * 3600,))
        self.con.commit()
        c = btc._btc_open()
        try:
            with mock.patch.object(btc, "get_json", return_value={"data": {"amount": "91000"}}):
                self.assertEqual(btc._btc_price(c), 91_000.0)
        finally:
            c.close()

    def test_block_just_under_two_hours_is_still_fresh(self):
        self.con.execute("UPDATE btc_blocks SET ts = ?", (NOW - 7199,))
        self.con.commit()
        c = btc._btc_open()
        try:
            self.assertEqual(btc._btc_price(c), 80_000.0)
        finally:
            c.close()


class BigTest(BtcBase):
    def test_rows_are_wallet_and_exchange_with_sum_count_and_biggest_tx(self):
        self.move("bc1qa", 1, 2 * SAT, 3600)
        big_tx = self.move("bc1qa", 1, 5 * SAT, 1800)
        self.move("bc1qa", 1, 1 * SAT, 900, ex="OKX")
        self.move("bc1qb", 1, 3 * SAT, 600)
        r = btc._btc_big_build("24h", "buy", 0.2)
        rows = [(x["a"], x["ex"], x["btc"], x["n"]) for x in r["rows"]]
        self.assertEqual(rows, [("bc1qa", "Binance", 7.0, 2), ("bc1qb", "Binance", 3.0, 1), ("bc1qa", "OKX", 1.0, 1)])
        top = r["rows"][0]
        self.assertEqual((top["tx"], top["t"], top["v"], top["px"]), (big_tx, NOW - 1800, 560_000.0, 80_000.0))
        self.assertEqual(r["tot"]["buy"], {"n": 4, "btc": 11.0, "v": 880_000.0})
        self.assertEqual(r["tot"]["sell"], {"n": 0, "btc": 0.0, "v": 0.0})
        self.assertEqual(r["byEx"][0], {"ex": "Binance", "n": 3, "w": 2, "btc": 10.0, "v": 800_000.0})
        self.assertEqual([e["ex"] for e in r["byEx"]], ["Binance", "OKX"])
        self.assertEqual((r["win"], r["side"], r["min"], r["at"]), ("24h", "buy", 0.2, NOW - 300))

    def test_threshold_window_and_side(self):
        self.move("bc1qa", 1, SAT // 2, 600)          # 0,5 BTC — ниже порога 1
        self.move("bc1qb", 1, 2 * SAT, 2 * 3600)     # вне часа
        self.move("bc1qc", 2, 3 * SAT, 600)          # продажа
        self.assertEqual([x["a"] for x in btc._btc_big_build("24h", "buy", 1)["rows"]], ["bc1qb"])
        self.assertEqual([x["a"] for x in btc._btc_big_build("1h", "buy", 0.2)["rows"]], ["bc1qa"])
        self.assertEqual([x["a"] for x in btc._btc_big_build("24h", "sell", 0.2)["rows"]], ["bc1qc"])
        # Ровно на пороге — в списке.
        self.move("bc1qd", 1, SAT, 600)
        self.assertIn("bc1qd", [x["a"] for x in btc._btc_big_build("24h", "buy", 1)["rows"]])

    def test_transit_wallets_are_not_buyers_or_sellers(self):
        # Вывел 10 и вернул 9,5 (95 %) — гоняет монеты, не покупает.
        self.move("bc1qtransit", 1, 10 * SAT, 3000)
        self.move("bc1qtransit", 2, 95 * SAT // 10, 2000)
        # Вывел 10, вернул 8 (80 %) — покупатель; и продавцом не считается.
        self.move("bc1qkeeper", 1, 10 * SAT, 3000)
        self.move("bc1qkeeper", 2, 8 * SAT, 2000)
        buy = btc._btc_big_build("24h", "buy", 0.2)
        self.assertEqual([x["a"] for x in buy["rows"]], ["bc1qkeeper"])
        # Итоги — по тем же правилам, что строки: транзит не считается ни там, ни там.
        self.assertEqual((buy["tot"]["buy"]["n"], buy["tot"]["sell"]["n"]), (1, 0))
        sell = btc._btc_big_build("24h", "sell", 0.2)
        self.assertEqual(sell["rows"], [])
        # Переводы без биржи в транзит и в доску не идут.
        self.move("bc1qself", 1, 10 * SAT, 3000)
        self.move("bc1qself", 2, 10 * SAT, 2000, ex="")
        self.assertIn("bc1qself", [x["a"] for x in btc._btc_big_build("24h", "buy", 0.2)["rows"]])
        self.assertNotIn("bc1qself", [x["a"] for x in btc._btc_big_build("24h", "sell", 0.2)["rows"]])

    def test_exchange_addresses_and_services_drop_out_but_base_wallets_stay(self):
        self.move("3Learned", 1, 5 * SAT, 600)        # позже узнан как биржевой
        self.con.execute("INSERT INTO btc_labels VALUES('3Learned', 'Binance', 'sweep', 0)")
        self.move("bc1qsvc", 1, 5 * SAT, 600)         # 1000 транзакций — сервис
        self.move("bc1qbig", 1, 5 * SAT, 600)         # сервис, но в базе владельца
        self.move("bc1qok", 1, 5 * SAT, 600)
        self.con.executemany("INSERT INTO btc_addr VALUES(?,?,?,?)",
                             [("bc1qsvc", 1000, 0, NOW), ("bc1qbig", 5000, 7 * SAT, NOW), ("bc1qok", 999, SAT, NOW)])
        self.con.execute("INSERT INTO btc_watch VALUES('bc1qbig', 'import', 0)")
        self.con.execute("INSERT INTO btc_etf_addr VALUES('bc1qok', 'IBIT', 'import', 0)")
        self.con.commit()
        rows = {x["a"]: x for x in btc._btc_big_build("24h", "buy", 0.2)["rows"]}
        self.assertEqual(set(rows), {"bc1qbig", "bc1qok"})
        self.assertEqual((rows["bc1qbig"]["bal"], rows["bc1qbig"]["txs"], rows["bc1qbig"]["base"]), (7.0, 5000, True))
        self.assertEqual(rows["bc1qok"]["etf"], "IBIT")
        self.assertNotIn("base", rows["bc1qok"])

    def test_exchange_filter_narrows_rows_and_total_but_not_the_exchange_list(self):
        self.move("bc1qa", 1, 2 * SAT, 600)
        self.move("bc1qb", 1, 3 * SAT, 600, ex="OKX")
        self.move("bc1qc", 2, 4 * SAT, 600, ex="Kraken")   # продажа — не в списке бирж покупок
        r = btc._btc_big_build("24h", "buy", 0.2, "OKX")
        self.assertEqual([x["a"] for x in r["rows"]], ["bc1qb"])
        self.assertEqual(r["tot"]["buy"]["btc"], 3.0)
        self.assertEqual({e["ex"] for e in r["byEx"]}, {"Binance", "OKX"})
        self.assertEqual(r["ex"], "OKX")

    def test_rows_are_capped(self):
        for i in range(btc.BTC_ROWS + 5):
            self.move(f"bc1q{i:04d}", 1, SAT + i, 600)
        r = btc._btc_big_build("24h", "buy", 0.2)
        self.assertEqual(len(r["rows"]), btc.BTC_ROWS)
        self.assertEqual(r["tot"]["buy"]["n"], btc.BTC_ROWS + 5)
        self.assertEqual(r["rows"][0]["a"], f"bc1q{btc.BTC_ROWS + 4:04d}")


class BookTest(unittest.TestCase):
    def test_average_cost_realized_and_open_result(self):
        # Купил 1 по 50k и 1 по 70k (средняя 60k), продал 1 по 90k: +30k
        # зафиксировано; остаток 1 BTC по 60k при цене 80k: +20k.
        moves = [(1, SAT, 50_000 * NANO, 100, "Binance"), (1, SAT, 70_000 * NANO, 200, "Binance"),
                 (2, SAT, 90_000 * NANO, 86_400 + 300, "OKX")]
        b = btc._btc_book(moves, 80_000.0)
        self.assertEqual((b["pnl"], b["btc"], b["avg"], b["inv"]), (50_000.0, 1.0, 60_000.0, 120_000.0))
        self.assertEqual(b["roi"], round(50_000 / 120_000 * 100, 2))
        self.assertEqual((b["buys"], b["sells"], b["tr"], b["bought"], b["sold"]), (2, 1, 3, 2.0, 1.0))
        # В плюсе — обе покупки дешевле нынешних 80k.
        self.assertEqual(b["win"], 100)
        self.assertEqual((b["ex"], b["days"], b["first"], b["last"]), ("Binance", 2, 100, 86_700))

    def test_selling_more_than_seen_bought_does_not_invent_profit(self):
        moves = [(1, SAT, 60_000 * NANO, 100, "Binance"), (2, 3 * SAT, 90_000 * NANO, 200, "Binance")]
        b = btc._btc_book(moves, 90_000.0)
        self.assertEqual((b["pnl"], b["btc"], b["sold"]), (30_000.0, 0.0, 3.0))

    def test_win_rate_counts_buys_cheaper_than_now(self):
        moves = [(1, SAT, 70_000 * NANO, 1, "B"), (1, SAT, 90_000 * NANO, 2, "B"), (1, SAT, 80_000 * NANO, 3, "B")]
        self.assertEqual(btc._btc_book(moves, 80_000.0)["win"], 33)

    def test_no_price_now_leaves_open_result_out(self):
        b = btc._btc_book([(1, SAT, 60_000 * NANO, 1, "B")], 0.0)
        self.assertEqual((b["pnl"], b["roi"], b["win"]), (0.0, 0.0, 0))

    def test_only_sells_is_not_a_trader(self):
        self.assertIsNone(btc._btc_book([(2, SAT, 60_000 * NANO, 1, "B")], 80_000.0))
        self.assertIsNone(btc._btc_book([], 80_000.0))

    def test_negative_zero_is_plain_zero(self):
        # Убыток в полцента округляется до нуля — без минуса.
        b = btc._btc_book([(1, SAT, 80_000 * NANO + 4_000_000, 1, "B")], 80_000.0)
        self.assertEqual(str(b["pnl"]), "0.0")
        self.assertEqual(str(b["roi"]), "0.0")


class RankTest(BtcBase):
    def test_boards_sort_and_skip_transfers_unpriced_and_old_moves(self):
        self.move("bc1qwin", 1, 2 * SAT, 5 * 86400, price=60_000)   # +40k
        self.move("bc1qwin", 1, 9 * SAT, 4 * 86400, price=0)        # без цены — не в запас
        self.move("bc1qroi", 1, SAT // 2, 5 * 86400, price=40_000)  # +20k, ROI 100 %
        self.move("bc1qloss", 1, SAT, 5 * 86400, price=90_000)      # −10k
        self.move("bc1qloss", 1, 10 * SAT, 5 * 86400, ex="")        # перевод — не сделка
        self.move("bc1qzero", 1, 9 * SAT, 5 * 86400, price=0)       # без цены — не сделка
        self.move("bc1qold", 1, SAT, 40 * 86400, price=10_000)      # за окном
        r = btc._btc_rank_build(30)
        self.assertTrue(r["ok"])
        self.assertEqual(r["n"], 3)
        self.assertEqual([b["a"] for b in r["pnl"]], ["bc1qwin", "bc1qroi", "bc1qloss"])
        self.assertEqual([b["a"] for b in r["roi"]], ["bc1qroi", "bc1qwin", "bc1qloss"])
        self.assertEqual([b["a"] for b in r["act"]], ["bc1qwin", "bc1qloss", "bc1qroi"])
        self.assertEqual(r["pnl"][-1]["btc"], 1.0)
        self.assertEqual(r["pnl"][0]["btc"], 2.0)
        self.assertEqual((r["price"], r["days"]), (80_000.0, 30))
        self.assertEqual(btc._btc_rank_build(90)["n"], 4)

    def test_board_rows_carry_balance_and_fund(self):
        self.move("bc1qa", 1, SAT, 600)
        self.con.execute("INSERT INTO btc_addr VALUES('bc1qa', 3, 250000000, ?)", (NOW,))
        self.con.execute("INSERT INTO btc_etf_addr VALUES('bc1qa', 'FBTC', 'seed', 0)")
        self.con.commit()
        b = btc._btc_rank_build(30)["pnl"][0]
        self.assertEqual((b["bal"], b["etf"]), (2.5, "FBTC"))

    def test_exchange_addresses_are_not_traders(self):
        self.move("3Binance", 1, SAT, 600)
        self.assertEqual(btc._btc_rank_build(30)["n"], 0)

    def test_ttl_and_warm_jobs(self):
        self.assertEqual((btc.btc_rank_ttl(30), btc.btc_rank_ttl(90)), (120.0, 600.0))
        keys = [j[1] for j in btc.warm_jobs()]
        self.assertEqual(keys[:5], ["flow", ("rank", 30), ("rank", 90), ("rank", 180), ("rank", 365)])
        # Крупные ордера готовы заранее: каждое окно и сторона, порог по умолчанию.
        self.assertEqual(keys[5:], [("big", w, side, 0.2, "") for w in ("1h", "6h", "24h", "7d", "30d")
                                    for side in ("buy", "sell")])
        big30 = next(j for j in btc.warm_jobs() if j[1] == ("big", "30d", "sell", 0.2, ""))
        self.assertEqual((big30[2], big30[3]()["win"], big30[3]()["side"]), (300.0, "30d", "sell"))
        self.move("bc1qa", 1, SAT, 600)
        self.assertEqual(btc.warm_jobs()[2][3]()["days"], 90)


class WalletTest(BtcBase):
    def test_card_has_book_moves_newest_first_and_label(self):
        self.move("bc1qa", 1, 2 * SAT, 3000, price=70_000)
        self.move("bc1qa", 2, SAT, 2000, ex="", price=75_000)        # перевод
        last = self.move("bc1qa", 2, SAT // 2, 1000, ex="OKX", price=90_000)
        r = btc._btc_wallet_build("bc1qa")
        self.assertEqual((r["ok"], r["addr"], r["ex"]), (True, "bc1qa", ""))
        self.assertEqual(r["moves"][0]["tx"], last)
        self.assertEqual([(m["buy"], m["btc"], m["ex"]) for m in r["moves"]],
                         [(False, 0.5, "OKX"), (False, 1.0, ""), (True, 2.0, "Binance")])
        # Итог — без перевода: купил 2 по 70k, продал 0,5 по 90k.
        self.assertEqual((r["book"]["buys"], r["book"]["sells"], r["book"]["btc"]), (1, 1, 1.5))
        self.assertEqual(r["moves"][0]["px"], 90_000.0)

    def test_card_shows_at_most_fifty_moves(self):
        for i in range(55):
            self.move("bc1qa", 1, SAT, 5000 - i)
        r = btc._btc_wallet_build("bc1qa")
        self.assertEqual(len(r["moves"]), 50)
        self.assertEqual(r["book"]["buys"], 55)

    def test_exchange_address_says_so(self):
        self.assertEqual(btc._btc_wallet_build("3OKX")["ex"], "OKX")


class CaseTest(BtcBase):
    def test_remembered_spelling_comes_back(self):
        btc.btc_remember_case("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")
        got = btc.btc_cases(["1bvbmseystwetqtfn5au4m4gfg7xjanvn2", "unknown"])
        self.assertEqual(got, {"1bvbmseystwetqtfn5au4m4gfg7xjanvn2": "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
                               "unknown": "unknown"})
        self.assertEqual(btc.btc_cases([]), {})

    def test_no_database_is_quiet(self):
        with mock.patch.object(btc, "BTC_DB", self.db + ".none"):
            btc.btc_remember_case("1Abc")
            self.assertEqual(btc.btc_cases(["1abc"]), {"1abc": "1abc"})
        self.assertFalse(os.path.exists(self.db + ".none"))


class ParamsTest(BtcBase):
    def test_route_params_are_normalized_before_the_cache_key(self):
        seen = []
        with mock.patch.object(btc, "cached_bg", lambda store, key, ttl, build: seen.append((key, ttl)) or {}):
            btc.btc_big("2y", "hold", 7, "")
            btc.btc_big("7d", "sell", 100, "OKX")
            btc.btc_rank(7)
            btc.btc_rank(365)
            btc.btc_flow()
        self.assertEqual([k for k, _ in seen], [("big", "24h", "buy", 0.2, ""), ("big", "7d", "sell", 100, "OKX"),
                                                ("rank", 30), ("rank", 365), "flow"])
        # Неделя и месяц крупных ордеров — раз в пять минут, короткие окна — раз в минуту.
        self.assertEqual([t for _, t in seen], [60.0, 300.0, 120.0, 600.0, 60.0])
        self.assertEqual([btc.btc_big_ttl(w) for w in ("1h", "6h", "24h", "7d", "30d")],
                         [60.0, 60.0, 60.0, 300.0, 300.0])

    def test_wallet_card_is_cached_per_address(self):
        self.move("bc1qa", 1, SAT, 600)
        first = btc.btc_wallet("bc1qa")
        self.move("bc1qa", 1, SAT, 500)
        self.assertIs(btc.btc_wallet("bc1qa"), first)
        self.assertEqual(len(btc.btc_wallet("bc1qb")["moves"]), 0)

    def test_setup_is_wired_from_whale_api(self):
        self.assertIs(api.btc_flow, btc.btc_flow)
        self.assertIs(api._BTC, btc._BTC)
        self.assertEqual(btc.BIG_WINDOWS, api.BIG_WINDOWS)
        self.assertEqual(btc.TREND_BUCKETS, api.TREND_BUCKETS)

    def test_concurrent_cold_requests_share_one_build(self):
        # Тяжёлый список без готового ответа: второй и третий запрос ждут
        # первую сборку, а не запускают свои (было — по сборке на запрос).
        calls = []

        def build():
            calls.append(1)
            time.sleep(0.3)
            return {"ok": True, "n": len(calls)}

        store: dict = {}
        got = []
        ts = [threading.Thread(target=lambda: got.append(api.cached_bg(store, "k", 60.0, build))) for _ in range(3)]
        for t in ts:
            t.start()
            time.sleep(0.02)
        for t in ts:
            t.join()
        self.assertEqual(len(calls), 1)
        self.assertEqual(got, [{"ok": True, "n": 1}] * 3)


if __name__ == "__main__":
    unittest.main()

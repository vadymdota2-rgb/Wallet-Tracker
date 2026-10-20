"""Альтсезон и сила биткоина (wt_dom): расчёт, сборка, защита — npm test.

Сеть подменена: Hyperliquid отвечает из словарей теста. Цены — простые ряды,
по которым ответ можно посчитать в уме.
"""
import io
import json
import math
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_dom as dom  # noqa: E402 — модуль лежит в корне репозитория

DAY = 86_400
T0 = 1_700_006_400  # 15 ноября 2023 г., начало суток UTC
NOW = T0 + 199 * DAY + 3600


def flat(n: int, px: float, grow: float = 1.0, start: int = T0) -> dict:
    """n дней с start: цена растёт в grow раз за день."""
    return {start + i * DAY: px * grow ** i for i in range(n)}


class Net:
    """Hyperliquid из теста: список монет с открытым интересом и дневные цены."""

    def __init__(self, oi: dict, px: dict):
        self.oi, self.px, self.calls = oi, px, []

    def __call__(self, url, body, timeout):
        self.calls.append(body)
        if body["type"] == "metaAndAssetCtxs":
            names = list(self.oi)
            return json.dumps([{"universe": [{"name": n} for n in names]},
                               [{"openInterest": str(self.oi[n]), "markPx": "1"} for n in names]]).encode()
        req = body["req"]
        start = req["startTime"] // 1000
        rows = [{"t": t * 1000, "c": str(v)} for t, v in sorted(self.px.get(req["coin"], {}).items()) if t >= start]
        return json.dumps(rows).encode()


class Base(unittest.TestCase):
    def setUp(self):
        dom._st = dom._State()
        dom._busy.clear()
        self.tmp = tempfile.mkdtemp()
        dom.set_cache_dir(self.tmp)
        for name, val in (("_now", lambda: NOW), ("_log", lambda m: None)):
            p = mock.patch.object(dom, name, val)
            p.start()
            self.addCleanup(p.stop)

    def run_build(self, net: Net) -> dict:
        with mock.patch.object(dom, "_fetch", net):
            return dom.build(sleep=lambda s: None)


# ── Расчёт ──────────────────────────────────────────────────────────────────

class ComputeTest(unittest.TestCase):
    def test_index_counts_coins_that_beat_bitcoin_over_90_days(self):
        n = 200
        px = {"BTC": flat(n, 100, 1.01), "ETH": flat(n, 5, 1.02)}
        alts = ["ETH"]
        # 20 монет: 15 растут быстрее биткоина, 5 — медленнее.
        for i in range(20):
            px[f"A{i}"] = flat(n, 1, 1.02 if i < 15 else 1.0)
            alts.append(f"A{i}")
        got = dom.compute(px, alts)
        last = got["rows"][-1]
        # ETH тоже быстрее: 16 из 21 → 76.
        self.assertEqual(last[1], round(100 * 16 / 21))
        # До 90-го дня индекса нет: не с чем сравнивать.
        self.assertIsNone(got["rows"][0][1])
        self.assertEqual(got["rows"][88][1], None)
        self.assertIsNotNone(got["rows"][89][1])
        # ETH/BTC — ровно отношение цен, цена BTC — закрытие.
        t = last[0]
        self.assertAlmostEqual(last[3], px["ETH"][t] / px["BTC"][t], places=6)
        self.assertEqual(last[4], round(px["BTC"][t], 2))
        # Монеты — по убыванию роста за 90 дней; биткоин — отдельно.
        self.assertEqual([c[0] for c in got["coins"][:2]], ["A0", "A1"])
        self.assertEqual(got["coins"][-1][1], 0.0)
        self.assertAlmostEqual(got["btc90"], (1.01 ** 90 - 1) * 100, places=1)

    def test_too_few_coins_is_no_index(self):
        n = 120
        px = {"BTC": flat(n, 100), **{f"A{i}": flat(n, 1, 1.01) for i in range(dom.MIN_IDX - 1)}}
        rows = dom.compute(px, [f"A{i}" for i in range(dom.MIN_IDX - 1)])["rows"]
        self.assertTrue(all(r[1] is None for r in rows))
        # Силы альтов нет без MIN_STR монет — и дней в ответе тоже.
        few = {"BTC": flat(n, 100), **{f"A{i}": flat(n, 1) for i in range(dom.MIN_STR - 1)}}
        self.assertIsNone(dom.compute(few, [f"A{i}" for i in range(dom.MIN_STR - 1)]))

    def test_strength_is_the_equal_weight_basket_against_bitcoin(self):
        n = 100
        px = {"BTC": flat(n, 100, 1.01)}
        alts = []
        for i in range(10):
            px[f"A{i}"] = flat(n, 1, 1.01 * 1.02 if i < 5 else 1.01 / 1.02)
            alts.append(f"A{i}")
        rows = dom.compute(px, alts)["rows"]
        # Половина на 2% в день сильнее биткоина, половина на 2% слабее — корзина стоит.
        self.assertTrue(all(abs(r[2] - 100) < 0.01 for r in rows))
        for a in alts[5:]:
            px[a] = flat(n, 1, 1.01)
        rows = dom.compute(px, alts)["rows"]
        # Теперь в среднем +1% в день к биткоину (логарифм): за 99 дней — e^(99·ln1.02/2).
        self.assertAlmostEqual(rows[-1][2], 100 * math.exp(99 * math.log(1.02) / 2), delta=0.5)

    def test_one_crazy_day_is_clipped(self):
        n = 100
        px = {"BTC": flat(n, 100), **{f"A{i}": flat(n, 1) for i in range(10)}}
        px["A0"] = {**px["A0"], T0 + 10 * DAY: 1e6}  # сбой цены: в миллион раз за день
        rows = dom.compute(px, [f"A{i}" for i in range(10)])["rows"]
        # Рост к биткоину урезан до CLIP: корзина сдвинулась не больше чем на e^(CLIP/10).
        self.assertLess(max(r[2] for r in rows), 100 * math.exp(dom.CLIP / 10) + 0.01)

    def test_limits_keep_the_answer_inside_what_the_app_accepts(self):
        n = 150
        # Каждая монета каждый день в e раз сильнее биткоина (сбой цен): сила
        # не уходит дальше e^STR_LOG от 100 — иначе приложение отвергло бы ответ.
        px = {"BTC": flat(n, 100), **{f"A{i}": flat(n, 1, math.e * 1.01) for i in range(10)}}
        rows = dom.compute(px, [f"A{i}" for i in range(10)])["rows"]
        self.assertLessEqual(max(r[2] for r in rows), 100 * math.exp(dom.STR_LOG) * 1.001)
        # Рост монеты больше GROW_MAX — сбой цены, монеты нет в списке.
        coins = dom.compute(px, [f"A{i}" for i in range(10)])["coins"]
        self.assertEqual(coins, [])
        # Биткоин дешевле BTC_MIN в какие-то дни — этих дней нет вовсе.
        btc = flat(n, 100)
        for d in range(100, 110):
            btc[T0 + d * DAY] = 0.5
        px = {"BTC": btc, "ETH": flat(n, 5), **{f"A{i}": flat(n, 1, 1.01) for i in range(10)}}
        rows = dom.compute(px, ["ETH", *[f"A{i}" for i in range(10)]])["rows"]
        days = {r[0] for r in rows}
        self.assertNotIn(T0 + 105 * DAY, days)
        self.assertTrue(all(r[4] >= dom.BTC_MIN for r in rows))
        # ETH/BTC вне пределов — этого дня ETH/BTC нет, а сам день есть.
        px["ETH"] = {**px["ETH"], T0 + 120 * DAY: 2_000.0}
        row = next(r for r in dom.compute(px, ["ETH", *[f"A{i}" for i in range(10)]])["rows"] if r[0] == T0 + 120 * DAY)
        self.assertIsNone(row[3])

    def test_no_bitcoin_is_nothing(self):
        self.assertIsNone(dom.compute({"ETH": flat(200, 1)}, ["ETH"]))
        self.assertIsNone(dom.compute({"BTC": flat(50, 1)}, []))

    def test_pegged_coin(self):
        end = T0 + 99 * DAY
        self.assertTrue(dom._pegged(flat(100, 1.0, 1.0001), end))
        self.assertFalse(dom._pegged(flat(100, 1.0, 1.01), end))


# ── Сборка ──────────────────────────────────────────────────────────────────

def market(n_alts: int = 20, days: int = 200) -> Net:
    oi = {"BTC": 1e10, "ETH": 5e9, "PAXG": 4e9, "USDE": 3e9}
    px = {"BTC": flat(days, 100, 1.01), "ETH": flat(days, 5, 1.02), "PAXG": flat(days, 2000, 1.005),
          "USDE": flat(days, 1.0, 1.00001)}
    for i in range(n_alts):
        oi[f"A{i}"] = 1e9 - i
        # Половина быстрее биткоина, половина медленнее (но не стоит на месте — не «привязана»).
        px[f"A{i}"] = flat(days, 1, 1.02 if i % 2 else 1.001)
    return Net(oi, px)


class BuildTest(Base):
    def test_build_ranks_by_open_interest_and_drops_gold_and_dollars(self):
        net = market()
        res = self.run_build(net)
        self.assertTrue(res["ok"])
        names = [c[0] for c in res["coins"]]
        self.assertNotIn("PAXG", names)
        self.assertNotIn("USDE", names)
        self.assertNotIn("BTC", names)
        self.assertIn("ETH", names)
        self.assertEqual(res["n"], 21)
        self.assertEqual(res["by"], "Hyperliquid")
        # Ответ — на диске: перезапуск отдаст его сразу.
        with open(os.path.join(self.tmp, "dom.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["v"]["rows"], res["rows"])

    def test_top_limits_the_basket(self):
        net = market(n_alts=dom.TOP + 30)
        res = self.run_build(net)
        self.assertEqual(res["n"], dom.TOP)
        # Цен спрашиваем не больше TOP + 10 альтов (с запасом на привязанные) и BTC.
        coins = {c["req"]["coin"] for c in net.calls if c["type"] == "candleSnapshot"}
        self.assertLessEqual(len(coins), dom.TOP + 11)

    def test_second_build_asks_only_the_last_days(self):
        net = market()
        self.run_build(net)
        net.calls.clear()
        self.run_build(net)
        starts = [c["req"]["startTime"] // 1000 for c in net.calls if c["type"] == "candleSnapshot"]
        self.assertTrue(starts)
        last = T0 + 199 * DAY
        self.assertTrue(all(s == last - dom.TAIL_DAYS * DAY for s in starts), starts)

    def test_prices_survive_restart(self):
        self.run_build(market())
        dom._st = dom._State()
        dom.set_cache_dir(self.tmp)
        net = market()
        self.run_build(net)
        starts = {c["req"]["startTime"] for c in net.calls if c["type"] == "candleSnapshot"}
        self.assertNotIn(0, starts)

    def test_coin_without_answer_keeps_old_prices(self):
        net = market()
        first = self.run_build(net)

        def broken(url, body, timeout):
            if body["type"] == "candleSnapshot" and body["req"]["coin"] == "A1":
                return None
            return net(url, body, timeout)
        with mock.patch.object(dom, "_fetch", broken):
            again = dom.build(sleep=lambda s: None)
        self.assertEqual(again["coins"], first["coins"])

    def test_pace_between_requests(self):
        slept = []
        with mock.patch.object(dom, "_fetch", market()):
            dom.build(sleep=slept.append)
        self.assertTrue(slept)
        self.assertTrue(all(s == dom.PACE for s in slept))

    def test_no_list_is_no_data_and_a_pause(self):
        with mock.patch.object(dom, "_fetch", lambda u, b, t: None):
            self.assertEqual(dom.build(sleep=lambda s: None), {"ok": False, "error": "no_data"})
        self.assertIsNotNone(dom._st.fail)


class DataTest(Base):
    def test_cold_start_says_building_and_builds_once_in_background(self):
        started = []
        with mock.patch.object(dom.threading, "Thread") as th:
            th.return_value.start.side_effect = lambda: started.append(1)
            self.assertEqual(dom.dom_data(), {"ok": False, "error": "building"})
            self.assertEqual(dom.dom_data(), {"ok": False, "error": "building"})
        self.assertEqual(len(started), 1)

    def test_fresh_answer_from_cache_and_disk_copy_after_restart(self):
        res = self.run_build(market())
        self.assertIs(dom.dom_data(), res)
        dom._st = dom._State()
        dom.set_cache_dir(self.tmp)
        with mock.patch.object(dom.threading, "Thread"):
            got = dom.dom_data()
        self.assertEqual(got["rows"], res["rows"])

    def test_failed_build_rests(self):
        dom._st.fail = time.monotonic()
        with mock.patch.object(dom.threading, "Thread") as th:
            self.assertEqual(dom.dom_data(), {"ok": False, "error": "no_data"})
        th.assert_not_called()


# ── Защита ──────────────────────────────────────────────────────────────────

class SecurityTest(Base):
    def test_only_hyperliquid_over_https(self):
        with mock.patch.object(dom._opener, "open") as op:
            for url in ("https://api.hyperliquid.xyz.evil.com/info", "http://api.hyperliquid.xyz/info",
                        "https://user:pw@api.hyperliquid.xyz/info", "file:///etc/passwd", "https://169.254.169.254/"):
                self.assertIsNone(dom._fetch(url, {}, 5), url)
            op.assert_not_called()

    def test_body_limit_and_network_errors(self):
        big = mock.MagicMock()
        big.__enter__.return_value.read.return_value = b"x" * (dom.BODY_MAX + 1)
        with mock.patch.object(dom._opener, "open", return_value=big):
            self.assertIsNone(dom._fetch(dom.INFO, {}, 5))
        with mock.patch.object(dom._opener, "open", side_effect=OSError("down")):
            self.assertIsNone(dom._fetch(dom.INFO, {}, 5))

    def test_hostile_json(self):
        for raw in (b"[" * 100_000, b'{"v": NaN}', b"[1e999]", b"[1" + b"0" * 400 + b"]", b"\xff\xfe", b""):
            self.assertIsNone(dom._parse(raw), raw[:20])

    def test_hostile_answers_are_no_data_not_a_crash(self):
        for meta in ([], {}, [1, 2], [{"universe": "x"}, []], [{"universe": [{"name": "<b>"}, 5]}, [{}, {}]],
                     [{"universe": [{"name": "A" * 50}]}, [{}]]):
            with mock.patch.object(dom, "_fetch", lambda u, b, t, m=meta: json.dumps(m).encode()):
                self.assertFalse(dom.build(sleep=lambda s: None)["ok"], meta)

    def test_bad_candles_are_skipped(self):
        rows = [{"t": T0 * 1000, "c": "100"}, {"t": T0 * 1000 + 5, "c": "100"}, {"t": (T0 + DAY) * 1000, "c": "-1"},
                {"t": (T0 + 2 * DAY) * 1000, "c": "1e300"}, {"t": (T0 + 3 * DAY) * 1000, "c": "abc"}, "x", None,
                {"t": 1_000_000 * 1000, "c": "5"}, {"t": (NOW + 30 * DAY) // DAY * DAY * 1000, "c": "5"}]
        with mock.patch.object(dom, "_fetch", lambda u, b, t: json.dumps(rows).encode()):
            self.assertEqual(dom._candles("BTC", 0), {T0: 100.0})

    def test_poisoned_price_copy_is_filtered(self):
        with open(os.path.join(self.tmp, "dom_px.json"), "w", encoding="utf-8") as f:
            json.dump({"at": NOW, "v": {"BTC": {str(T0): 100, "x": 5, str(T0 + 5): 1, str(T0 + DAY): -3},
                                         "<script>": {str(T0): 1}, "ETH": "nope"}}, f)
        self.assertEqual(dom._px_load(), {"BTC": {T0: 100.0}})
        # Дни до цен Hyperliquid и из будущего — мимо.
        with open(os.path.join(self.tmp, "dom_px.json"), "w", encoding="utf-8") as f:
            json.dump({"at": NOW, "v": {"BTC": {"0": 5, str(T0): 100, str(NOW // DAY * DAY + 10 * DAY): 7}}}, f)
        self.assertEqual(dom._px_load(), {"BTC": {T0: 100.0}})
        for body in ("[1, 2]", '{"at": "x", "v": {}}', '{"at": 1, "v": {"BTC": {}}}', "garbage"):
            with open(os.path.join(self.tmp, "dom_px.json"), "w", encoding="utf-8") as f:
                f.write(body)
            self.assertEqual(dom._px_load(), {}, body)

    def test_coin_names_reach_the_answer_only_if_plain(self):
        net = market()
        net.oi["<img src=x>"] = 9e9
        net.px["<img src=x>"] = flat(200, 1, 1.05)
        res = self.run_build(net)
        self.assertFalse([c for c in res["coins"] if not dom.COIN.fullmatch(c[0])])


class LogTest(unittest.TestCase):
    def test_log_is_printable_and_short(self):
        buf = io.StringIO()
        with mock.patch("sys.stderr", buf):
            dom._log("a\x1b[31mb\nc" + "x" * 1000)
        out = buf.getvalue()
        self.assertNotIn("\x1b", out)
        self.assertNotIn("b\nc", out)
        self.assertLess(len(out), 320)


if __name__ == "__main__":
    unittest.main()

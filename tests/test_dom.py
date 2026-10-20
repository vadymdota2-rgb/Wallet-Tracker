"""Альтсезон и сила биткоина (wt_dom): расчёт, сборка, защита — npm test.

Сеть подменена: Hyperliquid отвечает из словарей теста. Цены и обороты —
простые ряды, по которым ответ можно посчитать в уме.
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
# Идёт 200-й день: закрыты дни 0…198.
NOW = T0 + 199 * DAY + 3600
LAST = T0 + 198 * DAY


def flat(n: int, px: float, grow: float = 1.0, vol: float = 1e6, start: int = T0) -> dict:
    """n дней с start: цена растёт в grow раз за день, оборот vol $ в день."""
    return {start + i * DAY: (px * grow ** i, vol) for i in range(n)}


def coins(n: int, grow: float = 1.001, vol: float = 1e6, days: int = 199, prefix: str = "A") -> dict:
    return {f"{prefix}{i}": flat(days, 1, grow, vol) for i in range(n)}


def day(rows: list, t: int) -> list:
    return next(r for r in rows if r[0] == t)


class Net:
    """Hyperliquid из теста: список монет (снята ли с торгов) и дневные свечи."""

    def __init__(self, uni: dict, px: dict):
        self.uni, self.px, self.calls = uni, px, []

    def __call__(self, url, body, timeout):
        self.calls.append(body)
        if body["type"] == "meta":
            return json.dumps({"universe": [{"name": n, **({"isDelisted": True} if g else {})}
                                            for n, g in self.uni.items()]}).encode()
        req = body["req"]
        lo, hi = req["startTime"] // 1000, req["endTime"] // 1000
        rows = [{"t": t * 1000, "c": str(c), "v": str(v / c)}
                for t, (c, v) in sorted(self.px.get(req["coin"], {}).items()) if lo <= t <= hi]
        return json.dumps(rows).encode()

    def asked(self) -> list:
        return [c["req"]["coin"] for c in self.calls if c["type"] == "candleSnapshot"]


class Base(unittest.TestCase):
    def setUp(self):
        dom._st = dom._State()
        dom._busy.clear()
        self.tmp = tempfile.mkdtemp()
        self.now = NOW
        dom.set_cache_dir(self.tmp)
        for name, val in (("_now", lambda: self.now), ("_log", lambda m: None)):
            p = mock.patch.object(dom, name, val)
            p.start()
            self.addCleanup(p.stop)

    def run_build(self, net: Net) -> dict:
        with mock.patch.object(dom, "_fetch", net):
            return dom.build(sleep=lambda s: None)


# ── Расчёт ──────────────────────────────────────────────────────────────────

class ComputeTest(unittest.TestCase):
    def test_index_counts_coins_that_beat_bitcoin_over_90_days(self):
        px = {"BTC": flat(199, 100, 1.01), "ETH": flat(199, 5, 1.02),
              **coins(30, 1.02, prefix="F"), **coins(10, 1.001, prefix="S")}
        got = dom.compute(px)
        last = got["rows"][-1]
        self.assertEqual(last[0], LAST)
        # ETH тоже быстрее: 31 из 41 → 76; в корзине — 41 монета.
        self.assertEqual(last[1], round(100 * 31 / 41))
        self.assertEqual(last[5], 41)
        # Первый день — без оборота за прошлые дни, корзины нет; со второго —
        # сила альтов. Индекс — с 90-го дня: раньше не с чем сравнивать.
        self.assertEqual(got["rows"][0][0], T0 + DAY)
        self.assertIsNone(got["rows"][88][1])
        self.assertIsNone(got["rows"][88][5])
        self.assertEqual(got["rows"][89][0], T0 + 90 * DAY)
        self.assertIsNotNone(got["rows"][89][1])
        # ETH/BTC — ровно отношение цен, цена BTC — закрытие.
        self.assertAlmostEqual(last[3], px["ETH"][LAST][0] / px["BTC"][LAST][0], places=6)
        self.assertEqual(last[4], round(px["BTC"][LAST][0], 2))
        # Монеты — по убыванию роста за 90 дней; биткоин — отдельно.
        self.assertEqual(got["coins"][0][0], "ETH")
        self.assertEqual(len(got["coins"]), 41)
        self.assertAlmostEqual(got["coins"][-1][1], (1.001 ** 90 - 1) * 100, places=1)
        self.assertAlmostEqual(got["btc90"], (1.01 ** 90 - 1) * 100, places=1)

    def test_basket_is_the_most_traded_before_the_day(self):
        # 50 крупных медленных монет и 10 мелких быстрых: в корзине — крупные.
        px = {"BTC": flat(199, 100, 1.01), **coins(50, 1.001, 1e6, prefix="B"), **coins(10, 1.02, 1e3, prefix="M")}
        self.assertEqual(dom.compute(px)["rows"][-1][1], 0)
        # Оборот самого дня не известен, когда выбирают корзину: всплеск в
        # последний день корзину этого дня не меняет.
        px["M0"] = {**px["M0"], LAST: (px["M0"][LAST][0], 1e10)}
        self.assertEqual(dom.compute(px)["rows"][-1][1], 0)
        # Всплеск накануне — меняет: M0 входит в корзину, слабейшая крупная выходит.
        px["M0"] = {**px["M0"], LAST - DAY: (px["M0"][LAST - DAY][0], 1e10)}
        got = dom.compute(px)
        self.assertEqual(got["rows"][-1][1], 2)
        self.assertEqual(got["rows"][-1][5], dom.TOP)
        self.assertIn("M0", [c[0] for c in got["coins"]])
        # Вчера корзина была старой.
        self.assertEqual(got["rows"][-2][1], 0)

    def test_old_volume_does_not_count(self):
        # O была самой торгуемой в первые 100 дней, потом торги почти встали:
        # корзину решает оборот за последние VOLW дней, а не за всю историю.
        px = {"BTC": flat(199, 100, 1.01), **coins(50, 1.001, 1e6, prefix="B"),
              "O": {t: (c, 1e10 if t < T0 + 100 * DAY else 1.0) for t, (c, _) in flat(199, 1, 1.02).items()}}
        rows = dom.compute(px)["rows"]
        self.assertEqual(day(rows, T0 + 100 * DAY)[1], 2)
        self.assertEqual(rows[-1][1], 0)

    def test_delisted_coins_count_while_they_traded(self):
        # D росла быстрее биткоина и торговалась до 150-го дня, потом её сняли:
        # в те дни она в корзине — прошлое не подгоняется под выживших.
        px = {"BTC": flat(199, 100, 1.01), **coins(49, 1.001), "D": flat(151, 1, 1.02, 1e7)}
        rows = dom.compute(px)["rows"]
        self.assertEqual(day(rows, T0 + 150 * DAY)[1], 2)
        self.assertEqual(day(rows, T0 + 150 * DAY)[5], 50)
        self.assertEqual(day(rows, T0 + 151 * DAY)[1], 0)
        self.assertEqual(day(rows, T0 + 151 * DAY)[5], 49)

    def test_no_trading_no_basket(self):
        # Цены до начала торгов (оборот 0) — добавлены задним числом: дней по ним нет.
        px = {"BTC": flat(199, 100, 1.01)}
        for i in range(40):
            px[f"A{i}"] = {t: (c, 0.0 if t < T0 + 50 * DAY else v) for t, (c, v) in flat(199, 1, 1.001).items()}
        self.assertEqual(dom.compute(px)["rows"][0][0], T0 + 51 * DAY)

    def test_small_basket_is_no_day(self):
        px = {"BTC": flat(199, 100), **coins(dom.MIN_BASKET - 1)}
        self.assertIsNone(dom.compute(px))
        px = {"BTC": flat(199, 100), **coins(dom.MIN_BASKET)}
        self.assertTrue(dom.compute(px)["rows"])
        # С историей за 90 дней — меньше MIN_BASKET монет: сила есть, индекса нет.
        px = {"BTC": flat(199, 100), **coins(dom.MIN_BASKET - 5),
              **{f"N{i}": flat(60, 1, 1.001, start=T0 + 139 * DAY) for i in range(5)}}
        last = dom.compute(px)["rows"][-1]
        self.assertIsNone(last[1])
        self.assertIsNone(last[5])
        self.assertIsNotNone(last[2])

    def test_tiers_show_how_wide_the_market_goes(self):
        px = {"BTC": flat(199, 100, 1.01)}
        # 120 монет, оборот по убыванию: 25 самых торгуемых — быстрее биткоина.
        for i in range(120):
            px[f"A{i}"] = flat(199, 1, 1.02 if i < 25 else 1.001, 1e8 - i * 1e5)
        got = dom.compute(px)
        self.assertEqual(got["tiers"], [[25, 100, 25], [50, 50, 50], [100, 25, 100]])
        self.assertEqual(got["rows"][-1][1], 50)

    def test_strength_is_the_equal_weight_basket_against_bitcoin(self):
        px = {"BTC": flat(100, 100, 1.01),
              **{f"A{i}": flat(100, 1, 1.01 * 1.02 if i < 20 else 1.01 / 1.02) for i in range(40)}}
        rows = dom.compute(px)["rows"]
        # Половина на 2% в день сильнее биткоина, половина на 2% слабее — корзина стоит.
        self.assertTrue(all(abs(r[2] - 100) < 0.01 for r in rows))
        for i in range(20, 40):
            px[f"A{i}"] = flat(100, 1, 1.01)
        rows = dom.compute(px)["rows"]
        # Теперь в среднем +1% в день к биткоину (логарифм): за 99 дней — e^(99·ln1.02/2).
        self.assertAlmostEqual(rows[-1][2], 100 * math.exp(99 * math.log(1.02) / 2), delta=0.5)

    def test_one_crazy_day_is_clipped(self):
        px = {"BTC": flat(100, 100, 1.001), **{f"A{i}": flat(100, 1, 1.001) for i in range(40)}}
        px["A0"] = {**px["A0"], T0 + 10 * DAY: (1e6, 1e6)}  # сбой цены: в миллион раз за день
        rows = dom.compute(px)["rows"]
        # Рост к биткоину урезан до CLIP: корзина сдвинулась не больше чем на e^(CLIP/40).
        self.assertLess(max(r[2] for r in rows), 100 * math.exp(dom.CLIP / 40) + 0.01)

    def test_limits_keep_the_answer_inside_what_the_app_accepts(self):
        # Каждая монета каждый день в e раз сильнее биткоина (сбой цен): сила
        # не уходит дальше e^STR_LOG от 100 — иначе приложение отвергло бы ответ.
        px = {"BTC": flat(150, 100), **{f"A{i}": flat(150, 1e-30, math.e * 1.01) for i in range(40)}}
        got = dom.compute(px)
        self.assertLessEqual(max(r[2] for r in got["rows"]), 100 * math.exp(dom.STR_LOG) * 1.001)
        # Рост монеты больше GROW_MAX — сбой цены, монеты нет в списке.
        self.assertEqual(got["coins"], [])
        # Биткоин дешевле BTC_MIN в какие-то дни — этих дней нет вовсе.
        btc = flat(150, 100)
        for d in range(100, 110):
            btc[T0 + d * DAY] = (0.5, 1e6)
        px = {"BTC": btc, "ETH": flat(150, 5), **coins(40, days=150)}
        rows = dom.compute(px)["rows"]
        self.assertNotIn(T0 + 105 * DAY, {r[0] for r in rows})
        self.assertTrue(all(r[4] >= dom.BTC_MIN for r in rows))
        # ETH/BTC вне пределов — этого дня ETH/BTC нет, а сам день есть.
        px["ETH"] = {**px["ETH"], T0 + 120 * DAY: (2_000.0, 1e6)}
        self.assertIsNone(day(dom.compute(px)["rows"], T0 + 120 * DAY)[3])

    def test_not_alts(self):
        # Ни биткоина, ни золота, ни привязанных к доллару в корзине нет.
        px = {"BTC": flat(199, 100, 1.01), "PAXG": flat(199, 2000, 1.02, 1e10),
              "USDE": flat(199, 1.0, 1.00001, 1e10), **coins(40)}
        names = [c[0] for c in dom.compute(px)["coins"]]
        self.assertEqual(len(names), 40)
        self.assertFalse({"BTC", "PAXG", "USDE"} & set(names))

    def test_no_bitcoin_is_nothing(self):
        self.assertIsNone(dom.compute({"ETH": flat(199, 1), **coins(40)}))
        self.assertIsNone(dom.compute({"BTC": flat(50, 1), **coins(40)}))

    def test_pegged_coin(self):
        self.assertTrue(dom._pegged(flat(100, 1.0, 1.0001)))
        self.assertFalse(dom._pegged(flat(100, 1.0, 1.01)))
        self.assertFalse(dom._pegged(flat(9, 1.0)))


# ── Сборка ──────────────────────────────────────────────────────────────────

def market(n_alts: int = 40, days: int = 200) -> Net:
    """Рынок теста; день 199 — идущий, он не считается."""
    uni = {"BTC": False, "ETH": False, "PAXG": False, "USDE": False, "OLD": True}
    px = {"BTC": flat(days, 100, 1.01, 1e10), "ETH": flat(days, 5, 1.02, 5e9), "PAXG": flat(days, 2000, 1.005, 4e9),
          "USDE": flat(days, 1.0, 1.00001, 3e9), "OLD": flat(120, 1, 1.03, 2e9)}
    for i in range(n_alts):
        uni[f"A{i}"] = False
        # Половина быстрее биткоина, половина медленнее (но не стоит на месте — не «привязана»).
        px[f"A{i}"] = flat(days, 1, 1.02 if i % 2 else 1.001, 1e9 - i)
    return Net(uni, px)


class BuildTest(Base):
    def test_build_counts_closed_days_and_drops_gold_and_dollars(self):
        net = market()
        res = self.run_build(net)
        self.assertTrue(res["ok"])
        self.assertEqual(res["rows"][-1][0], LAST)
        names = [c[0] for c in res["coins"]]
        self.assertFalse({"PAXG", "USDE", "BTC"} & set(names))
        self.assertIn("ETH", names)
        self.assertEqual(res["n"], dom.TOP)
        self.assertEqual(res["by"], "Hyperliquid")
        self.assertEqual([t[0] for t in res["tiers"]], list(dom.TIERS))
        # Снятая с торгов OLD в прошлых днях — в корзине.
        self.assertEqual(day(res["rows"], T0 + 100 * DAY)[5], 42)
        self.assertEqual(res["rows"][-1][5], 41)
        # Ответ — на диске: перезапуск отдаст его сразу.
        with open(os.path.join(self.tmp, "dom.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["v"]["rows"], res["rows"])

    def test_same_day_needs_no_network(self):
        net = market()
        first = self.run_build(net)
        net.calls.clear()
        self.assertIs(self.run_build(net), first)
        self.assertEqual(net.calls, [])

    def test_next_day_asks_only_the_tail_and_not_the_delisted(self):
        net = market(days=201)
        self.run_build(net)
        self.assertIn("OLD", net.asked())
        net.calls.clear()
        self.now += DAY
        res = self.run_build(net)
        self.assertEqual(res["rows"][-1][0], LAST + DAY)
        self.assertNotIn("OLD", net.asked())
        starts = {c["req"]["startTime"] // 1000 for c in net.calls if c["type"] == "candleSnapshot"}
        self.assertEqual(starts, {LAST - dom.TAIL_DAYS * DAY})

    def test_long_pause_asks_from_the_last_known_day(self):
        net = market(days=230)
        self.run_build(net)
        net.calls.clear()
        self.now += 20 * DAY
        res = self.run_build(net)
        starts = {c["req"]["startTime"] // 1000 for c in net.calls if c["type"] == "candleSnapshot"}
        self.assertEqual(starts, {LAST - dom.TAIL_DAYS * DAY})
        # Пропущенные дни — все на месте, без дыр.
        days = [r[0] for r in res["rows"]]
        self.assertEqual(days[-1], LAST + 20 * DAY)
        self.assertEqual(days[-21:], [LAST + i * DAY for i in range(21)])

    def test_prices_survive_restart(self):
        self.run_build(market(days=201))
        dom._st = dom._State()
        dom.set_cache_dir(self.tmp)
        self.now += DAY
        net = market(days=201)
        self.run_build(net)
        starts = {c["req"]["startTime"] for c in net.calls if c["type"] == "candleSnapshot"}
        self.assertNotIn(0, starts)
        self.assertNotIn("OLD", net.asked())

    def test_coin_without_answer_keeps_old_prices(self):
        net = market(days=201)
        first = self.run_build(net)

        def broken(url, body, timeout):
            if body["type"] == "candleSnapshot" and body["req"]["coin"] == "A1":
                return None
            return net(url, body, timeout)
        self.now += DAY
        with mock.patch.object(dom, "_fetch", broken):
            again = dom.build(sleep=lambda s: None)
        self.assertEqual(again["rows"][-1][0], LAST + DAY)
        # A1 без нового дня — в корзину этого дня не попала, но не пропала из цен.
        self.assertEqual(len(again["coins"]), len(first["coins"]) - 1)
        self.assertIn(LAST, dom._st.px["A1"])

    def test_long_first_build_is_saved_on_the_way(self):
        saved = []
        real = dom._file_save
        with mock.patch.object(dom, "_file_save", lambda name, v: (saved.append((name, len(v))), real(name, v))):
            self.run_build(market())
        px = [n for name, n in saved if name == "dom_px.json"]
        # 45 монет спрошено: запись после 25-й и в конце.
        self.assertEqual(px, [dom.SAVE_EVERY, 45])
        # Следующий день: промежуточная запись держит и ещё не спрошенные
        # монеты — остановка сервера посреди обновления их не теряет.
        saved.clear()
        self.now += DAY
        with mock.patch.object(dom, "_file_save", lambda name, v: (saved.append((name, len(v))), real(name, v))):
            self.run_build(market(days=201))
        self.assertEqual([n for name, n in saved if name == "dom_px.json"], [45, 45])

    def test_pace_between_requests(self):
        slept = []
        with mock.patch.object(dom, "_fetch", market()):
            dom.build(sleep=slept.append)
        self.assertEqual(len(slept), 40 + 5 - 1)
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

    def test_old_disk_copy_is_still_served_while_a_fresh_one_builds(self):
        res = self.run_build(market())
        dom._st = dom._State()
        dom.set_cache_dir(self.tmp)
        # Сервер простоял месяц: копия старая, но люди видят её, а не «собираем».
        self.now += 30 * DAY
        with mock.patch.object(dom.threading, "Thread") as th:
            got = dom.dom_data()
        self.assertEqual(got["rows"], res["rows"])
        th.return_value.start.assert_called_once()
        # И свечи с диска тоже берутся: дописываются с последнего дня, а не заново.
        self.assertIn("BTC", dom._px_load())

    def test_copy_of_the_old_method_is_not_served(self):
        with open(os.path.join(self.tmp, "dom.json"), "w", encoding="utf-8") as f:
            json.dump({"at": NOW, "v": {"ok": True, "rows": [[T0, 50, 100, 0.03, 30_000]], "coins": [], "n": 50}}, f)
        with mock.patch.object(dom.threading, "Thread"):
            self.assertEqual(dom.dom_data(), {"ok": False, "error": "building"})

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
        for meta in ([], {}, [1, 2], {"universe": "x"}, {"universe": [{"name": "<b>"}, 5]},
                     {"universe": [{"name": "A" * 50}]}, {"universe": [{"name": "BTC"}] * (dom.COINS_MAX + 1)}):
            with mock.patch.object(dom, "_fetch", lambda u, b, t, m=meta: json.dumps(m).encode()):
                self.assertFalse(dom.build(sleep=lambda s: None)["ok"], str(meta)[:60])

    def test_bad_candles_are_skipped(self):
        today = NOW // DAY * DAY
        rows = [{"t": T0 * 1000, "c": "100", "v": "2"}, {"t": T0 * 1000 + 5, "c": "100", "v": "1"},
                {"t": (T0 + DAY) * 1000, "c": "-1", "v": "1"}, {"t": (T0 + 2 * DAY) * 1000, "c": "1e300", "v": "1"},
                {"t": (T0 + 3 * DAY) * 1000, "c": "abc", "v": "1"}, "x", None,
                {"t": (T0 + 4 * DAY) * 1000, "c": "100", "v": "-1"}, {"t": (T0 + 5 * DAY) * 1000, "c": "100", "v": "1e20"},
                {"t": (T0 + 6 * DAY) * 1000, "c": "100"},
                {"t": 1_000_000 * 1000, "c": "5", "v": "1"}, {"t": today * 1000, "c": "5", "v": "1"},
                {"t": (today + 30 * DAY) * 1000, "c": "5", "v": "1"}]
        with mock.patch.object(dom, "_fetch", lambda u, b, t: json.dumps(rows).encode()):
            # Нет оборота — ноль (так Hyperliquid отдаёт дни до торгов); идущий день — мимо.
            self.assertEqual(dom._candles("BTC", 0), {T0: (100.0, 200.0), T0 + 6 * DAY: (100.0, 0.0)})

    def test_poisoned_price_copy_is_filtered(self):
        def put(v):
            with open(os.path.join(self.tmp, "dom_px.json"), "w", encoding="utf-8") as f:
                json.dump({"at": NOW, "v": v}, f)
        put({"BTC": {str(T0): [100, 5], "x": [5, 1], str(T0 + 5): [1, 1], str(T0 + DAY): [-3, 1],
                     str(T0 + 2 * DAY): [3, -1], str(T0 + 3 * DAY): 7, str(T0 + 4 * DAY): [1, 2, 3]},
             "<script>": {str(T0): [1, 1]}, "ETH": "nope"})
        self.assertEqual(dom._px_load(), {"BTC": {T0: (100.0, 5.0)}})
        # Дни до цен Hyperliquid, идущий и из будущего — мимо.
        put({"BTC": {"0": [5, 1], str(T0): [100, 5], str(NOW // DAY * DAY): [7, 1], str(NOW // DAY * DAY + 10 * DAY): [7, 1]}})
        self.assertEqual(dom._px_load(), {"BTC": {T0: (100.0, 5.0)}})
        for body in ("[1, 2]", '{"at": "x", "v": {}}', '{"at": 1, "v": {"BTC": {}}}', "garbage"):
            with open(os.path.join(self.tmp, "dom_px.json"), "w", encoding="utf-8") as f:
                f.write(body)
            self.assertEqual(dom._px_load(), {}, body)

    def test_coin_names_reach_the_answer_only_if_plain(self):
        net = market()
        net.uni["<img src=x>"] = False
        net.px["<img src=x>"] = flat(200, 1, 1.05, 1e12)
        res = self.run_build(net)
        self.assertFalse([c for c in res["coins"] if not dom.COIN.fullmatch(c[0])])
        self.assertNotIn("<img src=x>", net.asked())


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

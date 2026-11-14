"""Скринер графика (wt_screen.py, /api/screener): npm test.

Проверяем: разбор свечей и списка монет (стейблкоины, мусор, повторы),
ответ (порядок, старые рейтинги, монеты без рейтинга), кэш (люди только
читают, те же цифры — тот же объект), расписание пересчёта и бюджет
запросов Binance (Hyperliquid не трогаем вовсе), сбои и враждебные ответы
источника, правила кода и подключение к серверу. Что рейтинг тот же, что у
графика, — test_screen_contract.py.
"""
import ast
import io
import json
import math
import os
import random
import sys
import threading
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_screen as sc  # noqa: E402

NOW = 1_794_100_000


def kl(n: int = 300, start: float = 100.0, step: float = 0.002, t0: int = 1_700_000_000_000) -> list:
    """Свечи Binance (klines): [время, o, h, l, c, v, …] строками, как у биржи."""
    out = []
    px = start
    for i in range(n):
        o = px
        c = px * (1 + step * (1 if i % 7 else -3))
        out.append([t0 + i * 900_000, f"{o}", f"{max(o, c) * 1.001}", f"{min(o, c) * 0.999}", f"{c}", "1000", 0, "0", 1, "0", "0", "0"])
        px = c
    return out


TICKER = [
    {"symbol": "BTCUSDT", "quoteVolume": "1500000000"},
    {"symbol": "ETHUSDT", "quoteVolume": "600000000"},
    {"symbol": "USDCUSDT", "quoteVolume": "900000000"},  # стейблкоин — мимо
    {"symbol": "ETHBTC", "quoteVolume": "1e12"},  # не к USDT — мимо
    {"symbol": "BTCUPUSDT", "quoteVolume": "5e6"},  # плечевой токен — мимо
    {"symbol": "SOLUSDT", "quoteVolume": "300000000"},
    {"symbol": "DEADUSDT", "quoteVolume": "10"},  # мёртвая пара — мимо
    {"symbol": "<b>USDT", "quoteVolume": "1e9"},
    {"symbol": "BTCUSDT", "quoteVolume": "1"},  # повтор — первый
]


class ParseTest(unittest.TestCase):
    def test_universe(self):
        self.assertEqual(sc.parse_universe(TICKER), [("BTC", 1.5e9, "s"), ("ETH", 6e8, "s"), ("SOL", 3e8, "s")])
        # Монеты только с фьючерсов — добавляются (по обороту, от FUT_VOL_MIN);
        # те, что есть на споте, — нет (свечи — со спота, как у графика).
        fut = [{"symbol": "BTCUSDT", "quoteVolume": "9e10"}, {"symbol": "NEWUSDT", "quoteVolume": "7e8"},
               {"symbol": "DEADUSDT", "quoteVolume": str(sc.FUT_VOL_MIN - 1)}, {"symbol": "BTCUSDT_261225", "quoteVolume": "1e9"},
               {"symbol": "USDCUSDT", "quoteVolume": "1e9"}]
        self.assertEqual(sc.parse_universe(TICKER, fut), [("BTC", 1.5e9, "s"), ("NEW", 7e8, "f"), ("ETH", 6e8, "s"), ("SOL", 3e8, "s")])
        many_f = [{"symbol": f"F{i}USDT", "quoteVolume": "1e7"} for i in range(500)]
        self.assertEqual(sum(1 for c in sc.parse_universe(TICKER, many_f) if c[2] == "f"), sc.FUT_MAX)
        for bad in (None, "x", {}, [1, None, {"symbol": 5}], [{"symbol": "XUSDT", "quoteVolume": "NaN"}]):
            self.assertEqual(sc.parse_universe(bad), [], bad)
        many = [{"symbol": f"C{i}USDT", "quoteVolume": str(1e7 + i)} for i in range(1000)]
        got = sc.parse_universe(many)
        self.assertEqual(len(got), sc.COINS_MAX)
        self.assertEqual(got[0][0], "C999")  # крупнейшие — первыми
        # Все монеты с оборотом от VOL_MIN, а не топ: ровно VOL_MIN — да, на доллар меньше — нет.
        edge = [{"symbol": "AUSDT", "quoteVolume": str(sc.VOL_MIN)}, {"symbol": "BUSDT", "quoteVolume": str(sc.VOL_MIN - 1)}]
        self.assertEqual([b for b, _, _ in sc.parse_universe(edge)], ["A"])

    def test_bars(self):
        bars = sc.parse_bars(kl(10))
        self.assertEqual(len(bars), 10)
        self.assertTrue(all(isinstance(x, float) for b in bars for x in b))
        raw = kl(5)
        raw[1][2] = "1"  # максимум ниже тела
        raw[2][0] = raw[0][0]  # время назад
        raw[3] = ["x"]
        raw.append([raw[-1][0] + 1, "1e999", "1", "1", "1", "1"])
        self.assertEqual(len(sc.parse_bars(raw)), 2)
        self.assertEqual(len(sc.parse_bars(kl(sc.BARS + 100))), sc.BARS)  # хвост — последние
        for bad in (None, "x", {}, [None, 1, "x"]):
            self.assertEqual(sc.parse_bars(bad), [])

    def test_rating_needs_enough_bars(self):
        self.assertIsNone(sc.rating(sc.parse_bars(kl(sc.MIN_BARS - 1))))
        r = sc.rating(sc.parse_bars(kl(300)))
        self.assertIsNotNone(r)
        for x in r:
            self.assertTrue(-1 <= x <= 1)
        # Ровный рост — скользящие «за покупку», ровное падение — «за продажу».
        up = sc.rating(sc.parse_bars(kl(300, step=0.01)))
        self.assertGreater(up[1], 0.5)
        self.assertLess(sc.rating([(i * 1000.0, 100 - i * 0.1, 100 - i * 0.1 + 0.05, 100 - i * 0.1 - 0.15, 100 - i * 0.1 - 0.1, 1.0)
                                   for i in range(300)])[1], -0.5)

    def test_change_24h(self):
        bars = sc.parse_bars(kl(200, step=0.0))
        self.assertEqual(sc.change_24h(bars), 0.0)
        self.assertIsNone(sc.change_24h(bars[:96]))


class EdgeTest(unittest.TestCase):
    """Границы, которые легко сломать незаметно (каждую ловит мутационная проверка)."""

    def test_numbers_and_tickers(self):
        self.assertTrue(math.isnan(sc._num(True)))  # логическое — не число
        self.assertEqual(sc.parse_bars([[1, True, True, True, True, True]]), [])
        tick = [{"symbol": s, "quoteVolume": "1e9"} for s in ("ВТСUSDT", "<B>USDT", "B-TUSDT", "B TUSDT", "ÉTHUSDT")]
        self.assertEqual(sc.parse_universe(tick), [])  # только латиница и цифры
        dup = [{"symbol": "BTCUSDT", "quoteVolume": "2e9"}, {"symbol": "BTCUSDT", "quoteVolume": "9e9"}]
        self.assertEqual(sc.parse_universe(dup), [("BTC", 2e9, "s")])  # повтор — первый
        low = [{"symbol": "AAAUSDT", "quoteVolume": str(sc.VOL_MIN - 1)}, {"symbol": "BBBUSDT", "quoteVolume": str(sc.VOL_MIN)}]
        self.assertEqual([c[0] for c in sc.parse_universe(low)], ["BBB"])  # оборот — от VOL_MIN
        self.assertEqual(sc.VOL_MIN, 1e4)

    def test_volume_spike_is_the_closed_candle_against_20_before(self):
        bars = [(float(i + 1), 10.0, 11.0, 9.0, 10.0, 1.0) for i in range(80)]
        bars[-2] = (*bars[-2][:5], 3.0)  # закрытая свеча — втрое больше
        bars[-1] = (*bars[-1][:5], 500.0)  # текущая (не закрыта) — не считается
        m = sc.metrics(bars)
        self.assertEqual(m[5], 3.0)  # type: ignore[index]

    def test_swing_floor_fresh_edge_change_and_journal(self):
        calm = [(float(i + 1), 100.0, 100.01, 99.99, 100.0, 1.0) for i in range(100)]
        self.assertEqual(sc.swing_dev(calm), 1.0)  # порог разворота — не меньше 1 %
        self.assertTrue(sc.fresh("15m", NOW - 3 * 600, NOW))  # ровно три интервала — ещё годен
        self.assertFalse(sc.fresh("15m", NOW - 3 * 600 - 1, NOW))
        flat = [(float(i + 1), 1.0, 1.0, 1.0, 1.0, 1.0) for i in range(97)]
        flat[0] = (1.0, 1.0, 1.0, 1.0, 0.0, 1.0)  # цена 0 сутки назад — изменения нет, а не деление на ноль
        self.assertIsNone(sc.change_24h(flat))
        err = io.StringIO()
        with mock.patch.object(sc.sys, "stderr", err):
            sc._log("a\nb\x1bc")
        self.assertEqual(err.getvalue(), "screener: a?b?c\n")  # одной чистой строкой

    def test_most_overdue_timeframe_first(self):
        st = sc._State()
        t0 = 100_000.0
        st.done = {"15m": t0 - 600 * 1.1, "1h": t0 - 1200 * 3, "4h": t0, "1d": t0}
        with mock.patch.object(sc, "_st", st):
            self.assertEqual(sc._due(t0)[1], "1h")  # просрочен втрое — раньше, чем 15m на 10 %


class SinceTest(unittest.TestCase):
    """Начало сигнала: рейтинг на прошлой свече — тот же, что techRating на
    свечах до неё; ход цены — от закрытия свечи, где сигнал появился."""

    def test_rating_at_past_candle_equals_rating_of_prefix(self):
        r = random.Random(7)  # noqa: S311
        bars, px = [], 50.0
        for i in range(420):
            o = px
            px = max(px * (1 + r.gauss(0.0005, 0.012)), 1e-6)
            bars.append((i * 900_000.0, o, max(o, px) * 1.003, min(o, px) * 0.997, px, r.uniform(0, 1e5)))
        at = sc._rater(bars)
        for j in [59, 60, 99, 100, 101, 199, 200, 201, 250, 333, 419]:
            want = sc.rating(bars[:j + 1])
            self.assertIsNotNone(want)
            for x, y in zip(at(j), want, strict=True):  # type: ignore[arg-type]
                self.assertAlmostEqual(x, y, delta=1e-12, msg=f"свеча {j}")

    def test_since(self):
        # Рейтинг подменён: продажа до свечи 190, покупка — с неё.
        bars = [(float(i), 1.0, 1.0, 1.0, 100.0 + i, 1.0) for i in range(200)]
        seq = {j: (-0.4 if j < 190 else 0.3) for j in range(200)}

        def at(j):
            return (seq[j], 0.0, 0.0)

        mv, age = sc.since(bars, at)
        self.assertEqual(age, 9)
        self.assertAlmostEqual(mv, (299 / 290 - 1) * 100)
        seq[199] = 0.05  # сейчас нейтрально — сигнала нет
        self.assertEqual(sc.since(bars, at), (None, None))
        seq[199] = 0.3
        seq.update({j: 0.3 for j in range(200)})  # покупка с самого начала данных — «давно»
        self.assertEqual(sc.since(bars, at), (None, sc.SINCE_MAX + 1))
        seq.update({j: (0.3 if j >= 199 - sc.SINCE_MAX else -0.3) for j in range(200)})  # ровно SINCE_MAX свечей
        self.assertEqual(sc.since(bars, at)[1], sc.SINCE_MAX)
        seq[199 - sc.SINCE_MAX] = -0.3
        seq[198 - sc.SINCE_MAX] = 0.3
        self.assertEqual(sc.since(bars, at)[1], sc.SINCE_MAX - 1)
        seq.update({j: (0.3 if j >= 198 - sc.SINCE_MAX else -0.3) for j in range(200)})  # на свечу старше — «давно»
        self.assertEqual(sc.since(bars, at), (None, sc.SINCE_MAX + 1))
        # Продажа: ход — вниз, со знаком.
        seq.update({j: (-0.6 if j >= 195 else 0.0) for j in range(200)})
        mv, age = sc.since(bars, at)
        self.assertEqual(age, 4)
        self.assertGreater(mv, 0)  # цена росла — ход против продажи
        self.assertEqual([sc.side(v) for v in (0.11, 0.1, -0.1, -0.11, 0.0)], [1, 0, 0, -1, 0])

    def test_metrics_has_since(self):
        m = sc.metrics(sc.parse_bars(kl(300, step=0.01)))
        self.assertIsNotNone(m)
        self.assertEqual(len(m), 11)  # type: ignore[arg-type]


class ReplyTest(unittest.TestCase):
    def test_order_stale_and_empty(self):
        uni = [("BTC", 2e9, "s"), ("NEW", 1.5e9, "f"), ("ETH", 1e9, "s"), ("SOL", 5e8, "s")]
        m = (0.6, 0.7333, 0.4666, 31.234, 27.06, 2.345, 1.2345, 3.456, -1.234, 2.3456, 7)
        rates = {"15m": {"BTC": (m, NOW - 30), "ETH": ((-0.2, *m[1:]), NOW - 3 * 600 - 1),
                         "NEW": ((0.2, *m[1:7], None, None, None, sc.SINCE_MAX + 1), NOW - 30)},
                 "1h": {"BTC": ((-0.4, *m[1:]), NOW - 60), "ETH": ((0.31234, *m[1:]), NOW - 60)},
                 "1m": {"BTC": ((0.9, *m[1:]), NOW - 3 * 360 - 1)}}  # старый — мимо
        px = {"BTC": (100000.0, 1.25)}
        rep = sc.reply(uni, rates, px, NOW)
        self.assertEqual(rep["tfs"], ["15m", "1h"])  # по каким таймфреймам рейтинг есть
        self.assertEqual(rep["at"], NOW - 30)  # время — самого свежего рейтинга
        self.assertEqual(rep["by"], "Binance")
        self.assertEqual([r["s"] for r in rep["rows"]], ["BTC", "NEW", "ETH"])  # у SOL рейтингов нет — мимо
        # По таймфрейму — рейтинг, скользящие, осцилляторы, RSI, ADX, объём ×,
        # ATR %, тейк %, стоп %, ход с сигнала %, свечей с сигнала — округлённые.
        packed = [0.6, 0.73, 0.47, 31.2, 27.1, 2.35, 1.23, 3.46, -1.23, 2.35, 7]
        self.assertEqual(rep["rows"][0], {"s": "BTC", "px": 100000.0, "ch": 1.25, "vol": 2000000000,
                                          "r": {"15m": packed, "1h": [-0.4, *packed[1:]]}})
        self.assertEqual(rep["rows"][1]["f"], 1)  # только фьючерсы — помечено
        self.assertEqual(rep["rows"][1]["r"]["15m"][7:], [None, None, None, sc.SINCE_MAX + 1])  # Фибо нет, сигнал давно
        self.assertNotIn("f", rep["rows"][0])
        self.assertEqual(rep["rows"][2]["r"], {"1h": [0.312, *packed[1:]]})  # старый 15m — мимо
        self.assertIsNone(rep["rows"][2]["px"])
        self.assertEqual(sc.reply(uni, {}, {}, NOW), {"ok": False, "error": "no_data"})
        json.dumps(rep, allow_nan=False)


class CacheTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, sc, "_st", sc._st)
        self.addCleanup(sc._src.clear)
        sc._st = sc._State()
        self.calls: list = []

        def uni():
            self.calls.append("universe")
            return TICKER

        def klines(base, tf, venue="s"):
            self.calls.append((base, tf))
            return kl(300, step=0.002 if base == "BTC" else -0.002)

        sc.set_sources(universe=uni, klines=klines)

    def test_people_only_read_the_cache(self):
        self.assertEqual(sc.screener_data(), {"ok": False, "error": "no_data"})
        self.assertEqual(self.calls, [])  # запрос человека к источникам не ходит
        with mock.patch.object(sc, "_now", return_value=NOW):
            res = sc.build()
            self.assertTrue(res["ok"])
            self.assertEqual([r["s"] for r in res["rows"]], ["BTC", "ETH", "SOL"])
            for _ in range(1000):
                sc.want(["1m", "5m"])  # человек фильтрует — только отметка, без сети
                self.assertIs(sc.screener_data(), res)
        self.assertEqual(len(self.calls), 1 + 3)  # список и один таймфрейм за сборку

    def run_for(self, minutes: int, t: list, mono: list, every_min=None) -> None:
        with mock.patch.object(sc, "_now", side_effect=lambda: t[0]), \
                mock.patch.object(sc.time, "monotonic", side_effect=lambda: mono[0]):
            for i in range(minutes):
                if every_min:
                    every_min(i)
                sc.build()
                t[0] += 60
                mono[0] += 60

    def by_tf(self) -> dict:
        return {tf: sum(1 for c in self.calls if isinstance(c, tuple) and c[1] == tf) // 3 for tf in sc.TFS}

    def test_schedule_warm_only_without_demand(self):
        # Без спроса — только WARM: 15m раз в 10 минут, 1H — в 20, 4H — в час,
        # 1D — в 3 часа; минутные никто не считает.
        t, mono = [NOW], [1000.0]
        self.run_for(180, t, mono)
        got = self.by_tf()
        self.assertEqual({tf: n for tf, n in got.items() if n}, {"15m": 18, "1h": 9, "4h": 3, "1d": 1})
        self.assertEqual(self.calls.count("universe"), 3)

    def test_demand_wakes_a_timeframe_then_it_sleeps(self):
        # Кто-то фильтрует 1m — считается сразу (раньше просроченных) и раз в
        # EVERY; перестали — через ACTIVE_FOR снова не считается.
        t, mono = [NOW], [1000.0]
        self.run_for(5, t, mono)  # прогрев WARM
        self.calls.clear()
        self.run_for(30, t, mono, every_min=lambda i: sc.want(["1m", "1m", "bad", 5, "15m"]))
        self.assertEqual(self.by_tf()["1m"], 5)  # 30 минут / 6
        self.assertEqual(self.calls[1][1], "1m")  # первым — нужный и ещё не посчитанный
        self.calls.clear()
        self.run_for(int(sc.ACTIVE_FOR / 60) + 30, t, mono)
        n = self.by_tf()["1m"]
        self.assertLessEqual(n, int(sc.ACTIVE_FOR / sc.EVERY["1m"]))
        self.calls.clear()
        self.run_for(60, t, mono)
        self.assertEqual(self.by_tf()["1m"], 0)
        self.assertNotIn("1m", sc._st.rates)  # старые рейтинги ненужного — из памяти прочь

    def test_budget(self):
        # Все таймфреймы нужны сразу: за сборку — не больше одного, и графику
        # хватает: сумма проходов в минуту меньше одного.
        self.assertLess(sum(60 / sc.EVERY[tf] for tf in sc.TFS), 1)
        # Вес Binance: в минуту не больше COINS_MAX × 2 + 80 (меньше 25 % от 6000),
        # в среднем при всех нужных — меньше 20 %, без спроса — меньше 5 %.
        self.assertLessEqual(sc.COINS_MAX * 2 + 80, 0.25 * 6000)
        # Фьючерсы — свой предел 2400 в минуту: монет только с фьючерсов — не
        # больше FUT_MAX, свечей — FUT_BARS (до 500 — вес 2), список — вес 40.
        self.assertLess(sc.FUT_BARS, 500)
        self.assertLessEqual(sc.FUT_MAX * 2 + 40, 0.25 * 2400)
        avg_all = sum(sc.COINS_MAX * 2 * 60 / sc.EVERY[tf] for tf in sc.TFS) + 80 / 60
        avg_warm = sum(sc.COINS_MAX * 2 * 60 / sc.EVERY[tf] for tf in sc.WARM) + 80 / 60
        self.assertLess(avg_all, 0.2 * 6000)
        self.assertLess(avg_warm, 0.05 * 6000)
        # Проверка на деле: все 14 таймфреймов нужны три часа — один проход за сборку.
        t, mono = [NOW], [1000.0]
        before = 0
        tfs_per_build = []

        def tick(i):
            nonlocal before
            sc.want(list(sc.TFS))
            n = sum(1 for c in self.calls if isinstance(c, tuple))
            tfs_per_build.append((n - before) // 3)
            before = n

        self.run_for(180, t, mono, every_min=tick)
        self.assertLessEqual(max(tfs_per_build), 1)
        self.assertTrue(all(self.by_tf()[tf] for tf in sc.TFS))  # до каждого дошла очередь

    def test_same_numbers_same_object_and_stale(self):
        with mock.patch.object(sc, "_now", return_value=NOW):
            a = sc.build()
            sc._st.done.clear()
            b = sc.build()
        self.assertIs(a, b)
        # Ничего не пересчитывалось дольше STALE_ALL — ответа нет.
        with mock.patch.object(sc, "_now", return_value=NOW + sc.STALE_ALL + 1):
            self.assertEqual(sc.screener_data(), {"ok": False, "error": "no_data"})

    def test_failures(self):
        err = io.StringIO()
        # Список монет не получен — пауза FAIL_WAIT, а не запрос каждую минуту.
        sc.set_sources(universe=lambda: (self.calls.append("universe"), None)[1], klines=lambda b, tf, v="s": 1 / 0)
        mono = [1000.0]
        with mock.patch.object(sc, "_now", return_value=NOW), mock.patch.object(sc.time, "monotonic", side_effect=lambda: mono[0]), \
                mock.patch.object(sc.sys, "stderr", err):
            self.assertEqual(sc.build(), {"ok": False, "error": "no_data"})
            mono[0] += 30
            sc.build()
            self.assertEqual(self.calls.count("universe"), 1)
            mono[0] += sc.FAIL_WAIT
            sc.build()
            self.assertEqual(self.calls.count("universe"), 2)
        # Binance недоступен: ABORT_FAILS сбоев подряд — проход прерван, а не 700
        # запросов, и свечи не просим PAUSE секунд (бан 418 растёт, если стучаться).
        sc._st = sc._State()
        many = [{"symbol": f"C{i}USDT", "quoteVolume": "1e8"} for i in range(200)]
        n = [0]
        alive = [False]

        def dead(b, tf, v="s"):
            n[0] += 1
            if not alive[0]:
                raise TimeoutError("секрет из текста ошибки")
            return kl(300)

        err = io.StringIO()
        sc.set_sources(universe=lambda: many, klines=dead)
        mono = [5000.0]
        with mock.patch.object(sc, "_now", return_value=NOW), mock.patch.object(sc.time, "monotonic", side_effect=lambda: mono[0]), \
                mock.patch.object(sc.sys, "stderr", err):
            sc.build()
            self.assertLess(n[0], sc.ABORT_FAILS + sc.WORKERS * 4 + 1)
            asked = n[0]
            for _ in range(int(sc.PAUSE // 60) - 1):  # пауза: каждую минуту — ни одного запроса свечей
                mono[0] += 60
                sc._st.done.clear()
                sc.build()
            self.assertEqual(n[0], asked)
            mono[0] += 60  # пауза кончилась
            sc._st.done.clear()
            sc.build()
            self.assertGreater(n[0], asked)
            for _ in range(5):  # молчит дальше — в журнале по-прежнему одна строка
                mono[0] += sc.PAUSE
                sc._st.done.clear()
                sc.build()
            alive[0] = True
            mono[0] += sc.PAUSE
            sc._st.done.clear()
            sc.build()
        self.assertEqual(err.getvalue(), "screener: источник klines не отвечает (TimeoutError)\nscreener: источник klines снова отвечает\n")
        # Свечи одной монеты не пришли — остальные на месте, журнал молчит (источник жив).
        sc._st = sc._State()
        err = io.StringIO()
        sc.set_sources(universe=lambda: TICKER, klines=lambda b, tf, v="s": (1 / 0) if b == "ETH" else kl(300))
        with mock.patch.object(sc, "_now", return_value=NOW), mock.patch.object(sc.sys, "stderr", err):
            res = sc.build()
        self.assertEqual([r["s"] for r in res["rows"]], ["BTC", "SOL"])
        self.assertEqual(err.getvalue(), "")

    def test_futures_list_missing_keeps_futures_coins(self):
        spot = TICKER
        fut = [{"symbol": "NEWUSDT", "quoteVolume": "5e8"}, {"symbol": "BTCUSDT", "quoteVolume": "9e9"}]
        answer = [fut]
        sc.set_sources(universe=lambda: spot, futures=lambda: answer[0], klines=lambda b, tf, v="s": kl(300))
        err = io.StringIO()
        mono = [1000.0]
        with mock.patch.object(sc, "_now", return_value=NOW), mock.patch.object(sc.time, "monotonic", side_effect=lambda: mono[0]), \
                mock.patch.object(sc.sys, "stderr", err):
            sc.build()
            self.assertIn(("NEW", 5e8, "f"), sc._st.universe)
            answer[0] = None  # фьючерсы не ответили на часовом обновлении — NEW остаётся
            mono[0] += sc.UNIVERSE_EVERY
            sc.build()
            self.assertIn(("NEW", 5e8, "f"), sc._st.universe)
            self.assertEqual([c[0] for c in sc._st.universe if c[2] == "f"], ["NEW"])
            answer[0] = []  # ответили: фьючерсов только с фьючерсов больше нет — NEW уходит
            mono[0] += sc.UNIVERSE_EVERY
            sc.build()
            self.assertNotIn("NEW", [c[0] for c in sc._st.universe])
        self.assertIn("screener: источник futures не отвечает (нет ответа)", err.getvalue())
        # Монета перешла на спот — из запаса фьючерсов не дублируется.
        old = [("NEW", 5e8, "f")]
        got = sc.merge_universe(old, [*spot, {"symbol": "NEWUSDT", "quoteVolume": "1"}], None, True)
        self.assertEqual([c[0] for c in got], ["BTC", "ETH", "SOL"])
        self.assertEqual(sc.merge_universe(old, None, None, True), [])  # спота нет — нет и списка

    def test_dropped_coins_leave_memory(self):
        with mock.patch.object(sc, "_now", return_value=NOW):
            sc.build()
            sc.set_sources(universe=lambda: TICKER[:2], klines=lambda b, tf, v="s": kl(300))
            sc._st.done.clear()
            sc._st.uni_at = -math.inf
            res = sc.build()
        self.assertEqual([r["s"] for r in res["rows"]], ["BTC", "ETH"])
        for d in sc._st.rates.values():
            self.assertNotIn("SOL", d)
        self.assertNotIn("SOL", sc._st.px)

    def test_refresh_runs_in_background_once(self):
        gate = threading.Event()

        def slow(b, tf, v="s"):
            gate.wait(5)
            return kl(300)

        sc.set_sources(universe=lambda: TICKER, klines=slow)
        with mock.patch.object(sc, "_now", return_value=NOW):
            sc.refresh()
            job = sc._st.job
            self.assertIsNotNone(job)
            for _ in range(50):
                sc.refresh()
            self.assertIs(sc._st.job, job)  # одна сборка, не пятьдесят
            gate.set()
            job.join(10)
            self.assertTrue(sc.screener_data()["ok"])
        self.assertIsNone(sc._st.job)

    def test_hostile_source(self):
        evil = '<img src=x onerror=alert(1)>'
        sc.set_sources(universe=lambda: [{"symbol": evil + "USDT", "quoteVolume": "1e12"}, {"symbol": "BTCUSDT", "quoteVolume": 10**400},
                                         {"symbol": "ETHUSDT", "quoteVolume": "2e9", "x": evil}],
                       klines=lambda b, tf, v="s": [[1, evil, "1e999", 10**400, "nan", "1"], *kl(300)])
        with mock.patch.object(sc, "_now", return_value=NOW):
            res = sc.build()
        out = json.dumps(res, allow_nan=False)
        self.assertNotIn("<img", out)
        self.assertEqual([r["s"] for r in res["rows"]], ["ETH"])
        t0 = time.process_time()
        sc.parse_bars([["1", "1", "1", "1", "1", "1"]] * 1_000_000)
        self.assertLess(time.process_time() - t0, 2.0)  # огромный ответ — разбираем только хвост


class PolicyTest(unittest.TestCase):
    def read(self, *p: str) -> str:
        with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
            return f.read()

    def test_module_is_pure(self):
        tree = ast.parse(self.read("wt_screen.py"))
        found = set()
        for n in ast.walk(tree):
            if isinstance(n, ast.Import):
                found |= {a.name for a in n.names}
            elif isinstance(n, ast.ImportFrom):
                found.add(n.module or "")
        self.assertLessEqual(found, {"__future__", "concurrent.futures", "contextlib", "decimal", "math", "sys", "threading",
                                     "time", "collections.abc", "typing"})
        self.assertEqual([n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str) and "://" in n.value], [])

    def test_server_wiring(self):
        import whale_api as api  # noqa: PLC0415
        src = self.read("whale_api.py")
        block = src.split("# --- Скринер графика (wt_screen.py)")[1].split("# --- Дайджест")[0]
        # Только Binance spot через публичное зеркало; Hyperliquid — ни запроса.
        self.assertNotIn("hl_post", block)
        self.assertNotIn("hyperliquid.xyz", block)
        self.assertIn('SCREEN_NAME = "data-api.binance.vision"', block)
        self.assertEqual(set(__import__("re").findall(r"https://([a-z0-9.-]+)", block)), {"fapi.binance.com"})  # других адресов нет
        self.assertEqual(block.count("max_bytes=wt_screen.RESP_MAX"), block.count("get_json("))
        self.assertIn("body = read_capped(r, wt_screen.RESP_MAX)", block)
        self.assertIn('if tf not in wt_screen.TFS or not (base.isascii() and base.isalnum() and len(base) <= 16):', block)
        self.assertIsNone(api._screen_klines("BTC/../x", "15m"))
        self.assertIsNone(api._screen_klines("BTC", "2m"))
        asked: list = []
        with mock.patch.object(api, "get_json", lambda url, *a, **k: asked.append((url, k)) or []):
            api._screen_klines("NEW", "1h", "f")
        self.assertEqual(asked, [("https://fapi.binance.com/fapi/v1/klines?symbol=NEWUSDT&interval=1h&limit=499",
                                  {"max_bytes": sc.RESP_MAX})])
        self.assertIs(api.screener_want, sc.want)
        for p in ("/api/screener", "/screener"):
            self.assertIn(p, api.PAID_PATHS)
        self.assertIs(api.screener_data, sc.screener_data)
        self.assertIn('        ("screener", lambda: screener_refresh()),\n', src.split("def _cache_modules() -> tuple:")[1].split("\ndef ")[0])
        route = src.split('if path in ("/screener", "/api/screener"):')[1].split("return\n")[0]
        self.assertNotIn("refresh", route)
        self.assertIn('screener_want(qs.get("tf", [""])[0][:120].split(","))', route)
        self.assertIn('self._json_public("screener", scr)', route)

    def test_keep_alive_fetch(self):
        # Сотни запросов за проход — по одному соединению на поток: открыто
        # один раз, не 200 — None, сбой — соединение заново.
        import whale_api as api  # noqa: PLC0415
        made: list = []

        class Resp:
            def __init__(self, status, body):
                self.status, self.body = status, body

            def read(self, n=-1):
                return self.body[:n] if n >= 0 else self.body

        class Conn:
            def __init__(self, host, timeout, context):
                self.host, self.n, self.closed = host, 0, False
                made.append(self)

            def request(self, method, path, headers):
                self.n += 1
                self.path = path
                if "boom" in path:
                    raise OSError("сброс")

            def getresponse(self):
                if "/banned" in self.path:
                    return Resp(429, b'{"code":-1003}')
                if "huge" in self.path:
                    return Resp(200, b"[" + b"1," * (sc.RESP_MAX // 2) + b"1]")
                return Resp(200, b'[[1,"1","1","1","1","1"]]')

            def close(self):
                self.closed = True

        api._screen_tls.__dict__.clear()
        with mock.patch.object(api.urllib.request, "getproxies", return_value={}), \
                mock.patch.object(api.http.client, "HTTPSConnection", Conn):
            for _ in range(5):
                self.assertEqual(api._screen_klines("BTC", "15m"), [[1, "1", "1", "1", "1", "1"]])
            self.assertEqual((len(made), made[0].n, made[0].host), (1, 5, "data-api.binance.vision"))
            self.assertIsNone(api._screen_get("/banned"))  # Binance ограничил — None, без исключения
            self.assertIsNone(api._screen_get("/boom"))  # сбой — соединение закрыто, со второй попытки тоже
            self.assertTrue(made[0].closed)
            self.assertIsNone(api._screen_get("/huge"))  # больше RESP_MAX — None
            self.assertIsNotNone(api._screen_get("/ok"))
        api._screen_tls.__dict__.clear()

    def test_app_and_server_agree(self):
        ts = self.read("src", "lib", "screener.ts")
        self.assertIn(f"export const SCREEN_TFS = {json.dumps(list(sc.TFS))} as const;", ts)
        self.assertIn(f"export const SCREEN_WARM: readonly ScreenTf[] = {json.dumps(list(sc.WARM))};", ts)


if __name__ == "__main__":
    unittest.main()

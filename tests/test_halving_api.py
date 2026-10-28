"""Халвинг на сервере (wt_halving.py): npm test. Сеть подменена — тест не
ходит в mempool, а модуль грузится сам по себе, без whale_api."""
import gc
import http.client
import io
import json
import os
import sys
import threading
import time
import tracemalloc
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import wt_halving as hv  # модуль лежит в корне репозитория

TIP = 1791881177
NOW = TIP + 78
H = 971219
HASH = "0" * 63 + "a"
TIP_HASH = "b" * 64  # хеш последнего блока
FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "halving.json")


class Net:
    """Подставная сеть: ответ по адресу и счётчик запросов.

    blocks — как список последних блоков: последний блок — blocks[0]
    (а мусор вместо списка — мусор вместо блока)."""

    def __init__(self, blocks=None, adj=None, fail=False, height_hash=HASH, tip_height=H):
        self.blocks, self.adj, self.fail, self.hash, self.tip_height = blocks, adj, fail, height_hash, tip_height
        self.calls, self.urls, self.start_height = 0, [], 0

    def _answer(self, url):
        as_json = lambda v: json.dumps(v).encode() if v is not None else None  # noqa: E731
        tip = self.blocks[0] if isinstance(self.blocks, list) and self.blocks else self.blocks
        routes = (
            (lambda u: u.endswith("/api/blocks/tip/hash"), lambda: TIP_HASH.encode() if self.blocks is not None else None),
            (lambda u: u.endswith(f"/api/block/{TIP_HASH}"), lambda: as_json(tip)),
            (lambda u: "difficulty-adjustment" in u, lambda: as_json(self.adj)),
            (lambda u: "block-height" in u, lambda: self._asked(url)),
            (lambda u: "/api/block/" in u, lambda: as_json({"height": self.start_height, "timestamp": 1838896000})),
            (lambda u: "tip/height" in u or "getblockcount" in u, lambda: str(self.tip_height).encode()),
        )
        return next((answer() for match, answer in routes if match(url)), None)

    def _asked(self, url):
        """Хеш блока по высоте; блок потом отдаётся с этой же высотой."""
        self.start_height = int(url.rsplit("/", 1)[1])
        return self.hash.encode()

    def fetch(self, url, limit=1 << 20):
        self.calls += 1
        self.urls.append(url)
        return None if self.fail else self._answer(url)


class HalvingTest(unittest.TestCase):
    def setUp(self):
        hv._st = hv._State()
        hv._busy.clear()
        hv.START_TS.clear()
        hv.START_TS[840_000] = 1713571767

    def run_with(self, net, t=NOW):
        with mock.patch.object(hv, "_fetch", net.fetch), mock.patch.object(hv, "_now", lambda: t):
            return hv.halving_data()

    def wait_bg(self):
        for _ in range(300):
            if not hv._busy.is_set():
                return
            time.sleep(0.02)

    def test_epoch_average(self):
        r = self.run_with(Net(blocks=[{"height": H, "timestamp": TIP}]))
        self.assertTrue(r["ok"])
        self.assertEqual((r["height"], r["next"], r["every"], r["src"], r["tip"]), (H, 1_050_000, 210_000, "epoch", TIP))
        avg = (TIP - 1713571767) / (H - 840_000)
        self.assertAlmostEqual(r["avg"], avg, places=1)
        self.assertEqual(r["eta"], int(TIP + (1_050_000 - H) * avg))
        self.assertEqual(r["prev"], 1713571767)

    def test_early_epoch_uses_difficulty_period(self):
        # Новая эпоха уже идёт: блок 1 050 000 вышел в 1838896000 (его отдаёт
        # подставная сеть), сейчас — 100 блоков спустя.
        tip = 1838896000 + 100 * 600
        r = self.run_with(Net(blocks=[{"height": 1_050_100, "timestamp": tip}], adj={"timeAvg": 570_866}), t=tip + 60)
        self.assertEqual((r["next"], r["src"]), (1_260_000, "period"))
        self.assertAlmostEqual(r["avg"], 570.9, places=1)
        self.assertEqual(hv.START_TS[1_050_000], 1838896000)  # время начала эпохи запомнено
        self.assertEqual(r["prev"], 1838896000)

    def test_start_block_of_another_height_is_not_remembered(self):
        # Источник на «блок 1 050 000» прислал другой блок — его время не
        # запоминается (иначе жило бы до перезапуска API).
        net = Net(blocks=[{"height": 1_050_100, "timestamp": 1838896000 + 100 * 600}], adj={"timeAvg": 570_866})
        net._asked = lambda url: (setattr(net, "start_height", 1_049_999), net.hash.encode())[1]
        r = self.run_with(net, t=1838896000 + 100 * 600 + 60)
        self.assertNotIn(1_050_000, hv.START_TS)
        self.assertNotIn("prev", r)
        self.assertEqual(r["src"], "period")

    def test_fallbacks_are_other_sources(self):
        # mempool молчит — следующий адрес уже другого источника.
        net = Net(fail=True)
        self.run_with(net)
        hosts = [u.split("/")[2] for u in net.urls]
        self.assertEqual(hosts, ["mempool.space", "blockstream.info", "blockchain.info"])

    def test_first_days_of_epoch_do_not_trust_epoch_average(self):
        # 100 блоков новой эпохи по 10 минут: среднему по ним не верим (мало),
        # берём период сложности. Найдено мутационной проверкой.
        hv.START_TS[1_050_000] = TIP - 100 * 600
        r = self.run_with(Net(blocks=[{"height": 1_050_100, "timestamp": TIP}], adj={"timeAvg": 570_866}))
        self.assertEqual(r["src"], "period")

    def test_bad_period_average_falls_back_to_600(self):
        r = self.run_with(Net(blocks=[{"height": 1_050_100, "timestamp": TIP}], adj={"timeAvg": 60_000}))
        self.assertEqual((r["avg"], r["src"]), (600.0, "nominal"))

    def test_future_tip_time_is_not_trusted(self):
        r = self.run_with(Net(blocks=[{"height": H, "timestamp": NOW + 99_999}]))
        self.assertEqual(r["tip"], NOW)

    def test_implausible_height_is_rejected(self):
        # mempool прислал 99 миллионов — не верим, берём запасной источник.
        r = self.run_with(Net(blocks=[{"height": 99_000_000, "timestamp": TIP}]))
        self.assertEqual((r["height"], r["tip"]), (H, NOW))
        # И запасные врут — данных нет, а не бессмыслица в карточке.
        with mock.patch("sys.stderr", io.StringIO()):
            hv._st = hv._State()
            r = self.run_with(Net(blocks=[{"height": 99_000_000, "timestamp": TIP}], tip_height=99_000_000))
        self.assertFalse(r["ok"])

    def test_fallback_height_source(self):
        r = self.run_with(Net(blocks="garbage"))
        self.assertTrue(r["ok"])
        self.assertEqual((r["height"], r["tip"]), (H, NOW))

    def test_unexpected_json_shapes_do_not_crash(self):
        r = self.run_with(Net(blocks=[{"height": 1_050_100, "timestamp": TIP}], adj=["not", "a", "dict"]))
        self.assertTrue(r["ok"])
        self.assertEqual((r["src"], r["avg"]), ("nominal", 600.0))

    def test_block_hash_is_validated_before_use(self):
        net = Net(blocks=[{"height": 1_050_100, "timestamp": TIP}], height_hash="../../evil?x=1")
        self.assertEqual(self.run_with(net)["src"], "nominal")
        self.assertFalse([u for u in net.urls if "evil" in u])

    def test_all_sources_down_then_quiet_for_a_minute(self):
        net = Net(fail=True)
        with mock.patch("sys.stderr", io.StringIO()):
            self.assertFalse(self.run_with(net)["ok"])
        calls = net.calls
        self.assertFalse(self.run_with(net)["ok"])
        self.assertEqual(net.calls, calls, "повторный запрос в течение минуты не должен идти в сеть")

    def test_stale_answer_is_instant_and_refreshes_in_background(self):
        first = self.run_with(Net(blocks=[{"height": H, "timestamp": TIP}]))
        at, res = hv._st.hit
        hv._st.hit = (at - hv.TTL - 1, res)
        slow = Net(blocks=[{"height": H + 1, "timestamp": TIP + 600}])

        def lazy(url, limit=1 << 20):
            time.sleep(1.0)
            return slow.fetch(url, limit)

        with mock.patch.object(hv, "_fetch", lazy), mock.patch.object(hv, "_now", lambda: NOW + 600):
            t0 = time.monotonic()
            self.assertEqual(hv.halving_data(), first)
            # Сеть отвечает секунду — ответ должен прийти, не дожидаясь её.
            self.assertLess(time.monotonic() - t0, 0.5)
            self.wait_bg()
        self.assertEqual(hv._st.hit[1]["height"], H + 1)

    def test_outage_with_stale_answer_does_not_hammer_sources(self):
        first = self.run_with(Net(blocks=[{"height": H, "timestamp": TIP}]))
        at, res = hv._st.hit
        hv._st.hit = (at - hv.TTL - 1, res)
        down = Net(fail=True)
        with mock.patch.object(hv, "_fetch", down.fetch), mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(hv.halving_data(), first)  # старый ответ — сразу
            self.wait_bg()
            calls = down.calls
            self.assertGreater(calls, 0)
            for _ in range(5):
                self.assertEqual(hv.halving_data(), first)
            time.sleep(0.1)
            self.assertEqual(down.calls, calls, "после сбоя минуту не ходим в сеть повторно")

    def test_outage_serves_last_answer_up_to_a_day_then_no_data(self):
        first = self.run_with(Net(blocks=[{"height": H, "timestamp": TIP}]))
        at, res = hv._st.hit
        down = Net(fail=True)
        with mock.patch.object(hv, "_fetch", down.fetch), mock.patch("sys.stderr", io.StringIO()):
            # Почти сутки источники молчат — старый ответ лучше пустой карточки.
            hv._st.hit = (at - hv.STALE_MAX + 60, res)
            hv._st.err_at = float("-inf")
            self.assertEqual(hv.halving_data(), first)
            self.wait_bg()
            # Больше суток — это уже не оценка: «нет данных», и сразу.
            hv._st.hit = (at - hv.STALE_MAX - 1, res)
            hv._st.err_at = float("-inf")
            t0 = time.monotonic()
            self.assertEqual(hv.halving_data(), {"ok": False, "error": "no_data"})
            self.assertLess(time.monotonic() - t0, 0.5)
        # Источники ожили — свежий ответ, как обычно.
        hv._st.err_at = float("-inf")
        self.assertEqual(self.run_with(Net(blocks=[{"height": H + 1, "timestamp": TIP + 600}]))["height"], H + 1)

    def test_reply_adds_response_time(self):
        self.run_with(Net(blocks=[{"height": H, "timestamp": TIP}]))
        with mock.patch.object(hv, "_now", lambda: NOW + 250):
            r = hv.reply()
        self.assertEqual((r["now"], r["at"]), (NOW + 250, NOW))

    def test_hung_sources_fit_the_time_budget(self):
        # Все источники висят до таймаута: сборка укладывается в бюджет, а
        # не ждёт каждый адрес по очереди.
        timeouts = []

        def hang(req, timeout=0):
            timeouts.append(timeout)
            time.sleep(timeout)
            raise TimeoutError("hung")

        with mock.patch.object(hv, "BUDGET", 0.6), mock.patch.object(hv, "HOP", 0.25), \
                mock.patch.object(hv._opener, "open", hang), mock.patch("sys.stderr", io.StringIO()):
            t0 = time.monotonic()
            self.assertFalse(hv.build()["ok"])
            # Без бюджета — 7 запросов по 0,25 с; с бюджетом — не дольше ~0,6 с
            # (запас на медленную машину CI).
            self.assertLess(time.monotonic() - t0, 1.2)
        self.assertTrue(all(t <= 0.25 for t in timeouts))
        self.assertEqual(getattr(hv._dl, "at", 0.0), 0.0)  # срок сброшен после сборки

    def test_contract_matches_shared_fixture(self):
        # Ответ сервера — те же поля и типы, что в образце, который проверяет
        # и приложение (tests/halving.test.ts). Разъехались — падает здесь.
        with open(FIXTURE, encoding="utf-8") as f:
            fx = json.load(f)
        self.run_with(Net(blocks=[{"height": H, "timestamp": TIP}]))
        with mock.patch.object(hv, "_now", lambda: NOW):
            r = hv.reply()
        self.assertEqual(set(r), set(fx))
        for k, v in fx.items():
            self.assertIs(type(r[k]), type(v), k)
        self.assertEqual({k: r[k] for k in ("height", "next", "every", "avg", "src", "tip", "prev")},
                         {k: fx[k] for k in ("height", "next", "every", "avg", "src", "tip", "prev")})

    def test_fetch_never_raises(self):
        for exc in (urllib.error.URLError("x"), OSError("x"), http.client.IncompleteRead(b""), ValueError("x")):
            with mock.patch.object(hv._opener, "open", side_effect=exc):
                self.assertIsNone(hv._fetch("https://mempool.space/api/x"))

    # ── Испорченные ответы источников: каждая ветка разбора ──────────────

    def test_garbage_bodies_are_rejected_not_raised(self):
        with mock.patch.object(hv, "_fetch", lambda url, limit=1 << 20: b"{not json"):
            self.assertIsNone(hv._json("https://x/"))
        with mock.patch.object(hv, "_fetch", lambda url, limit=1 << 20: b"abc"):
            self.assertEqual(hv._int("https://x/"), 0)
        with mock.patch.object(hv, "_fetch", lambda url, limit=1 << 20: None):
            self.assertIsNone(hv._json("https://x/"))
            self.assertEqual(hv._int("https://x/"), 0)

    def test_start_time_with_bad_type_is_not_cached(self):
        net = Net()
        net._answer = lambda url: HASH.encode() if "block-height" in url else b'{"timestamp": "soon"}'
        with mock.patch.object(hv, "_fetch", net.fetch):
            self.assertEqual(hv._start_ts(1_050_000), 0)
        self.assertNotIn(1_050_000, hv.START_TS)

    def test_start_time_from_the_future_is_not_cached(self):
        net = Net()
        net._answer = lambda url: HASH.encode() if "block-height" in url else b'{"timestamp": 9000000000}'
        with mock.patch.object(hv, "_fetch", net.fetch), mock.patch.object(hv, "_now", lambda: NOW):
            self.assertEqual(hv._start_ts(1_050_000), 0)
        self.assertNotIn(1_050_000, hv.START_TS)

    def test_thread_start_failure_releases_the_flag(self):
        self.run_with(Net(blocks=[{"height": H, "timestamp": TIP}]))
        at, res = hv._st.hit
        hv._st.hit = (at - hv.TTL - 1, res)
        with mock.patch.object(hv.threading.Thread, "start", side_effect=RuntimeError("can't start new thread")), \
                mock.patch("sys.stderr", io.StringIO()) as err:
            self.assertEqual(hv.halving_data(), res)  # старый ответ — как обычно
        self.assertFalse(hv._busy.is_set(), "флаг снят — следующая попытка возможна")
        self.assertIn("фон не запущен", err.getvalue())

    def test_tip_with_bad_height_type_uses_fallback(self):
        r = self.run_with(Net(blocks=[{"height": "abc", "timestamp": TIP}]))
        self.assertEqual((r["height"], r["tip"]), (H, NOW))

    def test_epoch_average_out_of_range_falls_back(self):
        # Время начала эпохи такое, что среднее вышло бы ~1000 с на блок.
        hv.START_TS[840_000] = TIP - (H - 840_000) * 1000
        r = self.run_with(Net(blocks=[{"height": H, "timestamp": TIP}], adj={"timeAvg": 570_866}))
        self.assertEqual(r["src"], "period")

    def test_period_average_of_bad_type_gives_nominal(self):
        r = self.run_with(Net(blocks=[{"height": 1_050_100, "timestamp": TIP}], adj={"timeAvg": "fast"}))
        self.assertEqual((r["src"], r["avg"]), ("nominal", 600.0))

    def test_fetch_reads_with_limit_and_budget_timeout(self):
        seen = {}

        class Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake(req, timeout=0):
            seen["timeout"], seen["ua"] = timeout, req.get_header("User-agent")
            return Resp(b"x" * 100)

        with mock.patch.object(hv._opener, "open", fake):
            self.assertEqual(hv._fetch("https://mempool.space/x", 100), b"x" * 100)  # ровно limit — годится
            self.assertIsNone(hv._fetch("https://mempool.space/x", 99))  # больше limit — не ответ
            self.assertEqual(seen["timeout"], hv.HOP)
            self.assertEqual(seen["ua"], "wallet-tracker/1.0")
            hv._dl.at = time.monotonic() + 1.0  # внутри сборки — не дольше остатка
            try:
                hv._fetch("https://mempool.space/x")
                self.assertLessEqual(seen["timeout"], 1.0)
                hv._dl.at = time.monotonic() + 0.1  # остатка нет — в сеть не идём
                seen.clear()
                self.assertIsNone(hv._fetch("https://mempool.space/x"))
                self.assertEqual(seen, {})
            finally:
                hv._dl.at = 0.0

    def test_clock_is_unix_seconds(self):
        self.assertLessEqual(abs(hv._now() - time.time()), 1)

    # ── Фон и гонки ──────────────────────────────────────────────────────

    def test_background_releases_the_flag_whatever_happens(self):
        # build сама не падает; но даже если бы упала — флаг «идёт сборка»
        # снимается, иначе ответ больше никогда не обновился бы.
        hv._busy.set()
        with mock.patch.object(hv, "build", side_effect=RuntimeError("boom")), self.assertRaises(RuntimeError):
            hv._bg()
        self.assertFalse(hv._busy.is_set())

    def _race(self, net, n=6):
        """n человек одновременно открывают меню на холодном сервере."""
        out = []
        with mock.patch.object(hv, "_fetch", net.fetch), mock.patch.object(hv, "_now", lambda: NOW), \
                mock.patch("sys.stderr", io.StringIO()):
            ts = [threading.Thread(target=lambda: out.append(hv.halving_data())) for _ in range(n)]
            for t in ts:
                t.start()
            for t in ts:
                t.join(10)
        return out

    def test_cold_start_race_builds_once(self):
        slow = Net(blocks=[{"height": H, "timestamp": TIP}])
        orig = slow.fetch

        def lazy(url, limit=1 << 20):
            time.sleep(0.2)
            return orig(url, limit)

        slow.fetch = lazy
        out = self._race(slow)
        self.assertEqual(len(out), 6)
        self.assertTrue(all(r is out[0] and r["ok"] for r in out))
        # Хеш последнего блока и сам блок — два запроса на одну сборку.
        self.assertEqual(slow.calls, 2, "сборка одна: остальные дождались и взяли готовое")

    def test_cold_start_race_when_sources_are_down(self):
        down = Net(fail=True)
        orig = down.fetch

        def lazy(url, limit=1 << 20):
            time.sleep(0.05)
            return orig(url, limit)

        down.fetch = lazy
        out = self._race(down)
        self.assertTrue(all(not r["ok"] for r in out))
        self.assertEqual(down.calls, 3, "одна неудачная сборка (3 адреса), остальные не ходили в сеть")


    # ── Не засоряет сервер ───────────────────────────────────────────────

    def test_memory_threads_and_cache_do_not_grow(self):
        # Тысячи ответов и сотни пересборок: память, потоки и кэш — те же.
        # Растёт — значит модуль что-то копит (утечка), и за месяцы работы
        # сервер бы «засорился».
        net = Net(blocks=[{"height": H, "timestamp": TIP}])
        threads = threading.active_count()
        # Сеть без журнала адресов: копить здесь должен только модуль, если копит.
        with mock.patch.object(hv, "_fetch", lambda url, limit=1 << 20: net._answer(url)), \
                mock.patch.object(hv, "_now", lambda: NOW):
            for _ in range(300):  # разогрев: кэши самого Python
                hv.build()
            gc.collect()
            tracemalloc.start()
            before = tracemalloc.get_traced_memory()[0]
            for i in range(20_000):
                hv.reply()
                if i % 50 == 0:
                    hv.build()
            gc.collect()
            grown = tracemalloc.get_traced_memory()[0] - before
            tracemalloc.stop()
        self.wait_bg()
        self.assertLess(grown, 64 * 1024, f"память выросла на {grown} байт")
        self.assertLessEqual(threading.active_count(), threads)
        self.assertEqual(set(hv.START_TS), {840_000})  # одно время на эпоху, не больше

    def test_json_answers_are_read_small(self):
        # Ответ-JSON — не больше JSON_MAX (блок ~0,5 КБ): мегабайт не читаем.
        limits = {}
        net = Net(blocks=[{"height": H, "timestamp": TIP}])

        def fetch(url, limit=1 << 20):
            limits[url.rsplit("/", 2)[-2]] = limit
            return net.fetch(url, limit)

        self.run_with(Net())  # пусто
        hv._st = hv._State()
        with mock.patch.object(hv, "_fetch", fetch), mock.patch.object(hv, "_now", lambda: NOW):
            hv.build()
        self.assertEqual(limits["block"], hv.JSON_MAX)
        self.assertLessEqual(hv.JSON_MAX, 4096)


if __name__ == "__main__":
    unittest.main()

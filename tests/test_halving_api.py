"""Халвинг на сервере (wt_halving.py): npm test. Сеть подменена — тест не
ходит в mempool, а модуль грузится сам по себе, без whale_api."""
import http.client
import io
import json
import os
import sys
import time
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import wt_halving as hv  # модуль лежит в корне репозитория

TIP = 1791881177
NOW = TIP + 78
H = 971219
HASH = "0" * 63 + "a"
FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "halving.json")


class Net:
    """Подставная сеть: ответ по адресу и счётчик запросов."""

    def __init__(self, blocks=None, adj=None, fail=False, height_hash=HASH, tip_height=H):
        self.blocks, self.adj, self.fail, self.hash, self.tip_height = blocks, adj, fail, height_hash, tip_height
        self.calls, self.urls = 0, []

    def _answer(self, url):
        as_json = lambda v: json.dumps(v).encode() if v is not None else None  # noqa: E731
        routes = (
            (lambda u: u.endswith("/api/v1/blocks"), lambda: as_json(self.blocks)),
            (lambda u: "difficulty-adjustment" in u, lambda: as_json(self.adj)),
            (lambda u: "block-height" in u, self.hash.encode),
            (lambda u: "/api/block/" in u, lambda: b'{"timestamp": 1838896000}'),
            (lambda u: "tip/height" in u or "getblockcount" in u, lambda: str(self.tip_height).encode()),
        )
        return next((answer() for match, answer in routes if match(url)), None)

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
        r = self.run_with(Net(blocks=[{"height": 1_050_100, "timestamp": TIP}], adj={"timeAvg": 570_866}))
        self.assertEqual((r["next"], r["src"]), (1_260_000, "period"))
        self.assertAlmostEqual(r["avg"], 570.9, places=1)
        self.assertEqual(hv.START_TS[1_050_000], 1838896000)  # время начала эпохи запомнено

    def test_bad_period_average_falls_back_to_600(self):
        r = self.run_with(Net(blocks=[{"height": 1_050_100, "timestamp": TIP}], adj={"timeAvg": 60_000}))
        self.assertEqual((r["avg"], r["src"]), (600.0, "nominal"))

    def test_future_tip_time_is_not_trusted(self):
        r = self.run_with(Net(blocks=[{"height": H, "timestamp": NOW + 99_999}]))
        self.assertEqual(r["tip"], NOW)

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
                mock.patch.object(hv.urllib.request, "urlopen", hang), mock.patch("sys.stderr", io.StringIO()):
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
            with mock.patch.object(hv.urllib.request, "urlopen", side_effect=exc):
                self.assertIsNone(hv._fetch("https://example.invalid/"))


if __name__ == "__main__":
    unittest.main()

"""Халвинг на сервере (wt_halving.py): npm test. Сеть подменена — тест не
ходит в mempool, а модуль грузится сам по себе, без whale_api."""
import io
import os
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import wt_halving as hv  # noqa: E402

TIP = 1791881177
NOW = TIP + 78
H = 971219
HASH = "0" * 63 + "a"


class Net:
    """Подставная сеть: ответ по адресу и счётчик запросов."""

    def __init__(self, blocks=None, adj=None, fail=False, height_hash=HASH, tip_height=H):
        self.blocks, self.adj, self.fail, self.hash, self.tip_height = blocks, adj, fail, height_hash, tip_height
        self.calls, self.urls = 0, []

    def fetch(self, url, limit=1 << 20):
        import json
        self.calls += 1
        self.urls.append(url)
        if self.fail:
            return None
        if url.endswith("/api/v1/blocks"):
            return json.dumps(self.blocks).encode() if self.blocks is not None else None
        if "difficulty-adjustment" in url:
            return json.dumps(self.adj).encode() if self.adj is not None else None
        if "block-height" in url:
            return self.hash.encode()
        if "/api/block/" in url:
            return b'{"timestamp": 1838896000}'
        if "tip/height" in url or "getblockcount" in url:
            return str(self.tip_height).encode()
        return None


class HalvingTest(unittest.TestCase):
    def setUp(self):
        hv._cache.clear()
        hv._busy = False
        hv.START_TS.clear()
        hv.START_TS[840_000] = 1713571767

    def run_with(self, net, t=NOW):
        with mock.patch.object(hv, "_fetch", net.fetch), mock.patch.object(hv, "_now", lambda: t):
            return hv.halving_data()

    def wait_bg(self):
        for _ in range(100):
            if not hv._busy:
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
        at, res = hv._cache["all"]
        hv._cache["all"] = (at - hv.TTL - 1, res)
        slow = Net(blocks=[{"height": H + 1, "timestamp": TIP + 600}])

        def lazy(url, limit=1 << 20):
            time.sleep(0.3)
            return slow.fetch(url, limit)

        with mock.patch.object(hv, "_fetch", lazy), mock.patch.object(hv, "_now", lambda: NOW + 600):
            t0 = time.monotonic()
            self.assertEqual(hv.halving_data(), first)
            self.assertLess(time.monotonic() - t0, 0.1)
            self.wait_bg()
        self.assertEqual(hv._cache["all"][1]["height"], H + 1)

    def test_outage_with_stale_answer_does_not_hammer_sources(self):
        first = self.run_with(Net(blocks=[{"height": H, "timestamp": TIP}]))
        at, res = hv._cache["all"]
        hv._cache["all"] = (at - hv.TTL - 1, res)
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

    def test_fetch_never_raises(self):
        import http.client
        import urllib.error

        for exc in (urllib.error.URLError("x"), OSError("x"), http.client.IncompleteRead(b""), ValueError("x")):
            with mock.patch.object(hv.urllib.request, "urlopen", side_effect=exc):
                self.assertIsNone(hv._fetch("https://example.invalid/"))


if __name__ == "__main__":
    unittest.main()

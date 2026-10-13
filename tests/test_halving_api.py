"""Халвинг на сервере: npm test. Сеть подменена — тест не ходит в mempool."""
import io
import os
import sys
import tempfile
import time
import unittest
import urllib.error
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp())  # базы и файлы API — во временной папке
import whale_api as w  # noqa: E402

TIP = 1791881177
NOW = TIP + 78
H = 971219


class Net:
    """Подставная сеть: ответы по адресу и счётчик запросов."""

    def __init__(self, blocks=None, adj=None, fail=False):
        self.blocks, self.adj, self.fail, self.calls = blocks, adj, fail, 0

    def get_json(self, url, timeout=10.0):
        self.calls += 1
        if self.fail:
            return None
        if url.endswith("/api/v1/blocks"):
            return self.blocks
        if "difficulty-adjustment" in url:
            return self.adj
        if "/api/block/" in url:
            return {"timestamp": 1838896000}
        return None

    def urlopen(self, req, timeout=0):
        self.calls += 1
        url = getattr(req, "full_url", req)
        if self.fail:
            raise urllib.error.URLError("down")
        if "block-height" in url:
            return io.BytesIO(b"00000000hash")
        return io.BytesIO(str(H).encode())


class HalvingTest(unittest.TestCase):
    def setUp(self):
        w._halving_cache.clear()
        w._liq_busy.discard("halving")
        w._HALVING_START_TS.clear()
        w._HALVING_START_TS[840_000] = 1713571767

    def run_with(self, net, t=NOW):
        with mock.patch.object(w, "get_json", net.get_json), \
                mock.patch.object(w.urllib.request, "urlopen", net.urlopen), \
                mock.patch.object(w, "now", lambda: t):
            return w.halving_data()

    def test_epoch_average(self):
        r = self.run_with(Net(blocks=[{"height": H, "timestamp": TIP}]))
        self.assertTrue(r["ok"])
        self.assertEqual((r["height"], r["next"], r["every"], r["src"], r["tip"]), (H, 1_050_000, 210_000, "epoch", TIP))
        avg = (TIP - 1713571767) / (H - 840_000)
        self.assertAlmostEqual(r["avg"], avg, places=1)
        self.assertEqual(r["eta"], int(TIP + (1_050_000 - H) * avg))
        self.assertEqual(r["prev"], 1713571767)

    def test_early_epoch_uses_difficulty_period(self):
        h = 1_050_100
        r = self.run_with(Net(blocks=[{"height": h, "timestamp": TIP}], adj={"timeAvg": 570_866}))
        self.assertEqual((r["next"], r["src"]), (1_260_000, "period"))
        self.assertAlmostEqual(r["avg"], 570.9, places=1)

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

    def test_all_sources_down_then_quiet_for_a_minute(self):
        net = Net(fail=True)
        with mock.patch("sys.stderr", io.StringIO()):
            self.assertFalse(self.run_with(net)["ok"])
        calls = net.calls
        self.assertFalse(self.run_with(net)["ok"])
        self.assertEqual(net.calls, calls, "повторный запрос в течение минуты не должен идти в сеть")

    def test_stale_answer_is_instant_and_refreshes_in_background(self):
        first = self.run_with(Net(blocks=[{"height": H, "timestamp": TIP}]))
        k = w._halving_cache["all"]
        w._halving_cache["all"] = (k[0] - w.HALVING_TTL - 1, k[1])
        slow = Net(blocks=[{"height": H + 1, "timestamp": TIP + 600}])

        def lazy(url, timeout=10.0):
            time.sleep(0.3)
            return Net.get_json(slow, url, timeout)

        with mock.patch.object(w, "get_json", lazy), mock.patch.object(w.urllib.request, "urlopen", slow.urlopen):
            t0 = time.monotonic()
            self.assertEqual(w.halving_data(), first)
            self.assertLess(time.monotonic() - t0, 0.1)
            for _ in range(50):
                if "halving" not in w._liq_busy:
                    break
                time.sleep(0.05)
        self.assertEqual(w._halving_cache["all"][1]["height"], H + 1)

    def test_outage_with_stale_answer_does_not_hammer_sources(self):
        first = self.run_with(Net(blocks=[{"height": H, "timestamp": TIP}]))
        k = w._halving_cache["all"]
        w._halving_cache["all"] = (k[0] - w.HALVING_TTL - 1, k[1])
        down = Net(fail=True)
        with mock.patch.object(w, "get_json", down.get_json), \
                mock.patch.object(w.urllib.request, "urlopen", down.urlopen), \
                mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(w.halving_data(), first)  # старый ответ — сразу
            for _ in range(50):
                if "halving" not in w._liq_busy:
                    break
                time.sleep(0.02)
            calls = down.calls
            self.assertGreater(calls, 0)
            for _ in range(5):
                self.assertEqual(w.halving_data(), first)
            time.sleep(0.1)
            self.assertEqual(down.calls, calls, "после сбоя минуту не ходим в сеть повторно")

    def test_unexpected_json_shapes_do_not_crash(self):
        # mempool вернул список там, где ждали объект, — раньше это был
        # AttributeError и 500 на холодном старте.
        class Odd(Net):
            def get_json(self, url, timeout=10.0):
                self.calls += 1
                if url.endswith("/api/v1/blocks"):
                    return [{"height": 1_050_100, "timestamp": TIP}]
                return ["not", "a", "dict"]
        r = self.run_with(Odd())
        self.assertTrue(r["ok"])
        self.assertEqual((r["src"], r["avg"]), ("nominal", 600.0))

    def test_block_hash_is_validated_before_use(self):
        seen = []

        class Evil(Net):
            def urlopen(self, req, timeout=0):
                url = getattr(req, "full_url", req)
                if "block-height" in url:
                    return io.BytesIO(b"../../evil?x=1")
                return Net.urlopen(self, req, timeout)

            def get_json(self, url, timeout=10.0):
                seen.append(url)
                return Net.get_json(self, url, timeout)
        self.assertEqual(self.run_with(Evil(blocks=[{"height": 1_050_100, "timestamp": TIP}])) ["src"], "nominal")
        self.assertFalse([u for u in seen if "evil" in u])


if __name__ == "__main__":
    unittest.main()

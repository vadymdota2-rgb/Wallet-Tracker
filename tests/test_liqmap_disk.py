"""Карта ликвидаций: копия на диске (wt_liqmap.dump/restore, whale_api.liq_disk_*).

Как у халвинга: после перезапуска сервера тёплые карты отдаются сразу, а не
через минуту сборки. Копия могла испортиться, устареть или быть подложенной,
а сетка карты — смениться с выкатом: такое не принимается, а что принято, —
ровно та же карта, что была.
"""
import copy
import json
import os
import random
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модули лежат в корне репозитория
import wt_liqmap as lm  # noqa: E402


def market(n=60, px=100.0):
    return [(1_000_000 + i * 900, px * 1.003, px * 0.997, px * (1 + (i % 5 - 2) * 0.002), 1e9 + 1e7 * i, 0.55)
            for i in range(n)]


class Base(unittest.TestCase):
    def setUp(self):
        lm._st = lm._State()
        self.addCleanup(setattr, lm, "_st", lm._State())
        lm.set_gather(lambda s, p, n: ({"OKX": market()}, market()))

    def built(self, *keys):
        for sym, rng in keys:
            self.assertTrue(lm.build(sym, rng)["ok"])
        return lm.dump()


class DumpRestoreTest(Base):
    def test_round_trip_gives_the_same_map(self):
        data = json.loads(json.dumps(self.built(("BTC", "1d"), ("ETH", "7d")), allow_nan=False))
        before = {k: v[2] for k, v in lm._st.hits.items()}
        self.assertEqual(data["v"], lm.DUMP_VERSION)
        lm._st = lm._State()
        self.assertEqual(lm.restore(data), 2)
        for k, res in before.items():
            self.assertEqual(lm._st.hits[k][2], res, k)
            # Возраст сохранён: сборка не «молодеет» от перезапуска.
            self.assertLess(time.monotonic() - lm._st.hits[k][0], 5)
        # Из копии — сразу, без сборки.
        lm.set_gather(None)
        self.assertTrue(lm.liq_map("BTC", "1d")["ok"])

    def test_same_coin_mark_survives_the_copy(self):
        lm.set_price(lambda s: 100.0)
        self.addCleanup(lm.set_price, None)
        data = json.loads(json.dumps(self.built(("BTC", "1d")), allow_nan=False))
        self.assertIs(lm._st.hits[("BTC", "1d")][1]["live"], True)
        lm._st = lm._State()
        self.assertEqual(lm.restore(data), 1)
        self.assertIs(lm._st.hits[("BTC", "1d")][1]["live"], True)
        for bad in (1, "true", None):
            data["maps"][0]["st"]["live"] = bad
            lm._st = lm._State()
            self.assertEqual(lm.restore(copy.deepcopy(data)), 1)
            self.assertIs(lm._st.hits[("BTC", "1d")][1]["live"], False)  # не True — не «та же монета»

    def test_candle_edges_survive_the_copy(self):
        data = json.loads(json.dumps(self.built(("BTC", "1d")), allow_nan=False))
        res = lm._st.hits[("BTC", "1d")][2]
        edges = res["ohlc_t"]
        self.assertEqual(len(edges), len(res["ohlc"]) + 1)
        self.assertEqual(edges, sorted(set(edges)))
        lm._st = lm._State()
        self.assertEqual(lm.restore(copy.deepcopy(data)), 1)
        self.assertEqual(lm._st.hits[("BTC", "1d")][2]["ohlc_t"], edges)
        # Старая копия без границ — принимается, карта без них.
        old = copy.deepcopy(data)
        del old["maps"][0]["st"]["ohlc_t"]
        lm._st = lm._State()
        self.assertEqual(lm.restore(old), 1)
        self.assertNotIn("ohlc_t", lm._st.hits[("BTC", "1d")][2])
        for bad in ([], edges[:-1], [*edges[:-1], edges[-2]], [True] * len(edges), [float(x) for x in edges], "x", [-1, *edges[1:]]):
            d = copy.deepcopy(data)
            d["maps"][0]["st"]["ohlc_t"] = bad
            lm._st = lm._State()
            self.assertEqual(lm.restore(d), 0, repr(bad)[:40])

    def test_age_survives_restart(self):
        data = self.built(("BTC", "1d"))
        data["maps"][0]["age"] = 1000.0
        lm._st = lm._State()
        self.assertEqual(lm.restore(data), 1)
        age = time.monotonic() - lm._st.hits[("BTC", "1d")][0]
        self.assertGreaterEqual(age, 1000)
        self.assertLess(age, 1010)
        # Старше TTL окна — пересоберётся на первом же запросе, как и без перезапуска.
        self.assertGreater(age, lm.TTL["1d"])

    def test_tiny_cells_do_not_spoil_the_copy(self):
        # Сервер: из 37 карт копии принимались 3 — монеты меньше 5·10⁻¹⁰
        # проходили отбор «больше нуля», а в файл ложились нулём после
        # округления, и вся карта браковалась при чтении.
        self.built(("BTC", "1d"), ("ETH", "7d"))
        for _born, st, _res in lm._st.hits.values():
            st["L"][0][3] = 1e-12
            st["S"][-1][lm.BUCKETS - 5] = 4e-10
        data = json.loads(json.dumps(lm.dump(), allow_nan=False))
        cells = [v for m in data["maps"] for side in ("L", "S") for g in m["st"][side] for _, v in g]
        self.assertTrue(all(v > 0 for v in cells))
        lm._st = lm._State()
        self.assertEqual(lm.restore(data), 2)

    def test_every_build_survives_the_copy(self):
        rnd = random.Random(7)  # noqa: S311 — разные рынки, не тайна
        for i in range(30):
            px = 10 ** rnd.uniform(-6, 5)
            rows = [(1_000_000 + j * 900, px * (1 + rnd.uniform(0, 0.02)), px * (1 - rnd.uniform(0, 0.02)),
                     px * (1 + rnd.uniform(-0.01, 0.01)), 10 ** rnd.uniform(2, 10) * (1 + 0.01 * j), rnd.random()) for j in range(60)]
            lm.set_gather(lambda s, p, n, r=rows: ({"OKX": r, "Gate": r[::-1][::-1]}, r))
            self.assertTrue(lm.build(f"C{i}", "1d")["ok"])
        data = json.loads(json.dumps(lm.dump(), allow_nan=False))
        lm._st = lm._State()
        self.assertEqual(lm.restore(data), 30)

    def test_sparse_cells_only(self):
        data = self.built(("BTC", "1d"))
        st = data["maps"][0]["st"]
        cells = sum(len(g) for side in ("L", "S") for g in st[side])
        self.assertLess(cells, lm.BUCKETS * len(lm.GROUPS) * 2)
        self.assertTrue(all(v > 0 for side in ("L", "S") for g in st[side] for _, v in g))

    def test_old_copy_and_old_maps_are_not_taken(self):
        data = self.built(("BTC", "1d"))
        lm._st = lm._State()
        self.assertEqual(lm.restore({**data, "at": time.time() - lm.STALE - 1}), 0)
        data["maps"][0]["age"] = lm.STALE
        self.assertEqual(lm.restore(data), 0)
        self.assertEqual(lm.restore({**data, "at": time.time() + 600}), 0)  # из будущего

    def test_does_not_overwrite_a_fresher_build(self):
        data = self.built(("BTC", "1d"))
        lm._st.hits[("BTC", "1d")] = (time.monotonic(), {"px": 1}, {"ok": True, "mine": 1})
        self.assertEqual(lm.restore(data), 0)
        self.assertEqual(lm._st.hits[("BTC", "1d")][2], {"ok": True, "mine": 1})

    def test_grid_changed_with_a_release_is_not_taken(self):
        data = self.built(("BTC", "1d"))
        lm._st = lm._State()
        with mock.patch.object(lm, "BUCKETS", 400):
            self.assertEqual(lm.restore(copy.deepcopy(data)), 0)
        with mock.patch.object(lm, "SPAN", 0.5):
            self.assertEqual(lm.restore(copy.deepcopy(data)), 0)
        with mock.patch.object(lm, "GROUPS", (10, 25, 50, 100)):
            self.assertEqual(lm.restore(copy.deepcopy(data)), 0)
        self.assertEqual(lm.restore({**data, "v": 0}), 0)

    def test_every_broken_field_is_rejected(self):
        data = self.built(("BTC", "1d"))
        st = data["maps"][0]["st"]
        bads = {
            "sym": ["btc", "", 1, "B" * 13], "range": ["2d", None, []], "px": [0, -1, True, "1", float("nan")],
            "lo": [-1, True, None], "step": [0, None], "at": [0, 1.5, True, None], "ex": ["OKX", [1], [""], ["A"] * 65],
            "path": [[], [0], "x", [1] * 201, [True]],
            "ohlc": [[], [[1, 2, 3]], [[0, 1, 1, 1]], [[1, 1, 1, 1]] * 101, [[1.0, 1.0, 1.0], *st["ohlc"][-1:]],
                     [[1.0, 1.0, 1.0, 1.0, 1.0], *st["ohlc"][1:]]],
            "oi": [-1, 1.5, None, True], "seen": [-1, None, True], "low": [0, None], "high": [0, None],
            "L": [[], [[]] * 4, None, [[[0, -1.0]]] * 5, [[[lm.BUCKETS, 1.0]]] * 5, [[[True, 1.0]]] * 5, [[[0, 1.0, 2]]] * 5],
            "S": [[[["0", 1.0]]] * 5, [[[0, float("inf")]]] * 5],
        }
        for field, values in bads.items():
            for v in values:
                d = copy.deepcopy(data)
                d["maps"][0]["st"][field] = v
                if field == "ohlc":
                    # Границы свечей (ohlc_t) по длине выдали бы порчу сами —
                    # проверяем саму проверку свечей, как у старой копии без них.
                    d["maps"][0]["st"].pop("ohlc_t", None)
                lm._st = lm._State()
                self.assertEqual(lm.restore(d), 0, f"{field} = {v!r}")
        for junk in (None, [], "x", {"v": 1}, {"v": 1, "at": "x", "maps": []}, {"v": 1, "at": 1, "maps": "x"}):
            self.assertEqual(lm.restore(junk), 0)
        for m in ("x", {"age": -1, "st": st}, {"age": True, "st": st}, {"st": st}):
            self.assertEqual(lm.restore({**data, "maps": [m]}), 0, m)

    def test_random_damage_never_breaks_the_server(self):
        data = self.built(("BTC", "1d"), ("ETH", "30d"))
        rnd = random.Random(5)  # noqa: S311 — порча копии, не тайна
        junk = [None, True, -1, 0, 1e400, "x", [], {}, [[1, 2]], 10 ** 30]
        for _ in range(300):
            d = copy.deepcopy(data)
            m = rnd.choice(d["maps"])
            target = m["st"] if rnd.random() < 0.8 else m
            target[rnd.choice(list(target))] = rnd.choice(junk)
            lm._st = lm._State()
            n = lm.restore(d)
            self.assertLessEqual(n, 2)
            for _born, _st, res in lm._st.hits.values():
                json.dumps(res, allow_nan=False)

    def test_bounded_by_cache_size(self):
        data = self.built(("BTC", "1d"))
        m = data["maps"][0]
        many = [copy.deepcopy(m) for _ in range(lm.CACHE_MAX + 20)]
        for i, x in enumerate(many):
            x["st"]["sym"] = f"C{i}"
        lm._st = lm._State()
        self.assertEqual(lm.restore({**data, "maps": many}), lm.CACHE_MAX)


class DiskFileTest(Base):
    def setUp(self):
        super().setUp()
        self.dir = tempfile.mkdtemp()
        patcher = mock.patch.object(api, "CACHE_DIR", self.dir)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_save_then_load_after_restart(self):
        self.built(("BTC", "1d"), ("SOL", "90d"))
        api.liq_disk_save()
        path = os.path.join(self.dir, api.LIQ_DISK)
        self.assertTrue(os.path.isfile(path))
        self.assertEqual([x for x in os.listdir(self.dir) if x.endswith(".tmp")], [])
        lm._st = lm._State()
        self.assertEqual(api.liq_disk_load(), 2)
        self.assertIn(("SOL", "90d"), lm._st.hits)

    def test_broken_huge_or_missing_file_is_ignored(self):
        path = os.path.join(self.dir, api.LIQ_DISK)
        self.assertEqual(api.liq_disk_load(), 0)
        with open(path, "w", encoding="utf-8") as f:
            f.write("{не json")
        self.assertEqual(api.liq_disk_load(), 0)
        with open(path, "w", encoding="utf-8") as f:
            f.write("[" * 100_000)
        self.assertEqual(api.liq_disk_load(), 0)
        with mock.patch.object(api, "LIQ_DISK_MAX", 10):
            self.built(("BTC", "1d"))
            api.liq_disk_save()  # больше предела — не пишется
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), "[" * 100_000)
        os.truncate(path, 0)
        self.assertEqual(api.liq_disk_load(), 0)

    def test_without_cache_dir_nothing_is_touched(self):
        with mock.patch.object(api, "CACHE_DIR", None):
            self.built(("BTC", "1d"))
            api.liq_disk_save()
            self.assertEqual(api.liq_disk_load(), 0)
        self.assertEqual(os.listdir(self.dir), [])

    def test_wired_into_start_and_warm_round(self):
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            src = f.read()
        wire = src.split("def wire() -> None:")[1].split("\ndef ")[0]
        self.assertIn("liq_disk_load()", wire)
        warm = src.split("def liq_warm_refresher() -> None:")[1].split("\ndef ")[0]
        self.assertIn("liq_disk_save()", warm)


if __name__ == "__main__":
    unittest.main()

"""Кеш ответов на диске: после перезапуска API первый запрос не ждёт сборку
(npm test). Перезапуск здесь — пустая память при том же каталоге кеша."""
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модуль лежит в корне репозитория
import wt_etf as etf  # noqa: E402
import wt_treasury as tr  # noqa: E402


class DiskCacheTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        p = mock.patch.object(api, "CACHE_DIR", self.dir)
        p.start()
        self.addCleanup(p.stop)
        self.store = api.disk_cache({}, "test")

    def wait_bg(self):
        for _ in range(100):
            if not any(t.name == "cache-bg" for t in threading.enumerate()):
                return
            time.sleep(0.02)

    def test_restart_serves_saved_then_refreshes(self):
        self.assertEqual(api.cached_bg(self.store, ("rank", 30), 60, lambda: {"ok": True, "v": 1}), {"ok": True, "v": 1})
        self.store.clear()  # «перезапуск»: память пуста, файл остался
        calls = []

        def slow():
            calls.append(1)
            time.sleep(0.1)
            return {"ok": True, "v": 2}

        t0 = time.monotonic()
        got = api.cached_bg(self.store, ("rank", 30), 60, slow)
        self.assertEqual(got, {"ok": True, "v": 1})  # сразу — копия с диска
        self.assertLess(time.monotonic() - t0, 0.08)
        self.wait_bg()
        self.assertEqual(calls, [1])  # и свежий собран в фоне
        self.assertEqual(api.cached_bg(self.store, ("rank", 30), 60, slow), {"ok": True, "v": 2})

    def test_failed_build_is_not_saved_and_old_file_stays(self):
        api.cached_bg(self.store, "k", 60, lambda: {"ok": True, "v": 1})
        self.store.clear()
        api.cached_bg(self.store, "k", 0, lambda: {"ok": False}, wait=True)
        self.store.clear()
        self.assertEqual(api.cached_bg(self.store, "k", 60, lambda: {"ok": False}), {"ok": True, "v": 1})

    def test_old_or_foreign_file_is_ignored(self):
        api.cached_bg(self.store, "k", 60, lambda: {"ok": True, "v": 1})
        path = api._disk_file("test", "k")
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        data["at"] -= api.DISK_MAX_AGE + 10
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        self.assertIsNone(api._disk_load("test", "k"))
        data["at"] = time.time()
        data["k"] = repr("другой ключ")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        self.assertIsNone(api._disk_load("test", "k"))
        with open(path, "w", encoding="utf-8") as f:
            f.write("{не json")
        self.assertIsNone(api._disk_load("test", "k"))

    def test_files_per_store_are_capped(self):
        with mock.patch.object(api, "DISK_KEEP", 3):
            for i in range(6):
                api.cached_bg(self.store, ("big", i), 60, lambda i=i: {"ok": True, "i": i})
                time.sleep(0.01)
        mine = [x for x in os.listdir(self.dir) if x.startswith("test-")]
        self.assertEqual(len(mine), 3)
        self.assertIsNotNone(api._disk_load("test", ("big", 5)))

    def test_unserializable_value_is_logged_not_raised(self):
        with mock.patch("sys.stderr", io.StringIO()) as err:
            self.assertEqual(api.cached_bg(self.store, "set", 60, lambda: {"ok": True, "s": {1}}), {"ok": True, "s": {1}})
        self.assertIn("кеш на диске test", err.getvalue())
        self.assertFalse([x for x in os.listdir(self.dir) if x.endswith(".tmp")])

    def test_heavy_stores_are_on_disk(self):
        for store in (api._BTC, api._BSCX, api._OIH, api._CHART, api._OPT, api._CAL):
            self.assertIn(id(store), api._DISK)


class EtfFileTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        etf._st = etf._State()
        etf._busy.clear()
        etf.set_cache_file(os.path.join(self.dir, "etf.json"))
        self.addCleanup(setattr, etf, "_st", etf._State())

    def test_restart_gets_saved_reply_at_once(self):
        res = {"ok": True, "coins": {"btc": {"funds": []}}, "at": 1}
        with mock.patch.object(etf, "_coin", lambda c, s: {"funds": []}), \
                mock.patch.object(etf, "_cme", dict), mock.patch.object(etf, "_cbp", dict), \
                mock.patch.object(etf.wt_treasury, "companies", list):
            etf.build()
        self.assertTrue(os.path.exists(os.path.join(self.dir, "etf.json")))
        path = etf._st.file
        etf._st = etf._State()  # «перезапуск»
        etf.set_cache_file(path)
        calls = []
        with mock.patch.object(etf, "build", lambda: calls.append(1) or res):
            got = etf.etf_data()
            for _ in range(50):
                if not etf._busy.is_set():
                    break
                time.sleep(0.02)
        self.assertTrue(got["ok"])
        self.assertEqual(got["coins"], {"btc": {"funds": []}})
        self.assertEqual(calls, [1])  # свежий — в фоне

    def test_broken_or_old_file_is_ignored(self):
        path = os.path.join(self.dir, "etf.json")
        for body in ("{", json.dumps({"at": 0, "v": {"ok": True}}), json.dumps({"at": time.time(), "v": {"ok": False}})):
            with open(path, "w", encoding="utf-8") as f:
                f.write(body)
            self.assertIsNone(etf._file_load())


class TreasuryFileTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        tr._st, tr._fst = tr._State(), tr._FundState()
        tr.set_cache_dir(self.dir)
        self.addCleanup(tr.set_cache_dir, None)

    def test_restart_does_not_ask_sec_again(self):
        good = json.dumps({"facts": {"us-gaap": {"CryptoAssetFairValue": {"units": {"USD": [
            {"end": "2026-06-30", "val": 5e9, "form": "10-Q", "filed": "2026-08-01"}]}}}}}).encode()
        urls = []

        def fetch(url, timeout):
            urls.append(url)
            return good

        with mock.patch.object(tr, "_fetch", fetch), mock.patch.object(tr, "PAUSE", 0), \
                mock.patch.dict(os.environ, {"WT_SEC_UA": "x a@b.c"}):
            first = tr.etf_funds()
            n = len(urls)
            tr._fst = tr._FundState()  # «перезапуск»
            again = tr.etf_funds()
        self.assertEqual(len(urls), n)  # SEC второй раз не спрашивали
        self.assertEqual(again, first)
        self.assertEqual(list(again["IBIT"]["q"]), [1_782_777_600])  # ключи кварталов — снова числа

    def test_stale_copy_is_used_when_sec_is_down(self):
        tr._file_save("sec_companies.json", [["Strategy", "COMPANY", "US", "MSTR", 1.0, 0], "мусор"])
        path = os.path.join(self.dir, "sec_companies.json")
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        data["at"] -= tr.TTL + 60  # копия старше полусуток
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        with mock.patch.object(tr, "_fetch", lambda url, timeout: None), mock.patch.object(tr, "PAUSE", 0), \
                mock.patch.dict(os.environ, {"WT_SEC_UA": "x a@b.c"}), mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(tr.companies(), [["Strategy", "COMPANY", "US", "MSTR", 1.0, 0]])


if __name__ == "__main__":
    unittest.main()

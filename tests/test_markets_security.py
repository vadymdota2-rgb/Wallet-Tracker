"""Атаки на модуль рынков (wt_markets.py): npm test.

Модель угрозы: источник (Hyperliquid, Frankfurter, модуль доминации) взломан
или ответ подменён. Он не должен: уронить сборку числом больше float
(10**400) или вложенностью, сжечь процессор огромным ответом, протащить
свои строки в ответ приложению, сдвинуть время ответа, держать запрос
человека дольше обещанного или заставить сервер долбить источник на каждый
запрос. Сам модуль в сеть не ходит (это проверяют правила кода), поэтому
здесь — только то, что приходит из чужих ответов.
"""
import io
import json
import os
import sys
import threading
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
from test_markets import (  # noqa: E402 — общие данные тестов модуля
    FRI,
    FX,
    NOW,
    PARTS,
    WD,
    hl,
    items,
    join_new_threads,
)

import wt_markets as mk  # noqa: E402 — модуль лежит в корне репозитория

EVIL = '<img src=x onerror=alert(1)>'


class HostileSourceTest(unittest.TestCase):
    def test_numbers_bigger_than_float(self):
        big = 10**400
        for v in (big, -big, str(big), "1e999", "-1e999", float("inf"), "Infinity"):
            self.assertIsNone(mk.pair(v, 1))
            xyz = hl({"xyz:SP500": (7373, 7392)})
            xyz[1][0] = {"markPx": v, "prevDayPx": v}
            self.assertNotIn("SP500", items(mk.compute({**PARTS, "xyz": xyz}, NOW)))
            fx = {**FX, "EUR": [{"t": (FRI - 3600) * 1000, "c": v}]}
            self.assertNotIn("DXY", items(mk.compute({**PARTS, "fx": fx}, NOW)))
            self.assertEqual(mk.candle_close([{"t": v, "c": "1"}], FRI), 0.0)
            ecb = {"rates": {"2026-11-06": dict.fromkeys(("EUR", "JPY", "GBP", "CAD", "SEK", "CHF"), v)}}
            self.assertEqual(mk.ecb_rates(ecb), {})
            mcap = {"ok": True, "btc": [v, 60], "usdt": v, "cap": [v, 3e12]}
            self.assertEqual(mk.dominance(mcap), {})
            aster = {"at": v, "rows": [{"symbol": "XAUUSDT", "lastPrice": "4000", "openPrice": "4010"}]}
            self.assertEqual(mk.aster_markets(aster, NOW), {})
            aster = {"at": NOW, "rows": [{"symbol": "XAUUSDT", "lastPrice": v, "openPrice": v}]}
            self.assertEqual(mk.aster_markets(aster, NOW), {})

    def test_deep_nesting_and_wrong_types(self):
        deep: object = []
        for _ in range(100_000):
            deep = [deep]
        for raw in (deep, {"rates": deep}, {"universe": deep}, [deep, deep], "x" * 1_000_000, b"\x00", 3.5):
            for name in ("xyz", "para", "mkts", "fx", "ecb", "mcap"):
                res = mk.compute({**PARTS, name: raw}, NOW)
                json.dumps(res, allow_nan=False)

    def test_own_strings_only(self):
        # Имена рынков, даты и поля источника в ответ не попадают — только наши
        # ключи и числа.
        xyz = hl({f"xyz:{EVIL}": (1, 1), "xyz:SP500": (7373, 7392), "xyz:GOLD": (4066, 4079)})
        xyz[0]["universe"].append({"name": "xyz:CL", "evil": EVIL})
        xyz[1].append({"markPx": "90", "prevDayPx": "89", "funding": EVIL})
        ecb = {"rates": {EVIL: PARTS["ecb"]["rates"]["2026-11-06"], **PARTS["ecb"]["rates"]}}
        res = mk.compute({**PARTS, "xyz": xyz, "ecb": ecb, "mcap": {**PARTS["mcap"], "note": EVIL}}, NOW)
        text = json.dumps(res, ensure_ascii=False)
        self.assertNotIn("<", text)
        self.assertNotIn("evil", text)
        self.assertEqual(set(res), {"ok", "at", "items"})
        self.assertTrue(all(set(it) == {"k", "px", "prev"} and it["k"] in mk.KEYS for it in res["items"]))

    def test_time_is_ours(self):
        # Время ответа — наши часы, а не источника; свечи «из будущего» не
        # становятся закрытием.
        res = mk.compute(PARTS, NOW)
        self.assertEqual(res["at"], NOW)
        future = [{"t": (NOW + 86400) * 1000, "c": "9.9"}]
        self.assertEqual(mk.candle_close(future, FRI), 0.0)
        fx = {c: v + future for c, v in FX.items()}
        self.assertEqual(items(mk.compute({**PARTS, "fx": fx}, NOW))["DXY"], items(res)["DXY"])

    def test_huge_answers_cost_little(self):
        # Ответ в сотни тысяч рынков, свечей и дней разбирается быстро: хвост
        # за пределом не смотрим.
        n = 200_000
        uni = [{"name": f"xyz:M{i}"} for i in range(n)]
        ctx = [{"markPx": "1", "prevDayPx": "1"}] * n
        candles = [{"t": (FRI - 3600) * 1000, "c": "1.115"}] * n
        rates = {f"2026-{1 + i % 12:02d}-{1 + i % 28:02d}x{i}": {} for i in range(n)}
        t0 = time.process_time()
        mk.compute({**PARTS, "xyz": [{"universe": uni}, ctx], "fx": {"EUR": candles, "JPY": candles, "GBP": candles},
                    "ecb": {"rates": rates}}, NOW)
        self.assertLess(time.process_time() - t0, 1.0)


class HostileHistoryFileTest(unittest.TestCase):
    """Копия истории на диске подменена или испорчена: сервер не падает, не
    зависает, не берёт чужое и не отдаёт его подписчикам."""

    def setUp(self):
        self.addCleanup(setattr, mk, "_st", mk._st)
        mk._st = mk._State()

    def load(self, body: str | bytes) -> int:
        import tempfile  # noqa: PLC0415

        import whale_api as api  # noqa: PLC0415
        with tempfile.TemporaryDirectory() as d, mock.patch.object(api, "CACHE_DIR", d), \
                mock.patch.object(mk, "_now", return_value=NOW):
            mode = "wb" if isinstance(body, bytes) else "w"
            with open(os.path.join(d, api.MARKETS_DISK), mode) as f:
                f.write(body)
            return api.markets_disk_load()

    def test_broken_and_hostile_files_are_ignored(self):
        for body in ("", "{", "null", "[]", '"x"', b"\xff\xfe", "{" * 100_000 + "}" * 100_000,  # вложенность
                     json.dumps({"series": {"GOLD": [[NOW, 10**400], [NOW, "NaN"], [True, 4000], [NOW, float("inf")]]}}).replace("Infinity", "1e999"),
                     json.dumps({"series": {"GOLD": [[NOW - 60, 4000.0, "лишнее"]], "<script>": [[NOW, 1.0]]}})):
            self.assertEqual(self.load(body), 0, str(body)[:60])
        self.assertEqual(mk._st.hist, {})
        self.assertEqual(mk.history(), {"ok": False, "error": "no_data"})

    def test_huge_file_costs_little(self):
        # Миллион точек в пределах MARKETS_DISK_MAX не влезет — а то, что
        # влезло, читается быстро и обрезается до HIST_MAX на пункт.
        pts = [[NOW - 86_000 + i, 4000.0] for i in range(20_000)]
        body = json.dumps({"series": {"GOLD": pts}}, separators=(",", ":"))
        t0 = time.monotonic()
        n = self.load(body)
        self.assertLess(time.monotonic() - t0, 2)
        self.assertEqual(n, mk.HIST_MAX)
        self.assertEqual(len(mk._st.hist["GOLD"]), mk.HIST_MAX)

    def test_only_our_numbers_go_out(self):
        self.load(json.dumps({"series": {"GOLD": [[NOW - 60, 4000.0]], "evil": [[NOW, 1.0]]}, "x": "<img onerror>"}))
        out = json.dumps(mk.history())
        self.assertNotIn("evil", out)
        self.assertNotIn("<img", out)
        self.assertEqual(mk.history()["series"], {"GOLD": [[NOW - 60, 4000.0]]})

    def test_stale_tmp_copy_name_is_cleaned_by_the_server(self):
        # Временный файл копии — «markets_hist.json.<pid>.<поток>.tmp»: его
        # узнаёт уборка брошенных копий сервера.
        import whale_api as api  # noqa: PLC0415
        self.assertTrue(api._TMP_RE.search(f"{api.MARKETS_DISK}.123.456.tmp"))


class HugeBodyTest(unittest.TestCase):
    """Источник отдаёт гигабайт: сервер читает не больше RESP_MAX байт и
    бросает ответ, а не держит его в памяти целиком."""

    def test_body_over_the_limit_is_not_read(self):
        import whale_api as api  # noqa: PLC0415 — сервер нужен только здесь

        class Body:
            def __init__(self, size: int):
                self.size, self.asked = size, []

            def read(self, n: int = -1) -> bytes:
                self.asked.append(n)
                k = self.size if n < 0 else min(n, self.size)
                return b"[" + b" " * (k - 2) + b"]" if k >= 2 else b"[]"

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        big = Body(1 << 30)
        with mock.patch.object(api.urllib.request, "urlopen", lambda *a, **k: big):
            self.assertIsNone(api.hl_post({"type": "metaAndAssetCtxs", "dex": "xyz"}, 15, max_bytes=mk.RESP_MAX))
            self.assertIsNone(api.get_json("https://api.frankfurter.dev/v1/x", 15, max_bytes=mk.RESP_MAX))
        self.assertEqual(big.asked, [mk.RESP_MAX + 1] * 2)  # не гигабайт, а предел и байт сверху
        ok = Body(64 * 1024)
        with mock.patch.object(api.urllib.request, "urlopen", lambda *a, **k: ok):
            self.assertEqual(api.hl_post({"type": "x"}, 15, max_bytes=mk.RESP_MAX), [])
        self.assertGreater(mk.RESP_MAX, 10 * 64 * 1024)  # у самых больших ответов (~60 КБ) запас вдесятеро


class HostileTimingTest(unittest.TestCase):
    def setUp(self):
        quiet = mock.patch.object(mk.sys, "stderr", io.StringIO())  # журнал модуля — не в вывод тестов
        quiet.start()
        self.addCleanup(quiet.stop)
        self.addCleanup(setattr, mk, "_st", mk._st)
        self.addCleanup(join_new_threads, set(threading.enumerate()))
        mk._st = mk._State()

    def test_hanging_source_does_not_hold_the_person(self):
        gate = threading.Event()
        self.addCleanup(gate.set)
        mk.set_sources({**{n: (lambda v=v: v) for n, v in PARTS.items()}, "ecb": lambda: gate.wait(30) and PARTS["ecb"]})
        with mock.patch.object(mk, "_now", return_value=NOW):
            t0 = time.monotonic()
            mk.refresh()
            first = mk.markets_data(0.3)
            self.assertLess(time.monotonic() - t0, 2)
            self.assertEqual(first, {"ok": False, "error": "no_data"})
            # Пока сборка ждёт источник, другие запросы не стоят на замке.
            t0 = time.monotonic()
            mk.markets_data(0)
            self.assertLess(time.monotonic() - t0, 0.5)
            gate.set()

    def test_failing_build_does_not_hammer_sources(self):
        calls: list = []

        def boom():
            calls.append(1)
            raise OSError("нет сети")

        mk.set_sources(dict.fromkeys(PARTS, boom))
        mk.refresh(5)
        job = mk._st.job
        if job is not None:
            job.join(5)
        n = len(calls)
        for _ in range(50):
            mk.refresh()
            mk.markets_data(0)
        self.assertEqual(len(calls), n)  # после сбоя — пауза FAIL_WAIT, а не запрос на каждый вызов

    def test_weekday_answer_does_not_wait_for_candles(self):
        # Свечи нужны для прошлого закрытия; без них DXY нет, остальное — есть.
        res = mk.compute({**PARTS, "fx": None}, WD)
        self.assertNotIn("DXY", items(res))
        self.assertIn("SP500", items(res))


if __name__ == "__main__":
    unittest.main()

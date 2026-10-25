"""Модуль «Страха и жадности» (wt_fng.py): сборка, кэш, копия на диске (npm test).

Сеть подменена выдуманными источниками (tests/fng_fake.py): цена — формула,
и закрытие каждого дня известно точно.
"""
import itertools
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
import fng_fake as fake  # noqa: E402

import wt_fng as fng  # noqa: E402 — модуль лежит в корне репозитория

DAY = fake.DAY
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "fng.json")


def fresh() -> None:
    fng._st = fng._State()
    fng._busy.clear()
    fng._dl.at = 0.0


def build(over=None, now=fake.NOW):
    net = fake.network(over)
    with mock.patch.object(fng, "_fetch", net), mock.patch.object(fng, "_now", lambda: now), \
            mock.patch.object(fng, "_log", lambda m: None):
        return fng.build(), net.calls


# Большие ответы (1400 дней) сравниваются через assertTrue(a == b): при
# расхождении assertEqual строил бы построчную разницу двух огромных списков —
# минута процессора на каждую порчу в мутационной проверке.


class BuildTest(unittest.TestCase):
    def setUp(self):
        fresh()

    def test_days_follow_the_index_one_by_one(self):
        r, _ = build()
        self.assertTrue(r["ok"])
        days = r["days"]
        self.assertEqual(days[0][0], fake.START)
        self.assertEqual(days[-1][0], fake.TODAY)
        self.assertEqual(len(days), fake.DAYS)
        self.assertTrue([d[0] for d in days] == list(range(fake.START, fake.TODAY + DAY, DAY)))
        self.assertEqual(r["at"], fake.NOW)
        self.assertEqual(set(r), {"ok", "days", "at"})
        for t, v, _p, f in days:
            if t not in fake.GAPS:
                self.assertEqual((v, f & fng.F_FILL), (fake.index_value(t), 0), t)

    def test_missing_index_day_takes_the_previous_one_and_is_marked(self):
        r, _ = build()
        by = {d[0]: d for d in r["days"]}
        for t in fake.GAPS:
            prev = t - DAY
            while prev in fake.GAPS:
                prev -= DAY
            self.assertEqual(by[t][1], fake.index_value(prev), t)
            self.assertTrue(by[t][3] & fng.F_FILL, t)
        self.assertEqual(sum(1 for d in r["days"] if d[3] & fng.F_FILL), len(fake.GAPS))

    def test_close_is_the_price_at_midnight_after_the_day(self):
        r, _ = build()
        exact = [d for d in r["days"] if not d[3] & fng.F_EST]
        self.assertGreater(len(exact), 700)
        for t, _v, p, _f in exact:
            want = fake.price(min(t + DAY, fake.NOW - 60))
            # Точно (до центов округления), кроме четверга среди часов:
            # там дневной свечи нет, закрытие — по точке в 23:00 (час раньше).
            self.assertAlmostEqual(p / want, 1, delta=0.005, msg=(t - fake.START) // DAY)

    def test_weekly_candle_is_moved_to_its_close(self):
        # Неделя до WEEKLY_TO: в каждый 7-й день цена точная (свеча четверга
        # закрылась в 00:00 следующего четверга = закрытие среды), остальные — ≈.
        r, _ = build()
        early = [d for d in r["days"] if d[0] + DAY < fake.WEEKLY_TO]
        exact = [d for d in early if not d[3] & fng.F_EST]
        self.assertTrue(exact)
        for t, _v, p, _f in exact:
            self.assertTrue(fake.is_thursday(t + DAY), t)  # закрытие среды — в 00:00 четверга
            self.assertAlmostEqual(p, fake.price(t + DAY), delta=0.06)
        self.assertGreater(sum(1 for d in early if d[3] & fng.F_EST), len(early) * 0.8)

    def test_interpolated_price_lies_between_weekly_points(self):
        # В недельные годы досчитанная цена — между соседними точными днями
        # (их закрытия — сами недельные точки); по логарифму, не выше и не ниже.
        r, _ = build()
        weekly = [d for d in r["days"] if d[0] + DAY < fake.WEEKLY_TO]
        exact = [i for i, d in enumerate(weekly) if not d[3] & fng.F_EST]
        self.assertGreater(len(exact), 50)
        for a, b in itertools.pairwise(exact):
            self.assertEqual(b - a, 7)
            lo, hi = sorted((weekly[a][2], weekly[b][2]))
            for d in weekly[a + 1:b]:
                self.assertTrue(d[3] & fng.F_EST)
                self.assertTrue(lo - 0.01 <= d[2] <= hi + 0.01, d[0])

    def test_candle_among_hourly_points_is_told_apart(self):
        # Первые сутки среди часов точка в 00:00 — ещё свеча: она ближе к цене
        # за час до закрытия свечи, чем к соседям, — и уходит на закрытие.
        raw = {p["time"]: p["USD"] for p in fake.history_points()}
        t0 = fake.HOURLY_FROM // DAY * DAY + DAY
        span = 7 * DAY if fake.is_thursday(t0) else DAY
        self.assertEqual(fng._when(t0, raw), t0 + span)
        late = t0 + 30 * DAY
        self.assertEqual(fng._when(late, raw), late)
        self.assertEqual(fng._when(late + 13 * fake.HOUR, raw), late + 13 * fake.HOUR)
        # Без соседей: четверг — неделя, другой день — сутки.
        self.assertEqual(fng._when(fake.START, {}), fake.START + 7 * DAY)
        self.assertEqual(fng._when(fake.START + DAY, {}), fake.START + 2 * DAY)

    def test_close_rules(self):
        # Точка у полуночи — цена как есть; между далёкими точками — по
        # логарифму (середина между 100 и 400 — 200, а не 250); дальше
        # GAP_MAX — не знаем; идущий день — последняя цена, если она из него.
        t = fake.START + 10 * DAY
        end = t + DAY
        self.assertEqual(fng._close([end - fng.EXACT], [5000.0], t, end + DAY), (5000.0, 0))
        self.assertEqual(fng._close([end - fng.EXACT - 1, end + DAY], [5000.0, 6000.0], t, end + 5 * DAY)[1], fng.F_EST)
        p, f = fng._close([end - 3 * DAY, end + 3 * DAY], [1000.0, 4000.0], t, end + 9 * DAY)
        self.assertAlmostEqual(p, 2000.0)
        self.assertEqual(f, fng.F_EST)
        self.assertEqual(fng._close([end - 5 * DAY, end + 5 * DAY], [1000.0, 4000.0], t, end + 9 * DAY), (0.0, 0))
        self.assertEqual(fng._close([], [], t, end), (0.0, 0))
        # День идёт.
        self.assertEqual(fng._close([t + 3600], [7000.0], t, t + 7200), (7000.0, 0))
        self.assertEqual(fng._close([t - 3600], [7000.0], t, t + 7200), (0.0, 0))

    def test_live_price_older_than_history_is_ignored(self):
        old = json.dumps({"time": fake.NOW - 5 * fake.HOUR, "USD": 1_000_000}).encode()
        r, _ = build({"/v1/prices": old})
        # Сегодня — по последней точке истории, а не по старой «текущей» цене.
        self.assertNotEqual(r["days"][-1][2], 1_000_000)
        self.assertEqual(r["days"][-1][2], max(fake.history_points(), key=lambda x: x["time"])["USD"])
        stale = json.dumps({"time": fake.NOW - 2 * DAY, "USD": 1_000_000}).encode()
        with mock.patch.object(fng, "_fetch", fake.network({"/v1/prices": stale})), \
                mock.patch.object(fng, "_now", lambda: fake.NOW):
            self.assertIsNone(fng._live())

    def test_live_price_from_the_future_is_ignored(self):
        for t in (fake.NOW + fng.MAX_FUTURE + 1, fake.NOW - DAY - 1):
            body = json.dumps({"time": t, "USD": 80_000}).encode()
            with mock.patch.object(fng, "_fetch", fake.network({"/v1/prices": body})), \
                    mock.patch.object(fng, "_now", lambda: fake.NOW):
                self.assertIsNone(fng._live(), t)
        body = json.dumps({"time": fake.NOW + 60, "USD": 80_000}).encode()
        with mock.patch.object(fng, "_fetch", fake.network({"/v1/prices": body})), \
                mock.patch.object(fng, "_now", lambda: fake.NOW):
            self.assertEqual(fng._live(), (fake.NOW + 60, 80_000.0))

    def test_today_uses_the_live_price(self):
        r, calls = build()
        self.assertEqual(r["days"][-1][2], round(fake.price(fake.NOW - 60)))
        self.assertEqual(r["days"][-1][3], 0)
        self.assertEqual(sum("/v1/prices" in c for c in calls), 1)

    def test_no_index_is_no_data_and_a_pause(self):
        r, calls = build({"alternative.me": None})
        self.assertEqual(r, {"ok": False, "error": "no_data"})
        self.assertTrue(fng._failed())
        self.assertEqual(len(calls), 1)  # цены без индекса не нужны

    def test_cut_index_is_not_trusted(self):
        rows = fake.index_rows()
        cut = json.dumps({"data": rows[:500]}).encode()
        self.assertEqual(build({"alternative.me": cut})[0]["ok"], False)
        # Дыры: каждый десятый день выброшен — дней хватает, но это обрезанный ответ.
        holey = json.dumps({"data": [x for i, x in enumerate(rows) if i % 10]}).encode()
        self.assertGreater(len(rows) * 0.9, fng.MIN_DAYS)
        fresh()
        self.assertEqual(build({"alternative.me": holey})[0]["ok"], False)

    def test_bad_index_rows_are_dropped(self):
        rows = fake.index_rows()
        day = {int(r["timestamp"]): r for r in rows}
        a, b = fake.START + 200 * DAY, fake.START + 300 * DAY
        day[a]["value"] = "101"  # больше 100
        day[b]["timestamp"] = str(b + 7)  # не полночь
        rows.insert(0, {"value": "50", "timestamp": str(fake.TODAY + 3 * DAY)})  # из будущего
        r, _ = build({"alternative.me": json.dumps({"data": rows}).encode()})
        by = {d[0]: d for d in r["days"]}
        self.assertEqual(r["days"][-1][0], fake.TODAY)
        # Последний день не в полночь — его нет, и лишнего дня после него тоже.
        fresh()
        rows2 = fake.index_rows()
        rows2[0]["timestamp"] = str(fake.TODAY + 7)
        r2, _ = build({"alternative.me": json.dumps({"data": rows2}).encode()})
        self.assertEqual(r2["days"][-1][0], fake.TODAY - DAY)
        for t in (a, b):
            self.assertEqual(by[t][3] & fng.F_FILL, fng.F_FILL, t)
            self.assertEqual(by[t][1], by[t - DAY][1])

    def test_index_that_went_back_in_time_keeps_the_last_answer(self):
        good, _ = build()
        fng._st.err_at = float("-inf")
        older = json.dumps({"data": fake.index_rows()[3:]}).encode()
        r, _ = build({"alternative.me": older})
        self.assertIs(r, good)
        self.assertTrue(fng._failed())

    def test_price_history_is_fetched_once_per_px_ttl(self):
        build()
        fng._st.hit = None
        _, calls = build()
        self.assertFalse(any("historical-price" in c for c in calls))
        fng._st.px_at -= fng.PX_TTL
        fng._st.hit = None
        _, calls = build()
        self.assertEqual(sum("historical-price" in c for c in calls), 1)

    def test_silent_price_source_keeps_old_prices(self):
        good, _ = build()
        fng._st = fng._State(hit=fng._st.hit)
        r, _ = build({"historical-price": None, "/v1/prices": None})
        self.assertTrue(r["ok"])
        self.assertTrue([d[2] for d in r["days"]] == [d[2] for d in good["days"]], "цены разошлись")
        # Без старых цен и без источника — цена 0, но индекс есть.
        fresh()
        r, _ = build({"historical-price": None, "/v1/prices": None})
        self.assertTrue(r["ok"])
        self.assertTrue(all(d[2] == 0 for d in r["days"]))

    def test_no_price_history_means_a_short_lived_answer(self):
        r, _ = build({"historical-price": None, "/v1/prices": None})
        self.assertTrue(r["ok"])
        age = time.monotonic() - fng._st.hit[0]
        self.assertGreater(age, fng.TTL - fng.ERR_TTL - 5)  # устареет через ERR_TTL
        self.assertLess(age, fng.TTL - fng.ERR_TTL + 5)
        fresh()
        build()
        self.assertLess(time.monotonic() - fng._st.hit[0], 5)  # с историей — полный TTL

    def test_backup_price_fills_days_when_mempool_is_silent(self):
        # mempool молчит — цена из запасных закрытий (Hyperliquid), с флагом
        # F_HL; дни до начала запасной истории — без цены.
        hl_from = fake.START + 900 * DAY
        backup = {t: fake.price(t + DAY) * 1.001 for t in range(hl_from, fake.TODAY, DAY)}
        backup[fake.TODAY] = 99_999.0  # идущий день — не закрыт: не берём
        backup[hl_from - DAY] = 5.0  # копейки — не цена
        backup[hl_from - 2 * DAY] = float("nan")
        backup["x"] = 80_000.0  # type: ignore[index]
        fng.set_backup(lambda: backup)
        self.addCleanup(fng.set_backup, None)
        r, _ = build({"historical-price": None, "/v1/prices": None})
        by = {d[0]: d for d in r["days"]}
        self.assertEqual(by[hl_from][2], round(backup[hl_from], 2))
        self.assertEqual(by[hl_from][3] & fng.F_HL, fng.F_HL)
        self.assertEqual(by[hl_from - DAY][2], 0)
        self.assertEqual(by[hl_from - 2 * DAY][2], 0)
        self.assertEqual(by[fake.TODAY][2], 0)
        self.assertEqual(by[fake.START][2], 0)
        # С запасной ценой ответ живёт обычный TTL: mempool не дёргаем чаще.
        self.assertLess(time.monotonic() - fng._st.hit[0], 5)

    def test_previous_mempool_price_beats_backup_and_mempool_beats_both(self):
        good, _ = build()
        fng.set_backup(lambda: {t: 12_345.0 for t in range(fake.START, fake.TODAY, DAY)})
        self.addCleanup(fng.set_backup, None)
        fng._st = fng._State(hit=fng._st.hit, backup=fng._st.backup)
        r, _ = build({"historical-price": None, "/v1/prices": None})
        self.assertTrue([d[2] for d in r["days"]] == [d[2] for d in good["days"]], "цены разошлись")
        self.assertFalse(any(d[3] & fng.F_HL for d in r["days"]))
        fresh()
        fng.set_backup(lambda: {t: 12_345.0 for t in range(fake.START, fake.TODAY, DAY)})
        r, _ = build()
        self.assertTrue(r == good, "запасная вмешалась")  # история mempool есть — запасная не нужна

    def test_backup_fills_a_hole_in_mempool_history(self):
        # В истории mempool месяц без точек (дальше GAP_MAX) — эти дни берут
        # запасную цену, остальные остаются от mempool.
        a, b = fake.START + 1100 * DAY, fake.START + 1130 * DAY
        pts = [p for p in fake.history_points() if not a - 3 * fake.HOUR <= p["time"] <= b + 3 * fake.HOUR]
        fng.set_backup(lambda: {t: 12_345.0 for t in range(fake.START, fake.TODAY, DAY)})
        self.addCleanup(fng.set_backup, None)
        r, _ = build({"historical-price": json.dumps({"prices": pts}).encode()})
        by = {d[0]: d for d in r["days"]}
        mid = (a + b) // 2 // DAY * DAY
        self.assertEqual((by[mid][2], by[mid][3] & fng.F_HL), (12_345.0, fng.F_HL))
        self.assertNotEqual(by[a - 10 * DAY][2], 12_345.0)
        self.assertNotEqual(by[b + 10 * DAY][2], 12_345.0)
        self.assertFalse(by[b + 10 * DAY][3] & fng.F_HL)

    def test_broken_backup_does_not_break_the_build(self):
        def boom():
            raise RuntimeError("wt_dom сломался")
        logs = []
        fng.set_backup(boom)
        self.addCleanup(fng.set_backup, None)
        with mock.patch.object(fng, "_fetch", fake.network({"historical-price": None, "/v1/prices": None})), \
                mock.patch.object(fng, "_now", lambda: fake.NOW), mock.patch.object(fng, "_log", logs.append):
            r = fng.build()
        self.assertTrue(r["ok"])
        self.assertTrue(any("запасная цена" in m for m in logs))
        self.assertFalse(any(m.startswith("сборка") for m in logs))

    def test_implausible_prices_are_dropped(self):
        good, _ = build()
        fresh()
        pts = fake.history_points()
        at = {p["time"]: p for p in pts}
        # Цены, которые были бы закрытиями трёх дней: копейки, миллиард, строка.
        for k, bad in ((fake.TODAY - DAY, 5.0), (fake.TODAY - 2 * DAY, 1e9), (fake.TODAY - 3 * DAY, "80000")):
            at[k]["USD"] = bad
        pts.append({"time": fake.NOW + 10 * DAY, "USD": 99_999})  # из будущего
        pts.append({"time": fng.START - 30 * DAY, "USD": 50_000})  # задолго до начала (свеча на неделю вперёд не дотянет)
        body = json.dumps({"prices": pts}).encode()
        r, _ = build({"historical-price": body})
        for i in (-2, -3, -4):
            p = r["days"][i][2]
            self.assertTrue(fng.PX_MIN < p < fng.PX_MAX, p)
            self.assertNotIn(p, (5.0, 1e9, 80000))
            self.assertAlmostEqual(p / good["days"][i][2], 1, delta=0.01)
        self.assertEqual(r["days"][-1][2], good["days"][-1][2])  # сегодня — текущая цена, а не «будущая»
        self.assertEqual(r["days"][0][2], good["days"][0][2])

    def test_fixture_is_this_build(self):
        # Образец для приложения — ровно то, что собирает модуль из выдуманных
        # источников (и now, как в ответе HTTP).
        r, _ = build()
        with open(FIXTURE, encoding="utf-8") as f:
            saved = json.load(f)
        self.assertTrue(saved == {**r, "now": fake.NOW}, "образец устарел: пересоберите tests/fixtures/fng.json")


class CacheTest(unittest.TestCase):
    def setUp(self):
        fresh()
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(lambda: [os.unlink(os.path.join(self.tmp, f)) for f in os.listdir(self.tmp)]
                        and os.rmdir(self.tmp))

    def test_route_serves_ready_bytes_with_etag(self):
        # /api/fng — один ответ на всех: готовые байты и «304 не изменилось».
        import whale_api as api  # noqa: PLC0415 — тяжёлый модуль, нужен одному тесту
        sys.path.insert(0, os.path.join(ROOT, "tests"))
        from test_dom_http import Fake  # noqa: PLC0415
        # Импорт whale_api подключает настоящую папку кэша и запасную цену —
        # тесту они не нужны: начинаем с чистого модуля.
        fresh()
        api._PUBLIC.clear()
        with mock.patch.object(fng, "_fetch", fake.network()), mock.patch.object(fng, "_now", lambda: fake.NOW):
            obj = fng.fng_data()
        first = Fake().get("fng", obj)
        self.assertEqual(json.loads(first.h.wfile.getvalue()), obj)
        again = Fake(first.hdr["ETag"]).get("fng", fng.fng_data())
        self.assertEqual((again.code, again.h.wfile.getvalue()), (304, b""))
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            self.assertIn('self._json_public("fng", wt_fng.fng_data())', f.read())

    def test_fresh_answer_is_served_from_memory(self):
        net = fake.network()
        with mock.patch.object(fng, "_fetch", net), mock.patch.object(fng, "_now", lambda: fake.NOW):
            a = fng.fng_data()
            n = len(net.calls)
            b = fng.fng_data()
        self.assertIs(a, b)
        self.assertEqual(len(net.calls), n)

    def test_stale_answer_is_served_and_refreshed_in_background(self):
        net = fake.network()
        with mock.patch.object(fng, "_fetch", net), mock.patch.object(fng, "_now", lambda: fake.NOW):
            a = fng.fng_data()
            fng._st.hit = (time.monotonic() - fng.TTL - 1, a)
            b = fng.fng_data()
            self.assertIs(b, a)
            for _ in range(200):
                if not fng._busy.is_set():
                    break
                time.sleep(0.01)
        self.assertFalse(fng._busy.is_set())
        self.assertIsNot(fng._st.hit[1], a)
        self.assertLess(time.monotonic() - fng._st.hit[0], fng.TTL)

    def test_cold_start_builds_once_for_everyone(self):
        started = threading.Event()
        gate = threading.Event()
        calls = []
        real = fake.network()

        def slow(url, limit):
            calls.append(url)
            started.set()
            gate.wait(5)
            return real(url, limit)

        out = []
        with mock.patch.object(fng, "_fetch", slow), mock.patch.object(fng, "_now", lambda: fake.NOW):
            ths = [threading.Thread(target=lambda: out.append(fng.fng_data())) for _ in range(8)]
            for th in ths:
                th.start()
            started.wait(5)
            gate.set()
            for th in ths:
                th.join(10)
        self.assertEqual(len(out), 8)
        self.assertTrue(all(r is out[0] for r in out))
        self.assertEqual(sum("alternative.me" in c for c in calls), 1)

    def test_stale_answer_is_not_rebuilt_right_after_a_failure(self):
        good = {"ok": True, "days": [], "at": 1}
        fng._st.hit = (time.monotonic() - fng.TTL - 1, good)
        fng._st.err_at = time.monotonic()
        net = fake.network()
        with mock.patch.object(fng, "_fetch", net):
            self.assertIs(fng.fng_data(), good)
        self.assertFalse(fng._busy.is_set())
        self.assertEqual(net.calls, [])

    def test_failed_sources_are_left_alone_for_err_ttl(self):
        net = fake.network({"alternative.me": None})
        with mock.patch.object(fng, "_fetch", net), mock.patch.object(fng, "_now", lambda: fake.NOW), \
                mock.patch.object(fng, "_log", lambda m: None):
            for _ in range(5):
                self.assertEqual(fng.fng_data(), {"ok": False, "error": "no_data"})
        self.assertEqual(len(net.calls), 1)

    def test_disk_copy_survives_a_restart(self):
        fng.set_cache_dir(self.tmp)
        self.addCleanup(fng.set_cache_dir, None)
        good, _ = build()
        self.assertTrue(os.path.exists(os.path.join(self.tmp, fng.SAVED)))
        fresh()
        fng.set_cache_dir(self.tmp)
        net = fake.network({"alternative.me": None})
        with mock.patch.object(fng, "_fetch", net), mock.patch.object(fng, "_now", lambda: fake.NOW), \
                mock.patch.object(fng, "_log", lambda m: None):
            r = fng.fng_data()
            for _ in range(200):
                if not fng._busy.is_set():
                    break
                time.sleep(0.01)
        self.assertTrue(r == good, "не та копия")  # сразу копия; источник молчит — она и остаётся

    def test_disk_copy_is_stale_and_refreshed_at_once(self):
        fng.set_cache_dir(self.tmp)
        self.addCleanup(fng.set_cache_dir, None)
        build()
        fresh()
        fng.set_cache_dir(self.tmp)
        net = fake.network()
        with mock.patch.object(fng, "_fetch", net), mock.patch.object(fng, "_now", lambda: fake.NOW):
            fng.fng_data()
            for _ in range(300):
                if not fng._busy.is_set():
                    break
                time.sleep(0.01)
        self.assertTrue(any("alternative.me" in c for c in net.calls))  # копия — как устаревшая: свежий в фоне

    def test_old_unfinished_copies_are_swept(self):
        fng.set_cache_dir(self.tmp)
        self.addCleanup(fng.set_cache_dir, None)
        old = os.path.join(self.tmp, fng.SAVED + ".123.456.tmp")
        new = os.path.join(self.tmp, fng.SAVED + ".789.1.tmp")
        other = os.path.join(self.tmp, "dom.json.1.tmp")
        for p in (old, new, other):
            with open(p, "w", encoding="utf-8") as f:
                f.write("{")
        os.utime(old, (time.time() - fng.TMP_AGE - 10,) * 2)
        os.utime(other, (time.time() - fng.TMP_AGE - 10,) * 2)
        with mock.patch.object(fng, "_fetch", fake.network({"alternative.me": None})), \
                mock.patch.object(fng, "_log", lambda m: None):
            fng.fng_data()
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.exists(new))  # может писаться прямо сейчас
        self.assertTrue(os.path.exists(other))  # чужой файл не трогаем

    def test_broken_disk_copy_is_ignored(self):
        fng.set_cache_dir(self.tmp)
        self.addCleanup(fng.set_cache_dir, None)
        good, _ = build()
        path = os.path.join(self.tmp, fng.SAVED)
        bad_days = [list(d) for d in good["days"]]
        bad_days[10][1] = 101
        for body in (b"{", b"[]", json.dumps({"ok": True, "days": bad_days, "at": 1}).encode(),
                     json.dumps({**good, "days": [*good["days"][:-1], [1, 2, 3, 4]]}).encode(),
                     json.dumps({**good, "ok": False}).encode()):
            with open(path, "wb") as f:
                f.write(body)
            fresh()
            fng.set_cache_dir(self.tmp)
            self.assertIsNone(fng._file_load(), body[:40])
        with open(path, "w", encoding="utf-8") as f:
            json.dump(good, f)
        self.assertTrue(fng._file_load() == good, "копия с диска не та")

    def test_valid_days_rules(self):
        good, _ = build()
        days = good["days"]
        with mock.patch.object(fng, "_now", lambda: fake.NOW):
            self.assertTrue(fng.valid_days(days) == days, "годные дни отвергнуты")
            self.assertIsNone(fng.valid_days(days[:999]))  # мало дней
            self.assertIsNone(fng.valid_days(days[:500] + days[501:]))  # дыра
            ok_hl = [list(x) for x in days]
            ok_hl[0][3] = fng.F_HL
            self.assertIsNotNone(fng.valid_days(ok_hl))
            for i, bad in ((1, -1), (1, 101), (1, 5.5), (2, 999.0), (2, 2e7), (3, 8), (3, -1), (0, fake.START - DAY)):
                d = [list(x) for x in days]
                d[0][i] = bad
                self.assertIsNone(fng.valid_days(d), (i, bad))
        with mock.patch.object(fng, "_now", lambda: fake.NOW - 30 * DAY):
            self.assertIsNone(fng.valid_days(days))  # из будущего


class DomBackupTest(unittest.TestCase):
    """wt_dom.btc_closes — запасная цена без сети: из памяти или с диска."""

    def test_closes_from_memory_and_from_disk(self):
        import wt_dom as dom  # noqa: PLC0415 — нужен только здесь
        saved = dom._st.px, dom._st.dir
        self.addCleanup(lambda: (setattr(dom._st, "px", saved[0]), setattr(dom._st, "dir", saved[1])))
        t = 1_700_000_000 // DAY * DAY
        dom._st.px = {"BTC": {t: (37_000.0, 1e9)}, "ETH": {t: (2_000.0, 1e9)}}
        with mock.patch.object(dom, "_fetch", side_effect=AssertionError("сеть не нужна")):
            self.assertEqual(dom.btc_closes(), {t: 37_000.0})
        tmp = tempfile.mkdtemp()
        self.addCleanup(lambda: [os.unlink(os.path.join(tmp, f)) for f in os.listdir(tmp)] and os.rmdir(tmp))
        dom._st.dir = tmp
        dom._px_save({"BTC": {t: (38_000.0, 1e9)}})
        dom._st.px = {}
        with mock.patch.object(dom, "_fetch", side_effect=AssertionError("сеть не нужна")):
            self.assertEqual(dom.btc_closes(), {t: 38_000.0})
        self.assertIn("BTC", dom._st.px)  # прочитанное с диска осталось в памяти
        dom._st.px = {}
        dom._st.dir = None
        self.assertEqual(dom.btc_closes(), {})


if __name__ == "__main__":
    unittest.main()

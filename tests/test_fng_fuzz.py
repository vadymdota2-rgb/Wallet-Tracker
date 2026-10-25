"""Сборка «Страха и жадности» на случайных и испорченных данных (npm test).

Как у халвинга и альтсезона: не «пример → ответ», а правила, которые обязаны
выполняться на любом входе. Генератор детерминированный (зерно SEED) —
найденное нарушение воспроизводится, номер случая есть в сообщении.

Источники отвечают то годным, то мусором: строками вместо чисел, NaN,
огромными и отрицательными ценами, днями не в полночь и из будущего,
дублями, перепутанным порядком, пустотой, обрезанной историей. Сборка не
падает никогда, а каждый годный ответ сервера принимает приложение
(validFng в lib/fng.ts) — сервер и приложение понимают ответ одинаково.
"""
import itertools
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
import fng_fake as fake  # noqa: E402

import wt_fng as fng  # noqa: E402 — модуль лежит в корне репозитория

SEED = 0xF_E4_12
CASES = 250
DAY = fake.DAY
JUNK = [None, "", "x", "1e999", "NaN", True, [], {}, {"a": 1}, -1, 0, 1e300, -1e300, "<script>", "-5", "101", "50.5"]
INDEX = fake.index_rows()
HIST = fake.history_points()


def junk(r: random.Random):
    return r.choice(JUNK)


def index_body(r: random.Random) -> bytes:
    if r.random() < 0.04:
        return json.dumps(junk(r)).encode()
    rows = [dict(x) for x in INDEX]
    # Иногда — обрезанный или дырявый ответ.
    if r.random() < 0.08:
        rows = rows[: r.randrange(0, len(rows))]
    if r.random() < 0.05:
        rows = [x for x in rows if r.random() > 0.2]
    for x in rows:
        if r.random() < 0.01:
            x["value"] = junk(r)
        if r.random() < 0.005:
            x["timestamp"] = r.choice([junk(r), str(int(x["timestamp"]) + 7), str(fake.NOW + 90 * DAY), "1000"])
    if r.random() < 0.05:
        rows += [dict(r.choice(INDEX), value=str(r.randrange(0, 101))) for _ in range(5)]  # дубли
    if r.random() < 0.1:
        r.shuffle(rows)
    if r.random() < 0.01:
        rows.append(junk(r))
    return json.dumps({"data": rows} if r.random() > 0.02 else {"data": junk(r)}).encode()


def hist_body(r: random.Random) -> bytes | None:
    if r.random() < 0.05:
        return None
    if r.random() < 0.04:
        return json.dumps(junk(r)).encode()
    pts = [dict(x) for x in HIST]
    if r.random() < 0.08:
        pts = pts[: r.randrange(0, len(pts))]
    for x in pts:
        if r.random() < 0.005:
            x["USD"] = junk(r)
        if r.random() < 0.002:
            x["time"] = junk(r)
    if r.random() < 0.1:
        r.shuffle(pts)
    return json.dumps({"prices": pts}).encode()


def live_body(r: random.Random) -> bytes | None:
    if r.random() < 0.1:
        return None
    v = {"time": fake.NOW - 60, "USD": fake.price(fake.NOW)}
    if r.random() < 0.2:
        v[r.choice(["time", "USD"])] = junk(r)
    return json.dumps(v).encode()


class FuzzTest(unittest.TestCase):
    def check(self, i: int, res: dict) -> None:
        m = f"случай {i}"
        if not res["ok"]:
            self.assertEqual(res, {"ok": False, "error": "no_data"}, m)
            return
        self.assertEqual(set(res), {"ok", "days", "at"}, m)
        days = res["days"]
        self.assertGreaterEqual(len(days), fng.MIN_DAYS, m)
        self.assertEqual(days[0][0] % DAY, 0, m)
        self.assertGreaterEqual(days[0][0], fng.START, m)
        self.assertLessEqual(days[-1][0], fake.NOW + fng.MAX_FUTURE, m)
        for a, b in itertools.pairwise(days):
            self.assertEqual(b[0] - a[0], DAY, m)
        for _t, v, p, f in days:
            self.assertTrue(isinstance(v, int) and 0 <= v <= 100, m)
            self.assertTrue(p == 0 or (math.isfinite(p) and fng.PX_MIN < p < fng.PX_MAX), m)
            self.assertTrue(isinstance(f, int) and 0 <= f <= fng.F_EST | fng.F_FILL, m)
        self.assertEqual(fng.valid_days(days), days, m)

    def test_build_never_raises_and_keeps_invariants(self):
        r = random.Random(SEED)  # noqa: S311 — нужна повторяемость, а не криптостойкость
        good, logs = [], []
        with mock.patch.object(fng, "_now", lambda: fake.NOW), mock.patch.object(fng, "_log", logs.append):
            for i in range(CASES):
                fng._st = fng._State()
                bodies = {"alternative.me": index_body(r), "historical-price": hist_body(r), "/v1/prices": live_body(r)}
                with mock.patch.object(fng, "_fetch", fake.network(bodies)):
                    res = fng.build()
                self.check(i, res)
                if res["ok"]:
                    good.append(res)
        self.assertEqual([m for m in logs if m.startswith("сборка")], [])
        self.assertGreater(len(good), CASES // 2)
        self.assertLess(len(good), CASES)
        self.__class__.good = good

    @unittest.skipUnless(shutil.which("node"), "нужен Node 22.18+")
    def test_every_ok_reply_is_accepted_by_the_app(self):
        if not getattr(self.__class__, "good", None):
            self.test_build_never_raises_and_keeps_invariants()
        good = [{**g, "now": fake.NOW} for g in self.__class__.good]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(good, f)
        try:
            script = (
                "import { readFileSync } from 'node:fs';"
                f"import {{ validFng }} from {json.dumps(os.path.join(ROOT, 'src/lib/fng.ts'))};"
                "const all = JSON.parse(readFileSync(process.argv[1], 'utf8'));"
                f"const bad = all.filter((r) => {{ const v = validFng(r, {fake.NOW}); return !v"
                " || v.days.length !== r.days.length || JSON.stringify(v.days) !== JSON.stringify(r.days); });"
                "console.log(JSON.stringify({ n: all.length, bad: bad.slice(0, 1).map((r) => r.days.slice(0, 3)) }));"
            )
            out = subprocess.run(["node", "--input-type=module", "-e", script, f.name],
                                 capture_output=True, text=True, timeout=120, check=True)
            got = json.loads(out.stdout)
            self.assertEqual(got["n"], len(good))
            self.assertEqual(got["bad"], [], "приложение отвергло ответ сервера")
        finally:
            os.unlink(f.name)


if __name__ == "__main__":
    unittest.main()

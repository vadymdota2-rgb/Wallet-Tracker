"""Договор «сервер ↔ график»: рейтинг скринера (wt_screen.rating) — тот же,
что у графика приложения (techRating в src/chart/indicators.ts).

Скринер считает рейтинг на сервере, график — на телефоне. Если они
разойдутся, человек отфильтрует монету «15 минут — покупать», откроет
график и увидит там «продавать». Поэтому на тысячах случайных рядов свечей
(тренды, боковики, ровные цены, гэпы, нулевой объём, короткие ряды) итог,
скользящие и осцилляторы обязаны совпасть до 1e-9 (npm test).
"""
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_screen as sc  # noqa: E402

SEED = 0x5C_4EE7


def series(r: random.Random) -> list[list[float]]:
    """Случайный ряд свечей: [время, o, h, l, c, v]."""
    n = r.choice([0, 30, 59, 60, 61, 100, 199, 200, 201, 250, 400, 600, 700])
    kind = r.choice(["walk", "trend_up", "trend_down", "flat", "spiky", "zero_vol", "tiny"])
    px = 10 ** r.uniform(-6, 5)
    out = []
    t = 1_700_000_000_000
    for _ in range(n):
        if kind == "flat":
            o = c = h = lo = px
        else:
            drift = {"trend_up": 0.004, "trend_down": -0.004}.get(kind, 0.0)
            step = r.gauss(drift, 0.03 if kind == "spiky" else 0.01)
            o = px
            c = max(px * (1 + step), 1e-12)
            h = max(o, c) * (1 + abs(r.gauss(0, 0.004)))
            lo = min(o, c) * (1 - abs(r.gauss(0, 0.004)))
            if kind == "tiny":
                o, c, h, lo = round(o, 8), round(c, 8), round(h, 8), round(lo, 8)
                h, lo = max(h, o, c), min(lo, o, c)
                if lo <= 0:
                    lo = min(o, c)
            px = c
        v = 0.0 if kind == "zero_vol" or r.random() < 0.02 else r.uniform(0, 1e6)
        out.append([t, o, h, lo, c, v])
        t += 900_000
    return out


@unittest.skipUnless(shutil.which("node"), "нужен Node 22.18+")
class RatingContractTest(unittest.TestCase):
    def test_server_and_chart_rate_alike(self):
        r = random.Random(SEED)  # noqa: S311 — повторяемость, а не криптостойкость
        cases = [series(r) for _ in range(400)]
        want = []
        for bars in cases:
            got = sc.rating([tuple(b) for b in bars])  # type: ignore[misc]
            want.append(None if got is None else list(got))
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(cases, f)
        try:
            script = (
                "import { readFileSync } from 'node:fs';"
                f"import {{ techRating }} from {json.dumps(os.path.join(ROOT, 'src/chart/indicators.ts'))};"
                "const all = JSON.parse(readFileSync(process.argv[1], 'utf8'));"
                "const out = all.map((rows) => { const r = techRating(rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })));"
                " return r ? [r.total, r.ma, r.osc] : null; });"
                "console.log(JSON.stringify(out));"
            )
            res = subprocess.run(["node", "--import", os.path.join(ROOT, "tests", "ts-resolve.mjs"), "--input-type=module", "-e", script, f.name],
                                 capture_output=True, text=True, timeout=300, check=True)
        finally:
            os.unlink(f.name)
        got_ts = json.loads(res.stdout)
        self.assertEqual(len(got_ts), len(want))
        rated = 0
        for i, (a, b) in enumerate(zip(want, got_ts, strict=True)):
            if a is None or b is None:
                self.assertEqual(a, b, f"случай {i}: {len(cases[i])} свечей")
                continue
            rated += 1
            for x, y in zip(a, b, strict=True):
                self.assertAlmostEqual(x, y, delta=1e-9, msg=f"случай {i}: сервер {a}, график {b}")
        self.assertGreater(rated, 250)  # большинство рядов — с рейтингом, иначе проверять нечего


if __name__ == "__main__":
    unittest.main()

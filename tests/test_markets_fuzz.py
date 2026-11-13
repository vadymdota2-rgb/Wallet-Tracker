"""Рынки в меню на случайных и испорченных данных (npm test).

Как у халвинга, ETF и доминации: не «пример → ответ», а правила, которые
обязаны выполняться на любом входе. Генератор детерминированный (зерно
SEED) — найденное нарушение воспроизводится, номер случая есть в сообщении.

Источники отвечают то годным, то мусором: строками вместо чисел, NaN,
огромными (10**400) и отрицательными ценами, перевёрнутыми курсами, HTML в
именах рынков, перепутанными типами, пустотой; время — будни, выходные,
переходы на летнее время. Сборка не падает никогда, в ответе — только наши
пункты в порядке экрана и правдоподобные числа, а каждый годный ответ сервера
приложение (validMarkets в lib/markets.ts) принимает целиком — сервер и
приложение понимают ответ одинаково.
"""
import calendar
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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_markets as mk  # noqa: E402 — модуль лежит в корне репозитория

SEED = 0x3A_4E75
CASES = 600
JUNK = [None, "", "x", "1e999", "NaN", "-1", True, [], {}, {"a": 1}, -1, 0, 1e300, -1e300, 10**400, "<script>", float("nan")]
# Моменты: будни и выходные зимой и летом, переход на летнее и обратно.
TIMES = ["2026-11-06 15:00", "2026-11-08 01:06", "2026-11-08 22:30", "2026-11-09 23:30", "2026-07-10 20:59",
         "2026-07-10 21:00", "2026-03-08 06:59", "2026-03-09 12:00", "2026-11-01 05:30", "2026-11-02 14:00",
         "2027-01-01 00:00", "2026-12-25 12:00"]
GOOD_HL = {"xyz": {"SP500": 7373.1, "XYZ100": 26925.0, "GOLD": 4066.2, "CL": 90.2, "EUR": 1.1157, "JPY": 158.36,
                   "GBP": 1.3349, "SILVER": 52.0, "DXY": 97.15},
           "para": {"10Y": 4.875, "BTCD": 60.4}, "mkts": {"BVIV": 42.4}}
ECB_DAY = {"EUR": 0.8957, "JPY": 158.33, "GBP": 0.7471, "CAD": 1.4066, "SEK": 9.8755, "CHF": 0.8189}


def utc(s: str) -> int:
    return calendar.timegm((*(int(x) for x in s.replace("-", " ").replace(":", " ").split()), 0))


def junk(r: random.Random) -> object:
    return r.choice(JUNK)


def num(r: random.Random, v: float) -> object:
    """Годное число (строкой, как у Hyperliquid) — или мусор, или скачок."""
    x = r.random()
    if x < 0.06:
        return junk(r)
    if x < 0.1:
        return str(v * r.choice([0.3, 3, 100, 1e-6, -1]))
    return str(round(v * (1 + r.uniform(-0.02, 0.02)), 6))


def hl(r: random.Random, dex: str) -> object:
    if r.random() < 0.05:
        return junk(r)
    names = list(GOOD_HL[dex])
    if r.random() < 0.15:
        names = r.sample(names, r.randrange(0, len(names) + 1))
    if r.random() < 0.1:
        names.append(r.choice(["<b>", "A" * 300, "SP500\n", "ПРИВЕТ", ""]))
    uni, ctx = [], []
    for n in names:
        uni.append({"name": f"{dex}:{n}", **({"isDelisted": r.choice([True, 1, "x"])} if r.random() < 0.08 else {})}
                   if r.random() > 0.03 else junk(r))
        base = GOOD_HL[dex].get(n, 1.0)
        ctx.append({"markPx": num(r, base), "prevDayPx": num(r, base)} if r.random() > 0.03 else junk(r))
    if r.random() < 0.05:
        ctx = ctx[: len(ctx) // 2]  # длины не совпадают
    return [{"universe": uni if r.random() > 0.03 else junk(r)}, ctx if r.random() > 0.03 else junk(r)]


def candles(r: random.Random, t: int, base: float) -> object:
    if r.random() < 0.05:
        return junk(r)
    start = (t - 5 * 86400) // 3600 * 3600
    out: list = []
    for h in range(start, t, 3600):
        if r.random() < 0.03:
            out.append(junk(r))
            continue
        if r.random() < 0.05:
            continue  # пропущенный час
        out.append({"t": h * 1000 if r.random() > 0.02 else junk(r), "c": num(r, base)})
    if r.random() < 0.1:
        r.shuffle(out)
    return out


def ecb(r: random.Random, t: int) -> object:
    if r.random() < 0.05:
        return junk(r)
    rates: dict = {}
    for d in range(10, -1, -1):
        day = t - d * 86400
        if r.random() < 0.15:
            continue
        key = mk.time.strftime("%Y-%m-%d", mk.time.gmtime(day)) if r.random() > 0.03 else r.choice(["2026-13-01", "x", "<b>"])
        rates[key] = {c: num(r, v) for c, v in ECB_DAY.items() if r.random() > 0.03} if r.random() > 0.03 else junk(r)
    return {"rates": rates if r.random() > 0.03 else junk(r)}


def mcap(r: random.Random) -> object:
    if r.random() < 0.08:
        return junk(r)
    return {"ok": True if r.random() > 0.05 else junk(r), "btc": [num(r, 60.4), num(r, 60.3)] if r.random() > 0.05 else junk(r),
            "usdt": num(r, 4.1), "cap": [num(r, 3.4e12), num(r, 3.3e12)] if r.random() > 0.05 else junk(r)}


def aster(r: random.Random, t: int) -> object:
    if r.random() < 0.05:
        return junk(r)
    rows = [{"symbol": sym, "lastPrice": num(r, v), "openPrice": num(r, v)} if r.random() > 0.03 else junk(r)
            for sym, v in (("XAUUSDT", 4072.0), ("CLUSDT", 90.6), ("SPXUSDT", 0.35), ("BTCUSDT", 1e5))]
    return {"at": t - r.choice([0, 300, 1700, 1900, -120, 86400]) if r.random() > 0.03 else junk(r),
            "rows": rows if r.random() > 0.03 else junk(r)}


def parts(r: random.Random, t: int) -> dict:
    out = {"xyz": hl(r, "xyz"), "para": hl(r, "para"), "mkts": hl(r, "mkts"), "ecb": ecb(r, t), "mcap": mcap(r),
           "aster": aster(r, t),
           "fx": {c: candles(r, t, v) for c, v in (("EUR", 1.1157), ("JPY", 158.36), ("GBP", 1.3349))}
           if r.random() > 0.05 else junk(r)}
    for k in list(out):
        if r.random() < 0.05:
            del out[k]  # источник промолчал
    if r.random() < 0.04:
        out = {k: junk(r) for k in out}  # молчат все — сеть пропала
    return out


class MarketsFuzzTest(unittest.TestCase):
    good: list = []  # noqa: RUF012 — общий для двух тестов класса

    def check(self, i: int, t: int, res: dict) -> None:
        m = f"случай {i}"
        json.dumps(res, allow_nan=False)
        if not res.get("ok"):
            self.assertEqual(res, {"ok": False, "error": "no_data"}, m)
            return
        self.assertEqual(set(res), {"ok", "at", "items"}, m)
        self.assertEqual(res["at"], t, m)
        keys = [it["k"] for it in res["items"]]
        self.assertTrue(keys, m)
        self.assertEqual(keys, [k for k in mk.KEYS if k in keys], m)  # только наши, по порядку, без повторов
        for it in res["items"]:
            self.assertEqual(set(it), {"k", "px", "prev"}, m)
            for v in (it["px"], it["prev"]):
                self.assertTrue(isinstance(v, float) and math.isfinite(v) and 0 < v < mk.PX_MAX, (m, it))
            self.assertTrue(mk.sane(it["k"], (it["px"], it["prev"])), (m, it))

    def test_compute_never_raises_and_keeps_invariants(self):
        r = random.Random(SEED)  # noqa: S311 — нужна повторяемость, а не криптостойкость
        good = []
        for i in range(CASES):
            t = utc(r.choice(TIMES)) + r.randrange(-1800, 1800)
            res = mk.compute(parts(r, t), t)
            self.check(i, t, res)
            if res["ok"]:
                good.append((t, res))
        # Генератор даёт и годные ответы с DXY, и отказы — иначе он ничего не проверяет.
        self.assertGreater(sum("DXY" in [it["k"] for it in g["items"]] for _, g in good), CASES // 4)
        self.assertGreater(len(good), CASES // 2)
        self.assertLess(len(good), CASES)
        self.__class__.good = good

    @unittest.skipUnless(shutil.which("node"), "нужен Node 22.18+")
    def test_every_ok_reply_is_accepted_by_the_app(self):
        if not self.__class__.good:
            self.test_compute_never_raises_and_keeps_invariants()
        good = self.__class__.good
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(good, f)
        try:
            script = (
                "import { readFileSync } from 'node:fs';"
                f"import {{ validMarkets }} from {json.dumps(os.path.join(ROOT, 'src/lib/markets.ts'))};"
                "const all = JSON.parse(readFileSync(process.argv[1], 'utf8'));"
                "const bad = all.filter(([t, r]) => { const v = validMarkets(r, t);"
                " return !v || JSON.stringify(v.items) !== JSON.stringify(r.items) || v.at !== r.at; });"
                "console.log(JSON.stringify({ n: all.length, bad: bad.slice(0, 1) }));"
            )
            out = subprocess.run(["node", "--input-type=module", "-e", script, f.name],
                                 capture_output=True, text=True, timeout=120, check=True)
            got = json.loads(out.stdout)
            self.assertEqual(got["n"], len(good))
            self.assertEqual(got["bad"], [], "приложение отвергло ответ сервера")
        finally:
            os.unlink(f.name)


class HistoryFuzzTest(unittest.TestCase):
    """История мини-графика на мусоре: копия с диска — чужая и испорченная,
    сборки — в любом порядке времени. История всегда: только наши пункты,
    точки по возрастанию времени, в пределах суток, не больше HIST_MAX,
    правдоподобные цены; ответ — честный JSON, и приложение (validHist)
    принимает его целиком."""

    def setUp(self):
        self.addCleanup(setattr, mk, "_st", mk._st)
        mk._st = mk._State()

    def check(self, m: str, t: int) -> None:
        for k, pts in mk._st.hist.items():
            self.assertIn(k, mk.KEYS, m)
            self.assertLessEqual(len(pts), mk.HIST_MAX, m)
            lo, hi = mk.RANGE.get(k, (0.0, mk.PX_MAX))
            for (a, _), (b, _) in itertools.pairwise(pts):
                self.assertLess(a, b, (m, k))
            for ts, px in pts:
                self.assertIsInstance(ts, int, m)
                self.assertLessEqual(ts, t + mk.HIST_AHEAD, (m, k, ts))
                self.assertTrue(math.isfinite(px) and 0 < px < mk.PX_MAX and lo <= px <= hi, (m, k, px))
        json.dumps(mk.history(), allow_nan=False)

    def junk_series(self, r: random.Random, t: int) -> object:
        if r.random() < 0.05:
            return r.choice(JUNK)
        out: dict = {}
        for k in [*mk.KEYS, "VIX", "<b>", ""]:
            if r.random() < 0.3:
                continue
            if r.random() < 0.05:
                out[k] = r.choice(JUNK)
                continue
            n = r.randrange(0, 400)
            base = r.choice([4000.0, 4.8, 42.0, 60.0, 102.0])
            out[k] = [r.choice(JUNK) if r.random() < 0.05 else
                      [r.choice([t - r.randrange(-500, 2 * mk.HIST_SEC), r.choice(JUNK), float(t), True]),
                       r.choice([base * (0.5 + r.random()), r.choice(JUNK), str(base)])]
                      for _ in range(n)]
        return {"series": out} if r.random() < 0.95 else out

    def test_restore_from_any_file_keeps_invariants(self):
        r = random.Random(SEED + 1)  # noqa: S311 — повторяемость, а не криптостойкость
        took = 0
        for i in range(400):
            mk._st = mk._State()
            t = utc(r.choice(TIMES))
            n = mk.history_restore(self.junk_series(r, t), t)
            took += n
            self.assertEqual(n, sum(len(v) for v in mk._st.hist.values()), i)
            self.check(f"случай {i}", t)
        self.assertGreater(took, 1000)  # генератор даёт и годные точки — иначе он ничего не проверяет

    def test_builds_in_any_time_order_keep_invariants(self):
        r = random.Random(SEED + 2)  # noqa: S311
        t = top = utc("2026-11-06 15:00")
        for i in range(3000):
            t += r.choice([600, 600, 600, 0, -600, 60, 3 * 3600])
            top = max(top, t)  # время назад — старый ответ: история его не берёт
            items = [{"k": k, "px": round(4000.0 * (0.9 + r.random() / 5), 2), "prev": 4000.0}
                     for k in ("GOLD", "SP500") if r.random() < 0.9]
            with mk._lock:
                mk._record({"ok": True, "at": t, "items": items})
            self.check(f"сборка {i}", top)
        last = max(p[-1][0] for p in mk._st.hist.values())
        for pts in mk._st.hist.values():
            self.assertGreaterEqual(pts[0][0], last - mk.HIST_SEC - 3 * 3600)

    @unittest.skipUnless(shutil.which("node"), "нужен Node 22.18+")
    def test_every_history_is_accepted_by_the_app(self):
        r = random.Random(SEED + 3)  # noqa: S311
        got = []
        for _ in range(60):
            mk._st = mk._State()
            t = utc(r.choice(TIMES))
            mk.history_restore(self.junk_series(r, t), t)
            h = mk.history()
            if h["ok"]:
                got.append((t, h))
        self.assertGreater(len(got), 30)
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(got, f)
        try:
            script = (
                "import { readFileSync } from 'node:fs';"
                f"import {{ validHist }} from {json.dumps(os.path.join(ROOT, 'src/lib/markets.ts'))};"
                "const all = JSON.parse(readFileSync(process.argv[1], 'utf8'));"
                "const bad = all.filter(([t, h]) => { const v = validHist(h, t);"
                " const want = Object.fromEntries(Object.entries(h.series).filter(([, p]) => p.length >= 2));"
                " return JSON.stringify(v) !== JSON.stringify(want); });"
                "console.log(JSON.stringify({ n: all.length, bad: bad.slice(0, 1) }));"
            )
            out = subprocess.run(["node", "--input-type=module", "-e", script, f.name],
                                 capture_output=True, text=True, timeout=120, check=True)
            res = json.loads(out.stdout)
            self.assertEqual(res["n"], len(got))
            self.assertEqual(res["bad"], [], "приложение отвергло историю сервера")
        finally:
            os.unlink(f.name)


if __name__ == "__main__":
    unittest.main()

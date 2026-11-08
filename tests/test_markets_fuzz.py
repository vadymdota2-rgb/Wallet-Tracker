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


if __name__ == "__main__":
    unittest.main()

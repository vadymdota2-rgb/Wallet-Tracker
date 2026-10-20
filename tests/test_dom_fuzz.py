"""Сборка «Альтсезона» на случайных и испорченных данных (npm test).

Как у халвинга и ETF: не «пример → ответ», а правила, которые обязаны
выполняться на любом входе. Генератор детерминированный (зерно SEED) —
найденное нарушение воспроизводится, номер случая есть в сообщении.

Hyperliquid отвечает то годным, то мусором: строками вместо чисел, NaN,
огромными и отрицательными ценами и оборотами, HTML в именах монет, перепутанными
типами, пустотой, ценами из будущего и до 2020 года. Сборка не падает
никогда, а каждый годный ответ сервера принимает приложение (validDom в
lib/dom.ts) — сервер и приложение понимают ответ одинаково.
"""
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
import wt_dom as dom  # noqa: E402 — модуль лежит в корне репозитория

SEED = 0xD0_5EED
CASES = 400
DAY = 86_400
NOW = 1_792_000_000
END = NOW // DAY * DAY
COINS = ["BTC", "ETH", "SOL", "DOGE", "PAXG", "USDE", "kPEPE", "HYPE", "XRP", "LINK", "AVAX", "SUI", "ADA", "TON",
         "NEAR", "UNI", "AAVE", "ARB", "OP", "TAO", "ENA", "WLD", "LTC", "BNB", *(f"C{i}" for i in range(40))]
# Огромное целое (10**30) разбор отвергает целиком — оно идёт отдельным ответом (HUGE), а не в каждый.
JUNK = [None, "", "x", "1e999", "NaN", True, [], {}, {"a": 1}, -1, 0, 1e300, -1e300, "<script>", "-5"]
HUGE = b'[{"t": 1' + b"0" * 30 + b', "c": "1"}]'


def junk(r: random.Random):
    return r.choice(JUNK)


def meta(r: random.Random) -> object:
    if r.random() < 0.05:
        return junk(r)
    # Чаще — рынок, на котором индекс считается; иногда — горстка монет.
    names = r.sample(COINS, r.randrange(1, len(COINS)) if r.random() < 0.2 else len(COINS))
    if "BTC" not in names and r.random() < 0.9:
        names.append("BTC")
    if r.random() < 0.1:
        names.append(r.choice(["<b>", "A" * 40, "BTC\n", "ПРИВЕТ"]))
    uni = [{"name": n, **({"isDelisted": r.choice([True, 1, "x"])} if r.random() < 0.1 else {})}
           if r.random() > 0.03 else junk(r) for n in names]
    return {"universe": uni} if r.random() > 0.03 else {"universe": junk(r)}


def candles(r: random.Random, coin: str) -> object:
    if r.random() < 0.04:
        return junk(r)
    n = r.randrange(0, 260) if r.random() < 0.2 else r.randrange(150, 260)
    # Монета снята с торгов: свечи кончаются раньше.
    stop = r.randrange(0, 60) if r.random() < 0.1 else 0
    start = END - n * DAY + r.choice([0, 0, 0, DAY, -DAY])
    px = r.uniform(0.001, 100_000) if coin != "BTC" else r.uniform(5_000, 150_000)
    # Начало без торгов: цены есть, оборота нет.
    quiet = r.randrange(0, 40) if r.random() < 0.2 else 0
    out = []
    for i in range(n - stop):
        px *= math.exp(r.gauss(0, 0.05))
        c: object = str(px)
        if r.random() < 0.02:
            c = junk(r)
        v: object = "0" if i < quiet else str(r.lognormvariate(10, 2) / px)
        if r.random() < 0.02:
            v = junk(r)
        t: object = (start + i * DAY) * 1000
        if r.random() < 0.01:
            t = r.choice([5, junk(r), (start + i * DAY) * 1000 + 7, (NOW + 90 * DAY) * 1000, 1_000_000_000])
        k = {"t": t, "c": c, "v": v}
        if r.random() < 0.01:
            del k["v"]
        out.append(k if r.random() > 0.01 else junk(r))
    if r.random() < 0.05:
        r.shuffle(out)
    return out


def network(r: random.Random):
    m = meta(r)
    cache: dict = {}

    def fetch(url, body, timeout):
        if r.random() < 0.01:
            return None
        if r.random() < 0.005:
            return HUGE
        if body.get("type") == "meta":
            return json.dumps(m).encode() if r.random() > 0.02 else b"{"
        coin = body["req"]["coin"]
        if coin not in cache:
            cache[coin] = candles(r, coin)
        return json.dumps(cache[coin]).encode()

    return fetch


class FuzzTest(unittest.TestCase):
    def check(self, i: int, res: dict) -> None:
        m = f"случай {i}"
        if not res["ok"]:
            self.assertEqual(res, {"ok": False, "error": "no_data"}, m)
            return
        self.assertEqual(set(res), {"ok", "rows", "coins", "btc90", "tiers", "n", "by", "at"}, m)
        prev = 0
        for row in res["rows"]:
            ts, idx, s, eb, px, n = row
            self.assertTrue(dom.PX_FROM <= ts < END, m)
            # Индекс и число монет в корзине — вместе: оба есть или обоих нет.
            self.assertEqual(idx is None, n is None, m)
            self.assertTrue(n is None or dom.MIN_BASKET <= n <= dom.TOP, m)
            self.assertGreater(ts, prev, m)
            prev = ts
            self.assertEqual(ts % DAY, 0, m)
            self.assertTrue(idx is None or (isinstance(idx, int) and 0 <= idx <= 100), m)
            self.assertTrue(s is None or (math.isfinite(s) and 1e-6 <= s <= 1e6), m)
            self.assertTrue(eb is None or 1e-6 <= eb <= 10, m)
            self.assertTrue(dom.BTC_MIN <= px < dom.PX_MAX, m)
        names = [c[0] for c in res["coins"]]
        self.assertEqual(len(names), len(set(names)), m)
        for name, g in res["coins"]:
            self.assertRegex(name, r"^[A-Za-z0-9]{1,20}$", m)
            self.assertNotIn(name, ("BTC", "PAXG"), m)
            self.assertTrue(-100 <= g <= dom.GROW_MAX, m)
        self.assertEqual([c[1] for c in res["coins"]], sorted((c[1] for c in res["coins"]), reverse=True), m)
        self.assertLessEqual(len(names), dom.TOP, m)
        self.assertEqual(res["n"], dom.TOP, m)
        self.assertEqual([t[0] for t in res["tiers"]], list(dom.TIERS), m)
        for size, idx, k in res["tiers"]:
            self.assertTrue(idx is None or (isinstance(idx, int) and 0 <= idx <= 100), m)
            self.assertTrue(0 <= k <= size, m)
            self.assertTrue(idx is None or k >= min(dom.MIN_BASKET, size), m)

    def test_build_never_raises_and_keeps_invariants(self):
        r = random.Random(SEED)  # noqa: S311 — нужна повторяемость, а не криптостойкость
        good, logs = [], []
        with mock.patch.object(dom, "_now", lambda: NOW), mock.patch.object(dom, "_log", logs.append):
            for i in range(CASES):
                dom._st = dom._State()
                with mock.patch.object(dom, "_fetch", network(r)):
                    res = dom.build(sleep=lambda s: None)
                self.check(i, res)
                if res["ok"]:
                    good.append(res)
        self.assertEqual([m for m in logs if m.startswith("сборка")], [])
        # Генератор даёт и годные ответы, и отказы — иначе он ничего не проверяет.
        self.assertGreater(len(good), CASES // 4)
        self.assertLess(len(good), CASES)
        self.__class__.good = good

    @unittest.skipUnless(shutil.which("node"), "нужен Node 22.18+")
    def test_every_ok_reply_is_accepted_by_the_app(self):
        if not getattr(self.__class__, "good", None):
            self.test_build_never_raises_and_keeps_invariants()
        good = self.__class__.good
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(good, f)
        try:
            script = (
                "import { readFileSync } from 'node:fs';"
                f"import {{ validDom }} from {json.dumps(os.path.join(ROOT, 'src/lib/dom.ts'))};"
                "const all = JSON.parse(readFileSync(process.argv[1], 'utf8'));"
                f"const bad = all.filter((r) => {{ const v = validDom(r, {NOW}); return !v"
                " || v.rows.length !== r.rows.length || v.coins.length !== r.coins.length; });"
                "console.log(JSON.stringify({ n: all.length, bad: bad.slice(0, 1).map((r) => r.rows.slice(0, 3)) }));"
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

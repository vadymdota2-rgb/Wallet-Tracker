"""Доминация (wt_mcap) на случайных и испорченных ответах CoinMarketCap (npm test).

Как у халвинга, ETF и альтсезона: не «пример → ответ», а правила, которые
обязаны выполняться на любом входе. Генератор детерминированный (зерно SEED)
— найденное нарушение воспроизводится, номер случая есть в сообщении.

CoinMarketCap отвечает то годным, то мусором: строками вместо чисел, NaN,
огромными и отрицательными долями, долями больше 100 %, датами из будущего
и до 2013 г., перепутанными типами, пустотой. Сборка не падает никогда,
кредитов тратит не больше дневного бюджета, а каждый годный ответ сервера
принимает приложение (validMcap в lib/dom.ts) — вместе с историей целиком.
"""
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_mcap as mc  # noqa: E402 — модуль лежит в корне репозитория

SEED = 0xC0_1A7
CASES = 300
DAY = 86_400
NOW = 1_792_454_400 + 3600
JUNK = [None, "", "x", "1e999", "NaN", True, [], {}, {"a": 1}, -1, 0, 1e300, -1e300, "<script>", "57"]


def junk(r: random.Random):
    return r.choice(JUNK)


def maybe(r: random.Random, good, p: float = 0.04):
    return junk(r) if r.random() < p else good


def glob(r: random.Random) -> object:
    if r.random() < 0.04:
        return junk(r)
    btc = r.uniform(30, 75) if r.random() > 0.05 else r.choice([0, 101, 99.9, 0.6])
    eth = r.uniform(5, 20) if r.random() > 0.05 else r.choice([0, 60, 100])
    cap = r.uniform(5e11, 5e12) if r.random() > 0.05 else r.choice([1, 1e20, 1e10])
    usd = {"total_market_cap": maybe(r, cap), "total_market_cap_yesterday": maybe(r, cap * r.uniform(0.9, 1.1), 0.1),
           "stablecoin_market_cap": maybe(r, cap * r.uniform(0, 0.4), 0.1)}
    data = {"btc_dominance": maybe(r, btc), "eth_dominance": maybe(r, eth),
            "btc_dominance_yesterday": maybe(r, btc + r.uniform(-1, 1), 0.1),
            "eth_dominance_yesterday": maybe(r, eth + r.uniform(-1, 1), 0.1), "quote": maybe(r, {"USD": usd})}
    return {"status": {"credit_count": maybe(r, 1)}, "data": maybe(r, data)}


def usdt(r: random.Random) -> object:
    if r.random() < 0.05:
        return junk(r)
    q = {"symbol": maybe(r, "USD"), "market_cap": maybe(r, r.uniform(1e10, 3e11))}
    c = {"id": maybe(r, 825), "symbol": maybe(r, "USDT"), "quote": maybe(r, [q])}
    return {"status": {"credit_count": 1}, "data": maybe(r, [c])}


def hist(r: random.Random) -> object:
    if r.random() < 0.05:
        return junk(r)
    n = r.randrange(0, 1500) if r.random() < 0.2 else r.randrange(500, 1500)
    end = NOW // DAY * DAY
    quotes = []
    for i in range(n):
        t = end - (n - 1 - i) * DAY
        stamp: object = time.strftime("%Y-%m-%dT00:00:00.000Z", time.gmtime(t))
        if r.random() < 0.01:
            stamp = r.choice(["вчера", "2099-01-01T00:00:00.000Z", "2010-01-01T00:00:00.000Z", junk(r)])
        btc = r.uniform(35, 95)
        q = {"timestamp": stamp, "quote": maybe(r, {"USD": {"total_market_cap": maybe(r, r.uniform(1e9, 4e12), 0.02)}}, 0.01),
             "btc_dominance": maybe(r, btc, 0.02), "eth_dominance": maybe(r, r.choice([0, r.uniform(1, 25)]), 0.02)}
        quotes.append(q if r.random() > 0.01 else junk(r))
    if r.random() < 0.05:
        r.shuffle(quotes)
    return {"status": {"credit_count": maybe(r, max(1, n // 100))}, "data": maybe(r, {"quotes": quotes})}


def network(r: random.Random):
    g, u, h = glob(r), usdt(r), hist(r)

    def fetch(url, timeout=20, limit=0):
        if r.random() < 0.02:
            return None
        if r.random() < 0.01:
            return b"[" * 50 + b"1e999"
        body = h if "historical" in url else g if "global-metrics" in url else u
        return json.dumps(body).encode()

    return fetch


class FuzzTest(unittest.TestCase):
    def check(self, i: int, res: dict) -> None:
        m = f"случай {i}"
        if not res["ok"]:
            self.assertEqual(res, {"ok": False, "error": "no_data"}, m)
            return
        self.assertEqual(set(res), {"ok", "btc", "eth", "alt", "alt_ns", "cap", "usdt", "hist", "by", "at"}, m)
        for k, lo in (("btc", 0.5), ("eth", 0), ("alt", 0)):
            now, y = res[k]
            self.assertTrue(lo <= now <= 100, m)
            self.assertTrue(y is None or lo <= y <= 100, m)
        self.assertLessEqual(res["btc"][0] + res["eth"][0], 100, m)
        self.assertAlmostEqual(res["btc"][0] + res["alt"][0], 100, delta=0.02, msg=m)
        self.assertTrue(mc.CAP_MIN <= res["cap"][0] <= mc.CAP_MAX, m)
        self.assertTrue(res["alt_ns"] is None or 0 <= res["alt_ns"] <= res["alt"][0], m)
        self.assertTrue(res["usdt"] is None or 0 <= res["usdt"] <= 100 - res["btc"][0], m)
        prev = 0
        for t, cap, btc, eth in res["hist"]:
            self.assertTrue(t > prev and t % DAY == 0 and mc.HIST_FROM <= t <= NOW, m)
            prev = t
            self.assertTrue(1e8 <= cap <= mc.CAP_MAX and 0.5 <= btc <= 100, m)
            self.assertTrue(eth is None or 0 < eth <= 100 - btc, m)

    def test_build_never_raises_keeps_invariants_and_budget(self):
        r = random.Random(SEED)  # noqa: S311 — нужна повторяемость, а не криптостойкость
        good, logs = [], []
        with mock.patch.dict(os.environ, {"CMC_API_KEY": "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d"}), \
                mock.patch.object(mc.time, "time", lambda: NOW), mock.patch.object(mc, "_log", logs.append):
            for i in range(CASES):
                mc._st = mc._State()
                mc.set_cache_dir(tempfile.mkdtemp())
                with mock.patch.object(mc, "_fetch", network(r)):
                    res = mc.build()
                self.check(i, res)
                with mc._lock:
                    self.assertLessEqual(mc._spent()[mc._today()], mc.DAY_BUDGET + 1000, f"случай {i}")
                if res["ok"]:
                    good.append(res)
        self.assertEqual([m for m in logs if m.startswith("сборка")], [])
        self.assertGreater(len(good), CASES // 3)
        self.assertLess(len(good), CASES)
        self.assertTrue(any(len(g["hist"]) > 100 for g in good))
        self.__class__.good = good

    @unittest.skipUnless(shutil.which("node"), "нужен Node 22.18+")
    def test_every_ok_reply_is_accepted_by_the_app_with_its_history(self):
        if not getattr(self.__class__, "good", None):
            self.test_build_never_raises_keeps_invariants_and_budget()
        good = self.__class__.good
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(good, f)
        try:
            script = (
                "import { readFileSync } from 'node:fs';"
                f"import {{ validMcap }} from {json.dumps(os.path.join(ROOT, 'src/lib/dom.ts'))};"
                "const all = JSON.parse(readFileSync(process.argv[1], 'utf8'));"
                f"const bad = all.filter((r) => {{ const v = validMcap(r, {NOW}); return !v"
                " || v.hist.length !== (r.hist.length >= 2 ? r.hist.length : 0)"
                " || v.usdt !== r.usdt || v.altNs !== r.alt_ns; });"
                "console.log(JSON.stringify({ n: all.length, bad: bad.slice(0, 1).map((r) => [r.btc, r.eth, r.alt, r.cap, r.usdt, r.alt_ns, r.hist.slice(0, 2)]) }));"
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

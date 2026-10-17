"""Сборка «Институциональных потоков» на случайных и испорченных данных (npm test).

Как у халвинга: не «пример → ответ», а правила, которые обязаны выполняться
на любом входе. Генератор детерминированный (зерно SEED) — найденное
нарушение воспроизводится, номер случая есть в сообщении.

Каждый источник (набор TFTC, отчёт CFTC, отчёты SEC) отвечает то годным,
то мусором: строками вместо чисел, NaN, огромными числами, HTML в тикерах и
датах, перепутанными типами, пустотой. Сборка не падает никогда, а каждый
годный ответ сервера принимает приложение (validEtf в lib/etf.ts) — сервер и
приложение понимают ответ одинаково.
"""
import json
import math
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
import wt_etf as etf  # noqa: E402 — модуль лежит в корне репозитория

SEED = 0x5EED_E7F
CASES = 600
NOW = 1_792_000_000
DAY = 86_400
TICKERS = ["IBIT", "FBTC", "GBTC", "BTC", "BITB", "ARKB", "HODL", "MSBT"]
JUNK = [None, "", "x", "1e999", "NaN", True, [], {}, {"a": 1}, -1, 0, 1e300, -1e300, "<script>", "２０２６-01-01",
        "2026-10-10<b>", "2026-13-45", 10**30]


def junk(r: random.Random):
    return r.choice(JUNK)


def tftc(r: random.Random) -> object:
    if r.random() < 0.05:
        return junk(r)
    days = []
    start = etf.ETF_LAUNCH + r.randrange(0, 600) * DAY
    for i in range(r.randrange(0, 60)):
        ts = start + i * DAY
        date = time.strftime("%Y-%m-%d", time.gmtime(ts)) if r.random() > 0.05 else junk(r)
        per: object = {t: r.choice([r.uniform(-5e8, 5e8), 0, None]) for t in r.sample(TICKERS, r.randrange(0, 6))}
        if r.random() < 0.05:
            per = junk(r)
        elif r.random() < 0.05 and isinstance(per, dict):
            per[r.choice(["<b>", "ibit", "TOO_LONG_TICKER_X", "IBIT\n"])] = 5e6
        row = {"date": date, "netFlowUsd": r.choice([r.uniform(-1e9, 1e9), None, 0]) if r.random() > 0.05 else junk(r),
               "btcCloseUsd": r.uniform(20_000, 150_000) if r.random() > 0.05 else junk(r), "perEtfUsd": per}
        days.append(row if r.random() > 0.03 else junk(r))
    if r.random() < 0.1:
        r.shuffle(days)
    return {"days": days if r.random() > 0.03 else junk(r),
            "updatedThrough": r.choice(["2026-10-15", junk(r)])}


def sec(r: random.Random) -> dict:
    out = {}
    for t in r.sample(TICKERS, r.randrange(0, len(TICKERS))):
        q = {}
        for e in (1_767_139_200, 1_774_915_200, 1_782_777_600):
            if r.random() < 0.7:
                q[e] = [r.choice([r.uniform(1, 900_000), None]), r.choice([r.uniform(1e6, 7e10), None])]
        out[t] = {"n": r.choice([f"{t} Trust", "", "x" * 300]), "fee": r.choice([None, 0.0025, 0.015]), "q": q}
    return out


def cftc(r: random.Random) -> object:
    if r.random() < 0.1:
        return junk(r)
    rows = []
    for i in range(r.randrange(0, 40)):
        ts = 1_700_000_000 + r.randrange(-3000, 1200) * DAY if r.random() > 0.1 else NOW + i * DAY
        rows.append({"cftc_contract_market_code": r.choice(["133741", "133742", "999999", junk(r)]),
                     "report_date_as_yyyy_mm_dd": time.strftime("%Y-%m-%dT00:00:00.000", time.gmtime(ts))
                     if r.random() > 0.05 else junk(r),
                     **{f: r.choice([str(r.randrange(0, 40_000)), "-5", "1e15", junk(r)]) if r.random() < 0.2
                        else str(r.randrange(0, 40_000)) for f in etf.CME_FIELDS}})
    return rows


def network(r: random.Random):
    flows, cf = tftc(r), cftc(r)

    def fetch(url, timeout):
        if "tftc.io" in url:
            return json.dumps(flows).encode() if r.random() > 0.02 else b"{"
        if "cftc.gov" in url:
            return json.dumps(cf).encode()
        return None

    return fetch


class FuzzTest(unittest.TestCase):
    def check(self, i: int, res: dict) -> None:
        m = f"случай {i}"
        if not res["ok"]:
            self.assertEqual(res, {"ok": False, "error": "no_data"}, m)
            return
        c = res["coins"]["btc"]
        tickers = [f["t"] for f in c["funds"]]
        self.assertEqual(len(tickers), len(set(tickers)), m)
        for f in c["funds"]:
            self.assertRegex(f["t"], r"^[A-Z0-9]{1,10}$", m)
            self.assertLessEqual(len(f["n"]), 60, m)
            for k in ("aum", "hold", "cum", "cumc"):
                self.assertTrue(math.isfinite(f[k]), m)
            self.assertGreaterEqual(f["hold"], 0, m)
        prev = 0
        for d in c["days"]:
            self.assertGreater(d[0], prev, m)
            prev = d[0]
            self.assertEqual(d[0] % DAY, 0, m)
            self.assertTrue(etf.ETF_LAUNCH <= d[0] <= NOW + DAY, m)
            self.assertTrue(all(math.isfinite(x) for x in d[1:4]), m)
            self.assertLessEqual(abs(d[1]) * 1000, etf.DAY_MAX + 1, m)
            self.assertEqual(len(d[4]), len(tickers), m)
            known = [v for v in d[4] if v is not None]
            if known:  # итог дня — сумма фондов (до округления)
                self.assertLessEqual(abs(sum(known) - d[1]), len(known), m)
        self.assertRegex(c["through"], r"^([0-9]{4}-[0-9]{2}-[0-9]{2})?$", m)
        for ts, v in c["tna"]:
            self.assertTrue(etf.TNA_MIN <= v <= etf.TNA_MAX and ts % DAY == 0, m)
        for w in (res["cme"] or {}).get("btc", []):
            self.assertEqual(len(w), 10, m)
            self.assertTrue(etf.CME_FROM <= w[0] <= NOW, m)
            self.assertTrue(all(0 <= v <= etf.CME_MAX for v in w[1:]), m)
        self.assertNotIn("cbp", res, m)
        self.assertTrue(all(d[3] == 0 or etf.PX_MIN <= d[3] <= etf.PX_MAX for d in c["days"]), m)

    def test_build_never_raises_and_keeps_invariants(self):
        r = random.Random(SEED)  # noqa: S311 — нужна повторяемость, а не криптостойкость
        good, logs = [], []
        with mock.patch.object(etf, "_now", lambda: NOW), mock.patch.object(etf, "_log", logs.append), \
                mock.patch.object(etf.wt_treasury, "companies", list):
            for i in range(CASES):
                etf._st = etf._State()
                data = sec(r)
                with mock.patch.object(etf, "_fetch", network(r)), \
                        mock.patch.object(etf.wt_treasury, "etf_funds", lambda d=data: d):
                    res = etf.build()
                self.check(i, res)
                if res["ok"]:
                    good.append(res)
        self.assertEqual([m for m in logs if m.startswith(("btc:", "сборка"))], [])
        # Генератор даёт и годные ответы, и отказы — иначе он ничего не проверяет.
        self.assertGreater(len(good), CASES // 3)
        self.assertLess(len(good), CASES)
        self.__class__.good = good

    @unittest.skipUnless(shutil.which("node"), "нужен Node 22.18+")
    def test_every_ok_reply_is_accepted_by_the_app(self):
        if not getattr(self.__class__, "good", None):
            self.test_build_never_raises_and_keeps_invariants()
        good = [g for g in self.__class__.good if g["coins"]["btc"]["days"]]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(good, f)
        try:
            script = (
                "import { readFileSync } from 'node:fs';"
                f"import {{ validEtf }} from {json.dumps(os.path.join(ROOT, 'src/lib/etf.ts'))};"
                "const all = JSON.parse(readFileSync(process.argv[1], 'utf8'));"
                f"const bad = all.filter((r) => {{ const v = validEtf(r, {NOW}); return !v"
                " || (r.cme.btc && !v.cme) || (r.coins.btc.tna.length && !v.coins.btc.tna)"
                " || (r.holders.length !== (v.holders || []).length); });"
                "console.log(JSON.stringify({ n: all.length, bad: bad.slice(0, 2) }));"
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

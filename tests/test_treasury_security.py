"""Отчёты SEC (wt_treasury) — правила кода, отравленные ответы и копия на диске (npm test).

Как у «Институциональных потоков»: модуль ходит только на data.sec.gov по
https, с подписью из окружения (почта — не в коде), без прокси и
перенаправлений; ответ SEC и копия на диске проверяются, и никакой мусор не
роняет сборку — в худшем случае фонда или компании просто нет.
"""
import ast
import json
import math
import os
import random
import re
import shutil
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_treasury as tr  # noqa: E402 — модуль лежит в корне репозитория

SEED = 0x5EC_5EC
CASES = 2_000
IMPORTS = {"__future__", "calendar", "contextlib", "http.client", "json", "math", "os", "re", "sys", "threading",
           "time", "urllib.parse", "urllib.request", "typing"}
JUNK = [None, "", "x", "1", True, [], {}, {"a": 1}, -1, 0, 1e300, -1e300, float("nan"), "２０２６-06-30",
        "2026-06-30<b>", "2026-13-45", 10**30, [1, 2, 3]]


def tree() -> ast.Module:
    with open(os.path.join(ROOT, "wt_treasury.py"), encoding="utf-8") as f:
        return ast.parse(f.read())


class PolicyTest(unittest.TestCase):
    def test_imports_are_on_the_list(self):
        found = set()
        for n in ast.walk(tree()):
            if isinstance(n, ast.Import):
                found |= {a.name for a in n.names}
            elif isinstance(n, ast.ImportFrom):
                found.add(n.module or "")
        self.assertLessEqual(found, IMPORTS, f"новый импорт: {found - IMPORTS}")

    def test_network_goes_through_one_door_to_sec_only(self):
        calls = [(fn.name, n.attr) for fn in ast.walk(tree()) if isinstance(fn, ast.FunctionDef)
                 for n in ast.walk(fn) if isinstance(n, ast.Attribute) and n.attr in ("open", "urlopen", "urlretrieve")]
        self.assertEqual(calls, [("_fetch", "open")])
        urls = [n for n in ast.walk(tree()) if isinstance(n, ast.JoinedStr)
                and n.values and isinstance(n.values[0], ast.Constant) and "://" in str(n.values[0].value)]
        self.assertTrue(urls)
        for u in urls:
            self.assertEqual(u.values[0].value, "https://")
            self.assertIsInstance(u.values[1], ast.FormattedValue)
            self.assertEqual(ast.unparse(u.values[1].value), "HOST")
        self.assertEqual(tr.HOST, "data.sec.gov")

    def test_no_contact_or_secret_in_code(self):
        # Подпись для SEC (с почтой) — только из окружения: в коде почты нет.
        with open(os.path.join(ROOT, "wt_treasury.py"), encoding="utf-8") as f:
            code = re.sub(r'""".*?"""|#[^\n]*', "", f.read(), flags=re.S)
        self.assertIsNone(re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", code))
        self.assertIn('os.environ.get("WT_SEC_UA"', code)

    def test_opener_is_direct_without_redirects(self):
        kinds = {type(h).__name__ for h in tr._opener.handlers}
        self.assertIn("_NoRedirect", kinds)
        self.assertFalse(any(getattr(h, "proxies", None) for h in tr._opener.handlers))

    def test_fetch_refuses_everything_but_sec_https_with_contact(self):
        with mock.patch.object(tr._opener, "open") as op, mock.patch.dict(os.environ, {"WT_SEC_UA": "x a@b.c"}):
            for url in ("http://data.sec.gov/x", "https://data.sec.gov.evil.com/x", "https://u:p@data.sec.gov/x",
                        "https://www.sec.gov/x", "file:///etc/passwd"):
                self.assertIsNone(tr._fetch(url, 5), url)
            op.assert_not_called()
        for ua in ("", "no contact", "a@b.c\r\nX-Evil: 1", "x" * 300 + "@b.c"):
            with mock.patch.object(tr._opener, "open") as op, mock.patch.dict(os.environ, {"WT_SEC_UA": ua}):
                self.assertIsNone(tr._fetch("https://data.sec.gov/x", 5), ua[:20])
                op.assert_not_called()


def facts(r: random.Random) -> object:
    """Ответ companyfacts: годные строки вперемешку с мусором любого типа."""
    if r.random() < 0.05:
        return r.choice(JUNK)

    def rows(lo: float, hi: float) -> list:
        out = []
        for _ in range(r.randrange(0, 12)):
            y = r.randrange(2023, 2027)
            row = {"end": r.choice([f"{y}-{m}" for m in ("03-31", "06-30", "09-30", "12-31")] + [r.choice(JUNK)]),
                   "val": r.uniform(lo, hi) if r.random() > 0.15 else r.choice(JUNK),
                   "form": r.choice(["10-Q", "10-K", "10-K/A", "8-K", r.choice(JUNK)]),
                   "filed": r.choice(["2026-08-01", "2026-02-01", r.choice(JUNK)])}
            if r.random() < 0.2:
                row["start"] = "2026-01-01"
            out.append(row if r.random() > 0.05 else r.choice(JUNK))
        return out

    g = {
        "CryptoAssetNumberOfUnits": {"units": {r.choice(["Bitcoin", "BTC", "USD", "x"]): rows(0, 1e6)}},
        "CryptoAssetFairValue": {"units": {"USD": rows(1e6, 9e10)}},
        "InvestmentCompanyExpenseRatioIncludingIncentiveFee": {"units": {"pure": rows(0, 0.05)}},
    }
    for k in list(g):
        if r.random() < 0.1:
            g[k] = r.choice(JUNK)
    return {"facts": {"us-gaap": g}} if r.random() > 0.05 else {"facts": r.choice(JUNK)}


class FuzzTest(unittest.TestCase):
    def test_fund_points_never_raise_and_stay_sane(self):
        r = random.Random(SEED)  # noqa: S311 — нужна повторяемость
        for i in range(CASES):
            p = tr.fund_points(facts(r))
            self.assertEqual(set(p), {"q", "fee"}, i)
            self.assertTrue(p["fee"] is None or 0 < p["fee"] < tr.FEE_MAX, i)
            for e, (cnt, fv) in p["q"].items():
                self.assertIsInstance(e, int, i)
                self.assertTrue(cnt is None or (math.isfinite(cnt) and cnt >= 100), i)
                self.assertTrue(fv is None or math.isfinite(fv), i)

    def test_quarter_date_is_ascii_only(self):
        # «２０２６-06-30» — не дата отчёта: такой строки в SEC не бывает.
        rows = [{"end": "２０２６-06-30", "val": 700_000, "form": "10-Q", "filed": "2026-08-01"}]
        got = tr.fund_points({"facts": {"us-gaap": {"CryptoAssetNumberOfUnits": {"units": {"BTC": rows}}}}})
        self.assertEqual(got["q"], {})
        rows[0]["end"] = "2026-06-30"
        got = tr.fund_points({"facts": {"us-gaap": {"CryptoAssetNumberOfUnits": {"units": {"BTC": rows}}}}})
        self.assertEqual(list(got["q"]), [1_782_777_600])

    def test_holding_never_raises(self):
        r = random.Random(SEED + 1)  # noqa: S311
        for i in range(CASES):
            f = facts(r)
            g = ((f.get("facts") or {}) if isinstance(f, dict) else {})
            concept = (g.get("us-gaap") or {}).get("CryptoAssetNumberOfUnits") if isinstance(g, dict) and isinstance(g.get("us-gaap"), dict) else f
            got = tr.holding(concept)
            self.assertTrue(got is None or (0 <= got[0] < 3_000_000 and got[1] > 0), i)


class DiskCopyTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        tr._st, tr._fst = tr._State(), tr._FundState()
        tr.set_cache_dir(self.dir)
        self.addCleanup(tr.set_cache_dir, None)

    def test_poisoned_fund_copy_is_cleaned_on_load(self):
        body = {"IBIT": {"n": {"x": 1}, "fee": "0.25", "q": {"1782777600": [734261, None], "x": [1, 2],
                                                              "1774915200": ["7e5", None], "1767139200": [-1, None],
                                                              "1759190400": ["inf", None], "1751241600": [1, 2, 3]}},
                "BAD": "мусор", "FBTC": {"n": "Fidelity", "fee": 0.0025, "q": {"1782777600": [None, 9e9]}}}
        tr._file_save("sec_funds.json", body)
        with mock.patch.dict(os.environ, {"WT_SEC_UA": ""}):
            got = tr.etf_funds()
        self.assertEqual(got["IBIT"], {"n": "{'x': 1}", "q": {1782777600: [734261, None]}, "fee": None})
        self.assertEqual(got["FBTC"]["fee"], 0.0025)
        self.assertNotIn("BAD", got)

    def test_broken_copy_files_are_ignored(self):
        # Битый JSON, бесконечности (их JSON-разбор не пускает), не тот вид.
        for body in ("{", "[1]", json.dumps({"at": "x", "v": {}}), json.dumps({"at": 1e999}),
                     '{"at": 1e9, "v": {"IBIT": {"q": {"1": [Infinity, null]}}}}'):
            with open(os.path.join(self.dir, "sec_funds.json"), "w", encoding="utf-8") as f:
                f.write(body)
            tr._fst = tr._FundState()
            with mock.patch.dict(os.environ, {"WT_SEC_UA": ""}):
                self.assertEqual(tr.etf_funds(), {}, body)


if __name__ == "__main__":
    unittest.main()

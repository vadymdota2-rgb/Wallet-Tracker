"""Безопасность карты ликвидаций: отравленные ответы бирж (npm test).

Источники — три десятка чужих бирж. Если одну из них взломают или подменят
ответ по дороге, худшее, что может случиться, — карта без этой биржи или
«нет данных». Ни падения, ни NaN и бесконечностей в рядах и ответе, ни чужой
строки в ответе и списке монет, ни выхода в сеть мимо списка адресов.

Отрава — случайные деревья JSON из ключей, которые читают сами источники
(их собираем из кода), с неправильными типами и значениями: строки вместо
чисел, NaN и бесконечность (json.loads их принимает), огромные и
отрицательные числа, HTML, списки вместо словарей. Зерно задано — прогон
повторяем.
"""
import ast
import io
import json
import math
import os
import random
import re
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модули лежат в корне репозитория
import wt_liqmap as lm  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_liqmap_policy import HOSTS  # noqa: E402 — список адресов один на оба теста

NOW = 1_794_050_000
EVIL = "<img src=x onerror=alert(1)>"
SYM_OK = re.compile(r"[A-Z][A-Z0-9]{0,14}")
ROUNDS = int(os.environ.get("LIQ_FUZZ_ROUNDS", "60"))


def vocabulary() -> list[str]:
    """Ключи, которые источники читают из ответов: r.get("x"), r["x"], _jrows(v, "x")."""
    with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
        tree = ast.parse(f.read())
    keys: set[str] = set()
    for fn in tree.body:
        if not (isinstance(fn, ast.FunctionDef) and re.match(r"_(liq|snap)_", fn.name)):
            continue
        for n in ast.walk(fn):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "get" and n.args:
                arg = n.args[0]
            elif isinstance(n, ast.Subscript):
                arg = n.slice
            elif isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in ("_jrows", "_jlists"):
                for a in n.args[1:]:
                    if isinstance(a, ast.Constant) and isinstance(a.value, str):
                        keys.add(a.value)
                continue
            else:
                continue
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str) and len(arg.value) < 40:
                keys.add(arg.value)
    return sorted(keys)


KEYS = vocabulary()
SYMS = ["BTCUSDT", "BTC-USDT-SWAP", "BTC_USDT", "BTC-USD", "PF_XBTUSD", "BTC", "ETHUSDT", "DOT-USDT", "btc_usdt",
        "BTC-USDC-PERP", "../admin", "BTC?x=1", EVIL, "1000PEPEUSDT", "XBT", "DOTUSDT", "BTC-PERP", "cBTCUSD"]


def leaf(rnd: random.Random) -> object:
    t = NOW * 1000 + rnd.randint(-10**9, 10**6)
    return rnd.choice([
        None, True, False, "", EVIL, "NaN", "1e400", "-5", "12.5", "abc", 0, -1, 1, 0.5, 1e308, -1e308,
        float("nan"), float("inf"), -float("inf"), 2**70, rnd.choice(SYMS), t, t // 1000, str(t), rnd.random() * 1e5,
        str(rnd.random() * 1e5), [], {}, "PERPETUAL", "ACTIVE", "Buy", "Sell", "SELL", "long", "short",
    ])


def tree(rnd: random.Random, depth: int = 0) -> object:
    roll = rnd.random()
    if depth >= 4 or roll < 0.25:
        return leaf(rnd)
    if roll < 0.6:
        return {rnd.choice(KEYS) if rnd.random() < 0.85 else rnd.choice(SYMS): tree(rnd, depth + 1)
                for _ in range(rnd.randint(0, 8))}
    if roll < 0.8:
        return [tree(rnd, depth + 1) for _ in range(rnd.randint(0, 12))]
    # Ряд свечей/интереса: список списков чисел и строк — как у бирж.
    return [[leaf(rnd) for _ in range(rnd.randint(0, 9))] for _ in range(rnd.randint(0, 30))]


def poison(rnd: random.Random):
    """get_json и hl_post, что на каждый запрос отдают новую отраву; адреса — в urls."""
    urls: list[str] = []

    def get(url, *_a, **_k):
        urls.append(url)
        v = tree(rnd)
        # Изредка — ответ, прошедший через json.loads с NaN и Infinity.
        return json.loads(json.dumps(v)) if isinstance(v, (dict, list)) and rnd.random() < 0.3 else v

    def post(_body, *_a, **_k):
        return tree(rnd)

    return get, post, urls


def finite(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def strings(v: object) -> list[str]:
    if isinstance(v, str):
        return [v]
    if isinstance(v, dict):
        return [s for k, x in v.items() for s in strings(k) + strings(x)]
    if isinstance(v, (list, tuple)):
        return [s for x in v for s in strings(x)]
    return []


class Fuzz(unittest.TestCase):
    def setUp(self):
        self.err = mock.patch("sys.stderr", io.StringIO())
        self.err.start()
        self.addCleanup(self.err.stop)
        for cache in (api._liq_coins_cache, api._liq_real, api._liq_comp):
            cache.clear()
        api._mexc_size.update(at=0.0, map={})

    def run_poisoned(self, seed: int, fn, *args):
        rnd = random.Random(seed)  # noqa: S311 — повторяемая отрава, не тайна
        get, post, urls = poison(rnd)
        with mock.patch.object(api, "get_json", get), mock.patch.object(api, "hl_post", post), \
                mock.patch.object(api, "now", return_value=NOW):
            res = fn(*args)
        for u in urls:
            host = re.match(r"https://([^/?#]+)/", u)
            self.assertIn(host.group(1) if host else u, HOSTS)
            self.assertNotIn("..", u)
            self.assertNotIn(" ", u)
            self.assertNotIn("<", u)
        return res

    def check_rows(self, name: str, rows: object) -> None:
        if rows is None:
            return
        if not isinstance(rows, list):
            self.fail(f"{name}: не список")
        for r in rows:
            self.assertEqual(len(r), 6, name)
            t, h, low, c, oi, bs = r
            self.assertTrue(finite(t), (name, r))
            for v in (h, low, c, oi):
                self.assertTrue(finite(v), (name, r))
            self.assertTrue(bs is None or (finite(bs) and 0 <= bs <= 1), (name, r))


class SourcesTest(Fuzz):
    def test_history_sources_never_raise_and_give_finite_rows(self):
        for name, fn in api.LIQ_SOURCES:
            for seed in range(ROUNDS):
                for sym in ("BTC", "DOT"):
                    with self.subTest(source=name, seed=seed, sym=sym):
                        self.check_rows(name, self.run_poisoned(seed, fn, sym, "1h", 48))

    def test_snapshots_never_raise_and_give_our_symbols(self):
        for name, fn in api.LIQ_SNAPS:
            for seed in range(ROUNDS):
                with self.subTest(snap=name, seed=seed):
                    api._mexc_size.update(at=0.0, map={})
                    got = self.run_poisoned(seed, fn)
                    self.assertIsInstance(got, dict)
                    for sym, val in got.items():
                        self.assertRegex(sym, SYM_OK)
                        usd, px = val
                        self.assertTrue(finite(usd), (name, sym, val))
                        self.assertTrue(finite(px) and px > 0, (name, sym, val))

    def test_hyperliquid_candles(self):
        for seed in range(ROUNDS * 2):
            with self.subTest(seed=seed):
                self.check_rows("hl", self.run_poisoned(seed, api._liq_hl_candles, "BTC", "1h", 48))

    def test_coin_list_has_only_our_symbols(self):
        for seed in range(ROUNDS):
            with self.subTest(seed=seed):
                res = self.run_poisoned(seed, api._liq_coins_build)
                self.assertIsInstance(res, dict)
                for c in res.get("coins", []):
                    self.assertRegex(c["s"], SYM_OK)
                    self.assertTrue(finite(c["v"]) and c["v"] >= 0, c)
                for s in strings(res):
                    self.assertNotIn("<", s)


def junk_rows(rnd: random.Random, n: int = 60) -> object:
    """Ряды источника, где часть строк настоящая, а часть — отрава."""
    t0, px, out = NOW - n * 3600, 100.0, []
    for i in range(n):
        good = (t0 + i * 3600, px * 1.01, px * 0.99, px, 1e9 + i * 1e6, 0.5)
        roll = rnd.random()
        if roll < 0.6:
            out.append(good)
        elif roll < 0.8:
            j = rnd.randrange(6)
            out.append(tuple(leaf(rnd) if k == j else v for k, v in enumerate(good)))
        else:
            out.append(rnd.choice([None, "row", [], good[:5], (*good, 1), {"t": 1}, [float("nan")] * 6, True]))
    return rnd.choice([out, out, out, None, "rows", {"a": out}, out[:3], [None] * 30])


def const(v: object):
    """Источник, что всегда отдаёт v."""
    return lambda *_a: v


class GateTest(Fuzz):
    """Ворота перед моделью и базой: что бы ни отдал источник, дальше идут
    только правдоподобные числа, а сбой одной биржи не роняет остальные."""

    def test_source_rows_gate(self):
        rnd = random.Random(1)  # noqa: S311 — повторяемая отрава, не тайна
        for _ in range(300):
            for r in api._liq_valid(junk_rows(rnd)):
                self.assertEqual(len(r), 6)
                self.assertIsInstance(r[0], int)
                self.assertTrue(all(finite(x) for x in r[1:]), r)
                self.assertTrue(min(r[1:4]) > 0 and r[4] >= 0 and 0 <= r[5] <= 1, r)

    def test_gather_survives_poisoned_sources(self):
        for seed in range(ROUNDS):
            with self.subTest(seed=seed):
                rnd = random.Random(seed)  # noqa: S311 — повторяемая отрава, не тайна
                srcs = [(name, const(junk_rows(rnd))) for name, _ in api.LIQ_SOURCES]
                srcs[0] = (srcs[0][0], lambda *_a: 1 / 0)  # одна биржа падает
                with mock.patch.object(api, "LIQ_SOURCES", tuple(srcs)), \
                        mock.patch.object(api, "_liq_sampled", return_value={}), \
                        mock.patch.object(api, "_liq_hl_candles", return_value=None):
                    got, ref = api._liq_gather("BTC", "1h", 48)
                for name, rows in got.items():
                    self.assertEqual(api._liq_valid(rows), [tuple(r) for r in rows], name)
                if ref:
                    self.assertEqual(api._liq_valid(ref), [tuple(r) for r in ref])

    def test_hyperliquid_fallback_candles_pass_the_gate(self):
        # Бирж с историей нет — опора по свечам Hyperliquid: и они через ворота.
        rnd = random.Random(3)  # noqa: S311 — повторяемая отрава, не тайна
        nan = float("nan")
        crafted = [(NOW - 3600 * (20 - i), 1.01, 0.99, 1.0, 0.0, 0.5) for i in range(20)]
        crafted[5] = (crafted[5][0], nan, 0.99, 1.0, 0.0, 0.5)
        crafted[6] = ("t", 1.01, 0.99, 1.0, 0.0, 0.5)
        for rows in [crafted, *(junk_rows(rnd) for _ in range(30))]:
            with mock.patch.object(api, "LIQ_SOURCES", (("OKX", const(None)),)), \
                    mock.patch.object(api, "_liq_sampled", return_value={}), \
                    mock.patch.object(api, "_liq_hl_candles", const(rows)):
                got, ref = api._liq_gather("BTC", "1h", 48)
            self.assertEqual(got, {})
            if ref is not None:
                self.assertTrue(ref)
                self.assertEqual(api._liq_valid(ref), [tuple(r) for r in ref])
        with mock.patch.object(api, "LIQ_SOURCES", (("OKX", const(None)),)), \
                mock.patch.object(api, "_liq_sampled", return_value={}), \
                mock.patch.object(api, "_liq_hl_candles", const(crafted)):
            _, ref = api._liq_gather("BTC", "1h", 48)
        self.assertEqual(len(ref or []), 18)

    def test_snapshot_writer_stores_only_sane_numbers(self):
        nan, inf = float("nan"), float("inf")
        bad = {"BTC": (inf, 1e5), "ETH": (1e9, inf), "SOL": (nan, 150.0), "XRP": (1e9, nan), "ADA": (1e14, 0.5),
               "DOGE": (1e9, 1e10), EVIL: (1e9, 1.0), "btc": (1e9, 1.0), "AVAX": ("1e9", 20.0), "LINK": (True, 20.0),
               "DOT": (1e9,), "SUI": [1e9, 2.0], "TRX": (1e9, 0.3, True, 4), "TON": (-1e9, 5.0), "NEAR": (1e9, -5.0)}
        good = {"BTC": (2e9, 100_000.0), "DOT": (3e8, 4.0), "0G": (1e6, 0.15), "PEPE": (5e5, 0.0, True)}
        snaps = (("Bad", lambda: bad), ("Crash", lambda: 1 / 0), ("List", lambda: [1, 2]), ("None", lambda: None),
                 ("Good", lambda: good))
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "liq_oi.db")
            with mock.patch.object(api, "LIQ_OI_DB", path), mock.patch.object(api, "LIQ_SNAPS", snaps), \
                    mock.patch.object(api, "now", return_value=NOW):
                counts = api.liq_oi_sample()
            con = sqlite3.connect(path)
            try:
                rows = con.execute("SELECT ex, coin, oi, px FROM oi_snap ORDER BY ex, coin").fetchall()
            finally:
                con.close()
        self.assertEqual(counts, {"Bad": 0, "Crash": 0, "List": 0, "None": 0, "Good": 3})
        # PEPE — в монетах без цены; цены по монете нет и у других — не снимок.
        self.assertEqual([r[:2] for r in rows], [("Good", "0G"), ("Good", "BTC"), ("Good", "DOT")])
        for _ex, _c, oi, px in rows:
            self.assertTrue(math.isfinite(oi) and math.isfinite(px) and oi > 0 and px > 0)


class MapTest(Fuzz):
    def test_gather_and_build_never_crash(self):
        lm._st = lm._State()
        self.addCleanup(setattr, lm, "_st", lm._State())
        lm.set_price(lambda _s: None)
        self.addCleanup(lm.set_price, None)
        self.addCleanup(lm.set_gather, api._liq_gather)
        with mock.patch.object(api, "_liq_sampled", return_value={}), mock.patch.object(api, "_liq_day_keep", lambda _s, g: g), \
                mock.patch.object(lm, "_pre", return_value={}), mock.patch.object(lm, "TAIL", {}):
            for seed in range(ROUNDS):
                with self.subTest(seed=seed):
                    rnd = random.Random(seed)  # noqa: S311 — повторяемая отрава, не тайна
                    get, post, _ = poison(rnd)
                    with mock.patch.object(api, "get_json", get), mock.patch.object(api, "hl_post", post):
                        lm.set_gather(api._liq_gather)
                        res = lm.build("BTC", "7d", pre_wait=0.0)
                    self.assertIn(res.get("ok"), (True, False))
                    if res["ok"]:
                        self.check_reply(res)
                    else:
                        self.assertEqual(res, {"ok": False, "error": "no_data"})

    def check_reply(self, res: dict) -> None:
        self.assertNotIn("NaN", json.dumps(res))
        json.dumps(res, allow_nan=False)
        for e in res["ex"]:
            self.assertIn(e, {n for n, _ in api.LIQ_SOURCES} | {n for n, _ in api.LIQ_SNAPS})
        for s in strings(res):
            self.assertNotIn("<", s)

    def test_crafted_rows_with_nan_are_dropped_by_the_model(self):
        good = [(1_700_000_000 + i * 3600, 101.0, 99.0, 100.0, 1e9, 0.5) for i in range(168)]
        bad = [*good[:80], (good[80][0], float("nan"), 99.0, 100.0, 1e9, 0.5),
               (good[81][0], 101.0, 99.0, float("inf"), 1e9, 0.5), (good[82][0], 101.0, 99.0, 100.0, -1e9, 0.5),
               (good[83][0], 101.0, 99.0, 100.0, 1e9, float("nan")), *good[84:]]
        res = lm.build_map("BTC", "7d", {"Binance": lm.clean_rows(bad)}, lm.clean_rows(good), 1_700_700_000)
        json.dumps(res, allow_nan=False)
        self.assertTrue(res["ok"])


class FeedTest(Fuzz):
    """Лента настоящих ликвидаций (WebSocket бирж) → база → точки на свечах."""

    def setUp(self):
        super().setUp()
        api._liqs_q.clear()
        self.addCleanup(api._liqs_q.clear)

    def test_poisoned_events_never_queue(self):
        nan, inf = float("nan"), float("inf")
        for args in [("BTCUSDT", NOW * 1000, True, nan, 1e5), ("BTCUSDT", NOW * 1000, True, 1e5, nan),
                     ("BTCUSDT", NOW * 1000, True, inf, 1e5), ("BTCUSDT", NOW * 1000, True, 1e5, inf),
                     ("BTCUSDT", nan, True, 1e5, 1e5), ("BTCUSDT", -5, True, 1e5, 1e5), ("BTCUSDT", NOW * 1000, True, -1, 5),
                     (EVIL, NOW * 1000, True, 1e5, 1e5), ("BTC'; DROP TABLE liq_ev;--", NOW * 1000, True, 1e5, 1e5),
                     ("", NOW * 1000, True, 1e5, 1e5), (None, NOW * 1000, True, 1e5, 1e5),
                     ("BTCUSDT", NOW * 1000, True, 1e5, 1e14)]:
            with self.subTest(args=args):
                api._liqs_put("Binance", *args)
        self.assertEqual(api._liqs_q, [])
        api._liqs_put("Binance", "BTCUSDT", NOW * 1000, True, 1e5, 2e5)
        self.assertEqual(len(api._liqs_q), 1)
        self.assertEqual(api._liqs_q[0][1], "BTC")

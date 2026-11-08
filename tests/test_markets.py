"""Рынки в боковом меню (/api/markets): сборка, DXY по формуле ICE, сбои источников.

Источники — Hyperliquid (площадки HIP-3 «xyz» и «para»), курсы ЕЦБ
(Frankfurter) и DVOL Deribit. Проверяем: какие рынки берутся и какие нет
(снятые с торгов), формулу DXY, что сбой или мусор одного источника не
роняет остальные, что ответ — только числа и наши ключи, и что маршрут —
для подписчиков.
"""
import json
import math
import os
import random
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модуль лежит в корне репозитория

NOW = 1_794_100_000
KEYS = {"SP500", "NDX", "DXY", "GOLD", "SILVER", "WTI", "BRENT", "US10Y", "DVOL"}


def hl_dex(markets: dict, delisted: tuple = ()) -> list:
    uni = [{"name": f"xyz:{n}", **({"isDelisted": True} if n in delisted else {})} for n in markets]
    ctx = [{"markPx": str(px), "prevDayPx": str(prev)} for px, prev in markets.values()]
    return [{"universe": uni}, ctx]


XYZ = {"SP500": (7373.1, 7392.9), "XYZ100": (26925, 26996), "GOLD": (4066.2, 4079.9), "SILVER": (52.013, 52.016),
       "CL": (90.135, 89.633), "BRENTOIL": (97.134, 96.83), "EUR": (1.1157, 1.1156), "JPY": (158.36, 158.29),
       "DXY": (97.15, 97.15), "VIX": (20, 20)}
PARA = {"10Y": (4.875, 4.8777)}
ECB = {"rates": {"2026-11-05": {"EUR": 0.89095, "JPY": 158.46, "GBP": 0.74299, "CAD": 1.3966, "SEK": 9.7866, "CHF": 0.81789},
                 "2026-11-06": {"EUR": 0.89566, "JPY": 158.33, "GBP": 0.74711, "CAD": 1.4066, "SEK": 9.8755, "CHF": 0.8189}}}
T = NOW * 1000
DVOL = {"result": {"data": [[T - h * 3_600_000, 0, 0, 0, 40 - h * 0.05] for h in range(26, -1, -1)]}}


def fake_post(body, *_a, **_k):
    if body.get("dex") == "xyz":
        return hl_dex(XYZ, delisted=("DXY", "VIX"))
    if body.get("dex") == "para":
        return hl_dex(PARA)
    return None


def fake_get(url, *_a, **_k):
    if "frankfurter" in url:
        return ECB
    if "deribit" in url:
        return DVOL
    return None


def build(post=fake_post, get=fake_get) -> dict:
    with mock.patch.object(api, "hl_post", post), mock.patch.object(api, "get_json", get), \
            mock.patch.object(api, "now", return_value=NOW), mock.patch("sys.stderr"):
        return api._mkt_build()


class BuildTest(unittest.TestCase):
    def test_all_nine(self):
        r = build()
        self.assertTrue(r["ok"])
        self.assertEqual(r["at"], NOW)
        got = {it["k"]: (it["px"], it["prev"]) for it in r["items"]}
        self.assertEqual(set(got), KEYS)
        self.assertEqual(got["SP500"], (7373.1, 7392.9))
        self.assertEqual(got["NDX"], (26925, 26996))
        self.assertEqual(got["WTI"], (90.135, 89.633))
        self.assertEqual(got["US10Y"], (4.875, 4.8777))
        self.assertEqual(got["DVOL"], (40.0, 38.8))  # сейчас и ровно сутки назад
        json.dumps(r, allow_nan=False)

    def test_dxy_by_ice_formula(self):
        r = {"EUR": 1 / 1.1157, "JPY": 158.36, "GBP": 0.74711, "CAD": 1.4066, "SEK": 9.8755, "CHF": 0.8189}
        want = 50.14348112 * 1.1157 ** -0.576 * 158.36 ** 0.136 * (1 / 0.74711) ** -0.119 * 1.4066 ** 0.091 \
            * 9.8755 ** 0.042 * 0.8189 ** 0.036
        self.assertAlmostEqual(api._dxy(r), want, places=9)
        self.assertAlmostEqual(sum(abs(w) for _, w in api.DXY_W), 1.0, places=9)
        got = {it["k"]: it for it in build()["items"]}["DXY"]
        self.assertAlmostEqual(got["px"], round(want, 3), places=6)
        # Сутки назад: EUR и JPY — сутки назад у Hyperliquid, остальное — прошлый день ЕЦБ.
        prev = dict(ECB["rates"]["2026-11-05"], EUR=1 / 1.1156, JPY=158.29)
        self.assertAlmostEqual(got["prev"], round(api._dxy(prev), 3), places=6)
        self.assertTrue(95 < got["px"] < 110)

    def test_delisted_markets_are_not_shown(self):
        # DXY и VIX у Hyperliquid сняты с торгов — их застывшие цены не берём.
        items = build()["items"]
        dxy = next(it for it in items if it["k"] == "DXY")
        self.assertNotAlmostEqual(dxy["px"], 97.15, places=1)
        self.assertNotIn("VIX", {it["k"] for it in items})

    def test_one_silent_source_does_not_drop_the_rest(self):
        def no_ecb(url, *a, **k):
            return None if "frankfurter" in url else fake_get(url, *a, **k)

        keys = {it["k"] for it in build(get=no_ecb)["items"]}
        self.assertNotIn("DXY", keys)
        self.assertIn("SP500", keys)

        def boom_post(body, *a, **k):
            if body.get("dex") == "xyz":
                raise OSError("нет сети")
            return fake_post(body, *a, **k)

        keys = {it["k"] for it in build(post=boom_post)["items"]}
        self.assertEqual(keys, {"US10Y", "DVOL"})  # без xyz нет ни индексов, ни EUR/JPY для DXY
        self.assertEqual(build(post=lambda *a, **k: None, get=lambda *a, **k: None), {"ok": False, "error": "no_data"})

    def test_poisoned_sources(self):
        rnd = random.Random(7)  # noqa: S311 — повторяемая отрава, не тайна
        junk = [None, "x", 0, -1, 1e400, float("nan"), float("inf"), [], {}, "1e999", True, "<b>", 1e8, 2**70]
        for _ in range(300):
            def post(body, *_a, **_k):
                if rnd.random() < 0.3:
                    return rnd.choice(junk)
                m = {n: (rnd.choice([*junk, 1.5, 100.0]), rnd.choice([*junk, 1.4, 99.0])) for n in rnd.sample(list(XYZ), 5)}
                return [{"universe": [{"name": f"xyz:{n}"} for n in m] + [rnd.choice(junk)]},
                        [{"markPx": a, "prevDayPx": b} for a, b in m.values()]]

            def get(url, *_a, **_k):
                if rnd.random() < 0.5:
                    return rnd.choice(junk)
                if "frankfurter" in url:
                    return {"rates": {rnd.choice(["2026-11-05", "x", "<b>"]): {c: rnd.choice([*junk, 1.2]) for c in ("EUR", "JPY", "GBP", "CAD", "SEK", "CHF")}}}
                return {"result": {"data": [[rnd.choice([*junk, T]), 0, 0, 0, rnd.choice([*junk, 40.0])] for _ in range(5)]}}

            r = build(post, get)
            json.dumps(r, allow_nan=False)
            if r["ok"]:
                for it in r["items"]:
                    self.assertIn(it["k"], KEYS)
                    self.assertEqual(set(it), {"k", "px", "prev"})
                    for v in (it["px"], it["prev"]):
                        self.assertTrue(isinstance(v, float) and math.isfinite(v) and 0 < v < api.MKT_PX_MAX, it)


class RouteTest(unittest.TestCase):
    def test_paid_and_routed(self):
        self.assertIn("/api/markets", api.PAID_PATHS)
        self.assertIn("/markets", api.PAID_PATHS)
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('if path in ("/markets", "/api/markets"):\n                self._json(200, markets_data())', src)

    def test_cached_for_a_minute(self):
        self.assertEqual(api.MKT_TTL, 60.0)
        calls = []
        api._MKT.clear()
        self.addCleanup(api._MKT.clear)
        with mock.patch.object(api, "_mkt_build", lambda: calls.append(1) or {"ok": True, "at": NOW, "items": []}):
            api.markets_data()
            api.markets_data()
        self.assertEqual(len(calls), 1)

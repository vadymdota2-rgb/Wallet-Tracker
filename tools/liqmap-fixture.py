"""Образец ответа /api/liqmap для e2e: python3 tools/liqmap-fixture.py

Карта собирается настоящим wt_liqmap.build_map из выдуманного рынка: цена
BTC бродит вокруг $100 000 (случайное блуждание с постоянным зерном),
открытый интерес трёх «бирж» растёт и иногда падает. Чужих данных в образце
нет — только модель на выдуманных рядах.
"""
import json
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_liqmap  # noqa: E402

AT = 1_793_000_000  # «сейчас» образца (ноябрь 2026)
SEC = {"15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}


def market(seed: int, n: int, period: str, oi0: float, vol: float) -> list[wt_liqmap.Row]:
    rnd = random.Random(seed)  # noqa: S311 — выдуманный рынок для образца, не тайна
    px, oi, out = 100_000.0, oi0, []
    t0 = AT - n * SEC[period]
    for i in range(n):
        c = px * (1 + rnd.gauss(0, vol))
        hi, lo = max(px, c) * (1 + abs(rnd.gauss(0, vol / 2))), min(px, c) * (1 - abs(rnd.gauss(0, vol / 2)))
        oi *= 1 + rnd.gauss(0.002, 0.01)
        out.append((t0 + i * SEC[period], round(hi, 2), round(lo, 2), round(c, 2), round(oi), round(rnd.uniform(0.4, 0.6), 3)))
        px = c
    return out


def main() -> None:
    res = {}
    for rng, (period, n) in wt_liqmap.RANGES.items():
        vol = {"1d": 0.0015, "7d": 0.003, "30d": 0.006, "90d": 0.02, "180d": 0.02, "365d": 0.02}[rng]
        got = {ex: market(seed + n, n, period, oi0, vol)
               for seed, (ex, oi0) in enumerate((("Alpha", 6e9), ("Beta", 4e9), ("Gamma", 2e9)))}
        # Опора — первая «биржа»; у всех одна цена, как у настоящих бирж.
        ref = got["Alpha"]
        got = {ex: [(*r[:4], o[4], o[5]) for r, o in zip(ref, rows, strict=True)] for ex, rows in got.items()}
        res[rng] = wt_liqmap.build_map("BTC", rng, got, ref, AT)
    res["now"] = AT
    with open(os.path.join(ROOT, "tests/fixtures/liqmap.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, separators=(",", ":"))
        f.write("\n")


main()

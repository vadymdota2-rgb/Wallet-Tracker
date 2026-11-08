"""Рынки для криптотрейдера — сверху бокового меню (/api/markets).

Девять чисел, на которые профессионал смотрит рядом с графиком биткоина,
сетка 3 × 3:

    S&P 500   Nasdaq 100   DXY      — аппетит к риску и доллар;
    Золото    US 10Y       DVOL     — «убежище», ставки, ждёт ли рынок шторма;
    BTC.D     USDT.D       ETH/BTC  — куда течёт капитал внутри крипты.

По каждому пункту — цена сейчас и сутки назад; изменение считает
приложение (у доходности — в базисных пунктах).

Источники — те, что проект уже берёт; модуль сам в сеть не ходит: ответы
источников ему отдаёт сервер (set_sources), здесь — только разбор, расчёт
и кэш:
  - Hyperliquid, бессрочные рынки HIP-3 (площадки «xyz» и «para»): S&P 500,
    Nasdaq-100 (XYZ100), золото, курсы EUR и JPY, доходность 10Y — круглые
    сутки; основная площадка — BTC и ETH для ETH/BTC. Рынки, снятые с
    торгов, не берутся: их цена застыла (DXY и VIX на «xyz»);
  - DXY нигде не торгуется — считаем по формуле ICE: EUR и JPY с
    Hyperliquid, GBP, CAD, SEK, CHF — курсы ЕЦБ (Европейского центрального
    банка) за последний рабочий день;
  - VIX нигде не торгуется, а индекс Cboe без лицензии показывать нельзя —
    вместо него DVOL Deribit, индекс волатильности BTC;
  - BTC.D и USDT.D — доли в капитализации рынка по CoinMarketCap (модуль
    доминации, wt_mcap: его данные и его условия — подпись источника рядом).
    У USDT.D CoinMarketCap не отдаёт вчерашнюю долю: сутки назад — та же
    капитализация USDT к вчерашней капитализации рынка (выпуск USDT за
    сутки меняется на доли процента, доля — от рынка).

Кэш: ответ живёт TTL; постарше — отдаётся сразу, а свежий собирается в фоне
одним потоком; ответа нет вовсе — запрос ждёт сборку не дольше COLD_WAIT.
Сбой одного источника не роняет остальные: пункт без данных просто не
показывается.
"""
from __future__ import annotations

import math
import re
import threading
import time
from collections.abc import Callable
from typing import Any

Json = Any
Pair = tuple[float, float]
Source = Callable[[], object]

# Пункты — в порядке экрана.
KEYS = ("SP500", "NDX", "DXY", "GOLD", "US10Y", "DVOL", "BTCD", "USDTD", "ETHBTC")
# Рынки Hyperliquid: пункт → (площадка, имя рынка без приставки).
HL = {"SP500": ("xyz", "SP500"), "NDX": ("xyz", "XYZ100"), "GOLD": ("xyz", "GOLD"), "US10Y": ("para", "10Y")}
# DXY = 50,14348112 × ∏ курс^вес (ICE): EUR и GBP — в долларах за единицу
# (вес со знаком минус), остальные — единиц за доллар.
DXY_K = 50.14348112
DXY_W = (("EUR", -0.576), ("JPY", 0.136), ("GBP", -0.119), ("CAD", 0.091), ("SEK", 0.042), ("CHF", 0.036))
PX_MAX = 1e7  # правдоподобная цена пункта
DAY_MS = 86_400_000
TTL = 60.0
COLD_WAIT = 6.0
FAIL_WAIT = 30.0  # сборка ничего не дала — следующая не раньше
DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _num(v: object) -> float:
    """Число из ответа источника (строка или число); иначе — 0."""
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        return 0.0
    try:
        f = float(v)
    except ValueError:
        return 0.0
    return f if math.isfinite(f) else 0.0


def pair(now: object, prev: object) -> Pair | None:
    """(сейчас, сутки назад) — оба конечные, больше нуля и правдоподобные."""
    a, b = _num(now), _num(prev)
    return (a, b) if 0 < a < PX_MAX and 0 < b < PX_MAX else None


def hl_markets(raw: object) -> dict[str, Pair]:
    """Ответ Hyperliquid metaAndAssetCtxs → {рынок без приставки: (сейчас,
    сутки назад)}; снятые с торгов и кривые — мимо."""
    out: dict[str, Pair] = {}
    if not isinstance(raw, list) or len(raw) < 2 or not isinstance(raw[0], dict) or not isinstance(raw[1], list):
        return out
    uni = raw[0].get("universe")
    for u, c in zip(uni if isinstance(uni, list) else [], raw[1]):  # noqa: B905 — длины не обязаны совпадать
        if not isinstance(u, dict) or not isinstance(c, dict) or u.get("isDelisted"):
            continue
        name = str(u.get("name") or "").split(":")[-1]
        if name and (p := pair(c.get("markPx"), c.get("prevDayPx"))):
            out[name] = p
    return out


def ecb_rates(raw: object) -> tuple[dict[str, float], dict[str, float]] | None:
    """Ответ Frankfurter (курсы ЕЦБ, база USD) → (последний рабочий день,
    предыдущий): {валюта: единиц за доллар}. Меньше двух полных дней — None."""
    rates = raw.get("rates") if isinstance(raw, dict) else None
    if not isinstance(rates, dict):
        return None
    full = []
    for day in sorted(d for d in rates if isinstance(d, str) and DATE.fullmatch(d)):
        r = rates[day]
        got = {c: _num(r.get(c)) if isinstance(r, dict) else 0.0 for c, _ in DXY_W}
        if all(0 < v < PX_MAX for v in got.values()):
            full.append(got)
    return (full[-1], full[-2]) if len(full) >= 2 else None


def dxy(r: dict[str, float]) -> float:
    """DXY по курсам {валюта: единиц за доллар}."""
    v = DXY_K
    for c, w in DXY_W:
        v *= (1 / r[c] if w < 0 else r[c]) ** w
    return v


def dvol(raw: object) -> Pair | None:
    """Ответ Deribit get_volatility_index_data (часовые свечи [время мс,
    открытие, максимум, минимум, закрытие]) → (сейчас, сутки назад)."""
    res = raw.get("result") if isinstance(raw, dict) else None
    data = res.get("data") if isinstance(res, dict) else None
    rows = sorted((int(_num(r[0])), _num(r[4])) for r in data if isinstance(r, list) and len(r) >= 5
                  and _num(r[0]) > 0 and _num(r[4]) > 0) if isinstance(data, list) else []
    if len(rows) < 2:
        return None
    back = [v for t, v in rows if t <= rows[-1][0] - DAY_MS]
    return pair(rows[-1][1], back[-1] if back else rows[0][1])


def dominance(mcap: object) -> dict[str, Pair]:
    """Ответ модуля доминации (wt_mcap) → BTC.D и USDT.D, (сейчас, вчера)."""
    out: dict[str, Pair] = {}
    if not isinstance(mcap, dict) or mcap.get("ok") is not True:
        return out
    btc, cap, usdt = mcap.get("btc"), mcap.get("cap"), _num(mcap.get("usdt"))
    if isinstance(btc, list) and len(btc) == 2 and (p := pair(btc[0], btc[1])) and p[0] <= 100 and p[1] <= 100:
        out["BTCD"] = p
    if isinstance(cap, list) and len(cap) == 2 and 0 < usdt <= 100:
        now_c, prev_c = _num(cap[0]), _num(cap[1])
        if now_c > 0 and prev_c > 0 and (p := pair(usdt, usdt * now_c / prev_c)) and p[1] <= 100:
            out["USDTD"] = p
    return out


def compute(parts: dict[str, object], at: int) -> dict[str, Json]:
    """Ответ по ответам источников: xyz, para, main (Hyperliquid), ecb, dvol, mcap."""
    xyz, para, main = (hl_markets(parts.get(k)) for k in ("xyz", "para", "main"))
    got: dict[str, Pair] = {}
    for key, (dex, name) in HL.items():
        if p := (xyz if dex == "xyz" else para).get(name):
            got[key] = p
    ecb = ecb_rates(parts.get("ecb"))
    if ecb and xyz.get("EUR") and xyz.get("JPY"):
        eur, jpy = xyz["EUR"], xyz["JPY"]
        p = pair(round(dxy({**ecb[0], "EUR": 1 / eur[0], "JPY": jpy[0]}), 3),
                 round(dxy({**ecb[1], "EUR": 1 / eur[1], "JPY": jpy[1]}), 3))
        if p:
            got["DXY"] = p
    if p := dvol(parts.get("dvol")):
        got["DVOL"] = p
    got.update(dominance(parts.get("mcap")))
    if main.get("ETH") and main.get("BTC"):
        e, b = main["ETH"], main["BTC"]
        if p := pair(round(e[0] / b[0], 8), round(e[1] / b[1], 8)):
            got["ETHBTC"] = p
    items = [{"k": k, "px": got[k][0], "prev": got[k][1]} for k in KEYS if k in got]
    return {"ok": True, "at": at, "items": items} if items else {"ok": False, "error": "no_data"}


# --- Сборка и кэш -------------------------------------------------------------

class _State:
    def __init__(self) -> None:
        self.sources: dict[str, Source] = {}
        self.hit: tuple[float, dict[str, Json]] | None = None
        self.job: threading.Thread | None = None
        self.fail = 0.0


_st = _State()
_lock = threading.Lock()


def set_sources(sources: dict[str, Source]) -> None:
    """Откуда брать ответы источников: имя (xyz, para, main, ecb, dvol, mcap) → fn()."""
    _st.sources = dict(sources)


def _now() -> int:
    return int(time.time())


def build() -> dict[str, Json]:
    """Опросить источники (параллельно, сбой одного — без него) и собрать ответ."""
    parts: dict[str, object] = {}

    def one(name: str, fn: Source) -> None:
        try:
            parts[name] = fn()
        except Exception:  # noqa: BLE001 — источник молчит: пункты без него
            parts[name] = None

    threads = [threading.Thread(target=one, args=item, daemon=True) for item in _st.sources.items()]
    for th in threads:
        th.start()
    for th in threads:
        th.join(30)
    res = compute(dict(parts), _now())
    with _lock:
        if res.get("ok"):
            _st.hit = (time.monotonic(), res)
        else:
            _st.fail = time.monotonic()
    return res


def _bg() -> None:
    try:
        build()
    finally:
        with _lock:
            _st.job = None


def _start() -> threading.Thread | None:
    """Фоновая сборка, если не идёт и не отдыхает после сбоя (звать под _lock)."""
    if _st.job is not None or time.monotonic() - _st.fail < FAIL_WAIT:
        return _st.job
    job = threading.Thread(target=_bg, daemon=True)
    try:
        job.start()
    except RuntimeError:
        return None
    _st.job = job
    return job


def markets_data(wait: float = COLD_WAIT) -> dict[str, Json]:
    """Ответ /api/markets: свежий — из кэша; постарше — тоже, а новый
    собирается в фоне; нет никакого — ждём сборку не дольше wait."""
    with _lock:
        hit = _st.hit
        if hit and time.monotonic() - hit[0] < TTL:
            return hit[1]
        job = _start()
        if hit:
            return hit[1]
    if job is not None:
        job.join(wait)
    with _lock:
        hit = _st.hit
    return hit[1] if hit else {"ok": False, "error": "no_data"}

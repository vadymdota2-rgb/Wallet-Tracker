"""Рынки для криптотрейдера — сверху бокового меню (/api/markets).

Девять чисел, на которые профессионал смотрит рядом с графиком биткоина,
сетка 3 × 3:

    S&P 500   XYZ100      DXY      — аппетит к риску и доллар;
    Золото    US 10Y      Нефть    — «убежище», ставки, инфляция;
    BTC.D     USDT.D      ETH/BTC  — куда течёт капитал внутри крипты.

По каждому пункту — цена сейчас и сутки назад; изменение считает
приложение (у доходности — в базисных пунктах).

Источники — те, что проект уже берёт; модуль сам в сеть не ходит: ответы
источников ему отдаёт сервер (set_sources), здесь — только разбор, расчёт
и кэш:
  - Hyperliquid, бессрочные рынки HIP-3: площадка trade.xyz («xyz») —
    S&P 500, XYZ100, золото, нефть WTI (CL), курсы EUR и JPY; площадка
    Paragon («para») — доходность 10Y; основная — BTC и ETH для ETH/BTC.
    Торгуются круглые сутки. Рынки, снятые с торгов, не берутся: их цена
    застыла (DXY и VIX на «xyz»);
  - DXY нигде не торгуется — считаем сами по открытой формуле ICE: EUR и
    JPY с Hyperliquid, GBP, CAD, SEK, CHF — курсы ЕЦБ (Европейского
    центрального банка) за последний рабочий день. EUR и JPY Hyperliquid
    сверяются с ЕЦБ: расходятся больше чем на EUR_JPY_GAP — DXY нет;
  - BTC.D и USDT.D — доли в капитализации рынка по CoinMarketCap (модуль
    доминации, wt_mcap: его данные и его условия — подпись источника со
    ссылкой рядом). У USDT.D CoinMarketCap не отдаёт вчерашнюю долю: сутки
    назад — та же капитализация USDT к вчерашней капитализации рынка
    (выпуск USDT за сутки меняется на доли процента, доля — от рынка).

Права — почему набор такой:
  - VIX нигде не торгуется (рынок на «xyz» снят), а индекс Cboe без
    лицензии показывать нельзя; DVOL Deribit — тоже нельзя: условия Deribit
    разрешают их рыночные и производные данные (индексы тоже) только для
    личного пользования, публиковать — по письменному разрешению. Вместо
    волатильности — нефть;
  - S&P 500 — рынок trade.xyz по лицензии S&P Dow Jones Indices; показываем
    цену контракта, а не значение индекса, с оговоркой о товарных знаках;
  - XYZ100 — собственный индекс trade.xyz (100 крупнейших нефинансовых
    компаний США), лицензии Nasdaq у него нет: имя «Nasdaq-100» ему не
    даём;
  - DXY — наш расчёт по открытой формуле из открытых курсов ЕЦБ (повторное
    использование — со ссылкой на источник), а не данные ICE; оговорка, что
    это не официальное значение, — рядом;
  - оговорки и источники видны и на телефоне (раскрываются в меню), а не
    только во всплывающей подсказке.

Проверки: цена конечная, больше нуля и правдоподобная; за сутки не
меняется больше чем вдвое (MOVE_MAX) — иначе сбой источника, пункта нет;
у DXY и доходности — свои рамки (RANGE).

Кэш: ответ живёт TTL; постарше — отдаётся сразу, а свежий собирается в фоне
одним потоком; ответа нет вовсе — запрос ждёт сборку не дольше COLD_WAIT.
Ответ старше STALE_MAX (источники долго молчат) не отдаётся: в меню —
прежний заголовок, а не вчерашние цены. Сбой одного источника не роняет
остальные: пункт без данных просто не показывается.
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
KEYS = ("SP500", "XYZ100", "DXY", "GOLD", "US10Y", "OIL", "BTCD", "USDTD", "ETHBTC")
# Рынки Hyperliquid: пункт → (площадка, имя рынка без приставки).
HL = {"SP500": ("xyz", "SP500"), "XYZ100": ("xyz", "XYZ100"), "GOLD": ("xyz", "GOLD"), "OIL": ("xyz", "CL"),
      "US10Y": ("para", "10Y")}
# DXY = 50,14348112 × ∏ курс^вес (ICE): EUR и GBP — в долларах за единицу
# (вес со знаком минус), остальные — единиц за доллар.
DXY_K = 50.14348112
DXY_W = (("EUR", -0.576), ("JPY", 0.136), ("GBP", -0.119), ("CAD", 0.091), ("SEK", 0.042), ("CHF", 0.036))
PX_MAX = 1e7  # правдоподобная цена пункта
MOVE_MAX = 2.0  # за сутки цена не меняется больше чем вдвое (в любую сторону)
# Свои рамки: DXY за полвека не выходил из 70…165, доходность 10Y — из 0…16 %.
RANGE = {"DXY": (50.0, 250.0), "US10Y": (0.01, 30.0), "BTCD": (0.01, 100.0), "USDTD": (0.01, 100.0)}
EUR_JPY_GAP = 0.03  # EUR и JPY Hyperliquid против ЕЦБ: расхождение больше — DXY нет
TTL = 60.0
STALE_MAX = 1800.0  # старше — не отдаётся
COLD_WAIT = 6.0
FAIL_WAIT = 30.0  # сборка ничего не дала — следующая не раньше
SOURCE_WAIT = 30.0  # все источники вместе ждём не дольше
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


def dominance(mcap: object) -> dict[str, Pair]:
    """Ответ модуля доминации (wt_mcap) → BTC.D и USDT.D, (сейчас, вчера)."""
    out: dict[str, Pair] = {}
    if not isinstance(mcap, dict) or mcap.get("ok") is not True:
        return out
    btc, cap, usdt = mcap.get("btc"), mcap.get("cap"), _num(mcap.get("usdt"))
    if isinstance(btc, list) and len(btc) == 2 and (p := pair(btc[0], btc[1])):
        out["BTCD"] = p
    if isinstance(cap, list) and len(cap) == 2 and usdt > 0:
        now_c, prev_c = _num(cap[0]), _num(cap[1])
        if now_c > 0 and prev_c > 0 and (p := pair(usdt, usdt * now_c / prev_c)):
            out["USDTD"] = p
    return out


def sane(key: str, p: Pair) -> bool:
    """Пункт правдоподобен: в своих рамках и за сутки не больше MOVE_MAX раз."""
    lo, hi = RANGE.get(key, (0.0, PX_MAX))
    a, b = p
    return lo <= a <= hi and lo <= b <= hi and max(a, b) <= MOVE_MAX * min(a, b)


def _near(a: float, b: float) -> bool:
    return abs(a / b - 1) <= EUR_JPY_GAP


def compute(parts: dict[str, object], at: int) -> dict[str, Json]:
    """Ответ по ответам источников: xyz, para, main (Hyperliquid), ecb, mcap."""
    xyz, para, main = (hl_markets(parts.get(k)) for k in ("xyz", "para", "main"))
    got: dict[str, Pair] = {}
    for key, (dex, name) in HL.items():
        if p := (xyz if dex == "xyz" else para).get(name):
            got[key] = p
    ecb = ecb_rates(parts.get("ecb"))
    eur, jpy = xyz.get("EUR"), xyz.get("JPY")
    # EUR на Hyperliquid — долларов за евро, у ЕЦБ (база USD) — евро за доллар.
    if ecb and eur and jpy and _near(1 / eur[0], ecb[0]["EUR"]) and _near(jpy[0], ecb[0]["JPY"]):
        p = pair(round(dxy({**ecb[0], "EUR": 1 / eur[0], "JPY": jpy[0]}), 3),
                 round(dxy({**ecb[1], "EUR": 1 / eur[1], "JPY": jpy[1]}), 3))
        if p:
            got["DXY"] = p
    got.update(dominance(parts.get("mcap")))
    if main.get("ETH") and main.get("BTC"):
        e, b = main["ETH"], main["BTC"]
        if p := pair(round(e[0] / b[0], 8), round(e[1] / b[1], 8)):
            got["ETHBTC"] = p
    items = [{"k": k, "px": got[k][0], "prev": got[k][1]} for k in KEYS if k in got and sane(k, got[k])]
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
    """Откуда брать ответы источников: имя (xyz, para, main, ecb, mcap) → fn()."""
    _st.sources = dict(sources)


def _now() -> int:
    return int(time.time())


def build() -> dict[str, Json]:
    """Опросить источники (параллельно, сбой одного — без него) и собрать ответ."""
    parts: dict[str, object] = {}
    got = threading.Lock()

    def one(name: str, fn: Source) -> None:
        try:
            v = fn()
        except Exception:  # noqa: BLE001 — источник молчит: пункты без него
            v = None
        with got:
            parts[name] = v

    threads = [threading.Thread(target=one, args=item, daemon=True) for item in _st.sources.items()]
    for th in threads:
        th.start()
    end = time.monotonic() + SOURCE_WAIT
    for th in threads:
        th.join(max(0.0, end - time.monotonic()))
    with got:  # опоздавший источник — уже без него
        now_parts = dict(parts)
    res = compute(now_parts, _now())
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


def _live(hit: tuple[float, dict[str, Json]] | None) -> tuple[float, dict[str, Json]] | None:
    """Ответ из кэша, если не старше STALE_MAX."""
    return hit if hit and time.monotonic() - hit[0] < STALE_MAX else None


def markets_data(wait: float = COLD_WAIT) -> dict[str, Json]:
    """Ответ /api/markets: свежий — из кэша; постарше — тоже, а новый
    собирается в фоне; нет никакого (или он старше STALE_MAX) — ждём сборку
    не дольше wait."""
    with _lock:
        hit = _live(_st.hit)
        if hit and time.monotonic() - hit[0] < TTL:
            return hit[1]
        job = _start()
        if hit:
            return hit[1]
    if job is not None:
        job.join(wait)
    with _lock:
        hit = _live(_st.hit)
    return hit[1] if hit else {"ok": False, "error": "no_data"}

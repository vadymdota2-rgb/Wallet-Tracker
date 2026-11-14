"""Скринер монет по техническому рейтингу (/api/screener) — снизу графика.

Список крупнейших монет Binance с рейтингом индикаторов на четырёх
таймфреймах (15 минут, час, 4 часа, день): фильтром находят, например,
монеты, где на 15 минутах индикаторы «за покупку», а на часе — «за продажу».
Рейтинг — тот же, что у графика приложения (techRating в
src/chart/indicators.ts, как «Technical Ratings» TradingView): 15
скользящих и 11 осцилляторов голосуют −1/0/+1, итог — среднее двух групп
от −1 до +1. Расчёт перенесён сюда один в один; что сервер и приложение
считают одинаково, проверяет тест-договор (test_screen_contract.py).

Это рейтинг индикаторов, а не совет: подпись на экране так и говорит.

Источник — Binance spot через публичное зеркало data-api.binance.vision (то
же, откуда график приложения берёт свечи): Hyperliquid скринер не трогает
вовсе — его бюджет запросов общий для сервера. Сам модуль в сеть не ходит:
ответы источников отдаёт сервер (set_sources).

Нагрузка (как у карточки халвинга: все видят кэш):
  - монеты — топ TOP по обороту за сутки, список обновляется раз в
    UNIVERSE_EVERY (один запрос ticker/24hr, вес 80);
  - свечи — BARS последних на монету (вес 2 за запрос), таймфрейм
    пересчитывается раз в EVERY[tf]: 15 минут — раз в 5 минут, час — раз в
    15, 4 часа — раз в 30, день — раз в час. В среднем ~25 запросов (~50
    единиц веса) в минуту на весь сервер при пределе Binance 6000 — меньше
    1 %; от числа людей не зависит;
  - сборка — одним фоновым потоком из cache_refresher; запрос человека —
    screener_data() — только читает готовый ответ;
  - те же цифры — тот же объект (сервер отдаёт те же байты и «304»).

Рейтинг таймфрейма старше STALE_X его интервалов (Binance долго молчит) не
отдаётся; монета без единого рейтинга — тоже. Сбой одной монеты не роняет
остальные.
"""
from __future__ import annotations

import contextlib
import math
import sys
import threading
import time
from collections.abc import Callable
from typing import Any

Json = Any
Bar = tuple[float, float, float, float, float, float]  # время (мс), открытие, максимум, минимум, закрытие, объём

TFS = ("15m", "1h", "4h", "1d")
EVERY = {"15m": 300.0, "1h": 900.0, "4h": 1800.0, "1d": 3600.0}
STALE_X = 3  # рейтинг старше стольких интервалов пересчёта — не отдаётся
TOP = 80
BARS = 600  # столько свечей берёт рейтинг графика (bars.slice(-600))
MIN_BARS = 60  # меньше — рейтинга нет (как у графика)
UNIVERSE_EVERY = 3600.0
FAIL_WAIT = 60.0  # список монет не получен — снова не раньше
PX_MAX = 1e9
VOL_MIN = 1e6  # оборот за сутки, $: меньше — не берём (мёртвые пары)
RESP_MAX = 4 << 20  # байт ответа источника (ticker/24hr — ~1 МБ)
# Стейблкоины, фиатные и обёрнутые монеты: рейтинг у них бессмыслен.
SKIP = frozenset({
    "USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "AEUR", "EUR", "EURI", "USD1", "XUSD", "BFUSD", "RLUSD", "USDE",
    "PYUSD", "USDS", "GBP", "TRY", "BRL", "WBTC", "WBETH", "BNSOL", "PAXG", "USTC", "U", "USDT",
})
LOG_MAX = 300

Source = Callable[..., object]


def _num(v: object) -> float:
    """Число из ответа источника (строка или число); иначе — NaN."""
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        return math.nan
    try:
        f = float(v)
    except (ValueError, OverflowError):
        return math.nan
    return f if math.isfinite(f) else math.nan


# --- Свечи и список монет ------------------------------------------------------

def parse_bars(raw: object) -> list[Bar]:
    """Свечи Binance (klines) → [(время, o, h, l, c, v)] по возрастанию
    времени, не больше BARS; кривая свеча — мимо."""
    out: list[Bar] = []
    for r in raw[-BARS:] if isinstance(raw, list) else ():
        if not isinstance(r, list) or len(r) < 6:
            continue
        t, o, h, lo, c, v = (_num(x) for x in r[:6])
        if not (t > 0 and 0 < lo <= min(o, c) and max(o, c) <= h < PX_MAX and v >= 0):
            continue
        if out and t <= out[-1][0]:
            continue
        out.append((t, o, h, lo, c, v))
    return out


def parse_universe(raw: object) -> list[tuple[str, float]]:
    """Ответ ticker/24hr → [(монета, оборот $)]: пары к USDT, без
    стейблкоинов и обёрнутых, оборот не меньше VOL_MIN; топ TOP по обороту."""
    got: dict[str, float] = {}
    for r in raw if isinstance(raw, list) else ():
        if not isinstance(r, dict):
            continue
        sym = r.get("symbol")
        if not isinstance(sym, str) or not sym.endswith("USDT") or len(sym) > 20:
            continue
        base = sym[:-4]
        if not base.isascii() or not base.isalnum() or not base.isupper() or base in SKIP:
            continue
        if base.endswith(("UP", "DOWN", "BULL", "BEAR")) and len(base) > 4:
            continue
        vol = _num(r.get("quoteVolume"))
        if vol >= VOL_MIN and base not in got:
            got[base] = vol
    return sorted(got.items(), key=lambda x: -x[1])[:TOP]


# --- Технический рейтинг (как techRating в src/chart/indicators.ts) ------------
# Ряды — списки float, «нет значения» — NaN, как Float64Array с NaN у графика.
# Деление и max/min — как в JavaScript (на ноль — бесконечность, NaN заразен).

NAN = math.nan
Ser = list[float]


def _isnan(v: float) -> bool:
    return math.isnan(v)


def _div(a: float, b: float) -> float:
    """a / b как в JavaScript."""
    if b == 0:
        if a == 0 or _isnan(a):
            return NAN
        return math.copysign(math.inf, a) * (math.copysign(1.0, b))
    return a / b


def _jmax(a: float, b: float) -> float:
    return NAN if _isnan(a) or _isnan(b) else max(a, b)


def _jmin(a: float, b: float) -> float:
    return NAN if _isnan(a) or _isnan(b) else min(a, b)


def _truthy(v: float) -> bool:
    return not _isnan(v) and v != 0


def _jround(v: float) -> int:
    """Math.round JavaScript: половина — вверх."""
    return math.floor(v + 0.5)


def _at(s: Ser, i: int) -> float:
    return s[i] if 0 <= i < len(s) else NAN


def sma(src: Ser, ln: int) -> Ser:
    out = [NAN] * len(src)
    total = 0.0
    cnt = 0
    for i, v in enumerate(src):
        if _isnan(v):
            total = 0.0
            cnt = 0
            continue
        total += v
        cnt += 1
        if cnt > ln:
            total -= _at(src, i - ln)
            cnt = ln
        if cnt == ln:
            out[i] = total / ln
    return out


def ema(src: Ser, ln: int) -> Ser:
    out = [NAN] * len(src)
    k = 2 / (ln + 1)
    prev = NAN
    seed = 0.0
    cnt = 0
    for i, v in enumerate(src):
        if _isnan(v):
            continue
        if _isnan(prev):
            seed += v
            cnt += 1
            if cnt == ln:
                prev = seed / ln
                out[i] = prev
            continue
        prev = v * k + prev * (1 - k)
        out[i] = prev
    return out


def rma(src: Ser, ln: int) -> Ser:
    out = [NAN] * len(src)
    prev = NAN
    seed = 0.0
    cnt = 0
    for i, v in enumerate(src):
        if _isnan(v):
            continue
        if _isnan(prev):
            seed += v
            cnt += 1
            if cnt == ln:
                prev = seed / ln
                out[i] = prev
            continue
        prev = (prev * (ln - 1) + v) / ln
        out[i] = prev
    return out


def wma(src: Ser, ln: int) -> Ser:
    out = [NAN] * len(src)
    den = (ln * (ln + 1)) / 2
    for i in range(ln - 1, len(src)):
        s = 0.0
        bad = False
        for j in range(ln):
            v = _at(src, i - j)
            if _isnan(v):
                bad = True
                break
            s += v * (ln - j)
        if not bad:
            out[i] = s / den
    return out


def _highest(src: Ser, ln: int) -> Ser:
    out = [NAN] * len(src)
    for i in range(ln - 1, len(src)):
        m = -math.inf
        for j in range(ln):
            m = _jmax(m, _at(src, i - j))
        out[i] = m
    return out


def _lowest(src: Ser, ln: int) -> Ser:
    out = [NAN] * len(src)
    for i in range(ln - 1, len(src)):
        m = math.inf
        for j in range(ln):
            m = _jmin(m, _at(src, i - j))
        out[i] = m
    return out


def _true_range(bars: list[Bar]) -> Ser:
    out = [0.0] * len(bars)
    for i, b in enumerate(bars):
        if i == 0:
            out[i] = b[2] - b[3]
        else:
            pc = bars[i - 1][4]
            out[i] = max(b[2] - b[3], abs(b[2] - pc), abs(b[3] - pc))
    return out


def _sum_n(src: Ser, ln: int) -> Ser:
    out = [NAN] * len(src)
    total = 0.0
    for i in range(len(src)):
        v = _at(src, i)
        total += v if _truthy(v) else 0.0
        if i >= ln:
            w = _at(src, i - ln)
            total -= w if _truthy(w) else 0.0
        if i >= ln - 1:
            out[i] = total
    return out


def _rsi(src: Ser, ln: int) -> Ser:
    up = [NAN] * len(src)
    dn = [NAN] * len(src)
    for i in range(1, len(src)):
        d = _at(src, i) - _at(src, i - 1)
        if _isnan(d):
            continue
        up[i] = max(d, 0.0)
        dn[i] = max(-d, 0.0)
    au = rma(up, ln)
    ad = rma(dn, ln)
    out = [NAN] * len(src)
    for i, u in enumerate(au):
        d = ad[i]
        if _isnan(u) or _isnan(d):
            continue
        out[i] = 100.0 if d == 0 else 0.0 if u == 0 else 100 - _div(100, 1 + _div(u, d))
    return out


def _stoch_of(src: Ser, hi: Ser, lo: Ser, ln: int) -> Ser:
    hh = _highest(hi, ln)
    ll = _lowest(lo, ln)
    out = [NAN] * len(src)
    for i, v in enumerate(src):
        h, lw = hh[i], ll[i]
        out[i] = 50.0 if h - lw == 0 else _div(100 * (v - lw), h - lw)
    return out


def _col(bars: list[Bar], k: int) -> Ser:
    return [b[k] for b in bars]


def hma(src: Ser, ln: int) -> Ser:
    half = wma(src, max(1, _jround(ln / 2)))
    full = wma(src, ln)
    return wma([2 * v - _at(full, i) for i, v in enumerate(half)], max(1, _jround(math.sqrt(ln))))


def vwma(bars: list[Bar], ln: int) -> Ser:
    pv = _sum_n([b[4] * b[5] for b in bars], ln)
    v = _sum_n(_col(bars, 5), ln)
    return [_div(x, v[i]) if _truthy(v[i]) else NAN for i, x in enumerate(pv)]


def _kijun(bars: list[Bar], ln: int) -> Ser:
    h = _highest(_col(bars, 2), ln)
    lw = _lowest(_col(bars, 3), ln)
    return [(x + lw[i]) / 2 for i, x in enumerate(h)]


def _cci(bars: list[Bar], ln: int) -> Ser:
    tp = [(b[2] + b[3] + b[4]) / 3 for b in bars]
    m = sma(tp, ln)
    out = [NAN] * len(bars)
    for i in range(ln - 1, len(bars)):
        mv = m[i]
        dev = 0.0
        for j in range(ln):
            dev += abs(_at(tp, i - j) - mv)
        dev /= ln
        out[i] = 0.0 if dev == 0 else _div(tp[i] - mv, 0.015 * dev)
    return out


def _adx(bars: list[Bar], ln: int) -> tuple[Ser, Ser, Ser]:
    n = len(bars)
    pdm = [NAN] * n
    ndm = [NAN] * n
    for i in range(1, n):
        u = bars[i][2] - bars[i - 1][2]
        d = bars[i - 1][3] - bars[i][3]
        pdm[i] = u if u > d and u > 0 else 0.0
        ndm[i] = d if d > u and d > 0 else 0.0
    tr = rma(_true_range(bars), ln)
    pdi = [_div(100 * v, _at(tr, i)) for i, v in enumerate(rma(pdm, ln))]
    ndi = [_div(100 * v, _at(tr, i)) for i, v in enumerate(rma(ndm, ln))]
    dx = []
    for i, v in enumerate(pdi):
        s = v + ndi[i]
        dx.append(0.0 if s == 0 else _div(100 * abs(v - ndi[i]), s))
    return rma(dx, ln), pdi, ndi


def _ao(bars: list[Bar]) -> Ser:
    m = [(b[2] + b[3]) / 2 for b in bars]
    a = sma(m, 5)
    b = sma(m, 34)
    return [v - b[i] for i, v in enumerate(a)]


def _uo(bars: list[Bar], a: int, b: int, c: int) -> Ser:
    bp = [0.0] * len(bars)
    tr = [0.0] * len(bars)
    for i, x in enumerate(bars):
        pc = bars[i - 1][4] if i > 0 else x[4]
        bp[i] = x[4] - min(x[3], pc)
        tr[i] = max(x[2], pc) - min(x[3], pc)

    def avg(ln: int) -> Ser:
        sb = _sum_n(bp, ln)
        st = _sum_n(tr, ln)
        return [_div(v, st[i]) if _truthy(st[i]) else NAN for i, v in enumerate(sb)]

    av, bv, cv = avg(a), avg(b), avg(c)
    return [_div(100 * (4 * v + 2 * bv[i] + cv[i]), 7) for i, v in enumerate(av)]


def rating(all_bars: list[Bar]) -> tuple[float, float, float] | None:
    """Технический рейтинг последней свечи: (итог, скользящие, осцилляторы),
    каждое от −1 до +1; свечей меньше MIN_BARS — None."""
    bars = all_bars[-BARS:]
    n = len(bars)
    if n < MIN_BARS:
        return None
    c = _col(bars, 4)
    last = n - 1
    px = bars[last][4]

    def lv(s: Ser, k: int = 0) -> float:
        return _at(s, last - k)

    ma_votes: list[int] = []

    def add_ma(v: float) -> None:
        if math.isfinite(v):
            ma_votes.append(1 if v < px else -1 if v > px else 0)

    for ln in (10, 20, 30, 50, 100, 200):
        if n > ln:
            add_ma(lv(ema(c, ln)))
            add_ma(lv(sma(c, ln)))
    add_ma(lv(_kijun(bars, 26)))
    add_ma(lv(vwma(bars, 20)))
    add_ma(lv(hma(c, 9)))

    osc = _osc_votes(bars, c)
    ma = sum(ma_votes) / len(ma_votes) if ma_votes else 0.0
    os_ = sum(osc) / len(osc) if osc else 0.0
    return (ma + os_) / 2, ma, os_


def _osc_votes(bars: list[Bar], c: Ser) -> list[int]:
    """Голоса 11 осцилляторов последней свечи (как у techRating)."""
    last = len(bars) - 1

    def lv(s: Ser, k: int = 0) -> float:
        return _at(s, last - k)

    osc: list[int] = []

    def add(value: float, vote: int) -> None:
        if math.isfinite(value):
            osc.append(vote)

    r = _rsi(c, 14)
    add(lv(r), 1 if lv(r) < 30 and lv(r) > lv(r, 1) else -1 if lv(r) > 70 and lv(r) < lv(r, 1) else 0)
    k = sma(_stoch_of(c, _col(bars, 2), _col(bars, 3), 14), 3)
    d = sma(k, 3)
    add(lv(k), 1 if lv(k) < 20 and lv(k) > lv(d) else -1 if lv(k) > 80 and lv(k) < lv(d) else 0)
    cci = _cci(bars, 20)
    add(lv(cci), 1 if lv(cci) < -100 and lv(cci) > lv(cci, 1) else -1 if lv(cci) > 100 and lv(cci) < lv(cci, 1) else 0)
    adx, pdi, ndi = _adx(bars, 14)
    add(lv(adx), 1 if lv(adx) > 20 and lv(pdi) > lv(ndi) and lv(adx) > lv(adx, 1)
        else -1 if lv(adx) > 20 and lv(pdi) < lv(ndi) and lv(adx) > lv(adx, 1) else 0)
    ao = _ao(bars)
    add(lv(ao), 1 if lv(ao) > 0 and lv(ao) > lv(ao, 1) else -1 if lv(ao) < 0 and lv(ao) < lv(ao, 1) else 0)
    mom = [v - c[i - 10] if i >= 10 else NAN for i, v in enumerate(c)]
    add(lv(mom), 1 if lv(mom) > lv(mom, 1) else -1 if lv(mom) < lv(mom, 1) else 0)
    ef, es = ema(c, 12), ema(c, 26)
    macd = [v - es[i] for i, v in enumerate(ef)]
    sig = ema(macd, 9)
    add(lv(macd), 1 if lv(macd) > lv(sig) else -1 if lv(macd) < lv(sig) else 0)
    rs = _rsi(c, 14)
    sk = sma(_stoch_of(rs, rs, rs, 14), 3)
    sd = sma(sk, 3)
    add(lv(sk), 1 if lv(sk) < 20 and lv(sk) > lv(sd) else -1 if lv(sk) > 80 and lv(sk) < lv(sd) else 0)
    hh = _highest(_col(bars, 2), 14)
    ll = _lowest(_col(bars, 3), 14)
    wr = [-50.0 if hh[i] - ll[i] == 0 else _div(-100 * (hh[i] - x), hh[i] - ll[i]) for i, x in enumerate(c)]
    add(lv(wr), 1 if lv(wr) < -80 and lv(wr) > lv(wr, 1) else -1 if lv(wr) > -20 and lv(wr) < lv(wr, 1) else 0)
    e13 = ema(c, 13)
    bbp = [b[2] - e13[i] + (b[3] - e13[i]) for i, b in enumerate(bars)]
    add(lv(bbp), 1 if lv(bbp) > 0 and lv(bbp) > lv(bbp, 1) else -1 if lv(bbp) < 0 and lv(bbp) < lv(bbp, 1) else 0)
    uo = _uo(bars, 7, 14, 28)
    add(lv(uo), 1 if lv(uo) > 70 else -1 if lv(uo) < 30 else 0)
    return osc


# --- Ответ ----------------------------------------------------------------------

def change_24h(bars: list[Bar]) -> float | None:
    """Изменение за сутки, % — по 15-минутным свечам (96 назад)."""
    if len(bars) < 97:
        return None
    a, b = bars[-97][4], bars[-1][4]
    return round((b / a - 1) * 100, 2) if a > 0 else None


def reply(universe: list[tuple[str, float]], rates: dict[str, dict[str, tuple[float, int]]],
          px: dict[str, tuple[float, float | None]], now: int) -> dict[str, Json]:
    """Ответ /api/screener: монеты в порядке оборота, рейтинг по таймфреймам
    (старше STALE_X интервалов — None); монета без рейтингов — мимо."""
    rows = []
    for base, vol in universe:
        r: dict[str, float | None] = {}
        for tf in TFS:
            got = rates.get(tf, {}).get(base)
            r[tf] = round(got[0], 3) if got and now - got[1] <= STALE_X * EVERY[tf] else None
        if all(v is None for v in r.values()):
            continue
        p, ch = px.get(base, (0.0, None))
        rows.append({"s": base, "px": p if p > 0 else None, "ch": ch, "vol": round(vol), "r": r})
    if not rows:
        return {"ok": False, "error": "no_data"}
    return {"ok": True, "at": now, "tfs": list(TFS), "by": "Binance", "rows": rows}


# --- Сборка и кэш ---------------------------------------------------------------

class _State:
    def __init__(self) -> None:
        self.universe: list[tuple[str, float]] = []
        self.uni_at = -math.inf  # монотонные часы
        self.uni_fail = -math.inf
        self.done: dict[str, float] = {}  # таймфрейм → когда пересчитан (монотонные часы)
        self.rates: dict[str, dict[str, tuple[float, int]]] = {}
        self.px: dict[str, tuple[float, float | None]] = {}
        self.hit: dict[str, Json] | None = None
        self.job: threading.Thread | None = None
        self.down = False


_st = _State()
_lock = threading.Lock()
_src: dict[str, Source] = {}


def set_sources(universe: Source, klines: Source) -> None:
    """universe() → ответ ticker/24hr; klines(монета, таймфрейм) → свечи."""
    _src["universe"] = universe
    _src["klines"] = klines


def _now() -> int:
    return int(time.time())


def _log(msg: str) -> None:
    clean = "".join(ch if ch.isprintable() else "?" for ch in msg)
    out = sys.stderr
    if out is None:
        return
    with contextlib.suppress(OSError, ValueError):
        print(f"screener: {clean[:LOG_MAX]}", file=out)


def _due(t0: float) -> tuple[bool, list[str]]:
    """Нужен ли новый список монет и какие таймфреймы пора пересчитать."""
    with _lock:
        uni = (not _st.universe or t0 - _st.uni_at >= UNIVERSE_EVERY) and t0 - _st.uni_fail >= FAIL_WAIT
        tfs = [tf for tf in TFS if t0 - _st.done.get(tf, -math.inf) >= EVERY[tf]]
    return uni, tfs


def _ask(name: str, *args: object) -> object:
    fn = _src.get(name)
    if fn is None:
        return None
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001 — источник молчит: без него
        _log(f"источник {name} не ответил ({type(e).__name__})")
        return None


def build() -> dict[str, Json]:
    """Пересчитать то, что пора, и положить ответ в кэш (зовёт только фоновый
    поток сервера)."""
    t0 = time.monotonic()
    uni_due, tfs = _due(t0)
    if uni_due:
        got = parse_universe(_ask("universe"))
        with _lock:
            if got:
                _st.universe, _st.uni_at = got, t0
            else:
                _st.uni_fail = t0
    with _lock:
        coins = [b for b, _ in _st.universe]
    for tf in tfs:
        ok = 0
        for base in coins:
            bars = parse_bars(_ask("klines", base, tf))
            r = rating(bars)
            if r is None:
                continue
            ok += 1
            with _lock:
                _st.rates.setdefault(tf, {})[base] = (r[0], _now())
                if tf == "15m":
                    _st.px[base] = (bars[-1][4], change_24h(bars))
        with _lock:
            _st.done[tf] = t0
            # Монеты, выпавшие из списка, — из памяти прочь.
            keep = set(coins)
            for d in (_st.rates.get(tf, {}), _st.px if tf == "15m" else {}):
                for k in [k for k in d if k not in keep]:
                    del d[k]
        if coins and not ok:
            _log(f"{tf}: ни одной монеты")
    with _lock:
        res = reply(_st.universe, _st.rates, _st.px, _now())
        if _st.hit is not None and res == _st.hit:
            res = _st.hit  # те же цифры — тот же объект (те же байты и ETag)
        _st.hit = res
        return res


def _bg() -> None:
    try:
        build()
    finally:
        with _lock:
            _st.job = None


def refresh() -> dict[str, Json]:
    """Обновить кэш — зовёт только сервер (cache_refresher раз в минуту и
    запуск): сборка в фоне, если не идёт и есть что пересчитать."""
    uni, tfs = _due(time.monotonic())
    with _lock:
        if _st.job is None and (uni or tfs):
            job = threading.Thread(target=_bg, daemon=True)
            try:
                job.start()
                _st.job = job
            except RuntimeError:
                pass
    return screener_data()


def screener_data() -> dict[str, Json]:
    """Ответ /api/screener — только из кэша: запрос человека сборку не
    начинает и к источникам не ходит. Рейтинги старше STALE_X интервалов
    отбрасываются при чтении тоже."""
    with _lock:
        hit = _st.hit
        if hit is None or not hit.get("ok"):
            return {"ok": False, "error": "no_data"}
        if _now() - int(hit["at"]) > STALE_X * EVERY["1d"]:
            return {"ok": False, "error": "no_data"}
        return hit

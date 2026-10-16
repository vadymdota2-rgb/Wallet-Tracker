"""Институциональные потоки — отдельный модуль API (/api/etf).

Что собирается — только биткоин, только официальное и своё:
  - фонды — спотовые биткоин-ETF США по их отчётам в SEC (wt_treasury):
    запас на конец каждого квартала, комиссия. Поток фонда за квартал —
    изменение запаса плюс комиссия, взятая монетами; в долларах — по средней
    цене квартала. Где фонд пишет в отчёте только стоимость монет, монеты —
    стоимость по цене, которую дают отчёты фондов с числом монет на ту же
    дату (их медиана; нет — закрытие Binance);
  - по дням — только своя цепочка (set_chain): фонды, чьи кошельки знает
    сканер бота (BITB — все, опубликованы им самим; у остальных — разметка:
    свой список и /import владельца, часто не все кошельки — тогда фонд
    помечен part), поток торгового дня — монеты, дошедшие до цепочки на
    следующий рабочий день. Остальных фондов в днях нет;
  - запас фонда — отчёт плюс то, что после него прошло через его
    размеченные кошельки (BITB — точно по всем кошелькам); у фонда без
    разметки — на дату отчёта;
  - цена — закрытие Binance; доля фондов от добытых монет — своим счётом
    по расписанию эмиссии (supply_at);
  - крупнейшие держатели — фонды отсюда же и публичные компании по их
    отчётам в SEC (wt_treasury);
  - позиции на CME — еженедельный отчёт CFTC «Traders in Financial Futures»;
  - премия Coinbase к Binance — спрос американских покупателей.

Ответ живёт час (TTL): устаревший отдаётся сразу, свежий собирается в фоне
одним потоком. Часть, которая в этот раз не собралась (потоки,
CME), берётся из прошлой сборки, а не пропадает с экрана.

Безопасность — как у модуля халвинга (wt_halving.py): запросы только по
https и только к известным адресам (HOSTS), без перенаправлений и прокси из
окружения, ответ ограничен по размеру, JSON — без NaN и бесконечностей.
Снаружи модуль ничего не принимает: у /api/etf нет параметров.

Модуль ни от чего в whale_api не зависит: сеть — через _fetch (тесты
подменяют только её), часы — через _now.
"""
from __future__ import annotations

import calendar
import contextlib
import http.client
import json
import math
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any

import wt_treasury
from wt_etfchain import settle_day

# Сколько ответ живёт в кэше, с: фонды отчитываются раз в сутки.
TTL = 3600.0
# Только биткоин: потоки других монет своими данными не проверить — их на
# экране нет. Монета → пара Binance для цены дня.
COINS = (("btc", "BTCUSDT"),)
# Позиции на CME: код контракта CFTC → размер контракта в монетах (большой
# и микро складываются в монетах: у них разный размер).
CME_CODES = {
    "btc": (("133741", 5.0), ("133742", 0.1)),
}
CME_FIELDS = ("open_interest_all", "asset_mgr_positions_long", "asset_mgr_positions_short",
              "lev_money_positions_long", "lev_money_positions_short",
              "dealer_positions_long_all", "dealer_positions_short_all",
              "nonrept_positions_long_all", "nonrept_positions_short_all")

# Куда модулю можно ходить — и больше никуда.
HOSTS = frozenset({"data-api.binance.vision", "publicreporting.cftc.gov", "api.exchange.coinbase.com"})
# Самый большой ответ — отчёт CFTC, ~2 МБ.
BODY_MAX = 8 << 20
_HEADERS = {"User-Agent": "wallet-tracker/1.0", "Accept-Encoding": "identity"}

Json = Any  # разобранный JSON источника: проверяется на месте, где читается


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Перенаправление не выполняется: 3xx — это ошибка, а не новый адрес."""

    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


# Напрямую (прокси из окружения не берётся), без перенаправлений, сертификат
# проверяется — как у wt_halving.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect, urllib.request.HTTPSHandler())


def _allowed(url: str) -> bool:
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    return u.scheme == "https" and u.hostname in HOSTS and not u.username and not u.password


def _now() -> int:
    return int(time.time())


def _log(msg: str) -> None:
    clean = "".join(c if c.isprintable() else "?" for c in msg)
    with contextlib.suppress(OSError, ValueError):  # журнал закрыт — работа важнее записи
        print(f"etf: {clean[:300]}", file=sys.stderr)


def _fetch(url: str, timeout: float, data: bytes | None = None) -> bytes | None:
    """GET (или POST с data). Любая ошибка сети и ответ больше BODY_MAX — None."""
    if not _allowed(url):
        return None
    headers = dict(_HEADERS, **({"Content-Type": "application/json"} if data is not None else {}))
    try:
        with _opener.open(urllib.request.Request(url, data=data, headers=headers), timeout=timeout) as r:
            body: bytes = r.read(BODY_MAX + 1)
    except (OSError, ValueError, http.client.HTTPException):
        return None
    return body if len(body) <= BODY_MAX else None


def _no_constant(name: str) -> float:
    raise ValueError(f"{name} в JSON")


def _finite(text: str) -> float:
    v = float(text)
    if not math.isfinite(v):
        raise ValueError("не конечное число")
    return v


_DECODER = json.JSONDecoder(parse_float=_finite, parse_constant=_no_constant)


def _parse(raw: bytes | None) -> Json:
    if not raw:
        return None
    try:
        return _DECODER.decode(raw.decode())
    except (ValueError, RecursionError):
        return None


def _get(url: str, timeout: float = 20) -> Json:
    return _parse(_fetch(url, timeout))


def _num(v: object) -> float:
    """Число из JSON источника; 0.0 — не число (строки-числа источник шлёт)."""
    if isinstance(v, bool):
        return 0.0
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    return f if math.isfinite(f) else 0.0


def _day(stamp: object) -> int:
    """Начало суток UTC из даты CFTC «2026-09-29T00:00:00.000»; не дата — ValueError."""
    if not isinstance(stamp, str):
        raise ValueError("не дата")
    return calendar.timegm(time.strptime(stamp[:10], "%Y-%m-%d"))


def _klines(symbol: str, start_ms: int) -> dict[int, float]:
    """Закрытие дня на Binance: начало суток (с) → цена."""
    out: dict[int, float] = {}
    cur = start_ms
    for _ in range(6):
        rows = _get(f"https://data-api.binance.vision/api/v3/klines?symbol={symbol}&interval=1d&limit=1000&startTime={cur}")
        if not isinstance(rows, list) or not rows:
            break
        for k in rows:
            if isinstance(k, list) and len(k) > 4:
                out[int(_num(k[0])) // 1000] = _num(k[4])
        if len(rows) < 1000:
            break
        cur = int(_num(rows[-1][0])) + 86_400_000
    return out


Day = tuple[dict[str, dict[str, Json]], float, float]  # фонды, итог $, итог монет


def _after(last: int, today: int) -> list[int]:
    """Рабочие дни после дня last, чьи деньги уже дошли до цепочки."""
    out = []
    t = last + 86400
    while settle_day(t // 86400) * 86400 < today:
        if time.gmtime(t).tm_wday < 5:
            out.append(t)
        t += 86400
    return out


# Сколько биткоинов добыто к блоку 840 000 (четвёртый халвинг, 20 апреля 2024,
# 00:09:27 UTC) и награда за блок после него — эпоха до блока 1 050 000.
SUPPLY_840K = 19_687_500.0
TS_840K = 1_713_571_767
REWARD_840K = 3.125


def supply_at(ts: int) -> float:
    """Биткоинов в обращении на момент ts — по расписанию добычи, блок раз в
    десять минут в среднем. Ошибка — тысячи монет из двадцати миллионов."""
    blocks = max(0, (ts - TS_840K) // 600)
    return SUPPLY_840K + min(blocks, 210_000) * REWARD_840K + max(0, blocks - 210_000) * REWARD_840K / 2


def _share(funds: list[dict[str, Json]], price: float) -> dict[str, Json]:
    """Доля фондов в биткоинах в обращении: их активы (по цепочке у найденных
    фондов) в монетах — к добытому по расписанию. Своя арифметика, без
    готовых цифр источника."""
    aum = sum(_num(f.get("aum")) for f in funds)
    if aum <= 0 or price <= 0:
        return {"share": None}
    return {"share": round(aum / price / supply_at(_now()) * 100, 3)}


def _median(xs: list[float]) -> float:
    xs = sorted(xs)
    n = len(xs)
    return 0.0 if not n else xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def _avg_px(px: dict[int, float], lo: int, hi: int) -> float:
    """Средняя цена закрытия дней (lo, hi]; нет дней — закрытие ближе к hi."""
    vals = [v for d, v in px.items() if lo < d <= hi and v > 0]
    if vals:
        return sum(vals) / len(vals)
    near = [d for d in px if d <= hi and px[d] > 0]
    return px[max(near)] if near else 0.0


def _sec_holdings(sec: dict[str, dict[str, Any]], px: dict[int, float]) -> tuple[dict[int, float], dict[str, dict[int, float]]]:
    """Цена отчётов на конец квартала и запас каждого фонда в монетах.

    Цена — медиана «стоимость / монеты» у фондов, сдавших и то и другое
    (так фонды сами оценили монеты на ту дату); нет таких — закрытие Binance.
    Монеты фонда — из отчёта, а где их нет — стоимость по этой цене."""
    ends = sorted({e for f in sec.values() for e in f.get("q") or {}})
    price: dict[int, float] = {}
    for e in ends:
        ratios = [fv / cnt for f in sec.values() if (r := (f.get("q") or {}).get(e))
                  for cnt, fv in [r] if cnt and fv and cnt > 0]
        price[e] = _median(ratios) or _avg_px(px, e - 86400, e)
    hold: dict[str, dict[int, float]] = {}
    for t, f in sec.items():
        h: dict[int, float] = {}
        for e, (cnt, fv) in sorted((f.get("q") or {}).items()):
            if cnt:
                h[e] = float(cnt)
            elif fv is not None and price.get(e, 0) > 0:
                h[e] = float(fv) / price[e]
        hold[t] = h
    return price, hold


QuarterFlows = dict[int, dict[str, tuple[float, float]]]  # конец квартала → фонд → ($, монет)


def _quarters(sec: dict[str, dict[str, Any]], px: dict[int, float]) -> tuple[QuarterFlows, dict[int, float], dict[str, tuple[float, int]]]:
    """Потоки фондов по кварталам, цена отчётов на концы кварталов и
    последний запас фонда (монет, дата отчёта).

    Поток фонда за квартал — изменение запаса плюс комиссия, взятая монетами
    (доля в год × средний запас × длина квартала), в долларах — по средней
    цене квартала. Первый отчёт фонда — от нуля (фонд открылся в этом
    квартале); точка отсчёта ETF_FROM (запас GBTC до перехода в ETF) — без
    потока."""
    price, hold = _sec_holdings(sec, px)
    ends = sorted(price)
    start = calendar.timegm(time.strptime(wt_treasury.ETF_FROM, "%Y-%m-%d"))
    flows: QuarterFlows = {}
    last: dict[str, tuple[float, int]] = {}
    for t, h in hold.items():
        fee = _num(sec[t].get("fee"))
        prev: int | None = None
        for e in sorted(h):
            last[t] = (h[e], e)
            if e > start:
                lo = prev if prev is not None else max([x for x in ends if x < e], default=e - 91 * 86400)
                before = h[prev] if prev is not None else 0.0
                btc = h[e] - before + fee * (h[e] + before) / 2 * (e - lo) / (365 * 86400)
                flows.setdefault(e, {})[t] = (btc * _avg_px(px, lo, e), btc)
            prev = e
    return flows, price, last


def _coin(cat: str, symbol: str) -> dict[str, Json] | None:
    """Фонды по отчётам в SEC (кварталы, запас) и по своей цепочке (дни)."""
    sec = wt_treasury.etf_funds() if cat == "btc" else {}
    if not sec:
        return None
    start = calendar.timegm(time.strptime(wt_treasury.ETF_FROM, "%Y-%m-%d"))
    px = _klines(symbol, (start - 120 * 86400) * 1000)
    if not px:
        return None
    last_px = px[max(px)]
    flows, price, last = _quarters(sec, px)
    # Дни — только фонды, чьи кошельки сканер знает (и знает почти все).
    chain_ok = {t: c for t, c in _chain().items() if t in sec and _usable(c, (last.get(t) or (0.0, 0))[0])}
    today = _now() - _now() % 86400
    days: dict[int, Day] = {}
    if chain_ok:
        first = min(int(c.get("from") or today) for c in chain_ok.values())
        days = {t: ({}, 0.0, 0.0) for t in _after(first - first % 86400 - 86400, today)}
    chain = _apply_chain(days, px, chain_ok) if days else {}
    funds: list[dict[str, Json]] = []
    for t in sec:
        if t not in last:
            continue  # ни одного отчёта с запасом — фонда на экране нет
        btc, asof = last[t]
        c = chain.get(t)
        # Что прошло через кошельки фонда после его отчёта.
        after = 0.0
        if c is not None:
            if c.get("exact") and c.get("hold"):
                after = float(c["hold"]) - btc
            else:
                cut = settle_day(asof // 86400) * 86400 if asof else 0
                after = sum(float(v) for d, v in (c.get("days") or {}).items() if int(d) > cut)
            btc = max(0.0, btc + after)
        fee = sec[t].get("fee")
        cu = sum(v[t][0] for v in flows.values() if t in v)
        cc = sum(v[t][1] for v in flows.values() if t in v)
        f: dict[str, Json] = {
            "t": t, "n": str(sec[t].get("n") or "")[:60], "c": "US",
            "fee": None if fee is None else round(float(fee) * 100, 3),
            "aum": round(btc * last_px), "hold": round(btc, 2), "asof": asof,
            "cum": round(cu + after * last_px), "cumc": round(cc + after, 2),
        }
        if c is not None:
            f["src"] = "chain"
            if _partial(c, (last.get(t) or (0.0, 0))[0]):
                f["part"] = True
        funds.append(f)
    funds.sort(key=lambda f: -_num(f["hold"]))
    order = [str(f["t"]) for f in funds]
    quarters = []
    for e in sorted(flows):
        by = flows[e]
        quarters.append([e, round(sum(v[0] for v in by.values()) / 1000), round(sum(v[1] for v in by.values()), 2),
                         round(price.get(e, 0.0), 2), [round(by[t][0] / 1000) if t in by else None for t in order]])
    rows = []
    for ts in sorted(days):
        by_day, tot, coin = days[ts]
        if not by_day:
            continue
        per = [None if (v := (by_day.get(t) or {}).get("usd")) is None else round(_num(v) / 1000) for t in order]
        rows.append([ts, round(tot / 1000), round(coin, 2), round(px.get(ts, 0.0), 4), per])
    return {"funds": funds, "days": rows, "quarters": quarters, "px": round(last_px, 2),
            "asof": max((int(_num(f["asof"])) for f in funds), default=0), **_share(funds, last_px)}


# Разметка кошельков (свой список и /import владельца) прибавляется к
# отчёту SEC всегда: что прошло через известные кошельки фонда после
# отчёта — его поток. Знаем не все кошельки (на известных меньше COVER
# запаса из отчёта) — фонд помечен «по части кошельков»: дни у него неполные.
COVER = 0.9
# Защита от неверной разметки: на «кошельках фонда» монет заметно больше
# его запаса из отчёта — это чужой кошелёк хранителя, фонд без цепочки.
COVER_MAX = 1.25


def _chain() -> dict[str, dict[str, Any]]:
    src = _st.chain
    if src is None:
        return {}
    try:
        return src()
    except Exception as e:  # noqa: BLE001 — свои данные не должны ломать экран
        _log(f"цепочка: {type(e).__name__}: {e}")
        return {}


def _usable(c: dict[str, Any], base_btc: float) -> bool:
    """Фонд по цепочке (дни и прибавка к отчёту): кошельки опубликованы самим
    фондом, имя группы хранителя подтверждено сверкой потоков, или на
    размеченных кошельках не больше COVER_MAX запаса из отчёта."""
    if c.get("exact") or c.get("matched"):
        return True
    return base_btc > 0 and _num(c.get("hold")) <= COVER_MAX * base_btc


def _partial(c: dict[str, Any], base_btc: float) -> bool:
    """Знаем не все кошельки фонда: на известных меньше COVER его запаса."""
    return not (c.get("exact") or c.get("matched")) and _num(c.get("hold")) < COVER * base_btc


def _chain_btc(flows: dict[int, float], lo: int, hi: int) -> float:
    return sum(v for d, v in flows.items() if lo < d <= hi)


def _apply_chain(days: dict[int, Day], px: dict[int, float], chain: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Поток торгового дня у фондов, найденных по цепочке: монеты, дошедшие
    до цепочки в следующий рабочий день (T+1), в долларах по цене дня; итоги
    дня — их сумма. Не считается: день до начала наблюдения цепочки и
    последний день, чьи деньги до цепочки ещё не дошли. Возвращает фонды,
    у которых есть дни."""
    today = _now() - _now() % 86400
    trade = sorted(days)
    used: dict[str, dict[str, Any]] = {}
    for ticker, c in chain.items():
        start = int(c.get("from") or 0)
        flows = {int(d): float(v) for d, v in (c.get("days") or {}).items()}
        prev: int | None = None
        for t in trade:
            settle = settle_day(t // 86400) * 86400
            lo, prev = prev, settle
            p = px.get(t, 0.0)
            if lo is None or lo < start or settle >= today or p <= 0:
                continue
            btc = _chain_btc(flows, lo, settle)
            by, tot, coin = days[t]
            old = by.get(ticker) or {}
            ou = _num(old.get("usd")) if old.get("usd") is not None else 0.0
            ob = _num(old.get("btc")) if old.get("btc") is not None else 0.0
            by[ticker] = {"usd": btc * p, "btc": btc}
            days[t] = (by, tot + btc * p - ou, coin + btc - ob)
            used[ticker] = c
    return used


def _cme() -> dict[str, Json]:
    """Позиции на CME по отчёту CFTC — раз в неделю (по вторникам, выходит в
    пятницу), открытый API CFTC (Socrata)."""
    codes = [c for pairs in CME_CODES.values() for c, _ in pairs]
    q = urllib.parse.urlencode({
        "$select": "cftc_contract_market_code,report_date_as_yyyy_mm_dd," + ",".join(CME_FIELDS),
        "$where": "cftc_contract_market_code in (" + ",".join(f"'{c}'" for c in codes) + ")",
        "$order": "report_date_as_yyyy_mm_dd ASC",
        "$limit": "5000",
    })
    rows = _get("https://publicreporting.cftc.gov/resource/gpe5-46if.json?" + q, 30)
    if not isinstance(rows, list) or not rows:
        return {}
    unit = {c: (coin, u) for coin, pairs in CME_CODES.items() for c, u in pairs}
    acc: dict[str, dict[int, list[float]]] = {}
    for r in rows:
        if not isinstance(r, dict) or r.get("cftc_contract_market_code") not in unit:
            continue
        coin, u = unit[r["cftc_contract_market_code"]]
        try:
            ts = _day(r.get("report_date_as_yyyy_mm_dd"))
        except (TypeError, ValueError):
            continue
        cur = acc.setdefault(coin, {}).setdefault(ts, [0.0] * len(CME_FIELDS))
        for i, f in enumerate(CME_FIELDS):
            cur[i] += _num(r.get(f)) * u
    return {coin: [[ts, *[round(v, 1) for v in by[ts]]] for ts in sorted(by)] for coin, by in acc.items()}


def _coinbase_daily(product: str, start: int) -> dict[int, float]:
    out: dict[int, float] = {}
    t = start
    end = _now()
    while t < end:
        t2 = min(end, t + 299 * 86400)
        a = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
        b = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t2))
        rows = _get(f"https://api.exchange.coinbase.com/products/{product}/candles?granularity=86400&start={a}&end={b}")
        if not isinstance(rows, list):
            break
        for k in rows:
            if isinstance(k, list) and len(k) > 4:
                out[int(_num(k[0]))] = _num(k[4])
        t = t2 + 86400
    return out


def _cbp() -> dict[str, Json]:
    """Премия Coinbase: на сколько процентов биткоин (эфир) на Coinbase дороже,
    чем на Binance. Coinbase — главная площадка американских фондов и
    компаний, поэтому плюс читают как спрос из США."""
    out: dict[str, Json] = {}
    start = (_now() - 400 * 86400) // 86400 * 86400
    for coin, cb, bn in (("btc", "BTC-USD", "BTCUSDT"),):
        c = _coinbase_daily(cb, start)
        b = _klines(bn, start * 1000)
        days = [[ts, round((c[ts] / b[ts] - 1) * 100, 4)] for ts in sorted(c) if b.get(ts)]
        tc = _get(f"https://api.exchange.coinbase.com/products/{cb}/ticker", 10)
        tb = _get(f"https://data-api.binance.vision/api/v3/ticker/price?symbol={bn}", 10)
        pc = _num(tc.get("price")) if isinstance(tc, dict) else 0.0
        pb = _num(tb.get("price")) if isinstance(tb, dict) else 0.0
        live = round((pc / pb - 1) * 100, 4) if pc > 0 and pb > 0 else None
        if days:
            out[coin] = {"days": days[-366:], "now": live}
    return out


# Фонды, найденные по цепочке (сканер бота): тикер → {"from": с какого дня
# цепочка наблюдается (unix), "days": {сутки цепочки (unix): чистый поток BTC},
# "hold": запас BTC или None}. Источник подключает API (set_chain).
ChainSrc = Callable[[], dict[str, dict[str, Any]]]


class _State:
    """Кэш модуля: (monotonic, ответ). Меняется только под _lock."""

    hit: tuple[float, dict[str, Json]] | None = None
    chain: ChainSrc | None = None


def _holders(c: Json, companies: list[list[Any]]) -> list[list[Any]]:
    """«Крупнейшие держатели»: фонды (запас — как в списке фондов выше) и
    компании по их отчётам в SEC (wt_treasury), по убыванию запаса. Строка —
    [имя, FUND или COMPANY, страна, тикер, BTC, дата отчёта unix (у фонда,
    чей запас ведёт цепочка, — 0)]."""
    rows: list[list[Any]] = []
    for f in (c or {}).get("funds") or []:
        hold = _num(f.get("hold"))
        if hold >= 1:
            # Дата отчёта — у фонда без цепочки: его запас — на ту дату.
            asof = 0 if f.get("src") == "chain" else int(_num(f.get("asof")))
            rows.append([str(f.get("n") or f.get("t")), "FUND", str(f.get("c") or ""), str(f.get("t")), hold, asof])
    rows += [r for r in companies if isinstance(r, list) and len(r) == 6]
    rows.sort(key=lambda r: -float(r[4]))
    return rows


def peek() -> dict[str, Json] | None:
    """Готовый ответ из кэша, без сборки: для тех, кого зовёт сама сборка
    (сверка имён фондов по цепочке) — иначе холодный старт ждал бы сам себя."""
    with _lock:
        return _st.hit[1] if _st.hit else None


def set_chain(src: ChainSrc | None) -> None:
    """Подключить свои данные по цепочке: фонды, которые сканер нашёл, на
    экране считаются по ним, остальные — по отчётам, пока не найдены."""
    _st.chain = src


_st = _State()
_lock = threading.Lock()
_cold = threading.Lock()
_busy = threading.Event()  # идёт фоновая сборка


def _part(name: str, fut: Future[Any], timeout: float) -> Any:
    """Часть сборки: упала или не уложилась — None (и строка в журнале)."""
    try:
        return fut.result(timeout=timeout)
    except Exception as e:  # noqa: BLE001 — одна часть не роняет остальные
        _log(f"{name}: {type(e).__name__}: {e}")
        return None


def build() -> dict[str, Json]:
    """Собрать ответ из сети и положить в кэш."""
    coins: dict[str, Json] = {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futs = {cat: pool.submit(_coin, cat, sym) for cat, sym in COINS}
        cme_f = pool.submit(_cme)
        cbp_f = pool.submit(_cbp)
        co_f = pool.submit(wt_treasury.companies)
        for cat, f in futs.items():
            r = _part(cat, f, 90)
            if r:
                coins[cat] = r
        extra = {"cme": _part("cme", cme_f, 90) or {}, "cbp": _part("cbp", cbp_f, 90) or {}}
        companies = _part("companies", co_f, 90) or []
    with _lock:
        was = _st.hit[1] if _st.hit else {}
    if "btc" not in coins and not was:
        return {"ok": False, "error": "no_data"}
    # Часть, которой в этот раз нет, — из прошлой сборки, а не пропадает с экрана.
    for cat, _ in COINS:
        if cat not in coins and cat in (was.get("coins") or {}):
            coins[cat] = was["coins"][cat]
    for name in ("cme", "cbp"):
        if not extra[name] and was.get(name):
            extra[name] = was[name]
    res = {"ok": True, "coins": coins, "holders": _holders(coins.get("btc"), companies),
           "cme": extra["cme"], "cbp": extra["cbp"], "at": _now()}
    with _lock:
        _st.hit = (time.monotonic(), res)
    return res


def _bg() -> None:
    try:
        build()
    except Exception as e:  # noqa: BLE001 — фоновый поток не должен умирать молча
        _log(f"сборка: {type(e).__name__}: {e}")
    finally:
        _busy.clear()


def etf_data() -> dict[str, Json]:
    """Ответ /api/etf: из кэша, свежий собирается в фоне одним потоком."""
    with _lock:
        hit = _st.hit
        if hit and time.monotonic() - hit[0] < TTL:
            return hit[1]
        if hit and not _busy.is_set():
            _busy.set()
            try:
                threading.Thread(target=_bg, daemon=True).start()
            except RuntimeError as e:
                _busy.clear()
                _log(f"фон не запущен: {e}")
    if hit:
        return hit[1]
    # Холодный старт: первый собирает, остальные ждут его и берут готовое.
    with _cold:
        with _lock:
            hit = _st.hit
        return hit[1] if hit else build()

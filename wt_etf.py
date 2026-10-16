"""Институциональные потоки — отдельный модуль API (/api/etf).

Что собирается — только биткоин и только то, что мы достаём сами:
  - приток и отток фондов — свой сканер бота по цепочке (set_chain): BITB
    по кошелькам, которые фонд публикует сам, и фонды, найденные у
    хранителя; поток — за сутки UTC, запас — остатки кошельков фонда;
  - цена дня — закрытие Binance, премия Coinbase — цены Coinbase и Binance
    напрямую с бирж, разница — своим счётом;
  - доля фондов от добытых монет — своим счётом по расписанию эмиссии;
  - кто держит биткоин — фонды отсюда же и государства по своему сканеру
    (set_holders);
  - позиции на CME — еженедельный отчёт CFTC «Traders in Financial Futures»
    (данные правительства США, открытые).
Чужих сводок на экране нет: то, чего мы не видим сами, на экран не идёт.
Сводка CoinMarketCap — только ключ сверки (check_reply): по её ежедневным
потокам фондов узнаётся, чьё хранилище нашёл сканер; сами её цифры никуда
не выводятся.

Цепочка меняется каждые десять минут, но сутки — раз в сутки, поэтому ответ
живёт час (TTL): устаревший отдаётся сразу, свежий собирается в фоне одним
потоком. Часть, которая в этот раз не собралась (потоки, держатели, CME),
берётся из прошлой сборки, а не пропадает с экрана.

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
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any

# Сколько ответ живёт в кэше, с.
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
HOSTS = frozenset({"data-api.binance.vision", "publicreporting.cftc.gov", "api.exchange.coinbase.com",
                   "api.coinmarketcap.com"})
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


def _flag(code: str) -> str:
    """Флаг страны из кода ISO: две буквы → два «региональных» символа."""
    return "".join(chr(0x1F1E6 + ord(ch) - ord("A")) for ch in code) if re.fullmatch(r"[A-Z]{2}", code) else ""


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


# Фонды, которых мы знаем по тикеру: имя и страна, где фонд торгуется. Это
# факты о самом фонде (из его проспекта), не чужая сводка.
FUND_INFO = {
    "IBIT": ("iShares Bitcoin Trust", "US"), "FBTC": ("Fidelity Wise Origin Bitcoin Fund", "US"),
    "GBTC": ("Grayscale Bitcoin Trust", "US"), "BTC": ("Grayscale Bitcoin Mini Trust", "US"),
    "BITB": ("Bitwise Bitcoin ETF", "US"), "ARKB": ("ARK 21Shares Bitcoin ETF", "US"),
    "HODL": ("VanEck Bitcoin ETF", "US"), "BRRR": ("CoinShares Bitcoin ETF", "US"),
    "EZBC": ("Franklin Bitcoin ETF", "US"), "BTCO": ("Invesco Galaxy Bitcoin ETF", "US"),
    "BTCW": ("WisdomTree Bitcoin Fund", "US"),
}


def _chain() -> dict[str, dict[str, Any]]:
    src = _st.chain
    if src is None:
        return {}
    try:
        return src()
    except Exception as e:  # noqa: BLE001 — свои данные не должны ломать экран
        _log(f"цепочка: {type(e).__name__}: {e}")
        return {}


def _coin(cat: str, symbol: str) -> dict[str, Json] | None:
    """Потоки фондов по цепочке: сутки UTC от начала наблюдения до вчера
    (сегодняшние ещё идут) — итог в $ тыс., в монетах, цена дня, потоки
    фондов в $ тыс. (None — фонд в тот день ещё не наблюдался)."""
    chain = {t: c for t, c in _chain().items() if c.get("days")}
    if cat != "btc" or not chain:
        return None
    today = _now() - _now() % 86400
    start = min(int(c.get("from") or min(c["days"])) for c in chain.values())
    start -= start % 86400
    if start >= today:
        return None
    px = _klines(symbol, start * 1000)
    last_px = next((px[d] for d in sorted(px, reverse=True) if d < today and px[d] > 0), 0.0)
    flows = {t: {int(d) - int(d) % 86400: float(v) for d, v in c["days"].items()} for t, c in chain.items()}
    funds: list[dict[str, Json]] = []
    for t, c in chain.items():
        name, country = FUND_INFO.get(t, ("", ""))
        hold = c.get("hold")
        usd = sum(v * px.get(d, 0.0) for d, v in flows[t].items() if d < today)
        funds.append({"t": t[:20], "n": name, "c": country,
                      "aum": round(float(hold) * last_px) if hold and last_px > 0 else 0,
                      "fee": None, "cum": round(usd), "cumc": round(sum(v for d, v in flows[t].items() if d < today), 2),
                      "src": "chain", "from": int(c.get("from") or start)})
    funds.sort(key=lambda f: (-_num(f["aum"]), str(f["t"])))
    rows = []
    for d in range(start, today, 86400):
        p = px.get(d, 0.0)
        per: list[int | None] = []
        usd = coins = 0.0
        for f in funds:
            if d < int(f["from"]) - int(f["from"]) % 86400:
                per.append(None)
                continue
            b = flows[str(f["t"])].get(d, 0.0)
            per.append(round(b * p / 1000))
            usd += b * p
            coins += b
        rows.append([d, round(usd / 1000), round(coins, 2), round(p, 4), per])
    for f in funds:
        f.pop("from")
    return {"funds": funds, "days": rows, **_share(funds, last_px)}


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


# «Кто держит биткоин»: фонды — из списка фондов этого же экрана, государства —
# свой сканер бота (подключает API, set_holders): {"top": [строки держателей]},
# строка — [имя, тип, подтип, флаг, тикер или код страны, BTC, за 7 дней, 0].
HoldersSrc = Callable[[], dict[str, Any]]


class _State:
    """Кэш модуля: (monotonic, ответ). Меняется только под _lock."""

    hit: tuple[float, dict[str, Json]] | None = None
    chain: ChainSrc | None = None
    holders: HoldersSrc | None = None


def set_holders(src: HoldersSrc | None) -> None:
    """Подключить государства по цепочке (сканер бота)."""
    _st.holders = src


def _own_holders() -> dict[str, Json]:
    src = _st.holders
    if src is None:
        return {}
    try:
        return src()
    except Exception as e:  # noqa: BLE001 — свои данные не должны ломать экран
        _log(f"держатели: {type(e).__name__}: {e}")
        return {}


def _fund_holders(c: dict[str, Any] | None) -> list[list[Any]]:
    """Фонды как держатели: запас — активы фонда по цене последнего дня (у
    фондов, найденных в цепочке, — свой запас), за неделю — сумма их дневных
    потоков, каждый день по своей цене."""
    if not c or not c.get("days"):
        return []
    days = c["days"]
    px = next((float(d[3]) for d in reversed(days) if d[3]), 0.0)
    if px <= 0:
        return []
    week = [d for d in days if d[0] > days[-1][0] - 7 * 86400]
    out: list[list[Any]] = []
    for i, f in enumerate(c.get("funds") or []):
        aum = float(f.get("aum") or 0)
        if aum <= 0:
            continue
        d7 = sum(float(d[4][i]) * 1000 / float(d[3]) for d in week if i < len(d[4]) and d[4][i] and d[3])
        out.append([str(f.get("n") or f["t"]), "FUND", "", _flag(str(f.get("c") or "")), str(f["t"]),
                    round(aum / px, 2), round(d7, 2), 0])
    return out


def _holders(c: dict[str, Any] | None, own: dict[str, Any]) -> dict[str, Any]:
    """Блок «Кто держит биткоин»: группы, все держатели по убыванию запаса и
    кто сильнее всех менялся за неделю."""
    # От сканера — только государства: биржи и киты живут в Нетфлоу и Рейтинге.
    top = _fund_holders(c) + [r for r in own.get("top") or []
                              if isinstance(r, list) and len(r) == 8 and r[1] == "GOVERNMENT"]
    if not top:
        return {}
    top.sort(key=lambda r: -r[5])
    groups: dict[str, list[Any]] = {}
    for r in top:
        g = groups.setdefault(r[1], [r[1], 0, 0.0, 0.0])
        g[1] += 1
        g[2] += r[5]
        g[3] += r[6]
    movers = sorted((r for r in top if abs(r[6]) >= 0.5), key=lambda r: -abs(r[6]))[:12]
    return {"groups": [[g[0], g[1], round(g[2], 2), round(g[3], 2)] for g in sorted(groups.values(), key=lambda g: -g[2])],
            "top": top, "movers": movers}


# --- Ключ сверки имён (не на экран) -----------------------------------------
# Ежедневные потоки фондов по сводке CoinMarketCap: с ними сравниваются
# потоки групп хранителя (wt_etfchain.match_names), совпали — группа
# получает имя фонда. Формат — как coins.btc у экрана: [день, 0, 0, цена,
# [поток фонда $ тыс. | None]] и фонды с комиссией.
CMC = "https://api.coinmarketcap.com/data-api/v3/"


def _cmc(path: str, timeout: float = 25) -> dict[str, Json]:
    got = _get(CMC + path, timeout)
    data = got.get("data") if isinstance(got, dict) else None
    return data if isinstance(data, dict) else {}


def _points() -> list[Json] | None:
    """Все дни потоков страницами по сто; None — страница не пришла."""
    first = _cmc("etf/detail/netflow/list?category=btc&size=100&page=1")
    pts = list(first.get("points") or [])
    if not pts:
        return None
    pages = min(12, (int(_num(first.get("totalCount"))) + 99) // 100)
    for n in range(2, pages + 1):
        got: list[Json] = []
        for attempt in range(3):
            got = list(_cmc(f"etf/detail/netflow/list?category=btc&size=100&page={n}").get("points") or [])
            if got:
                break
            time.sleep(1.5 * (attempt + 1))
        if not got:
            return None
        pts.extend(got)
    return pts


def _check_build() -> dict[str, Json] | None:
    pts = _points()
    if not pts:
        return None
    days: dict[int, dict[str, float]] = {}
    for p in pts:
        if not isinstance(p, dict):
            continue
        ts = int(_num(p.get("date"))) // 1000
        by = {str(k): _num(v.get("usd")) for k, v in p.items()
              if k not in ("date", "total") and isinstance(v, dict) and v.get("usd") is not None}
        if ts > 0 and by:
            days[ts] = by
    if not days:
        return None
    fees: dict[str, float | None] = {}
    lst = _get(CMC + "etf/list?category=btc&size=60&start=1", 25)
    for f in (lst.get("data") if isinstance(lst, dict) else None) or []:
        if isinstance(f, dict) and isinstance(f.get("ticker"), str) and f["ticker"]:
            fees[f["ticker"]] = None if f.get("netFee") is None else _num(f["netFee"])
    tickers = sorted({t for by in days.values() for t in by})
    px = _klines("BTCUSDT", min(days) * 1000)
    rows = [[ts, 0, 0, round(px.get(ts, 0.0), 4),
             [None if t not in days[ts] else round(days[ts][t] / 1000) for t in tickers]] for ts in sorted(days)]
    return {"coins": {"btc": {"funds": [{"t": t, "fee": fees.get(t)} for t in tickers], "days": rows}}}


class _Check:
    at = 0.0
    reply: dict[str, Json] | None = None


_check = _Check()
_check_lock = threading.Lock()


def check_reply() -> dict[str, Json] | None:
    """Ключ сверки имён, живёт TTL. Зовёт только фоновый разбор хранилищ."""
    with _check_lock:
        if _check.reply is None or time.monotonic() - _check.at > TTL:
            try:
                got = _check_build()
            except Exception as e:  # noqa: BLE001 — сверка не должна ронять разбор
                _log(f"ключ сверки: {type(e).__name__}: {e}")
                got = None
            if got:
                _check.at, _check.reply = time.monotonic(), got
        return _check.reply


def peek() -> dict[str, Json] | None:
    """Готовый ответ из кэша, без сборки: для тех, кого зовёт сама сборка
    (сверка имён фондов по цепочке) — иначе холодный старт ждал бы сам себя."""
    with _lock:
        return _st.hit[1] if _st.hit else None


def set_chain(src: ChainSrc | None) -> None:
    """Подключить свои данные по цепочке: фонды, которые сканер нашёл."""
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
    with ThreadPoolExecutor(max_workers=2) as pool:
        futs = {cat: pool.submit(_coin, cat, sym) for cat, sym in COINS}
        cme_f = pool.submit(_cme)
        cbp_f = pool.submit(_cbp)
        for cat, f in futs.items():
            r = _part(cat, f, 90)
            if r:
                coins[cat] = r
        own = _own_holders()
        extra = {"cme": _part("cme", cme_f, 90) or {}, "cbp": _part("cbp", cbp_f, 90) or {}}
    with _lock:
        was = _st.hit[1] if _st.hit else {}
    if "btc" not in coins and not was:
        return {"ok": False, "error": "no_data"}
    # Часть, которой в этот раз нет, — из прошлой сборки, а не пропадает с экрана.
    for cat, _ in COINS:
        if cat not in coins and cat in (was.get("coins") or {}):
            coins[cat] = was["coins"][cat]
    if not own.get("top"):
        # Сканер бота не ответил — государства из прошлой сборки.
        own = {"top": [r for r in (was.get("holders") or {}).get("top") or [] if r[1] == "GOVERNMENT"]}
    holders = _holders(coins.get("btc"), own)
    for name in ("cme", "cbp"):
        if not extra[name] and was.get(name):
            extra[name] = was[name]
    res = {"ok": True, "coins": coins, "holders": holders, "cme": extra["cme"], "cbp": extra["cbp"], "at": _now()}
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

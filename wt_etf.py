"""Институциональные потоки — отдельный модуль API (/api/etf).

Что собирается — только биткоин (всё — открытые источники без ключей):
  - приток и отток спотовых ETF по каждому фонду и торговому дню —
    data-api CoinMarketCap с января 2024, страницы по сто дней; названия
    фондов, активы и комиссия — их же список фондов. Фонды, которые сканер
    бота нашёл в цепочке, считаются своими потоками (set_chain, _apply_chain).
    Цена дня — закрытие Binance;
  - доля фондов от добытых монет — своим счётом по расписанию эмиссии
    (supply_at), без чужих данных;
  - кто держит биткоин — свой блок из сканера бота (set_holders): биржи,
    фонды и киты по цепочке;
  - позиции на CME — еженедельный отчёт CFTC «Traders in Financial Futures»;
  - премия Coinbase к Binance — спрос американских покупателей.

Отчёты фондов выходят раз в сутки, поэтому ответ живёт час (TTL): устаревший
отдаётся сразу, свежий собирается в фоне одним потоком. Часть, которая в этот
раз не собралась (потоки, держатели, CME), берётся из прошлой сборки, а не
пропадает с экрана.

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
HOSTS = frozenset({"api.coinmarketcap.com", "data-api.binance.vision", "publicreporting.cftc.gov",
                   "api.exchange.coinbase.com"})
# Самый большой ответ — отчёт CFTC, ~2 МБ.
BODY_MAX = 8 << 20
_HEADERS = {"User-Agent": "wallet-tracker/1.0", "Accept-Encoding": "identity"}
CMC = "https://api.coinmarketcap.com/data-api/v3/"

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


def _cmc(path: str, timeout: float = 25) -> dict[str, Json]:
    got = _get(CMC + path, timeout)
    data = got.get("data") if isinstance(got, dict) else None
    return data if isinstance(data, dict) else {}


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


def _points(cat: str) -> list[Json] | None:
    """Все дни потоков монеты страницами по сто; None — страница не пришла
    (тогда не рисуем дыру на месяцы, а считаем сборку неудачной)."""
    first = _cmc(f"etf/detail/netflow/list?category={cat}&size=100&page=1")
    pts = list(first.get("points") or [])
    if not pts:
        return None
    pages = min(12, (int(_num(first.get("totalCount"))) + 99) // 100)

    def page(n: int) -> list[Json]:
        # Под нагрузкой CoinMarketCap иногда отдаёт пустую страницу — второй
        # заход через пару секунд её приносит.
        for attempt in range(3):
            got = _cmc(f"etf/detail/netflow/list?category={cat}&size=100&page={n}").get("points") or []
            if got:
                return list(got)
            time.sleep(1.5 * (attempt + 1))
        return []

    if pages > 1:
        with ThreadPoolExecutor(max_workers=3) as pool:
            rest = list(pool.map(page, range(2, pages + 1)))
        if not all(rest):
            return None
        for chunk in rest:
            pts.extend(chunk)
    return pts


Day = tuple[dict[str, dict[str, Json]], float, float]  # фонды, итог $, итог монет


def _days(pts: list[Json], unit: str) -> dict[int, Day]:
    """Торговые дни: начало суток → (фонды, итог в $, итог в монетах)."""
    days: dict[int, Day] = {}
    for p in pts:
        if not isinstance(p, dict):
            continue
        ts = int(_num(p.get("date"))) // 1000
        funds = {str(k): v for k, v in p.items() if k not in ("date", "total") and isinstance(v, dict)}
        # День, по которому фонды ещё не отчитались: всё пусто, а не нули.
        if ts <= 0 or not any(v.get("usd") is not None for v in funds.values()):
            continue
        tot = p.get("total")
        # Количество монет — сумма по фондам: в итоговой строке источника в
        # поле монет у биткоина лежат доллары.
        coin = sum(_num(v.get(unit)) for v in funds.values())
        days[ts] = (funds, _num(tot.get("usd")) if isinstance(tot, dict) else 0.0, coin)
    return days


def _funds(cat: str, days: dict[int, Day], unit: str) -> list[dict[str, Json]]:
    """Фонды по убыванию итога «с запуска»: имя, активы, премия, комиссия."""
    names: dict[str, dict[str, Json]] = {}
    if cat == "btc":
        lst = _get(f"https://api.coinmarketcap.com/data-api/v3/etf/list?category={cat}&size=60&start=1", 25)
        for f in (lst.get("data") if isinstance(lst, dict) else None) or []:
            if isinstance(f, dict) and isinstance(f.get("ticker"), str) and f["ticker"]:
                names[f["ticker"]] = f
    # Итог «с запуска» — сумма дневных потоков. Готовая строка источника с
    # итогами врёт: у гонконгского HARVEST там +$8,5 млрд при дневных потоках
    # на десятки миллионов.
    sums: dict[str, list[float]] = {}
    for funds, _, _ in days.values():
        for k, v in funds.items():
            acc = sums.setdefault(k, [0.0, 0.0])
            acc[0] += _num(v.get("usd"))
            acc[1] += _num(v.get(unit))
    out = []
    for k in sorted(sums, key=lambda k: -abs(sums[k][0])):
        info = names.get(k) or {}
        out.append({
            "t": k[:20], "n": str(info.get("name") or "")[:60],
            "aum": round(_num(info.get("aum"))),
            "fee": None if info.get("netFee") is None else _num(info["netFee"]),
            "cum": round(sums[k][0]), "cumc": round(sums[k][1], 2),
        })
    return out


def _prices(symbol: str, days: dict[int, Day]) -> dict[int, float]:
    """Цена закрытия каждого дня — дневные свечи Binance."""
    return _klines(symbol, min(days) * 1000)


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


def _coin(cat: str, symbol: str) -> dict[str, Json] | None:
    """Потоки фондов одной монеты: дни (итог, монеты, цена, по фондам),
    фонды, доля в капитализации и рекорды месяца."""
    pts = _points(cat)
    unit = "btc"
    days = _days(pts, unit) if pts else {}
    if not days:
        return None
    px = _prices(symbol, days)
    chain = _apply_chain(days, px) if cat == "btc" else {}
    funds = _funds(cat, days, unit)
    for f in funds:
        c = chain.get(str(f["t"]))
        if c is None:
            continue
        f["src"] = "chain"
        last_px = px[max(px)] if px else 0.0
        if c.get("hold") and last_px > 0:
            f["aum"] = round(float(c["hold"]) * last_px)
    rows = []
    for ts in sorted(days):
        by, tot, coin = days[ts]
        per = [None if (v := (by.get(f["t"]) or {}).get("usd")) is None else round(_num(v) / 1000) for f in funds]
        rows.append([ts, round(tot / 1000), round(coin, 2), round(px.get(ts, 0.0), 4), per])
    last = px[max(px)] if px else 0.0
    return {"funds": funds, "days": rows, **_share(funds, last)}


def _chain_btc(flows: dict[int, float], lo: int, hi: int) -> float:
    return sum(v for d, v in flows.items() if lo < d <= hi)


def _apply_chain(days: dict[int, Day], px: dict[int, float]) -> dict[str, dict[str, Any]]:
    """Подмена по фонду: у фондов, найденных по цепочке, поток торгового дня —
    свой: монеты, дошедшие до цепочки в следующий рабочий день (T+1), в
    долларах по цене дня. Итоги дня правятся на разницу — экран всегда
    полный. Не подменяется: день до начала наблюдения цепочки и последний
    день, чьи деньги до цепочки ещё не дошли. Возвращает подменённые фонды."""
    src = _st.chain
    if src is None:
        return {}
    try:
        chain = src()
    except Exception as e:  # noqa: BLE001 — свои данные не должны ломать экран
        _log(f"цепочка: {type(e).__name__}: {e}")
        return {}
    today = _now() - _now() % 86400
    trade = sorted(days)
    used: dict[str, dict[str, Any]] = {}
    for ticker, c in chain.items():
        start = int(c.get("from") or 0)
        flows = {int(d): float(v) for d, v in (c.get("days") or {}).items()}
        prev = None
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


# «Кто держит биткоин» — свой, из сканера бота (подключает API, set_holders):
# группы, держатели и движения недели в формате экрана.
HoldersSrc = Callable[[], dict[str, Any]]


class _State:
    """Кэш модуля: (monotonic, ответ). Меняется только под _lock."""

    hit: tuple[float, dict[str, Json]] | None = None
    chain: ChainSrc | None = None
    holders: HoldersSrc | None = None


def set_holders(src: HoldersSrc | None) -> None:
    """Подключить своих держателей биткоина (биржи, фонды, киты по цепочке)."""
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
    with ThreadPoolExecutor(max_workers=2) as pool:
        futs = {cat: pool.submit(_coin, cat, sym) for cat, sym in COINS}
        cme_f = pool.submit(_cme)
        cbp_f = pool.submit(_cbp)
        for cat, f in futs.items():
            r = _part(cat, f, 90)
            if r:
                coins[cat] = r
        holders = _own_holders()
        extra = {"cme": _part("cme", cme_f, 90) or {}, "cbp": _part("cbp", cbp_f, 90) or {}}
    with _lock:
        was = _st.hit[1] if _st.hit else {}
    if "btc" not in coins and not was:
        return {"ok": False, "error": "no_data"}
    # Часть, которой в этот раз нет, — из прошлой сборки, а не пропадает с экрана.
    for cat, _ in COINS:
        if cat not in coins and cat in (was.get("coins") or {}):
            coins[cat] = was["coins"][cat]
    if not holders and was.get("holders"):
        holders = was["holders"]
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

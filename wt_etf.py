"""Институциональные потоки — отдельный модуль API (/api/etf).

Что собирается (всё — открытые источники без ключей):
  - приток и отток спотовых ETF по каждому фонду и торговому дню —
    data-api CoinMarketCap: биткоин с января 2024, эфир с июля 2024, Solana,
    XRP и HYPE — с их запуска; страницы по сто дней. Названия фондов, активы,
    премия и комиссия — их же список фондов. Цена дня — закрытие Binance
    (у HYPE дни без Binance — свечи Hyperliquid);
  - доля фондов в капитализации монеты и лучший/худший месяц — CoinMarketCap;
  - кто ещё держит биткоин: компании, государства, фонды —
    bitcointreasuries.net (и казначейства в эфире, Solana, BNB, XRP);
  - позиции на CME — еженедельный отчёт CFTC «Traders in Financial Futures»;
  - премия Coinbase к Binance — спрос американских покупателей.

Отчёты фондов выходят раз в сутки, поэтому ответ живёт час (TTL): устаревший
отдаётся сразу, свежий собирается в фоне одним потоком. Часть, которая в этот
раз не собралась (монета, держатели, CME), берётся из прошлой сборки, а не
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
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any

# Сколько ответ живёт в кэше, с: фонды отчитываются раз в сутки.
TTL = 3600.0
# Монета → пара Binance для цены дня.
COINS = (("btc", "BTCUSDT"), ("eth", "ETHUSDT"), ("sol", "SOLUSDT"), ("xrp", "XRPUSDT"), ("hype", "HYPEUSDT"))
# Позиции на CME: код контракта CFTC → размер контракта в монетах (большой
# и микро складываются в монетах: у них разный размер).
CME_CODES = {
    "btc": (("133741", 5.0), ("133742", 0.1)),
    "eth": (("146021", 50.0), ("146022", 0.1)),
    "sol": (("177741", 500.0), ("177742", 25.0)),
    "xrp": (("176740", 50000.0), ("176741", 2500.0)),
}
CME_FIELDS = ("open_interest_all", "asset_mgr_positions_long", "asset_mgr_positions_short",
              "lev_money_positions_long", "lev_money_positions_short",
              "dealer_positions_long_all", "dealer_positions_short_all",
              "nonrept_positions_long_all", "nonrept_positions_short_all")

# Куда модулю можно ходить — и больше никуда.
HOSTS = frozenset({"api.coinmarketcap.com", "data-api.binance.vision", "api.hyperliquid.xyz",
                   "publicreporting.cftc.gov", "api.exchange.coinbase.com", "bitcointreasuries.net"})
# Самый большой ответ: страница bitcointreasuries.net ~1 МБ, отчёт CFTC ~2 МБ.
BODY_MAX = 8 << 20
_HEADERS = {"User-Agent": "wallet-tracker/1.0", "Accept-Encoding": "identity"}
CMC = "https://api.coinmarketcap.com/data-api/v3/"
BT_PAGE = "https://bitcointreasuries.net/"
_BT_SNAP = re.compile(r'<script type="application/json" id="bt-query-snapshot">(.*?)</script>', re.S)

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


def _post(url: str, payload: dict[str, Any], timeout: float = 15) -> Json:
    return _parse(_fetch(url, timeout, json.dumps(payload).encode()))


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
    if cat in ("btc", "eth"):
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
            "aum": round(_num(info.get("aum"))), "vol": round(_num(info.get("volume"))),
            "prem": None if info.get("premiumDiscount") is None else _num(info["premiumDiscount"]),
            "fee": None if info.get("netFee") is None else _num(info["netFee"]),
            "cum": round(sums[k][0]), "cumc": round(sums[k][1], 2),
        })
    return out


def _prices(symbol: str, days: dict[int, Day]) -> dict[int, float]:
    """Цена закрытия каждого дня: Binance, а чего там нет — Hyperliquid."""
    t0 = min(days)
    px = _klines(symbol, t0 * 1000)
    # На Binance монета могла появиться позже фондов (HYPE) — дни без цены
    # добираем дневными свечами Hyperliquid.
    if sum(1 for ts in days if ts in px) < len(days) * 0.9:
        kl = _post("https://api.hyperliquid.xyz/info", {"type": "candleSnapshot", "req": {
            "coin": symbol.replace("USDT", ""), "interval": "1d", "startTime": t0 * 1000, "endTime": _now() * 1000}})
        for k in kl if isinstance(kl, list) else []:
            if isinstance(k, dict):
                px.setdefault(int(_num(k.get("t"))) // 1000 // 86400 * 86400, _num(k.get("c")))
    return px


def _share(cat: str) -> dict[str, Json]:
    """Доля фондов в капитализации монеты (сейчас и по дням), лучший и
    худший месяц."""
    m = _cmc(f"etf/netflow/metrics?category={cat}&convertId=2781")
    ratio = _cmc(f"etf/aum/market-cap/ratio?category={cat}&range=all")
    configs = ratio.get("configs")
    share = None
    if isinstance(configs, list) and configs and isinstance(configs[0], dict) and configs[0].get("value") is not None:
        share = _num(configs[0]["value"])
    hist = [[int(_num(q.get("timestamp"))), round(_num(q["points"][0]), 3)] for q in ratio.get("points") or []
            if isinstance(q, dict) and isinstance(q.get("points"), list) and q["points"]]

    def month(k: str) -> list[float] | None:
        v = m.get(k)
        if not isinstance(v, dict) or v.get("timestamp") is None or v.get("value") is None:
            return None
        return [int(_num(v["timestamp"])), _num(v["value"])]

    return {"share": share, "shareHist": hist, "best": month("strongestMonth"), "worst": month("weakestMonth")}


def _coin(cat: str, symbol: str) -> dict[str, Json] | None:
    """Потоки фондов одной монеты: дни (итог, монеты, цена, по фондам),
    фонды, доля в капитализации и рекорды месяца."""
    pts = _points(cat)
    unit = "btc" if cat == "btc" else "eth"  # у остальных монет количество лежит в поле eth
    days = _days(pts, unit) if pts else {}
    if not days:
        return None
    funds = _funds(cat, days, unit)
    px = _prices(symbol, days)
    rows = []
    for ts in sorted(days):
        by, tot, coin = days[ts]
        per = [None if (v := (by.get(f["t"]) or {}).get("usd")) is None else round(_num(v) / 1000) for f in funds]
        rows.append([ts, round(tot / 1000), round(coin, 2), round(px.get(ts, 0.0), 4), per])
    return {"funds": funds, "days": rows, **_share(cat)}


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
    for coin, cb, bn in (("btc", "BTC-USD", "BTCUSDT"), ("eth", "ETH-USD", "ETHUSDT")):
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


def _bt_root() -> dict[str, Json] | None:
    """Держатели с главной страницы bitcointreasuries.net.

    С октября 2026 сайт кладёт данные прямо в страницу — снимком своих
    запросов (bt-query-snapshot): держатели — entities.listOverviews,
    казначейства в других монетах — entities.getAltcoinHoldings. В
    __data.json осталась только оболочка, и раздел «Держатели» пропадал."""
    raw = _fetch(BT_PAGE, 30)
    m = _BT_SNAP.search(raw.decode("utf-8", "replace")) if raw else None
    snap = _parse(m.group(1).encode()) if m else None
    rpc: dict[str, Json] = {}
    for q in (snap.get("queries") if isinstance(snap, dict) else None) or []:
        if not isinstance(q, dict) or not isinstance(q.get("hash"), str):
            continue
        h = _parse(q["hash"].encode())
        if isinstance(h, list) and h and isinstance(h[0], dict) and isinstance(h[0].get("rpc"), str):
            rpc[h[0]["rpc"]] = q.get("data")
    ents = rpc.get("entities.listOverviews")
    if not isinstance(ents, list) or not ents:
        return None
    alts = {str(p[0]): p[1] for p in rpc.get("entities.getAltcoinHoldings") or []
            if isinstance(p, list) and len(p) == 2 and isinstance(p[1], dict)}
    return {"entities": ents, "altcoinHoldings": alts}


def _holders() -> dict[str, Json]:
    """Кто держит биткоин: группы (тип → число, монет, изменение за 7 дней),
    все держатели, крупнейшие движения недели, казначейства в других монетах."""
    root = _bt_root()
    if root is None:
        _log("bitcointreasuries.net: держателей в странице нет")
        return {}
    groups: dict[str, list[float]] = {}
    top: list[list[Json]] = []
    for e in root.get("entities") or []:
        if not isinstance(e, dict):
            continue
        h = next((x for x in e.get("holdings") or [] if isinstance(x, dict) and x.get("asset") == "BTC"), None)
        if not h:
            continue
        bal, d7 = _num(h.get("balance")), _num(h.get("balance_change_7d"))
        if bal <= 0 and d7 == 0:
            continue
        typ = str(e.get("type") or "OTHER")[:20]
        g = groups.setdefault(typ, [0, 0.0, 0.0])
        g[0] += 1
        g[1] += bal
        g[2] += d7
        tick = e["ticker"].get("symbol") if isinstance(e.get("ticker"), dict) else None
        flag = e["country"].get("flag") if isinstance(e.get("country"), dict) else None
        top.append([str(e.get("name") or "")[:60].strip(), typ, str(e.get("subtype") or "")[:20],
                    str(flag or "")[:8], str(tick or "")[:24], round(bal, 2), round(d7, 2), round(_num(e.get("cost_basis")))])
    top.sort(key=lambda r: -r[5])
    movers = sorted([r for r in top if r[6]], key=lambda r: -abs(r[6]))[:20]
    # Казначейства в других монетах: эфир, Solana, BNB, XRP.
    alts: dict[str, list[list[Json]]] = {}
    for slug, sym in (("ethereum", "eth"), ("solana", "sol"), ("bnb", "bnb"), ("xrp", "xrp")):
        holding = (root.get("altcoinHoldings") or {}).get(slug)
        ents = [e for e in (holding.get("entities") if isinstance(holding, dict) else None) or [] if isinstance(e, dict)]
        ents.sort(key=lambda e: -_num(e.get("balance")))
        lst: list[list[Json]] = [[str(e.get("name") or "")[:60].strip(), str(e.get("type") or "")[:20],
                                  round(_num(e.get("balance")), 2)] for e in ents]
        if lst:
            alts[sym] = lst
    # Все держатели, а не первые восемьдесят: экран фильтрует их по группам
    # и ищет по имени.
    return {"groups": sorted([[k, *v] for k, v in groups.items()], key=lambda g: -g[2]),
            "top": top, "movers": movers, "alts": alts, "eth": alts.get("eth", [])[:30]}


class _State:
    """Кэш модуля: (monotonic, ответ). Меняется только под _lock."""

    hit: tuple[float, dict[str, Json]] | None = None


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
        hold_f = pool.submit(_holders)
        cme_f = pool.submit(_cme)
        cbp_f = pool.submit(_cbp)
        for cat, f in futs.items():
            r = _part(cat, f, 90)
            if r:
                coins[cat] = r
        holders = _part("holders", hold_f, 60) or {}
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

"""Институциональные потоки — отдельный модуль API (/api/etf).

Что собирается — только биткоин:
  - потоки фондов по дням — открытый набор TFTC (tftc.io/bitcoin-etf-flows,
    лицензия CC BY 4.0: можно брать и показывать с подписью и ссылкой на
    источник — экран её показывает). Каждый торговый день с запуска фондов
    в январе 2024: итог дня и поток каждого фонда в долларах. Монеты —
    доллары по закрытию дня Binance;
  - фонды — спотовые биткоин-ETF США по их отчётам в SEC (wt_treasury):
    имя, комиссия, запас на конец последнего квартала. Запас сегодня —
    отчёт плюс потоки после него, минус комиссия, взятая монетами. Где фонд
    пишет в отчёте только стоимость монет, монеты — стоимость по цене,
    которую дают отчёты фондов с числом монет на ту же дату (их медиана;
    нет — закрытие Binance);
  - цена — закрытие Binance; доля фондов от добытых монет — своим счётом
    по расписанию эмиссии (supply_at);
  - крупнейшие держатели — фонды отсюда же и публичные компании по их
    отчётам в SEC (wt_treasury);
  - позиции на CME — еженедельный отчёт CFTC «Traders in Financial Futures»;
  - премия Coinbase к Binance — спрос американских покупателей.

Модуль независим: своя разметка кошельков фондов (сканер бота — для
рейтинга BTC, потоков бирж и алертов по сделкам кошельков) сюда не входит.
Наоборот, разметку сверяют с этими потоками (whale_api._btc_check) — только
чтобы проверить, верно ли размечено.

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
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any

import wt_treasury

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
HOSTS = frozenset({"data-api.binance.vision", "publicreporting.cftc.gov", "api.exchange.coinbase.com",
                   "www.tftc.io"})
# Потоки фондов по дням — открытый набор TFTC, CC BY 4.0 (см. начало модуля).
# Обновляется вечером и утром: раз в час (TTL) — с запасом.
TFTC = "https://www.tftc.io/bitcoin-etf-flows/data.json"
# Тикер фонда в наборе — заглавные буквы и цифры.
TICKER = re.compile(r"[A-Z0-9]{1,10}")
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


Day = tuple[dict[str, float], float]  # поток фонда $, итог дня $


def _tftc() -> tuple[dict[int, Day], dict[int, float], str]:
    """Дни набора TFTC: начало суток → (фонд → поток $, итог дня $), цена
    дня из набора (запасная к Binance) и «данные по» (дата). Нет набора или
    он битый — пусто. День без разбивки по фондам (праздник биржи) — с
    итогом, но без фондов; итога нет — сумма фондов."""
    got = _get(TFTC, 30)
    rows = got.get("days") if isinstance(got, dict) else None
    if not isinstance(rows, list):
        return {}, {}, ""
    days: dict[int, Day] = {}
    px: dict[int, float] = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        try:
            ts = _day(r.get("date"))
        except ValueError:
            continue
        per = r.get("perEtfUsd")
        by = {str(k): _num(v) for k, v in per.items()
              if v is not None and isinstance(k, str) and TICKER.fullmatch(k)} if isinstance(per, dict) else {}
        total = r.get("netFlowUsd")
        days[ts] = (by, _num(total) if total is not None else sum(by.values()))
        if _num(r.get("btcCloseUsd")) > 0:
            px[ts] = _num(r["btcCloseUsd"])
    through = got.get("updatedThrough")
    return days, px, through if isinstance(through, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", through) else ""


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
    """Доля фондов в биткоинах в обращении: их запас в монетах — к добытому
    по расписанию. Своя арифметика, без готовых цифр источника."""
    aum = sum(_num(f.get("aum")) for f in funds)
    if aum <= 0 or price <= 0:
        return {"share": None}
    return {"share": round(aum / price / supply_at(_now()) * 100, 3)}


def _median(xs: list[float]) -> float:
    xs = sorted(xs)
    n = len(xs)
    return 0.0 if not n else xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def _last_report(sec: dict[str, dict[str, Any]], px: dict[int, float]) -> dict[str, tuple[float, int]]:
    """Запас каждого фонда в монетах на дату последнего отчёта: (монет, дата).

    Где в отчёте только стоимость, монеты — стоимость по цене отчётов на ту
    дату: медиана «стоимость / монеты» у фондов, сдавших и то и другое (так
    фонды сами оценили монеты); нет таких — закрытие Binance."""
    out: dict[str, tuple[float, int]] = {}
    for t, f in sec.items():
        q = f.get("q") or {}
        for e in sorted(q, reverse=True):
            cnt, fv = q[e]
            if cnt:
                out[t] = (float(cnt), int(e))
                break
            ratios = [r[1] / r[0] for g in sec.values() if (r := (g.get("q") or {}).get(e)) and r[0] and r[1] and r[0] > 0]
            near = [d for d in px if d <= e and px[d] > 0]
            price = _median(ratios) or (px[max(near)] if near else 0.0)
            if fv is not None and price > 0:
                out[t] = (float(fv) / price, int(e))
                break
    return out


def _coin(cat: str, symbol: str) -> dict[str, Json] | None:
    """Потоки фондов по дням (TFTC), фонды и их запас (отчёты SEC плюс потоки
    после отчёта), доля от добытых монет."""
    if cat != "btc":
        return None
    days, tpx, through = _tftc()
    if not days:
        return None
    px = _klines(symbol, (min(days) - 2 * 86400) * 1000)
    for ts, p in tpx.items():
        px.setdefault(ts, p)  # нет свечи Binance — цена из набора
    last_px = px[max(px)] if px else 0.0
    sec = wt_treasury.etf_funds()
    reports = _last_report(sec, px)
    sums: dict[str, list[float]] = {}  # фонд → [$ с запуска, монет с запуска]
    for ts, (by, _) in days.items():
        p = px.get(ts, 0.0)
        for t, usd in by.items():
            acc = sums.setdefault(t, [0.0, 0.0])
            acc[0] += usd
            acc[1] += usd / p if p > 0 else 0.0
    funds: list[dict[str, Json]] = []
    for t in sorted(set(sums) | set(reports), key=lambda k: -abs((sums.get(k) or [0.0])[0])):
        info = sec.get(t) or {}
        fee = info.get("fee")
        btc = 0.0
        if t in reports:
            # Запас: отчёт плюс потоки дней после него минус комиссия, взятая
            # монетами (доля в год от запаса за прошедшие дни).
            btc, asof = reports[t]
            after = sum(by[t] / px[ts] for ts, (by, _) in days.items() if ts > asof and t in by and px.get(ts, 0) > 0)
            btc = max(0.0, (btc + after) * (1 - _num(fee) * max(0, _now() - asof) / (365 * 86400)))
        cu, cc = sums.get(t) or [0.0, 0.0]
        funds.append({
            "t": t, "n": str(info.get("n") or "")[:60], "c": "US",
            "fee": None if fee is None else round(float(fee) * 100, 3),
            "aum": round(btc * last_px), "hold": round(btc, 2), "cum": round(cu), "cumc": round(cc, 2),
        })
    rows = []
    for ts in sorted(days):
        by, tot = days[ts]
        p = px.get(ts, 0.0)
        per = [None if (v := by.get(str(f["t"]))) is None else round(v / 1000) for f in funds]
        rows.append([ts, round(tot / 1000), round(tot / p, 2) if p > 0 else 0.0, round(p, 4), per])
    return {"funds": funds, "days": rows, "px": round(last_px, 2), "through": through, **_share(funds, last_px)}


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


class _State:
    """Кэш модуля: (monotonic, ответ). Меняется только под _lock."""

    hit: tuple[float, dict[str, Json]] | None = None
    # Копия последнего ответа на диске (set_cache_file): после перезапуска
    # API экран получает её сразу, свежий ответ собирается в фоне.
    file: str | None = None


# Копия с диска старше этого не берётся.
FILE_MAX_AGE = 3 * 86400


def set_cache_file(path: str | None) -> None:
    """Где держать копию последнего ответа (None — нигде)."""
    _st.file = path


def _file_load() -> dict[str, Json] | None:
    path = _st.file
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            got = _parse(f.read().encode())
    except (OSError, ValueError):
        return None
    if not isinstance(got, dict) or not isinstance(got.get("v"), dict) or not got["v"].get("ok"):
        return None
    if _now() - _num(got.get("at")) > FILE_MAX_AGE:
        return None
    v: dict[str, Json] = got["v"]
    return v


def _file_save(res: dict[str, Json]) -> None:
    path = _st.file
    if not path:
        return
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"at": _now(), "v": res}, f, separators=(",", ":"))
        os.replace(tmp, path)
    except (OSError, TypeError, ValueError) as e:
        _log(f"копия на диске: {type(e).__name__}: {e}")
        with contextlib.suppress(OSError):
            os.remove(tmp)


def _holders(c: Json, companies: list[list[Any]]) -> list[list[Any]]:
    """«Крупнейшие держатели»: фонды (запас — как в списке фондов выше) и
    компании по их отчётам в SEC (wt_treasury), по убыванию запаса. Строка —
    [имя, FUND или COMPANY, страна, тикер, BTC, дата отчёта unix (у фонда 0:
    его запас — на сегодня)]."""
    rows: list[list[Any]] = []
    for f in (c or {}).get("funds") or []:
        hold = _num(f.get("hold"))
        if hold >= 1:
            rows.append([str(f.get("n") or f.get("t")), "FUND", str(f.get("c") or ""), str(f.get("t")), hold, 0])
    rows += [r for r in companies if isinstance(r, list) and len(r) == 6]
    rows.sort(key=lambda r: -float(r[4]))
    return rows


def peek() -> dict[str, Json] | None:
    """Готовый ответ из кэша, без сборки: для сверки разметки кошельков
    фондов (whale_api._btc_check) — она не ждёт сборку и не запускает её."""
    with _lock:
        return _st.hit[1] if _st.hit else None


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
    _file_save(res)
    return res


def _bg() -> None:
    try:
        build()
    except Exception as e:  # noqa: BLE001 — фоновый поток не должен умирать молча
        _log(f"сборка: {type(e).__name__}: {e}")
    finally:
        _busy.clear()


def etf_data() -> dict[str, Json]:
    """Ответ /api/etf: из кэша, свежий собирается в фоне одним потоком.
    После перезапуска — копия с диска (как устаревшая), свежий — в фоне."""
    if _st.hit is None and _st.file:
        saved = _file_load()
        with _lock:
            if _st.hit is None and saved is not None:
                _st.hit = (time.monotonic() - TTL - 1.0, saved)
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

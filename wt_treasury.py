"""Биткоины публичных компаний и биржевых фондов — из их официальной
отчётности в SEC.

Компании США сдают в SEC (американский регулятор) квартальные (10-Q) и
годовые (10-K) отчёты. С 2025 года число монет компания показывает
стандартным полем отчётности us-gaap:CryptoAssetNumberOfUnits; SEC отдаёт
его открыто (data.sec.gov, «companyconcept»), это государственные открытые
данные. Чужих сводок и сайтов самих компаний модуль не читает.

Компании — список ниже (COMPANIES): только те, кто это поле действительно
заполняет. MARA, Tesla, Coinbase и другие его не сдают — их здесь нет.
CleanSpark поле сдаёт, но цифры не сходятся с его же отчётами (1 641 BTC
в первом квартале 2026 г., 1 719 000 — во втором) — тоже нет.
Цифра — на дату последнего отчёта (end), она и показывается на экране.

Поле компании заполняют по-разному: монеты бывают в единицах «Bitcoin»,
«bitcoin», «BTC», «item»… (UNITS), а встречаются и опечатки масштаба
(GameStop: «1» в годовом отчёте между 4 710 и 4 709). Значение, которое отличается от прошлого отчёта больше чем в
JUMP раз, не берём — остаётся прошлое.

Фонды (ETF, список ETFS) сдают в SEC те же квартальные и годовые отчёты.
Поля у фондов разные: число монет — CryptoAssetNumberOfUnits или
InvestmentOwnedBalanceContracts (у IBIT, ARKB, GBTC, BTC, EZBC), у
остальных — только стоимость монет в долларах (CryptoAssetFairValue,
InvestmentOwnedAtFairValue). fund_points отдаёт по фонду запас на конец
каждого квартала как есть (монеты и/или доллары) и комиссию; в монеты
доллары переводит wt_etf — по цене, которую дают сами отчёты.

SEC требует, чтобы в запросе было видно, кто спрашивает (User-Agent с
почтой для связи): строку берём из окружения WT_SEC_UA. Её нет — компании
не собираются. Не больше 10 запросов в секунду — у нас десяток раз в
полсуток.

Безопасность — как у wt_etf: только https к data.sec.gov, без
перенаправлений и прокси из окружения, ответ ограничен по размеру, JSON без
NaN и бесконечностей. Снаружи модуль ничего не принимает.
"""
from __future__ import annotations

import calendar
import contextlib
import http.client
import json
import math
import os
import sys
import threading
import time
import urllib.parse
import urllib.request
from typing import Any

# (тикер, имя, страна, CIK в SEC).
COMPANIES: tuple[tuple[str, str, str, int], ...] = (
    ("MSTR", "Strategy", "US", 1050446),
    ("XXI", "Twenty One Capital", "US", 2070457),
    ("HUT", "Hut 8", "US", 1964789),
    ("RIOT", "Riot Platforms", "US", 1167419),
    ("XYZ", "Block", "US", 1512673),
    ("ABTC", "American Bitcoin", "US", 1755953),
    ("NAKA", "Nakamoto", "US", 1946573),
    ("GME", "GameStop", "US", 1326380),
    ("FLD", "Fold Holdings", "US", 1889123),
)
# Спотовые биткоин-ETF США: (тикер, имя, CIK в SEC).
ETFS: tuple[tuple[str, str, int], ...] = (
    ("IBIT", "iShares Bitcoin Trust", 1980994),
    ("FBTC", "Fidelity Wise Origin Bitcoin Fund", 1852317),
    ("GBTC", "Grayscale Bitcoin Trust", 1588489),
    ("BTC", "Grayscale Bitcoin Mini Trust", 2015034),
    ("ARKB", "ARK 21Shares Bitcoin ETF", 1869699),
    ("BITB", "Bitwise Bitcoin ETF", 1763415),
    ("HODL", "VanEck Bitcoin ETF", 1838028),
    ("BRRR", "CoinShares Bitcoin ETF", 1841175),
    ("EZBC", "Franklin Bitcoin ETF", 1992870),
    ("BTCO", "Invesco Galaxy Bitcoin ETF", 1855781),
    ("BTCW", "WisdomTree Bitcoin Fund", 1850391),
    ("MSBT", "Morgan Stanley Bitcoin Trust", 2103612),
)
# Поля фонда: число монет (с единицами) и стоимость монет в долларах — по
# порядку предпочтения; комиссия — доля в год.
ETF_COUNT = (("CryptoAssetNumberOfUnits", frozenset({"Bitcoin", "bitcoin", "BTC", "pure"})),
             ("InvestmentOwnedBalanceContracts", frozenset({"Bitcoin", "bitcoin", "BTC", "pure", "Number", "NUMBER"})))
ETF_FAIR = ("CryptoAssetFairValue", "InvestmentOwnedAtFairValue", "InvestmentInPhysicalCommoditiesFairValueDisclosure")
ETF_FEE = ("InvestmentCompanyExpenseRatioIncludingIncentiveFee", "InvestmentCompanyExpenseRatioBeforeIncentiveAllocation",
           "InvestmentCompanyExpenseRatioExcludingIncentiveFee", "InvestmentCompanyExpenseRatioAfterIncentiveAllocation")
# Отчёты фондов — с конца 2023 г. (запас GBTC до перехода в ETF — точка отсчёта).
ETF_FROM = "2023-12-31"
# Единицы, в которых компании пишут число биткоинов.
UNITS = frozenset({"Bitcoin", "bitcoin", "BTC", "Btcoin", "Bitcoins", "bitcoinUnit", "item", "Integer"})
JUMP = 20.0
# Меньше — не прошлый запас, а случайная цифра (GameStop: «1» в годовом).
JUMP_FLOOR = 10.0
HOST = "data.sec.gov"
BODY_MAX = 4 << 20
TTL = 12 * 3600.0
PAUSE = 0.2

Json = Any


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect, urllib.request.HTTPSHandler())


def _log(msg: str) -> None:
    clean = "".join(c if c.isprintable() else "?" for c in msg)
    with contextlib.suppress(OSError, ValueError):
        print(f"treasury: {clean[:300]}", file=sys.stderr)


def _ua() -> str:
    """Подпись запроса для SEC: из окружения, только печатные символы, с почтой."""
    ua = os.environ.get("WT_SEC_UA", "").strip()
    return ua if ua.isprintable() and "@" in ua and len(ua) <= 200 else ""


def _fetch(url: str, timeout: float) -> bytes | None:
    u = urllib.parse.urlsplit(url)
    ua = _ua()
    if u.scheme != "https" or u.hostname != HOST or u.username or u.password or not ua:
        return None
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept-Encoding": "identity"})
    try:
        with _opener.open(req, timeout=timeout) as r:
            body: bytes = r.read(BODY_MAX + 1)
    except (OSError, ValueError, http.client.HTTPException):
        return None
    return body if len(body) <= BODY_MAX else None


def _finite(text: str) -> float:
    v = float(text)
    if not math.isfinite(v):
        raise ValueError("не конечное число")
    return v


def _no_constant(name: str) -> float:
    raise ValueError(f"{name} в JSON")


_DECODER = json.JSONDecoder(parse_float=_finite, parse_constant=_no_constant)


def _parse(raw: bytes | None) -> Json:
    if not raw:
        return None
    try:
        return _DECODER.decode(raw.decode())
    except (ValueError, RecursionError):
        return None


def _day(s: object) -> int:
    """'2026-06-30' → unix полночь UTC; не дата — 0."""
    if not isinstance(s, str):
        return 0
    try:
        return calendar.timegm(time.strptime(s, "%Y-%m-%d")) if len(s) == 10 else 0
    except (ValueError, OverflowError):
        return 0


def holding(concept: Json) -> tuple[float, int] | None:
    """Запас по ответу companyconcept: (BTC, дата отчёта unix) или None.

    Берём отчёты 10-Q и 10-K (и их поправки) в единицах UNITS; на дату — то,
    что сдано позже всего. Идём от свежей даты назад: значение, которое
    скачет больше чем в JUMP раз от предыдущей даты, пропускаем."""
    units = concept.get("units") if isinstance(concept, dict) else None
    if not isinstance(units, dict):
        return None
    by_end: dict[int, tuple[str, float]] = {}
    for unit, rows in units.items():
        if unit not in UNITS or not isinstance(rows, list):
            continue
        for r in rows:
            if not isinstance(r, dict) or not str(r.get("form") or "").startswith("10-"):
                continue
            end, val, filed = _day(r.get("end")), r.get("val"), str(r.get("filed") or "")
            if not end or isinstance(val, bool) or not isinstance(val, (int, float)) or not 0 <= val < 3_000_000:
                continue
            if end not in by_end or filed >= by_end[end][0]:
                by_end[end] = (filed, float(val))
    ends = sorted(by_end, reverse=True)
    for i, end in enumerate(ends):
        v = by_end[end][1]
        prev = by_end[ends[i + 1]][1] if i + 1 < len(ends) else None
        if prev is not None and prev >= JUMP_FLOOR and (v > prev * JUMP or v * JUMP < prev):
            continue
        return v, end
    return None


class _State:
    hit: tuple[float, list[list[Any]]] | None = None


_st = _State()
_lock = threading.Lock()


def _build() -> list[list[Any]]:
    out: list[list[Any]] = []
    for i, (ticker, name, country, cik) in enumerate(COMPANIES):
        if i:
            time.sleep(PAUSE)
        got = _parse(_fetch(f"https://{HOST}/api/xbrl/companyconcept/CIK{cik:010d}/us-gaap/CryptoAssetNumberOfUnits.json", 20))
        h = holding(got)
        if h and h[0] >= 1:
            out.append([name, "COMPANY", country, ticker, round(h[0], 2), h[1]])
    return out


def companies() -> list[list[Any]]:
    """Компании: [имя, "COMPANY", страна, тикер, BTC, дата отчёта unix].

    Собирается раз в TTL; не собралось (нет WT_SEC_UA, SEC молчит) — прошлое.
    Зовёт сборка экрана ETF из своего фонового потока."""
    with _lock:
        hit = _st.hit
    if hit and time.monotonic() - hit[0] < TTL:
        return hit[1]
    if not _ua():
        return hit[1] if hit else []
    rows = _build()
    if not rows:
        # SEC не ответил — прошлое (или пусто); спросим снова со следующей сборкой.
        _log("SEC не ответил")
        return hit[1] if hit else []
    with _lock:
        _st.hit = (time.monotonic(), rows)
    return rows


def _quarter_end(s: str) -> bool:
    return len(s) == 10 and s[5:] in ("03-31", "06-30", "09-30", "12-31")


def _latest(rows: Json, units: frozenset[str] | None, unit_rows: Json = None) -> dict[str, float]:
    """Мгновенные значения на концы кварталов из 10-Q/10-K: дата → значение,
    на дату — сданное позже всего."""
    best: dict[str, tuple[str, float]] = {}
    for unit, items in (rows.items() if isinstance(rows, dict) else ()):
        if (units is not None and unit not in units) or not isinstance(items, list):
            continue
        for r in items:
            if not isinstance(r, dict) or "start" in r or not str(r.get("form") or "").startswith("10-"):
                continue
            end, val, filed = str(r.get("end") or ""), r.get("val"), str(r.get("filed") or "")
            if not _quarter_end(end) or end < ETF_FROM or isinstance(val, bool) or not isinstance(val, (int, float)):
                continue
            if not math.isfinite(val) or val < 0:
                continue
            if end not in best or filed >= best[end][0]:
                best[end] = (filed, float(val))
    return {k: v[1] for k, v in best.items()}


def fund_points(facts: Json) -> dict[str, Any]:
    """Отчёты фонда по ответу companyfacts: {"q": {дата конца квартала unix:
    [монет или None, долларов или None]}, "fee": доля в год или None}."""
    root = facts.get("facts") if isinstance(facts, dict) else None
    g = root.get("us-gaap") if isinstance(root, dict) else None
    if not isinstance(g, dict):
        return {"q": {}, "fee": None}

    def units(tag: str) -> Json:
        item = g.get(tag)
        return item.get("units") if isinstance(item, dict) else None
    count: dict[str, float] = {}
    for tag, us in ETF_COUNT:
        for end, v in _latest(units(tag), us).items():
            # Десяток монет посевного взноса до запуска — не запас фонда.
            if v >= 100:
                count.setdefault(end, v)
    fair: dict[str, float] = {}
    for tag in ETF_FAIR:
        for end, v in _latest(units(tag), frozenset({"USD"})).items():
            fair.setdefault(end, v)
    fee: float | None = None
    fee_end = ""
    for tag in ETF_FEE:
        for r in ((units(tag) or {}).get("pure") or []) if isinstance(units(tag), dict) else []:
            if not isinstance(r, dict) or "start" not in r:
                continue
            val, end = r.get("val"), str(r.get("end") or "")
            if isinstance(val, (int, float)) and not isinstance(val, bool) and 0 < val < 0.03 and end >= fee_end:
                fee, fee_end = float(val), end
    q: dict[int, list[float | None]] = {}
    for end in sorted(set(count) | set(fair)):
        q[calendar.timegm(time.strptime(end, "%Y-%m-%d"))] = [count.get(end), fair.get(end)]
    return {"q": q, "fee": fee}


class _FundState:
    hit: tuple[float, dict[str, dict[str, Any]]] | None = None


_fst = _FundState()


def etf_funds() -> dict[str, dict[str, Any]]:
    """Фонды: тикер → {"n": имя, "q": отчёты на концы кварталов, "fee"}.

    Собирается раз в TTL; не собралось (нет WT_SEC_UA, SEC молчит) — прошлое.
    Фонд, чей отчёт не прочитался, берётся из прошлой сборки."""
    with _lock:
        hit = _fst.hit
    if hit and time.monotonic() - hit[0] < TTL:
        return hit[1]
    if not _ua():
        return hit[1] if hit else {}
    out: dict[str, dict[str, Any]] = {}
    for i, (ticker, name, cik) in enumerate(ETFS):
        if i:
            time.sleep(PAUSE)
        p = fund_points(_parse(_fetch(f"https://{HOST}/api/xbrl/companyfacts/CIK{cik:010d}.json", 30)))
        if p["q"]:
            out[ticker] = {"n": name, **p}
        elif hit and ticker in hit[1]:
            out[ticker] = hit[1][ticker]
    if not out:
        _log("SEC не ответил (фонды)")
        return hit[1] if hit else {}
    with _lock:
        _fst.hit = (time.monotonic(), out)
    return out

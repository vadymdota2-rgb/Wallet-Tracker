"""Институциональные потоки — отдельный модуль API (/api/etf).

Что собирается — только биткоин:
  - потоки фондов по дням — открытый набор TFTC (tftc.io/bitcoin-etf-flows,
    лицензия CC BY 4.0: можно брать и показывать с подписью и ссылкой на
    источник и лицензию — их показывают экран потоков и дайджест, а сам
    ответ /api/etf несёт их в поле by). Каждый торговый день с запуска фондов
    в январе 2024: итог дня и поток каждого фонда в долларах, цена закрытия
    дня. Монеты — доллары по этой цене;
  - фонды — спотовые биткоин-ETF США по их отчётам в SEC (wt_treasury):
    имя, комиссия, запас на конец последнего квартала. Запас сегодня —
    отчёт плюс потоки после него, минус комиссия, взятая монетами. Где фонд
    пишет в отчёте только стоимость монет, монеты — стоимость по цене,
    которую дают отчёты фондов с числом монет на ту же дату (их медиана;
    нет — закрытие дня из набора);
  - цена — закрытие дня из набора TFTC; доля фондов от добытых монет —
    своим счётом по расписанию эмиссии (supply_at);
  - крупнейшие держатели — фонды отсюда же и публичные компании по их
    отчётам в SEC (wt_treasury);
  - позиции на CME — еженедельный отчёт CFTC «Traders in Financial Futures».

Только открытые источники: TFTC (CC BY 4.0), SEC и CFTC (госданные США).
Цен бирж здесь нет: условия Coinbase и Binance запрещают показывать их
данные (и расчёты на их основе) в приложении для пользователей без
письменного согласия.

Модуль независим: метки кошельков фондов в боте (список фонда и /import —
подпись в крупных сделках и рейтинге BTC) с ним не связаны никак.

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
import urllib.parse
import urllib.request
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, NamedTuple

import wt_treasury

# Сколько ответ живёт в кэше, с: фонды отчитываются раз в сутки.
TTL = 3600.0
# Позиции на CME: код контракта CFTC → размер контракта в биткоинах (большой
# и микро складываются в монетах: у них разный размер).
CME_CODES = (("133741", 5.0), ("133742", 0.1))
# Правдоподобие отчёта CFTC: позиция группы и открытый интерес — до стольких
# BTC (весь рынок фьючерсов CME — около 150 тыс.); дата — с запуска фьючерсов.
CME_MAX = 2_000_000.0
CME_FROM = 1_513_036_800  # 12 декабря 2017 г.
CME_FIELDS = ("open_interest_all", "asset_mgr_positions_long", "asset_mgr_positions_short",
              "lev_money_positions_long", "lev_money_positions_short",
              "dealer_positions_long_all", "dealer_positions_short_all",
              "nonrept_positions_long_all", "nonrept_positions_short_all")

# Куда модулю можно ходить — и больше никуда.
HOSTS = frozenset({"publicreporting.cftc.gov", "www.tftc.io"})
# Потоки фондов по дням — открытый набор TFTC, CC BY 4.0 (см. начало модуля).
# Обновляется вечером и утром: раз в час (TTL) — с запасом.
TFTC = "https://www.tftc.io/bitcoin-etf-flows/data.json"
# Подпись, которую просит набор (поле attribution) и условие лицензии: она
# идёт в каждом ответе /api/etf — ответ открыт, его может взять кто угодно.
TFTC_BY = "TFTC — tftc.io/bitcoin-etf-flows (CC BY 4.0: creativecommons.org/licenses/by/4.0/)"
# Тикер фонда в наборе — заглавные буквы и цифры; дата — ГГГГ-ММ-ДД. Цифры —
# только ASCII: \d в Python пропустил бы и «２０２６» (полноширинные), а
# приложение (JavaScript) такую дату не примет.
TICKER = re.compile(r"[A-Z0-9]{1,10}")
DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
# Начало торгов спотовыми биткоин-ETF в США — 11 января 2024 г.
ETF_LAUNCH = 1_704_931_200
# Пределы правдоподобия строки набора: поток всех фондов за день и одного
# фонда, $ (рекорд — около $1,4 млрд за день), цена BTC.
DAY_MAX = 50e9
FUND_MAX = 25e9
PX_MIN, PX_MAX = 1_000.0, 10_000_000.0
# Своя оценка запаса фондов и сводка набора расходятся больше этого — в журнал.
SPLIT_MAX = 0.1
# Активы всех фондов за день, $ (правдоподобные: от $1 млрд до $10 трлн).
TNA_MIN, TNA_MAX = 1e9, 1e13
# Запас одного фонда по отчёту — не больше этого, BTC (у крупнейшего ~0,8
# млн); больше — ошибка в отчёте, такого запаса нет.
HOLD_MAX = 5_000_000.0
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


def _fetch(url: str, timeout: float) -> bytes | None:
    """GET. Любая ошибка сети и ответ больше BODY_MAX — None."""
    if not _allowed(url):
        return None
    try:
        with _opener.open(urllib.request.Request(url, headers=_HEADERS), timeout=timeout) as r:
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
    """Начало суток UTC из даты «2026-09-29» (у CFTC — «2026-09-29T00:00:00.000»);
    не дата — ValueError. Цифры — только ASCII (как DATE): strptime пустил бы
    и «２０２６»."""
    if not isinstance(stamp, str) or not DATE.fullmatch(stamp[:10]):
        raise ValueError("не дата")
    return calendar.timegm(time.strptime(stamp[:10], "%Y-%m-%d"))


Day = tuple[dict[str, float], float]  # поток фонда $, итог дня $


class Tftc(NamedTuple):
    """Разобранный набор TFTC."""

    days: dict[int, Day]
    # Цена закрытия дня из набора и активы всех фондов, $ (с мая 2025).
    px: dict[int, float]
    tna: dict[int, float]
    # «Данные по» — дата ГГГГ-ММ-ДД или пусто.
    through: str


def _tftc() -> Tftc:
    """Дни набора TFTC: начало суток → (фонд → поток $, итог дня $), цена
    дня, активы фондов и «данные по». Нет набора или он битый — пусто.

    Итог дня — сумма фондов: так итог, фонды и «с запуска» на экране
    сходятся до доллара (сводка набора в редкие дни расходится с фондами на
    единицы процентов). Нет разбивки по фондам — итог набора; день без
    разбивки и с нулём — праздник биржи, торгов не было, его нет. Строка,
    которой не бывает (дата вне торгов фондов, поток или цена за пределами
    правдоподобного), пропускается."""
    got = _get(TFTC, 30)
    rows = got.get("days") if isinstance(got, dict) else None
    if not isinstance(rows, list):
        return Tftc({}, {}, {}, "")
    days: dict[int, Day] = {}
    px: dict[int, float] = {}
    tna: dict[int, float] = {}
    last = _now() + 86400
    for r in rows:
        if not isinstance(r, dict) or not isinstance(r.get("date"), str) or not DATE.fullmatch(r["date"]):
            continue
        try:
            ts = _day(r["date"])
        except ValueError:
            continue
        per = r.get("perEtfUsd")
        by = {str(k): _num(v) for k, v in per.items()
              if v is not None and isinstance(k, str) and TICKER.fullmatch(k)} if isinstance(per, dict) else {}
        total = sum(by.values()) if by else _num(r.get("netFlowUsd"))
        if not ETF_LAUNCH <= ts <= last or (not by and total == 0) or abs(total) > DAY_MAX \
                or any(abs(v) > FUND_MAX for v in by.values()):
            continue
        days[ts] = (by, total)
        if PX_MIN <= _num(r.get("btcCloseUsd")) <= PX_MAX:
            px[ts] = _num(r["btcCloseUsd"])
        if TNA_MIN <= _num(r.get("totalNetAssetsUsd")) <= TNA_MAX:
            tna[ts] = _num(r["totalNetAssetsUsd"])
    through = got.get("updatedThrough")
    return Tftc(days, px, tna, through if isinstance(through, str) and DATE.fullmatch(through) else "")


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


def _share(aum: float, price: float) -> dict[str, Json]:
    """Доля фондов в биткоинах в обращении: их активы в монетах — к добытому
    по расписанию."""
    if aum <= 0 or price <= 0:
        return {"share": None}
    return {"share": round(aum / price / supply_at(_now()) * 100, 3)}


def _median(xs: list[float]) -> float:
    xs = sorted(xs)
    n = len(xs)
    return 0.0 if not n else xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def _point(f: dict[str, Any], e: int) -> tuple[float, float]:
    """Отчёт фонда на дату: (монет, долларов); чего нет — ноль."""
    p = f["q"].get(e)
    return (_num(p[0]), _num(p[1])) if isinstance(p, (list, tuple)) and len(p) == 2 else (0.0, 0.0)


def _sec(got: object) -> dict[str, dict[str, Any]]:
    """Фонды из wt_treasury — только с тикером как в наборе и с отчётами."""
    if not isinstance(got, dict):
        return {}
    return {t: f for t, f in got.items() if isinstance(t, str) and TICKER.fullmatch(t)
            and isinstance(f, dict) and isinstance(f.get("q"), dict)}


def _last_report(sec: dict[str, dict[str, Any]], px: dict[int, float]) -> dict[str, tuple[float, int]]:
    """Запас каждого фонда в монетах на дату последнего правдоподобного отчёта:
    (монет, дата).

    Где в отчёте только стоимость, монеты — стоимость по цене отчётов на ту
    дату: медиана «стоимость / монеты» у фондов, сдавших и то и другое (так
    фонды сами оценили монеты); нет таких — закрытие дня из набора."""
    out: dict[str, tuple[float, int]] = {}
    for t, f in sec.items():
        for e in sorted((e for e in f["q"] if isinstance(e, int)), reverse=True):
            cnt, usd = _point(f, e)
            btc = cnt
            if not cnt and usd > 0:
                ratios = [v / c for c, v in (_point(g, e) for g in sec.values()) if c > 0 and v > 0]
                near = [d for d in px if d <= e and px[d] > 0]
                price = _median(ratios) or (px[max(near)] if near else 0.0)
                btc = usd / price if price > 0 else 0.0
            # Отчёт, которого не бывает (запас больше HOLD_MAX, ноль), — мимо:
            # запас считается от прошлого квартала.
            if 0 < btc <= HOLD_MAX:
                out[t] = (btc, e)
                break
    return out


def _coin(sec_of: Callable[[], object] | None = None) -> dict[str, Json] | None:
    """Потоки фондов по дням (TFTC), фонды и их запас (отчёты SEC плюс потоки
    после отчёта), активы всех фондов по дням (TFTC), доля от добытых монет.

    sec_of — откуда взять отчёты фондов (по умолчанию wt_treasury.etf_funds):
    сборка спрашивает SEC параллельно и не ждёт его дольше SEC_WAIT."""
    days, px, tna, through = _tftc()
    if not days:
        return None
    last_px = px[max(px)] if px else 0.0
    sec = _sec(sec_of() if sec_of else wt_treasury.etf_funds())
    reports = _last_report(sec, px)
    sums: dict[str, list[float]] = {}  # фонд → [$ с запуска, монет с запуска]
    for ts, (by, _) in days.items():
        p = px.get(ts, 0.0)
        for t, usd in by.items():
            acc = sums.setdefault(t, [0.0, 0.0])
            acc[0] += usd
            acc[1] += usd / p if p > 0 else 0.0
    funds: list[dict[str, Json]] = []
    # По модулю потока «с запуска»; при равенстве — по тикеру (порядок
    # столбцов в днях не зависит от порядка ответа SEC).
    for t in sorted(set(sums) | set(reports), key=lambda k: (-abs((sums.get(k) or [0.0])[0]), k)):
        info = sec.get(t) or {}
        fee = _num(info.get("fee"))
        fee = fee if 0 < fee < wt_treasury.FEE_MAX else 0.0
        btc = 0.0
        if t in reports:
            # Запас: отчёт плюс потоки дней после него минус комиссия, взятая
            # монетами (доля в год от запаса за прошедшие дни).
            btc, asof = reports[t]
            after = sum(by[t] / px[ts] for ts, (by, _) in days.items() if ts > asof and t in by and px.get(ts, 0) > 0)
            btc = max(0.0, (btc + after) * (1 - fee * max(0, _now() - asof) / (365 * 86400)))
        cu, cc = sums.get(t) or [0.0, 0.0]
        funds.append({
            "t": t, "n": str(info.get("n") or "")[:60], "c": "US",
            "fee": round(fee * 100, 3) if fee else None,
            "aum": round(btc * last_px), "hold": round(btc, 2), "cum": round(cu), "cumc": round(cc, 2),
        })
    rows = []
    for ts in sorted(days):
        by, tot = days[ts]
        p = px.get(ts, 0.0)
        per = [None if (v := by.get(str(f["t"]))) is None else round(v / 1000) for f in funds]
        rows.append([ts, round(tot / 1000), round(tot / p, 2) if p > 0 else 0.0, round(p, 4), per])
    # Активы всех фондов — по сводке набора, если она свежая (не старше
    # недели от последнего дня); иначе — сумма своих оценок по фондам.
    aum = sum(_num(f["aum"]) for f in funds)
    if tna and max(tna) >= max(days) - 7 * 86400 and px.get(max(tna)):
        own = sum(_num(f["hold"]) for f in funds)
        held = tna[max(tna)] / px[max(tna)]
        # Сверка: своя оценка запаса (SEC + потоки) против сводки. Расхождение
        # больше SPLIT_MAX — сбой в отчётах или в наборе; видно в журнале.
        if own > 0 and abs(own / held - 1) > SPLIT_MAX:
            _log(f"запас: свой {own:,.0f} BTC, по сводке {held:,.0f} BTC")
        aum = held * last_px
    return {"funds": funds, "days": rows, "px": round(last_px, 2), "through": through,
            "tna": [[ts, round(tna[ts])] for ts in sorted(tna)], **_share(aum, last_px)}


def _cme() -> dict[str, Json]:
    """Позиции на CME по отчёту CFTC — раз в неделю (по вторникам, выходит в
    пятницу), открытый API CFTC (Socrata)."""
    codes = [c for c, _ in CME_CODES]
    q = urllib.parse.urlencode({
        "$select": "cftc_contract_market_code,report_date_as_yyyy_mm_dd," + ",".join(CME_FIELDS),
        "$where": "cftc_contract_market_code in (" + ",".join(f"'{c}'" for c in codes) + ")",
        "$order": "report_date_as_yyyy_mm_dd ASC",
        "$limit": "5000",
    })
    rows = _get("https://publicreporting.cftc.gov/resource/gpe5-46if.json?" + q, 30)
    if not isinstance(rows, list) or not rows:
        return {}
    unit = dict(CME_CODES)
    acc: dict[int, list[float]] = {}
    for r in rows:
        if not isinstance(r, dict) or r.get("cftc_contract_market_code") not in unit:
            continue
        u = unit[r["cftc_contract_market_code"]]
        try:
            ts = _day(r.get("report_date_as_yyyy_mm_dd"))
        except (TypeError, ValueError):
            continue
        vals = [_num(r.get(f)) * u for f in CME_FIELDS]
        # Отчёт, которого не бывает (дата вне торгов, отрицательная или
        # огромная позиция), — мимо: одна строка исказила бы всю неделю.
        if not CME_FROM <= ts <= _now() or any(not 0 <= v <= CME_MAX for v in vals):
            continue
        cur = acc.setdefault(ts, [0.0] * len(CME_FIELDS))
        for i, v in enumerate(vals):
            cur[i] += v
    weeks = [[ts, *[round(v, 1) for v in acc[ts]]] for ts in sorted(acc) if all(v <= CME_MAX for v in acc[ts])]
    return {"btc": weeks} if weeks else {}


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


def _company(r: object) -> bool:
    """Строка компании от wt_treasury: [имя, "COMPANY", страна, тикер, BTC,
    дата отчёта unix] — с правдоподобным запасом. Иное — мимо, а не сбой сборки."""
    return (isinstance(r, list) and len(r) == 6 and isinstance(r[0], str) and r[1] == "COMPANY"
            and isinstance(r[2], str) and isinstance(r[3], str) and TICKER.fullmatch(r[3]) is not None
            and 1 <= _num(r[4]) <= HOLD_MAX and isinstance(r[5], int) and not isinstance(r[5], bool) and r[5] > 0)


def _holders(c: Json, companies: object) -> list[list[Any]]:
    """«Крупнейшие держатели»: фонды (запас — как в списке фондов выше) и
    компании по их отчётам в SEC (wt_treasury), по убыванию запаса (при
    равенстве — по тикеру). Строка — [имя, FUND или COMPANY, страна, тикер,
    BTC, дата отчёта unix (у фонда 0: его запас — на сегодня)]."""
    rows: list[list[Any]] = []
    for f in (c or {}).get("funds") or []:
        hold = _num(f.get("hold"))
        if hold >= 1:
            rows.append([str(f.get("n") or f.get("t")), "FUND", str(f.get("c") or ""), str(f.get("t")), hold, 0])
    rows += [r for r in companies if _company(r)] if isinstance(companies, list) else []
    rows.sort(key=lambda r: (-_num(r[4]), r[3]))
    return rows


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


# Сколько ждать части сборки, с — общий срок для всех; не уложилась — её
# нет (см. build).
PART_WAIT = 90.0
# Отчёты фондов в SEC обновляются раз в полсуток (wt_treasury.TTL), и тогда
# это десяток медленных запросов: потоки их ждут не дольше этого, дальше —
# прошлые отчёты (wt_treasury.funds_cached), а свежие подхватит следующая сборка.
SEC_WAIT = 45.0


def build() -> dict[str, Json]:
    """Собрать ответ из сети и положить в кэш."""
    pool = ThreadPoolExecutor(max_workers=4)
    try:
        sec_f = pool.submit(wt_treasury.etf_funds)
        btc_f = pool.submit(_coin, lambda: _part("sec", sec_f, SEC_WAIT) or wt_treasury.funds_cached())
        cme_f = pool.submit(_cme)
        co_f = pool.submit(wt_treasury.companies)
        end = time.monotonic() + PART_WAIT

        def left() -> float:
            return max(0.0, end - time.monotonic())
        btc = _part("btc", btc_f, left())
        cme = _part("cme", cme_f, left()) or {}
        companies = _part("companies", co_f, left()) or []
    finally:
        # Зависшую часть не ждём: её поток закончится сам по таймауту сети
        # (SEC при этом дозаполнит свой кэш — к следующей сборке).
        pool.shutdown(wait=False, cancel_futures=True)
    with _lock:
        was = _st.hit[1] if _st.hit else {}
    # Часть, которой в этот раз нет, — из прошлой сборки, а не пропадает с экрана.
    if not btc:
        btc = (was.get("coins") or {}).get("btc")
    if not btc:
        return {"ok": False, "error": "no_data"}
    coins = {"btc": btc}
    res = {"ok": True, "coins": coins, "holders": _holders(coins.get("btc"), companies),
           "cme": cme or was.get("cme") or {}, "by": TFTC_BY, "at": _now()}
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

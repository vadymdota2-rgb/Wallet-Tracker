"""Доминация — доля биткоина, эфира, USDT и альтов во всём рынке (/api/mcap).

Капитализацию всех монет открыто не считает никто, поэтому берём её из
официального API CoinMarketCap (pro-api.coinmarketcap.com) по ключу. Его
бесплатный план Basic даёт право коммерческого использования: один продукт,
до 100 тыс. пользователей, данные — часть приложения, а не отдельная выдача
(coinmarketcap.com/api/pricing). Неофициальные адреса сайта CoinMarketCap —
нельзя: их условия запрещают такое использование.

Права: данные CoinMarketCap используются только внутри приложения и с
подписью источника («по данным CoinMarketCap» на экране). Наружу уходят не
сырые ответы, а числа для экрана: доли и капитализация сейчас и их история
по дням (её отдаёт сам CoinMarketCap на бесплатном плане; у нас — лишь копия
последнего ответа для экрана, своей базы из их данных не строим, отдельной
выдачей не отдаём). Лицензия бесплатного плана — до 100 тыс. пользователей;
больше — нужен платный план.

Ключ — только из окружения (CMC_API_KEY в /etc/whale-api.env): в коде, ответе
и журнале его нет. Ключа нет — ответ «нет ключа» (error: no_key), экран
блок доминации просто не показывает.

Два запроса раз в TTL (час): общие цифры рынка (1 кредит) и USDT (1 кредит);
история рынка по дням с 2013 г. — раз в HIST_TTL (12 ч, ~50 кредитов).
Всего около 4500 кредитов в месяц из 15 000 бесплатных. Доли — как их
считает CoinMarketCap, со вчерашними значениями для изменения за сутки.

  - BTC, ETH — доля в капитализации всего рынка, %;
  - альты — всё, кроме биткоина (100 − BTC), и без стейблкоинов тоже;
  - USDT — доля USDT (его капитализация к капитализации рынка);
  - hist — по дням: [начало суток UTC, капитализация рынка $, доля BTC %,
    доля ETH % или None]; за последние HIST_DAILY дней — каждый день,
    раньше — раз в неделю (на графике всё равно не больше 600 точек).

Безопасность — как у wt_dom: запросы только по https и только к HOSTS, без
перенаправлений и прокси из окружения, ответ ограничен по размеру, JSON — без
NaN, бесконечностей и огромных целых; каждое число проверяется на
правдоподобие. Снаружи модуль ничего не принимает: у /api/mcap нет
параметров.
"""
from __future__ import annotations

import contextlib
import datetime
import http.client
import json
import math
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

TTL = 3600.0
FAIL_WAIT = 300.0
API = "https://pro-api.coinmarketcap.com"
HOSTS = frozenset({"pro-api.coinmarketcap.com"})
GLOBAL = f"{API}/v1/global-metrics/quotes/latest"
# USDT в CoinMarketCap — id 825.
USDT_ID = "825"
USDT = f"{API}/v3/cryptocurrency/quotes/latest?id={USDT_ID}"
# История рынка с первого дня CoinMarketCap: только капитализация и доли. Конец
# (time_end) — обязательно: без него CoinMarketCap отдаёт лишь 10 последних дней.
HIST = f"{API}/v1/global-metrics/quotes/historical?time_start=2013-04-28&interval=daily&aux=btc_dominance,eth_dominance"
HIST_TTL = 12 * 3600.0
HIST_DAILY = 3 * 365
HIST_FROM = 1_367_107_200  # 28 апреля 2013 г.
HIST_MAX = 20_000
DAY = 86400
BODY_MAX = 1 << 20
# История за 13 лет — около 1 МБ.
HIST_BODY_MAX = 4 << 20
INT_DIGITS = 18
# Пределы правдоподобия: капитализация рынка, $; доля, %.
CAP_MIN, CAP_MAX = 1e10, 1e15
_HEADERS = {"User-Agent": "wallet-tracker/1.0", "Accept-Encoding": "identity", "Accept": "application/json"}

Json = Any


def _hist_url(now: float) -> str:
    return f"{HIST}&time_end={time.strftime('%Y-%m-%d', time.gmtime(now))}"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Перенаправление не выполняется: 3xx — это ошибка, а не новый адрес."""

    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect, urllib.request.HTTPSHandler())


def _allowed(url: str) -> bool:
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    return u.scheme == "https" and u.hostname in HOSTS and not u.username and not u.password


def _key() -> str:
    """Ключ API из окружения; не похож на ключ — нет ключа."""
    k = os.environ.get("CMC_API_KEY", "").strip()
    return k if 8 <= len(k) <= 100 and k.isascii() and k.replace("-", "").isalnum() else ""


def _log(msg: str) -> None:
    clean = "".join(c if c.isprintable() else "?" for c in msg)
    with contextlib.suppress(OSError, ValueError):  # журнал закрыт — работа важнее записи
        print(f"mcap: {clean[:300]}", file=sys.stderr)


def _fetch(url: str, timeout: float = 20, limit: int = BODY_MAX) -> bytes | None:
    """GET с ключом. Любая ошибка сети и ответ больше limit — None."""
    key = _key()
    if not key or not _allowed(url):
        return None
    req = urllib.request.Request(url, headers={**_HEADERS, "X-CMC_PRO_API_KEY": key})
    try:
        with _opener.open(req, timeout=timeout) as r:
            got: bytes = r.read(limit + 1)
    except urllib.error.HTTPError as e:
        # Код ответа — в журнал (401 — неверный ключ, 429 — лимит), ключ — нет.
        _log(f"HTTP {e.code}")
        return None
    except (OSError, ValueError, http.client.HTTPException):
        return None
    return got if len(got) <= limit else None


def _finite(text: str) -> float:
    v = float(text)
    if not math.isfinite(v):
        raise ValueError("не конечное число")
    return v


def _no_constant(name: str) -> float:
    raise ValueError(f"{name} в JSON")


def _int(text: str) -> int:
    """Целое не длиннее INT_DIGITS цифр: от огромного float() бросает OverflowError."""
    if len(text.lstrip("-")) > INT_DIGITS:
        raise ValueError("слишком длинное целое")
    return int(text)


_DECODER = json.JSONDecoder(parse_float=_finite, parse_int=_int, parse_constant=_no_constant)


def _parse(raw: bytes | None) -> Json:
    if not raw:
        return None
    try:
        return _DECODER.decode(raw.decode())
    except (ValueError, RecursionError):
        return None


def _num(v: object, lo: float, hi: float) -> float | None:
    """Число в пределах [lo, hi]; иначе — None."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) and lo <= f <= hi else None


def _get(d: object, *path: str) -> object:
    for k in path:
        if not isinstance(d, dict):
            return None
        d = d.get(k)
    return d


def _pct(v: float) -> float:
    return round(v, 2)


def compute(glob: Json, usdt: Json) -> dict[str, Json] | None:
    """Ответ по двум ответам CoinMarketCap; нет общих цифр рынка — None.

    btc, eth, alt, alt_ns — [доля сейчас, вчера или None], %; usdt — доля
    сейчас или None; cap — [капитализация рынка сейчас, вчера или None], $."""
    data = _get(glob, "data")
    usd = _get(data, "quote", "USD")
    btc = _num(_get(data, "btc_dominance"), 0.5, 100)
    eth = _num(_get(data, "eth_dominance"), 0, 100)
    cap = _num(_get(usd, "total_market_cap"), CAP_MIN, CAP_MAX)
    # Сумма — по округлённым долям: их и проверяет приложение (60,005 и
    # 39,995 дают 100, а округлённые 60,01 и 40,0 — уже 100,01).
    if btc is None or eth is None or cap is None or _pct(btc) + _pct(eth) > 100:
        return None
    btc_y = _num(_get(data, "btc_dominance_yesterday"), 0.5, 100)
    eth_y = _num(_get(data, "eth_dominance_yesterday"), 0, 100)
    cap_y = _num(_get(usd, "total_market_cap_yesterday"), CAP_MIN, CAP_MAX)
    stable = _num(_get(usd, "stablecoin_market_cap"), 0, cap)
    if stable is None:
        stable = _num(_get(data, "stablecoin_market_cap"), 0, cap)
    out: dict[str, Json] = {
        "btc": [_pct(btc), None if btc_y is None else _pct(btc_y)],
        "eth": [_pct(eth), None if eth_y is None else _pct(eth_y)],
        "alt": [_pct(100 - btc), None if btc_y is None else _pct(100 - btc_y)],
        "alt_ns": None if stable is None or stable / cap * 100 > 100 - btc else _pct(100 - btc - stable / cap * 100),
        "cap": [round(cap), None if cap_y is None else round(cap_y)],
        "usdt": None,
    }
    out["usdt"] = _usdt(usdt, cap)
    return out


def _usdt(got: Json, cap: float) -> float | None:
    """Доля USDT, %, по ответу v3 quotes (data — список монет, quote — список
    валют); не USDT или нет капитализации в $ — None."""
    coins = _get(got, "data")
    if not isinstance(coins, list):
        return None
    for c in coins[:5]:
        if not isinstance(c, dict) or c.get("id") != int(USDT_ID) or c.get("symbol") != "USDT":
            continue
        quotes = c.get("quote")
        for q in quotes[:5] if isinstance(quotes, list) else []:
            if isinstance(q, dict) and q.get("symbol") == "USD":
                ucap = _num(q.get("market_cap"), 1e8, cap)
                return None if ucap is None else _pct(ucap / cap * 100)
    return None


def _day(stamp: object) -> int | None:
    """«2026-10-19T00:00:00.000Z» → начало суток UTC, unix с; иначе None."""
    if not isinstance(stamp, str) or len(stamp) < 10:
        return None
    try:
        d = datetime.datetime.strptime(stamp[:10], "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        return None
    return int(d.timestamp())


def history(got: Json, now: float) -> list[list[Json]] | None:
    """История рынка по ответу global-metrics/quotes/historical: [день,
    капитализация $, доля BTC %, доля ETH % или None] по возрастанию дней;
    старше HIST_DAILY дней — раз в неделю. Битые дни пропускаются; меньше
    двух годных — None."""
    quotes = _get(got, "data", "quotes")
    if not isinstance(quotes, list) or len(quotes) > HIST_MAX:
        return None
    days: dict[int, list[Json]] = {}
    for q in quotes:
        if not isinstance(q, dict):
            continue
        t = _day(q.get("timestamp"))
        cap = _num(_get(q, "quote", "USD", "total_market_cap"), 1e8, CAP_MAX)
        btc = _num(q.get("btc_dominance"), 0.5, 100)
        if t is None or not HIST_FROM <= t <= now or cap is None or btc is None:
            continue
        # До октября 2020 г. доли эфира в истории нет (0) — это «нет данных».
        # Предел — по округлённым долям, как проверяет приложение.
        eth = _num(q.get("eth_dominance"), 0.01, 100)
        eth = None if eth is None or _pct(eth) > 100 - _pct(btc) else eth
        days[t] = [t, round(cap), _pct(btc), None if eth is None else _pct(eth)]
    if len(days) < 2:
        return None
    last = max(days)
    return [r for t, r in sorted(days.items()) if t > last - HIST_DAILY * DAY or (t // DAY) % 7 == 0]


class _State:
    """Кэш модуля. Меняется только под _lock."""

    hit: tuple[float, dict[str, Json]] | None = None
    fail: float | None = None
    # История рынка и когда (unix с) она получена; когда (unix с) её
    # последний раз не удалось получить.
    hist: tuple[float, list[list[Json]]] | None = None
    hist_try: float = 0.0
    # Потрачено кредитов CoinMarketCap: день UTC «ГГГГ-ММ-ДД» → кредиты.
    spent: dict[str, int] | None = None
    dir: str | None = None


_st = _State()
_lock = threading.Lock()
_busy = threading.Event()


def set_cache_dir(path: str | None) -> None:
    """Где держать копии ответа, истории и счётчика кредитов (None — нигде):
    после перезапуска их не надо спрашивать и считать заново."""
    _st.dir = path


def _file_load(name: str) -> Json:
    path = os.path.join(_st.dir, name) if _st.dir else None
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return _parse(f.read().encode())
    except (OSError, ValueError):
        return None


def _file_save(name: str, v: Json) -> None:
    if not _st.dir:
        return
    path = os.path.join(_st.dir, name)
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(v, f, separators=(",", ":"))
        os.replace(tmp, path)
    except (OSError, TypeError, ValueError) as e:
        _log(f"копия на диске: {type(e).__name__}")
        with contextlib.suppress(OSError):
            os.remove(tmp)


# --- Бюджет кредитов ---------------------------------------------------------
# Бесплатный план — 15 000 кредитов в месяц. Обычный расход — около 150 в
# день (ответ раз в час — 2 кредита, история раз в 12 ч — около 50). Больше
# DAY_BUDGET в сутки модуль не тратит ни при каком сбое (CoinMarketCap сменил
# формат, сервер перезапускается по кругу): 400 × 31 = 12 400 — в пределах
# месяца. Счётчик — на диске, перезапуск его не обнуляет.
DAY_BUDGET = 400
# Сколько кредитов стоит запрос, если CoinMarketCap не сказал сам
# (status.credit_count): ответ — 1, история — 1 за 100 дней.
COST_LATEST = 1
COST_HIST = 60
# История не пришла — следующая попытка не раньше чем через столько, с.
HIST_RETRY = 3 * 3600.0


def _today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _spent() -> dict[str, int]:
    """Счётчик кредитов: из памяти или с диска; только сегодняшний день.
    Звать под _lock."""
    if _st.spent is None:
        got = _file_load("mcap_spent.json")
        v = got.get(_today()) if isinstance(got, dict) else None
        _st.spent = {_today(): v} if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 1_000_000 else {}
    if _today() not in _st.spent:
        _st.spent = {_today(): 0}
    return _st.spent


def _can(cost: int) -> bool:
    """Хватит ли сегодняшнего бюджета; запрос дороже ожидаемого может
    перешагнуть его, но только один — следующих уже не будет."""
    with _lock:
        return _spent()[_today()] + cost <= DAY_BUDGET


def _charge(got: Json, guess: int) -> None:
    """Списать кредиты запроса: сколько назвал CoinMarketCap, иначе guess."""
    n = _get(got, "status", "credit_count")
    cost = n if isinstance(n, int) and not isinstance(n, bool) and 0 <= n <= 1000 else guess
    with _lock:
        sp = _spent()
        sp[_today()] += cost
        snap = dict(sp)
    _file_save("mcap_spent.json", snap)


def _call(url: str, guess: int, timeout: float = 20, limit: int = BODY_MAX) -> Json:
    """Запрос с бюджетом: на сегодня кредиты кончились — сеть не трогаем
    (None). Пришёл ответ — кредиты списаны, даже если он не годится."""
    if not _can(guess):
        _log("дневной бюджет кредитов исчерпан")
        return None
    raw = _fetch(url, timeout, limit)
    got = _parse(raw)
    if raw is not None:
        _charge(got, guess)
    return got


# --- Копии на диске ------------------------------------------------------------

def _hist_load() -> tuple[float, list[list[Json]]] | None:
    """Копия истории с диска: только правдоподобные дни по возрастанию."""
    got = _file_load("mcap_hist.json")
    at = _num(_get(got, "at"), HIST_FROM, time.time() + DAY)
    raw = _get(got, "v")
    if at is None or not isinstance(raw, list) or len(raw) > HIST_MAX:
        return None
    rows: list[list[Json]] = []
    for r in raw:
        if not (isinstance(r, list) and len(r) == 4 and isinstance(r[0], int) and r[0] % DAY == 0
                and HIST_FROM <= r[0] <= time.time() and (not rows or r[0] > rows[-1][0])):
            return None
        cap, btc = _num(r[1], 1e8, CAP_MAX), _num(r[2], 0.5, 100)
        eth = None if r[3] is None or btc is None else _num(r[3], 0.01, 100 - btc)
        if cap is None or btc is None or (r[3] is not None and eth is None):
            return None
        rows.append([r[0], round(cap), btc, eth])
    return (at, rows) if len(rows) >= 2 else None


def _share_ok(v: object, lo: float) -> bool:
    return (isinstance(v, list) and len(v) == 2 and _num(v[0], lo, 100) is not None
            and (v[1] is None or _num(v[1], lo, 100) is not None))


def _last_load() -> tuple[float, dict[str, Json]] | None:
    """Копия последнего ответа (без истории) с диска и его время, unix с; она
    отдаётся сразу после перезапуска, а пока ей меньше TTL — без сети."""
    got = _file_load("mcap.json")
    if not isinstance(got, dict) or got.get("ok") is not True:
        return None
    at = _num(got.get("at"), HIST_FROM, time.time() + 60)
    cap = got.get("cap")
    if (at is None or not all(_share_ok(got.get(k), lo) for k, lo in (("btc", 0.5), ("eth", 0), ("alt", 0)))
            or not (isinstance(cap, list) and len(cap) == 2 and _num(cap[0], CAP_MIN, CAP_MAX) is not None
                    and (cap[1] is None or _num(cap[1], CAP_MIN, CAP_MAX) is not None))
            or not all(got.get(k) is None or _num(got.get(k), 0, 100) is not None for k in ("alt_ns", "usdt"))):
        return None
    keep = ("btc", "eth", "alt", "alt_ns", "cap", "usdt")
    return at, {"ok": True, **{k: got.get(k) for k in keep}, "by": "CoinMarketCap", "at": int(at)}


def _hist() -> list[list[Json]] | None:
    """История рынка: из памяти или с диска, а раз в HIST_TTL — из сети.
    Сеть не ответила (или ответ не годится) — прошлая, и новая попытка не
    раньше чем через HIST_RETRY."""
    with _lock:
        if _st.hist is None:
            _st.hist = _hist_load()
        old, tried = _st.hist, _st.hist_try
    now = time.time()
    if (old and now - old[0] < HIST_TTL) or now - tried < HIST_RETRY:
        return old[1] if old else None
    rows = history(_call(_hist_url(now), COST_HIST, timeout=60, limit=HIST_BODY_MAX), now)
    if not rows:
        with _lock:
            _st.hist_try = now
        return old[1] if old else None
    with _lock:
        _st.hist = (now, rows)
    _file_save("mcap_hist.json", {"at": now, "v": rows})
    return rows


def build() -> dict[str, Json]:
    """Собрать ответ из сети и положить в кэш (и на диск)."""
    if not _key():
        return {"ok": False, "error": "no_key"}
    glob = _call(GLOBAL, COST_LATEST)
    got = compute(glob, _call(USDT, COST_LATEST) if glob else None)
    if not got:
        with _lock:
            _st.fail = time.monotonic()
        return {"ok": False, "error": "no_data"}
    at = int(time.time())
    _file_save("mcap.json", {"ok": True, **got, "at": at})
    res = {"ok": True, **got, "hist": _hist() or [], "by": "CoinMarketCap", "at": at}
    with _lock:
        _st.hit = (time.monotonic(), res)
        _st.fail = None
    return res


def _bg() -> None:
    try:
        build()
    except Exception as e:  # noqa: BLE001 — фоновый поток не должен умирать молча
        _log(f"сборка: {type(e).__name__}")
        with _lock:
            _st.fail = time.monotonic()
    finally:
        _busy.clear()


def mcap_data() -> dict[str, Json]:
    """Ответ /api/mcap: из кэша; свежий собирается в фоне одним потоком.
    Пока свежего нет — прошлый; нет и прошлого — «нет данных»."""
    if not _key():
        return {"ok": False, "error": "no_key"}
    if _st.hit is None and _st.dir:
        # Перезапуск: последний ответ — с диска; моложе TTL — сеть не нужна.
        last, hist = _last_load(), _hist_load()
        with _lock:
            if _st.hit is None and last:
                age = max(0.0, time.time() - last[0])
                _st.hit = (time.monotonic() - age, {**last[1], "hist": hist[1] if hist else []})
                if _st.hist is None:
                    _st.hist = hist
    with _lock:
        hit = _st.hit
        if hit and time.monotonic() - hit[0] < TTL:
            return hit[1]
        resting = _st.fail is not None and time.monotonic() - _st.fail < FAIL_WAIT
        if not _busy.is_set() and not resting:
            _busy.set()
            try:
                threading.Thread(target=_bg, daemon=True).start()
            except RuntimeError as e:
                _busy.clear()
                _log(f"фон не запущен: {e}")
    return hit[1] if hit else {"ok": False, "error": "no_data"}

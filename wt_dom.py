"""Альтсезон и сила биткоина — отдельный модуль API (/api/dom).

Всё считаем сами по дневным ценам закрытия Hyperliquid (открытые данные
блокчейна, info API): чужих индексов и сводок здесь нет.

  - монеты — TOP крупнейших бессрочных контрактов Hyperliquid по открытому
    интересу сейчас (без самого биткоина, золота PAXG и монет, привязанных к
    доллару); в прошлом считаются те из них, что уже торговались;
  - индекс альтсезона на каждый день — сколько процентов этих монет выросли
    за WINDOW дней сильнее биткоина (как у известных индексов: 75 и выше —
    альтсезон, 25 и ниже — сезон биткоина). Считается, когда монет с ценой
    на обе даты не меньше MIN_IDX;
  - сила альтов против биткоина — корзина монет поровну против биткоина: за
    день — средний по монетам дневной рост к биткоину (логарифм, урезанный до
    CLIP: одна монета не перевешивает корзину), накопленный с первого дня; 100
    — первый день. Растёт — альты сильнее биткоина;
  - ETH/BTC — закрытие эфира в биткоинах.

Доли биткоина во всём рынке нет: для неё нужна капитализация всех монет, а
открытых данных о числе монет в обращении с правом коммерческого показа нет
ни у кого (CoinMarketCap, CoinGecko, DefiLlama — только с их согласия).

Ответ живёт час (TTL): устаревший отдаётся сразу, свежий собирается в фоне
одним потоком. Цены по дням копятся в памяти и на диске: сборка спрашивает
у Hyperliquid только последние дни, полную историю — один раз на монету.
Первая сборка без копии на диске — пара минут (запросы идут с паузой PACE,
чтобы не упереться в лимит Hyperliquid): до неё ответ — «собираем»
(error: building), а не ожидание.

Безопасность — как у wt_etf: запросы только по https и только к HOSTS, без
перенаправлений и прокси из окружения, ответ ограничен по размеру, JSON — без
NaN, бесконечностей и огромных целых. Снаружи модуль ничего не принимает: у
/api/dom нет параметров.
"""
from __future__ import annotations

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
from typing import Any

# Сколько ответ живёт в кэше, с.
TTL = 3600.0
INFO = "https://api.hyperliquid.xyz/info"
HOSTS = frozenset({"api.hyperliquid.xyz"})
# Сколько монет в корзине; окно индекса альтсезона, дней; меньше скольких
# монет индекс и силу не считаем (горстка монет — не рынок).
TOP = 50
WINDOW = 90
MIN_IDX = 15
MIN_STR = 10
# Дневной рост монеты к биткоину в силе альтов — не больше этого по модулю
# (логарифм: 1 — в 2,7 раза за день).
CLIP = 1.0
# Не альты: золото и привязанные к доллару. Привязанную монету видно и по
# ценам: за WINDOW дней её цена ходит меньше чем на PEG (в разах).
EXCLUDE = frozenset({"PAXG"})
PEG = 1.05
DAY = 86400
# Пауза между запросами цен, с: у Hyperliquid общий лимит на адрес, его
# делят все модули сервера.
PACE = 1.5
# Последних дней в обновлении цен: с запасом на простой сервера.
TAIL_DAYS = 5
# Пределы правдоподобия: монет в списке Hyperliquid, дней цен у монеты, цена.
COINS_MAX = 1000
CANDLES_MAX = 10_000
PX_MAX = 1e8
# Начало дневных цен Hyperliquid — 19 августа 2020 г.; раньше не бывает.
PX_FROM = 1_597_795_200
# Имя монеты в Hyperliquid: буквы и цифры («kPEPE» — тысяча PEPE).
COIN = re.compile(r"[A-Za-z0-9]{1,20}")
BODY_MAX = 4 << 20
INT_DIGITS = 18
_HEADERS = {"User-Agent": "wallet-tracker/1.0", "Accept-Encoding": "identity", "Content-Type": "application/json"}

Json = Any


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


def _now() -> int:
    return int(time.time())


def _log(msg: str) -> None:
    clean = "".join(c if c.isprintable() else "?" for c in msg)
    with contextlib.suppress(OSError, ValueError):  # журнал закрыт — работа важнее записи
        print(f"dom: {clean[:300]}", file=sys.stderr)


def _fetch(url: str, body: dict[str, Any], timeout: float) -> bytes | None:
    """POST JSON. Любая ошибка сети и ответ больше BODY_MAX — None."""
    if not _allowed(url):
        return None
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=_HEADERS, method="POST")
    try:
        with _opener.open(req, timeout=timeout) as r:
            got: bytes = r.read(BODY_MAX + 1)
    except (OSError, ValueError, http.client.HTTPException):
        return None
    return got if len(got) <= BODY_MAX else None


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


def _info(body: dict[str, Any], timeout: float = 30) -> Json:
    return _parse(_fetch(INFO, body, timeout))


def _num(v: object) -> float:
    """Число из ответа (Hyperliquid шлёт числа строками); 0.0 — не число."""
    if isinstance(v, bool):
        return 0.0
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError):
        return 0.0
    return f if math.isfinite(f) else 0.0


# --- Монеты и цены -----------------------------------------------------------

def _ranked() -> list[str] | None:
    """Монеты Hyperliquid по открытому интересу в долларах, крупные первыми
    (без снятых с торгов). Нет ответа — None."""
    got = _info({"type": "metaAndAssetCtxs"})
    if not isinstance(got, list) or len(got) != 2 or not isinstance(got[0], dict):
        return None
    uni, ctxs = got[0].get("universe"), got[1]
    if not isinstance(uni, list) or not isinstance(ctxs, list) or not uni or len(uni) > COINS_MAX:
        return None
    rows: list[tuple[float, str]] = []
    for u, c in zip(uni, ctxs, strict=False):
        if not isinstance(u, dict) or not isinstance(c, dict) or u.get("isDelisted"):
            continue
        name = u.get("name")
        if not isinstance(name, str) or not COIN.fullmatch(name):
            continue
        rows.append((_num(c.get("openInterest")) * _num(c.get("markPx")), name))
    rows.sort(key=lambda r: (-r[0], r[1]))
    return [n for _, n in rows]


def _candles(coin: str, start: int) -> dict[int, float] | None:
    """Закрытия дня с start (unix с): начало суток UTC → цена. Нет ответа — None."""
    got = _info({"type": "candleSnapshot",
                 "req": {"coin": coin, "interval": "1d", "startTime": start * 1000, "endTime": (_now() + DAY) * 1000}})
    if not isinstance(got, list) or len(got) > CANDLES_MAX:
        return None
    out: dict[int, float] = {}
    for k in got:
        if not isinstance(k, dict):
            continue
        t, px = _num(k.get("t")), _num(k.get("c"))
        if t % (DAY * 1000) or not 0 < px < PX_MAX:
            continue
        ts = int(t) // 1000
        if PX_FROM <= ts <= _now() + DAY:
            out[ts] = px
    return out


class _State:
    """Кэш модуля. Меняется только под _lock."""

    hit: tuple[float, dict[str, Json]] | None = None
    # Когда (monotonic) сборка последний раз не удалась; до FAIL_WAIT после
    # неё новой нет.
    fail: float | None = None
    # Цены по дням: монета → {начало суток: закрытие}.
    px: dict[str, dict[int, float]] = {}  # noqa: RUF012 — заменяется целиком, не меняется на месте
    # Где держать копии (set_cache_dir).
    dir: str | None = None


_st = _State()
_lock = threading.Lock()
_busy = threading.Event()
FAIL_WAIT = 120.0
# Копия ответа и цен на диске старше этого не берётся.
FILE_MAX_AGE = 7 * 86400


def set_cache_dir(path: str | None) -> None:
    """Где держать копии ответа и цен (None — нигде)."""
    _st.dir = path


def _file(name: str) -> str | None:
    return os.path.join(_st.dir, name) if _st.dir else None


def _file_load(name: str) -> Json:
    path = _file(name)
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            got = _parse(f.read().encode())
    except (OSError, ValueError):
        return None
    if not isinstance(got, dict) or _now() - _num(got.get("at")) > FILE_MAX_AGE:
        return None
    return got.get("v")


def _file_save(name: str, v: Json) -> None:
    path = _file(name)
    if not path:
        return
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"at": _now(), "v": v}, f, separators=(",", ":"))
        os.replace(tmp, path)
    except (OSError, TypeError, ValueError) as e:
        _log(f"копия на диске: {type(e).__name__}: {e}")
        with contextlib.suppress(OSError):
            os.remove(tmp)


def _px_load() -> dict[str, dict[int, float]]:
    """Цены из копии на диске: только правдоподобные строки."""
    got = _file_load("dom_px.json")
    out: dict[str, dict[int, float]] = {}
    if not isinstance(got, dict):
        return out
    for coin, days in list(got.items())[:COINS_MAX]:
        if not isinstance(coin, str) or not COIN.fullmatch(coin) or not isinstance(days, dict):
            continue
        ok = {int(t): _num(v) for t, v in days.items()
              if isinstance(t, str) and t.isdigit() and len(t) <= 12 and int(t) % DAY == 0 and 0 < _num(v) < PX_MAX}
        if ok:
            out[coin] = ok
    return out


def _refresh(coins: list[str], sleep: Any = time.sleep) -> dict[str, dict[int, float]]:
    """Цены монет: известные — дописываем последними днями, новые — вся
    история. Монета без ответа остаётся с прошлыми ценами."""
    with _lock:
        if not _st.px:
            _st.px = _px_load()
        old = dict(_st.px)
    out: dict[str, dict[int, float]] = {}
    for i, coin in enumerate(coins):
        if i:
            sleep(PACE)
        have = old.get(coin) or {}
        fresh = bool(have) and max(have) >= _now() - TAIL_DAYS * DAY
        got = _candles(coin, max(have) - TAIL_DAYS * DAY if fresh else 0)
        if got is None:
            if have:
                out[coin] = have
            continue
        out[coin] = {**have, **got} if fresh else got
    with _lock:
        _st.px = out
    _file_save("dom_px.json", {c: {str(t): v for t, v in d.items()} for c, d in out.items()})
    return out


# --- Расчёт ------------------------------------------------------------------

def _pegged(p: dict[int, float], end: int) -> bool:
    """Цена за последние WINDOW дней ходила меньше чем в PEG раз — монета
    привязана к доллару (или замерла), это не альт."""
    xs = [v for t, v in p.items() if t > end - WINDOW * DAY]
    return len(xs) >= 10 and max(xs) / min(xs) < PEG


def compute(px: dict[str, dict[int, float]], alts: list[str]) -> dict[str, Json] | None:
    """Ответ по ценам: px — монета → {день: закрытие}, alts — корзина
    (без BTC). Нет цен биткоина — None.

    rows — по дням биткоина с первого дня, где есть сила альтов:
    [день, индекс альтсезона или None, сила альтов, ETH/BTC или None, цена BTC];
    coins — монеты корзины с ценой сегодня и WINDOW дней назад: [монета, рост
    за WINDOW дней, %], по убыванию; btc90 — рост биткоина за то же время."""
    btc = px.get("BTC") or {}
    if len(btc) < WINDOW + 2:
        return None
    eth = px.get("ETH") or {}
    days = sorted(btc)
    rows: list[list[Json]] = []
    acc = 0.0
    for i, t in enumerate(days):
        if i == 0:
            continue
        p = days[i - 1]
        rel = [max(-CLIP, min(CLIP, math.log(px[a][t] / px[a][p]) - math.log(btc[t] / btc[p])))
               for a in alts if t in px[a] and p in px[a]]
        if len(rel) < MIN_STR:
            continue
        acc += sum(rel) / len(rel)
        b = t - WINDOW * DAY
        idx = None
        if b in btc:
            rb = btc[t] / btc[b]
            el = [a for a in alts if t in px[a] and b in px[a]]
            if len(el) >= MIN_IDX:
                idx = round(100 * sum(1 for a in el if px[a][t] / px[a][b] > rb) / len(el))
        eb = float(f"{eth[t] / btc[t]:.6g}") if t in eth else None
        rows.append([t, idx, round(100 * math.exp(acc), 2), eb, round(btc[t], 2)])
    if not rows:
        return None
    end = days[-1]
    b = end - WINDOW * DAY
    grown = [(a, round((px[a][end] / px[a][b] - 1) * 100, 2)) for a in alts if end in px[a] and b in px[a]]
    coins = [[a, g] for a, g in sorted(grown, key=lambda c: (-c[1], c[0]))]
    btc90 = round((btc[end] / btc[b] - 1) * 100, 2) if b in btc else None
    return {"rows": rows, "coins": coins, "btc90": btc90}


def build(sleep: Any = time.sleep) -> dict[str, Json]:
    """Собрать ответ из сети и положить в кэш."""
    ranked = _ranked()
    if not ranked:
        with _lock:
            _st.fail = time.monotonic()
        return _no_data()
    alts_all = [c for c in ranked if c not in ("BTC", *EXCLUDE)]
    # С запасом: привязанные к доллару отсеются по ценам.
    want = ["BTC", "ETH", *[c for c in alts_all[:TOP + 10] if c != "ETH"]]
    px = _refresh(want, sleep)
    end = max(px.get("BTC") or {0: 0})
    alts = [c for c in alts_all if c in px and not _pegged(px[c], end)][:TOP]
    got = compute(px, alts)
    if not got:
        with _lock:
            _st.fail = time.monotonic()
        return _no_data()
    res = {"ok": True, **got, "n": len(alts), "by": "Hyperliquid", "at": _now()}
    with _lock:
        _st.hit = (time.monotonic(), res)
        _st.fail = None
    _file_save("dom.json", res)
    return res


def _no_data() -> dict[str, Json]:
    return {"ok": False, "error": "no_data"}


def _bg() -> None:
    try:
        build()
    except Exception as e:  # noqa: BLE001 — фоновый поток не должен умирать молча
        _log(f"сборка: {type(e).__name__}: {e}")
        with _lock:
            _st.fail = time.monotonic()
    finally:
        _busy.clear()


def _resting() -> bool:
    """Последняя сборка не удалась меньше FAIL_WAIT назад. Звать под _lock."""
    return _st.fail is not None and time.monotonic() - _st.fail < FAIL_WAIT


def dom_data() -> dict[str, Json]:
    """Ответ /api/dom: из кэша; свежий собирается в фоне одним потоком.
    После перезапуска — копия с диска (как устаревшая). Без кэша и копии —
    «собираем» (первая сборка — пара минут), сборка идёт в фоне."""
    if _st.hit is None and _st.dir:
        saved = _file_load("dom.json")
        with _lock:
            if _st.hit is None and isinstance(saved, dict) and saved.get("ok") is True:
                _st.hit = (time.monotonic() - TTL - 1.0, saved)
    with _lock:
        hit = _st.hit
        if hit and time.monotonic() - hit[0] < TTL:
            return hit[1]
        if not _busy.is_set() and not _resting():
            _busy.set()
            try:
                threading.Thread(target=_bg, daemon=True).start()
            except RuntimeError as e:
                _busy.clear()
                _log(f"фон не запущен: {e}")
        building = _busy.is_set()
    if hit:
        return hit[1]
    return {"ok": False, "error": "building"} if building else _no_data()

"""Альтсезон и сила биткоина — отдельный модуль API (/api/dom).

Всё считаем сами по дневным свечам Hyperliquid (открытые данные блокчейна,
info API): цена закрытия и оборот за день. Чужих индексов и сводок здесь нет.

Честность расчёта — главное:
  - корзина на каждый день своя: TOP самых торгуемых монет Hyperliquid по
    обороту за VOLW дней ДО этого дня — только то, что было известно тогда,
    без заглядывания в будущее;
  - в корзину попадают и монеты, которые потом сняли с торгов (Hyperliquid
    отдаёт их историю): прошлое не подгоняется под сегодняшних выживших;
  - только закрытые дни (UTC): идущий день не считается, индекс за день не
    прыгает;
  - история — с начала настоящих торгов на Hyperliquid (раньше у свечей нет
    оборота: цены добавлены задним числом, торгов на бирже не было);
  - день, где в корзине меньше MIN_BASKET монет, не считается; сколько монет
    было в корзине — в каждом дне ответа.

  - индекс альтсезона — сколько процентов корзины дня выросли за WINDOW дней
    сильнее биткоина (75 и выше — альтсезон, 25 и ниже — сезон биткоина);
  - ширина — тот же индекс за последний день для корзин TIERS: видно, идёт
    рост широко или только в самых торгуемых монетах;
  - сила альтов против биткоина — корзина дня поровну: за день — средний по
    монетам дневной рост к биткоину (логарифм, урезанный до CLIP: одна монета
    не перевешивает корзину), накопленный с первого дня; 100 — первый день;
  - ETH/BTC — закрытие эфира в биткоинах.

Без биткоина, золота PAXG, стейблкоинов (и бывшего USTC), индекса NFTI и
монет, привязанных к доллару (цена за всю историю ходит меньше чем в PEG раз).

Доли биткоина во всём рынке (доминации) здесь нет: для неё нужна
капитализация тысяч монет, своим счётом её не получить. Её отдаёт отдельный
модуль wt_mcap.py — по официальному API CoinMarketCap с ключом.

Свечи копятся в памяти и на диске; у Hyperliquid спрашиваем только когда
закрылся новый день, и только его хвост (полную историю — один раз на
монету; снятые с торгов — один раз навсегда). Запросы идут с паузой PACE.
Первая сборка без копии на диске — несколько минут: до неё ответ —
«собираем» (error: building).

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
# Сколько монет в корзине дня; за сколько дней до него оборот выбирает
# корзину; окно индекса, дней; меньше скольких монет в корзине день не
# считается (горстка монет — не рынок); корзины для ширины рынка.
TOP = 100
VOLW = 30
WINDOW = 90
MIN_BASKET = 30
TIERS = (25, 50, 100)
# Дневной рост монеты к биткоину в силе альтов — не больше этого по модулю
# (логарифм: 1 — в 2,7 раза за день).
CLIP = 1.0
# Не альты (как у CoinMarketCap: без стейблкоинов и обеспеченных активами
# токенов): золото PAXG, бывший стейблкоин USTC (Terra; после краха цена
# ходит, и по ценам его не узнать) и NFTI — индекс NFT, а не монета.
# Привязанную к доллару монету видно и по ценам: за всю историю её цена
# ходит меньше чем в PEG раз.
EXCLUDE = frozenset({"PAXG", "USTC", "NFTI"})
PEG = 1.05
DAY = 86400
# Пауза между запросами цен, с: у Hyperliquid общий лимит на адрес — 1200
# «весов» в минуту, его делят все модули сервера; запрос свечей весит 20 и
# ещё 1 за каждые 60 свечей ответа. С паузой 4 с — 15 запросов в минуту:
# около 300 весов на хвостах и меньше 900, даже будь у каждой монеты история
# с 2020 г.
PACE = 4.0
# Сколько последних известных дней спрашивать заново: свеча дня у
# Hyperliquid может уточниться после закрытия.
TAIL_DAYS = 5
# Пределы правдоподобия: монет в списке Hyperliquid, дней у монеты, цена,
# оборот за день, $.
COINS_MAX = 1000
CANDLES_MAX = 10_000
PX_MAX = 1e8
VOL_MAX = 1e12
# ETH/BTC — в этих пределах (максимум — около 0,15 в 2017 г.): иначе — сбой
# цены, ETH/BTC этого дня нет. Биткоин дешевле BTC_MIN, $ — тоже сбой.
EB_MIN, EB_MAX = 1e-6, 10.0
BTC_MIN = 1.0
# Сила альтов не уходит дальше чем в e^STR_LOG раз от 100 (за всю историю —
# 0,4…3,4 раза): дальше — сбой цен, а не рынок. Те же пределы проверяет
# приложение (validDom).
STR_LOG = math.log(1e3)
# Рост монеты за WINDOW дней больше этого, % — сбой цены, монеты нет в списке.
GROW_MAX = 1e6
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


# --- Монеты и свечи ----------------------------------------------------------

def _universe() -> dict[str, bool] | None:
    """Все монеты Hyperliquid, и торгуемые, и снятые: имя → снята ли.
    Нет ответа — None."""
    got = _info({"type": "meta"})
    uni = got.get("universe") if isinstance(got, dict) else None
    if not isinstance(uni, list) or not uni or len(uni) > COINS_MAX:
        return None
    out: dict[str, bool] = {}
    for u in uni:
        name = u.get("name") if isinstance(u, dict) else None
        if isinstance(name, str) and COIN.fullmatch(name):
            out[name] = bool(u.get("isDelisted"))
    return out or None


Candle = tuple[float, float]  # закрытие, оборот за день в $


def _today() -> int:
    """Начало идущих суток UTC: этот день ещё не закрыт и не считается."""
    return _now() // DAY * DAY


def _candles(coin: str, start: int) -> dict[int, Candle] | None:
    """Закрытые дни с start (unix с): начало суток UTC → (закрытие, оборот $).
    Нет ответа — None."""
    got = _info({"type": "candleSnapshot",
                 "req": {"coin": coin, "interval": "1d", "startTime": start * 1000, "endTime": _today() * 1000}})
    if not isinstance(got, list) or len(got) > CANDLES_MAX:
        return None
    out: dict[int, Candle] = {}
    for k in got:
        if not isinstance(k, dict):
            continue
        t, px, vol = _num(k.get("t")), _num(k.get("c")), _num(k.get("v"))
        if t % (DAY * 1000) or not 0 < px < PX_MAX or not 0 <= vol * px < VOL_MAX:
            continue
        ts = int(t) // 1000
        if PX_FROM <= ts < _today():
            out[ts] = (px, vol * px)
    return out


class _State:
    """Кэш модуля. Меняется только под _lock."""

    hit: tuple[float, dict[str, Json]] | None = None
    # Когда (monotonic) сборка последний раз не удалась; до FAIL_WAIT после
    # неё новой нет.
    fail: float | None = None
    # Свечи: монета → {начало суток: (закрытие, оборот $)}.
    px: dict[str, dict[int, Candle]] = {}  # noqa: RUF012 — заменяется целиком, не меняется на месте
    # Где держать копии (set_cache_dir).
    dir: str | None = None


_st = _State()
_lock = threading.Lock()
_busy = threading.Event()
FAIL_WAIT = 120.0
# Сколько монет между промежуточными записями свечей на диск: перезапуск
# посреди первой сборки (она идёт ~15 мин) не начинает её с нуля.
SAVE_EVERY = 25


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
    # Возраст копии не важен: люди видят последний посчитанный ответ (старые
    # дни экран помечает сам), пока свежий собирается в фоне; свечи
    # дописываются с последнего известного дня.
    return got.get("v") if isinstance(got, dict) else None


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


def _px_load() -> dict[str, dict[int, Candle]]:
    """Свечи из копии на диске: только правдоподобные строки."""
    got = _file_load("dom_px.json")
    out: dict[str, dict[int, Candle]] = {}
    if not isinstance(got, dict):
        return out
    for coin, days in list(got.items())[:COINS_MAX]:
        if not isinstance(coin, str) or not COIN.fullmatch(coin) or not isinstance(days, dict):
            continue
        ok: dict[int, Candle] = {}
        for t, v in days.items():
            if not (isinstance(t, str) and t.isdigit() and len(t) <= 12 and isinstance(v, list) and len(v) == 2):
                continue
            ts, px, dv = int(t), _num(v[0]), _num(v[1])
            if ts % DAY == 0 and PX_FROM <= ts < _today() and 0 < px < PX_MAX and 0 <= dv < VOL_MAX:
                ok[ts] = (px, dv)
        if ok:
            out[coin] = ok
    return out


def _refresh(coins: dict[str, bool], sleep: Any = time.sleep) -> dict[str, dict[int, Candle]]:
    """Свечи монет: известные — дописываем с последних TAIL_DAYS известных
    дней (сколько бы сервер ни простоял), новые — вся история; снятые с
    торгов, что уже есть, — не спрашиваем (у них новых дней не будет).
    Монета без ответа остаётся с прошлыми свечами. Каждые SAVE_EVERY монет
    свечи пишутся на диск."""
    with _lock:
        if not _st.px:
            _st.px = _px_load()
        old = dict(_st.px)
    out: dict[str, dict[int, Candle]] = {}
    asked = 0
    for coin, gone in coins.items():
        have = old.get(coin) or {}
        if gone and have:
            out[coin] = have
            continue
        if asked:
            sleep(PACE)
        asked += 1
        got = _candles(coin, max(have) - TAIL_DAYS * DAY if have else 0)
        if got is None:
            if have:
                out[coin] = have
            continue
        if got or have:
            out[coin] = {**have, **got}
        if asked % SAVE_EVERY == 0:
            _px_save({**old, **out})
    with _lock:
        _st.px = out
    _px_save(out)
    return out


def _px_save(px: dict[str, dict[int, Candle]]) -> None:
    _file_save("dom_px.json", {c: {str(t): list(v) for t, v in d.items()} for c, d in px.items()})


# --- Расчёт ------------------------------------------------------------------

def _pegged(p: dict[int, Candle]) -> bool:
    """Цена за всю историю ходила меньше чем в PEG раз — монета привязана к
    доллару (или замерла), это не альт."""
    xs = [c for c, _ in p.values()]
    return len(xs) >= 10 and max(xs) / min(xs) < PEG


def compute(px: dict[str, dict[int, Candle]]) -> dict[str, Json] | None:
    """Ответ по свечам: px — монета → {день: (закрытие, оборот $)}. Нет цен
    биткоина — None.

    rows — по всем закрытым дням биткоина: [день, индекс альтсезона или
    None, сила альтов или None, ETH/BTC или None, цена BTC, монет в корзине
    индекса или None];
    coins — корзина последнего дня: [монета, рост за WINDOW дней, %], по
    убыванию; btc90 — рост биткоина за то же время; tiers — индекс последнего
    дня для корзин TIERS: [размер, индекс или None, монет]."""
    btc = {t: c for t, (c, _) in (px.get("BTC") or {}).items() if c >= BTC_MIN}
    if len(btc) < WINDOW + 2:
        return None
    eth = {t: c for t, (c, _) in (px.get("ETH") or {}).items()}
    days = sorted(btc)
    alts = [a for a in px if a != "BTC" and a not in EXCLUDE and not _pegged(px[a])]
    close = {a: {t: c for t, (c, _) in px[a].items()} for a in alts}
    # Оборот за VOLW дней до дня (сам день не в счёт — его ещё не знают, когда
    # выбирают корзину): по накопленной сумме оборотов.
    pos = {t: i for i, t in enumerate(days)}
    trail: dict[str, list[float]] = {}
    for a in alts:
        acc_v, sums = 0.0, [0.0]
        for t in days:
            acc_v += px[a].get(t, (0.0, 0.0))[1]
            sums.append(acc_v)
        trail[a] = [(sums[i] - sums[max(0, i - VOLW)]) / VOLW for i in range(len(days))]

    def basket(t: int, need: int, n: int) -> list[str]:
        """Корзина дня t: n самых торгуемых за VOLW дней до него монет, у
        которых есть цена в день t и за need дней до него."""
        i = pos[t]
        live = [a for a in alts if trail[a][i] > 0 and t in close[a] and t - need * DAY in close[a]]
        live.sort(key=lambda a: (-trail[a][i], a))
        return live[:n]

    def index(t: int, n: int) -> tuple[int | None, int]:
        b = t - WINDOW * DAY
        if b not in btc:
            return None, 0
        el = basket(t, WINDOW, n)
        if len(el) < min(MIN_BASKET, n):
            return None, len(el)
        rb = btc[t] / btc[b]
        return round(100 * sum(1 for a in el if close[a][t] / close[a][b] > rb) / len(el)), len(el)

    rows: list[list[Json]] = []
    acc = 0.0
    for i, t in enumerate(days):
        # Сила альтов — только за день подряд после прошлого и с корзиной не
        # меньше MIN_BASKET монет; иначе её в этот день нет (None), а ETH/BTC
        # и цена BTC есть с первого дня цен.
        strength = None
        p = days[i - 1] if i else 0
        el = basket(t, 1, TOP) if i and t - p == DAY else []
        if len(el) >= MIN_BASKET:
            rel = [max(-CLIP, min(CLIP, math.log(close[a][t] / close[a][p]) - math.log(btc[t] / btc[p]))) for a in el]
            acc = max(-STR_LOG, min(STR_LOG, acc + sum(rel) / len(rel)))
            strength = round(100 * math.exp(acc), 2)
        idx, n = index(t, TOP)
        eb = float(f"{eth[t] / btc[t]:.6g}") if t in eth and EB_MIN < eth[t] / btc[t] < EB_MAX else None
        rows.append([t, idx, strength, eb, round(btc[t], 2), n if idx is not None else None])
    # Ни одного дня с корзиной — это не рынок альтов: ответа нет.
    if all(r[2] is None for r in rows):
        return None
    end = rows[-1][0]
    b = end - WINDOW * DAY
    grown = [(a, g) for a in basket(end, WINDOW, TOP)
             if (g := round((close[a][end] / close[a][b] - 1) * 100, 2)) <= GROW_MAX]
    coins = [[a, g] for a, g in sorted(grown, key=lambda c: (-c[1], c[0]))]
    btc90 = round((btc[end] / btc[b] - 1) * 100, 2) if b in btc else None
    tiers = [[n, *index(end, n)] for n in TIERS]
    return {"rows": rows, "coins": coins, "btc90": btc90, "tiers": tiers}


def build(sleep: Any = time.sleep) -> dict[str, Json]:
    """Собрать ответ из сети и положить в кэш."""
    with _lock:
        if not _st.px:
            _st.px = _px_load()
        hit, have = _st.hit, _st.px
    # Новый день ещё не закрылся — свечи те же: сеть не трогаем. Ответ тот же,
    # если посчитан по нынешним правилам (TOP); иначе — пересчёт по свечам с
    # диска (после перезапуска с новыми правилами — за секунды, а не минуты).
    last = max((have.get("BTC") or {0: (0.0, 0.0)}), default=0)
    if last >= _today() - DAY:
        if hit and hit[1].get("n") == TOP:
            with _lock:
                _st.hit = (time.monotonic(), hit[1])
            return hit[1]
        got = compute(have)
    else:
        coins = _universe()
        if not coins or "BTC" not in coins:
            with _lock:
                _st.fail = time.monotonic()
            return _no_data()
        got = compute(_refresh(coins, sleep))
    if not got:
        with _lock:
            _st.fail = time.monotonic()
        return _no_data()
    res = {"ok": True, **got, "n": TOP, "by": "Hyperliquid", "at": _now()}
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
            # Копия прежнего расчёта (без tiers) не годится: её не примет и приложение.
            if _st.hit is None and isinstance(saved, dict) and saved.get("ok") is True \
                    and isinstance(saved.get("tiers"), list):
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

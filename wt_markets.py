"""Рынки для трейдера — сверху бокового меню (/api/markets).

Девять чисел, на которые смотрят рядом с графиком биткоина, сетка 3 × 3:

    S&P 500   XYZ100    DXY      — аппетит к риску и доллар;
    Золото    Нефть     US 10Y   — «убежище», инфляция, ставки;
    BVIV      BTC.D     USDT.D   — ждёт ли рынок шторма, куда течёт капитал
                                   в крипте.

По каждому пункту — цена сейчас и сутки назад; изменение считает
приложение (у доходности — в базисных пунктах).

Источники — те, что проект уже берёт; модуль сам в сеть не ходит: ответы
источников ему отдаёт сервер (set_sources), здесь — только разбор, расчёт
и кэш:
  - Aster — запасной источник золота (XAUUSDT) и нефти WTI (CLUSDT): только
    когда Hyperliquid их не дал. Своих запросов нет — ответ ticker/24hr, который
    модуль фандинга и так берёт у Aster раз в 10 минут; старше ASTER_AGE — мимо;
  - Hyperliquid, бессрочные рынки HIP-3 (открытые данные сети): площадка
    trade.xyz («xyz») — S&P 500, XYZ100, золото, нефть WTI (CL), курсы EUR,
    JPY и GBP; площадка Paragon («para») — доходность 10Y; площадка Markets by
    Kinetiq («mkts») — BVIV, подразумеваемая волатильность BTC на 30 дней
    по индексу Volmex («VIX крипты»; рынок открыт вместе с Volmex). Торгуются
    круглые сутки. Рынки, снятые с торгов, не берутся: их цена застыла (DXY
    и VIX на «xyz»);
  - BTC.D и USDT.D — доли в капитализации рынка по CoinMarketCap (модуль
    доминации, wt_mcap: его данные и его условия — подпись источника со
    ссылкой рядом). Вчерашней доли USDT CoinMarketCap не отдаёт: сутки
    назад — та же капитализация USDT к вчерашней капитализации рынка
    (выпуск USDT за сутки меняется на доли процента, доля — от рынка);
  - DXY нигде не торгуется — считаем сами по открытой формуле ICE: EUR, JPY
    и GBP с Hyperliquid (trade.xyz), CAD, SEK, CHF — курсы ЕЦБ
    (Европейского центрального банка, фиксация в 14:15 по Франкфурту) за
    тот же день. Курсы Hyperliquid сверяются с ЕЦБ: расходятся больше чем
    на FX_GAP — DXY нет. Как у TradingView и ICE, DXY живёт по валютному
    дню: день закрывается в 17:00 по Нью-Йорку, с пятницы 17:00 до
    воскресенья 17:00 рынок закрыт. Пока открыт — цена сейчас против
    прошлого закрытия; закрыт — закрытие пятницы против закрытия четверга
    (закрытия — по часовым свечам Hyperliquid). Выходные цены бессрочных
    рынков в DXY не идут. Остаток расхождения с ICE — около 0,1 %: CAD, SEK
    и CHF — по фиксации ЕЦБ, а не по закрытию.

Права — почему набор такой:
  - котировки TradingView брать нельзя (их виджеты показывают данные
    только в своих окнах, выгрузки нет); VIX — индекс Cboe по лицензии;
    DVOL Deribit — их данные только для личного пользования. Волатильность —
    BVIV: цена рынка Hyperliquid (открытые данные сети), а не значение
    индекса Volmex, с оговоркой рядом;
  - S&P 500 — рынок trade.xyz по лицензии S&P Dow Jones Indices; показываем
    цену контракта, а не значение индекса, с оговоркой о товарных знаках;
  - XYZ100 — собственный индекс trade.xyz (100 крупнейших нефинансовых
    компаний США), лицензии Nasdaq у него нет: имя «Nasdaq-100» ему не
    даём;
  - DXY — наш расчёт по открытой формуле из открытых курсов ЕЦБ (повторное
    использование — со ссылкой на источник), а не данные ICE; оговорка, что
    это не официальное значение, — рядом;
  - оговорки и источники видны и на телефоне (раскрываются в меню), а не
    только во всплывающей подсказке.

Проверки: цена конечная, больше нуля и правдоподобная; за сутки не
меняется больше чем вдвое (MOVE_MAX) — иначе сбой источника, пункта нет;
у DXY, доходности, BVIV и долей — свои рамки (RANGE). Неправдоподобная цена
Hyperliquid уступает запасу Aster (золото, нефть).

Кэш: ответ живёт TTL; постарше — отдаётся сразу, а свежий собирается в фоне
одним потоком; ответа нет вовсе — запрос ждёт сборку не дольше COLD_WAIT.
Ответ старше STALE_MAX (источники долго молчат) не отдаётся: в меню —
прежний заголовок, а не вчерашние цены. Сбой одного источника не роняет
остальные: пункт без данных просто не показывается.
"""
from __future__ import annotations

import calendar
import math
import re
import threading
import time
from collections.abc import Callable
from typing import Any

Json = Any
Pair = tuple[float, float]
Source = Callable[[], object]

# Пункты — в порядке экрана.
KEYS = ("SP500", "XYZ100", "DXY", "GOLD", "OIL", "US10Y", "BVIV", "BTCD", "USDTD")
# Рынки Hyperliquid: пункт → (площадка, имя рынка без приставки).
HL = {"SP500": ("xyz", "SP500"), "XYZ100": ("xyz", "XYZ100"), "GOLD": ("xyz", "GOLD"), "OIL": ("xyz", "CL"),
      "US10Y": ("para", "10Y"), "BVIV": ("mkts", "BVIV")}
DEXES = ("xyz", "para", "mkts")  # площадки Hyperliquid
# Запасной источник (Aster): пункт → рынок; цена — последняя, вчера — открытие
# скользящих суток (ticker/24hr). Ответ старше ASTER_AGE не берём.
ASTER = {"GOLD": "XAUUSDT", "OIL": "CLUSDT"}
ASTER_AGE = 1800.0
# DXY = 50,14348112 × ∏ курс^вес (ICE): EUR и GBP — в долларах за единицу
# (вес со знаком минус), остальные — единиц за доллар.
DXY_K = 50.14348112
DXY_W = (("EUR", -0.576), ("JPY", 0.136), ("GBP", -0.119), ("CAD", 0.091), ("SEK", 0.042), ("CHF", 0.036))
PX_MAX = 1e7  # правдоподобная цена пункта
MOVE_MAX = 2.0  # за сутки цена не меняется больше чем вдвое (в любую сторону)
# Свои рамки (с запасом): DXY за полвека не выходил из 70…165, доходность
# 10Y — из 0…16 %; BVIV (годовая волатильность, %) обычно 30…150; доли — проценты.
RANGE = {"DXY": (50.0, 250.0), "US10Y": (0.01, 30.0), "BVIV": (1.0, 500.0), "BTCD": (0.01, 100.0),
         "USDTD": (0.01, 100.0)}
FX_GAP = 0.03  # курс Hyperliquid против ЕЦБ: расхождение больше — DXY нет
FX_HL = ("EUR", "JPY", "GBP")  # валюты DXY с Hyperliquid; EUR и GBP — долларов за единицу
FX_DAYS = 5  # часовые свечи валют — за столько суток (прошлое закрытие — не дальше трёх)
ECB_DAYS = 10  # курсы ЕЦБ — за столько дней (праздники и выходные — без фиксации)
HOUR = 3600
CANDLE_AGE = 3 * HOUR  # свеча закрытия старше этого — закрытия нет
TTL = 60.0  # ответ свежий — не пересобирается
STALE_MAX = 1800.0  # старше — не отдаётся
COLD_WAIT = 6.0  # ответа нет вовсе — запрос ждёт сборку не дольше
FAIL_WAIT = 30.0  # сборка ничего не дала — следующая не раньше
SOURCE_WAIT = 30.0  # все источники вместе ждём не дольше
# Источники из памяти: свежий ответ живёт SLOW[имя][0] — сеть не нужна;
# источник молчит — берём прошлый годный ответ не старше SLOW[имя][1].
# Бюджет запросов Hyperliquid (1200 единиц веса в минуту на адрес) — общий
# для всего сервера, рынки в меню его почти не тратят:
#   - цены площадок (metaAndAssetCtxs, вес 20) — раз в 10 минут на всех, а не
#     раз в минуту: 3 × 20 / 10 = 6 единиц в минуту в худшем случае (~0,5 %);
#   - свечи валют (candleSnapshot, вес ~22) нужны только ради закрытий
#     валютного дня: пока нужные закрытия в памяти (fx_covers), Hyperliquid
#     не спрашиваем — запросы раз в сутки после закрытия, а не раз в 10 минут;
#   - фоновых опросов нет: сборка — только по запросу подписчика с открытым
#     меню.
# Фиксация ЕЦБ — раз в день, а бесплатный Frankfurter просит не долбить его.
SLOW = {"xyz": (600.0, STALE_MAX), "para": (600.0, STALE_MAX), "mkts": (600.0, STALE_MAX),
        "ecb": (3600.0, 4 * 86400.0), "fx": (600.0, 4 * 86400.0)}
# Пределы разбора: ответ больше — хвост не смотрим (процессор не жжём).
UNI_MAX = 5000  # рынков на площадке Hyperliquid
CANDLES_MAX = 1000  # часовых свечей на валюту (берём FX_DAYS суток — 120)
DAYS_MAX = 60  # дней ЕЦБ (берём ECB_DAYS)
DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _num(v: object) -> float:
    """Число из ответа источника (строка или число); иначе — 0."""
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        return 0.0
    try:
        f = float(v)
    except (ValueError, OverflowError):  # не число; целое больше float (10**400)
        return 0.0
    return f if math.isfinite(f) else 0.0


def pair(now: object, prev: object) -> Pair | None:
    """(сейчас, сутки назад) — оба конечные, больше нуля и правдоподобные."""
    a, b = _num(now), _num(prev)
    return (a, b) if 0 < a < PX_MAX and 0 < b < PX_MAX else None


def hl_markets(raw: object) -> dict[str, Pair]:
    """Ответ Hyperliquid metaAndAssetCtxs → {рынок без приставки: (сейчас,
    сутки назад)}; снятые с торгов и кривые — мимо."""
    out: dict[str, Pair] = {}
    if not isinstance(raw, list) or len(raw) < 2 or not isinstance(raw[0], dict) or not isinstance(raw[1], list):
        return out
    uni = raw[0].get("universe")
    for u, c in zip(uni[:UNI_MAX] if isinstance(uni, list) else [], raw[1]):  # noqa: B905 — длины не обязаны совпадать
        if not isinstance(u, dict) or not isinstance(c, dict) or u.get("isDelisted"):
            continue
        name = str(u.get("name") or "").split(":")[-1]
        if name and (p := pair(c.get("markPx"), c.get("prevDayPx"))):
            out[name] = p
    return out


def ecb_rates(raw: object) -> dict[str, dict[str, float]]:
    """Ответ Frankfurter (курсы ЕЦБ, база USD) → {день «ГГГГ-ММ-ДД»: {валюта:
    единиц за доллар}} — только полные дни."""
    rates = raw.get("rates") if isinstance(raw, dict) else None
    out: dict[str, dict[str, float]] = {}
    for day, r in list(rates.items())[-DAYS_MAX:] if isinstance(rates, dict) else ():
        if not (isinstance(day, str) and DATE.fullmatch(day)):
            continue
        got = {c: _num(r.get(c)) if isinstance(r, dict) else 0.0 for c, _ in DXY_W}
        if all(0 < v < PX_MAX for v in got.values()):
            out[day] = got
    return out


def ecb_on(ecb: dict[str, dict[str, float]], t: int) -> dict[str, float] | None:
    """Фиксация ЕЦБ, действующая в момент t: последний день не позже даты t (UTC)."""
    day = time.strftime("%Y-%m-%d", time.gmtime(t))
    days = [d for d in ecb if d <= day]
    return ecb[max(days)] if days else None


def _sunday(y: int, month: int, n: int) -> int:
    """Число месяца n-го воскресенья."""
    return 1 + (6 - calendar.weekday(y, month, 1)) % 7 + 7 * (n - 1)


def ny_offset(t: int) -> int:
    """Смещение Нью-Йорка от UTC в момент t, секунд: летнее время — со второго
    воскресенья марта 2:00 до первого воскресенья ноября 2:00 (местных)."""
    y = time.gmtime(t).tm_year
    start = calendar.timegm((y, 3, _sunday(y, 3, 2), 7, 0, 0))
    end = calendar.timegm((y, 11, _sunday(y, 11, 1), 6, 0, 0))
    return -4 * HOUR if start <= t < end else -5 * HOUR


def fx_session(t: int) -> tuple[bool, int, int]:
    """Валютный день в момент t: (рынок открыт, последнее закрытие, прошлое
    закрытие) — закрытия в 17:00 по Нью-Йорку с понедельника по пятницу, UTC."""
    off = ny_offset(t)
    loc = t + off
    day = loc - loc % 86400
    wd = time.gmtime(loc).tm_wday
    close = day + 17 * HOUR if loc >= day + 17 * HOUR else day - 7 * HOUR
    while time.gmtime(close).tm_wday > 4:
        close -= 86400
    prev = close - 86400
    while time.gmtime(prev).tm_wday > 4:
        prev -= 86400
    shut = (wd == 4 and loc >= day + 17 * HOUR) or wd == 5 or (wd == 6 and loc < day + 17 * HOUR)
    return not shut, close - ny_offset(close - off), prev - ny_offset(prev - off)


def candle_close(raw: object, t: int) -> float:
    """Часовые свечи Hyperliquid (candleSnapshot) → цена закрытия в момент t:
    последняя свеча, закрывшаяся не позже t и не раньше t − CANDLE_AGE; иначе 0."""
    best, px = -1, 0.0
    for c in raw[-CANDLES_MAX:] if isinstance(raw, list) else ():
        if not isinstance(c, dict):
            continue
        end = int(_num(c.get("t")) / 1000) + HOUR
        v = _num(c.get("c"))
        if t - CANDLE_AGE <= end <= t and end > best and 0 < v < PX_MAX:
            best, px = end, v
    return px


def fx_dxy(live: dict[str, Pair], candles: object, ecb: dict[str, dict[str, float]], t: int) -> Pair | None:
    """DXY (сейчас или закрытие пятницы, прошлое закрытие) по валютному дню."""
    is_open, close, prev = fx_session(t)
    cs = candles if isinstance(candles, dict) else {}

    def at(when: int, now: bool) -> float:
        base = ecb_on(ecb, when)
        if base is None:
            return 0.0
        r = dict(base)
        for c in FX_HL:
            v = live[c][0] if now and c in live else candle_close(cs.get(c), when)
            if v <= 0:
                return 0.0
            r[c] = 1 / v if c in ("EUR", "GBP") else v
            if abs(r[c] / base[c] - 1) > FX_GAP:  # курс Hyperliquid сорвался или перевёрнут
                return 0.0
        return round(dxy(r), 3)

    return pair(at(t, True) if is_open else at(close, False), at(close if is_open else prev, False))


def dxy(r: dict[str, float]) -> float:
    """DXY по курсам {валюта: единиц за доллар}."""
    v = DXY_K
    for c, w in DXY_W:
        v *= (1 / r[c] if w < 0 else r[c]) ** w
    return v


def dominance(mcap: object) -> dict[str, Pair]:
    """Ответ модуля доминации (wt_mcap) → BTC.D и USDT.D, (сейчас, вчера)."""
    out: dict[str, Pair] = {}
    if not isinstance(mcap, dict) or mcap.get("ok") is not True:
        return out
    btc, cap, usdt = mcap.get("btc"), mcap.get("cap"), _num(mcap.get("usdt"))
    if isinstance(btc, list) and len(btc) == 2 and (p := pair(btc[0], btc[1])):
        out["BTCD"] = p
    if isinstance(cap, list) and len(cap) == 2 and usdt > 0:
        now_c, prev_c = _num(cap[0]), _num(cap[1])
        if now_c > 0 and prev_c > 0 and (p := pair(usdt, usdt * now_c / prev_c)):
            out["USDTD"] = p
    return out


def aster_markets(raw: object, at: int) -> dict[str, Pair]:
    """Запасной ответ Aster ({"at": когда получен, "rows": ticker/24hr}) →
    золото и нефть, (сейчас, сутки назад); старый или кривой — пусто."""
    out: dict[str, Pair] = {}
    if not isinstance(raw, dict):
        return out
    got_at, rows = _num(raw.get("at")), raw.get("rows")
    if not (at - ASTER_AGE <= got_at <= at + 60) or not isinstance(rows, list):
        return out
    want = {sym: key for key, sym in ASTER.items()}
    for r in rows[:UNI_MAX]:
        if isinstance(r, dict) and (key := want.get(str(r.get("symbol")))) and key not in out \
                and (p := pair(r.get("lastPrice"), r.get("openPrice"))):
            out[key] = p
    return out


def sane(key: str, p: Pair) -> bool:
    """Пункт правдоподобен: в своих рамках и за сутки не больше MOVE_MAX раз."""
    lo, hi = RANGE.get(key, (0.0, PX_MAX))
    a, b = p
    return lo <= a <= hi and lo <= b <= hi and max(a, b) <= MOVE_MAX * min(a, b)


def compute(parts: dict[str, object], at: int) -> dict[str, Json]:
    """Ответ по ответам источников: xyz, para, mkts, fx — часовые свечи EUR,
    JPY, GBP (Hyperliquid), ecb, mcap (доминация CoinMarketCap), aster (запас
    золота и нефти)."""
    dex_mk = {d: hl_markets(parts.get(d)) for d in DEXES}
    # Кандидаты по старшинству: Aster — после Hyperliquid, то есть запас.
    cand: list[tuple[str, Pair | None]] = [(key, dex_mk[dex].get(name)) for key, (dex, name) in HL.items()]
    cand.append(("DXY", fx_dxy(dex_mk["xyz"], parts.get("fx"), ecb_rates(parts.get("ecb")), at)))
    cand += aster_markets(parts.get("aster"), at).items()
    cand += dominance(parts.get("mcap")).items()
    got: dict[str, Pair] = {}
    for key, p in cand:
        if p and key not in got and sane(key, p):  # первый правдоподобный
            got[key] = p
    items = [{"k": k, "px": got[k][0], "prev": got[k][1]} for k in KEYS if k in got]
    return {"ok": True, "at": at, "items": items} if items else {"ok": False, "error": "no_data"}


# --- Сборка и кэш -------------------------------------------------------------

class _State:
    def __init__(self) -> None:
        self.sources: dict[str, Source] = {}
        self.hit: tuple[float, dict[str, Json]] | None = None
        self.job: threading.Thread | None = None
        self.fail = 0.0
        # Медленные источники: имя → (когда получен, годный ответ).
        self.slow: dict[str, tuple[float, object]] = {}


_st = _State()
_lock = threading.Lock()


def set_sources(sources: dict[str, Source]) -> None:
    """Откуда брать ответы источников: имя (xyz, para, mkts, fx, ecb, mcap, aster) → fn()."""
    _st.sources = dict(sources)


def _now() -> int:
    return int(time.time())


def _good(name: str, raw: object) -> bool:
    """Годен ли ответ источника, чтобы его помнить."""
    if name == "ecb":
        return bool(ecb_rates(raw))
    if name == "fx":
        return isinstance(raw, dict) and all(_candles(raw.get(c)) for c in FX_HL)
    return bool(hl_markets(raw))


def _candles(raw: object) -> bool:
    """Есть хоть одна годная часовая свеча (время и цена закрытия)."""
    return isinstance(raw, list) and any(
        isinstance(c, dict) and _num(c.get("t")) > 0 and 0 < _num(c.get("c")) < PX_MAX for c in raw[-CANDLES_MAX:])


def fx_covers(raw: object, t: int) -> bool:
    """Есть ли в свечах все закрытия, нужные DXY в момент t: открыт — последнее
    закрытие, закрыт — последнее и прошлое. Есть — Hyperliquid не спрашиваем."""
    is_open, close, prev = fx_session(t)
    if not isinstance(raw, dict):
        return False
    return all(candle_close(raw.get(c), w) > 0 for c in FX_HL for w in ((close,) if is_open else (close, prev)))


def _fresh(name: str, hit: tuple[float, object], t0: float) -> bool:
    """Ответ источника из памяти ещё годится — сеть не нужна (в памяти — только
    источники SLOW)."""
    return t0 - hit[0] < SLOW[name][0] or (name == "fx" and fx_covers(hit[1], _now()))


def build() -> dict[str, Json]:
    """Опросить источники (параллельно, сбой одного — без него) и собрать ответ.
    Источники SLOW — из памяти, пока свежи; молчат — прошлый годный ответ."""
    parts: dict[str, object] = {}
    got = threading.Lock()
    t0 = time.monotonic()
    with _lock:
        slow = dict(_st.slow)
    ask = {}
    for name, fn in _st.sources.items():
        hit = slow.get(name)
        if hit and _fresh(name, hit, t0):
            parts[name] = hit[1]
        else:
            ask[name] = fn

    def one(name: str, fn: Source) -> None:
        try:
            v = fn()
        except Exception:  # noqa: BLE001 — источник молчит: пункты без него
            v = None
        if name in SLOW:
            if _good(name, v):
                with _lock:
                    _st.slow[name] = (time.monotonic(), v)
            elif (old := slow.get(name)) and time.monotonic() - old[0] < SLOW[name][1]:
                v = old[1]
        with got:
            parts[name] = v

    threads = []
    for item in ask.items():
        th = threading.Thread(target=one, args=item, daemon=True)
        try:
            th.start()
        except RuntimeError:  # потоков не хватило — источник без ответа
            continue
        threads.append(th)
    end = time.monotonic() + SOURCE_WAIT
    for th in threads:
        th.join(max(0.0, end - time.monotonic()))
    with got:  # опоздавший источник — уже без него
        now_parts = dict(parts)
    res = compute(now_parts, _now())
    with _lock:
        if res.get("ok"):
            _st.hit = (time.monotonic(), res)
        else:
            _st.fail = time.monotonic()
    return res


def _bg() -> None:
    try:
        build()
    finally:
        with _lock:
            _st.job = None


def _start() -> threading.Thread | None:
    """Фоновая сборка, если не идёт и не отдыхает после сбоя (звать под _lock)."""
    if _st.job is not None or time.monotonic() - _st.fail < FAIL_WAIT:
        return _st.job
    job = threading.Thread(target=_bg, daemon=True)
    try:
        job.start()
    except RuntimeError:
        return None
    _st.job = job
    return job


def _live(hit: tuple[float, dict[str, Json]] | None) -> tuple[float, dict[str, Json]] | None:
    """Ответ из кэша, если не старше STALE_MAX."""
    return hit if hit and time.monotonic() - hit[0] < STALE_MAX else None


def markets_data(wait: float = COLD_WAIT) -> dict[str, Json]:
    """Ответ /api/markets: свежий — из кэша; постарше — тоже, а новый
    собирается в фоне; нет никакого (или он старше STALE_MAX) — ждём сборку
    не дольше wait."""
    with _lock:
        hit = _live(_st.hit)
        if hit and time.monotonic() - hit[0] < TTL:
            return hit[1]
        job = _start()
        if hit:
            return hit[1]
    if job is not None:
        job.join(wait)
    with _lock:
        hit = _live(_st.hit)
    return hit[1] if hit else {"ok": False, "error": "no_data"}

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

Дневные свечи (мини-график при касании ячейки, /api/markets/candles) — за
DAYS_SHOW дней, сутки — по UTC, у DXY — валютный день (до 17:00 по
Нью-Йорку, без выходных):
  - рынки Hyperliquid — их дневные свечи (candleSnapshot 1d): раз в сутки,
    шесть запросов на весь сервер (RETRY — не чаще при сбое);
  - DXY — по часовым свечам EUR, JPY, GBP (они и так нужны ради закрытий) и
    курсам ЕЦБ того же дня: открытие, максимум, минимум, закрытие по часам;
  - BTC.D — по дневной истории CoinMarketCap из модуля доминации (только
    закрытия дня: открытие — закрытие прошлого дня, без теней);
  - всё остальное (USDT.D — истории у CoinMarketCap на бесплатном плане нет;
    сегодняшняя свеча всех пунктов; дни, которых нет у источника) — свои
    свечи из своих же сборок (цена раз в 10 минут), копией на диске на
    DAYS_KEEP дней (решение владельца проекта: своя короткая история
    USDT.D для графика).
У сегодняшней свечи закрытие — цена ответа, максимум и минимум — с учётом
своих сборок.

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

Кэш (как у карточки халвинга): все видят кэш, запросы людей источники не
трогают. Обновляет его только сервер — refresh() раз в минуту из
cache_refresher и при запуске: сборка одним фоновым потоком. Запрос человека
— markets_data() — только читает готовый ответ: сборку не начинает, в сеть
не ходит; ответа ещё нет (сервер только запущен) — ждёт идущую сборку не
дольше COLD_WAIT. Время ответа — когда получены цены (они меняются раз в
SLOW[площадка][0]), и те же цифры — тот же объект: приложение спрашивает,
только когда могли появиться новые, а сервер отдаёт готовые байты или «304».
Ответ старше STALE_MAX (источники долго молчат) не отдаётся: в меню —
прежний заголовок, а не вчерашние цены. Сбой одного источника не роняет
остальные: пункт без данных просто не показывается.
"""
from __future__ import annotations

import calendar
import contextlib
import math
import re
import sys
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
FX_DAYS = 32  # часовые свечи валют — за столько суток (дневные свечи DXY за DAYS_SHOW дней)
ECB_DAYS = 45  # курсы ЕЦБ — за столько дней (праздники и выходные — без фиксации)
HOUR = 3600
CANDLE_AGE = 3 * HOUR  # свеча закрытия старше этого — закрытия нет
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
#   - свечи валют (candleSnapshot, вес ~33 за FX_DAYS суток) нужны ради
#     закрытий валютного дня и дневных свечей DXY: пока нужные закрытия в
#     памяти (fx_covers), Hyperliquid не спрашиваем — запросы раз в сутки
#     после закрытия, а не раз в 10 минут;
#   - дневные свечи рынков (d1: шесть candleSnapshot, вес ~21) — раз в сутки
#     по UTC; не ответили — снова не раньше чем через RETRY;
#   - сборка — раз в минуту на весь сервер (cache_refresher), от числа людей
#     не зависит: запросы людей только читают кэш.
# Фиксация ЕЦБ — раз в день, а бесплатный Frankfurter просит не долбить его.
SLOW = {"xyz": (600.0, STALE_MAX), "para": (600.0, STALE_MAX), "mkts": (600.0, STALE_MAX),
        "ecb": (3600.0, 4 * 86400.0), "fx": (600.0, 4 * 86400.0), "d1": (86400.0, 3 * 86400.0)}
# Источник не ответил — снова спрашиваем не раньше чем через столько секунд
# (остальные — на следующей сборке).
RETRY = {"d1": 600.0}
# Пределы разбора: ответ больше — хвост не смотрим (процессор не жжём).
RESP_MAX = 1 << 20  # байт ответа источника (сервер дальше не читает; у самых больших — ~60 КБ)
UNI_MAX = 5000  # рынков на площадке Hyperliquid
CANDLES_MAX = 1000  # свечей на рынок (часовых валют за FX_DAYS суток — 768)
DAYS_MAX = 60  # дней ЕЦБ (берём ECB_DAYS)
DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
LOG_MAX = 300  # строка журнала — не длиннее
# Дневные свечи для мини-графика в ячейке (касание), см. выше.
DAY = 86_400
DAYS_SHOW = 30  # свечей на пункт в ответе
DAYS_KEEP = 40  # своих свечей на пункт — в памяти и на диске
D1_DAYS = DAYS_SHOW + 2  # дневные свечи Hyperliquid — за столько суток
# Дневные свечи Hyperliquid: пункт → рынок (площадка:имя).
D1 = {k: f"{dex}:{name}" for k, (dex, name) in HL.items()}


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


Candle = tuple[float, float, float, float]  # открытие, максимум, минимум, закрытие


def ohlc(o: object, h: object, lo: object, c: object) -> Candle | None:
    """Свеча — все цены конечные, больше нуля, правдоподобные; максимум не
    ниже открытия и закрытия, минимум не выше; внутри дня — не больше
    MOVE_MAX раз."""
    v = (_num(o), _num(h), _num(lo), _num(c))
    if not all(0 < x < PX_MAX for x in v) or v[1] < max(v[0], v[3]) or v[2] > min(v[0], v[3]) \
            or v[1] > MOVE_MAX * v[2]:
        return None
    return v


def d1_days(raw: object) -> dict[int, Candle]:
    """Дневные свечи Hyperliquid (candleSnapshot 1d) → {начало суток UTC: свеча}."""
    out: dict[int, Candle] = {}
    for c in raw[-CANDLES_MAX:] if isinstance(raw, list) else ():
        if not isinstance(c, dict):
            continue
        t = _num(c.get("t")) / 1000
        if t > 0 and t % DAY == 0 and (cd := ohlc(c.get("o"), c.get("h"), c.get("l"), c.get("c"))):
            out[int(t)] = cd
    return out


def fx_day(t: int) -> int | None:
    """Валютный день момента t — начало суток UTC даты его закрытия (17:00 по
    Нью-Йорку); рынок закрыт (с пятницы 17:00 до воскресенья 17:00) — None."""
    loc = t + ny_offset(t)
    day = loc - loc % DAY
    d = day if loc - day < 17 * HOUR else day + DAY
    return None if time.gmtime(d).tm_wday > 4 else d


def _fx_hours(fx: object) -> dict[int, dict[str, tuple[float, float]]]:
    """Часовые свечи валют → {начало часа: {валюта: (открытие, закрытие)}}."""
    cs = fx if isinstance(fx, dict) else {}
    hours: dict[int, dict[str, tuple[float, float]]] = {}
    for cur in FX_HL:
        raw = cs.get(cur)
        for c in raw[-CANDLES_MAX:] if isinstance(raw, list) else ():
            if not isinstance(c, dict):
                continue
            t, o, cl = _num(c.get("t")) / 1000, _num(c.get("o")), _num(c.get("c"))
            if t > 0 and t % HOUR == 0 and 0 < o < PX_MAX and 0 < cl < PX_MAX:
                hours.setdefault(int(t), {})[cur] = (o, cl)
    return hours


def dxy_days(fx: object, ecb: dict[str, dict[str, float]]) -> dict[int, Candle]:
    """Дневные свечи DXY по валютным дням — из часовых свечей EUR, JPY, GBP
    (Hyperliquid) и фиксации ЕЦБ того же дня: значения на открытии первого
    часа и на закрытии каждого. Час без всех трёх валют, без фиксации или с
    курсом дальше FX_GAP от ЕЦБ — мимо."""
    hours = _fx_hours(fx)
    vals: dict[int, list[float]] = {}
    for t in sorted(hours):
        got = hours[t]
        if len(got) < len(FX_HL) or (d := fx_day(t)) is None or (base := ecb_on(ecb, t)) is None:
            continue
        pts: list[float] = []
        for i in (0, 1):
            r = dict(base)
            for cur in FX_HL:
                v = got[cur][i]
                r[cur] = 1 / v if cur in ("EUR", "GBP") else v
                if abs(r[cur] / base[cur] - 1) > FX_GAP:
                    break
            else:
                pts.append(round(dxy(r), 3))
        if len(pts) == 2:
            if d in vals:
                vals[d].append(pts[1])
            else:
                vals[d] = pts
    return {d: cd for d, v in vals.items() if (cd := ohlc(v[0], max(v), min(v), v[-1]))}


def btcd_days(mcap: object) -> dict[int, Candle]:
    """Дневные свечи BTC.D по истории модуля доминации ([день, капитализация,
    доля BTC, доля ETH]): закрытие — доля дня, открытие — доля прошлого дня
    (если он есть), тени — только тело."""
    hist = mcap.get("hist") if isinstance(mcap, dict) and mcap.get("ok") is True else None
    rows: list[tuple[int, float]] = []
    for r in hist[-(DAYS_KEEP + 1):] if isinstance(hist, list) else ():
        if isinstance(r, list) and len(r) >= 3 and isinstance(r[0], int) and not isinstance(r[0], bool) \
                and r[0] > 0 and r[0] % DAY == 0 and 0 < (v := _num(r[2])) <= 100:
            rows.append((r[0], v))
    out: dict[int, Candle] = {}
    prev: tuple[int, float] | None = None
    for d, v in sorted(rows):
        o = prev[1] if prev and prev[0] == d - DAY else v
        if cd := ohlc(o, max(o, v), min(o, v), v):
            out[d] = cd
        prev = (d, v)
    return out


def ext_days(parts: dict[str, object]) -> dict[str, tuple[dict[int, Candle], bool]]:
    """Дневные свечи источников: пункт → ({день: свеча}, полные ли тени)."""
    out: dict[str, tuple[dict[int, Candle], bool]] = {}
    d1 = parts.get("d1")
    for k in D1:
        if isinstance(d1, dict) and (v := d1_days(d1.get(k))):
            out[k] = (v, True)
    if v := dxy_days(parts.get("fx"), ecb_rates(parts.get("ecb"))):
        out["DXY"] = (v, True)
    if v := btcd_days(parts.get("mcap")):
        out["BTCD"] = (v, False)
    return out


def day_of(key: str, t: int) -> int | None:
    """День свечи пункта в момент t: начало суток UTC, у DXY — валютный день."""
    return fx_day(t) if key == "DXY" else t - t % DAY


def merge_days(ext: dict[str, tuple[dict[int, Candle], bool]], own: dict[str, dict[int, Candle]],
               at: int) -> dict[str, Json]:
    """Ответ /api/markets/candles: свечи источника, свои — где у источника дня
    нет; у последней свечи открытие — источника, закрытие — своё (цена
    ответа), тени — с учётом своих сборок; не дальше DAYS_KEEP дней и не
    больше DAYS_SHOW на пункт; каждая свеча — в рамках пункта."""
    out: dict[str, Json] = {}
    for k in KEYS:
        e, full = ext.get(k, ({}, True))
        w = own.get(k, {})
        lo, hi = RANGE.get(k, (0.0, PX_MAX))
        days = sorted(d for d in set(e) | set(w) if at - DAYS_KEEP * DAY <= d <= at + DAY)[-DAYS_SHOW:]
        rows = []
        for i, d in enumerate(days):
            a, b = e.get(d), w.get(d)
            last = i == len(days) - 1
            if a and b:
                c = b[3] if last else a[3]
                h, low = (a[1], a[2]) if full and not last else (max(a[1], b[1]), min(a[2], b[2]))
                cd = ohlc(a[0], max(h, a[0], c), min(low, a[0], c), c)
            else:
                cd = a or b
            if cd and lo <= cd[2] and cd[1] <= hi:
                rows.append([d, *cd])
        if rows:
            out[k] = rows
    return {"ok": True, "at": at, "days": out} if out else {"ok": False, "error": "no_data"}


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


def compute(parts: dict[str, object], at: int, since: int | None = None) -> dict[str, Json]:
    """Ответ по ответам источников: xyz, para, mkts, fx — часовые свечи EUR,
    JPY, GBP (Hyperliquid), ecb, mcap (доминация CoinMarketCap), aster (запас
    золота и нефти). at — сейчас; since — когда получены цены (в ответ,
    «обновлено N мин назад»; нет — at)."""
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
    if not items:
        return {"ok": False, "error": "no_data"}
    return {"ok": True, "at": at if since is None else min(since, at), "items": items}


# --- Сборка и кэш -------------------------------------------------------------

class _State:
    def __init__(self) -> None:
        self.sources: dict[str, Source] = {}
        self.hit: tuple[float, dict[str, Json]] | None = None
        self.job: threading.Thread | None = None
        self.fail = 0.0
        # Журнал — только смены состояния: какие источники молчат (с какого
        # момента, monotonic) и пуст ли последний ответ.
        self.down: dict[str, float] = {}
        self.empty = False
        # Медленные источники: имя → (когда получен — по монотонным часам,
        # годный ответ, когда получен — время Unix).
        self.slow: dict[str, tuple[float, object, int]] = {}
        # Свои дневные свечи: пункт → {день: свеча}; время последней цены
        # пункта (старее — мимо); готовый ответ /api/markets/candles — один
        # объект, пока свечи не менялись; когда последний раз спрашивали
        # источники из RETRY (по монотонным часам).
        self.days: dict[str, dict[int, Candle]] = {}
        self.seen: dict[str, int] = {}
        self.cand: dict[str, Json] | None = None
        self.tried: dict[str, float] = {}
        self.sink: Callable[[dict[str, Json]], None] | None = None


_st = _State()
_lock = threading.Lock()


def set_sources(sources: dict[str, Source]) -> None:
    """Откуда брать ответы источников: имя (xyz, para, mkts, fx, ecb, d1, mcap, aster) → fn()."""
    _st.sources = dict(sources)


def _log(msg: str) -> None:
    """В журнал сервера — одной строкой, без управляющих символов и не длиннее
    LOG_MAX (как у карточки халвинга)."""
    clean = "".join(c if c.isprintable() else "?" for c in msg)
    out = sys.stderr
    if out is None:  # журнала нет (pythonw, закрыт) — print ушёл бы в stdout
        return
    # Журнал закрыт или сломан — работа модуля важнее записи о ней.
    with contextlib.suppress(OSError, ValueError):
        print(f"markets: {clean[:LOG_MAX]}", file=out)


def _health(name: str, ok: bool, why: str = "") -> None:
    """Источник замолчал или снова отвечает — строка в журнал только при смене
    состояния: сборка раз в минуту, и каждый сбой отдельно засорял бы журнал.
    Причина — только тип ошибки: текст ошибки может нести адрес запроса."""
    t = time.monotonic()
    with _lock:
        since = _st.down.get(name)
        if ok == (since is None):
            return
        if ok:
            del _st.down[name]
        else:
            _st.down[name] = t
    if since is not None:
        _log(f"источник {name} снова отвечает (молчал {int(t - since) // 60} мин)")
    else:
        _log(f"источник {name} молчит" + (f" ({why})" if why else ""))


def _answered(name: str, v: object) -> bool:
    """Источник ответил по делу: SLOW — годным ответом, остальные — не пустым и
    не «нет данных» своего модуля."""
    if name in SLOW:
        return _good(name, v)
    return v is not None and not (isinstance(v, dict) and v.get("ok") is False)


def _now() -> int:
    return int(time.time())


def _good(name: str, raw: object) -> bool:
    """Годен ли ответ источника, чтобы его помнить."""
    if name == "ecb":
        return bool(ecb_rates(raw))
    if name == "fx":
        return isinstance(raw, dict) and all(_candles(raw.get(c)) for c in FX_HL)
    if name == "d1":
        return isinstance(raw, dict) and any(d1_days(raw.get(k)) for k in D1)
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


def _fresh(name: str, hit: tuple[float, object, int], t0: float) -> bool:
    """Ответ источника из памяти ещё годится — сеть не нужна (в памяти — только
    источники SLOW). Дневные свечи — пока не начались новые сутки UTC."""
    if name == "d1":
        return hit[2] // DAY == _now() // DAY
    return t0 - hit[0] < SLOW[name][0] or (name == "fx" and fx_covers(hit[1], _now()))


def _plan(slow: dict[str, tuple[float, object, int]], t0: float) -> tuple[dict[str, object], dict[str, int], dict[str, Source]]:
    """Кого спросить: SLOW из памяти, пока свежи; источник из RETRY недавно не
    ответил — не спрашиваем, берём прошлый годный (не старше SLOW[имя][1]).
    Вернёт ответы из памяти, когда они получены (Unix) и кого спросить."""
    parts: dict[str, object] = {}
    since: dict[str, int] = {}
    ask: dict[str, Source] = {}
    with _lock:
        tried = dict(_st.tried)
    for name, fn in _st.sources.items():
        hit = slow.get(name)
        if hit and _fresh(name, hit, t0):
            parts[name], since[name] = hit[1], hit[2]
        elif name in RETRY and t0 - tried.get(name, -math.inf) < RETRY[name]:
            if hit and t0 - hit[0] < SLOW[name][1]:  # недавно не ответил — прошлый годный
                parts[name], since[name] = hit[1], hit[2]
        else:
            ask[name] = fn
    with _lock:
        for name in ask:
            if name in RETRY:
                _st.tried[name] = t0
    return parts, since, ask


def _gather() -> tuple[dict[str, object], dict[str, int]]:
    """Ответы источников (параллельно, сбой одного — без него) и когда
    получены ответы SLOW (Unix). SLOW — из памяти, пока свежи; молчат —
    прошлый годный ответ не старше SLOW[имя][1]."""
    got = threading.Lock()
    t0 = time.monotonic()
    with _lock:
        slow = dict(_st.slow)
    parts, since, ask = _plan(slow, t0)

    def one(name: str, fn: Source) -> None:
        why = ""
        try:
            v = fn()
        except Exception as e:  # noqa: BLE001 — источник молчит: пункты без него
            v, why = None, type(e).__name__
        good = _answered(name, v)
        _health(name, good, why)
        at = None
        if name in SLOW:
            if good:
                at = _now()
                with _lock:
                    _st.slow[name] = (time.monotonic(), v, at)
            elif (old := slow.get(name)) and time.monotonic() - old[0] < SLOW[name][1]:
                v, at = old[1], old[2]
        with got:
            parts[name] = v
            if at is not None:
                since[name] = at

    threads = []
    end = time.monotonic() + SOURCE_WAIT
    for item in ask.items():
        th = threading.Thread(target=one, args=item, daemon=True)
        try:
            th.start()
        except RuntimeError:  # потоков не хватило — спрашиваем сами, пока есть время
            if time.monotonic() < end:
                one(*item)
            continue
        threads.append(th)
    for th in threads:
        th.join(max(0.0, end - time.monotonic()))
    with got:  # опоздавший источник — уже без него
        return dict(parts), dict(since)


def build() -> dict[str, Json]:
    """Собрать ответ по ответам источников и положить в кэш.

    Время ответа (at) — когда получены цены площадок Hyperliquid (самые
    старые из взятых), а не когда собран ответ: цены из памяти не выдаются
    за свежие, а «обновлено N мин назад» — правда. Те же цифры, что в
    прошлом ответе, — тот же объект: сервер отдаёт те же байты, телефону —
    «304» (как у карточки халвинга)."""
    parts, since = _gather()
    dex_at = [since[d] for d in DEXES if d in since]
    res = compute(parts, _now(), min(dex_at) if dex_at else None)
    ext = ext_days(parts) if res.get("ok") else {}
    with _lock:
        empty, was = not res.get("ok"), _st.empty
        _st.empty = empty
        if not empty:
            if _st.hit and _st.hit[1] == res:
                res = _st.hit[1]  # те же цифры — тот же объект (те же байты и ETag)
            _st.hit = (time.monotonic(), res)
            grew, sink = _record(res), _st.sink
            cand = merge_days(ext, _st.days, res["at"])
            if cand != _st.cand:  # те же свечи — тот же объект (те же байты и ETag)
                _st.cand = cand
        else:
            _st.fail = time.monotonic()
            grew, sink = False, None
    if empty != was:
        _log("ответа нет: ни одного пункта" if empty else "ответ снова есть")
    if grew and sink is not None:
        try:
            sink(days_snapshot())
        except Exception as e:  # noqa: BLE001 — запись копии не роняет сборку
            _log(f"свечи не записаны ({type(e).__name__})")
    return res


def _record(res: dict[str, Json]) -> bool:
    """Цены ответа — в свои дневные свечи (звать под _lock): первая цена дня —
    открытие, дальше — максимум, минимум и закрытие; цена старее уже
    записанной — мимо; DXY в выходные (рынок закрыт) — мимо; свечей на пункт
    — не больше DAYS_KEEP. Вернёт, менялись ли свечи."""
    at = res.get("at")
    if not isinstance(at, int) or isinstance(at, bool):
        return False
    changed = False
    for it in res.get("items") or ():
        k, px = it["k"], float(it["px"])
        if at < _st.seen.get(k, 0) or (d := day_of(k, at)) is None:
            continue
        _st.seen[k] = at
        days = _st.days.setdefault(k, {})
        c = days.get(d)
        new = (px, px, px, px) if c is None else (c[0], max(c[1], px), min(c[2], px), px)
        if new != c:
            days[d] = new
            changed = True
        while len(days) > DAYS_KEEP:
            del days[min(days)]
    return changed


def candles() -> dict[str, Json]:
    """Ответ /api/markets/candles: {"ok", "at", "days": {пункт: [[день,
    открытие, максимум, минимум, закрытие], …]}} — из памяти; пока свечи не
    менялись — тот же объект (сервер отдаёт те же байты и «304»). Нет —
    «нет данных»."""
    with _lock:
        return _st.cand or {"ok": False, "error": "no_data"}


def days_snapshot() -> dict[str, Json]:
    """Свои дневные свечи — для копии на диске: {"ok", "days": {пункт: [[день,
    открытие, максимум, минимум, закрытие], …]}}."""
    with _lock:
        return {"ok": True, "days": {k: [[d, *c] for d, c in sorted(v.items())] for k, v in _st.days.items() if v}}


def days_restore(raw: object, t: int | None = None) -> int:
    """Свои свечи с диска (после перезапуска) — в память, только для пунктов,
    у которых своих ещё нет. Каждая свеча проверяется: известный пункт, день
    — начало суток UTC не старше DAYS_KEEP дней и не дальше суток вперёд,
    правдоподобная свеча в рамках пункта; по возрастанию дней, не больше
    DAYS_KEEP. Вернёт, сколько свечей принято."""
    t = int(t if t is not None else _now())
    days = raw.get("days") if isinstance(raw, dict) else None
    if not isinstance(days, dict):
        return 0
    n = 0
    with _lock:
        for k in KEYS:
            rows = days.get(k)
            if _st.days.get(k) or not isinstance(rows, list):
                continue
            lo, hi = RANGE.get(k, (0.0, PX_MAX))
            good: dict[int, Candle] = {}
            for r in rows[-DAYS_KEEP:]:
                if not (isinstance(r, list) and len(r) == 5 and isinstance(r[0], int) and not isinstance(r[0], bool)):
                    continue
                d = r[0]
                cd = ohlc(*r[1:])
                if d % DAY == 0 and t - DAYS_KEEP * DAY <= d <= t + DAY and cd and lo <= cd[2] and cd[1] <= hi \
                        and (not good or d > max(good)):
                    good[d] = cd
            if good:
                _st.days[k] = good
                n += len(good)
        if n:
            _st.cand = None
    return n


def set_sink(fn: Callable[[dict[str, Json]], None] | None) -> None:
    """Куда отдавать свои свечи, когда они поменялись (сервер пишет их на
    диск, модуль сам файлов не трогает)."""
    _st.sink = fn


def _bg() -> None:
    try:
        build()
    finally:
        with _lock:
            _st.job = None


def _start() -> threading.Thread | None:
    """Фоновая сборка, если ещё не идёт (звать под _lock); потоков не хватило —
    None."""
    if _st.job is not None:
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


def refresh(wait: float = 0.0) -> dict[str, Json]:
    """Обновить кэш — зовёт только сервер (cache_refresher раз в минуту и
    запуск), не запрос человека. Сборка в фоне, если не идёт и не отдыхает
    после пустой (FAIL_WAIT); потоков не хватило — в этом же потоке, как у
    карточки халвинга. wait > 0 — подождать её. Вернёт ответ из кэша."""
    with _lock:
        rest = time.monotonic() - _st.fail < FAIL_WAIT
        job = _st.job if rest else _start()
    if job is None and not rest:
        build()
    elif job is not None and wait > 0:
        job.join(wait)
    return markets_data(0)


def markets_data(wait: float = COLD_WAIT) -> dict[str, Json]:
    """Ответ /api/markets — только из кэша: запрос человека сборку не
    начинает и к источникам не ходит. Ответа ещё нет (сервер только запущен)
    — ждёт идущую сборку не дольше wait; старше STALE_MAX — «нет данных»."""
    with _lock:
        hit, job = _live(_st.hit), _st.job
    if hit is None and job is not None and wait > 0:
        job.join(wait)
        with _lock:
            hit = _live(_st.hit)
    return hit[1] if hit else {"ok": False, "error": "no_data"}

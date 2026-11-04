"""Карта ликвидаций — отдельный модуль (/api/liqmap).

Где лежат ликвидации открытых позиций с плечом — оценка по открытому
интересу бирж (та же идея, что у Coinglass): за свечу интерес вырос — на
ценах этой свечи открылись позиции; лонги и шорты делятся по доле
агрессивных покупок; объём раскладывается по плечам, у каждого плеча своя
цена ликвидации. Интерес упал — позиции закрываются на ту же долю. Уровень,
который цена уже прошла, снят: там ликвидация случилась. Это модель, а не
список чужих позиций: настоящих цен ликвидации биржи не публикуют.

Почему карта была «гребёнкой» и как теперь:
  - плеч было четыре (10×, 25×, 50×, 100×), и уровни ложились не облаком, а
    зубцами ровно на −9,5 %, −3,5 %, −1,5 %, −0,5 % от цены входа: самый
    крупный «уровень» BTC за сутки оказывался на −12 % — артефакт 10×.
    Теперь — восемь плеч (LEVS) с долями, как их держат на деле, а на экране
    — четыре группы: до 10×, 20–25×, 50×, 75–100× (GROUPS);
  - цена входа была одной точкой на свечу; теперь интерес свечи раскладывается
    по её диапазону от минимума до максимума (ENTRY точек) — карта плотности,
    а не редкие пики;
  - позиции считаются не списком, а по сетке цен ликвидации (BUCKETS корзин
    окна ±SPAN): точек входа в двадцать раз больше, а работы меньше.

Сбор данных бирж (свечи, открытый интерес, доля покупок) — в whale_api: он же
нужен истории открытого интереса. Сюда он приходит через set_gather: модуль
сам в сеть не ходит, файлов не пишет — только считает и держит кэш.

Кэш — как у остальных разделов: свежая карта (до TTL) — из памяти;
постарше, но не старше STALE, — тоже сразу, а пересчёт уходит в фон одним
потоком на карту. Карты нет вовсе — запрос ждёт сборку не дольше COLD_WAIT
(а не собирает сам до бюджета бирж), не успела — «собираем». Сборок
одновременно — не больше JOBS_MAX: сотня запросов с разными монетами не
запускает сотню обходов бирж.
"""
from __future__ import annotations

import bisect
import re
import threading
import time
from collections.abc import Callable
from typing import Any

Json = Any
# Ряд биржи: (начало свечи unix с, максимум, минимум, закрытие, интерес $, доля покупок 0–1).
Row = tuple[int, float, float, float, float, float]
Gather = Callable[[str, str, int], tuple[dict[str, list[Row]], list[Row] | None]]

# Окно карты: свеча и сколько их.
RANGES = {"1d": ("15m", 96), "7d": ("1h", 168), "30d": ("4h", 180)}
# Плечи, их доли в открытом интересе и группа экрана (0 — до 10×, 1 — 20–25×,
# 2 — 50×, 3 — 75–100×). Доли — как их держат на деле: больше всего 5–25×,
# сотое плечо — у немногих. Сумма долей — 1.
LEVS: tuple[tuple[int, float, int], ...] = (
    (3, 0.06, 0), (5, 0.12, 0), (10, 0.20, 0),
    (20, 0.14, 1), (25, 0.14, 1),
    (50, 0.16, 2),
    (75, 0.08, 3), (100, 0.10, 3),
)
# Верхняя граница плеча каждой группы — подпись на экране («до 10×» …).
GROUPS = (10, 25, 50, 100)
# Поддерживающая маржа: ликвидация лонга — на (1 − 1/плечо + MMR) от входа.
MMR = 0.005
# Окно карты: ±SPAN от цены, BUCKETS корзин (по 0,25 %).
SPAN = 0.15
BUCKETS = 120
# По скольким точкам диапазона свечи раскладывается её прирост интереса.
ENTRY = 5
# Сглаживание соседних корзин (1-2-1): цена входа и плечо — оценки.
SMOOTH = (0.25, 0.5, 0.25)

TTL = 120.0  # карта живая: открытый экран спрашивает раз в минуту
STALE = 6 * 3600.0  # старше — не отдаётся даже на время пересчёта
COLD_WAIT = 8.0  # сколько запрос без карты ждёт сборку, с
FAIL_WAIT = 120.0  # биржи не дали ничего — столько не спрашиваем снова, с
JOBS_MAX = 4  # сборок одновременно
CACHE_MAX = 150  # карт в памяти (монета × окно)
SYM = re.compile(r"[A-Z0-9]{1,12}")


def _no(error: str) -> dict[str, Json]:
    return {"ok": False, "error": error}


# --- Модель -------------------------------------------------------------------

def model(rows: list[Row], lo: float, step: float) -> tuple[list[list[float]], list[list[float]]]:
    """Открытые позиции окна по сетке цен ликвидации: (лонги, шорты), каждое —
    [группа][корзина] → $. Корзина b — цены [lo + b·step, lo + (b+1)·step)."""
    g_n = len(GROUPS)
    longs = [[0.0] * BUCKETS for _ in range(g_n)]
    shorts = [[0.0] * BUCKETS for _ in range(g_n)]
    mids = [lo + step * (b + 0.5) for b in range(BUCKETS)]
    for i in range(1, len(rows)):
        _, hi, low, _c, oi, bs = rows[i]
        # Сначала — ликвидации этой свечой: лонг с ценой ликвидации не ниже
        # её минимума и шорт — не выше максимума уже сгорели.
        cut_l = bisect.bisect_left(mids, low)
        cut_s = bisect.bisect_right(mids, hi)
        for g in range(g_n):
            longs[g][cut_l:] = [0.0] * (BUCKETS - cut_l)
            shorts[g][:cut_s] = [0.0] * cut_s
        prev = rows[i - 1][4]
        d = oi - prev
        if d < 0 < prev:
            # Интерес биржи упал на долю — на ту же долю закрываются и наши
            # позиции (доля — от всего интереса биржи, а не от набранного
            # моделью за окно: иначе падение на 2 % стирало бы всё).
            k = max(0.0, oi / prev)
            for g in range(g_n):
                longs[g] = [x * k for x in longs[g]]
                shorts[g] = [x * k for x in shorts[g]]
        elif d > 0:
            share = min(1.0, max(0.0, bs))
            for e in range(ENTRY):
                p = low + (hi - low) * (e + 0.5) / ENTRY
                for lev, w, g in LEVS:
                    part = d * w / ENTRY
                    bl = int((p * (1 - 1 / lev + MMR) - lo) // step)
                    bsh = int((p * (1 + 1 / lev - MMR) - lo) // step)
                    if 0 <= bl < BUCKETS:
                        longs[g][bl] += part * share
                    if 0 <= bsh < BUCKETS:
                        shorts[g][bsh] += part * (1 - share)
    return longs, shorts


def _smooth(a: list[float]) -> list[float]:
    """Соседние корзины 1-2-1; края — без потерь (недостающий сосед — сама корзина)."""
    n = len(a)
    k0, k1, k2 = SMOOTH
    return [k0 * a[max(0, i - 1)] + k1 * a[i] + k2 * a[min(n - 1, i + 1)] for i in range(n)]


def candles(rows: list[Row], n: int = 48) -> list[list[float]]:
    """Свечи окна для графика цены на карте: ≤n штук, [откр, макс, мин, закр].

    Свечи бирж склеиваются по несколько, открытие — закрытие предыдущей: у
    источников модели открытия нет, а разрыв в долю процента на графике не виден."""
    k = max(1, -(-len(rows) // n))
    out: list[list[float]] = []
    prev = rows[0][3]
    for i in range(0, len(rows), k):
        part = rows[i:i + k]
        hi, low, c = max(r[1] for r in part), min(r[2] for r in part), part[-1][3]
        out.append([round(x, 10) for x in (prev, max(hi, prev, c), min(low, prev, c), c)])
        prev = c
    return out


def build_map(sym: str, rng: str, got: dict[str, list[Row]], ref: list[Row], at: int) -> dict[str, Json]:
    """Ответ /api/liqmap по рядам бирж (got) и опорной бирже (ref): корзины
    уровней по группам плеч, накопленное до ±2/±5/±10 %, путь цены, свечи."""
    px = ref[-1][3]
    lo, step = px * (1 - SPAN), px * SPAN * 2 / BUCKETS
    g_n = len(GROUPS)
    long_b = [[0.0] * BUCKETS for _ in range(g_n)]
    short_b = [[0.0] * BUCKETS for _ in range(g_n)]
    for rows in got.values():
        lg, sg = model(rows, lo, step)
        for g in range(g_n):
            long_b[g] = [a + b for a, b in zip(long_b[g], lg[g], strict=True)]
            short_b[g] = [a + b for a, b in zip(short_b[g], sg[g], strict=True)]
    # Лонги — только ниже цены, шорты — только выше: что по ту сторону, уже
    # сгорело бы нынешней ценой. После сглаживания — снова (оно размывает край).
    mids = [lo + step * (b + 0.5) for b in range(BUCKETS)]
    cut_l, cut_s = bisect.bisect_left(mids, px), bisect.bisect_right(mids, px)
    for g in range(g_n):
        for side in (long_b, short_b):
            side[g] = _smooth(side[g])
        long_b[g][cut_l:] = [0.0] * (BUCKETS - cut_l)
        short_b[g][:cut_s] = [0.0] * cut_s
    # (цена середины корзины, лонги по группам, шорты по группам), $ целыми.
    rows_out: list[tuple[float, list[int], list[int]]] = []
    for b in range(BUCKETS):
        lv = [long_b[g][b] for g in range(g_n)]
        sv = [short_b[g][b] for g in range(g_n)]
        if sum(lv) + sum(sv) >= 1:
            rows_out.append((round(lo + step * (b + 0.5), 8), [round(x) for x in lv], [round(x) for x in sv]))

    def cum(side: str, pct: float) -> int:
        far = px * (1 - pct / 100) if side == "L" else px * (1 + pct / 100)
        if side == "L":
            return sum(sum(lv) for p, lv, _ in rows_out if far <= p < px)
        return sum(sum(sv) for p, _, sv in rows_out if px < p <= far)

    buckets = [{"p": p, "L": lv, "S": sv} for p, lv, sv in rows_out]

    # Путь цены за окно — у опорной биржи, ≤60 точек: видно, откуда цена пришла.
    stride = max(1, len(ref) // 60)
    path = [r[3] for r in ref[::stride]]
    if path[-1] != px:
        path.append(px)
    return {"ok": True, "sym": sym, "range": rng, "px": px, "step": step, "lo": lo,
            "ex": sorted(got), "levs": list(GROUPS), "buckets": buckets,
            "cum": {k: {"L": cum("L", k), "S": cum("S", k)} for k in (2, 5, 10)},
            "path": [round(x, 10) for x in path], "oi": round(sum(r[-1][4] for r in got.values())),
            "ohlc": candles(ref), "at": at}


# --- Кэш и сборка -------------------------------------------------------------

class _State:
    """Кэш модуля; меняется только под _lock."""

    def __init__(self) -> None:
        self.hits: dict[tuple[str, str], tuple[float, dict[str, Json]]] = {}
        self.jobs: dict[tuple[str, str], threading.Thread] = {}
        self.fails: dict[tuple[str, str], float] = {}
        self.gather: Gather | None = None


_st = _State()
_lock = threading.Lock()


def set_gather(fn: Gather | None) -> None:
    """Откуда брать ряды бирж: fn(монета, свеча, сколько) → ({биржа: ряды}, опора)."""
    _st.gather = fn


def _now() -> int:
    return int(time.time())


def _clean(sym: object) -> str:
    s = re.sub(r"[^A-Z0-9]", "", str(sym or "").upper())[:12]
    return s if SYM.fullmatch(s) else ""


def build(sym: str, rng: str) -> dict[str, Json]:
    """Собрать карту (ряды — через set_gather) и положить в кэш."""
    key = (sym, rng)
    period, n = RANGES[rng]
    gather = _st.gather
    got, ref = gather(sym, period, n) if gather else ({}, None)
    if not got or not ref:
        with _lock:
            _st.fails[key] = time.monotonic()
        return _no("no_data")
    res = build_map(sym, rng, got, ref, _now())
    with _lock:
        _st.hits[key] = (time.monotonic(), res)
        _st.fails.pop(key, None)
        while len(_st.hits) > CACHE_MAX:
            del _st.hits[min(_st.hits, key=lambda k: _st.hits[k][0])]
    return res


def _bg(key: tuple[str, str]) -> None:
    try:
        build(*key)
    except Exception:  # noqa: BLE001 — фоновая сборка не роняет сервер; биржи и так часто молчат
        with _lock:
            _st.fails[key] = time.monotonic()
    finally:
        with _lock:
            _st.jobs.pop(key, None)


def _start(key: tuple[str, str]) -> threading.Thread | None:
    """Фоновая сборка карты, если она ещё не идёт, не отдыхает после сбоя и
    свободен слот (JOBS_MAX). Звать под _lock."""
    job = _st.jobs.get(key)
    if job is not None:
        return job
    fail = _st.fails.get(key)
    if fail is not None and time.monotonic() - fail < FAIL_WAIT:
        return None
    if len(_st.jobs) >= JOBS_MAX:
        return None
    job = threading.Thread(target=_bg, args=(key,), daemon=True)
    try:
        job.start()
    except RuntimeError:
        return None
    _st.jobs[key] = job
    return job


def liq_map(sym: object, rng: object, wait: float = COLD_WAIT) -> dict[str, Json]:
    """Ответ /api/liqmap: из кэша; устаревшая — сразу, пересчёт в фоне; карты
    нет — ждём сборку не дольше wait, не успела — «собираем» (building)."""
    s = _clean(sym)
    if not s or rng not in RANGES:
        return _no("bad_args")
    key = (s, str(rng))
    with _lock:
        hit = _st.hits.get(key)
        age = time.monotonic() - hit[0] if hit else None
        if hit and age is not None and age < TTL:
            return hit[1]
        job = _start(key)
        if hit and age is not None and age < STALE:
            return hit[1]
        resting = key in _st.fails and job is None
    if resting:
        return _no("no_data")
    if job is not None:
        job.join(wait)
    with _lock:
        hit = _st.hits.get(key)
        busy = key in _st.jobs
        failed = key in _st.fails
    if hit and time.monotonic() - hit[0] < STALE:
        return hit[1]
    return _no("building" if busy else "no_data" if failed else "busy")


def warm(sym: str, rng: str) -> None:
    """Прогрев (фоновый поток сервера): карта старше TTL − минута — собрать
    сейчас, в этом потоке; свежая — ничего."""
    key = (sym, rng)
    with _lock:
        hit = _st.hits.get(key)
        if (hit and time.monotonic() - hit[0] < TTL - 60) or key in _st.jobs:
            return
    build(sym, rng)

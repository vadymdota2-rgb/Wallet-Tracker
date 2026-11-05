"""Карта ликвидаций — отдельный модуль (/api/liqmap).

Карту строим сами — только из открытых данных бирж (свечи, открытый интерес,
доля агрессивных покупок), со всеми плечами. Настоящих цен ликвидации биржи
не публикуют: это модель, как у всех подобных карт.

Как считается (model):
  - интерес — в монетах, а не в долларах: доллары растут вместе с ценой, и
    рост цены на 2 % без единой новой сделки раньше «открывал» позиции, а
    падение — «закрывало» их. Доллары биржи делим на цену в момент снимка;
  - снимок интереса — на момент t, поэтому прирост между снимками t₁ и t₂
    случился в свече [t₁, t₂): на её ценах позиции и открылись (раньше их
    клали на следующую свечу — для окна в 4 часа это сдвиг на 4 часа);
  - прирост раскладывается по диапазону этой свечи (ENTRY точек) и по
    одиннадцати плечам 3–500× с долями, как их держат (LEVS); на экране — пять
    групп (GROUPS); лонги и шорты делятся по доле агрессивных покупок;
  - свеча сжигает уровни, через которые прошла: лонги с ценой ликвидации не
    ниже её минимума, шорты — не выше максимума;
  - интерес упал — часть падения объясняют ликвидации этой свечи, на
    остаток закрываются (сами) остальные позиции — поровну по всем: какие
    именно закрыли, биржи не говорят. Открыли и закрыли за одну свечу —
    интерес не изменился, и модель этого не видит;
  - после последнего снимка — текущая свеча: её ход тоже сжигает уровни.

Живая цена: цена карты — одна на все окна, а не закрытие свечи своего окна
(у «30 дней» последняя свеча 4-часовая, и цена отставала на часы). Между
пересборками каждый запрос берёт текущую цену (set_price) и снимает уровни,
до которых она дошла после сборки: дошли до цены — позиции ликвидированы, и
карта показывает это сразу, а не через TTL.

Сбор данных бирж — в whale_api (он же нужен истории открытого интереса);
сюда он приходит через set_gather, цена — через set_price. Модуль сам в
сеть не ходит и файлов не пишет — только считает и держит кэш.

Кэш: свежая сборка (до TTL окна) — из памяти, с живой ценой; постарше, но
не старше STALE, — тоже сразу, а пересборка уходит в фон одним потоком на
карту. Сборки нет вовсе — запрос ждёт её не дольше COLD_WAIT, не успела —
«собираем». Сборок одновременно — не больше JOBS_MAX.
"""
from __future__ import annotations

import bisect
import re
import threading
import time
from collections.abc import Callable
from typing import Any

Json = Any
# Ряд биржи: (начало свечи unix с, максимум, минимум, закрытие,
# интерес $ на момент начала свечи, доля агрессивных покупок 0–1).
Row = tuple[int, float, float, float, float, float]
Gather = Callable[[str, str, int], tuple[dict[str, list[Row]], list[Row] | None]]
Price = Callable[[str], float | None]

# Окно карты: свеча и сколько их. Длинные окна — дневными свечами: историю
# интереса за год биржи отдают только по дням (Binance — лишь за 30 дней,
# HTX — за ~200: такие биржи дают свою часть окна).
RANGES = {"1d": ("15m", 96), "7d": ("1h", 168), "30d": ("4h", 180),
          "90d": ("1d", 90), "180d": ("1d", 180), "365d": ("1d", 365)}
# Хвост окна — мелкими свечами: снимок интереса окна в 4 часа или сутки —
# на начало свечи, и всё, что открыли за идущую свечу (до суток!), без хвоста
# не видно до следующего снимка: рядом с ценой карта пустела. Старую часть
# окна считаем крупными свечами, идущую — мелкими (splice).
TAIL = {"7d": ("15m", 12), "30d": ("15m", 24), "90d": ("1h", 30), "180d": ("1h", 30), "365d": ("1h", 30)}
# Сколько живёт сборка окна, с. Цена и ликвидации между сборками — живые;
# дневные свечи длинных окон за полчаса почти не меняются.
TTL = {"1d": 120.0, "7d": 120.0, "30d": 300.0, "90d": 1800.0, "180d": 1800.0, "365d": 1800.0}
# Плечи, их доли в открытом интересе и группа экрана (0 — до 10×, 1 — 20–25×,
# 2 — 50×, 3 — 75–100×, 4 — 125–500×: столько дают Binance (125×), Bybit и
# MEXC (200×), а некоторые биржи — до 500×). Доли — как их держат на деле:
# больше всего 5–25×, сотое плечо и выше — у немногих. Сумма долей — 1.
LEVS: tuple[tuple[int, float, int], ...] = (
    (3, 0.05, 0), (5, 0.11, 0), (10, 0.19, 0),
    (20, 0.14, 1), (25, 0.14, 1),
    (50, 0.16, 2),
    (75, 0.07, 3), (100, 0.08, 3),
    (125, 0.03, 4), (200, 0.02, 4), (500, 0.01, 4),
)
# Верхняя граница плеча каждой группы — подпись на экране («до 10×» …).
GROUPS = (10, 25, 50, 100, 500)
# Наибольшее плечо BTC и ETH на бирже: плечо выше на ней не открыть, и его
# доля уходит остальным (levs_upto). Пределы бирж — по их правилам торговли
# на 2026 год, с запасом вниз. У прочих монет плечо меньше — ALT_CAP.
CAPS = {"Binance": 125, "Bybit": 100, "OKX": 100, "Gate": 100, "HTX": 200, "dYdX": 20, "Hyperliquid": 40,
        "Bitget": 125, "MEXC": 500, "KuCoin": 100, "Kraken": 50, "Phemex": 100, "WOO X": 50, "WhiteBIT": 100,
        "Bitfinex": 100, "Deribit": 50, "CoinEx": 100, "Coinbase Intl": 50, "Crypto.com": 100, "Paradex": 50,
        "Lighter": 50, "Backpack": 50, "Orderly": 50, "GMX": 100, "Aster": 500, "BingX": 150, "BloFin": 150, "XT.com": 125}
CAP_OTHER = 50  # биржа не из списка
MAJORS = frozenset({"BTC", "ETH"})
ALT_CAP = 75
# Поддерживающая маржа: ликвидация лонга — на (1 − 1/плечо + маржа) от входа.
# У бирж она ступенями: чем больше плечо, тем меньше, и всегда меньше
# начальной (1/плечо) — иначе 200× ликвидировалось бы на цене входа. Берём
# MMR, но не больше половины начальной: 100× — 0,5 %, 200× — 0,25 %, 500× — 0,1 %.
MMR = 0.005


def mmr(lev: int) -> float:
    """Поддерживающая маржа плеча lev (доля позиции)."""
    return min(MMR, 0.5 / lev)
# Окно карты: ±SPAN от цены, BUCKETS корзин (по 0,25 %): до нуля вниз и до
# удвоения вверх — экран приближает от ±5 до ±100 %.
SPAN = 1.0
BUCKETS = 800
# По скольким точкам диапазона свечи раскладывается её прирост интереса.
ENTRY = 5
# Сглаживание соседних корзин (1-2-1): цена входа и плечо — оценки.
SMOOTH = (0.25, 0.5, 0.25)
# Текущая цена дальше этого от цены сборки — не та монета (другой тикер у
# источника цены) или сбой: берём цену сборки.
PX_GAP = 0.03

STALE = 3600.0  # сборка старше — не отдаётся даже на время пересборки (биржи молчат)
COLD_WAIT = 8.0  # сколько запрос без карты ждёт сборку, с
FAIL_WAIT = 120.0  # биржи не дали ничего — столько не спрашиваем снова, с
JOBS_MAX = 4  # сборок одновременно
CACHE_MAX = 150  # карт в памяти (монета × окно)
SYM = re.compile(r"[A-Z0-9]{1,12}")


def _no(error: str) -> dict[str, Json]:
    return {"ok": False, "error": error}


# --- Модель -------------------------------------------------------------------

def _opened(x: float, hi: float, low: float, bs: float, lo: float,  # noqa: PLR0913 — свеча и сетка целиком
            step: float, levs: tuple[tuple[int, float, int], ...]) -> tuple[list[tuple[int, int, int, float]], float]:
    """Новые позиции на x монет в свече [low, hi]: по ENTRY точкам входа и по
    плечам LEVS, лонги — доля покупок bs. Вернёт ([(сторона, группа, корзина,
    монеты)], монеты с ликвидацией за краем окна)."""
    share = min(1.0, max(0.0, bs))
    entries: list[tuple[int, int, int, float]] = []
    out = 0.0
    for e in range(ENTRY):
        p = low + (hi - low) * (e + 0.5) / ENTRY
        for lev, w, g in levs:
            part = x * w / ENTRY
            keep = 1 / lev - mmr(lev)  # на сколько цена уходит до ликвидации
            bl = int((p * (1 - keep) - lo) // step)
            bsh = int((p * (1 + keep) - lo) // step)
            if 0 <= bl < BUCKETS:
                entries.append((0, g, bl, part * share))
            else:
                out += part * share
            if 0 <= bsh < BUCKETS:
                entries.append((1, g, bsh, part * (1 - share)))
            else:
                out += part * (1 - share)
    return entries, out


def levs_upto(cap: int) -> tuple[tuple[int, float, int], ...]:
    """Плечи LEVS не выше cap; доли остальных — пропорционально, сумма снова 1."""
    kept = [x for x in LEVS if x[0] <= cap] or [LEVS[0]]
    total = sum(w for _, w, _ in kept)
    return tuple((lev, w / total, g) for lev, w, g in kept)


def max_lev(ex: str, sym: str) -> int:
    """Наибольшее плечо монеты на бирже: у BTC и ETH — предел биржи (CAPS), у
    остальных монет биржи дают меньше — не больше ALT_CAP."""
    cap = CAPS.get(ex, CAP_OTHER)
    return cap if sym in MAJORS else min(cap, ALT_CAP)


class _Book:
    """Открытые позиции модели по сетке цен ликвидации, в монетах.

    Позиции хранятся пачками по свечам открытия (cohorts): закрываются первыми
    самые свежие — кто последним вошёл, тот первым и вышел. Так шум «открыли —
    закрыли» внутри часа гасится и на 15-минутных свечах, и на часовых, и
    карта не зависит от того, какой мелкой свечой её считали."""

    def __init__(self, lo: float, step: float) -> None:
        g_n = len(GROUPS)
        self.g_n = g_n
        self.agg = ([[0.0] * BUCKETS for _ in range(g_n)], [[0.0] * BUCKETS for _ in range(g_n)])
        self.mids = [lo + step * (b + 0.5) for b in range(BUCKETS)]
        # Когда корзина сгорела в последний раз (номер шага): позиция пачки
        # шага s в ней жива, пока корзина не сгорела позже s.
        self.burnt = ([[-1] * BUCKETS for _ in range(g_n)], [[-1] * BUCKETS for _ in range(g_n)])
        # Пачка: [шаг открытия, какая доля осталась после закрытий,
        # [(сторона, группа, корзина, монеты)], монеты с ликвидацией за краем окна].
        # Те, что за краем, на карту не попадают, но закрываются наравне со
        # всеми: иначе их закрытия съедали бы видимые уровни.
        self.cohorts: list[list[Any]] = []
        # Докуда по группе лежали лонги (самая верхняя корзина) и шорты (самая
        # нижняя): свеча сжигает только эту полосу, а не всю сетку в 800 корзин.
        self.top_l = [-1] * g_n
        self.bot_s = [BUCKETS] * g_n

    def burn(self, at: int, hi: float, low: float) -> float:
        """Свеча прошла уровни: лонг с ценой ликвидации не ниже её минимума и
        шорт — не выше максимума сгорели. Вернёт, сколько монет сгорело."""
        cut_l, cut_s = bisect.bisect_left(self.mids, low), bisect.bisect_right(self.mids, hi)
        gone = 0.0
        for g in range(self.g_n):
            for side, rng_b in ((0, range(cut_l, self.top_l[g] + 1)), (1, range(self.bot_s[g], cut_s))):
                arr, mark = self.agg[side][g], self.burnt[side][g]
                for b in rng_b:
                    if arr[b]:
                        gone += arr[b]
                        arr[b] = 0.0
                    mark[b] = at
            # Выше cut_l живых лонгов больше нет, ниже cut_s — шортов.
            self.top_l[g] = min(self.top_l[g], cut_l - 1)
            self.bot_s[g] = max(self.bot_s[g], cut_s)
        return gone

    def alive(self, c: list[Any]) -> list[tuple[int, int, int, float]]:
        return [x for x in c[2] if self.burnt[x[0]][x[1]][x[2]] <= c[0]]

    def close(self, amount: float) -> None:
        """Закрыть amount монет — с самых свежих пачек."""
        agg = self.agg
        while amount > 0 and self.cohorts:
            c = self.cohorts[-1]
            live = self.alive(c)
            mass = c[1] * (sum(x[3] for x in live) + c[3])
            if mass <= amount:
                for side, g, b, q in live:
                    agg[side][g][b] = max(0.0, agg[side][g][b] - q * c[1])
                self.cohorts.pop()
                amount -= mass
                continue
            keep = 1 - amount / mass
            for side, g, b, q in live:
                agg[side][g][b] = max(0.0, agg[side][g][b] - q * c[1] * (1 - keep))
            c[1] *= keep
            return

    def add(self, at: int, entries: list[tuple[int, int, int, float]], out: float) -> None:
        """Новая пачка позиций шага at: в сетку и в стопку пачек."""
        for side, g, b, q in entries:
            self.agg[side][g][b] += q
            if side:
                self.bot_s[g] = min(self.bot_s[g], b)
            else:
                self.top_l[g] = max(self.top_l[g], b)
        self.cohorts.append([at, 1.0, entries, out])

    def total(self) -> float:
        """Все живые позиции, и с ликвидацией за краем окна тоже, в монетах."""
        return float(sum(c[1] * (sum(x[3] for x in self.alive(c)) + c[3]) for c in self.cohorts))


def model(rows: list[Row], lo: float, step: float,
          levs: tuple[tuple[int, float, int], ...] = LEVS) -> tuple[list[list[float]], list[list[float]], float]:
    """Открытые позиции окна по сетке цен ликвидации, в монетах: (лонги, шорты,
    всего), лонги и шорты — [группа][корзина]; «всего» — все живые позиции,
    открытые за окно, и с ликвидацией за краем окна тоже. Корзина b — цены
    [lo + b·step, lo + (b+1)·step). Как закрываются позиции — _Book."""
    book = _Book(lo, step)
    # Шаг i: от снимка i−1 до снимка i прошла свеча i−1; цена на момент
    # снимка i — её закрытие, на момент снимка i−1 — закрытие свечи i−2.
    for i in range(2, len(rows)):
        _, hi, low, p_now, _oi, bs = rows[i - 1]
        p_prev = rows[i - 2][3]
        if p_now <= 0 or p_prev <= 0:
            continue
        q_prev, q_now = rows[i - 1][4] / p_prev, rows[i][4] / p_now
        # Чистый прирост интереса плюс сгоревшее этой свечой: интерес стоит, а
        # уровни сгорели — значит, на их место открылись новые.
        x = q_now - q_prev + book.burn(i, hi, low)
        if x < 0:
            book.close(-x)
        elif x > 0:
            book.add(i, *_opened(x, hi, low, bs, lo, step, levs))
    # После последнего снимка — текущая свеча: её ход тоже сжигает уровни.
    if rows:
        book.burn(len(rows), rows[-1][1], rows[-1][2])
    return book.agg[0], book.agg[1], book.total()


def splice(main: list[Row], tail: list[Row] | None) -> list[Row]:
    """Ряд окна: крупные свечи до начала идущей, дальше — мелкие свечи хвоста.
    Хвост не дотягивается до начала идущей свечи — ряд как был."""
    if not main or not tail:
        return main
    cut = main[-1][0]
    if tail[0][0] > cut:
        return main
    return [r for r in main if r[0] < cut] + [r for r in tail if r[0] >= cut]


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


def make_state(sym: str, rng: str, got: dict[str, list[Row]], ref: list[Row], px: float,  # noqa: PLR0913 — сборка целиком
               at: int) -> dict[str, Json]:
    """Сборка карты: позиции всех бирж по сетке вокруг цены px (в монетах,
    сглаженные), свечи и путь цены опорной биржи. Ответ из неё — render()."""
    lo, step = px * (1 - SPAN), px * SPAN * 2 / BUCKETS
    g_n = len(GROUPS)
    long_b = [[0.0] * BUCKETS for _ in range(g_n)]
    short_b = [[0.0] * BUCKETS for _ in range(g_n)]
    seen = 0.0
    for ex, rows in got.items():
        lg, sg, mass = model(rows, lo, step, levs_upto(max_lev(ex, sym)))
        seen += mass
        for g in range(g_n):
            long_b[g] = [a + b for a, b in zip(long_b[g], lg[g], strict=True)]
            short_b[g] = [a + b for a, b in zip(short_b[g], sg[g], strict=True)]
    # Путь цены за окно — у опорной биржи, ≤60 точек: видно, откуда цена пришла.
    stride = max(1, len(ref) // 60)
    return {"sym": sym, "range": rng, "px": px, "lo": lo, "step": step, "at": at, "ex": sorted(got),
            "L": [_smooth(x) for x in long_b], "S": [_smooth(x) for x in short_b],
            "path": [r[3] for r in ref[::stride]], "ohlc": candles(ref),
            "oi": round(sum(r[-1][4] for r in got.values())),
            # Сколько из открытого интереса модель видит — позиции, открытые
            # за окно и ещё живые, $; остальное открыто раньше окна.
            "seen": round(seen * px),
            # Где цена побывала после последнего снимка: всё за этими краями сгорело.
            "low": min(px, ref[-1][2]), "high": max(px, ref[-1][1])}


def render(st: dict[str, Json], px: float) -> dict[str, Json]:
    """Ответ /api/liqmap: уровни сборки st без сгоревших — тех, до которых
    цена дошла после последнего снимка (st low/high и px), — при цене px."""
    lo, step, g_n = st["lo"], st["step"], len(GROUPS)
    low, high = min(st["low"], px), max(st["high"], px)
    mids = [lo + step * (b + 0.5) for b in range(BUCKETS)]
    cut_l, cut_s = bisect.bisect_left(mids, low), bisect.bisect_right(mids, high)
    # (цена середины корзины, лонги по группам, шорты по группам), $ целыми:
    # монеты × цена ликвидации — столько денег сгорит на этом уровне.
    rows_out: list[tuple[float, list[int], list[int]]] = []
    for b in range(BUCKETS):
        m = mids[b]
        lv = [round(st["L"][g][b] * m) if b < cut_l else 0 for g in range(g_n)]
        sv = [round(st["S"][g][b] * m) if b >= cut_s else 0 for g in range(g_n)]
        if sum(lv) + sum(sv) >= 1:
            rows_out.append((round(m, 8), lv, sv))

    def cum(side: str, pct: float) -> int:
        if side == "L":
            far = px * (1 - pct / 100)
            return sum(sum(lv) for p, lv, _ in rows_out if far <= p < px)
        far = px * (1 + pct / 100)
        return sum(sum(sv) for p, _, sv in rows_out if px < p <= far)

    path = list(st["path"])
    if path[-1] != px:
        path.append(px)
    # Последняя свеча — до текущей цены.
    ohlc = [list(c) for c in st["ohlc"]]
    o, h, lw, _c = ohlc[-1]
    ohlc[-1] = [o, round(max(h, px), 10), round(min(lw, px), 10), round(px, 10)]
    return {"ok": True, "sym": st["sym"], "range": st["range"], "px": px, "step": step, "lo": lo,
            "ex": st["ex"], "levs": list(GROUPS), "buckets": [{"p": p, "L": lv, "S": sv} for p, lv, sv in rows_out],
            "cum": {k: {"L": cum("L", k), "S": cum("S", k)} for k in (2, 5, 10)},
            "path": [round(x, 10) for x in path], "oi": st["oi"], "seen": min(st["seen"], st["oi"]),
            "ohlc": ohlc, "at": st["at"]}


def build_map(sym: str, rng: str, got: dict[str, list[Row]], ref: list[Row], at: int,  # noqa: PLR0913 — сборка целиком
              px: float | None = None) -> dict[str, Json]:
    """Ответ сразу по рядам бирж (got) и опорной бирже (ref) при цене px
    (нет — закрытие последней свечи опорной)."""
    p = px if px is not None else ref[-1][3]
    return render(make_state(sym, rng, got, ref, p, at), p)


# --- Кэш и сборка -------------------------------------------------------------

class _State:
    """Кэш модуля; меняется только под _lock. hits: ключ → (когда собрана,
    сборка, последний ответ)."""

    def __init__(self) -> None:
        self.hits: dict[tuple[str, str], tuple[float, dict[str, Json], dict[str, Json]]] = {}
        self.jobs: dict[tuple[str, str], threading.Thread] = {}
        self.fails: dict[tuple[str, str], float] = {}
        self.gather: Gather | None = None
        self.price: Price | None = None


_st = _State()
_lock = threading.Lock()


def set_gather(fn: Gather | None) -> None:
    """Откуда брать ряды бирж: fn(монета, свеча, сколько) → ({биржа: ряды}, опора)."""
    _st.gather = fn


def set_price(fn: Price | None) -> None:
    """Откуда брать текущую цену: fn(монета) → цена или None."""
    _st.price = fn


def _now() -> int:
    return int(time.time())


def _clean(sym: object) -> str:
    s = re.sub(r"[^A-Z0-9]", "", str(sym or "").upper())[:12]
    return s if SYM.fullmatch(s) else ""


def _live(sym: str, base: float) -> float:
    """Текущая цена монеты; источник молчит, сбоит или далеко от base — base."""
    fn = _st.price
    try:
        p = fn(sym) if fn else None
    except Exception:  # noqa: BLE001 — сбой источника цены не ломает карту: цена сборки
        p = None
    # Ноль и минус отсекает и PX_GAP; True — не цена, хоть и равна 1.
    if isinstance(p, (int, float)) and not isinstance(p, bool) and abs(p / base - 1) <= PX_GAP:
        return float(p)
    return base


def _sweep() -> None:
    """Самочистка кэша (звать под _lock): сборки старше STALE больше не
    отдаются — их нет и в памяти; паузы после сбоя старше FAIL_WAIT — тоже."""
    t = time.monotonic()
    for k in [k for k, v in _st.hits.items() if t - v[0] >= STALE]:
        del _st.hits[k]
    for k in [k for k, v in _st.fails.items() if t - v >= FAIL_WAIT]:
        del _st.fails[k]


def build(sym: str, rng: str) -> dict[str, Json]:
    """Собрать карту (ряды — через set_gather, цена — через set_price) и положить в кэш."""
    key = (sym, rng)
    period, n = RANGES[rng]
    gather = _st.gather
    tail: dict[str, list[Row]] = {}
    job = None
    if gather is not None and rng in TAIL:
        fn = gather

        # Хвост — параллельно с окном: две сборки по бюджету бирж, а не подряд.
        def fetch_tail() -> None:
            try:
                tail.update(fn(sym, *TAIL[rng])[0])
            except Exception:  # noqa: BLE001 — хвоста нет — окно без него, как раньше
                tail.clear()
        job = threading.Thread(target=fetch_tail, daemon=True)
        job.start()
    got, ref = gather(sym, period, n) if gather else ({}, None)
    if job is not None:
        job.join()
    got = {ex: splice(rows, tail.get(ex)) for ex, rows in got.items()}
    if not got or not ref:
        with _lock:
            _st.fails[key] = time.monotonic()
        return _no("no_data")
    px = _live(sym, ref[-1][3])
    st = make_state(sym, rng, got, ref, px, _now())
    res = render(st, px)
    with _lock:
        _st.hits[key] = (time.monotonic(), st, res)
        _st.fails.pop(key, None)
        _sweep()
        while len(_st.hits) > CACHE_MAX:
            del _st.hits[min(_st.hits, key=lambda k: _st.hits[k][0])]
    return res


def _fresh(key: tuple[str, str], px: float) -> dict[str, Json] | None:
    """Ответ по сборке key при текущей цене px (звать под _lock): цена ушла
    с прошлого ответа — уровни, до которых она дошла, сгорают насовсем."""
    hit = _st.hits.get(key)
    if hit is None:
        return None
    born, st, res = hit
    if res["px"] == px:
        return res
    st["low"], st["high"] = min(st["low"], px), max(st["high"], px)
    res = render(st, px)
    _st.hits[key] = (born, st, res)
    return res


def _served(key: tuple[str, str]) -> dict[str, Json] | None:
    """Ответ из кэша с текущей ценой, если сборка не старше STALE."""
    with _lock:
        hit = _st.hits.get(key)
        if not hit or time.monotonic() - hit[0] >= STALE:
            return None
        base = hit[1]["px"]
    px = _live(key[0], base)  # источник цены — вне _lock: может сходить в сеть
    with _lock:
        return _fresh(key, px)


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
    """Ответ /api/liqmap: из кэша с текущей ценой; сборка старше TTL окна —
    пересборка в фоне; карты нет — ждём сборку не дольше wait, не успела —
    «собираем» (building)."""
    s = _clean(sym)
    if not s or rng not in RANGES:
        return _no("bad_args")
    key = (s, str(rng))
    with _lock:
        hit = _st.hits.get(key)
        job = _start(key) if hit is None or time.monotonic() - hit[0] >= TTL[key[1]] else None
        resting = hit is None and key in _st.fails and job is None
    res = _served(key)
    if res is not None:
        return res
    if resting:
        return _no("no_data")
    if job is not None:
        job.join(wait)
    res = _served(key)
    if res is not None:
        return res
    with _lock:
        busy = key in _st.jobs
        failed = key in _st.fails
    return _no("building" if busy else "no_data" if failed else "busy")


def warm(sym: str, rng: str) -> None:
    """Прогрев (фоновый поток сервера): сборка старше TTL окна − минута —
    собрать сейчас, в этом потоке; свежая — ничего."""
    key = (sym, rng)
    with _lock:
        _sweep()
        hit = _st.hits.get(key)
        if (hit and time.monotonic() - hit[0] < TTL[rng] - 60) or key in _st.jobs:
            return
    build(sym, rng)

"""Фонды у хранителя по цепочке: разбор переводов хранилищ по «корзинам».

Сырьё пишет сканер бота (WhaleScanner/btc_etf.cpp) в btc.db:
  • btc_cust_vault — хранилища хранителя: им кошелёк комиссий хранителя
    присылает пылинку перед каждой тратой;
  • btc_cust_xfer — переводы, где хоть одна сторона — хранилище.

Хранилище всегда одного клиента, но чьё — по цепочке не написано. Отпечаток
фонда — корзина: фонд выпускает и гасит акции корзинами, поэтому каждый его
поток в биткоинах — ровно целое число корзин, до сатоши
(37,98156327 = 7 × 5,42593761 и 81,38906415 = 15 × 5,42593761 — BITB, один
день). Корзина у каждого фонда своя и медленно тает ровно на комиссию фонда.

Разбор:
  1. За день наибольший общий делитель разных сумм — корзина (якорь).
  2. Якоря склеиваются в фонд, если корзина тает как комиссия: позже — не
     больше, и не быстрее 2,5% в год.
  3. Перевод относится к фонду, если сумма — целое число его корзин на этот
     день (корзина между якорями — по прямой).
  4. Хранилище, чьи переводы относятся к одному фонду, — его; к нескольким —
     расчётный узел хранителя (через него идут деньги многих фондов).
  5. Поток фонда — переводы на его хранилища извне (приток) и с них наружу
     (отток); переводы между его хранилищами — внутри фонда.
Имя: корзина, в которой есть размеченный кошелёк фонда (btc_etf_addr:
опубликованные фондом, свой список, /import владельца), получает его тикер.
Остальные — «#…».

Сверка (check): поток размеченных кошельков фонда против его дневного
потока из «Институциональных потоков» — только проверка, правильно ли
размечено; разметку она не меняет.
"""

from __future__ import annotations

import hashlib
import itertools
import math
import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field

SAT = 100_000_000
# Корзина — от полубиткоина; мельче — сдача и пыль.
BASKET_MIN = SAT // 2
# Больше стольких корзин за перевод не бывает: заявка — десятки, редко сотни.
KMAX = 3000
# Тает не быстрее 2% в год (самая дорогая комиссия у спотовых фондов —
# 1,5% у GBTC) — доля за сутки.
DECAY_DAY = 0.02 / 365
# Склейка якорей через неделю и больше — только при общем адресе.
NEAR_DAYS = 7
# Дальше стольких суток от якорей корзину не угадываем: ошибка растёт, и
# случайная сумма начинает «совпадать».
REACH_DAYS = 30
# Насколько можем ошибиться в скорости таяния короткой линии — доля в год:
# по двум якорям через четыре дня скорость видна грубо (у BITB 1 721 против
# 2 670 сатоши в сутки за месяц).
RATE_SLACK = 0.003 / 365
# Фонд с одним якорем — только в эти сутки рядом с ним.
LONE_DAYS = 3
# Якорь бывает кратным корзине: если за день все заявки — чётное число
# корзин, общий делитель — две корзины. Кратность до стольких узнаём.
MULT_MAX = 12
# Хранилище — фонда, если к нему относятся хотя бы два перевода фонда, это
# четыре пятых отнесённых и не меньше половины всех его некруглых переводов:
# у хранилища фонда почти каждый перевод — целое число корзин, у чужого
# совпадения редки и случайны.
OWN_MIN = 2
OWN_SHARE = 0.8
OWN_ALL = 0.5
DAY = 86400


def roundish(v: int) -> bool:
    """Круглая сумма или «круглая минус комиссия сети» (до 0,001 BTC): так
    хранитель перекладывает между хранилищами, корзин таких не бывает."""
    r = v % 10_000_000
    return r < 100_000 or r > 10_000_000 - 100_000


@dataclass
class Xfer:
    day: int
    sats: int
    src: str
    dst: str
    sv: bool
    dv: bool


@dataclass
class Fund:
    anchors: list[tuple[int, int]] = field(default_factory=list)  # (день, корзина)
    addrs: set[str] = field(default_factory=set)

    def mixed(self) -> bool:
        """Линия склеила два фонда с почти одинаковой корзиной: якорь не лежит
        между соседями (корзина тает гладко, а у смеси скачет туда-сюда на
        разницу корзин). Такую линию не разбираем: лучше без потока, чем с
        чужим."""
        a = self.anchors
        if len(a) < 4:
            return False
        r = self.rate()
        bad = 0
        for (d0, q0), (d1, q1), (d2, q2) in zip(a, a[1:], a[2:], strict=False):
            if d2 == d0:
                bad += q0 != q1 or q1 != q2
                continue
            p = q0 + (q2 - q0) * (d1 - d0) / (d2 - d0)
            bad += abs(q1 - p) > 3 + r * (1 + 0.5 * (d2 - d0))
        return bad > 0.2 * (len(a) - 2)

    def rate(self) -> float:
        """Насколько корзина тает за сутки, сатоши; без двух якорей — оценка
        сверху по самой дорогой комиссии."""
        a = sorted(self.anchors)
        if len(a) >= 2 and a[-1][0] > a[0][0]:
            return max(1.0, (a[0][1] - a[-1][1]) / (a[-1][0] - a[0][0]))
        return a[0][1] * DECAY_DAY

    def basket(self, day: int) -> tuple[float, float] | None:
        """Корзина на день и допуск в сатоши на одну корзину; None — день
        слишком далеко от якорей, корзину не угадать."""
        a = sorted(self.anchors)
        r = self.rate()
        if len(a) == 1:
            dd = abs(day - a[0][0])
            return None if dd > LONE_DAYS else (float(a[0][1]), 3.0 + r * dd)
        if day < a[0][0] - REACH_DAYS or day > a[-1][0] + REACH_DAYS:
            return None
        for (d0, q0), (d1, q1) in itertools.pairwise(a):
            if d0 <= day <= d1:
                t = (day - d0) / max(1, d1 - d0)
                # В день якоря корзина известна до сатоши; между якорями тает
                # ровно, ошибка растёт к середине промежутка.
                return q0 + (q1 - q0) * t, 3.0 + r * 0.5 * min(day - d0, d1 - day)
        if day < a[0][0]:
            return a[0][1] + r * (a[0][0] - day), 3.0 + r * (1 + 0.3 * (a[0][0] - day))
        return a[-1][1] - r * (day - a[-1][0]), 3.0 + r * (1 + 0.3 * (day - a[-1][0]))

    def fee_year(self) -> float | None:
        """Комиссия фонда в год, % — по тому, как тает корзина."""
        a = sorted(self.anchors)
        if len(a) < 2 or a[-1][0] - a[0][0] < 5:
            return None
        rate = (a[0][1] - a[-1][1]) / (a[-1][0] - a[0][0])
        return max(0.0, rate * 365 / a[0][1] * 100)


class _Dsu:
    def __init__(self, n: int) -> None:
        self.p = list(range(n))

    def find(self, x: int) -> int:
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def join(self, a: int, b: int) -> None:
        self.p[self.find(a)] = self.find(b)


def _link_day(dsu: _Dsu, idx: dict[tuple[int, int], int], d: int, vals: list[int], nxt: list[int]) -> None:
    """Суммы дня (и следующего) с общим делителем — некруглой корзиной от
    полубиткоина — в одну группу."""
    near = vals + nxt
    for i, a in enumerate(vals):
        for j in range(i + 1, len(near)):
            g = math.gcd(a, near[j])
            if g >= BASKET_MIN and not roundish(g) and a // g <= KMAX and near[j] // g <= KMAX:
                dj = d if j < len(vals) else d + 1
                dsu.join(idx[(d, a)], idx[(dj, near[j])])


def anchors(xs: list[Xfer]) -> list[tuple[int, int, set[str]]]:
    """Якоря: (день, корзина, адреса). Суммы одного дня и соседнего связаны,
    если их общий делитель — некруглая корзина от полубиткоина."""
    cand = sorted({(x.day, x.sats) for x in xs if x.sats >= BASKET_MIN and not roundish(x.sats)})
    idx = {c: i for i, c in enumerate(cand)}
    by_day: dict[int, list[int]] = defaultdict(list)
    for d, v in cand:
        by_day[d].append(v)
    dsu = _Dsu(len(cand))
    for d, vals in by_day.items():
        _link_day(dsu, idx, d, vals, by_day.get(d + 1, []))
    groups: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for c in cand:
        groups[dsu.find(idx[c])].append(c)
    addr_of: dict[tuple[int, int], set[str]] = defaultdict(set)
    for x in xs:
        addr_of[(x.day, x.sats)] |= {x.src, x.dst}
    out = []
    for members in groups.values():
        per: dict[int, list[int]] = defaultdict(list)
        for d, v in members:
            per[d].append(v)
        # Корзина — только если за день есть хотя бы две разные суммы:
        # одинаковые суммы — одна передача по цепочке, а не корзины.
        for d, vals in per.items():
            if len(vals) < 2:
                continue
            g = 0
            for v in vals:
                g = math.gcd(g, v)
            if g >= BASKET_MIN and not roundish(g):
                out.append((d, g, set().union(*(addr_of[(dd, v)] for dd, v in members))))
    return out


def funds(xs: list[Xfer]) -> list[Fund]:
    """Якоря — в фонды.

    Первый проход: якоря не дальше недели друг от друга с той же корзиной —
    позже не больше и тает не быстрее комиссии. Общий адрес не в счёт: через
    расчётный узел хранителя идут деньги всех фондов.

    Второй проход: якорь бывает кратным корзине (за день все заявки — чётное
    число корзин, и общий делитель — две корзины). Маленькая линия, чей якорь
    делится нацело на корзину большой линии в тот же день с точностью до
    суточного таяния (миллионные доли), — та же большая линия.
    """
    an = anchors(xs)
    dsu = _Dsu(len(an))
    for i in range(len(an)):
        for j in range(i + 1, len(an)):
            (de, qe, _), (dl, ql, _) = (an[i], an[j]) if an[i][0] <= an[j][0] else (an[j], an[i])
            dd = dl - de
            if dd <= NEAR_DAYS and -3e-6 <= (qe - ql) / qe <= DECAY_DAY * dd + 3e-6:
                dsu.join(i, j)
    groups: dict[int, list[int]] = defaultdict(list)
    for i in range(len(an)):
        groups[dsu.find(i)].append(i)
    lines = sorted(groups.values(), key=len, reverse=True)
    fs: list[Fund] = []
    for idx in lines:
        f = Fund()
        for i in idx:
            f.anchors.append((an[i][0], an[i][1]))
            f.addrs |= an[i][2]
        f.anchors.sort()
        fs.append(f)
    # Кратные линии — в линию с корзиной меньше; склеенные — через пропуски;
    # и так, пока что-то склеивается.
    while True:
        n = len(fs)
        fs = _bridge(_fold(fs))
        if len(fs) == n:
            return fs


def _fold(fs: list[Fund]) -> list[Fund]:
    """Якорь, который — целое число корзин устоявшейся линии (там, где её
    корзина известна), переходит в неё: дни, когда заявки шли кратно двум,
    трём корзинам. По одному якорю: случайный якорь в кратной линии не мешает
    перенести остальные. Линии с корзиной меньше — первыми."""
    homes = sorted((f for f in fs if len(f.anchors) >= 3), key=lambda f: f.anchors[0][1])
    for f in fs:
        keep = []
        for d, q in f.anchors:
            home = None
            for h in homes:
                if h is not f and h.anchors and h.anchors[0][1] < q and _divides(q, d, h):
                    home = h
                    break
            if home is None:
                keep.append((d, q))
                continue
            b = home.basket(d)
            if b is None:
                keep.append((d, q))
                continue
            home.anchors.append((d, q // round(q / b[0])))
        f.anchors = keep
    for h in homes:
        h.anchors = sorted(set(h.anchors))
    return [f for f in fs if f.anchors]


def _predict(line: Fund, day: int) -> tuple[float, float]:
    """Корзина линии на день по её прямой и допуск: в день якоря — до
    сатоши, дальше от якорей — на долю суточного таяния за каждый день."""
    a = line.anchors
    r = line.rate()
    for (d0, q0), (d1, q1) in itertools.pairwise(a):
        if d0 <= day <= d1:
            return q0 + (q1 - q0) * (day - d0) / max(1, d1 - d0), 3 + r * (1 + 0.5 * min(day - d0, d1 - day))
    if day < a[0][0]:
        return a[0][1] + r * (a[0][0] - day), 3 + r * (1 + 0.2 * (a[0][0] - day))
    return a[-1][1] - r * (day - a[-1][0]), 3 + r * (1 + 0.2 * (day - a[-1][0]))


def _bridge(fs: list[Fund]) -> list[Fund]:
    """Одна линия фонда рвётся на несколько: неделю и больше не было двух
    заявок в день, или кратные якоря легли поверх. Устоявшаяся линия знает,
    как тает корзина: если её прямая предсказывает каждый якорь другой линии
    (до двух месяцев в сторону) с точностью до суточного таяния, — это тот же
    фонд."""
    merged = True
    while merged:
        merged = False
        fs = sorted(fs, key=lambda f: -len(f.anchors))
        for a in fs:
            if len(a.anchors) < 2:
                continue
            for b in fs:
                if b is a or not b.anchors:
                    continue
                ok = True
                for d, q in b.anchors:
                    if d < a.anchors[0][0] - 60 or d > a.anchors[-1][0] + 60:
                        ok = False
                        break
                    p, tol = _predict(a, d)
                    far = max(0, a.anchors[0][0] - d, d - a.anchors[-1][0])
                    if abs(p - q) > tol + p * RATE_SLACK * far:
                        ok = False
                        break
                if ok:
                    a.anchors = sorted(set(a.anchors + b.anchors))
                    a.addrs |= b.addrs
                    b.anchors = []
                    merged = True
            fs = [f for f in fs if f.anchors]
            if merged:
                break
    return fs


def _divides(q: int, day: int, line: Fund) -> bool:
    """Якорь q в этот день — целое число (2…MULT_MAX) корзин линии."""
    b = line.basket(day)
    if b is None:
        return False
    base, _ = b
    m = round(q / base)
    if not 2 <= m <= MULT_MAX or q % m:
        return False
    return abs(q // m - base) <= 3 + line.rate()


def attribute(xs: list[Xfer], fs: list[Fund]) -> list[int | None]:
    """Каждому переводу — фонд, чьё целое число корзин он есть; спорный (под
    два фонда) и ничей — None."""
    out: list[int | None] = []
    for x in xs:
        hit = None
        for k, f in enumerate(fs):
            b = f.basket(x.day)
            if b is None:
                continue
            q, tol = b
            n = round(x.sats / q)
            if 1 <= n <= KMAX and abs(x.sats - n * q) <= n * tol + 2:
                if hit is not None:
                    hit = None
                    break
                hit = k
        out.append(hit)
    return out


@dataclass
class Result:
    funds: list[Fund]
    owner: dict[str, int]
    hubs: set[str]
    days: dict[int, dict[int, list[float]]]  # фонд → день → [приток, отток] BTC
    names: dict[int, str] = field(default_factory=dict)


# Сколько переводов между хранилищами фонда и опубликованными кошельками
# тикера нужно, чтобы назвать фонд этим тикером.
NAME_MIN = 2


def _names(xs: list[Xfer], owner: dict[str, int], published: dict[str, str]) -> dict[int, str]:
    """Фонд получает тикер, если его хранилище — среди кошельков, которые
    фонд опубликовал сам, или он гоняет деньги с ними (главное хранилище BITB
    раскладывает приток по опубликованным холодным кошелькам: 300 + 700)."""
    score: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for a, k in owner.items():
        if a in published:
            score[k][published[a]] += NAME_MIN
    for x in xs:
        for mine, other in ((x.src, x.dst), (x.dst, x.src)):
            who = owner.get(mine)
            if who is not None and other in published and other not in owner:
                score[who][published[other]] += 1
    names: dict[int, str] = {}
    taken: set[str] = set()
    for k, sc in sorted(score.items(), key=lambda kv: -max(kv[1].values())):
        t, n = max(sc.items(), key=lambda kv: kv[1])
        if n >= NAME_MIN and t not in taken and sum(1 for v in sc.values() if v >= NAME_MIN) == 1:
            names[k] = t
            taken.add(t)
    return names


def _ownership(xs: list[Xfer], attr: list[int | None]) -> tuple[dict[str, int], set[str]]:
    """Чьё хранилище: фонда, к которому относится почти всё, что через него
    идёт; хранилище нескольких фондов — расчётный узел хранителя."""
    seen: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    total: dict[str, int] = defaultdict(int)
    for x in xs:
        if x.sats >= BASKET_MIN and not roundish(x.sats):
            if x.sv:
                total[x.src] += 1
            if x.dv:
                total[x.dst] += 1
    for x, k in zip(xs, attr, strict=True):
        if k is None:
            continue
        if x.sv:
            seen[x.src][k] += 1
        if x.dv:
            seen[x.dst][k] += 1
    owner: dict[str, int] = {}
    hubs: set[str] = set()
    for a, ks in seen.items():
        strong = {k: n for k, n in ks.items() if n >= OWN_MIN}
        k, n = max(ks.items(), key=lambda kv: kv[1])
        if len(strong) > 1:
            hubs.add(a)
        elif n >= OWN_MIN and n >= OWN_SHARE * sum(ks.values()) and n >= OWN_ALL * total[a]:
            owner[a] = k
    return owner, hubs


def analyse(xs: list[Xfer], published: dict[str, str] | None = None) -> Result:
    fs = [f for f in funds(xs) if not f.mixed()]
    owner, hubs = _ownership(xs, attribute(xs, fs))
    published = published or {}
    names = _names(xs, owner, published)
    # Опубликованные кошельки названного фонда — его хранилища: переводы между
    # ними — внутри фонда, а не отток.
    by_ticker = {t: k for k, t in names.items()}
    for a, t in published.items():
        if t in by_ticker and a not in hubs:
            owner.setdefault(a, by_ticker[t])
    days: dict[int, dict[int, list[float]]] = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))
    for x in xs:
        s = owner.get(x.src)
        d = owner.get(x.dst)
        if d is not None and d != s:
            days[d][x.day][0] += x.sats / SAT
        if s is not None and s != d:
            days[s][x.day][1] += x.sats / SAT
    return Result(fs, owner, hubs, days, names)


def _name(k: int, res: Result) -> str:
    if k in res.names:
        return res.names[k]
    vaults = sorted(a for a, o in res.owner.items() if o == k)
    seed = vaults[0] if vaults else str(sorted(res.funds[k].anchors)[0])
    return "#" + hashlib.sha256(seed.encode()).hexdigest()[:4]


def known_names(con: sqlite3.Connection) -> dict[str, str]:
    """Адрес → тикер: своя разметка бота (btc_etf_addr)."""
    return {str(r[0]): str(r[1]) for r in con.execute(
        "SELECT address, fund FROM btc_etf_addr WHERE fund NOT LIKE '#%'")}


def fund_series(reply: dict[str, object]) -> dict[str, dict[int, float | None]]:
    """Ежедневные потоки фондов в биткоинах — из ответа /api/etf
    (coins.btc): строка дня — [время, итог $ тыс., монет, цена, [поток фонда
    $ тыс. | None]]. Монеты — доллары по цене дня."""
    coins = reply.get("coins")
    btc = coins.get("btc") if isinstance(coins, dict) else None
    if not isinstance(btc, dict):
        return {}
    funds = [f for f in btc.get("funds") or [] if isinstance(f, dict)]
    days: dict[str, dict[int, float | None]] = {str(f.get("t")): {} for f in funds}
    for row in btc.get("days") or []:
        if not isinstance(row, list) or len(row) < 5 or not isinstance(row[4], list):
            continue
        day, px = int(row[0]) // DAY, float(row[3] or 0)
        for f, v in zip(funds, row[4], strict=False):
            days[str(f.get("t"))][day] = None if v is None or px <= 0 else float(v) * 1000 / px
    return days


def load(con: sqlite3.Connection, since: int) -> list[Xfer]:
    return [
        Xfer(int(r[0]) // DAY, int(r[1]), str(r[2]), str(r[3]), bool(r[4]), bool(r[5]))
        for r in con.execute(
            "SELECT ts, sats, src, dst, sv, dv FROM btc_cust_xfer WHERE ts >= ? ORDER BY ts", (since,))
    ]


def build(con: sqlite3.Connection, now: int, days: int = 60) -> list[dict[str, object]]:
    """Фонды хранителя за `days` суток: имя, хранилища, корзина, комиссия,
    приток и отток по суткам UTC. Крупнейшие по обороту — первыми."""
    # Якоря и хранилища — по более длинной истории: корзина, найденная
    # месяц назад, помогает узнать фонд сегодня.
    xs = load(con, now - max(days, 120) * DAY)
    published = known_names(con)
    res = analyse(xs, published)
    first = now // DAY - days + 1
    out = []
    for k, f in enumerate(res.funds):
        flow = res.days.get(k, {})
        rows = [[d * DAY, round(v[0], 8), round(v[1], 8)] for d, v in sorted(flow.items()) if d >= first]
        vol = sum(r[1] + r[2] for r in rows)
        if not rows:
            continue
        a = sorted(f.anchors)
        fee = f.fee_year()
        out.append({
            "t": _name(k, res),
            "vaults": sum(1 for o in res.owner.values() if o == k),
            # Хранилища группы — для памяти имени; приложению не отдаются.
            "_vaults": sorted(a for a, o in res.owner.items() if o == k),
            "basket": round(a[-1][1] / SAT, 8),
            "fee": None if fee is None else round(fee, 3),
            "days": rows,
            "vol": round(vol, 8),
        })
    out.sort(key=lambda r: -float(r["vol"]))  # type: ignore[arg-type]
    return out


# ── Имена по сверке потоков ─────────────────────────────────────────────────
#
# Сверка разметки с ежедневными потоками фондов. В цепочке деньги фонда
# приходят на следующий рабочий день после торгов (T+1): заявка BITB во
# вторник 8 сентября — в среду 9-го, в пятницу 18-го — в понедельник 21-го.
# Отчётные цифры в биткоинах пересчитаны из долларов по своей цене, поэтому
# сходятся до процентов, а не до сатоши.

# «Сходится»: суммарное расхождение — не больше доли от суммарного оборота.
MATCH_ERR = 0.12
# Сколько дней с движением нужно для вывода.
MATCH_DAYS = 4
# «Верно, но не всё»: видна доля потока фонда от PART_MIN до PART_MAX, и
# после поправки на эту долю потоки сходятся так.
PART_MIN = 0.05
PART_MAX = 0.9
PART_ERR = 0.25


def settle_day(trade_day: int) -> int:
    """Сутки, когда заявка торгового дня доходит до цепочки: следующий
    рабочий день (пятница → понедельник). Праздники биржи не учтены — такой
    день просто разойдётся, сверке хватает остальных."""
    d = trade_day + 1
    while (d + 3) % 7 in (5, 6):  # 1 января 1970 — четверг: (d + 3) % 7 — понедельник = 0
        d += 1
    return d


def _err(pairs: list[tuple[float, float]]) -> float:
    tot = sum(abs(a) + abs(b) for a, b in pairs)
    return sum(abs(a - b) for a, b in pairs) / tot if tot else 1.0


def check(chain: dict[int, float], fund: dict[int, float | None], window: tuple[int, int]) -> dict[str, object]:
    """Сверка разметки фонда: его поток по размеченным кошелькам (сутки
    цепочки → BTC) против дневного потока фонда (торговые сутки → BTC; None
    — не отчитался) за окно (сутки цепочки, включительно).

    {"v": вывод, "days": сравнено дней с движением, "err": расхождение 0…1,
    "share": какую долю потока фонда видит разметка}. Вывод: «ok» —
    сходится; «part» — размечено верно, но не всё; «bad» — не сходится
    (проверить разметку); «few» — мало дней с движением."""
    want: dict[int, float] = defaultdict(float)
    for d, v in fund.items():
        if v is not None:
            want[settle_day(d)] += v
    first = max(window[0], min(want, default=window[0]))
    last = min(window[1], max(want, default=window[0] - 1))
    pairs = [(chain.get(d, 0.0), want.get(d, 0.0)) for d in range(first, last + 1)]
    pairs = [(a, b) for a, b in pairs if abs(a) >= 1 or abs(b) >= 1]
    if len(pairs) < MATCH_DAYS:
        return {"v": "few", "days": len(pairs), "err": None, "share": None}
    err = _err(pairs)
    bb = sum(b * b for _, b in pairs)
    share = sum(a * b for a, b in pairs) / bb if bb else 0.0
    if err <= MATCH_ERR:
        verdict = "ok"
    elif PART_MIN <= share < PART_MAX and _err([(a / share, b) for a, b in pairs]) <= PART_ERR:
        verdict = "part"
    else:
        verdict = "bad"
    return {"v": verdict, "days": len(pairs), "err": round(err, 3), "share": round(share, 3)}

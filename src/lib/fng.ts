/**
 * Страх и жадность — модуль приложения: тип ответа /api/fng, его проверка и
 * все расчёты экрана (зоны, полосы, «что было после»). Без React и без
 * зависимостей: тесты (node --test) гоняют его как есть.
 *
 * Индекс — alternative.me, цена BTC — mempool.space, а где её нет —
 * Hyperliquid (флаг F_HL; сервер — wt_fng.py).
 * Ответ проверяется целиком: подменённый, обрезанный или старый (в том числе
 * сохранённый в телефоне ответ прежнего формата, с ценой Binance) экран не
 * роняет — берётся свежий или экран просит повторить.
 */

/**
 * День: [начало суток UTC, индекс 0–100, закрытие BTC $ (0 — цены нет),
 * флаги F_EST | F_FILL | F_HL]. Дни идут подряд, без пропусков.
 */
export type FngDay = readonly [t: number, v: number, px: number, f: number];

export interface FngReply {
  ok: true;
  days: FngDay[];
  /** Когда сервер собрал ответ, unix с. */
  at: number;
}

/** Ответ живёт столько же, сколько на сервере (wt_fng.TTL). */
export const FNG_TTL_MS = 30 * 60_000;
/** Цена дня досчитана между недельными точками (до середины 2022 года). */
export const F_EST = 1;
/** Индекса за день у alternative.me нет — взят прошлый день. */
export const F_FILL = 2;
/** Цена дня — запасная, Hyperliquid (у mempool.space её нет или она устарела). */
export const F_HL = 4;
const DAY = 86_400;
/** Первый день индекса alternative.me — 1 февраля 2018 г. */
export const FNG_START = 1_517_443_200;
/** Меньше дней — обрезанный ответ (как MIN_DAYS в wt_fng.py). */
const DAYS_MIN = 1000;
const DAYS_MAX = 200_000;
const PX_MIN = 1000;
const PX_MAX = 10_000_000;
/** На сколько часы телефона могут отставать от сервера: дни сверяются со
 *  временем ответа (at), а at — с телефоном с этим запасом. */
export const CLOCK_LAG = 366 * DAY;
/** Последний день ответа может быть впереди at не больше чем на это (сутки
 *  индекса начинаются в 00:00 UTC, а часы источника могут спешить). */
const AHEAD = DAY;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Проверенная копия ответа /api/fng или null. Любая ошибка в любом дне —
 * ответ не годится: дыра в днях сдвинула бы «неделю назад» и «через 30 дней».
 * now — «сейчас», unix с (по умолчанию — часы телефона).
 */
export function validFng(raw: unknown, now: number = Date.now() / 1000): FngReply | null {
  if (!isObj(raw) || raw["ok"] !== true) return null;
  const at = raw["at"];
  const days = raw["days"];
  if (!isInt(at) || at < FNG_START || at > now + CLOCK_LAG) return null;
  if (!Array.isArray(days) || days.length < DAYS_MIN || days.length > DAYS_MAX) return null;
  const out: FngDay[] = [];
  let prev = 0;
  for (const d of days as unknown[]) {
    if (!Array.isArray(d) || d.length !== 4) return null;
    const [ts, v, px, f] = d as unknown[];
    // Первый день — не раньше начала индекса и в полночь UTC, дальше — подряд.
    const first = !prev && isInt(ts) && ts >= FNG_START && ts % DAY === 0;
    if ((!first && ts !== prev + DAY) || !isInt(ts) || !isInt(v) || v < 0 || v > 100) return null;
    if (!isNum(px) || (px !== 0 && (px <= PX_MIN || px >= PX_MAX))) return null;
    if (!isInt(f) || f < 0 || f > (F_EST | F_FILL | F_HL)) return null;
    out.push([ts, v, px, f]);
    prev = ts;
  }
  if (prev > at + AHEAD) return null;
  return { ok: true, days: out, at };
}

/* ---------------------------------------------------------------------- */

/** Зоны индекса: границы — как у самого alternative.me. Цвета — привычные:
 *  красный — крайний страх … зелёный — крайняя жадность. */
export const ZONES = [
  { max: 25, key: "fg_z0", c: "#ea3943" },
  { max: 46, key: "fg_z1", c: "#f5841f" },
  { max: 54, key: "fg_z2", c: "#f3d42f" },
  { max: 75, key: "fg_z3", c: "#93d900" },
  { max: 100, key: "fg_z4", c: "#16c784" },
] as const;
export type ZoneKey = (typeof ZONES)[number]["key"];

/** Номер зоны 0–4 (индекс из проверенного ответа всегда 0–100). */
export function zoneOf(v: number): number {
  const i = ZONES.findIndex((z) => v <= z.max);
  return i < 0 ? ZONES.length - 1 : i;
}
export const zoneKey = (v: number): ZoneKey => ZONES[zoneOf(v)]!.key;
export const colorOf = (v: number): string => ZONES[zoneOf(v)]!.c;

export function median(a: readonly number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Дни окна: последние n дней или вся история. */
export function windowOf(days: readonly FngDay[], range: "30" | "90" | "365" | "1095" | "all"): readonly FngDay[] {
  return range === "all" ? days : days.slice(-Number(range));
}

/** Самый высокий и самый низкий индекс за последний год (первый такой день). */
export function yearExtremes(days: readonly FngDay[]): { hi: FngDay; lo: FngDay } | null {
  const y = days.slice(-365);
  const first = y[0];
  if (!first) return null;
  let hi = first;
  let lo = first;
  for (const d of y) {
    if (d[1] > hi[1]) hi = d;
    if (d[1] < lo[1]) lo = d;
  }
  return { hi, lo };
}

/** Сколько дней окна в каждой зоне и средний индекс. */
export function distribution(days: readonly FngDay[]): { cnt: number[]; avg: number; total: number } {
  const cnt = ZONES.map(() => 0);
  let sum = 0;
  for (const d of days) {
    cnt[zoneOf(d[1])]! += 1;
    sum += d[1];
  }
  return { cnt, avg: days.length ? sum / days.length : 0, total: days.length };
}

/** Полосы — дни подряд в одной зоне: [первый день, последний день, зона]. */
function runsOf(days: readonly FngDay[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  let i = 0;
  while (i < days.length) {
    const z = zoneOf(days[i]![1]);
    let j = i;
    while (j + 1 < days.length && zoneOf(days[j + 1]![1]) === z) j++;
    out.push([i, j, z]);
    i = j + 1;
  }
  return out;
}

export interface Streak {
  /** Сколько полос закончилось и их суммарная длина (для средней). */
  n: number;
  sum: number;
  /** Рекорд, дней, и день его начала. */
  max: number;
  maxAt: number;
  /** Куда индекс уходил после полосы: сколько раз в каждую зону. */
  next: number[];
}

/**
 * Полосы по зонам: сколько закончилось, средняя длина, рекорд (с днём
 * начала) и куда индекс уходил после. Ещё идущая полоса в среднее не
 * входит — она не закончилась, но в рекорд попадает. Первая полоса окна
 * тоже не входит, если окно начинается не с начала истории (cutStart): её
 * начало обрезано.
 */
export function streakStats(days: readonly FngDay[], cutStart: boolean): Streak[] {
  const out: Streak[] = ZONES.map(() => ({ n: 0, sum: 0, max: 0, maxAt: 0, next: ZONES.map(() => 0) }));
  for (const [i, j, z] of runsOf(days)) {
    if (cutStart && i === 0) continue;
    const s = out[z]!;
    const len = j - i + 1;
    if (len > s.max) {
      s.max = len;
      s.maxAt = days[i]![0];
    }
    const after = days[j + 1];
    if (after) {
      s.n += 1;
      s.sum += len;
      s.next[zoneOf(after[1])]! += 1;
    }
  }
  return out;
}

/** Текущая полоса: зона последнего дня и сколько дней подряд индекс в ней. */
export function currentStreak(days: readonly FngDay[]): { zi: number; len: number } | null {
  const last = days[days.length - 1];
  if (!last) return null;
  const zi = zoneOf(last[1]);
  let k = days.length - 1;
  while (k > 0 && zoneOf(days[k - 1]![1]) === zi) k -= 1;
  return { zi, len: days.length - k };
}

/**
 * Сколько ещё держались прошлые полосы этой зоны, дожившие до нынешней
 * длины: медиана остатка и доля тех, что продлились ещё неделю. Меньше пяти
 * таких полос — null: по двум случаям выводов нет.
 */
export function streakLeft(days: readonly FngDay[], cur: { zi: number; len: number }): { n: number; med: number; week: number } | null {
  const rest: number[] = [];
  for (const [i, j, z] of runsOf(days)) {
    const len = j - i + 1;
    if (j + 1 < days.length && z === cur.zi && len >= cur.len) rest.push(len - cur.len);
  }
  if (rest.length < 5) return null;
  return { n: rest.length, med: median(rest), week: rest.filter((r) => r >= 7).length / rest.length };
}

/* --- Что было после (блок «Что скрыто в данных») ------------------------- */

/**
 * После начала зоны: куда цена ушла дальше за 90 дней и через сколько.
 * Началом считается первый день зоны после недели без неё: индекс часто
 * выскакивает из крайнего страха на день и возвращается, и такие «новые
 * начала» считали бы один и тот же эпизод по нескольку раз.
 */
export const FRESH = 7;
export function afterEntry(days: readonly FngDay[], z: number, down: boolean): { n: number; move: number; days: number; calm: number } {
  const moves: number[] = [];
  const when: number[] = [];
  for (let i = FRESH; i < days.length - 90; i++) {
    const d = days[i]!;
    if (zoneOf(d[1]) !== z || !(d[2] > 0)) continue;
    let fresh = true;
    for (let k = i - FRESH; k < i; k++) if (zoneOf(days[k]![1]) === z) fresh = false;
    if (!fresh) continue;
    const w = days.slice(i, i + 91).map((x) => x[2]).filter((p) => p > 0);
    const ext = down ? Math.min(...w) : Math.max(...w);
    moves.push(ext / d[2] - 1);
    when.push(w.indexOf(ext));
  }
  return {
    n: moves.length,
    move: median(moves),
    days: median(when),
    calm: moves.length ? moves.filter((m) => m > -0.05).length / moves.length : 0,
  };
}

/** Цена через h дней после дня в каждой зоне: медиана и доля случаев выше. */
export function forward(days: readonly FngDay[], h: number): { n: number; med: number; up: number }[] {
  return ZONES.map((_, z) => {
    const r: number[] = [];
    for (let i = 0; i + h < days.length; i++) {
      const a = days[i]!;
      const b = days[i + h]!;
      if (zoneOf(a[1]) === z && a[2] > 0 && b[2] > 0) r.push(b[2] / a[2] - 1);
    }
    return { n: r.length, med: median(r), up: r.length ? r.filter((x) => x > 0).length / r.length : 0 };
  });
}

/**
 * Дни до последнего дня с ценой включительно. Цены за сегодня может ещё не
 * быть (сервер не получил текущую), и «сейчас» для расчётов о цене — это
 * последний день, где она известна: иначе покупки стоили бы «$0», а сегодня
 * не было бы ни дна, ни вершины.
 */
export function pricedPrefix(days: readonly FngDay[]): readonly FngDay[] {
  let i = days.length - 1;
  while (i >= 0 && !(days[i]![2] > 0)) i -= 1;
  return i === days.length - 1 ? days : days.slice(0, i + 1);
}

/**
 * Дни с первого дня с ценой — для графика: панели цены и индекса на одной
 * оси времени, и начало без цены (запасная история Hyperliquid — только с
 * августа 2020) не оставляет пустой треть панели цены. Цен нет совсем —
 * все дни (график — один индекс).
 */
export function fromFirstPrice(days: readonly FngDay[]): readonly FngDay[] {
  const i = days.findIndex((d) => d[2] > 0);
  return i <= 0 ? days : days.slice(i);
}

/** Последняя известная цена BTC, $; 0 — цен нет ни за один день. */
export function lastPrice(days: readonly FngDay[]): number {
  const p = pricedPrefix(days);
  return p[p.length - 1]?.[2] ?? 0;
}

/** Покупка на сумму в день с даты from — только в дни, что проходят отбор;
 *  стоимость — по последней известной цене. */
export function dca(days: readonly FngDay[], amount: number, from: number, pick: (z: number) => boolean): { inv: number; val: number } {
  let inv = 0;
  let btc = 0;
  for (const d of days) {
    if (d[0] < from || !(d[2] > 0) || !pick(zoneOf(d[1]))) continue;
    inv += amount;
    btc += amount / d[2];
  }
  return { inv, val: btc * lastPrice(days) };
}

/** Похожие дни: индекс ±5, его ход за месяц ±10, цена за месяц в ту же
 *  сторону. «Сегодня» — последний день с ценой (см. pricedPrefix). */
export function analogs(all: readonly FngDay[]): {
  v: number; c: number; up: boolean; n: number; up30: number; med30: number; up90: number; med90: number;
} | null {
  const days = pricedPrefix(all);
  const n = days.length;
  const i0 = n - 1;
  if (n < 400) return null;
  const v = days[i0]![1];
  const c = v - days[i0 - 30]![1];
  /* Цены месяц назад нет — хода цены не знаем, и сравнивать не с чем. */
  if (!(days[i0 - 30]![2] > 0)) return null;
  const up = days[i0]![2] >= days[i0 - 30]![2];
  const r30: number[] = [];
  const r90: number[] = [];
  let count = 0;
  for (let i = 30; i < n - 30; i++) {
    const d = days[i]!;
    if (Math.abs(d[1] - v) > 5 || Math.abs(d[1] - days[i - 30]![1] - c) > 10) continue;
    const pb = days[i - 30]![2];
    if (!(d[2] > 0) || !(pb > 0) || (d[2] >= pb) !== up) continue;
    const p30 = days[i + 30]![2];
    if (!(p30 > 0)) continue;
    count += 1;
    r30.push(p30 / d[2] - 1);
    const p90 = days[i + 90]?.[2] ?? 0;
    if (p90 > 0) r90.push(p90 / d[2] - 1);
  }
  const share = (a: number[]) => (a.length ? a.filter((x) => x > 0).length / a.length : 0);
  return { v, c, up, n: count, up30: share(r30), med30: median(r30), up90: share(r90), med90: median(r90) };
}

/** Расхождение сейчас: цена на краю 60 дней, а настроение — с другой
 *  стороны. «Сейчас» — последний день с ценой (см. pricedPrefix). */
export function divergence(all: readonly FngDay[]): { kind: "hi" | "lo"; n: number; med: number } | null {
  const days = pricedPrefix(all);
  const n = days.length;
  if (n < 120) return null;
  const prices = (i: number) => days.slice(i - 60, i).map((d) => d[2]).filter((p) => p > 0);
  /* Окно без единой цены — не край: Math.max() пустого — −∞, Math.min() — +∞. */
  const high = (i: number) => {
    const w = prices(i);
    return days[i]![2] > 0 && w.length > 0 && days[i]![2] >= Math.max(...w);
  };
  const low = (i: number) => {
    const w = prices(i);
    return days[i]![2] > 0 && w.length > 0 && days[i]![2] <= Math.min(...w);
  };
  const hist = (test: (i: number) => boolean) => {
    const r: number[] = [];
    for (let i = 60; i < n - 30; i++) {
      const later = days[i + 30]![2];
      if (later > 0 && test(i)) r.push(later / days[i]![2] - 1);
    }
    return { n: r.length, med: median(r) };
  };
  const i0 = n - 1;
  if (high(i0) && days[i0]![1] <= 50) return { kind: "hi", ...hist((i) => high(i) && days[i]![1] <= 50) };
  if (low(i0) && days[i0]![1] >= 50) return { kind: "lo", ...hist((i) => low(i) && days[i]![1] >= 50) };
  return null;
}

/** Последний день с досчитанной (недельной) ценой или 0 — для подписи под графиком. */
export function estUntil(days: readonly FngDay[]): number {
  for (let i = days.length - 1; i >= 0; i--) if (days[i]![3] & F_EST) return days[i]![0];
  return 0;
}

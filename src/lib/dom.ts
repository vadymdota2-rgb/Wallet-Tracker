/**
 * Альтсезон и сила биткоина — модуль приложения: тип ответа /api/dom, его
 * проверка и расчёты экрана. Без React и без зависимостей: тесты (node --test)
 * гоняют его как есть.
 *
 * Всё на сервере посчитано своим счётом по дневным ценам Hyperliquid
 * (wt_dom.py). Ответ проверяется целиком: подменённый или старый (в том числе
 * сохранённый в телефоне ответ прежнего формата, с долями CoinMarketCap) не
 * годится — экран берёт свежий или просит повторить.
 */

/**
 * Закрытый день: [начало суток UTC, индекс альтсезона 0–100 или null, сила
 * альтов (100 — первый день) или null (корзины ещё нет), ETH/BTC или null,
 * цена BTC $, монет в корзине индекса или null (индекса нет)]. Дни — с
 * первого дня цен Hyperliquid (2020 г.): ETH/BTC видно за всю историю.
 */
export type DomDay = [number, number | null, number | null, number | null, number, number | null];

/** Ширина рынка за последний день: [монет в корзине, индекс или null, сколько из них с историей за 90 дней]. */
export type DomTier = [number, number | null, number];

export interface DomReply {
  ok: true;
  rows: DomDay[];
  /** Монеты корзины: [монета, рост за 90 дней %], по убыванию. */
  coins: [string, number][];
  /** Рост биткоина за те же 90 дней, %. */
  btc90: number | null;
  /** Индекс последнего дня для корзин 25, 50 и 100 самых торгуемых монет. */
  tiers: DomTier[];
  /** Сколько монет в корзине (самые торгуемые за 30 дней до дня). */
  n: number;
  at: number;
}

/** Ответ живёт столько же, сколько на сервере (wt_dom.TTL). */
export const DOM_TTL_MS = 60 * 60_000;
const DAY = 86_400;
/** Начало дневных цен Hyperliquid — 19 августа 2020 г. */
export const PX_FROM = 1_597_795_200;
const DAYS_MAX = 10_000;
const COINS_MAX = 200;
/** Корзина индекса — не меньше стольких монет (wt_dom.MIN_BASKET). */
export const MIN_BASKET = 30;
const TIERS_MAX = 5;
const COIN = /^[A-Za-z0-9]{1,20}$/;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const within = (v: unknown, lo: number, hi: number): v is number => isNum(v) && v >= lo && v <= hi;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function validRows(raw: unknown, at: number): DomDay[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > DAYS_MAX) return null;
  const out: DomDay[] = [];
  let prev = 0;
  for (const r of raw) {
    if (!Array.isArray(r) || r.length !== 6) return null;
    const [ts, idx, str, eb, px, n] = r as unknown[];
    if (!within(ts, PX_FROM, at + 2 * DAY) || ts % DAY !== 0 || ts <= prev) return null;
    if (idx !== null && (!within(idx, 0, 100) || !Number.isInteger(idx))) return null;
    if ((str !== null && !within(str, 1e-6, 1e6)) || (eb !== null && !within(eb, 1e-6, 10)) || !within(px, 1e-6, 1e8)) return null;
    // Индекс и корзина — вместе: индекс без корзины (или корзина без индекса) — подделка.
    if ((idx === null) !== (n === null) || (n !== null && (!within(n, MIN_BASKET, COINS_MAX) || !Number.isInteger(n)))) return null;
    out.push([ts, idx as number | null, str as number | null, eb as number | null, px, n as number | null]);
    prev = ts;
  }
  return out;
}

/** На сколько часы телефона могут отставать от сервера (сбились после
 *  разрядки, выставлены вручную): ответ всё равно годен. Дни ответа
 *  сверяются с его собственным временем (at — часы сервера), а не с
 *  телефоном: иначе при отставших часах экран говорил бы «не удалось
 *  загрузить», хотя данные в порядке. */
export const CLOCK_LAG = 366 * DAY;

/**
 * Проверенная копия ответа /api/dom или null. Дни — главное: любая ошибка в
 * них — ответ не годится. Монета с ошибкой просто не попадает в список.
 * now — «сейчас», unix с (по умолчанию — часы телефона).
 */
export function validDom(raw: unknown, now: number = Date.now() / 1000): DomReply | null {
  if (!isObj(raw) || raw["ok"] !== true || !within(raw["at"], PX_FROM, now + CLOCK_LAG)) return null;
  const rows = validRows(raw["rows"], raw["at"]);
  if (!rows) return null;
  const coins = Array.isArray(raw["coins"])
    ? raw["coins"].slice(0, COINS_MAX).filter((c): c is [string, number] =>
      Array.isArray(c) && c.length === 2 && typeof c[0] === "string" && COIN.test(c[0]) && within(c[1], -100, 1e6))
      .map((c) => [c[0], c[1]] as [string, number])
    : [];
  const btc90 = within(raw["btc90"], -100, 1e6) ? raw["btc90"] : null;
  const n = within(raw["n"], 0, COINS_MAX) && Number.isInteger(raw["n"]) ? raw["n"] : coins.length;
  const tiers = Array.isArray(raw["tiers"])
    ? raw["tiers"].slice(0, TIERS_MAX).filter((t): t is DomTier => Array.isArray(t) && t.length === 3
      && within(t[0], 1, COINS_MAX) && Number.isInteger(t[0])
      && (t[1] === null || (within(t[1], 0, 100) && Number.isInteger(t[1])))
      && within(t[2], 0, t[0]) && Number.isInteger(t[2]))
      .map((t): DomTier => [t[0], t[1], t[2]])
    : [];
  return { ok: true, rows, coins, btc90, tiers, n, at: raw["at"] };
}

/* --------------------------------------------------------------------- */

/** Доля во всём рынке, %: [сейчас, сутки назад или null]. */
export type Share = [number, number | null];

/** День рынка: [начало суток UTC, капитализация $, доля BTC %, доля ETH % или null (до 2020 г.)]. */
export type McapDay = [number, number, number, number | null];

/** Ответ /api/mcap — доминация по официальному API CoinMarketCap (wt_mcap.py). */
export interface McapReply {
  ok: true;
  btc: Share;
  eth: Share;
  /** Альты — всё, кроме биткоина (100 − BTC). */
  alt: Share;
  /** Альты без стейблкоинов, %, или null. */
  altNs: number | null;
  /** Доля USDT, %, или null. */
  usdt: number | null;
  /** Капитализация всего рынка, $: [сейчас, сутки назад или null]. */
  cap: [number, number | null];
  /** История рынка по дням с 2013 г. (раньше трёх лет — раз в неделю); пустая — графика нет. */
  hist: McapDay[];
  at: number;
}

/** Ответ живёт столько же, сколько на сервере (wt_mcap.TTL). */
export const MCAP_TTL_MS = 60 * 60_000;

function share(v: unknown, lo: number): Share | null {
  if (!Array.isArray(v) || v.length !== 2 || !within(v[0], lo, 100)) return null;
  return [v[0], within(v[1], lo, 100) ? v[1] : null];
}

/** 28 апреля 2013 г. — первый день истории CoinMarketCap. */
export const MCAP_FROM = 1_367_107_200;
const HIST_MAX = 20_000;

/** История рынка: любой битый день — истории нет (графика нет), остальной ответ годен. */
function validHist(raw: unknown, at: number): McapDay[] {
  if (!Array.isArray(raw) || raw.length > HIST_MAX) return [];
  const out: McapDay[] = [];
  let prev = 0;
  for (const r of raw) {
    if (!Array.isArray(r) || r.length !== 4) return [];
    const [ts, cap, btc, eth] = r as unknown[];
    if (!within(ts, MCAP_FROM, at + DAY) || ts % DAY !== 0 || ts <= prev) return [];
    if (!within(cap, 1e8, 1e15) || !within(btc, 0.5, 100) || (eth !== null && !within(eth, 0, 100 - btc))) return [];
    out.push([ts, cap, btc, eth as number | null]);
    prev = ts;
  }
  return out.length >= 2 ? out : [];
}

/** Проверенная копия ответа /api/mcap или null (нет ключа, сбой, подделка). */
export function validMcap(raw: unknown, now: number = Date.now() / 1000): McapReply | null {
  if (!isObj(raw) || raw["ok"] !== true || !within(raw["at"], PX_FROM, now + CLOCK_LAG)) return null;
  const btc = share(raw["btc"], 0.5);
  const eth = share(raw["eth"], 0);
  const alt = share(raw["alt"], 0);
  const cap = raw["cap"];
  if (!btc || !eth || !alt || btc[0] + eth[0] > 100 || Math.abs(btc[0] + alt[0] - 100) > 0.02) return null;
  if (!Array.isArray(cap) || cap.length !== 2 || !within(cap[0], 1e10, 1e15)) return null;
  const altNs = within(raw["alt_ns"], 0, alt[0]) ? raw["alt_ns"] : null;
  const usdt = within(raw["usdt"], 0, 100 - btc[0]) ? raw["usdt"] : null;
  return {
    ok: true, btc, eth, alt, altNs, usdt, cap: [cap[0], within(cap[1], 1e10, 1e15) ? cap[1] : null],
    hist: validHist(raw["hist"], raw["at"]), at: raw["at"],
  };
}

/** День истории не позже чем за n суток до последнего; нет — null. */
export function mcapAgo(h: McapDay[], n: number): McapDay | null {
  const last = h[h.length - 1];
  if (!last) return null;
  const t = last[0] - n * DAY;
  for (let i = h.length - 1; i >= 0; i--) if (h[i]![0] <= t) return h[i]!;
  return null;
}

export type McapRange = "365" | "1095" | "1825" | "all";
export const MCAP_RANGES: readonly McapRange[] = ["365", "1095", "1825", "all"];

/** Дни истории за окно: последние n суток или вся. */
export function mcapWindow(h: McapDay[], range: McapRange): McapDay[] {
  const last = h[h.length - 1];
  if (!last || range === "all") return h;
  return h.filter((d) => d[0] > last[0] - Number(range) * DAY);
}

/** Изменение доли за сутки, процентных пунктов; нет вчерашней — null. */
export const shareDelta = (s: Share): number | null => (s[1] === null ? null : Math.round((s[0] - s[1]) * 100) / 100);

/* --------------------------------------------------------------------- */

/** Зона индекса: 0 — сезон биткоина (25 и ниже), 1 — нейтрально, 2 — альтсезон (75 и выше). */
export const seasonOf = (v: number): 0 | 1 | 2 => (v >= 75 ? 2 : v <= 25 ? 0 : 1);

/** Ряд одной величины по дням: [начало суток, значение], без пустых дней. */
export function series(rows: DomDay[], col: 1 | 2 | 3 | 4 | 5): [number, number][] {
  return rows.flatMap((r): [number, number][] => (r[col] === null ? [] : [[r[0], r[col] as number]]));
}

/** Точка ряда на n суток раньше последней (ближайшая не позже); нет — null. */
export function ago(s: [number, number][], n: number): [number, number] | null {
  const last = s[s.length - 1];
  if (!last) return null;
  const t = last[0] - n * DAY;
  for (let i = s.length - 1; i >= 0; i--) if (s[i]![0] <= t) return s[i]!;
  return null;
}

/** Рост величины за n суток, %; нет точки — null. */
export function change(s: [number, number][], n: number): number | null {
  const last = s[s.length - 1];
  const p = ago(s, n);
  return last && p && p[1] > 0 ? (last[1] / p[1] - 1) * 100 : null;
}

export interface AltStats {
  /** Дней в каждой зоне: сезон биткоина, нейтрально, альтсезон. */
  cnt: [number, number, number];
  n: number;
  from: number;
  max: [number, number];
  /** Максимум и минимум за последние 365 суток. */
  hi: [number, number];
  lo: [number, number];
  /** Сколько суток подряд индекс в нынешней зоне (по сегодняшний день). */
  run: number;
}

/** Итоги индекса альтсезона по его ряду [день, значение]. */
export function altStats(s: [number, number][]): AltStats | null {
  const last = s[s.length - 1];
  if (!last) return null;
  const cnt: [number, number, number] = [0, 0, 0];
  let max = s[0]!;
  for (const p of s) {
    cnt[seasonOf(p[1])] += 1;
    if (p[1] > max[1]) max = p;
  }
  const year = s.filter((p) => p[0] > last[0] - 365 * DAY);
  const hi = year.reduce((m, p) => (p[1] > m[1] ? p : m), year[0]!);
  const lo = year.reduce((m, p) => (p[1] < m[1] ? p : m), year[0]!);
  const zone = seasonOf(last[1]);
  let i = s.length - 1;
  while (i > 0 && seasonOf(s[i - 1]![1]) === zone) i--;
  return { cnt, n: s.length, from: s[0]![0], max, hi, lo, run: Math.round((last[0] - s[i]![0]) / DAY) + 1 };
}

export interface EbStats {
  cur: [number, number];
  /** Рост за 30, 90 и 365 суток, %. */
  ch: (number | null)[];
  hi: [number, number];
  lo: [number, number];
  /** Доля дней, когда ETH/BTC был выше нынешнего. */
  above: number;
}

export function ebStats(s: [number, number][]): EbStats | null {
  const cur = s[s.length - 1];
  if (!cur || s.length < 60) return null;
  const hi = s.reduce((m, p) => (p[1] > m[1] ? p : m), s[0]!);
  const lo = s.reduce((m, p) => (p[1] < m[1] ? p : m), s[0]!);
  return { cur, ch: [30, 90, 365].map((n) => change(s, n)), hi, lo, above: s.filter((p) => p[1] > cur[1]).length / s.length };
}

/** Ряд от начала окна: первая точка — 100 (сила альтов «с начала периода»). */
export function rebase(s: [number, number][]): [number, number][] {
  const b = s[0]?.[1];
  return b ? s.map((p): [number, number] => [p[0], (p[1] / b) * 100]) : [];
}

/** На графике не больше max точек (ширина экрана всё равно меньше); последняя — всегда. */
export function thin<T>(s: T[], max = 600): T[] {
  const step = Math.max(1, Math.ceil(s.length / max));
  const out = s.filter((_, i) => i % step === 0);
  const tail = s[s.length - 1];
  if (tail !== undefined && out[out.length - 1] !== tail) out.push(tail);
  return out;
}

export type Range = "365" | "1095" | "all";
export const RANGES: readonly Range[] = ["365", "1095", "all"];

/** Точки ряда за окно: последние n суток или вся история. */
export function windowOf(s: [number, number][], range: Range): [number, number][] {
  const last = s[s.length - 1];
  if (!last || range === "all") return s;
  return s.filter((p) => p[0] > last[0] - Number(range) * DAY);
}

/** Монеты против биткоина: обогнали и отстали за 90 дней. */
export function beat(coins: [string, number][], btc90: number): { up: number; dn: number } {
  const up = coins.filter((c) => c[1] > btc90).length;
  return { up, dn: coins.length - up };
}

/** Hyperliquid давно не присылал цен: последний день старше этого (день у
 *  Hyperliquid — и сегодняшний, ещё идущий, так что даже выходные не в счёт). */
export const STALE_DAYS = 2;

/** Сколько полных суток прошло с последнего дня ответа до now (unix с). */
export function daysOld(rows: DomDay[], now: number): number {
  const last = rows[rows.length - 1]?.[0] ?? now;
  return Math.max(0, Math.floor((now - last) / DAY));
}

/** Точки раз в n суток, считая от последней (для таблицы: свежие — первыми). */
export function everyNth(s: [number, number][], n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = s.length - 1; i >= 0; i -= n) out.push(s[i]!);
  return out;
}

/** Дни истории доминации раз в неделю и реже, от последнего (для таблицы:
 *  свежие — первыми). История не везде подневная — до последних трёх лет
 *  сервер хранит её по неделям, — поэтому шаг по датам, а не по точкам. */
export function byWeek(s: McapDay[]): McapDay[] {
  const out: McapDay[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const d = s[i]!;
    const prev = out[out.length - 1];
    if (!prev || prev[0] - d[0] >= 7 * DAY) out.push(d);
  }
  return out;
}

/** Номер точки, ближайшей по времени к t; times — по возрастанию. Пустой — −1.
 *  Графики ставят точки по датам, а не по номеру: история доминации старше
 *  трёх лет — раз в неделю, и по номеру последние три года заняли бы почти
 *  весь график, разойдясь с подписями лет. */
export function nearestIdx(times: number[], t: number): number {
  if (!times.length) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && t - times[lo - 1]! <= times[lo]! - t ? lo - 1 : lo;
}

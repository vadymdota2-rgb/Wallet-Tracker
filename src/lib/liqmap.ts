/*
 * Карта ликвидаций — модуль приложения: проверка ответа сервера (validLiqMap)
 * и расчёты экрана (строки, накопленное, скопления). Без React и без сети:
 * всё проверяется тестами (tests/liqmap.test.ts, tests/liqmap.props.test.ts).
 *
 * Ответ сервера — модель wt_liqmap (см. её описание): корзины цены
 * ликвидации по 0,25 % от нуля до удвоения цены и по 2,5 % дальше, до шести
 * цен, в каждой — доллары лонгов и шортов по группам плеч. Подменённый, обрезанный или старый ответ экран не
 * роняет: validLiqMap пропускает только известные поля правдоподобных
 * значений, остальное — null.
 */
import type { LiqBucket, LiqMapReply } from "./types";

/** Окна карты — как у сервера (wt_liqmap.RANGES). */
export const LIQ_RANGES = ["1d", "7d", "30d", "90d", "180d", "365d"] as const;
export type LiqWindow = (typeof LIQ_RANGES)[number];
/** Ответы без карты, которые экран понимает. */
export const LIQ_ERRORS = ["no_data", "building", "busy", "bad_args"] as const;
/** Пределы ответа: корзин у сервера 960, групп плеч 5, пути ≤ 120 точек, свечей ≤ 48. */
export const BUCKETS_MAX = 1000;
export const LEVS_MAX = 8;
export const PATH_MAX = 200;
export const OHLC_MAX = 100;
/** Время сборки впереди часов телефона больше чем на сутки — не ответ: часы
 *  телефона могут отставать, но не на сутки. */
export const AHEAD_MAX = 86_400;
const SYM = /^[A-Z0-9]{1,12}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pos = (v: unknown): v is number => fin(v) && v > 0;
const nonNeg = (v: unknown): v is number => fin(v) && v >= 0;
const money = (v: unknown): v is number => nonNeg(v) && Number.isInteger(v);

function moneyList(v: unknown, n: number): number[] | null {
  if (!Array.isArray(v) || v.length !== n || !v.every(money)) return null;
  return v.slice();
}

/** Ответ сервера → карта или ответ-ошибка; всё неправдоподобное — null. */
export function validLiqMap(raw: unknown, now: number = Date.now() / 1000): LiqMapReply | null {
  if (!isObj(raw)) return null;
  if (raw["ok"] === false) {
    const e = raw["error"];
    return typeof e === "string" && (LIQ_ERRORS as readonly string[]).includes(e)
      ? ({ ok: false, error: e } as LiqMapReply)
      : null;
  }
  if (raw["ok"] !== true) return null;
  const { sym, range, px, step, lo, ex, levs, buckets, cum, path, oi, seen, ohlc, at } = raw;
  if (typeof sym !== "string" || !SYM.test(sym)) return null;
  if (typeof range !== "string" || !(LIQ_RANGES as readonly string[]).includes(range)) return null;
  if (!pos(px) || !pos(step) || !nonNeg(lo) || lo >= px) return null;
  if (!Array.isArray(ex) || ex.length > 64 || !ex.every((e) => typeof e === "string" && e.length > 0 && e.length <= 40)) return null;
  if (!Array.isArray(levs) || levs.length < 1 || levs.length > LEVS_MAX) return null;
  if (!levs.every((l, i) => Number.isInteger(l) && l > 0 && (i === 0 || l > (levs[i - 1] as number)))) return null;
  const n = levs.length;
  if (!Array.isArray(buckets) || buckets.length > BUCKETS_MAX) return null;
  const outB: LiqBucket[] = [];
  for (const b of buckets) {
    if (!isObj(b) || !pos(b["p"])) return null;
    const L = moneyList(b["L"], n);
    const S = moneyList(b["S"], n);
    if (!L || !S) return null;
    outB.push({ p: b["p"], L, S });
  }
  if (!isObj(cum)) return null;
  const outC: Record<string, { L: number; S: number }> = {};
  for (const k of ["2", "5", "10"]) {
    const c = cum[k];
    if (!isObj(c) || !money(c["L"]) || !money(c["S"])) return null;
    outC[k] = { L: c["L"], S: c["S"] };
  }
  if (!Array.isArray(path) || path.length < 1 || path.length > PATH_MAX || !path.every(pos)) return null;
  if (!Array.isArray(ohlc) || ohlc.length > OHLC_MAX) return null;
  const outO: [number, number, number, number][] = [];
  for (const k of ohlc) {
    if (!Array.isArray(k) || k.length !== 4 || !k.every(pos)) return null;
    const [o, h, l, c] = k as [number, number, number, number];
    if (h < l || o > h || o < l || c > h || c < l) return null;
    outO.push([o, h, l, c]);
  }
  if (!money(oi) || (seen !== undefined && !money(seen))) return null;
  /* Настоящие ликвидации — дополнение: битые или не той длины — отбрасываются
     сами, карта остаётся. */
  const realRaw = raw["real"];
  const real = Array.isArray(realRaw) && realRaw.length === outO.length
    && realRaw.every((x) => Array.isArray(x) && x.length === 2 && x.every(money))
    ? (realRaw as [number, number][]).map(([l, s]) => [l, s] as [number, number]) : undefined;
  const realFrom = raw["real_from"];
  if (!Number.isInteger(at) || (at as number) <= 0 || (at as number) > now + AHEAD_MAX) return null;
  return {
    ok: true, sym, range, px, step, lo, ex: ex.slice() as string[], levs: levs.slice() as number[], buckets: outB, cum: outC,
    path: path.slice() as number[], oi, ...(seen !== undefined ? { seen: Math.min(seen as number, oi) } : {}),
    ohlc: outO, at: at as number,
    ...(real ? { real, ...(Number.isInteger(realFrom) && (realFrom as number) > 0 ? { realFrom: realFrom as number } : {}) } : {}),
  };
}

/** Строка экрана: диапазон цены и доллары по группам плеч. */
export interface ViewRow {
  lo: number;
  hi: number;
  mid: number;
  L: number[];
  S: number[];
}

export const sum = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0);
export const sumOn = (a: readonly number[], on: readonly boolean[]): number => a.reduce((x, y, j) => x + (on[j] ? y : 0), 0);
/** Выше цены на строке — шорты, ниже — лонги. */
export const side = (w: ViewRow, p: number): number[] => (w.mid > p ? w.S : w.L);

/** Корзины сервера (по 0,25 % до удвоения цены, выше — по 2,5 %) — в строки
 *  экрана окна ±span %: строка — целое число мелких корзин, строк около
 *  шестидесяти (от 40 до 81), сверху вниз (от дорогой цены к дешёвой). Вниз
 *  окно — не ниже нуля: на ±500 % оно от нуля до шести цен. */
export function rowsOf(r: LiqMapReply, span: number): { rows: ViewRow[]; rowH: number } {
  const lo = Math.max(0, r.px * (1 - span / 100));
  const hi = r.px * (1 + span / 100);
  const base = Math.max(1, Math.round((hi - lo) / r.step / 60));
  const size = r.step * base;
  const n = Math.max(1, Math.ceil((hi - lo) / size));
  const rows: ViewRow[] = Array.from({ length: n }, (_, i) => ({
    lo: lo + i * size,
    hi: lo + (i + 1) * size,
    mid: lo + (i + 0.5) * size,
    L: r.levs.map(() => 0),
    S: r.levs.map(() => 0),
  }));
  for (const b of r.buckets) {
    const row = rows[Math.floor((b.p - lo) / size)];
    if (!row) continue;
    for (let j = 0; j < r.levs.length; j++) {
      row.L[j] = (row.L[j] ?? 0) + (b.L[j] ?? 0);
      row.S[j] = (row.S[j] ?? 0) + (b.S[j] ?? 0);
    }
  }
  const rowH = Math.max(7, Math.min(14, 520 / n));
  return { rows: rows.reverse(), rowH };
}

/** Накопленное от цены до каждой строки — на её стороне (включённые группы on). */
export function cumOf(rows: readonly ViewRow[], p: number, on: readonly boolean[]): number[] {
  const out = rows.map(() => 0);
  let acc = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const w = rows[i];
    if (w && w.mid > p) {
      acc += sumOn(w.S, on);
      out[i] = acc;
    }
  }
  acc = 0;
  for (let i = 0; i < rows.length; i++) {
    const w = rows[i];
    if (w && w.mid < p) {
      acc += sumOn(w.L, on);
      out[i] = acc;
    }
  }
  return out;
}

/** Строка экрана окна ±span %, в которую попадает цена; нет — −1. */
export function rowAt(r: LiqMapReply, span: number, price: number): number {
  return rowsOf(r, span).rows.findIndex((w) => price >= w.lo && price < w.hi);
}

export interface Cluster {
  p: number;
  v: number;
  d: number;
}

/** Скопления стороны (выше цены — шорты, ниже — лонги) полосами шириной band
 *  (доля цены) в пределах within: полоса → (доллары, средняя цена по деньгам). */
function bands(r: LiqMapReply, up: boolean, band: number, within: number): { k: number; p: number; v: number }[] {
  const groups = new Map<number, { v: number; pv: number }>();
  for (const b of r.buckets) {
    const d = (b.p - r.px) / r.px;
    if ((up ? d <= 0 : d >= 0) || Math.abs(d) > within) continue;
    const v = sum(up ? b.S : b.L);
    if (v <= 0) continue;
    const k = Math.floor(Math.abs(d) / band);
    const g = groups.get(k) ?? { v: 0, pv: 0 };
    g.v += v;
    g.pv += v * b.p;
    groups.set(k, g);
  }
  return [...groups.entries()].map(([k, g]) => ({ k, p: g.pv / g.v, v: g.v }));
}

/**
 * Ближайшее крупное скопление на стороне: полосы по 0,5 % в пределах ±10 %,
 * «крупное» — не меньше половины самого большого на этой стороне. Самое
 * большое часто далеко, а до ближайшего крупного цена доходит первой.
 */
export function nearest(r: LiqMapReply, up: boolean): Cluster | null {
  const list = bands(r, up, 0.005, 0.1);
  const max = Math.max(0, ...list.map((g) => g.v));
  if (max <= 0) return null;
  const hit = list.filter((g) => g.v >= max * 0.5).sort((a, b) => a.k - b.k)[0];
  return hit ? { p: hit.p, v: hit.v, d: ((hit.p - r.px) / r.px) * 100 } : null;
}

/**
 * Крупнейшие уровни стороны в видимом окне ±span %: скопления, а не корзины
 * (корзины по 0,25 % одного скопления шли подряд — одно место трижды).
 * Полосы — 0,5 %, на крупном приближении шире (1/30 окна); три крупнейших —
 * не в соседних полосах.
 */
export function topLevels(r: LiqMapReply, up: boolean, span: number): { k: number; p: number; v: number }[] {
  const list = bands(r, up, Math.max(0.005, span / 3000), span / 100).sort((a, b) => b.v - a.v);
  const out: { k: number; p: number; v: number }[] = [];
  for (const g of list) {
    if (out.length >= 3) break;
    if (out.every((x) => Math.abs(x.k - g.k) >= 2)) out.push(g);
  }
  return out;
}

/** Сколько минут карте (время сборки at против часов телефона); не меньше нуля. */
export function ageMin(at: number, now: number = Date.now() / 1000): number {
  return Math.max(0, Math.floor((now - at) / 60));
}
/** Карта старше — на экране пометка «биржи не отвечают, карта от HH:MM»:
 *  сервер пересобирает её раз в 2–30 минут и сам отдаёт не старше часа. */
export const LIQ_OLD_MIN = 40;

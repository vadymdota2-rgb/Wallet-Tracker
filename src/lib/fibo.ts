/*
 * Фибоначчи от последнего лоя — для монеты из скринера (и кнопкой на
 * графике): от последней впадины до вершины после неё уровни коррекции и
 * расширения; выше цены — тейки, ниже — поддержки, сам лой — стоп.
 *
 * Впадины и вершины — по ZigZag графика (тот же, что у индикатора ZigZag и
 * автофибо); порог разворота подстраивается под монету и таймфрейм: три
 * средних хода свечи (ATR 14) в процентах цены, от 1 % до 20 %. Если после
 * лоя цена ещё не прошла порог вверх (лой только что поставлен) — уровни
 * натягиваются до прошлой вершины перед лоем: цели отскока.
 *
 * Это ориентиры, а не совет: экран так и подписывает.
 */
import type { Bar } from "../chart/data";
import { atr, zigzag } from "../chart/indicators";

/** Уровни: коррекции, сам размах и расширения (цели выше вершины). */
export const FIBO_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2, 2.618];

export interface FiboLevel {
  lv: number;
  p: number;
  /** От нынешней цены, %: плюс — выше, минус — ниже. */
  pct: number;
}
export interface Fibo {
  lo: { t: number; p: number };
  hi: { t: number; p: number };
  /** up — после лоя был рост до вершины; bounce — лой свежий, цели отскока. */
  mode: "up" | "bounce";
  px: number;
  dev: number;
  levels: FiboLevel[];
}

const DEV_MIN = 1;
const DEV_MAX = 20;
const BARS_MIN = 20;

/** Порог разворота ZigZag, %: три ATR 14 к цене, от DEV_MIN до DEV_MAX. */
export function swingDev(bars: readonly Bar[]): number {
  const n = bars.length;
  if (n < 15) return 5;
  const a = atr(bars as Bar[], 14)[n - 1] ?? NaN;
  const px = bars[n - 1]!.c;
  const d = (3 * a) / px * 100;
  return Number.isFinite(d) ? Math.min(DEV_MAX, Math.max(DEV_MIN, +d.toFixed(2))) : 5;
}

/** Фибо от последнего лоя или null (свечей мало, размаха нет). */
export function fiboFromLow(bars: readonly Bar[], dev: number = swingDev(bars)): Fibo | null {
  const n = bars.length;
  if (n < BARS_MIN) return null;
  const px = bars[n - 1]!.c;
  const pts = zigzag(bars as Bar[], dev);
  const lows = pts.filter((q) => !q.hi);
  let lo: { i: number; p: number };
  if (lows.length) lo = lows[lows.length - 1]!;
  else {
    let k = 0;
    for (let i = 1; i < n; i++) if (bars[i]!.l < bars[k]!.l) k = i;
    lo = { i: k, p: bars[k]!.l };
  }
  // Вершина после лоя — если цена уже ушла вверх на порог.
  let hi: { i: number; p: number } | null = null;
  for (let i = lo.i + 1; i < n; i++) if (!hi || bars[i]!.h > hi.p) hi = { i, p: bars[i]!.h };
  let mode: Fibo["mode"] = "up";
  if (!hi || hi.p < lo.p * (1 + dev / 100)) {
    // Лой свежий: до прошлой вершины перед ним — цели отскока.
    mode = "bounce";
    const before = pts.filter((q) => q.hi && q.i < lo.i);
    hi = before.length ? before[before.length - 1]! : null;
    if (!hi) for (let i = 0; i < lo.i; i++) if (!hi || bars[i]!.h > hi.p) hi = { i, p: bars[i]!.h };
  }
  if (!hi || !(hi.p > lo.p) || !(lo.p > 0) || !(px > 0)) return null;
  const span = hi.p - lo.p;
  const levels = FIBO_LEVELS.map((lv) => {
    const p = lo.p + span * lv;
    return { lv, p, pct: (p / px - 1) * 100 };
  });
  return { lo: { t: bars[lo.i]!.t, p: lo.p }, hi: { t: bars[hi.i]!.t, p: hi.p }, mode, px, dev, levels };
}

/** Тейки — ближайшие уровни выше цены (до трёх), поддержки — ниже (до трёх,
 *  ближайшие первыми), стоп — сам лой. */
export function fiboPlan(f: Fibo): { tp: FiboLevel[]; sup: FiboLevel[]; stop: FiboLevel } {
  const above = f.levels.filter((x) => x.p > f.px).sort((a, b) => a.p - b.p).slice(0, 3);
  const below = f.levels.filter((x) => x.p < f.px && x.lv > 0).sort((a, b) => b.p - a.p).slice(0, 3);
  return { tp: above, sup: below, stop: f.levels[0]! };
}

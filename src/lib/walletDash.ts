/*
 * Экран кошелька Hyperliquid «как у терминалов»: расчёты без React и без
 * сети — всё проверяется тестами (tests/walletDash.test.ts).
 *
 * Данные — только те, что уже приходят с открытием кошелька: счёт и позиции
 * из того же ответа Hyperliquid (clearinghouseState), результат закрытых
 * сделок — из базы Wallet Tracker. Новых запросов к бирже экран не делает.
 */
import type { Account, Perf, PerfWindow, Position } from "./types";

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Доля part в whole, 0…1; whole не больше нуля — 0. */
export const share = (part: number, whole: number): number =>
  fin(part) && fin(whole) && whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;

/** Перевес: доля лонгов от 60 % — в лонг, до 40 % — в шорт, между — нейтрально. */
export const BIAS_EDGE = 0.6;
export type Bias = "long" | "short" | "flat";

export interface Exposure {
  long: number;
  short: number;
  total: number;
  /** Доля лонгов в объёме позиций, 0…1. */
  longShare: number;
  bias: Bias;
  upnl: number;
  /** Нереализованный PnL к марже позиций, % (как ROE у Hyperliquid). */
  roe: number | null;
  funding: number;
}

/** Сводка по открытым позициям: объём лонгов и шортов, перевес, PnL, ROE, фандинг. */
export function exposure(pos: readonly Position[]): Exposure {
  let long = 0, short = 0, upnl = 0, margin = 0, funding = 0;
  for (const p of pos) {
    const size = fin(p.size) ? Math.abs(p.size) : 0;
    if (p.long) long += size;
    else short += size;
    if (fin(p.pnl)) upnl += p.pnl;
    if (fin(p.margin)) margin += Math.max(0, p.margin);
    if (fin(p.funding)) funding += p.funding;
  }
  const total = long + short;
  const longShare = share(long, total);
  const bias: Bias = total <= 0 ? "flat" : longShare >= BIAS_EDGE ? "long" : longShare <= 1 - BIAS_EDGE ? "short" : "flat";
  return { long, short, total, longShare, bias, upnl, roe: margin > 0 ? (upnl / margin) * 100 : null, funding };
}

/** Плечо счёта: объём позиций к капиталу; капитала нет — null. */
export const acctLev = (a: Account): number | null => (fin(a.ntl) && fin(a.equity) && a.equity > 0 ? a.ntl / a.equity : null);

/** Счёт годен для показа: числа конечные и не отрицательные (капитал — больше нуля
 *  или есть позиции). */
export function validAccount(a: unknown): Account | null {
  if (!a || typeof a !== "object") return null;
  const r = a as Record<string, unknown>;
  const out = { equity: r["equity"], margin: r["margin"], free: r["free"], ntl: r["ntl"], maint: r["maint"] };
  for (const v of Object.values(out)) if (!fin(v) || v < 0) return null;
  return out as Account;
}

/** Точек на кривой не больше этого (окно — 30 дней и точка начала). */
export const PTS_MAX = 40;

/** Окно результата годно: числа конечные, точки — пары [время, значение] по возрастанию времени. */
export function validWindow(w: unknown): PerfWindow | null {
  if (!w || typeof w !== "object") return null;
  const r = w as Record<string, unknown>;
  for (const k of ["pnl", "trades", "wins", "win", "avg_w", "avg_l", "best", "worst", "dd"]) if (!fin(r[k])) return null;
  if (r["pf"] !== null && !fin(r["pf"])) return null;
  const pts = r["pts"];
  if (!Array.isArray(pts) || pts.length < 2 || pts.length > PTS_MAX) return null;
  let prev = -Infinity;
  for (const p of pts) {
    if (!Array.isArray(p) || p.length !== 2 || !fin(p[0]) || !fin(p[1]) || p[0] < prev) return null;
    prev = p[0];
  }
  if ((r["trades"] as number) < 1) return null;
  return r as unknown as PerfWindow;
}

/** Годные окна результата; ни одного — пусто. */
export function validPerf(p: unknown): Perf {
  const out: Perf = {};
  if (!p || typeof p !== "object") return out;
  for (const k of ["7", "30"] as const) {
    const w = validWindow((p as Record<string, unknown>)[k]);
    if (w) out[k] = w;
  }
  return out;
}

export interface Geom {
  /** Линия кривой (SVG path). */
  line: string;
  /** Заливка между кривой и нулём. */
  area: string;
  /** Где ноль по высоте. */
  zero: number;
  xs: number[];
  ys: number[];
}

/** Кривая в прямоугольнике w × h с отступом pad сверху и снизу; ноль всегда
 *  в кадре (чтобы было видно, где прибыль, а где убыток). */
export function geom(pts: readonly [number, number][], w: number, h: number, pad = 6): Geom {
  const t0 = pts[0]?.[0] ?? 0;
  const t1 = pts[pts.length - 1]?.[0] ?? 1;
  const vs = pts.map((p) => p[1]);
  let lo = Math.min(0, ...vs);
  let hi = Math.max(0, ...vs);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const x = (t: number) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * w : 0);
  const y = (v: number) => pad + ((hi - v) / (hi - lo)) * (h - 2 * pad);
  const xs = pts.map((p) => +x(p[0]).toFixed(2));
  const ys = pts.map((p) => +y(p[1]).toFixed(2));
  const zero = +y(0).toFixed(2);
  const line = xs.map((xv, i) => `${i ? "L" : "M"}${xv},${ys[i]}`).join("");
  const area = xs.length ? `${line}L${xs[xs.length - 1]},${zero}L${xs[0]},${zero}Z` : "";
  return { line, area, zero, xs, ys };
}

/** Ближайшая точка к доле ширины f (0…1). */
export function nearest(xs: readonly number[], w: number, f: number): number {
  if (!xs.length) return -1;
  const target = Math.min(1, Math.max(0, f)) * w;
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i]! - target) < Math.abs(xs[best]! - target)) best = i;
  return best;
}

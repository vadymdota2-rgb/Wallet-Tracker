/**
 * Индикаторы графика. Каждый — чистая функция от свечей и параметров:
 * ряды той же длины, что свечи (NaN — значения ещё нет), у Ишимоку облако
 * длиннее — уходит вперёд на смещение.
 *
 * Формулы — классические, как в TradingView: RSI и ATR по Уайлдеру (RMA),
 * MACD на EMA, стохастик по %K со сглаживанием, Parabolic SAR Уайлдера,
 * SuperTrend на ATR, VWAP с обнулением на границе периода.
 *
 * Свои данные Wallet Tracker (открытый интерес по 32 биржам, фандинг,
 * уровни ликвидаций) — тоже здесь как виды индикаторов, но считает их сервер:
 * у них нет calc, график подкладывает ряды из ответа API.
 */
import type { Bar, Tf } from "./data";
import { TF_MS } from "./data";

export type Ser = Float64Array;

export type IndKind =
  | "vol" | "sma" | "ema" | "wma" | "bb" | "vwap" | "st" | "psar" | "ichi" | "dc"
  | "hma" | "vwma" | "dema" | "tema" | "kc" | "env" | "ribbon"
  | "vp" | "pivots" | "zz" | "autofib" | "sr" | "linreg" | "cdl" | "div"
  | "rsi" | "macd" | "stoch" | "srsi" | "atr" | "obv" | "mfi" | "cci" | "adx" | "wr"
  | "cvd" | "mom" | "roc" | "aroon" | "cmf" | "ao" | "trix" | "uo" | "sqz" | "ad" | "chop" | "hv"
  | "vortex" | "fisher" | "bbw" | "pctb" | "bbp" | "efi"
  | "wt_oi" | "wt_fund" | "wt_liq";

/**
 * Как рисовать ряд:
 *   line — линия; hist — столбики от нуля; dots — точки; area — линия с заливкой;
 *   step — ступеньки без вертикалей (пивоты: уровень держится весь период);
 *   zz — ломаная через точки, где ряд есть (ZigZag: значения только в вершинах);
 *   level — горизонталь через весь экран (авто-уровни поддержки и сопротивления).
 */
export type Style = "line" | "hist" | "dots" | "area" | "step" | "zz" | "level";

export interface LineDef {
  name: string;
  color: string;
  style?: Style;
  /** Гистограмма: цвет по знаку (MACD) или по свече (объём). */
  signed?: boolean;
  /** Подписать имя и значение у правого конца ряда (пивоты, автофибо). */
  label?: boolean;
}

/** Значок на свече: паттерн или дивергенция. text — ключ словаря или готовая строка. */
export interface Mark {
  i: number;
  p: number;
  /** Под свечой (бычий сигнал) или над ней. */
  below: boolean;
  text: string;
  color: string;
  /** Линия от второй точки (дивергенция: от прошлой вершины к этой). */
  link?: { i: number; p: number };
}

export interface IndDef {
  kind: IndKind;
  /** Короткое имя — как в легенде TradingView. */
  short: string;
  /** Отдельная панель под графиком (иначе — поверх цены). */
  pane: boolean;
  params: { name: string; def: number; min: number; max: number; step: number }[];
  lines: LineDef[];
  /** Заливка между двумя рядами (индексы в lines). */
  fills?: { a: number; b: number; color: string; byDir?: boolean }[];
  /** Пунктирные уровни (RSI 30/70). */
  levels?: number[];
  /** Шкала панели фиксирована (RSI 0–100). */
  range?: [number, number];
  /** Свои данные Wallet Tracker: считает сервер. */
  own?: boolean;
  /** Рисует сам движок по видимому участку (профиль объёма). */
  live?: boolean;
  /** Не растягивать под себя шкалу цены: далёкий уровень не должен
   *  сплющивать свечи в полоску (у других сервисов — именно так). */
  noScale?: boolean;
  calc?: (bars: Bar[], p: number[], tf: Tf) => Ser[];
  marks?: (bars: Bar[], p: number[]) => Mark[];
}

/* ── База ──────────────────────────────────────────────────────────────── */

const nan = (n: number) => new Float64Array(n).fill(NaN);
const col = (bars: Bar[], k: "o" | "h" | "l" | "c" | "v"): Ser => Float64Array.from(bars, (b) => b[k]);
const at = (s: Ser, i: number) => s[i] ?? NaN;

export function sma(src: Ser, len: number): Ser {
  const out = nan(src.length);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < src.length; i++) {
    const v = at(src, i);
    if (Number.isNaN(v)) {
      sum = 0;
      cnt = 0;
      continue;
    }
    sum += v;
    cnt++;
    if (cnt > len) {
      sum -= at(src, i - len);
      cnt = len;
    }
    if (cnt === len) out[i] = sum / len;
  }
  return out;
}

export function ema(src: Ser, len: number): Ser {
  const out = nan(src.length);
  const k = 2 / (len + 1);
  let prev = NaN;
  let seed = 0;
  let cnt = 0;
  for (let i = 0; i < src.length; i++) {
    const v = at(src, i);
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(prev)) {
      seed += v;
      if (++cnt === len) {
        prev = seed / len;
        out[i] = prev;
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Скользящая Уайлдера (RMA) — в RSI, ATR, ADX. */
export function rma(src: Ser, len: number): Ser {
  const out = nan(src.length);
  let prev = NaN;
  let seed = 0;
  let cnt = 0;
  for (let i = 0; i < src.length; i++) {
    const v = at(src, i);
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(prev)) {
      seed += v;
      if (++cnt === len) {
        prev = seed / len;
        out[i] = prev;
      }
      continue;
    }
    prev = (prev * (len - 1) + v) / len;
    out[i] = prev;
  }
  return out;
}

export function wma(src: Ser, len: number): Ser {
  const out = nan(src.length);
  const den = (len * (len + 1)) / 2;
  for (let i = len - 1; i < src.length; i++) {
    let s = 0;
    let bad = false;
    for (let j = 0; j < len; j++) {
      const v = at(src, i - j);
      if (Number.isNaN(v)) {
        bad = true;
        break;
      }
      s += v * (len - j);
    }
    if (!bad) out[i] = s / den;
  }
  return out;
}

function stdev(src: Ser, len: number, mean: Ser): Ser {
  const out = nan(src.length);
  for (let i = len - 1; i < src.length; i++) {
    const m = at(mean, i);
    if (Number.isNaN(m)) continue;
    let s = 0;
    for (let j = 0; j < len; j++) s += (at(src, i - j) - m) ** 2;
    out[i] = Math.sqrt(s / len);
  }
  return out;
}

function highest(src: Ser, len: number): Ser {
  const out = nan(src.length);
  for (let i = len - 1; i < src.length; i++) {
    let m = -Infinity;
    for (let j = 0; j < len; j++) m = Math.max(m, at(src, i - j));
    out[i] = m;
  }
  return out;
}

function lowest(src: Ser, len: number): Ser {
  const out = nan(src.length);
  for (let i = len - 1; i < src.length; i++) {
    let m = Infinity;
    for (let j = 0; j < len; j++) m = Math.min(m, at(src, i - j));
    out[i] = m;
  }
  return out;
}

function trueRange(bars: Bar[]): Ser {
  const out = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const pc = i > 0 ? bars[i - 1]!.c : NaN;
    out[i] = Number.isNaN(pc) ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  }
  return out;
}

export const atr = (bars: Bar[], len: number) => rma(trueRange(bars), len);

function map(a: Ser, f: (v: number, i: number) => number): Ser {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = f(at(a, i), i);
  return out;
}

function rsiOf(src: Ser, len: number): Ser {
  const up = new Float64Array(src.length).fill(NaN);
  const dn = new Float64Array(src.length).fill(NaN);
  for (let i = 1; i < src.length; i++) {
    const d = at(src, i) - at(src, i - 1);
    if (Number.isNaN(d)) continue;
    up[i] = Math.max(d, 0);
    dn[i] = Math.max(-d, 0);
  }
  const au = rma(up, len);
  const ad = rma(dn, len);
  return map(au, (u, i) => {
    const d = at(ad, i);
    if (Number.isNaN(u) || Number.isNaN(d)) return NaN;
    return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
  });
}

function stochOf(src: Ser, hi: Ser, lo: Ser, len: number): Ser {
  const hh = highest(hi, len);
  const ll = lowest(lo, len);
  return map(src, (v, i) => {
    const h = at(hh, i);
    const l = at(ll, i);
    return h - l === 0 ? 50 : (100 * (v - l)) / (h - l);
  });
}

/* ── Расчёты ───────────────────────────────────────────────────────────── */

function calcBB(bars: Bar[], p: number[]): Ser[] {
  const len = p[0] ?? 20;
  const k = p[1] ?? 2;
  const c = col(bars, "c");
  const basis = sma(c, len);
  const dev = stdev(c, len, basis);
  return [basis, map(basis, (b, i) => b + k * at(dev, i)), map(basis, (b, i) => b - k * at(dev, i))];
}

/** VWAP с обнулением: внутри дня — по суткам, на часах — по неделям, выше — по месяцам. */
function calcVwap(bars: Bar[], _p: number[], tf: Tf): Ser[] {
  const out = nan(bars.length);
  const ms = TF_MS[tf];
  const period = ms < 60 * 60_000 ? "d" : ms < 24 * 3600_000 ? "w" : "m";
  let key = "";
  let pv = 0;
  let vv = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const d = new Date(b.t);
    const k = period === "d" ? d.toISOString().slice(0, 10)
      : period === "m" ? d.toISOString().slice(0, 7)
        : String(Math.floor((b.t - 4 * 86400_000) / (7 * 86400_000)));
    if (k !== key) {
      key = k;
      pv = 0;
      vv = 0;
    }
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v;
    vv += b.v;
    out[i] = vv > 0 ? pv / vv : tp;
  }
  return [out];
}

/** SuperTrend: линия под ценой в росте (зелёная) и над ценой в падении (красная). */
function calcSt(bars: Bar[], p: number[]): Ser[] {
  const len = p[0] ?? 10;
  const mult = p[1] ?? 3;
  const a = atr(bars, len);
  const upL = nan(bars.length);
  const dnL = nan(bars.length);
  let fu = NaN;
  let fl = NaN;
  let dir = 1;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const av = at(a, i);
    if (Number.isNaN(av)) continue;
    const mid = (b.h + b.l) / 2;
    const bu = mid + mult * av;
    const bl = mid - mult * av;
    const pc = i > 0 ? bars[i - 1]!.c : b.c;
    const nu = Number.isNaN(fu) || bu < fu || pc > fu ? bu : fu;
    const nl = Number.isNaN(fl) || bl > fl || pc < fl ? bl : fl;
    if (!Number.isNaN(fu)) {
      if (dir === 1 && b.c < fl) dir = -1;
      else if (dir === -1 && b.c > fu) dir = 1;
    }
    fu = nu;
    fl = nl;
    if (dir === 1) upL[i] = fl;
    else dnL[i] = fu;
  }
  return [upL, dnL];
}

/** Parabolic SAR Уайлдера. */
function calcPsar(bars: Bar[], p: number[]): Ser[] {
  const step = p[0] ?? 0.02;
  const max = p[1] ?? 0.2;
  const out = nan(bars.length);
  if (bars.length < 2) return [out];
  let up = bars[1]!.c >= bars[0]!.c;
  let sar = up ? bars[0]!.l : bars[0]!.h;
  let ep = up ? bars[0]!.h : bars[0]!.l;
  let af = step;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const prev = bars[i - 1]!;
    sar = sar + af * (ep - sar);
    if (up) {
      sar = Math.min(sar, prev.l, i > 1 ? bars[i - 2]!.l : prev.l);
      if (b.l < sar) {
        up = false;
        sar = ep;
        ep = b.l;
        af = step;
      } else if (b.h > ep) {
        ep = b.h;
        af = Math.min(af + step, max);
      }
    } else {
      sar = Math.max(sar, prev.h, i > 1 ? bars[i - 2]!.h : prev.h);
      if (b.h > sar) {
        up = true;
        sar = ep;
        ep = b.h;
        af = step;
      } else if (b.l < ep) {
        ep = b.l;
        af = Math.min(af + step, max);
      }
    }
    out[i] = sar;
  }
  return [out];
}

/** Ишимоку: Тенкан, Киджун, Чикоу (сдвиг назад) и облако (сдвиг вперёд). */
function calcIchi(bars: Bar[], p: number[]): Ser[] {
  const [a = 9, b = 26, c = 52, d = 26] = p;
  const hi = col(bars, "h");
  const lo = col(bars, "l");
  const mid = (len: number) => {
    const h = highest(hi, len);
    const l = lowest(lo, len);
    return map(h, (v, i) => (v + at(l, i)) / 2);
  };
  const ten = mid(a);
  const kij = mid(b);
  const sb = mid(c);
  const n = bars.length;
  const spanA = nan(n + d - 1);
  const spanB = nan(n + d - 1);
  for (let i = 0; i < n; i++) {
    spanA[i + d - 1] = (at(ten, i) + at(kij, i)) / 2;
    spanB[i + d - 1] = at(sb, i);
  }
  const chikou = nan(n);
  for (let i = d - 1; i < n; i++) chikou[i - d + 1] = bars[i]!.c;
  return [ten, kij, chikou, spanA, spanB];
}

function calcDc(bars: Bar[], p: number[]): Ser[] {
  const len = p[0] ?? 20;
  const up = highest(col(bars, "h"), len);
  const lo = lowest(col(bars, "l"), len);
  return [up, map(up, (v, i) => (v + at(lo, i)) / 2), lo];
}

function calcMacd(bars: Bar[], p: number[]): Ser[] {
  const [f = 12, s = 26, g = 9] = p;
  const c = col(bars, "c");
  const ef = ema(c, f);
  const es = ema(c, s);
  const macd = map(ef, (v, i) => v - at(es, i));
  const sig = ema(macd, g);
  return [map(macd, (v, i) => v - at(sig, i)), macd, sig];
}

function calcStoch(bars: Bar[], p: number[]): Ser[] {
  const [len = 14, sk = 3, sd = 3] = p;
  const k = sma(stochOf(col(bars, "c"), col(bars, "h"), col(bars, "l"), len), sk);
  return [k, sma(k, sd)];
}

function calcSrsi(bars: Bar[], p: number[]): Ser[] {
  const [rl = 14, sl = 14, sk = 3, sd = 3] = p;
  const r = rsiOf(col(bars, "c"), rl);
  const k = sma(stochOf(r, r, r, sl), sk);
  return [k, sma(k, sd)];
}

function calcObv(bars: Bar[]): Ser[] {
  const out = new Float64Array(bars.length);
  let s = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const pc = bars[i - 1]!.c;
    s += b.c > pc ? b.v : b.c < pc ? -b.v : 0;
    out[i] = s;
  }
  return [out];
}

function calcMfi(bars: Bar[], p: number[]): Ser[] {
  const len = p[0] ?? 14;
  const out = nan(bars.length);
  const tp = bars.map((b) => (b.h + b.l + b.c) / 3);
  for (let i = len; i < bars.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - len + 1; j <= i; j++) {
      const f = tp[j]! * bars[j]!.v;
      if (tp[j]! > tp[j - 1]!) pos += f;
      else if (tp[j]! < tp[j - 1]!) neg += f;
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return [out];
}

function calcCci(bars: Bar[], p: number[]): Ser[] {
  const len = p[0] ?? 20;
  const tp = Float64Array.from(bars, (b) => (b.h + b.l + b.c) / 3);
  const m = sma(tp, len);
  const out = nan(bars.length);
  for (let i = len - 1; i < bars.length; i++) {
    const mv = at(m, i);
    let dev = 0;
    for (let j = 0; j < len; j++) dev += Math.abs(at(tp, i - j) - mv);
    dev /= len;
    out[i] = dev === 0 ? 0 : (at(tp, i) - mv) / (0.015 * dev);
  }
  return [out];
}

function calcAdx(bars: Bar[], p: number[]): Ser[] {
  const len = p[0] ?? 14;
  const n = bars.length;
  const pdm = nan(n);
  const ndm = nan(n);
  for (let i = 1; i < n; i++) {
    const u = bars[i]!.h - bars[i - 1]!.h;
    const d = bars[i - 1]!.l - bars[i]!.l;
    pdm[i] = u > d && u > 0 ? u : 0;
    ndm[i] = d > u && d > 0 ? d : 0;
  }
  const tr = rma(trueRange(bars), len);
  const pdi = map(rma(pdm, len), (v, i) => (100 * v) / at(tr, i));
  const ndi = map(rma(ndm, len), (v, i) => (100 * v) / at(tr, i));
  const dx = map(pdi, (v, i) => {
    const s = v + at(ndi, i);
    return s === 0 ? 0 : (100 * Math.abs(v - at(ndi, i))) / s;
  });
  return [rma(dx, len), pdi, ndi];
}

function calcWr(bars: Bar[], p: number[]): Ser[] {
  const len = p[0] ?? 14;
  const hh = highest(col(bars, "h"), len);
  const ll = lowest(col(bars, "l"), len);
  return [map(col(bars, "c"), (c, i) => {
    const h = at(hh, i);
    const l = at(ll, i);
    return h - l === 0 ? -50 : (-100 * (h - c)) / (h - l);
  })];
}


/* ── Ещё скользящие и каналы ───────────────────────────────────────────── */

const sumN = (src: Ser, len: number): Ser => {
  const out = nan(src.length);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += at(src, i) || 0;
    if (i >= len) sum -= at(src, i - len) || 0;
    if (i >= len - 1) out[i] = sum;
  }
  return out;
};

export function hma(src: Ser, len: number): Ser {
  const half = wma(src, Math.max(1, Math.round(len / 2)));
  const full = wma(src, len);
  return wma(map(half, (v, i) => 2 * v - at(full, i)), Math.max(1, Math.round(Math.sqrt(len))));
}

export function vwma(bars: Bar[], len: number): Ser {
  const pv = sumN(Float64Array.from(bars, (b) => b.c * b.v), len);
  const v = sumN(col(bars, "v"), len);
  return map(pv, (x, i) => (at(v, i) ? x / at(v, i) : NaN));
}

const dema = (src: Ser, len: number) => {
  const e1 = ema(src, len);
  const e2 = ema(e1, len);
  return map(e1, (v, i) => 2 * v - at(e2, i));
};

const tema = (src: Ser, len: number) => {
  const e1 = ema(src, len);
  const e2 = ema(e1, len);
  const e3 = ema(e2, len);
  return map(e1, (v, i) => 3 * v - 3 * at(e2, i) + at(e3, i));
};

function calcKc(bars: Bar[], p: number[]): Ser[] {
  const [len = 20, mult = 2, al = 10] = p;
  const basis = ema(col(bars, "c"), len);
  const a = atr(bars, al);
  return [basis, map(basis, (b, i) => b + mult * at(a, i)), map(basis, (b, i) => b - mult * at(a, i))];
}

function calcEnv(bars: Bar[], p: number[]): Ser[] {
  const [len = 20, pct = 5] = p;
  const basis = sma(col(bars, "c"), len);
  return [basis, map(basis, (b) => b * (1 + pct / 100)), map(basis, (b) => b * (1 - pct / 100))];
}

/** Значение линейной регрессии в последней точке окна (как linreg(src, len, 0)). */
function linregEnd(src: Ser, len: number): Ser {
  const out = nan(src.length);
  const sx = (len * (len - 1)) / 2;
  const sxx = ((len - 1) * len * (2 * len - 1)) / 6;
  for (let i = len - 1; i < src.length; i++) {
    let sy = 0;
    let sxy = 0;
    let bad = false;
    for (let k = 0; k < len; k++) {
      const v = at(src, i - len + 1 + k);
      if (Number.isNaN(v)) {
        bad = true;
        break;
      }
      sy += v;
      sxy += k * v;
    }
    if (bad) continue;
    const slope = (len * sxy - sx * sy) / (len * sxx - sx * sx);
    const icpt = (sy - slope * sx) / len;
    out[i] = icpt + slope * (len - 1);
  }
  return out;
}

/* ── Автоанализ ────────────────────────────────────────────────────────── */

/** Пивоты: от прошлого дня (внутри дня), недели (на часах) или месяца (выше). */
function calcPivots(bars: Bar[], p: number[], tf: Tf): Ser[] {
  const fib = (p[0] ?? 0) >= 1;
  const n = bars.length;
  const out = Array.from({ length: 7 }, () => nan(n));
  const ms = TF_MS[tf];
  const key = (t: number) => {
    const d = new Date(t);
    if (ms < 3600_000) return d.toISOString().slice(0, 10);
    if (ms < 86400_000) return String(Math.floor((t - 4 * 86400_000) / (7 * 86400_000)));
    if (ms < 7 * 86400_000) return d.toISOString().slice(0, 7);
    return d.toISOString().slice(0, 4);
  };
  let cur = "";
  let H = -Infinity;
  let L = Infinity;
  let C = NaN;
  let lv: number[] | null = null;
  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    const k = key(b.t);
    if (k !== cur) {
      if (cur && Number.isFinite(H)) {
        const P = (H + L + C) / 3;
        const r = H - L;
        lv = fib
          ? [P, P + 0.382 * r, P + 0.618 * r, P + r, P - 0.382 * r, P - 0.618 * r, P - r]
          : [P, 2 * P - L, P + r, H + 2 * (P - L), 2 * P - H, P - r, L - 2 * (H - P)];
      }
      cur = k;
      H = -Infinity;
      L = Infinity;
    }
    H = Math.max(H, b.h);
    L = Math.min(L, b.l);
    C = b.c;
    if (lv) for (let j = 0; j < 7; j++) out[j]![i] = lv[j]!;
  }
  return out;
}

/** Вершины ZigZag: разворот, когда цена ушла от экстремума на dev %. */
export function zigzag(bars: Bar[], dev: number): { i: number; p: number; hi: boolean }[] {
  const pts: { i: number; p: number; hi: boolean }[] = [];
  if (bars.length < 3) return pts;
  let dir = 0;
  let ext = { i: 0, p: bars[0]!.c, hi: true };
  let lo = { i: 0, p: bars[0]!.l };
  let hi = { i: 0, p: bars[0]!.h };
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    if (dir === 0) {
      if (b.h > hi.p) hi = { i, p: b.h };
      if (b.l < lo.p) lo = { i, p: b.l };
      if (hi.p >= lo.p * (1 + dev / 100)) {
        if (hi.i > lo.i) {
          pts.push({ i: lo.i, p: lo.p, hi: false });
          dir = 1;
          ext = { i: hi.i, p: hi.p, hi: true };
        } else {
          pts.push({ i: hi.i, p: hi.p, hi: true });
          dir = -1;
          ext = { i: lo.i, p: lo.p, hi: false };
        }
      }
      continue;
    }
    if (dir === 1) {
      if (b.h >= ext.p) ext = { i, p: b.h, hi: true };
      else if (b.l <= ext.p * (1 - dev / 100)) {
        pts.push(ext);
        dir = -1;
        ext = { i, p: b.l, hi: false };
      }
    } else {
      if (b.l <= ext.p) ext = { i, p: b.l, hi: false };
      else if (b.h >= ext.p * (1 + dev / 100)) {
        pts.push(ext);
        dir = 1;
        ext = { i, p: b.h, hi: true };
      }
    }
  }
  if (dir !== 0) pts.push(ext);
  return pts;
}

function calcZz(bars: Bar[], p: number[]): Ser[] {
  const out = nan(bars.length);
  for (const q of zigzag(bars, p[0] ?? 5)) out[q.i] = q.p;
  return [out];
}

export const AUTOFIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

/** Автофибо: по последнему завершённому размаху ZigZag. */
function calcAutofib(bars: Bar[], p: number[]): Ser[] {
  const n = bars.length;
  const out = AUTOFIB.map(() => nan(n));
  const zz = zigzag(bars, p[0] ?? 5);
  if (zz.length < 3) return out;
  // Последняя вершина ещё не подтверждена — берём размах перед ней.
  const a = zz[zz.length - 3]!;
  const b = zz[zz.length - 2]!;
  AUTOFIB.forEach((lv, k) => {
    const v = b.p + (a.p - b.p) * lv;
    for (let i = a.i; i < n; i++) out[k]![i] = v;
  });
  return out;
}

/** Авто-уровни: локальные вершины и впадины, собранные в кластеры; сильнее — где больше касаний. */
function calcSr(bars: Bar[], p: number[]): Ser[] {
  const n = bars.length;
  const look = Math.max(2, Math.round(p[0] ?? 10));
  const maxN = 6;
  const out = Array.from({ length: maxN }, () => nan(n));
  if (n < look * 3) return out;
  const piv: { p: number; i: number }[] = [];
  for (let i = look; i < n - look; i++) {
    const b = bars[i]!;
    let isH = true;
    let isL = true;
    for (let k = 1; k <= look; k++) {
      if (bars[i - k]!.h > b.h || bars[i + k]!.h > b.h) isH = false;
      if (bars[i - k]!.l < b.l || bars[i + k]!.l < b.l) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) piv.push({ p: b.h, i });
    if (isL) piv.push({ p: b.l, i });
  }
  const a = atr(bars, 14);
  const tol = (at(a, n - 1) || bars[n - 1]!.c * 0.005) * 0.6;
  piv.sort((x, y) => x.p - y.p);
  const cl: { p: number; n: number; last: number }[] = [];
  for (const q of piv) {
    const c = cl[cl.length - 1];
    if (c && Math.abs(q.p - c.p) <= tol * 2) {
      c.p = (c.p * c.n + q.p) / (c.n + 1);
      c.n++;
      c.last = Math.max(c.last, q.i);
    } else cl.push({ p: q.p, n: 1, last: q.i });
  }
  const last = bars[n - 1]!.c;
  cl.sort((x, y) => y.n - x.n || y.last - x.last);
  const pick = cl.filter((c) => c.n >= 2).slice(0, maxN).sort((x, y) => Math.abs(x.p - last) - Math.abs(y.p - last));
  pick.forEach((c, k) => out[k]!.fill(c.p));
  return out;
}

/** Канал линейной регрессии по последним len свечам. */
function calcLinreg(bars: Bar[], p: number[]): Ser[] {
  const n = bars.length;
  const len = Math.min(n, Math.max(10, Math.round(p[0] ?? 100)));
  const dev = p[1] ?? 2;
  const out = [nan(n), nan(n), nan(n)];
  if (n < 10) return out;
  const s0 = n - len;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let k = 0; k < len; k++) {
    const y = bars[s0 + k]!.c;
    sx += k;
    sy += y;
    sxy += k * y;
    sxx += k * k;
  }
  const slope = (len * sxy - sx * sy) / (len * sxx - sx * sx || 1);
  const icpt = (sy - slope * sx) / len;
  let se = 0;
  for (let k = 0; k < len; k++) se += (bars[s0 + k]!.c - (icpt + slope * k)) ** 2;
  const sd = Math.sqrt(se / len);
  for (let k = 0; k < len; k++) {
    const m = icpt + slope * k;
    out[0]![s0 + k] = m;
    out[1]![s0 + k] = m + dev * sd;
    out[2]![s0 + k] = m - dev * sd;
  }
  return out;
}

/** Свечные паттерны: поглощение, молот, падающая звезда, доджи, утренняя и вечерняя звезда. */
function marksCdl(bars: Bar[]): Mark[] {
  const out: Mark[] = [];
  const a = atr(bars, 14);
  for (let i = 2; i < bars.length; i++) {
    const b = bars[i]!;
    const p1 = bars[i - 1]!;
    const p2 = bars[i - 2]!;
    const body = Math.abs(b.c - b.o);
    const range = b.h - b.l || 1e-12;
    const up = b.c > b.o;
    const av = at(a, i) || range;
    const upper = b.h - Math.max(b.o, b.c);
    const lower = Math.min(b.o, b.c) - b.l;
    const b1 = Math.abs(p1.c - p1.o);
    // Маленькие свечи ничего не значат — паттерн ищем только у заметных.
    // Порог выше, чем у многих сервисов: паттерн на каждой третьей свече —
    // это шум, а не сигнал.
    if (range < av * 0.8) continue;
    // Бычьи сигналы — только после снижения, медвежьи — после роста.
    const fell = i >= 4 && bars[i - 4]!.c > p1.c;
    const rose = i >= 4 && bars[i - 4]!.c < p1.c;
    if (up && fell && p1.c < p1.o && b.c >= p1.o && b.o <= p1.c && body > b1 && body > av * 0.7) out.push({ i, p: b.l, below: true, text: "chart_p_engulf", color: "#3ddc97" });
    else if (!up && rose && p1.c > p1.o && b.o >= p1.c && b.c <= p1.o && body > b1 && body > av * 0.7) out.push({ i, p: b.h, below: false, text: "chart_p_engulf", color: "#ff5c77" });
    else if (body / range < 0.08 && range > av * 1.2) out.push({ i, p: b.h, below: false, text: "chart_p_doji", color: "#9aa7b8" });
    else if (fell && lower > body * 2.5 && upper < body * 0.5 && range > av) out.push({ i, p: b.l, below: true, text: "chart_p_hammer", color: "#3ddc97" });
    else if (rose && upper > body * 2.5 && lower < body * 0.5 && range > av) out.push({ i, p: b.h, below: false, text: "chart_p_star", color: "#ff5c77" });
    else if (p2.c < p2.o && Math.abs(p2.c - p2.o) > av * 0.6 && b1 < av * 0.3 && up && b.c > (p2.o + p2.c) / 2)
      out.push({ i, p: b.l, below: true, text: "chart_p_mstar", color: "#3ddc97" });
    else if (p2.c > p2.o && Math.abs(p2.c - p2.o) > av * 0.6 && b1 < av * 0.3 && !up && b.c < (p2.o + p2.c) / 2)
      out.push({ i, p: b.h, below: false, text: "chart_p_estar", color: "#ff5c77" });
  }
  return out;
}

/** Дивергенции RSI: цена обновила минимум, а RSI — нет (бычья), и наоборот. */
function marksDiv(bars: Bar[], p: number[]): Mark[] {
  const len = p[0] ?? 14;
  const look = 5;
  const r = rsiOf(col(bars, "c"), len);
  const out: Mark[] = [];
  let lastLo: number | null = null;
  let lastHi: number | null = null;
  for (let i = look; i < bars.length - look; i++) {
    const b = bars[i]!;
    let isL = true;
    let isH = true;
    for (let k = 1; k <= look; k++) {
      if (bars[i - k]!.l < b.l || bars[i + k]!.l < b.l) isL = false;
      if (bars[i - k]!.h > b.h || bars[i + k]!.h > b.h) isH = false;
    }
    if (isL) {
      if (lastLo !== null && i - lastLo <= 60) {
        const a = bars[lastLo]!;
        if (b.l < a.l && at(r, i) > at(r, lastLo) && at(r, lastLo) < 45)
          out.push({ i, p: b.l, below: true, text: "chart_p_bull_div", color: "#3ddc97", link: { i: lastLo, p: a.l } });
      }
      lastLo = i;
    }
    if (isH) {
      if (lastHi !== null && i - lastHi <= 60) {
        const a = bars[lastHi]!;
        if (b.h > a.h && at(r, i) < at(r, lastHi) && at(r, lastHi) > 55)
          out.push({ i, p: b.h, below: false, text: "chart_p_bear_div", color: "#ff5c77", link: { i: lastHi, p: a.h } });
      }
      lastHi = i;
    }
  }
  return out;
}

/* ── Ещё осцилляторы ───────────────────────────────────────────────────── */

/** Дельта объёма нарастающим итогом. Есть покупки по рынку (Binance) — честно; нет — по телу свечи. */
function calcCvd(bars: Bar[]): Ser[] {
  const out = new Float64Array(bars.length);
  let s = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const d = b.tb !== undefined && b.tb > 0 ? 2 * b.tb - b.v : b.v * ((b.c - b.o) / (b.h - b.l || 1));
    s += d;
    out[i] = s;
  }
  return [out];
}

const change = (src: Ser, n: number) => map(src, (v, i) => (i >= n ? v - at(src, i - n) : NaN));

function calcAroon(bars: Bar[], p: number[]): Ser[] {
  const len = p[0] ?? 14;
  const n = bars.length;
  const up = nan(n);
  const dn = nan(n);
  for (let i = len; i < n; i++) {
    let hi = i;
    let lo = i;
    for (let k = i - len; k <= i; k++) {
      if (bars[k]!.h >= bars[hi]!.h) hi = k;
      if (bars[k]!.l <= bars[lo]!.l) lo = k;
    }
    up[i] = (100 * (len - (i - hi))) / len;
    dn[i] = (100 * (len - (i - lo))) / len;
  }
  return [up, dn];
}

function calcCmf(bars: Bar[], p: number[]): Ser[] {
  const len = p[0] ?? 20;
  const mfv = Float64Array.from(bars, (b) => (b.h === b.l ? 0 : (((b.c - b.l) - (b.h - b.c)) / (b.h - b.l)) * b.v));
  const sv = sumN(mfv, len);
  const v = sumN(col(bars, "v"), len);
  return [map(sv, (x, i) => (at(v, i) ? x / at(v, i) : 0))];
}

const hl2 = (bars: Bar[]) => Float64Array.from(bars, (b) => (b.h + b.l) / 2);

function calcAo(bars: Bar[]): Ser[] {
  const m = hl2(bars);
  const a = sma(m, 5);
  const b = sma(m, 34);
  return [map(a, (v, i) => v - at(b, i))];
}

function calcTrix(bars: Bar[], p: number[]): Ser[] {
  const len = p[0] ?? 18;
  const e = ema(ema(ema(Float64Array.from(bars, (b) => Math.log(b.c)), len), len), len);
  return [map(e, (v, i) => (i > 0 ? 10000 * (v - at(e, i - 1)) : NaN))];
}

function calcUo(bars: Bar[], p: number[]): Ser[] {
  const [a = 7, b = 14, c = 28] = p;
  const bp = new Float64Array(bars.length);
  const tr = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const x = bars[i]!;
    const pc = i > 0 ? bars[i - 1]!.c : x.c;
    bp[i] = x.c - Math.min(x.l, pc);
    tr[i] = Math.max(x.h, pc) - Math.min(x.l, pc);
  }
  const avg = (len: number) => {
    const sb = sumN(bp, len);
    const st = sumN(tr, len);
    return map(sb, (v, i) => (at(st, i) ? v / at(st, i) : NaN));
  };
  const A = avg(a);
  const B = avg(b);
  const Cc = avg(c);
  return [map(A, (v, i) => (100 * (4 * v + 2 * at(B, i) + at(Cc, i))) / 7)];
}

/** Squeeze Momentum (LazyBear): Боллинджер внутри Кельтнера — сжатие, импульс — регрессия. */
function calcSqz(bars: Bar[], p: number[]): Ser[] {
  const [len = 20, bbm = 2, kcm = 1.5] = p;
  const c = col(bars, "c");
  const basis = sma(c, len);
  const dev = stdev(c, len, basis);
  const rng = sma(trueRange(bars), len);
  const hh = highest(col(bars, "h"), len);
  const ll = lowest(col(bars, "l"), len);
  const src = map(c, (v, i) => v - ((at(hh, i) + at(ll, i)) / 2 + at(basis, i)) / 2);
  const val = linregEnd(src, len);
  const on = nan(bars.length);
  const off = nan(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const b = at(basis, i);
    if (Number.isNaN(b)) continue;
    const inside = b - bbm * at(dev, i) > b - kcm * at(rng, i) && b + bbm * at(dev, i) < b + kcm * at(rng, i);
    if (inside) on[i] = 0;
    else off[i] = 0;
  }
  return [val, on, off];
}

function calcAd(bars: Bar[]): Ser[] {
  const out = new Float64Array(bars.length);
  let s = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    s += b.h === b.l ? 0 : (((b.c - b.l) - (b.h - b.c)) / (b.h - b.l)) * b.v;
    out[i] = s;
  }
  return [out];
}

function calcChop(bars: Bar[], p: number[]): Ser[] {
  const len = p[0] ?? 14;
  const s = sumN(trueRange(bars), len);
  const hh = highest(col(bars, "h"), len);
  const ll = lowest(col(bars, "l"), len);
  return [map(s, (v, i) => {
    const r = at(hh, i) - at(ll, i);
    return r > 0 ? (100 * Math.log10(v / r)) / Math.log10(len) : NaN;
  })];
}

function calcHv(bars: Bar[], p: number[], tf: Tf): Ser[] {
  const len = p[0] ?? 10;
  const r = Float64Array.from(bars, (b, i) => (i > 0 ? Math.log(b.c / bars[i - 1]!.c) : NaN));
  const m = sma(r, len);
  const sd = stdev(r, len, m);
  const per = (365 * 86400_000) / TF_MS[tf];
  return [map(sd, (v) => v * Math.sqrt(per) * 100)];
}

function calcVortex(bars: Bar[], p: number[]): Ser[] {
  const len = p[0] ?? 14;
  const vp = new Float64Array(bars.length);
  const vm = new Float64Array(bars.length);
  for (let i = 1; i < bars.length; i++) {
    vp[i] = Math.abs(bars[i]!.h - bars[i - 1]!.l);
    vm[i] = Math.abs(bars[i]!.l - bars[i - 1]!.h);
  }
  const tr = sumN(trueRange(bars), len);
  const sp = sumN(vp, len);
  const sm = sumN(vm, len);
  return [map(sp, (v, i) => v / at(tr, i)), map(sm, (v, i) => v / at(tr, i))];
}

function calcFisher(bars: Bar[], p: number[]): Ser[] {
  const len = p[0] ?? 9;
  const m = hl2(bars);
  const hh = highest(m, len);
  const ll = lowest(m, len);
  const fish = nan(bars.length);
  const trig = nan(bars.length);
  let val = 0;
  let prev = 0;
  for (let i = len - 1; i < bars.length; i++) {
    const r = at(hh, i) - at(ll, i);
    val = 0.66 * ((r ? (at(m, i) - at(ll, i)) / r : 0.5) - 0.5) + 0.67 * val;
    val = Math.max(-0.999, Math.min(0.999, val));
    const f = 0.5 * Math.log((1 + val) / (1 - val)) + 0.5 * prev;
    trig[i] = prev;
    fish[i] = f;
    prev = f;
  }
  return [fish, trig];
}

function calcBbw(bars: Bar[], p: number[]): Ser[] {
  const [b, u, l] = calcBB(bars, p);
  return [map(u!, (v, i) => ((v - at(l!, i)) / at(b!, i)) * 100)];
}

function calcPctb(bars: Bar[], p: number[]): Ser[] {
  const [, u, l] = calcBB(bars, p);
  return [map(col(bars, "c"), (c, i) => (c - at(l!, i)) / (at(u!, i) - at(l!, i)))];
}

function calcBbp(bars: Bar[], p: number[]): Ser[] {
  const e = ema(col(bars, "c"), p[0] ?? 13);
  return [Float64Array.from(bars, (b, i) => b.h - at(e, i) + (b.l - at(e, i)))];
}

function calcEfi(bars: Bar[], p: number[]): Ser[] {
  const f = Float64Array.from(bars, (b, i) => (i > 0 ? (b.c - bars[i - 1]!.c) * b.v : NaN));
  return [ema(f, p[0] ?? 13)];
}

/* ── Технический рейтинг ───────────────────────────────────────────────── */

export type Vote = 1 | 0 | -1;
export interface RateItem {
  name: string;
  value: number;
  vote: Vote;
}
export interface Rating {
  total: number;
  ma: number;
  osc: number;
  maItems: RateItem[];
  oscItems: RateItem[];
}

/**
 * Технический рейтинг — как «Technical Ratings» TradingView: 15 скользящих
 * (цена выше — «покупать») и 11 осцилляторов (перепроданность с разворотом —
 * «покупать»). Итог — среднее двух групп от −1 до +1.
 */
export function techRating(all: Bar[]): Rating | null {
  const bars = all.slice(-600);
  const n = bars.length;
  if (n < 60) return null;
  const c = col(bars, "c");
  const last = n - 1;
  const px = bars[last]!.c;
  const L = (s: Ser, k = 0) => at(s, last - k);
  const maItems: RateItem[] = [];
  const addMa = (name: string, v: number) => {
    if (Number.isFinite(v)) maItems.push({ name, value: v, vote: v < px ? 1 : v > px ? -1 : 0 });
  };
  for (const len of [10, 20, 30, 50, 100, 200]) {
    if (n > len) {
      addMa(`EMA ${len}`, L(ema(c, len)));
      addMa(`SMA ${len}`, L(sma(c, len)));
    }
  }
  const ich = calcIchi(bars, [9, 26, 52, 26]);
  addMa("Ichimoku Kijun", L(ich[1]!));
  addMa("VWMA 20", L(vwma(bars, 20)));
  addMa("HMA 9", L(hma(c, 9)));

  const oscItems: RateItem[] = [];
  const add = (name: string, value: number, vote: Vote) => {
    if (Number.isFinite(value)) oscItems.push({ name, value, vote });
  };
  const rsi = rsiOf(c, 14);
  add("RSI 14", L(rsi), L(rsi) < 30 && L(rsi) > L(rsi, 1) ? 1 : L(rsi) > 70 && L(rsi) < L(rsi, 1) ? -1 : 0);
  const [k, d] = calcStoch(bars, [14, 3, 3]);
  add("Stoch %K", L(k!), L(k!) < 20 && L(k!) > L(d!) ? 1 : L(k!) > 80 && L(k!) < L(d!) ? -1 : 0);
  const cci = calcCci(bars, [20])[0]!;
  add("CCI 20", L(cci), L(cci) < -100 && L(cci) > L(cci, 1) ? 1 : L(cci) > 100 && L(cci) < L(cci, 1) ? -1 : 0);
  const [adx, pdi, ndi] = calcAdx(bars, [14]);
  add("ADX 14", L(adx!), L(adx!) > 20 && L(pdi!) > L(ndi!) && L(adx!) > L(adx!, 1) ? 1
    : L(adx!) > 20 && L(pdi!) < L(ndi!) && L(adx!) > L(adx!, 1) ? -1 : 0);
  const ao = calcAo(bars)[0]!;
  add("Awesome Osc", L(ao), L(ao) > 0 && L(ao) > L(ao, 1) ? 1 : L(ao) < 0 && L(ao) < L(ao, 1) ? -1 : 0);
  const mom = change(c, 10);
  add("Momentum 10", L(mom), L(mom) > L(mom, 1) ? 1 : L(mom) < L(mom, 1) ? -1 : 0);
  const [, macd, sig] = calcMacd(bars, [12, 26, 9]);
  add("MACD", L(macd!), L(macd!) > L(sig!) ? 1 : L(macd!) < L(sig!) ? -1 : 0);
  const [sk, sd] = calcSrsi(bars, [14, 14, 3, 3]);
  add("Stoch RSI", L(sk!), L(sk!) < 20 && L(sk!) > L(sd!) ? 1 : L(sk!) > 80 && L(sk!) < L(sd!) ? -1 : 0);
  const wr = calcWr(bars, [14])[0]!;
  add("Williams %R", L(wr), L(wr) < -80 && L(wr) > L(wr, 1) ? 1 : L(wr) > -20 && L(wr) < L(wr, 1) ? -1 : 0);
  const bbp = calcBbp(bars, [13])[0]!;
  add("Bull Bear Power", L(bbp), L(bbp) > 0 && L(bbp) > L(bbp, 1) ? 1 : L(bbp) < 0 && L(bbp) < L(bbp, 1) ? -1 : 0);
  const uo = calcUo(bars, [7, 14, 28])[0]!;
  add("Ultimate Osc", L(uo), L(uo) > 70 ? 1 : L(uo) < 30 ? -1 : 0);

  const avg = (a: RateItem[]) => (a.length ? a.reduce((s, x) => s + x.vote, 0) / a.length : 0);
  const ma = avg(maItems);
  const osc = avg(oscItems);
  return { total: (ma + osc) / 2, ma, osc, maItems, oscItems };
}

/** Итог рейтинга словом: ключ словаря. */
export function rateKey(v: number): "chart_r_ss" | "chart_r_s" | "chart_r_n" | "chart_r_b" | "chart_r_sb" {
  return v < -0.5 ? "chart_r_ss" : v < -0.1 ? "chart_r_s" : v <= 0.1 ? "chart_r_n" : v <= 0.5 ? "chart_r_b" : "chart_r_sb";
}

/* ── Справочник ────────────────────────────────────────────────────────── */

const P = (name: string, def: number, min = 1, max = 500, step = 1) => ({ name, def, min, max, step });

export const IND: Record<IndKind, IndDef> = {
  vol: { kind: "vol", short: "Vol", pane: false, params: [P("MA", 20, 0)], lines: [{ name: "Vol", color: "#5b7fa8", style: "hist", signed: true }, { name: "MA", color: "#f0b90b" }],
    calc: (b, p) => [col(b, "v"), (p[0] ?? 0) > 0 ? sma(col(b, "v"), p[0]!) : nan(b.length)] },
  sma: { kind: "sma", short: "MA", pane: false, params: [P("Length", 20)], lines: [{ name: "MA", color: "#f0b90b" }],
    calc: (b, p) => [sma(col(b, "c"), p[0] ?? 20)] },
  ema: { kind: "ema", short: "EMA", pane: false, params: [P("Length", 50)], lines: [{ name: "EMA", color: "#7fd8ff" }],
    calc: (b, p) => [ema(col(b, "c"), p[0] ?? 50)] },
  wma: { kind: "wma", short: "WMA", pane: false, params: [P("Length", 20)], lines: [{ name: "WMA", color: "#c38bff" }],
    calc: (b, p) => [wma(col(b, "c"), p[0] ?? 20)] },
  bb: { kind: "bb", short: "BB", pane: false, params: [P("Length", 20), P("StdDev", 2, 0.5, 5, 0.1)],
    lines: [{ name: "Basis", color: "#f0b90b" }, { name: "Upper", color: "#3a9bff" }, { name: "Lower", color: "#3a9bff" }],
    fills: [{ a: 1, b: 2, color: "rgba(58,155,255,0.07)" }], calc: calcBB },
  vwap: { kind: "vwap", short: "VWAP", pane: false, params: [], lines: [{ name: "VWAP", color: "#e86df5" }], calc: calcVwap },
  st: { kind: "st", short: "SuperTrend", pane: false, params: [P("ATR", 10), P("Factor", 3, 0.5, 10, 0.1)],
    lines: [{ name: "Up", color: "#3ddc97" }, { name: "Down", color: "#ff5c77" }], calc: calcSt },
  psar: { kind: "psar", short: "SAR", pane: false, params: [P("Step", 0.02, 0.001, 0.2, 0.001), P("Max", 0.2, 0.01, 1, 0.01)],
    lines: [{ name: "SAR", color: "#f0b90b", style: "dots" }], calc: calcPsar },
  ichi: { kind: "ichi", short: "Ichimoku", pane: false, params: [P("Tenkan", 9), P("Kijun", 26), P("Senkou B", 52), P("Shift", 26)],
    lines: [{ name: "Tenkan", color: "#3a9bff" }, { name: "Kijun", color: "#ff5c77" }, { name: "Chikou", color: "#9aa7b8" },
      { name: "Span A", color: "#3ddc97" }, { name: "Span B", color: "#ff7a90" }],
    fills: [{ a: 3, b: 4, color: "rgba(61,220,151,0.12)", byDir: true }], calc: calcIchi },
  dc: { kind: "dc", short: "Donchian", pane: false, params: [P("Length", 20)],
    lines: [{ name: "Upper", color: "#3a9bff" }, { name: "Basis", color: "#f0b90b" }, { name: "Lower", color: "#3a9bff" }],
    fills: [{ a: 0, b: 2, color: "rgba(58,155,255,0.06)" }], calc: calcDc },
  rsi: { kind: "rsi", short: "RSI", pane: true, params: [P("Length", 14)], lines: [{ name: "RSI", color: "#c38bff" }],
    levels: [30, 70], range: [0, 100], calc: (b, p) => [rsiOf(col(b, "c"), p[0] ?? 14)] },
  macd: { kind: "macd", short: "MACD", pane: true, params: [P("Fast", 12), P("Slow", 26), P("Signal", 9)],
    lines: [{ name: "Hist", color: "#3ddc97", style: "hist", signed: true }, { name: "MACD", color: "#3a9bff" }, { name: "Signal", color: "#ff9f43" }],
    levels: [0], calc: calcMacd },
  stoch: { kind: "stoch", short: "Stoch", pane: true, params: [P("%K", 14), P("Smooth K", 3), P("%D", 3)],
    lines: [{ name: "%K", color: "#3a9bff" }, { name: "%D", color: "#ff9f43" }], levels: [20, 80], range: [0, 100], calc: calcStoch },
  srsi: { kind: "srsi", short: "Stoch RSI", pane: true, params: [P("RSI", 14), P("Stoch", 14), P("K", 3), P("D", 3)],
    lines: [{ name: "K", color: "#3a9bff" }, { name: "D", color: "#ff9f43" }], levels: [20, 80], range: [0, 100], calc: calcSrsi },
  atr: { kind: "atr", short: "ATR", pane: true, params: [P("Length", 14)], lines: [{ name: "ATR", color: "#ff5c77" }],
    calc: (b, p) => [atr(b, p[0] ?? 14)] },
  obv: { kind: "obv", short: "OBV", pane: true, params: [], lines: [{ name: "OBV", color: "#3a9bff" }], calc: calcObv },
  mfi: { kind: "mfi", short: "MFI", pane: true, params: [P("Length", 14)], lines: [{ name: "MFI", color: "#c38bff" }],
    levels: [20, 80], range: [0, 100], calc: calcMfi },
  cci: { kind: "cci", short: "CCI", pane: true, params: [P("Length", 20)], lines: [{ name: "CCI", color: "#3a9bff" }],
    levels: [-100, 100], calc: calcCci },
  adx: { kind: "adx", short: "ADX", pane: true, params: [P("Length", 14)],
    lines: [{ name: "ADX", color: "#ff5c77" }, { name: "+DI", color: "#3ddc97" }, { name: "-DI", color: "#ff9f43" }],
    levels: [25], calc: calcAdx },
  wr: { kind: "wr", short: "%R", pane: true, params: [P("Length", 14)], lines: [{ name: "%R", color: "#7fd8ff" }],
    levels: [-80, -20], range: [-100, 0], calc: calcWr },
  hma: { kind: "hma", short: "HMA", pane: false, params: [P("Length", 9)], lines: [{ name: "HMA", color: "#e86df5" }],
    calc: (b, p) => [hma(col(b, "c"), p[0] ?? 9)] },
  vwma: { kind: "vwma", short: "VWMA", pane: false, params: [P("Length", 20)], lines: [{ name: "VWMA", color: "#3ddc97" }],
    calc: (b, p) => [vwma(b, p[0] ?? 20)] },
  dema: { kind: "dema", short: "DEMA", pane: false, params: [P("Length", 20)], lines: [{ name: "DEMA", color: "#ff9f43" }],
    calc: (b, p) => [dema(col(b, "c"), p[0] ?? 20)] },
  tema: { kind: "tema", short: "TEMA", pane: false, params: [P("Length", 20)], lines: [{ name: "TEMA", color: "#7fd8ff" }],
    calc: (b, p) => [tema(col(b, "c"), p[0] ?? 20)] },
  kc: { kind: "kc", short: "KC", pane: false, params: [P("Length", 20), P("Mult", 2, 0.5, 10, 0.1), P("ATR", 10)],
    lines: [{ name: "Basis", color: "#3a9bff" }, { name: "Upper", color: "#3a9bff" }, { name: "Lower", color: "#3a9bff" }],
    fills: [{ a: 1, b: 2, color: "rgba(58,155,255,0.06)" }], calc: calcKc },
  env: { kind: "env", short: "Env", pane: false, noScale: true, params: [P("Length", 20), P("%", 5, 0.1, 50, 0.1)],
    lines: [{ name: "Basis", color: "#ff9f43" }, { name: "Upper", color: "#3a9bff" }, { name: "Lower", color: "#3a9bff" }], calc: calcEnv },
  ribbon: { kind: "ribbon", short: "EMA Ribbon", pane: false, params: [P("1", 20), P("2", 50), P("3", 100), P("4", 200)],
    lines: [{ name: "1", color: "#7fd8ff" }, { name: "2", color: "#3a9bff" }, { name: "3", color: "#c38bff" }, { name: "4", color: "#e86df5" }],
    calc: (b, p) => p.map((len) => ema(col(b, "c"), len)) },
  vp: { kind: "vp", short: "VPVR", pane: false, live: true, params: [P("Rows", 40, 10, 120), P("Value area %", 70, 50, 95)], lines: [] },
  pivots: { kind: "pivots", short: "Pivots", pane: false, noScale: true, params: [P("Fib (0/1)", 0, 0, 1)],
    lines: ["P", "R1", "R2", "R3", "S1", "S2", "S3"].map((name, k) => ({ name, color: k === 0 ? "#f0b90b" : k < 4 ? "#ff5c77" : "#3ddc97", style: "step" as Style, label: true })),
    calc: calcPivots },
  zz: { kind: "zz", short: "ZigZag", pane: false, params: [P("Deviation %", 5, 0.5, 50, 0.5)],
    lines: [{ name: "ZZ", color: "#f0b90b", style: "zz" }], calc: calcZz },
  autofib: { kind: "autofib", short: "Auto Fib", pane: false, noScale: true, params: [P("Deviation %", 5, 0.5, 50, 0.5)],
    lines: AUTOFIB.map((lv, k) => ({ name: String(lv), color: ["#9aa7b8", "#ff5c77", "#ff9f43", "#3ddc97", "#f0b90b", "#7fd8ff", "#9aa7b8"][k]!, label: true })),
    calc: calcAutofib },
  sr: { kind: "sr", short: "S/R", pane: false, noScale: true, params: [P("Pivot bars", 10, 2, 50)],
    lines: Array.from({ length: 6 }, (_, k) => ({ name: `L${k + 1}`, color: "#c9a227", style: "level" as Style, label: true })), calc: calcSr },
  linreg: { kind: "linreg", short: "LinReg", pane: false, noScale: true, params: [P("Length", 100, 10, 1000), P("Dev", 2, 0.5, 5, 0.1)],
    lines: [{ name: "Mid", color: "#f0b90b" }, { name: "Upper", color: "#3a9bff" }, { name: "Lower", color: "#3a9bff" }],
    fills: [{ a: 1, b: 2, color: "rgba(58,155,255,0.07)" }], calc: calcLinreg },
  cdl: { kind: "cdl", short: "Patterns", pane: false, params: [], lines: [], marks: (b) => marksCdl(b) },
  div: { kind: "div", short: "RSI Div", pane: false, params: [P("RSI", 14)], lines: [], marks: (b, p) => marksDiv(b, p) },
  cvd: { kind: "cvd", short: "CVD", pane: true, params: [], lines: [{ name: "CVD", color: "#7fd8ff", style: "area" }], calc: (b) => calcCvd(b) },
  mom: { kind: "mom", short: "Mom", pane: true, params: [P("Length", 10)], lines: [{ name: "Mom", color: "#3a9bff" }], levels: [0],
    calc: (b, p) => [change(col(b, "c"), p[0] ?? 10)] },
  roc: { kind: "roc", short: "ROC", pane: true, params: [P("Length", 9)], lines: [{ name: "ROC", color: "#3a9bff" }], levels: [0],
    calc: (b, p) => { const c = col(b, "c"); const n = p[0] ?? 9; return [map(c, (v, i) => (i >= n ? (100 * (v - at(c, i - n))) / at(c, i - n) : NaN))]; } },
  aroon: { kind: "aroon", short: "Aroon", pane: true, params: [P("Length", 14)], lines: [{ name: "Up", color: "#ff9f43" }, { name: "Down", color: "#3a9bff" }],
    range: [0, 100], calc: calcAroon },
  cmf: { kind: "cmf", short: "CMF", pane: true, params: [P("Length", 20)], lines: [{ name: "CMF", color: "#3ddc97", style: "hist", signed: true }], levels: [0], calc: calcCmf },
  ao: { kind: "ao", short: "AO", pane: true, params: [], lines: [{ name: "AO", color: "#3ddc97", style: "hist", signed: true }], calc: (b) => calcAo(b) },
  trix: { kind: "trix", short: "TRIX", pane: true, params: [P("Length", 18)], lines: [{ name: "TRIX", color: "#ff5c77" }], levels: [0], calc: calcTrix },
  uo: { kind: "uo", short: "UO", pane: true, params: [P("Fast", 7), P("Middle", 14), P("Slow", 28)], lines: [{ name: "UO", color: "#ff5c77" }],
    levels: [30, 70], range: [0, 100], calc: calcUo },
  sqz: { kind: "sqz", short: "SQZMOM", pane: true, params: [P("Length", 20), P("BB mult", 2, 0.5, 5, 0.1), P("KC mult", 1.5, 0.5, 5, 0.1)],
    lines: [{ name: "Mom", color: "#3ddc97", style: "hist", signed: true }, { name: "Squeeze", color: "#ff5c77", style: "dots" }, { name: "Free", color: "#9aa7b8", style: "dots" }],
    calc: calcSqz },
  ad: { kind: "ad", short: "A/D", pane: true, params: [], lines: [{ name: "A/D", color: "#3a9bff" }], calc: (b) => calcAd(b) },
  chop: { kind: "chop", short: "CHOP", pane: true, params: [P("Length", 14)], lines: [{ name: "CHOP", color: "#3a9bff" }],
    levels: [38.2, 61.8], range: [0, 100], calc: calcChop },
  hv: { kind: "hv", short: "HV", pane: true, params: [P("Length", 10)], lines: [{ name: "HV %", color: "#ff9f43" }], calc: calcHv },
  vortex: { kind: "vortex", short: "VI", pane: true, params: [P("Length", 14)], lines: [{ name: "VI+", color: "#3ddc97" }, { name: "VI-", color: "#ff5c77" }],
    levels: [1], calc: calcVortex },
  fisher: { kind: "fisher", short: "Fisher", pane: true, params: [P("Length", 9)], lines: [{ name: "Fisher", color: "#3a9bff" }, { name: "Trigger", color: "#ff9f43" }],
    levels: [-1.5, 0, 1.5], calc: calcFisher },
  bbw: { kind: "bbw", short: "BBW", pane: true, params: [P("Length", 20), P("StdDev", 2, 0.5, 5, 0.1)], lines: [{ name: "BBW %", color: "#3a9bff" }], calc: calcBbw },
  pctb: { kind: "pctb", short: "%B", pane: true, params: [P("Length", 20), P("StdDev", 2, 0.5, 5, 0.1)], lines: [{ name: "%B", color: "#3ddc97" }],
    levels: [0, 1], calc: calcPctb },
  bbp: { kind: "bbp", short: "BBP", pane: true, params: [P("Length", 13)], lines: [{ name: "BBP", color: "#3ddc97", style: "hist", signed: true }], calc: calcBbp },
  efi: { kind: "efi", short: "EFI", pane: true, params: [P("Length", 13)], lines: [{ name: "EFI", color: "#ff5c77" }], levels: [0], calc: calcEfi },
  /* Свои данные Wallet Tracker — ряды подкладывает экран из API. */
  wt_oi: { kind: "wt_oi", short: "OI", pane: true, params: [], own: true,
    lines: [{ name: "OI", color: "#7fd8ff", style: "area" }] },
  wt_fund: { kind: "wt_fund", short: "Funding", pane: true, params: [], own: true,
    lines: [{ name: "8h", color: "#3ddc97", style: "hist", signed: true }], levels: [0] },
  wt_liq: { kind: "wt_liq", short: "Liq levels", pane: false, params: [], own: true, lines: [] },
};

/** Порядок в меню: свои данные первыми — их нет больше нигде. */
export const OWN_KINDS: IndKind[] = ["wt_liq", "wt_oi", "wt_fund"];
/** Автоанализ: график сам находит уровни, вершины, паттерны и дивергенции. */
export const AUTO_KINDS: IndKind[] = ["vp", "sr", "autofib", "zz", "pivots", "div", "cdl", "linreg"];
export const OVERLAY_KINDS: IndKind[] = ["vol", "sma", "ema", "wma", "hma", "vwma", "dema", "tema", "ribbon", "bb", "kc", "env", "dc", "vwap", "st", "psar", "ichi"];
export const PANE_KINDS: IndKind[] = [
  "rsi", "macd", "stoch", "srsi", "cvd", "atr", "obv", "mfi", "cci", "adx", "wr", "mom", "roc", "aroon", "cmf", "ao", "trix", "uo",
  "sqz", "ad", "chop", "hv", "vortex", "fisher", "bbw", "pctb", "bbp", "efi",
];

export interface IndInst {
  uid: string;
  kind: IndKind;
  params: number[];
  colors: string[];
  hidden?: boolean;
}

let seq = 0;
export function newInd(kind: IndKind, params?: number[]): IndInst {
  const d = IND[kind];
  return {
    uid: `${kind}-${Date.now().toString(36)}-${(seq++).toString(36)}`,
    kind,
    params: params ?? d.params.map((p) => p.def),
    colors: d.lines.map((l) => l.color),
  };
}

/** Подпись в легенде: «EMA 50», «BB 20 2». */
export function indTitle(i: IndInst): string {
  const d = IND[i.kind];
  return [d.short, ...i.params.map((p) => String(+p.toFixed(4)))].join(" ");
}

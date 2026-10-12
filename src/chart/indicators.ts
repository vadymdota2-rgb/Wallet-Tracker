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
  | "rsi" | "macd" | "stoch" | "srsi" | "atr" | "obv" | "mfi" | "cci" | "adx" | "wr"
  | "wt_oi" | "wt_fund" | "wt_liq";

export type Style = "line" | "hist" | "dots" | "area";

export interface LineDef {
  name: string;
  color: string;
  style?: Style;
  /** Гистограмма: цвет по знаку (MACD) или по свече (объём). */
  signed?: boolean;
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
  calc?: (bars: Bar[], p: number[], tf: Tf) => Ser[];
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
  /* Свои данные Wallet Tracker — ряды подкладывает экран из API. */
  wt_oi: { kind: "wt_oi", short: "OI", pane: true, params: [], own: true,
    lines: [{ name: "OI", color: "#7fd8ff", style: "area" }] },
  wt_fund: { kind: "wt_fund", short: "Funding", pane: true, params: [], own: true,
    lines: [{ name: "8h", color: "#3ddc97", style: "hist", signed: true }], levels: [0] },
  wt_liq: { kind: "wt_liq", short: "Liq levels", pane: false, params: [], own: true, lines: [] },
};

/** Порядок в меню: свои данные первыми — их нет больше нигде. */
export const OWN_KINDS: IndKind[] = ["wt_liq", "wt_oi", "wt_fund"];
export const OVERLAY_KINDS: IndKind[] = ["vol", "sma", "ema", "wma", "bb", "vwap", "st", "psar", "ichi", "dc"];
export const PANE_KINDS: IndKind[] = ["rsi", "macd", "stoch", "srsi", "atr", "obv", "mfi", "cci", "adx", "wr"];

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

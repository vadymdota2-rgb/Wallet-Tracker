/**
 * Движок графика: canvas, без библиотек.
 *
 * Модель — как у TradingView. По горизонтали два числа: ширина свечи в
 * пикселях (spacing) и номер свечи у правого края (right, дробный — отступ
 * справа от последней свечи). По вертикали у каждой панели своя шкала:
 * авто (по видимым свечам) или ручная, линейная или логарифмическая.
 *
 * Панели: главная (цена, объём внизу, индикаторы поверх цены, рисунки,
 * уровни ликвидаций) и под ней — по панели на каждый осциллятор. Границы
 * панелей тянутся пальцем.
 *
 * Управление:
 *   палец/мышь по графику — листать (с инерцией), щипок и колесо — масштаб,
 *   по шкале цены — растянуть по вертикали (двойной тап — снова авто),
 *   по шкале времени — растянуть по горизонтали, тап — перекрестие,
 *   долгое нажатие — перекрестие, которое водится пальцем, двойной тап по
 *   графику — к последней свече.
 * Мышь: перекрестие ходит за курсором.
 */
import type { Bar, Tf } from "./data";
import { TF_MS, tfEnd } from "./data";
import { IND, techRating, type IndInst, type Mark, type Rating, type Ser } from "./indicators";
import {
  axisMarks, hit as hitDrawing, render as renderDrawing, TOOL_POINTS,
  type Drawing, type DrawType, type Pt, type View,
} from "./draw";

export type ChartType = "candles" | "hollow" | "heikin" | "bars" | "line" | "area";
export type Tool = "cursor" | DrawType;

/** Свой ряд Wallet Tracker во времени (интерес, фандинг): t — мс. */
export interface OwnSeries {
  t: number[];
  v: number[];
}

/** Уровни ликвидаций: цена и сколько ликвидируется лонгов и шортов, $. */
export interface LiqLevels {
  rows: { p: number; L: number; S: number }[];
}

/** Ликвидации по свечам: [начало, сек; лонги $; шорты $; событий]. */
export type LiqRows = [number, number, number, number][];
/** Крупная сделка кита: время (сек), цена, сумма $, сторона. */
export interface WhaleMark {
  t: number;
  px: number;
  usd: number;
  buy: boolean;
  open: boolean;
}

/** Монета для сравнения: её свечи того же таймфрейма и цвет линии. */
export interface Compare {
  label: string;
  color: string;
  bars: Bar[];
}

export interface Hover {
  /** Номер свечи под перекрестием (или последней). */
  i: number;
  bar: Bar | null;
  prev: Bar | null;
  /** Значения индикаторов на этой свече: uid → значения рядов. */
  vals: Record<string, number[]>;
  /** Перекрестие стоит (а не просто последняя свеча). */
  live: boolean;
  /** Ликвидации на этой свече, $: лонги и шорты. */
  liq?: { L: number; S: number };
  /** Сделки китов на этой свече: куплено и продано, $. */
  wh?: { buy: number; sell: number };
  /** Режим сравнения: изменение от первой видимой свечи, %, — у главной монеты и у каждой сравниваемой. */
  cmp?: { label: string; color: string; pct: number }[];
  mainPct?: number;
}

export interface Events {
  hover(h: Hover): void;
  needOlder(): void;
  drawings(list: Drawing[]): void;
  select(d: Drawing | null): void;
  toolDone(): void;
  /** Только что поставлен текст — открыть ввод. */
  textNew(d: Drawing): void;
  view(atLatest: boolean): void;
  /** Можно ли отменить и вернуть последнее действие с рисунками. */
  history(canUndo: boolean, canRedo: boolean): void;
  /** Технический рейтинг пересчитан (не чаще раза в 3 с). */
  rating(r: Rating | null): void;
  /** Процентную шкалу включили или выключили кнопкой «%». */
  pct(on: boolean): void;
}

interface Scale {
  auto: boolean;
  lo: number;
  hi: number;
  log: boolean;
}

interface Pane {
  key: string;
  ind: IndInst | null;
  top: number;
  h: number;
  /** Доля высоты подпанели (у главной не используется). */
  frac: number;
  /** В видимом окне нет ни одного значения — шкалу не подписываем. */
  empty?: boolean;
  scale: Scale;
}

const C = {
  bg: "#050b16",
  grid: "rgba(58,130,214,0.07)",
  axis: "#7c97bc",
  text: "#c9d8ee",
  line: "rgba(58,130,214,0.22)",
  up: "#3ddc97",
  dn: "#ff5c77",
  cross: "rgba(201,216,238,0.55)",
  label: "#1b2b44",
};

const TIME_H = 24;
const MIN_SPACING = 1.2;
const MAX_SPACING = 64;
const RIGHT_PAD_BARS = 4;

const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);

/** Знаков после запятой — по величине цены, как у бирж. */
export function priceDecimals(p: number): number {
  const a = Math.abs(p);
  if (!a || !Number.isFinite(a)) return 2;
  if (a >= 100) return 2;
  if (a >= 1) return 4;
  return Math.min(12, -Math.floor(Math.log10(a)) + 3);
}

export function fmtPrice(p: number, dec: number): string {
  if (!Number.isFinite(p)) return "—";
  return p.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

/** Короткое число для панелей индикаторов и объёма: 1.25K, 3.4M, 2.1B. */
export function fmtShort(v: number): string {
  const a = Math.abs(v);
  if (!Number.isFinite(v)) return "—";
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a === 0) return "0";
  return v.toPrecision(3);
}

function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/** Свечи Хейкен-Аши — только для показа: индикаторы считаются по настоящим. */
function heikin(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  let po = 0;
  let pc = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const c = (b.o + b.h + b.l + b.c) / 4;
    const o = i === 0 ? (b.o + b.c) / 2 : (po + pc) / 2;
    out.push({ t: b.t, o, h: Math.max(b.h, o, c), l: Math.min(b.l, o, c), c, v: b.v });
    po = o;
    pc = c;
  }
  return out;
}

/* Шаги подписей времени: от минуты до года. */
const T_STEPS: [number, "m" | "h" | "d" | "M" | "Y", number][] = [
  [60_000, "m", 1], [5 * 60_000, "m", 5], [15 * 60_000, "m", 15], [30 * 60_000, "m", 30],
  [3600_000, "h", 1], [2 * 3600_000, "h", 2], [3 * 3600_000, "h", 3], [6 * 3600_000, "h", 6], [12 * 3600_000, "h", 12],
  [86400_000, "d", 1], [2 * 86400_000, "d", 2], [7 * 86400_000, "d", 7], [14 * 86400_000, "d", 14],
  [30 * 86400_000, "M", 1], [91 * 86400_000, "M", 3], [182 * 86400_000, "M", 6], [365 * 86400_000, "Y", 1],
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export class Engine {
  private cv: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ev: Events;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private font = "11px sans-serif";
  private priceW = 64;

  private bars: Bar[] = [];
  private shown: Bar[] = [];
  private tf: Tf = "1h";
  private type: ChartType = "candles";
  private dec = 2;
  private mark = "";

  private spacing = 6;
  private right = 0;
  private panes: Pane[] = [];
  private inds: IndInst[] = [];
  private calc = new Map<string, Ser[]>();
  private marks = new Map<string, Mark[]>();
  private tr: (k: string) => string = (k) => k;
  private past: Drawing[][] = [];
  private future: Drawing[][] = [];
  private loupe: { x: number; y: number } | null = null;
  private rateAt = 0;
  private rateTimer: ReturnType<typeof setTimeout> | null = null;
  private indDirty = true;
  private own: { oi: OwnSeries | null; fund: OwnSeries | null; liq: LiqLevels | null } = { oi: null, fund: null, liq: null };
  private liqx: LiqRows | null = null;
  private cmp: { label: string; color: string; at: Map<number, number> }[] = [];
  private pct = false;
  /** Свеча-точка отсчёта для процентов — первая видимая. */
  private baseI = 0;
  private whales: WhaleMark[] | null = null;

  private drawings: Drawing[] = [];
  private sel: string | null = null;
  private tool: Tool = "cursor";
  private magnet = true;
  private hideDrawings = false;
  private creating: { d: Drawing; idx: number; downs: number } | null = null;

  private cross: { x: number; y: number } | null = null;
  private crossSticky = false;
  private mouse = false;

  private olderAsked = false;
  private noOlder = false;
  private raf = 0;
  private dirty = true;
  private tick: ReturnType<typeof setInterval>;
  private ro: ResizeObserver;

  /* Жесты. */
  private ptrs = new Map<number, { x: number; y: number }>();
  private mode: "" | "pan" | "pending" | "cross" | "price" | "time" | "sep" | "create" | "handle" | "move" | "pinch" = "";
  private down = { x: 0, y: 0, t: 0, right: 0, spacing: 0, lo: 0, hi: 0, pane: 0, handle: -1, pts: [] as Pt[], id: "" };
  private pinch = { d: 0, cx: 0, spacing: 0, anchor: 0 };
  private longTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTap = { t: 0, x: 0, y: 0 };
  private vel = 0;
  private lastMove = { x: 0, t: 0 };
  private inertia = 0;

  constructor(canvas: HTMLCanvasElement, ev: Events) {
    this.cv = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    this.ctx = ctx;
    this.ev = ev;
    const fam = getComputedStyle(document.body).fontFamily || "sans-serif";
    this.font = `11px ${fam}`;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement ?? canvas);
    this.resize();
    canvas.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointercancel", this.onUp);
    canvas.addEventListener("pointerleave", this.onLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    // Отсчёт до закрытия свечи — раз в секунду.
    this.tick = setInterval(() => {
      if (this.bars.length) this.invalidate();
    }, 1000);
    this.panes = [{ key: "main", ind: null, top: 0, h: 0, frac: 1, scale: { auto: true, lo: 0, hi: 1, log: false } }];
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.inertia);
    clearInterval(this.tick);
    if (this.rateTimer) clearTimeout(this.rateTimer);
    this.ro.disconnect();
    this.cv.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("pointercancel", this.onUp);
    this.cv.removeEventListener("pointerleave", this.onLeave);
    this.cv.removeEventListener("wheel", this.onWheel);
  }

  /* ── Данные ─────────────────────────────────────────────────────────── */

  setData(bars: Bar[], tf: Tf) {
    this.bars = bars.slice();
    this.tf = tf;
    this.olderAsked = false;
    this.noOlder = false;
    this.cross = null;
    this.crossSticky = false;
    const last = bars[bars.length - 1];
    this.dec = last ? priceDecimals(last.c) : 2;
    this.right = bars.length - 1 + RIGHT_PAD_BARS;
    this.spacing = 6;
    for (const p of this.panes) p.scale.auto = true;
    this.refresh();
  }

  /** Живая свеча: та же — заменить, новая — добавить. */
  update(b: Bar) {
    const last = this.bars[this.bars.length - 1];
    if (!last || b.t < last.t) return;
    const follow = this.right >= this.bars.length - 1;
    if (b.t === last.t) this.bars[this.bars.length - 1] = b;
    else {
      this.bars.push(b);
      if (follow) this.right += 1;
    }
    this.refresh();
  }

  /** Старые свечи слева. Пусто — история кончилась. */
  prepend(older: Bar[]) {
    this.olderAsked = false;
    const first = this.bars[0];
    const add = first ? older.filter((b) => b.t < first.t) : older;
    if (!add.length) {
      this.noOlder = true;
      return;
    }
    this.bars = [...add, ...this.bars];
    this.right += add.length;
    if (this.down.right) this.down.right += add.length;
    this.refresh();
  }

  /** Время первой загруженной свечи — откуда грузить историю назад. */
  get firstTime(): number | null {
    return this.bars[0]?.t ?? null;
  }

  olderFailed() {
    this.olderAsked = false;
  }

  setType(t: ChartType) {
    this.type = t;
    this.refresh();
  }

  setWatermark(s: string) {
    this.mark = s;
    this.invalidate();
  }

  setIndicators(list: IndInst[]) {
    this.inds = list;
    const keep = new Map(this.panes.map((p) => [p.key, p]));
    const main = keep.get("main")!;
    const next: Pane[] = [main];
    for (const i of list) {
      if (!IND[i.kind].pane) continue;
      next.push(keep.get(i.uid) ?? { key: i.uid, ind: i, top: 0, h: 0, frac: 0.2, scale: { auto: true, lo: 0, hi: 1, log: false } });
      next[next.length - 1]!.ind = i;
    }
    this.panes = next;
    this.indDirty = true;
    this.invalidate();
  }

  setOwn(kind: "oi" | "fund", s: OwnSeries | null) {
    this.own[kind] = s;
    this.invalidate();
  }

  setLiq(l: LiqLevels | null) {
    this.own.liq = l;
    this.invalidate();
  }

  /** Сравнение с другими монетами: их цены приводятся к старту главной. */
  setCompare(list: Compare[]) {
    this.cmp = list.map((c) => ({ label: c.label, color: c.color, at: new Map(c.bars.map((b) => [b.t, b.c])) }));
    this.invalidate();
  }

  setPct(on: boolean) {
    this.pct = on;
    this.invalidate();
  }

  /** Шкала в процентах: включена вручную или сама — при сравнении. */
  get pctMode() {
    return this.pct || this.cmp.length > 0;
  }

  /** Цена сравниваемой монеты на свече i — в масштабе главной (от общей точки старта). */
  private cmpAt(c: { at: Map<number, number> }, i: number): number {
    const b = this.bars[i];
    const v = b ? c.at.get(b.t) : undefined;
    if (v === undefined) return NaN;
    let base: number | undefined;
    for (let k = this.baseI; k < Math.min(this.bars.length, this.baseI + 50) && base === undefined; k++) {
      const bk = this.bars[k];
      if (bk) base = c.at.get(bk.t);
    }
    const mb = this.bars[this.baseI]?.c;
    return base && mb ? (mb * v) / base : NaN;
  }

  setLiqx(r: LiqRows | null) {
    this.liqx = r;
    this.invalidate();
  }

  setWhales(w: WhaleMark[] | null) {
    this.whales = w;
    this.invalidate();
  }

  setLog(on: boolean) {
    this.panes[0]!.scale.log = on;
    this.panes[0]!.scale.auto = true;
    this.invalidate();
  }

  get log() {
    return this.panes[0]!.scale.log;
  }

  get autoScale() {
    return this.panes[0]!.scale.auto;
  }

  resetScale() {
    for (const p of this.panes) p.scale.auto = true;
    this.invalidate();
  }

  /** Сдвинуть на n свечей (клавиши ← →). */
  nudge(n: number) {
    this.right += n;
    this.clampRight();
    this.ev.view(this.right >= this.bars.length - 1);
    this.invalidate();
  }

  /** Масштаб от правого края (клавиши + −). */
  zoomBy(k: number) {
    this.zoomTo(this.spacing * k, this.idx(this.plotR), this.plotR);
  }

  /**
   * Снимок для чата: график 1280×800 (так он хорошо смотрится в ленте и
   * влезает больше истории, чем на экране телефона) без перекрестия, лупы и
   * выделения. Сверху — монета и цены, снизу — где нас найти и время.
   */
  snapshot(title: string, sub: string, W = 1280, H = 800): Promise<Blob> {
    const keep = { cross: this.cross, loupe: this.loupe, sel: this.sel, cv: this.cv, ctx: this.ctx, w: this.w, h: this.h, dpr: this.dpr };
    const head = 56;
    const foot = 36;
    const tmp = document.createElement("canvas");
    const dpr = 1.5;
    tmp.width = Math.round(W * dpr);
    tmp.height = Math.round((H - head - foot) * dpr);
    const tctx = tmp.getContext("2d");
    if (!tctx) return Promise.reject(new Error("canvas"));
    this.cross = null;
    this.loupe = null;
    this.sel = null;
    this.cv = tmp;
    this.ctx = tctx;
    this.w = W;
    this.h = H - head - foot;
    this.dpr = dpr;
    try {
      this.paint();
    } finally {
      this.cv = keep.cv;
      this.ctx = keep.ctx;
      this.w = keep.w;
      this.h = keep.h;
      this.dpr = keep.dpr;
      this.cross = keep.cross;
      this.loupe = keep.loupe;
      this.sel = keep.sel;
      this.invalidate();
    }
    const out = document.createElement("canvas");
    out.width = Math.round(W * dpr);
    out.height = Math.round(H * dpr);
    const c = out.getContext("2d")!;
    c.scale(dpr, dpr);
    c.fillStyle = C.bg;
    c.fillRect(0, 0, W, H);
    c.drawImage(tmp, 0, head, W, H - head - foot);
    const fam = this.font.replace(/^\d+px\s*/, "");
    c.textBaseline = "middle";
    c.fillStyle = "#eaf5ff";
    c.font = `700 22px ${fam}`;
    c.fillText(title, 16, 20);
    c.fillStyle = C.axis;
    c.font = `500 14px ${fam}`;
    c.fillText(sub, 16, 43);
    c.strokeStyle = C.line;
    c.beginPath();
    c.moveTo(0, H - foot + 0.5);
    c.lineTo(W, H - foot + 0.5);
    c.stroke();
    c.fillStyle = "#7fd8ff";
    c.font = `700 15px ${fam}`;
    c.fillText("Wallet Tracker · @WalletTrackerAppBot", 16, H - foot / 2);
    c.fillStyle = C.axis;
    c.font = `500 13px ${fam}`;
    c.textAlign = "right";
    c.fillText(new Date().toLocaleString(), W - 16, H - foot / 2);
    return new Promise((ok, fail) => out.toBlob((b) => (b ? ok(b) : fail(new Error("blob"))), "image/png"));
  }

  /** К последней свече, масштаб — авто. */
  goLatest() {
    this.right = this.bars.length - 1 + RIGHT_PAD_BARS;
    this.resetScale();
    this.ev.view(true);
  }

  /* ── Рисунки ────────────────────────────────────────────────────────── */

  /** Перевод подписей на холсте (паттерны, правила Эллиотта). */
  setText(fn: (k: string) => string) {
    this.tr = fn;
    this.invalidate();
  }

  /** Запомнить состояние рисунков перед изменением — для «Отменить». */
  private snap() {
    this.past.push(this.drawings.map((d) => ({ ...d, pts: d.pts.map((p) => ({ ...p })) })));
    if (this.past.length > 100) this.past.shift();
    this.future = [];
    this.ev.history(true, false);
  }

  undo() {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.drawings);
    this.drawings = prev;
    this.afterHistory();
  }

  redo() {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.drawings);
    this.drawings = next;
    this.afterHistory();
  }

  private afterHistory() {
    if (this.sel && !this.drawings.some((d) => d.id === this.sel)) this.select(null);
    else if (this.sel) this.ev.select(this.drawings.find((d) => d.id === this.sel) ?? null);
    this.ev.drawings(this.drawings);
    this.ev.history(this.past.length > 0, this.future.length > 0);
    this.invalidate();
  }

  /** Удалить все рисунки — одним шагом, который можно отменить. */
  clearDrawings() {
    if (!this.drawings.length) return;
    this.snap();
    this.drawings = [];
    this.select(null);
    this.ev.drawings(this.drawings);
    this.invalidate();
  }

  setDrawings(list: Drawing[]) {
    this.past = [];
    this.future = [];
    this.ev.history(false, false);
    this.drawings = list.slice();
    if (this.sel && !list.some((d) => d.id === this.sel)) this.select(null);
    this.invalidate();
  }

  setTool(t: Tool) {
    this.tool = t;
    this.creating = null;
    if (t !== "cursor") this.select(null);
    this.cv.style.cursor = t === "cursor" ? "default" : "crosshair";
    this.invalidate();
  }

  setMagnet(on: boolean) {
    this.magnet = on;
  }

  setHideDrawings(on: boolean) {
    this.hideDrawings = on;
    if (on) this.select(null);
    this.invalidate();
  }

  patchDrawing(id: string, patch: Partial<Drawing>) {
    this.snap();
    this.drawings = this.drawings.map((d) => (d.id === id ? { ...d, ...patch } : d));
    this.ev.drawings(this.drawings);
    const d = this.drawings.find((x) => x.id === id);
    if (d && this.sel === id) this.ev.select(d);
    this.invalidate();
  }

  /** Правка без шага отмены: сверка с сервером (алерт сработал). */
  patchQuiet(id: string, patch: Partial<Drawing>) {
    this.drawings = this.drawings.map((d) => (d.id === id ? { ...d, ...patch } : d));
    this.ev.drawings(this.drawings);
    const d = this.drawings.find((x) => x.id === id);
    if (d && this.sel === id) this.ev.select(d);
    this.invalidate();
  }

  get allDrawings(): Drawing[] {
    return this.drawings;
  }

  deleteSelected() {
    if (!this.sel) return;
    this.snap();
    this.drawings = this.drawings.filter((d) => d.id !== this.sel);
    this.select(null);
    this.ev.drawings(this.drawings);
    this.invalidate();
  }

  private select(id: string | null) {
    if (this.sel === id) return;
    this.sel = id;
    this.ev.select(id ? this.drawings.find((d) => d.id === id) ?? null : null);
  }

  /* ── Пересчёт и кадр ────────────────────────────────────────────────── */

  private refresh() {
    this.shown = this.type === "heikin" ? heikin(this.bars) : this.bars;
    const last = this.bars[this.bars.length - 1];
    if (last) this.dec = priceDecimals(last.c);
    this.indDirty = true;
    this.invalidate();
  }

  invalidate() {
    if (this.dirty && this.raf) return;
    this.dirty = true;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (!this.dirty) return;
      this.dirty = false;
      this.paint();
    });
  }

  private resize() {
    const box = this.cv.parentElement ?? this.cv;
    const r = box.getBoundingClientRect();
    this.w = Math.max(100, Math.floor(r.width));
    this.h = Math.max(120, Math.floor(r.height));
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.cv.width = Math.floor(this.w * this.dpr);
    this.cv.height = Math.floor(this.h * this.dpr);
    this.cv.style.width = `${this.w}px`;
    this.cv.style.height = `${this.h}px`;
    this.invalidate();
  }

  private compute() {
    if (!this.indDirty) return;
    this.indDirty = false;
    this.calc.clear();
    this.marks.clear();
    this.scheduleRating();
    for (const i of this.inds) {
      const d = IND[i.kind];
      if (!d.calc || !this.bars.length) continue;
      try {
        this.calc.set(i.uid, d.calc(this.bars, i.params, this.tf));
      } catch {
        /* битые параметры — индикатор просто не рисуется */
      }
    }
    for (const i of this.inds) {
      const d = IND[i.kind];
      if (!d.marks || !this.bars.length) continue;
      try {
        this.marks.set(i.uid, d.marks(this.bars, i.params));
      } catch { /* то же */ }
    }
  }

  /** Рейтинг считается по 26 индикаторам — не на каждый тик, а раз в 3 с. */
  private scheduleRating() {
    if (this.rateTimer) return;
    const wait = Math.max(0, 3000 - (Date.now() - this.rateAt));
    this.rateTimer = setTimeout(() => {
      this.rateTimer = null;
      this.rateAt = Date.now();
      try {
        this.ev.rating(techRating(this.bars));
      } catch {
        this.ev.rating(null);
      }
    }, wait);
  }

  /* ── Геометрия ──────────────────────────────────────────────────────── */

  private get plotR() {
    return this.w - this.priceW;
  }

  private x(i: number) {
    return this.plotR - (this.right - i + 0.5) * this.spacing;
  }

  private idx(x: number) {
    return this.right - (this.plotR - x) / this.spacing - 0.5;
  }

  /** Время → дробный номер свечи (за краями — по шагу таймфрейма). */
  private tIdx(t: number): number {
    const b = this.bars;
    const n = b.length;
    if (!n) return 0;
    const step = TF_MS[this.tf];
    const first = b[0]!.t;
    const last = b[n - 1]!.t;
    if (t <= first) return (t - first) / step;
    if (t >= last) return n - 1 + (t - last) / step;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (b[m]!.t <= t) lo = m;
      else hi = m;
    }
    const a = b[lo]!.t;
    const c = b[hi]!.t;
    return lo + (c > a ? (t - a) / (c - a) : 0);
  }

  /** Дробный номер свечи → время. */
  private iTime(i: number): number {
    const b = this.bars;
    const n = b.length;
    if (!n) return Date.now();
    const step = TF_MS[this.tf];
    if (i <= 0) return b[0]!.t + i * step;
    if (i >= n - 1) return b[n - 1]!.t + (i - (n - 1)) * step;
    const lo = Math.floor(i);
    const a = b[lo]!.t;
    const c = b[lo + 1]!.t;
    return a + (c - a) * (i - lo);
  }

  private tx(t: number) {
    return this.x(this.tIdx(t));
  }

  private layout() {
    const total = this.h - TIME_H;
    const subs = this.panes.slice(1);
    const maxSub = total * 0.6;
    let subH = subs.reduce((s, p) => s + Math.max(48, p.frac * total), 0);
    const k = subH > maxSub ? maxSub / subH : 1;
    subH = 0;
    for (const p of subs) {
      p.h = Math.max(40, Math.round(Math.max(48, p.frac * total) * k));
      subH += p.h;
    }
    const main = this.panes[0]!;
    main.top = 0;
    main.h = total - subH;
    let y = main.h;
    for (const p of subs) {
      p.top = y;
      y += p.h;
    }
  }

  private f(v: number, s: Scale) {
    return s.log ? Math.log(Math.max(v, 1e-12)) : v;
  }

  private fi(v: number, s: Scale) {
    return s.log ? Math.exp(v) : v;
  }

  private py(p: Pane, v: number) {
    const s = p.scale;
    const pad = p.key === "main" ? 0.08 : 0.1;
    const top = p.top + p.h * pad;
    const hh = p.h * (1 - pad * 2);
    const lo = this.f(s.lo, s);
    const hi = this.f(s.hi, s);
    return top + (1 - (this.f(v, s) - lo) / (hi - lo || 1)) * hh;
  }

  private yp(p: Pane, y: number) {
    const s = p.scale;
    const pad = p.key === "main" ? 0.08 : 0.1;
    const top = p.top + p.h * pad;
    const hh = p.h * (1 - pad * 2);
    const lo = this.f(s.lo, s);
    const hi = this.f(s.hi, s);
    return this.fi(lo + (1 - (y - top) / (hh || 1)) * (hi - lo), s);
  }

  private paneAt(y: number): number {
    for (let i = this.panes.length - 1; i >= 0; i--) if (y >= this.panes[i]!.top) return i;
    return 0;
  }

  private visible(): [number, number] {
    const n = this.shown.length;
    const a = Math.max(0, Math.floor(this.idx(0)));
    const b = Math.min(n - 1, Math.ceil(this.idx(this.plotR)));
    return [a, b];
  }

  private autoscale(i0: number, i1: number) {
    const main = this.panes[0]!;
    if (main.scale.auto && i1 >= i0) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = i0; i <= i1; i++) {
        const b = this.shown[i]!;
        if (this.type === "line" || this.type === "area") {
          lo = Math.min(lo, b.c);
          hi = Math.max(hi, b.c);
        } else {
          lo = Math.min(lo, b.l);
          hi = Math.max(hi, b.h);
        }
      }
      for (const ind of this.inds) {
        const d = IND[ind.kind];
        if (d.pane || ind.hidden || ind.kind === "vol" || d.noScale) continue;
        const ser = this.calc.get(ind.uid);
        if (!ser) continue;
        for (const s of ser) {
          for (let i = i0; i <= i1; i++) {
            const v = s[i];
            if (finite(v)) {
              lo = Math.min(lo, v);
              hi = Math.max(hi, v);
            }
          }
        }
      }
      for (const c of this.cmp) {
        for (let i = i0; i <= i1; i++) {
          const v = this.cmpAt(c, i);
          if (finite(v)) {
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
        }
      }
      if (Number.isFinite(lo) && Number.isFinite(hi)) {
        if (hi - lo < hi * 1e-6) {
          hi += hi * 0.001 || 1;
          lo -= lo * 0.001 || 1;
        }
        main.scale.lo = lo;
        main.scale.hi = hi;
      }
    }
    for (const p of this.panes.slice(1)) {
      if (!p.scale.auto || !p.ind) continue;
      const d = IND[p.ind.kind];
      if (d.range) {
        p.scale.lo = d.range[0];
        p.scale.hi = d.range[1];
        continue;
      }
      let lo = Infinity;
      let hi = -Infinity;
      const own = p.ind.kind === "wt_oi" ? this.own.oi : p.ind.kind === "wt_fund" ? this.own.fund : null;
      if (own) {
        const t0 = this.iTime(i0);
        const t1 = this.iTime(i1 + 1);
        own.t.forEach((t, k) => {
          const v = own.v[k];
          if (t >= t0 - TF_MS[this.tf] * 4 && t <= t1 && finite(v)) {
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
        });
        if (p.ind.kind === "wt_fund") {
          lo = Math.min(lo, 0);
          hi = Math.max(hi, 0);
        }
      } else {
        const ser = this.calc.get(p.ind.uid) ?? [];
        for (const s of ser) {
          for (let i = i0; i <= i1; i++) {
            const v = s[i];
            if (finite(v)) {
              lo = Math.min(lo, v);
              hi = Math.max(hi, v);
            }
          }
        }
        for (const lv of d.levels ?? []) {
          if (Number.isFinite(lo)) {
            lo = Math.min(lo, lv);
            hi = Math.max(hi, lv);
          }
        }
      }
      p.empty = !(Number.isFinite(lo) && Number.isFinite(hi));
      if (Number.isFinite(lo) && Number.isFinite(hi)) {
        if (hi === lo) {
          hi += Math.abs(hi) * 0.01 || 1;
          lo -= Math.abs(lo) * 0.01 || 1;
        }
        p.scale.lo = lo;
        p.scale.hi = hi;
      }
    }
  }

  /** Вид главной панели для рисунков. */
  private view(): View {
    const main = this.panes[0]!;
    return {
      x: (t) => this.tx(t),
      y: (p) => this.py(main, p),
      left: 0,
      right: this.plotR,
      top: main.top,
      bottom: main.top + main.h,
      fmt: (p) => fmtPrice(p, this.dec),
      bars: (t0, t1) => Math.round(Math.abs(this.tIdx(t1) - this.tIdx(t0))),
      font: this.font,
      tr: (k) => this.tr(k),
    };
  }

  /* ── Кадр ───────────────────────────────────────────────────────────── */

  private paint() {
    this.compute();
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.font = this.font;
    this.layout();
    if (!this.shown.length) {
      this.emitHover();
      return;
    }
    // Ширина шкалы цены — по самой длинной подписи.
    const sample = fmtPrice(this.panes[0]!.scale.hi, this.dec);
    this.priceW = Math.max(58, Math.ceil(ctx.measureText(sample).width) + 18);
    const [i0, i1] = this.visible();
    this.baseI = i0;
    this.autoscale(i0, i1);

    if (!this.olderAsked && !this.noOlder && this.idx(0) < 40) {
      this.olderAsked = true;
      this.ev.needOlder();
    }

    this.paintGrid();
    if (this.mark) {
      const main = this.panes[0]!;
      ctx.save();
      ctx.font = `700 ${Math.round(Math.min(64, this.w / 9))}px ${this.font.replace(/^\d+px\s*/, "")}`;
      ctx.fillStyle = "rgba(127,216,255,0.045)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.mark, this.plotR / 2, main.top + main.h / 2);
      ctx.restore();
    }

    for (const p of this.panes) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, p.top, this.plotR, p.h);
      ctx.clip();
      if (p.key === "main") this.paintMain(i0, i1);
      else this.paintSub(p, i0, i1);
      ctx.restore();
    }

    // Разделители панелей.
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    for (const p of this.panes.slice(1)) {
      ctx.beginPath();
      ctx.moveTo(0, p.top + 0.5);
      ctx.lineTo(this.w, p.top + 0.5);
      ctx.stroke();
    }
    this.paintAxes();
    this.paintCross();
    this.paintLoupe();
    this.emitHover();
  }

  /**
   * Лупа: палец закрывает точку, которую ставит, — над пальцем показываем
   * увеличенный участок с перекрестием. У TradingView на телефоне такого нет,
   * и точку там ставят наугад.
   */
  private paintLoupe() {
    const l = this.loupe;
    if (!l) return;
    const ctx = this.ctx;
    const r = 52;
    const zoom = 2;
    const cx = Math.max(r + 4, Math.min(this.w - r - 4, l.x));
    const cy = l.y - r - 46 < r ? l.y + r + 46 : l.y - r - 46;
    const src = (r / zoom) * this.dpr;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = C.bg;
    ctx.fill();
    ctx.clip();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.cv, l.x * this.dpr - src, l.y * this.dpr - src, src * 2, src * 2,
      (cx - r) * this.dpr, (cy - r) * this.dpr, r * 2 * this.dpr, r * 2 * this.dpr);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy);
    ctx.lineTo(cx + 10, cy);
    ctx.moveTo(cx, cy - 10);
    ctx.lineTo(cx, cy + 10);
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "#7fd8ff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  private paintGrid() {
    const ctx = this.ctx;
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    // Вертикали — по подписям времени.
    for (const [x] of this.timeTicks()) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, this.h - TIME_H);
      ctx.stroke();
    }
    for (const p of this.panes) {
      if (p.empty) continue;
      for (const [y] of this.priceTicks(p)) {
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(this.plotR, Math.round(y) + 0.5);
        ctx.stroke();
      }
    }
  }

  private priceTicks(p: Pane): [number, number][] {
    const s = p.scale;
    const out: [number, number][] = [];
    const target = Math.max(2, Math.floor(p.h / 46));
    if (p.key === "main" && this.pctMode) {
      // Проценты от первой видимой свечи: шаг подбираем в процентах.
      const base = this.bars[this.baseI]?.c;
      if (base) {
        const plo = (s.lo / base - 1) * 100;
        const phi = (s.hi / base - 1) * 100;
        const st = niceStep(phi - plo, target);
        let last = Infinity;
        for (let v = Math.ceil(plo / st) * st; v <= phi + st * 0.01; v += st) {
          const y = this.py(p, base * (1 + v / 100));
          if (Math.abs(last - y) < 22) continue;
          out.push([y, v]);
          last = y;
        }
        return out;
      }
    }
    if (s.log && p.key === "main") {
      // Лог-шкала: шаги по кратности, подписи не теснее 26 px.
      let last = Infinity;
      const lo = s.lo;
      const hi = s.hi;
      const step0 = niceStep(hi - lo, target * 2);
      for (let v = Math.ceil(lo / step0) * step0; v <= hi; v += step0) {
        const y = this.py(p, v);
        if (Math.abs(last - y) >= 26) {
          out.push([y, v]);
          last = y;
        }
      }
      return out;
    }
    const step = niceStep(s.hi - s.lo, target);
    if (!(step > 0)) return out;
    for (let v = Math.ceil(s.lo / step) * step; v <= s.hi + step * 0.01; v += step) out.push([this.py(p, v), v]);
    return out;
  }

  private timeTicks(): [number, string, boolean][] {
    const out: [number, string, boolean][] = [];
    const n = this.shown.length;
    if (!n) return out;
    const per = TF_MS[this.tf];
    const minPx = 78;
    let step = T_STEPS[T_STEPS.length - 1]!;
    for (const s of T_STEPS) {
      if (s[0] < per) continue;
      if ((s[0] / per) * this.spacing >= minPx) {
        step = s;
        break;
      }
    }
    const daily = per >= 86400_000;
    const key = (t: number): number => {
      const d = new Date(t);
      const Y = daily ? d.getUTCFullYear() : d.getFullYear();
      const M = daily ? d.getUTCMonth() : d.getMonth();
      const D = daily ? d.getUTCDate() : d.getDate();
      const H = daily ? d.getUTCHours() : d.getHours();
      const m = daily ? d.getUTCMinutes() : d.getMinutes();
      switch (step[1]) {
        case "Y": return Y;
        case "M": return Y * 12 + Math.floor(M / step[2]);
        case "d": return step[2] === 1 ? Y * 400 + M * 32 + D
          : step[2] >= 7 ? Math.floor((t - 4 * 86400_000) / (step[2] * 86400_000)) : Math.floor(t / (step[2] * 86400_000));
        case "h": return (Y * 400 + M * 32 + D) * 24 + Math.floor(H / step[2]);
        default: return ((Y * 400 + M * 32 + D) * 24 + H) * 60 + Math.floor(m / step[2]);
      }
    };
    const [a, b] = this.visible();
    let prev = a > 0 ? key(this.shown[a - 1]!.t) : NaN;
    let lastX = -Infinity;
    // Что сменилось с прошлой свечи — то и подписываем: год, месяц, день или время.
    // Смотрим на смену даты, а не на «полночь»: у 4-часовых свечей в Киеве
    // день начинается со свечи 03:00, и раньше вместо даты стояло «03:00».
    const parts = (t: number) => {
      const d = new Date(t);
      return daily
        ? [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()]
        : [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()];
    };
    // Год и месяц сверяем с прошлой подписью (между подписями могла пройти
    // неделя — смена месяца внутри неё тоже должна стать «Oct»), день — с
    // прошлой свечой.
    let pp = a > 0 ? parts(this.shown[a - 1]!.t) : null;
    let lbl = pp;
    for (let i = a; i <= b; i++) {
      const t = this.shown[i]!.t;
      const k = key(t);
      const [Y, M, D, H, mi] = parts(t) as [number, number, number, number, number];
      const prevP = pp;
      pp = [Y, M, D, H, mi];
      if (k !== prev) {
        const x = this.x(i);
        if (x - lastX >= minPx * 0.7) {
          let txt: string;
          let bold = false;
          if (lbl && lbl[0] !== Y) {
            txt = String(Y);
            bold = true;
          } else if (lbl && lbl[1] !== M) {
            txt = MONTHS[M]!;
            bold = true;
          } else if ((prevP && prevP[2] !== D) || step[1] === "d" || step[1] === "M" || step[1] === "Y") txt = String(D);
          else txt = `${String(H).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
          out.push([x, txt, bold]);
          lastX = x;
          lbl = pp;
        }
        prev = k;
      }
    }
    return out;
  }

  private paintMain(i0: number, i1: number) {
    const ctx = this.ctx;
    const main = this.panes[0]!;
    const sp = this.spacing;
    const bw = Math.max(1, Math.min(sp * 0.72, sp - 1));

    // Профиль объёма видимого участка: где торговали больше всего.
    const vp = this.inds.find((i) => i.kind === "vp" && !i.hidden);
    if (vp && i1 > i0) this.paintVp(main, i0, i1, vp.params[0] ?? 40, (vp.params[1] ?? 70) / 100);

    // Уровни ликвидаций — позади всего: горизонтальные полосы справа.
    const liqOn = this.inds.some((i) => i.kind === "wt_liq" && !i.hidden);
    if (liqOn && this.own.liq?.rows.length) {
      const rows = this.own.liq.rows;
      const max = Math.max(...rows.map((r) => r.L + r.S), 1);
      const maxW = this.plotR * 0.28;
      const last = this.bars[this.bars.length - 1]!.c;
      const steps = rows.length > 1 ? Math.abs(rows[1]!.p - rows[0]!.p) : last * 0.002;
      for (const r of rows) {
        const y0 = this.py(main, r.p + steps / 2);
        const y1 = this.py(main, r.p - steps / 2);
        // Тонкая полоса по центру уровня — как тепловая карта, а не кирпич.
        const hh = Math.max(1, Math.min(5, Math.abs(y1 - y0) - 0.5));
        const v = r.L + r.S;
        const w = (v / max) * maxW;
        if (w < 0.5) continue;
        const a = 0.18 + 0.55 * (v / max);
        ctx.fillStyle = r.p < last ? `rgba(255,92,119,${a})` : `rgba(61,220,151,${a})`;
        ctx.fillRect(this.plotR - w, (y0 + y1) / 2 - hh / 2, w, hh);
      }
    }

    // Объём — внизу главной панели, своя шкала.
    const vol = this.inds.find((i) => i.kind === "vol" && !i.hidden);
    if (vol) {
      let vmax = 0;
      for (let i = i0; i <= i1; i++) vmax = Math.max(vmax, this.bars[i]?.v ?? 0);
      const base = main.top + main.h;
      const vh = main.h * 0.18;
      if (vmax > 0) {
        for (let i = i0; i <= i1; i++) {
          const b = this.bars[i]!;
          const hgt = (b.v / vmax) * vh;
          ctx.fillStyle = b.c >= b.o ? "rgba(61,220,151,0.28)" : "rgba(255,92,119,0.28)";
          ctx.fillRect(this.x(i) - bw / 2, base - hgt, bw, hgt);
        }
        const ma = this.calc.get(vol.uid)?.[1];
        if (ma) {
          ctx.strokeStyle = vol.colors[1] ?? "#f0b90b";
          ctx.lineWidth = 1;
          ctx.beginPath();
          let pen = false;
          for (let i = i0; i <= i1; i++) {
            const v = ma[i];
            if (!finite(v)) {
              pen = false;
              continue;
            }
            const y = base - (v / vmax) * vh;
            if (pen) ctx.lineTo(this.x(i), y);
            else ctx.moveTo(this.x(i), y);
            pen = true;
          }
          ctx.stroke();
        }
      }
    }

    // Индикаторы поверх цены: сперва заливки, потом линии.
    for (const ind of this.inds) {
      const d = IND[ind.kind];
      if (d.pane || ind.hidden || d.own || ind.kind === "vol") continue;
      const ser = this.calc.get(ind.uid);
      if (!ser) continue;
      for (const f of d.fills ?? []) this.fill(main, ser[f.a], ser[f.b], i0, i1 + 30, f.color, !!f.byDir);
    }

    // Цена.
    const s = this.shown;
    if (this.type === "line" || this.type === "area") {
      const first = s[i0];
      const last = s[i1];
      const up = !!first && !!last && last.c >= first.c;
      if (this.type === "area") {
        const g = ctx.createLinearGradient(0, main.top, 0, main.top + main.h);
        g.addColorStop(0, "rgba(58,155,255,0.32)");
        g.addColorStop(1, "rgba(58,155,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(this.x(i0), main.top + main.h);
        for (let i = i0; i <= i1; i++) ctx.lineTo(this.x(i), this.py(main, s[i]!.c));
        ctx.lineTo(this.x(i1), main.top + main.h);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = this.type === "area" ? "#3a9bff" : up ? C.up : "#3a9bff";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) {
        const y = this.py(main, s[i]!.c);
        if (i === i0) ctx.moveTo(this.x(i), y);
        else ctx.lineTo(this.x(i), y);
      }
      ctx.stroke();
    } else {
      ctx.lineWidth = 1;
      for (let i = i0; i <= i1; i++) {
        const b = s[i]!;
        const x = Math.round(this.x(i)) + 0.5;
        const up = b.c >= b.o;
        const col = up ? C.up : C.dn;
        const yo = this.py(main, b.o);
        const yc = this.py(main, b.c);
        const yh = this.py(main, b.h);
        const yl = this.py(main, b.l);
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        if (this.type === "bars") {
          ctx.beginPath();
          ctx.moveTo(x, yh);
          ctx.lineTo(x, yl);
          ctx.moveTo(x - bw / 2, yo);
          ctx.lineTo(x, yo);
          ctx.moveTo(x, yc);
          ctx.lineTo(x + bw / 2, yc);
          ctx.stroke();
          continue;
        }
        const top = Math.min(yo, yc);
        const bh = Math.max(1, Math.abs(yc - yo));
        ctx.beginPath();
        ctx.moveTo(x, yh);
        ctx.lineTo(x, top);
        ctx.moveTo(x, top + bh);
        ctx.lineTo(x, yl);
        ctx.stroke();
        if (bw <= 2) {
          ctx.fillRect(x - 0.5, top, 1, bh);
        } else if (this.type === "hollow" && up) {
          ctx.strokeRect(Math.round(x - bw / 2) + 0.5, top + 0.5, Math.round(bw) - 1, Math.max(1, bh - 1));
        } else {
          ctx.fillRect(Math.round(x - bw / 2), top, Math.round(bw), bh);
        }
      }
    }

    // Сравниваемые монеты — линиями, в масштабе главной от общей точки старта.
    for (const c of this.cmp) {
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let pen = false;
      let lastX = 0;
      let lastY = 0;
      for (let i = i0; i <= i1; i++) {
        const v = this.cmpAt(c, i);
        if (!finite(v)) {
          pen = false;
          continue;
        }
        lastX = this.x(i);
        lastY = this.py(main, v);
        if (pen) ctx.lineTo(lastX, lastY);
        else ctx.moveTo(lastX, lastY);
        pen = true;
      }
      ctx.stroke();
      if (lastX) {
        ctx.font = `700 ${this.font}`;
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(5,11,22,0.9)";
        ctx.strokeText(c.label, lastX - 4, lastY - 4);
        ctx.fillStyle = c.color;
        ctx.fillText(c.label, lastX - 4, lastY - 4);
      }
    }

    // Уровни вне экрана — ярлыком у края со стрелкой: не сжимаем свечи
    // и не прячем уровень молча.
    const edge = { top: 0, bottom: 0 };
    for (const ind of this.inds) {
      const d = IND[ind.kind];
      if (d.pane || ind.hidden || d.own || ind.kind === "vol") continue;
      const ser = this.calc.get(ind.uid);
      if (!ser) continue;
      d.lines.forEach((l, k) => {
        const sr = ser[k];
        if (sr) this.series(main, sr, i0, ind.kind === "ichi" ? i1 + (ind.params[3] ?? 26) : i1, ind.colors[k] ?? l.color, l.style ?? "line", false, bw);
        // Подпись у правого конца: «R1 84 120», «0.618 (83 950)».
        if (sr && l.label) {
          let j = Math.min(i1, sr.length - 1);
          while (j >= i0 && !finite(sr[j])) j--;
          const v = sr[j];
          if (j >= i0 && finite(v)) {
            let y = this.py(main, v);
            let arrow = "";
            if (y < main.top + 16) {
              arrow = "↑ ";
              y = main.top + 30 + 13 * edge.top++;
            } else if (y > main.top + main.h - 4) {
              arrow = "↓ ";
              y = main.top + main.h - 6 - 13 * edge.bottom++;
            }
            const txt = `${arrow}${l.name}  ${fmtPrice(v, this.dec)}`;
            ctx.font = this.font;
            const tw = ctx.measureText(txt).width;
            const x = Math.min(this.plotR - tw - 4, this.x(j) + 4);
            ctx.fillStyle = "rgba(5,11,22,0.75)";
            ctx.fillRect(x - 2, y - 13, tw + 4, 12);
            ctx.fillStyle = ind.colors[k] ?? l.color;
            ctx.textAlign = "left";
            ctx.textBaseline = "bottom";
            ctx.fillText(txt, x, y - 2);
          }
        }
      });
    }

    // Значки: свечные паттерны и дивергенции.
    for (const ind of this.inds) {
      if (ind.hidden) continue;
      const ms = this.marks.get(ind.uid);
      if (!ms) continue;
      ctx.font = `600 ${this.font.replace(/^\d+px/, "10px")}`;
      ctx.textAlign = "center";
      // Подписи не должны налезать друг на друга: над и под свечами —
      // своя очередь, следующая подпись не ближе её ширины.
      const lastX = { up: -Infinity, dn: -Infinity };
      for (const m of ms) {
        if (m.i < i0 - 1 || m.i > i1 + 1) continue;
        const x = this.x(m.i);
        const y = this.py(main, m.p);
        if (m.link) {
          ctx.strokeStyle = m.color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(this.x(m.link.i), this.py(main, m.link.p));
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        const ty = m.below ? y + 16 : y - 16;
        ctx.fillStyle = m.color;
        ctx.beginPath();
        if (m.below) {
          ctx.moveTo(x, y + 4);
          ctx.lineTo(x - 4, y + 9);
          ctx.lineTo(x + 4, y + 9);
        } else {
          ctx.moveTo(x, y - 4);
          ctx.lineTo(x - 4, y - 9);
          ctx.lineTo(x + 4, y - 9);
        }
        ctx.fill();
        // Подпись — только если свечи не слиплись и есть место.
        const txt = this.tr(m.text);
        const tw = ctx.measureText(txt).width;
        const lane = m.below ? "dn" : "up";
        if (this.spacing >= 4 && x - tw / 2 > lastX[lane] + 4) {
          ctx.textBaseline = m.below ? "top" : "bottom";
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(5,11,22,0.9)";
          ctx.strokeText(txt, x, m.below ? ty - 5 : ty + 5);
          ctx.fillText(txt, x, m.below ? ty - 5 : ty + 5);
          lastX[lane] = x + tw / 2;
        }
      }
    }

    // Максимум и минимум видимого участка.
    if (i1 > i0 && this.type !== "line" && this.type !== "area") {
      let hiI = i0;
      let loI = i0;
      for (let i = i0; i <= i1; i++) {
        if (s[i]!.h > s[hiI]!.h) hiI = i;
        if (s[i]!.l < s[loI]!.l) loI = i;
      }
      ctx.font = this.font;
      ctx.fillStyle = C.axis;
      ctx.textBaseline = "middle";
      const mk = (i: number, v: number, dy: number) => {
        const x = this.x(i);
        const y = this.py(main, v) + dy;
        const txt = fmtPrice(v, this.dec);
        const right = x < this.plotR * 0.6;
        const s2 = right ? `← ${txt}` : `${txt} →`;
        const tw = ctx.measureText(s2).width;
        const tx = right ? x + 4 : x - 4 - tw;
        ctx.fillStyle = "rgba(5,11,22,0.7)";
        ctx.fillRect(tx - 2, y - 7, tw + 4, 14);
        ctx.fillStyle = C.axis;
        ctx.textAlign = "left";
        ctx.fillText(s2, tx, y);
      };
      mk(hiI, s[hiI]!.h, -9);
      mk(loI, s[loI]!.l, 9);
    }

    // Линия последней цены.
    const last = this.bars[this.bars.length - 1]!;
    const ly = Math.round(this.py(main, last.c)) + 0.5;
    ctx.strokeStyle = last.c >= last.o ? C.up : C.dn;
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, ly);
    ctx.lineTo(this.plotR, ly);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    this.paintLiqx(main, i0, i1);
    this.paintWhales(main, i0, i1);

    // Рисунки.
    if (!this.hideDrawings) {
      const v = this.view();
      for (const d of this.drawings) renderDrawing(ctx, d, v, d.id === this.sel);
      if (this.creating) renderDrawing(ctx, this.creating.d, v, true);
    }
  }

  /**
   * Ликвидации на свечах: пузырь под свечой — выбило лонги, над — шорты.
   * Размер — по сумме (площадь круга ∝ $), крупнейшие подписаны.
   */
  private paintLiqx(p: Pane, i0: number, i1: number) {
    if (!this.liqx?.length || !this.inds.some((i) => i.kind === "wt_liqx" && !i.hidden)) return;
    const ctx = this.ctx;
    // Ликвидации — в свечу, в которую попадает их время (свеча может быть крупнее шага данных).
    const L = new Map<number, number>();
    const S = new Map<number, number>();
    for (const [t, l, sh] of this.liqx) {
      const i = Math.floor(this.tIdx(t * 1000) + 1e-6);
      if (i < i0 - 1 || i > i1 + 1) continue;
      L.set(i, (L.get(i) ?? 0) + l);
      S.set(i, (S.get(i) ?? 0) + sh);
    }
    const max = Math.max(1, ...L.values(), ...S.values());
    const rMax = Math.max(6, Math.min(18, this.spacing * 1.6));
    const draw = (i: number, v: number, long: boolean) => {
      if (v <= 0) return;
      const b = this.bars[i];
      if (!b) return;
      const r = Math.max(2, Math.sqrt(v / max) * rMax);
      const x = this.x(i);
      const y = long ? this.py(p, b.l) + r + 4 : this.py(p, b.h) - r - 4;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = long ? "rgba(255,92,119,0.55)" : "rgba(61,220,151,0.55)";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = long ? "#ff5c77" : "#3ddc97";
      ctx.stroke();
      if (v >= max * 0.45 && this.spacing >= 3) {
        ctx.font = `600 ${this.font.replace(/^\d+px/, "10px")}`;
        ctx.textAlign = "center";
        ctx.textBaseline = long ? "top" : "bottom";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(5,11,22,0.9)";
        const txt = `$${fmtShort(v)}`;
        const ty = long ? y + r + 2 : y - r - 2;
        ctx.strokeText(txt, x, ty);
        ctx.fillStyle = long ? "#ff5c77" : "#3ddc97";
        ctx.fillText(txt, x, ty);
      }
    };
    for (const [i, v] of L) draw(i, v, true);
    for (const [i, v] of S) draw(i, v, false);
  }

  /** Сделки китов: ромб на цене сделки, зелёный — покупка, красный — продажа. */
  private paintWhales(p: Pane, i0: number, i1: number) {
    if (!this.whales?.length || !this.inds.some((i) => i.kind === "wt_whale" && !i.hidden)) return;
    const ctx = this.ctx;
    const vis = this.whales.filter((w) => {
      const i = this.tIdx(w.t * 1000);
      return i >= i0 - 1 && i <= i1 + 1;
    });
    if (!vis.length) return;
    const max = Math.max(...vis.map((w) => w.usd));
    // Сначала мелкие — крупные ложатся сверху.
    for (const w of [...vis].sort((a, b) => a.usd - b.usd)) {
      const x = this.x(Math.floor(this.tIdx(w.t * 1000) + 1e-6));
      const y = this.py(p, w.px);
      const r = Math.max(3, Math.sqrt(w.usd / max) * 9);
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fillStyle = w.buy ? "rgba(61,220,151,0.85)" : "rgba(255,92,119,0.85)";
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "#050b16";
      ctx.stroke();
      if (w.usd >= max * 0.5 && this.spacing >= 3) {
        ctx.font = `600 ${this.font.replace(/^\d+px/, "10px")}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(5,11,22,0.9)";
        const txt = `🐋 $${fmtShort(w.usd)}`;
        // У правого края подпись — слева от ромба, иначе её режет шкала цены.
        const tw = ctx.measureText(txt).width;
        const left = x + r + 3 + tw > this.plotR - 2;
        const tx = left ? x - r - 3 - tw : x + r + 3;
        ctx.strokeText(txt, tx, y);
        ctx.fillStyle = w.buy ? "#3ddc97" : "#ff5c77";
        ctx.fillText(txt, tx, y);
      }
    }
  }

  /** Профиль объёма: объём свечи раскладывается по ценам от минимума до максимума. */
  private paintVp(p: Pane, i0: number, i1: number, rows: number, area: number) {
    const ctx = this.ctx;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = i0; i <= i1; i++) {
      const b = this.bars[i]!;
      lo = Math.min(lo, b.l);
      hi = Math.max(hi, b.h);
    }
    if (!(hi > lo)) return;
    const n = Math.max(5, Math.round(rows));
    const step = (hi - lo) / n;
    const up = new Float64Array(n);
    const dn = new Float64Array(n);
    for (let i = i0; i <= i1; i++) {
      const b = this.bars[i]!;
      const a = Math.max(0, Math.floor((b.l - lo) / step));
      const z = Math.min(n - 1, Math.floor((b.h - lo) / step));
      const share = b.v / (z - a + 1);
      for (let k = a; k <= z; k++) {
        if (b.c >= b.o) up[k] = (up[k] ?? 0) + share;
        else dn[k] = (dn[k] ?? 0) + share;
      }
    }
    const tot = Array.from(up, (v, k) => v + dn[k]!);
    let poc = 0;
    tot.forEach((v, k) => {
      if (v > tot[poc]!) poc = k;
    });
    // Зона стоимости: от точки контроля в обе стороны, пока не наберётся area объёма.
    const all = tot.reduce((x, y) => x + y, 0);
    let va0 = poc;
    let va1 = poc;
    let acc = tot[poc]!;
    while (acc < all * area && (va0 > 0 || va1 < n - 1)) {
      const below = va0 > 0 ? tot[va0 - 1]! : -1;
      const above = va1 < n - 1 ? tot[va1 + 1]! : -1;
      if (above >= below) acc += tot[++va1]!;
      else acc += tot[--va0]!;
    }
    const max = tot[poc]! || 1;
    const maxW = this.plotR * 0.3;
    for (let k = 0; k < n; k++) {
      const y0 = this.py(p, lo + (k + 1) * step);
      const y1 = this.py(p, lo + k * step);
      const h = Math.max(1, y1 - y0 - 1);
      const inVa = k >= va0 && k <= va1;
      const wu = (up[k]! / max) * maxW;
      const wd = (dn[k]! / max) * maxW;
      ctx.fillStyle = inVa ? "rgba(61,220,151,0.30)" : "rgba(61,220,151,0.14)";
      ctx.fillRect(this.plotR - wu - wd, y0, wu, h);
      ctx.fillStyle = inVa ? "rgba(255,92,119,0.30)" : "rgba(255,92,119,0.14)";
      ctx.fillRect(this.plotR - wd, y0, wd, h);
    }
    // Точка контроля (POC) — цена, где наторговали больше всего.
    const py = Math.round(this.py(p, lo + (poc + 0.5) * step)) + 0.5;
    ctx.strokeStyle = "#f0b90b";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(this.plotR, py);
    ctx.stroke();
    ctx.font = this.font;
    ctx.fillStyle = "#f0b90b";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(`POC ${fmtPrice(lo + (poc + 0.5) * step, this.dec)}`, 6, py - 2);
  }

  private fill(p: Pane, a: Ser | undefined, b: Ser | undefined, i0: number, i1: number, color: string, byDir: boolean) {
    if (!a || !b) return;
    const ctx = this.ctx;
    const end = Math.min(i1, a.length - 1, b.length - 1);
    let i = i0;
    while (i <= end) {
      while (i <= end && !(finite(a[i]) && finite(b[i]))) i++;
      if (i > end) break;
      const start = i;
      const up = (a[i] as number) >= (b[i] as number);
      while (i <= end && finite(a[i]) && finite(b[i]) && (!byDir || ((a[i] as number) >= (b[i] as number)) === up)) i++;
      const stop = i - 1;
      if (stop <= start) continue;
      ctx.fillStyle = byDir && !up ? "rgba(255,92,119,0.12)" : color;
      ctx.beginPath();
      for (let k = start; k <= stop; k++) {
        const y = this.py(p, a[k] as number);
        if (k === start) ctx.moveTo(this.x(k), y);
        else ctx.lineTo(this.x(k), y);
      }
      for (let k = stop; k >= start; k--) ctx.lineTo(this.x(k), this.py(p, b[k] as number));
      ctx.closePath();
      ctx.fill();
    }
  }

  private series(p: Pane, s: Ser, i0: number, i1: number, color: string, style: string, signed: boolean, bw: number) {
    const ctx = this.ctx;
    const end = Math.min(i1, s.length - 1);
    if (style === "hist") {
      const zero = this.py(p, Math.max(p.scale.lo, Math.min(p.scale.hi, 0)));
      for (let i = i0; i <= end; i++) {
        const v = s[i];
        if (!finite(v)) continue;
        const y = this.py(p, v);
        const prev = s[i - 1];
        if (signed) {
          const grow = finite(prev) ? Math.abs(v) >= Math.abs(prev) : true;
          ctx.fillStyle = v >= 0 ? (grow ? "#3ddc97" : "rgba(61,220,151,0.5)") : grow ? "#ff5c77" : "rgba(255,92,119,0.5)";
        } else ctx.fillStyle = color;
        ctx.fillRect(this.x(i) - bw / 2, Math.min(y, zero), bw, Math.max(1, Math.abs(zero - y)));
      }
      return;
    }
    if (style === "dots") {
      ctx.fillStyle = color;
      const r = Math.max(1.2, Math.min(2.5, this.spacing / 4));
      for (let i = i0; i <= end; i++) {
        const v = s[i];
        if (!finite(v)) continue;
        ctx.beginPath();
        ctx.arc(this.x(i), this.py(p, v), r, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    if (style === "zz") {
      // Ломаная через вершины: точки есть не на каждой свече.
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      let first = true;
      let from = i0;
      while (from > 0 && !finite(s[from])) from--;
      let to = end;
      while (to < s.length - 1 && !finite(s[to])) to++;
      for (let i = from; i <= to; i++) {
        const v = s[i];
        if (!finite(v)) continue;
        const x = this.x(i);
        const y = this.py(p, v);
        if (first) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        first = false;
      }
      ctx.stroke();
      return;
    }
    if (style === "level") {
      const v = s[s.length - 1];
      if (!finite(v)) return;
      const y = Math.round(this.py(p, v)) + 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.plotR, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color.startsWith("#") ? `${color}22` : color;
      ctx.fillRect(0, y - 3, this.plotR, 6);
      return;
    }
    if (style === "step") {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = Math.max(0, i0 - 1); i <= end; i++) {
        const v = s[i];
        if (!finite(v)) continue;
        const y = Math.round(this.py(p, v)) + 0.5;
        ctx.moveTo(this.x(i) - this.spacing / 2, y);
        ctx.lineTo(this.x(i) + this.spacing / 2, y);
      }
      ctx.stroke();
      return;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.beginPath();
    let pen = false;
    for (let i = Math.max(0, i0 - 1); i <= end; i++) {
      const v = s[i];
      if (!finite(v)) {
        pen = false;
        continue;
      }
      const x = this.x(i);
      const y = this.py(p, v);
      if (pen) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
  }

  private paintSub(p: Pane, i0: number, i1: number) {
    const ctx = this.ctx;
    const ind = p.ind;
    if (!ind) return;
    const d = IND[ind.kind];
    const bw = Math.max(1, Math.min(this.spacing * 0.72, this.spacing - 1));
    // Уровни (30/70 и т. п.) и заливка между крайними.
    const lv = d.levels ?? [];
    if (lv.length === 2 && d.range) {
      const y0 = this.py(p, lv[0]!);
      const y1 = this.py(p, lv[1]!);
      ctx.fillStyle = "rgba(127,216,255,0.04)";
      ctx.fillRect(0, Math.min(y0, y1), this.plotR, Math.abs(y1 - y0));
    }
    ctx.strokeStyle = "rgba(124,151,188,0.35)";
    ctx.setLineDash([4, 4]);
    for (const l of lv) {
      const y = Math.round(this.py(p, l)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.plotR, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (ind.hidden) return;

    if (d.own) {
      const own = ind.kind === "wt_oi" ? this.own.oi : this.own.fund;
      if (!own || !own.t.length) return;
      const t0 = this.iTime(i0 - 2);
      const t1 = this.iTime(i1 + 2);
      if (ind.kind === "wt_oi") {
        const pts: [number, number][] = [];
        own.t.forEach((t, k) => {
          const v = own.v[k];
          if (t >= t0 - 86400_000 && t <= t1 + 86400_000 && finite(v)) pts.push([this.tx(t), this.py(p, v)]);
        });
        if (pts.length < 2) return;
        const g = ctx.createLinearGradient(0, p.top, 0, p.top + p.h);
        g.addColorStop(0, "rgba(127,216,255,0.3)");
        g.addColorStop(1, "rgba(127,216,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(pts[0]![0], p.top + p.h);
        for (const [x, y] of pts) ctx.lineTo(x, y);
        ctx.lineTo(pts[pts.length - 1]![0], p.top + p.h);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = ind.colors[0] ?? "#7fd8ff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
      } else {
        const zero = this.py(p, 0);
        // Ширина столбика — его промежуток времени (8 ч) в пикселях.
        const span = own.t.length > 1 ? Math.abs(own.t[1]! - own.t[0]!) : 8 * 3600_000;
        const w = Math.max(1, (span / TF_MS[this.tf]) * this.spacing * 0.8);
        own.t.forEach((t, k) => {
          const v = own.v[k];
          if (!finite(v) || t < t0 - span || t > t1 + span) return;
          const x = this.tx(t + span / 2);
          const y = this.py(p, v);
          ctx.fillStyle = v >= 0 ? "rgba(61,220,151,0.8)" : "rgba(255,92,119,0.8)";
          ctx.fillRect(x - w / 2, Math.min(y, zero), w, Math.max(1, Math.abs(zero - y)));
        });
      }
      return;
    }
    const ser = this.calc.get(ind.uid);
    if (!ser) return;
    d.lines.forEach((l, k) => {
      const s = ser[k];
      if (s) this.series(p, s, i0, i1, ind.colors[k] ?? l.color, l.style ?? "line", !!l.signed, bw);
    });
  }

  private axisLabel(y: number, txt: string, bg: string, fg = "#fff", sub?: string) {
    const ctx = this.ctx;
    const h = sub ? 30 : 17;
    const x = this.plotR;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(x + 1, y - 8.5, this.priceW - 2, h, 3);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(txt, x + 6, y + 0.5);
    if (sub) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText(sub, x + 6, y + 13.5);
    }
  }

  private countdown(): string {
    const last = this.bars[this.bars.length - 1];
    if (!last) return "";
    const left = tfEnd(this.tf, last.t) - Date.now();
    if (left <= 0) return "";
    const s = Math.floor(left / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  private paintAxes() {
    const ctx = this.ctx;
    const R = this.plotR;
    ctx.fillStyle = C.bg;
    ctx.fillRect(R, 0, this.priceW, this.h);
    ctx.fillRect(0, this.h - TIME_H, this.w, TIME_H);
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(R + 0.5, 0);
    ctx.lineTo(R + 0.5, this.h - TIME_H);
    ctx.moveTo(0, this.h - TIME_H + 0.5);
    ctx.lineTo(this.w, this.h - TIME_H + 0.5);
    ctx.stroke();
    ctx.font = this.font;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (const p of this.panes) {
      ctx.fillStyle = C.axis;
      if (p.empty) continue;
      for (const [y, v] of this.priceTicks(p)) {
        if (y < p.top + 8 || y > p.top + p.h - 6) continue;
        ctx.fillText(p.key === "main" ? (this.pctMode ? `${v > 0 ? "+" : ""}${+v.toFixed(2)}%` : fmtPrice(v, this.dec)) : fmtShort(v), R + 6, y);
      }
      // Последнее значение индикатора — плашкой его цвета.
      if (p.ind && !p.ind.hidden) {
        const d = IND[p.ind.kind];
        if (d.own) {
          const own = p.ind.kind === "wt_oi" ? this.own.oi : this.own.fund;
          const v = own?.v[own.v.length - 1];
          if (finite(v)) this.axisLabel(this.py(p, v), p.ind.kind === "wt_fund" ? `${v.toFixed(4)}%` : fmtShort(v), p.ind.colors[0] ?? "#3a9bff");
        } else {
          const ser = this.calc.get(p.ind.uid);
          d.lines.forEach((l, k) => {
            if (l.style === "hist") return;
            const s = ser?.[k];
            const v = s?.[this.bars.length - 1];
            if (finite(v)) this.axisLabel(this.py(p, v), fmtShort(v), p.ind!.colors[k] ?? l.color);
          });
        }
      }
    }
    // Подписи рисунков на шкале цены.
    const main = this.panes[0]!;
    if (!this.hideDrawings) {
      for (const d of this.drawings) {
        for (const m of axisMarks(d)) {
          if (m.p !== undefined) this.axisLabel(this.py(main, m.p), fmtPrice(m.p, this.dec), d.color);
        }
      }
    }
    // Последняя цена с отсчётом до закрытия свечи.
    const last = this.bars[this.bars.length - 1]!;
    const ly = this.py(main, last.c);
    if (ly > main.top - 10 && ly < main.top + main.h + 10) {
      this.axisLabel(Math.max(main.top + 9, Math.min(main.top + main.h - 22, ly)), fmtPrice(last.c, this.dec),
        last.c >= last.o ? "#1fa972" : "#d9405b", "#fff", this.countdown() || undefined);
    }
    // Время.
    ctx.textAlign = "center";
    for (const [x, txt, bold] of this.timeTicks()) {
      if (x < 12 || x > R - 12) continue;
      ctx.fillStyle = bold ? C.text : C.axis;
      ctx.font = bold ? `600 ${this.font}` : this.font;
      ctx.fillText(txt, x, this.h - TIME_H / 2);
    }
    ctx.font = this.font;
    // Кнопки шкалы: A — авто, L — логарифм.
    const by = this.h - TIME_H / 2;
    ctx.textAlign = "center";
    ctx.fillStyle = main.scale.auto ? "#7fd8ff" : C.axis;
    ctx.font = `700 ${this.font}`;
    ctx.fillText("A", R + this.priceW * 0.2, by);
    ctx.fillStyle = main.scale.log ? "#7fd8ff" : C.axis;
    ctx.fillText("L", R + this.priceW * 0.5, by);
    ctx.fillStyle = this.pctMode ? "#7fd8ff" : C.axis;
    ctx.fillText("%", R + this.priceW * 0.8, by);
    ctx.font = this.font;
  }

  private paintCross() {
    const c = this.cross;
    if (!c || !this.shown.length) return;
    const ctx = this.ctx;
    const pi = this.paneAt(c.y);
    const p = this.panes[pi]!;
    const i = Math.round(this.idx(c.x));
    const x = Math.round(this.x(i)) + 0.5;
    const y = Math.round(c.y) + 0.5;
    ctx.strokeStyle = C.cross;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, this.h - TIME_H);
    if (c.y < this.h - TIME_H) {
      ctx.moveTo(0, y);
      ctx.lineTo(this.plotR, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = this.font;
    if (c.y < this.h - TIME_H) {
      const v = this.yp(p, c.y);
      this.axisLabel(c.y, p.key === "main" ? fmtPrice(v, this.dec) : fmtShort(v), "#2a3f5f");
    }
    // Время под перекрестием.
    const t = this.iTime(i);
    const d = new Date(t);
    const daily = TF_MS[this.tf] >= 86400_000;
    const ds = daily
      ? `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`
      : `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} '${String(d.getFullYear()).slice(2)}  ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const tw = ctx.measureText(ds).width + 12;
    const bx = Math.max(0, Math.min(this.plotR - tw, x - tw / 2));
    ctx.fillStyle = "#2a3f5f";
    ctx.beginPath();
    ctx.roundRect(bx, this.h - TIME_H + 2, tw, TIME_H - 4, 3);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(ds, bx + 6, this.h - TIME_H / 2);
  }

  private emitHover() {
    const n = this.bars.length;
    let i = n - 1;
    const live = !!this.cross;
    if (this.cross) i = Math.max(0, Math.min(n - 1, Math.round(this.idx(this.cross.x))));
    const vals: Record<string, number[]> = {};
    for (const ind of this.inds) {
      const s = this.calc.get(ind.uid);
      if (s) vals[ind.uid] = s.map((a) => a[i] ?? NaN);
      else if (ind.kind === "wt_oi" || ind.kind === "wt_fund") {
        const own = ind.kind === "wt_oi" ? this.own.oi : this.own.fund;
        if (own && own.t.length) {
          const t = this.bars[i]?.t ?? 0;
          let k = own.t.length - 1;
          while (k > 0 && own.t[k]! > t + TF_MS[this.tf]) k--;
          vals[ind.uid] = [own.v[k] ?? NaN];
        }
      }
    }
    let liq: Hover["liq"];
    if (this.liqx?.length && this.inds.some((x) => x.kind === "wt_liqx" && !x.hidden)) {
      let L = 0;
      let S = 0;
      for (const [t, l, sh] of this.liqx) {
        if (Math.floor(this.tIdx(t * 1000) + 1e-6) === i) {
          L += l;
          S += sh;
        }
      }
      if (L || S) liq = { L, S };
    }
    let wh: Hover["wh"];
    if (this.whales?.length && this.inds.some((x) => x.kind === "wt_whale" && !x.hidden)) {
      let buy = 0;
      let sell = 0;
      for (const w of this.whales) {
        if (Math.floor(this.tIdx(w.t * 1000) + 1e-6) !== i) continue;
        if (w.buy) buy += w.usd;
        else sell += w.usd;
      }
      if (buy || sell) wh = { buy, sell };
    }
    let cmp: Hover["cmp"];
    let mainPct: number | undefined;
    if (this.pctMode) {
      const base = this.bars[this.baseI]?.c;
      const cur = this.bars[i]?.c;
      if (base && cur) mainPct = (cur / base - 1) * 100;
      if (this.cmp.length && base) {
        cmp = this.cmp.map((c) => {
          const v = this.cmpAt(c, i);
          return { label: c.label, color: c.color, pct: finite(v) ? (v / base - 1) * 100 : NaN };
        });
      }
    }
    this.ev.hover({ i, bar: this.bars[i] ?? null, prev: this.bars[i - 1] ?? null, vals, live, liq, wh, cmp, mainPct });
  }

  /* ── Жесты ──────────────────────────────────────────────────────────── */

  private pos(e: PointerEvent | WheelEvent) {
    const r = this.cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Точка рисунка под пальцем: время — по свече, цена — с магнитом. */
  private ptAt(x: number, y: number, snap = true): Pt {
    const main = this.panes[0]!;
    const fi = this.idx(x);
    const i = snap ? Math.round(fi) : fi;
    let p = this.yp(main, y);
    if (this.magnet && snap) {
      const b = this.bars[Math.round(fi)];
      if (b) {
        let best = p;
        let dist = Infinity;
        for (const v of [b.o, b.h, b.l, b.c]) {
          const dd = Math.abs(this.py(main, v) - y);
          if (dd < dist) {
            dist = dd;
            best = v;
          }
        }
        if (dist < 28) p = best;
      }
    }
    return { t: this.iTime(i), p };
  }

  private tol(e: PointerEvent) {
    return e.pointerType === "mouse" ? 6 : 14;
  }

  private hitAny(x: number, y: number, tol: number): { d: Drawing; handle: number } | null {
    if (this.hideDrawings) return null;
    const v = this.view();
    // Сверху — выбранный, потом последние нарисованные.
    const sel = this.drawings.filter((d) => d.id === this.sel);
    const rest = this.drawings.filter((d) => d.id !== this.sel).reverse();
    for (const d of [...sel, ...rest]) {
      const h = hitDrawing(d, v, x, y, tol, d.id === this.sel);
      if (h) return { d, handle: "handle" in h ? h.handle : -1 };
    }
    return null;
  }

  private onDown = (e: PointerEvent) => {
    const { x, y } = this.pos(e);
    this.mouse = e.pointerType === "mouse";
    try {
      this.cv.setPointerCapture(e.pointerId);
    } catch { /* старые webview */ }
    this.ptrs.set(e.pointerId, { x, y });
    cancelAnimationFrame(this.inertia);
    if (this.longTimer) clearTimeout(this.longTimer);

    if (this.ptrs.size === 2) {
      const [a, b] = [...this.ptrs.values()] as [{ x: number; y: number }, { x: number; y: number }];
      this.mode = "pinch";
      this.creating = this.creating && this.creating.d.type === "brush" ? null : this.creating;
      this.pinch = { d: Math.abs(a.x - b.x) || 1, cx: (a.x + b.x) / 2, spacing: this.spacing, anchor: this.idx((a.x + b.x) / 2) };
      return;
    }
    if (this.ptrs.size > 2) return;
    if (e.button === 2) return;

    const R = this.plotR;
    const bottom = this.h - TIME_H;
    this.down = { ...this.down, x, y, t: performance.now(), right: this.right, spacing: this.spacing, handle: -1, id: "", pts: [] };
    this.vel = 0;
    this.lastMove = { x, t: performance.now() };
    this.lastMoveY = y;

    // Кнопки A и L под шкалой цены.
    if (x > R && y > bottom) {
      const part = (x - R) / this.priceW;
      if (part < 0.35) this.resetScale();
      else if (part < 0.65) this.setLog(!this.log);
      else {
        this.setPct(!this.pct);
        this.ev.pct(this.pct);
      }
      this.ev.view(this.right >= this.bars.length - 1);
      this.mode = "";
      return;
    }
    // Граница панелей.
    for (let k = 1; k < this.panes.length; k++) {
      const p = this.panes[k]!;
      if (Math.abs(y - p.top) <= (this.mouse ? 4 : 9) && x < R) {
        this.mode = "sep";
        this.down.pane = k;
        this.down.lo = p.h;
        return;
      }
    }
    if (x > R) {
      const pi = this.paneAt(y);
      const p = this.panes[pi]!;
      // Двойной тап по шкале — снова авто.
      if (performance.now() - this.lastTap.t < 320 && Math.abs(this.lastTap.y - y) < 30 && this.lastTap.x > R) {
        p.scale.auto = true;
        this.lastTap.t = 0;
        this.invalidate();
        this.mode = "";
        return;
      }
      this.mode = "price";
      this.down.pane = pi;
      this.down.lo = p.scale.lo;
      this.down.hi = p.scale.hi;
      return;
    }
    if (y > bottom) {
      this.mode = "time";
      return;
    }
    const pi = this.paneAt(y);

    // Рисование.
    if (this.tool !== "cursor" && pi === 0) {
      this.drawDown(x, y);
      return;
    }
    if (this.creating) {
      this.drawDown(x, y);
      return;
    }
    // Рисунок под пальцем: ручка или тело.
    if (pi === 0) {
      const h = this.hitAny(x, y, this.tol(e));
      if (h) {
        this.select(h.d.id);
        this.dragBefore = this.drawings.map((d) => ({ ...d, pts: d.pts.map((q) => ({ ...q })) }));
        this.down.id = h.d.id;
        this.down.pts = h.d.pts.map((p) => ({ ...p }));
        this.down.handle = h.handle;
        this.mode = h.d.locked ? "pan" : h.handle >= 0 ? "handle" : "move";
        this.invalidate();
        return;
      }
      if (this.sel) this.select(null);
    }
    if (this.mouse) {
      this.mode = "pan";
      return;
    }
    // Палец: ждём — тап, сдвиг или долгое нажатие.
    this.mode = "pending";
    this.longTimer = setTimeout(() => {
      if (this.mode === "pending") {
        this.mode = "cross";
        this.cross = { x, y };
        this.crossSticky = true;
        try {
          navigator.vibrate?.(8);
        } catch { /* нет вибро */ }
        this.invalidate();
      }
    }, 380);
  };

  private drawDown(x: number, y: number) {
    const tool = this.creating?.d.type ?? (this.tool === "cursor" ? null : this.tool);
    if (!tool) return;
    const pt = this.ptAt(x, y, tool !== "brush");
    if (!this.creating) {
      const need = TOOL_POINTS[tool];
      const d: Drawing = { id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, type: tool, pts: [pt], color: tool === "long" || tool === "short" ? "#9aa7b8" : "#3a9bff" };
      if (tool === "long" || tool === "short") {
        const main = this.panes[0]!;
        const span = main.scale.hi - main.scale.lo;
        const t2 = this.iTime(this.idx(x) + Math.max(12, 120 / this.spacing));
        const up = tool === "long" ? 1 : -1;
        d.pts = [pt, { t: t2, p: pt.p + up * span * 0.12 }, { t: t2, p: pt.p - up * span * 0.06 }];
        this.commit(d);
        return;
      }
      if (need === 1) {
        if (tool === "text") d.text = "";
        this.commit(d);
        if (tool === "text") this.ev.textNew(d);
        return;
      }
      if (tool !== "brush") for (let k = 1; k < need; k++) d.pts.push({ ...pt });
      this.creating = { d, idx: 1, downs: 1 };
      this.mode = "create";
      this.invalidate();
      return;
    }
    const c = this.creating;
    c.downs++;
    for (let k = c.idx; k < c.d.pts.length; k++) c.d.pts[k] = { ...pt };
    this.mode = "create";
    this.invalidate();
  }

  private commit(d: Drawing) {
    this.snap();
    this.creating = null;
    this.drawings = [...this.drawings, d];
    this.ev.drawings(this.drawings);
    this.tool = "cursor";
    this.cv.style.cursor = "default";
    this.ev.toolDone();
    this.select(d.id);
    this.invalidate();
  }

  private onMove = (e: PointerEvent) => {
    const { x, y } = this.pos(e);
    const had = this.ptrs.get(e.pointerId);
    if (had) this.ptrs.set(e.pointerId, { x, y });

    if (this.mode === "pinch" && this.ptrs.size >= 2) {
      const [a, b] = [...this.ptrs.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const dist = Math.abs(a.x - b.x) || 1;
      const cx = (a.x + b.x) / 2;
      this.zoomTo(this.pinch.spacing * (dist / this.pinch.d), this.pinch.anchor, cx);
      return;
    }

    // Мышь без нажатия: перекрестие за курсором, превью рисунка.
    if (!had) {
      if (e.pointerType !== "mouse") return;
      const r = this.cv.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      this.cross = x < this.plotR && y < this.h - TIME_H ? { x, y } : null;
      if (this.creating && this.creating.d.type !== "brush") {
        const c = this.creating;
        const pt = this.ptAt(x, y);
        for (let k = c.idx; k < c.d.pts.length; k++) c.d.pts[k] = { ...pt };
      }
      if (this.tool === "cursor" && !this.creating) {
        const h = y < this.panes[0]!.h ? this.hitAny(x, y, 6) : null;
        this.cv.style.cursor = h ? (h.handle >= 0 ? "grab" : "pointer") : x > this.plotR ? "ns-resize" : y > this.h - TIME_H ? "ew-resize" : "default";
      }
      this.invalidate();
      return;
    }

    const dx = x - this.down.x;
    const dy = y - this.down.y;
    const now = performance.now();
    if (this.mode === "pending") {
      // Палец сдвинулся до долгого нажатия — это листание.
      if (Math.hypot(dx, dy) <= 7) return;
      if (this.longTimer) clearTimeout(this.longTimer);
      this.mode = "pan";
      if (!this.crossSticky) this.cross = null;
    }
    switch (this.mode) {
      case "pan": {
        const ddx = x - this.down.x;
        this.right = this.down.right - ddx / this.spacing;
        this.clampRight();
        const main = this.panes[0]!;
        if (!main.scale.auto && this.paneAt(this.down.y) === 0) {
          // Ручная шкала: двигаем и по вертикали.
          const k = (y - this.lastMoveY) / (main.h * 0.84);
          const s = main.scale;
          const lo = this.f(s.lo, s);
          const hi = this.f(s.hi, s);
          const sh = (hi - lo) * k;
          s.lo = this.fi(lo + sh, s);
          s.hi = this.fi(hi + sh, s);
        }
        const dt = now - this.lastMove.t;
        if (dt > 0) this.vel = 0.8 * ((x - this.lastMove.x) / dt) + 0.2 * this.vel;
        this.lastMove = { x, t: now };
        if (this.mouse) this.cross = { x, y };
        this.ev.view(this.right >= this.bars.length - 1);
        this.invalidate();
        break;
      }
      case "cross":
        this.cross = { x: Math.min(x, this.plotR - 1), y: Math.min(y, this.h - TIME_H - 1) };
        this.invalidate();
        break;
      case "price": {
        const p = this.panes[this.down.pane]!;
        const s = p.scale;
        s.auto = false;
        const k = Math.exp(dy * 0.006);
        const lo = this.f(this.down.lo, s);
        const hi = this.f(this.down.hi, s);
        const mid = (lo + hi) / 2;
        const half = ((hi - lo) / 2) * k;
        s.lo = this.fi(mid - half, s);
        s.hi = this.fi(mid + half, s);
        this.invalidate();
        break;
      }
      case "time": {
        const k = Math.exp(dx * 0.006);
        const anchor = this.idx(this.plotR);
        this.zoomTo(this.down.spacing * k, anchor, this.plotR);
        break;
      }
      case "sep": {
        const p = this.panes[this.down.pane]!;
        const total = this.h - TIME_H;
        const nh = Math.max(40, Math.min(total * 0.6, this.down.lo - dy));
        p.frac = nh / total;
        this.invalidate();
        break;
      }
      case "create": {
        const c = this.creating;
        if (!c) break;
        if (c.d.type === "brush") {
          const last = c.d.pts[c.d.pts.length - 1];
          const pt = this.ptAt(x, y, false);
          if (!last || Math.abs(this.tx(last.t) - x) + Math.abs(this.py(this.panes[0]!, last.p) - y) > 3) c.d.pts.push(pt);
        } else {
          const pt = this.ptAt(x, y);
          for (let k = c.idx; k < c.d.pts.length; k++) c.d.pts[k] = { ...pt };
        }
        this.loupe = this.mouse ? null : { x, y };
        this.invalidate();
        break;
      }
      case "handle":
      case "move": {
        const d = this.drawings.find((q) => q.id === this.down.id);
        if (!d) break;
        const main = this.panes[0]!;
        const pt = this.ptAt(x, y);
        let pts = this.down.pts.map((p) => ({ ...p }));
        if (this.mode === "move") {
          const i0 = this.idx(this.down.x);
          const di = Math.round(this.idx(x) - i0);
          const dp = this.yp(main, y) - this.yp(main, this.down.y);
          pts = pts.map((p) => ({ t: this.iTime(this.tIdx(p.t) + di), p: p.p + dp }));
        } else {
          const k = this.down.handle;
          if (d.type === "long" || d.type === "short") {
            if (k === 0) pts[0] = { t: pt.t, p: pt.p };
            else {
              pts[k] = { t: pt.t, p: pt.p };
              const other = k === 1 ? 2 : 1;
              pts[other] = { ...pts[other]!, t: pt.t };
            }
          } else if (d.type === "hline") pts[0] = { ...pts[0]!, p: pt.p };
          else if (d.type === "vline") pts[0] = { ...pts[0]!, t: pt.t };
          else pts[k] = pt;
        }
        this.drawings = this.drawings.map((q) => (q.id === d.id ? { ...q, pts } : q));
        this.loupe = this.mouse || this.mode === "move" ? null : { x, y };
        this.invalidate();
        break;
      }
    }
    this.lastMoveY = y;
  };

  private lastMoveY = 0;
  private dragBefore: Drawing[] | null = null;

  private onUp = (e: PointerEvent) => {
    if (!this.ptrs.has(e.pointerId)) return;
    this.ptrs.delete(e.pointerId);
    if (this.loupe) {
      this.loupe = null;
      this.invalidate();
    }
    if (this.longTimer) clearTimeout(this.longTimer);
    const { x, y } = this.pos(e);
    if (this.mode === "pinch") {
      if (this.ptrs.size === 0) this.mode = "";
      else {
        // Остался один палец — продолжаем листать от него.
        const rest = [...this.ptrs.values()][0]!;
        this.mode = "pan";
        this.down = { ...this.down, x: rest.x, y: rest.y, right: this.right };
      }
      return;
    }
    const moved = Math.hypot(x - this.down.x, y - this.down.y);
    switch (this.mode) {
      case "pending": {
        // Тап: двойной — к последней свече, одиночный — перекрестие.
        const now = performance.now();
        if (now - this.lastTap.t < 320 && Math.hypot(this.lastTap.x - x, this.lastTap.y - y) < 30) {
          this.cross = null;
          this.crossSticky = false;
          this.goLatest();
          this.lastTap.t = 0;
        } else {
          this.lastTap = { t: now, x, y };
          if (this.cross) {
            this.cross = null;
            this.crossSticky = false;
          } else {
            this.cross = { x, y };
            this.crossSticky = true;
          }
        }
        this.invalidate();
        break;
      }
      case "pan":
        if (this.mouse && moved < 3) {
          const now = performance.now();
          if (now - this.lastTap.t < 320) this.goLatest();
          this.lastTap = { t: now, x, y };
        } else if (Math.abs(this.vel) > 0.25) this.glide();
        break;
      case "price":
        this.lastTap = { t: performance.now(), x, y };
        break;
      case "create": {
        const c = this.creating;
        if (!c) break;
        if (c.d.type === "brush") {
          if (c.d.pts.length > 1) this.commit(c.d);
          else this.creating = null;
          break;
        }
        const need = TOOL_POINTS[c.d.type];
        // Первая точка: потянул — вторая встала, где отпустил; тапнул — ждём второй тап.
        if (c.downs === 1 && moved < 8) break;
        c.idx++;
        if (c.idx >= need) this.commit(c.d);
        else this.invalidate();
        break;
      }
      case "handle":
      case "move":
        if (moved > 2) {
          if (this.dragBefore) {
            this.past.push(this.dragBefore);
            this.future = [];
            this.ev.history(true, false);
          }
          this.ev.drawings(this.drawings);
        }
        this.dragBefore = null;
        {
          const d = this.drawings.find((q) => q.id === this.down.id);
          if (d) this.ev.select(d);
        }
        break;
    }
    if (this.mode !== "create" || !this.creating) this.mode = "";
  };

  private onLeave = () => {
    if (this.mouse && !this.ptrs.size) {
      this.cross = null;
      this.invalidate();
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const { x } = this.pos(e);
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this.right += e.deltaX / this.spacing;
      this.clampRight();
      this.invalidate();
      return;
    }
    const k = Math.exp(-e.deltaY * 0.0015);
    this.zoomTo(this.spacing * k, this.idx(x), x);
  };

  private zoomTo(spacing: number, anchor: number, ax: number) {
    this.spacing = Math.max(MIN_SPACING, Math.min(MAX_SPACING, spacing));
    this.right = anchor + (this.plotR - ax) / this.spacing - 0.5;
    this.clampRight();
    this.invalidate();
  }

  private clampRight() {
    const n = this.bars.length;
    const vis = this.plotR / this.spacing;
    this.right = Math.max(Math.min(8, vis * 0.3), Math.min(n - 1 + vis * 0.75, this.right));
  }

  private glide() {
    let v = this.vel;
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      this.right -= (v * dt) / this.spacing;
      this.clampRight();
      v *= Math.pow(0.994, dt);
      this.invalidate();
      this.ev.view(this.right >= this.bars.length - 1);
      if (Math.abs(v) > 0.02) this.inertia = requestAnimationFrame(step);
    };
    this.inertia = requestAnimationFrame(step);
  }
}

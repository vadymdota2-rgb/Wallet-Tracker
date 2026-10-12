/**
 * Рисунки на графике: линии, лучи, уровни, каналы, весь набор Фибоначчи,
 * волны Эллиотта, позиции лонг/шорт, линейка, текст и кисть.
 *
 * Точки хранятся во времени и цене (t — мс, p — цена), а не в пикселях и не
 * в номерах свечей: рисунок остаётся на месте при смене таймфрейма, масштаба
 * и подгрузке истории — так же, как в TradingView.
 *
 * Чего у других нет:
 *   • у Фибоначчи уровни выбираются по одному, а «золотой карман» 0.618–0.65
 *     подсвечен сразу — по нему в крипте и торгуют;
 *   • волны Эллиотта размечаются сами (1–5, A–C, A–E, W–X–Y), на каждой
 *     волне — её пропорция к соседней, а импульс проверяется по трём
 *     правилам Эллиотта: нарушено — видно сразу, а не после убытка.
 */

export type DrawType =
  | "trend" | "ray" | "ext" | "hline" | "hray" | "vline" | "rect" | "channel"
  | "fib" | "fibext" | "fibfan" | "fibtime"
  | "ew5" | "abc" | "tri" | "wxy"
  | "long" | "short" | "measure" | "text" | "brush";

export interface Pt {
  t: number;
  p: number;
}

export interface Drawing {
  id: string;
  type: DrawType;
  pts: Pt[];
  color: string;
  text?: string;
  locked?: boolean;
  /** Фибоначчи: какие уровни показывать (иначе — по умолчанию). */
  levels?: number[];
  /** Фибоначчи: продлить уровни вправо до края. */
  extend?: boolean;
}

/** Сколько точек ставит человек: позиции и текст — одной, кисть — сколько нарисует. */
export const TOOL_POINTS: Record<DrawType, number> = {
  trend: 2, ray: 2, ext: 2, hline: 1, hray: 1, vline: 1, rect: 2, channel: 3,
  fib: 2, fibext: 3, fibfan: 2, fibtime: 2,
  ew5: 6, abc: 4, tri: 6, wxy: 4,
  long: 1, short: 1, measure: 2, text: 1, brush: 0,
};

export const DRAW_COLORS = ["#3a9bff", "#f0b90b", "#3ddc97", "#ff5c77", "#c38bff", "#eaf5ff"];

/** Все уровни, из которых выбирают: коррекции, золотой карман, расширения и цели вниз. */
export const FIB_ALL = [-0.618, -0.272, 0, 0.236, 0.382, 0.5, 0.618, 0.65, 0.705, 0.786, 0.886, 1, 1.272, 1.414, 1.618, 2, 2.272, 2.618, 3.618, 4.236];
export const FIB_DEF = [0, 0.236, 0.382, 0.5, 0.618, 0.65, 0.786, 1, 1.618, 2.618];
export const FIBEXT_DEF = [0, 0.382, 0.618, 1, 1.272, 1.618, 2, 2.618];
const FAN = [0, 0.382, 0.5, 0.618, 0.786];
const FIB_TIME = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

export const isFib = (t: DrawType) => t === "fib" || t === "fibext";

function fibColor(lv: number): string {
  if (lv === 0.618 || lv === 0.65) return "#f0b90b";
  if (lv === 0.5) return "#3ddc97";
  if (lv === 0.382 || lv === 0.705) return "#ff9f43";
  if (lv === 0.236) return "#ff5c77";
  if (lv === 0.786 || lv === 0.886) return "#7fd8ff";
  if (lv === 0 || lv === 1) return "#9aa7b8";
  if (lv < 0) return "#e86df5";
  return "#c38bff";
}

/** Как переводить время и цену в пиксели главной панели. */
export interface View {
  x(t: number): number;
  y(p: number): number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  fmt(p: number): string;
  /** Число свечей между двумя моментами — для «N свечей» на линейке. */
  bars(t0: number, t1: number): number;
  font: string;
  /** Подписи на языке человека: правила Эллиотта и т. п. */
  tr(key: string): string;
}

const UP = "#3ddc97";
const DN = "#ff5c77";

function alpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Продолжение прямой через две точки до краёв области. */
function extend(x0: number, y0: number, x1: number, y1: number, v: View, both: boolean): [number, number, number, number] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (Math.abs(dx) < 1e-9) return [x0, both ? v.top : y0, x0, dy >= 0 ? v.bottom : v.top];
  const k = dy / dx;
  const toRight = dx > 0;
  const xe = toRight ? v.right : v.left;
  const ye = y0 + k * (xe - x0);
  if (!both) return [x0, y0, xe, ye];
  const xs = toRight ? v.left : v.right;
  return [xs, y0 + k * (xs - x0), xe, ye];
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, v: View, align: CanvasTextAlign = "left") {
  ctx.font = v.font;
  const w = ctx.measureText(text).width + 10;
  const h = 18;
  let bx = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
  // Прижимаем к краю, только пока сам рисунок на экране: уехал — уезжает и подпись.
  if (x >= v.left && x <= v.right) bx = Math.max(v.left + 2, Math.min(v.right - w - 2, bx));
  ctx.fillStyle = "rgba(5,11,22,0.85)";
  ctx.fillRect(bx, y - h / 2, w, h);
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, bx + 5, y + 0.5);
}

/** Текст с тёмной обводкой — читается поверх свечей. */
function halo(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, font: string, align: CanvasTextAlign = "center") {
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(5,11,22,0.9)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

const pct = (a: number, b: number) => (a ? ((b - a) / a) * 100 : 0);
const sgn = (v: number) => (v > 0 ? "+" : "");
const lvTxt = (lv: number) => String(+lv.toFixed(3));

function fmtSpan(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60 ? `${m % 60}m` : ""}`.trim();
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24 ? `${h % 24}h` : ""}`.trim();
}

/* ── Волны Эллиотта ────────────────────────────────────────────────────── */

const EW_LABELS: Partial<Record<DrawType, string[]>> = {
  ew5: ["", "1", "2", "3", "4", "5"],
  abc: ["", "A", "B", "C"],
  tri: ["", "A", "B", "C", "D", "E"],
  wxy: ["", "W", "X", "Y"],
};

export const isWave = (t: DrawType) => t in EW_LABELS;

/**
 * Три правила импульса Эллиотта: волна 2 не уходит за начало волны 1,
 * волна 3 не самая короткая из 1, 3, 5, волна 4 не заходит на территорию
 * волны 1. Пустой список — правила соблюдены.
 */
export function elliottBroken(pts: Pt[]): string[] {
  if (pts.length < 6) return [];
  const p = pts.map((q) => q.p);
  const up = p[1]! > p[0]!;
  const len = (a: number, b: number) => Math.abs(p[b]! - p[a]!);
  const bad: string[] = [];
  if (up ? p[2]! <= p[0]! : p[2]! >= p[0]!) bad.push("chart_ew_r2");
  if (len(2, 3) < len(0, 1) && len(2, 3) < len(4, 5)) bad.push("chart_ew_r3");
  if (up ? p[4]! <= p[1]! : p[4]! >= p[1]!) bad.push("chart_ew_r4");
  return bad;
}

/** Пропорция у точки k: откат (в %) или удлинение (×) относительно прошлой волны. */
function waveRatio(type: DrawType, pts: Pt[], k: number): string {
  const L = (a: number, b: number) => Math.abs((pts[b]?.p ?? 0) - (pts[a]?.p ?? 0));
  const r = (a: number, b: number) => (b ? a / b : 0);
  if (type === "ew5") {
    if (k === 2) return `${(r(L(1, 2), L(0, 1)) * 100).toFixed(1)}%`;
    if (k === 3) return `×${r(L(2, 3), L(0, 1)).toFixed(2)}`;
    if (k === 4) return `${(r(L(3, 4), L(2, 3)) * 100).toFixed(1)}%`;
    if (k === 5) return `×${r(L(4, 5), L(0, 1)).toFixed(2)}`;
  }
  if (type === "abc" || type === "wxy") {
    if (k === 2) return `${(r(L(1, 2), L(0, 1)) * 100).toFixed(1)}%`;
    if (k === 3) return `×${r(L(2, 3), L(0, 1)).toFixed(2)}`;
  }
  return "";
}

/* ── Геометрия ─────────────────────────────────────────────────────────── */

/** Экранные точки рисунка — для ручек и попадания пальцем. */
export function handles(d: Drawing, v: View): [number, number][] {
  if (d.type === "brush") return [];
  if (d.type === "long" || d.type === "short") {
    const [e, a, b] = d.pts;
    if (!e || !a || !b) return [];
    return [[v.x(e.t), v.y(e.p)], [v.x(a.t), v.y(a.p)], [v.x(b.t), v.y(b.p)]];
  }
  if (d.type === "hline") {
    const p = d.pts[0];
    return p ? [[(v.left + v.right) / 2, v.y(p.p)]] : [];
  }
  if (d.type === "vline") {
    const p = d.pts[0];
    return p ? [[v.x(p.t), (v.top + v.bottom) / 2]] : [];
  }
  return d.pts.map((p) => [v.x(p.t), v.y(p.p)]);
}

function segDist(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const l = dx * dx + dy * dy;
  let k = l ? ((px - x0) * dx + (py - y0) * dy) / l : 0;
  k = Math.max(0, Math.min(1, k));
  return Math.hypot(px - (x0 + k * dx), py - (y0 + k * dy));
}

type Seg = [number, number, number, number];

/** Уровни Фибоначчи: [уровень, y, x0, x1]. */
function fibLines(d: Drawing, v: View): [number, number, number, number][] {
  const P = d.pts.map((p) => [v.x(p.t), v.y(p.p)] as [number, number]);
  const [a, b, c] = P;
  const out: [number, number, number, number][] = [];
  if (d.type === "fib" && a && b) {
    const x0 = Math.min(a[0], b[0]);
    const x1 = d.extend ? v.right : Math.max(a[0], b[0]);
    for (const lv of d.levels ?? FIB_DEF) out.push([lv, v.y(d.pts[1]!.p + (d.pts[0]!.p - d.pts[1]!.p) * lv), x0, x1]);
  }
  if (d.type === "fibext" && a && b && c) {
    const span = Math.max(Math.abs(b[0] - a[0]), 40);
    const x1 = d.extend ? v.right : c[0] + span;
    const move = d.pts[1]!.p - d.pts[0]!.p;
    for (const lv of d.levels ?? FIBEXT_DEF) out.push([lv, v.y(d.pts[2]!.p + move * lv), c[0], x1]);
  }
  return out;
}

/** Отрезки, по которым рисунок ловится пальцем, и прямоугольные области. */
function shape(d: Drawing, v: View): { segs: Seg[]; boxes: Seg[] } {
  const segs: Seg[] = [];
  const boxes: Seg[] = [];
  const P = d.pts.map((p) => [v.x(p.t), v.y(p.p)] as [number, number]);
  const [a, b, c] = P;
  switch (d.type) {
    case "trend":
      if (a && b) segs.push([a[0], a[1], b[0], b[1]]);
      break;
    case "ray":
      if (a && b) segs.push(extend(a[0], a[1], b[0], b[1], v, false));
      break;
    case "ext":
      if (a && b) segs.push(extend(a[0], a[1], b[0], b[1], v, true));
      break;
    case "hline":
      if (a) segs.push([v.left, a[1], v.right, a[1]]);
      break;
    case "hray":
      if (a) segs.push([a[0], a[1], v.right, a[1]]);
      break;
    case "vline":
      if (a) segs.push([a[0], v.top, a[0], v.bottom]);
      break;
    case "rect":
    case "measure":
      if (a && b) boxes.push([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
      break;
    case "channel":
      if (a && b) {
        segs.push([a[0], a[1], b[0], b[1]]);
        if (c) {
          const off = chanOffset(a, b, c);
          segs.push([a[0], a[1] + off, b[0], b[1] + off]);
        }
      }
      break;
    case "fib":
    case "fibext":
      for (const [, y, x0, x1] of fibLines(d, v)) segs.push([x0, y, x1, y]);
      if (d.type === "fibext") for (let i = 1; i < P.length; i++) segs.push([P[i - 1]![0], P[i - 1]![1], P[i]![0], P[i]![1]]);
      break;
    case "fibfan":
      if (a && b) for (const lv of FAN) segs.push(extend(a[0], a[1], b[0], b[1] + (a[1] - b[1]) * lv, v, false));
      break;
    case "fibtime":
      if (a && b) for (const k of FIB_TIME) {
        const x = v.x(d.pts[0]!.t + (d.pts[1]!.t - d.pts[0]!.t) * k);
        segs.push([x, v.top, x, v.bottom]);
      }
      break;
    case "ew5":
    case "abc":
    case "tri":
    case "wxy":
    case "brush":
      for (let i = 1; i < P.length; i++) segs.push([P[i - 1]![0], P[i - 1]![1], P[i]![0], P[i]![1]]);
      if (d.type === "tri" && P.length === 6) {
        // Стороны треугольника — по A-C-E и B-D.
        segs.push([P[1]![0], P[1]![1], P[5]![0], P[5]![1]]);
      }
      break;
    case "long":
    case "short":
      if (a && b && c) boxes.push([Math.min(a[0], b[0]), Math.min(a[1], b[1], c[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1], c[1])]);
      break;
    case "text":
      if (a) boxes.push([a[0] - 4, a[1] - 14, a[0] + Math.max(40, (d.text ?? "").length * 8), a[1] + 6]);
      break;
  }
  return { segs, boxes };
}

/** Смещение второй линии канала по вертикали: третья точка задаёт ширину. */
function chanOffset(a: [number, number], b: [number, number], c: [number, number]): number {
  const dx = b[0] - a[0];
  const yAt = Math.abs(dx) < 1e-9 ? a[1] : a[1] + ((b[1] - a[1]) * (c[0] - a[0])) / dx;
  return c[1] - yAt;
}

/** Куда попал палец: ручка (номер точки), тело рисунка или мимо. */
export function hit(d: Drawing, v: View, x: number, y: number, tol: number, selected: boolean): { handle: number } | { body: true } | null {
  if (selected) {
    const hs = handles(d, v);
    for (let i = 0; i < hs.length; i++) {
      const h = hs[i]!;
      if (Math.hypot(h[0] - x, h[1] - y) <= tol + 2) return { handle: i };
    }
  }
  const { segs, boxes } = shape(d, v);
  for (const s of segs) if (segDist(x, y, s[0], s[1], s[2], s[3]) <= tol) return { body: true };
  for (const b of boxes) if (x >= b[0] - tol && x <= b[2] + tol && y >= b[1] - tol && y <= b[3] + tol) return { body: true };
  return null;
}

/* ── Рисование ─────────────────────────────────────────────────────────── */

/** Нарисовать рисунок. */
export function render(ctx: CanvasRenderingContext2D, d: Drawing, v: View, selected: boolean) {
  const P = d.pts.map((p) => [v.x(p.t), v.y(p.p)] as [number, number]);
  const [a, b, c] = P;
  const col = d.color;
  const bold = `600 ${v.font.replace(/^\d+px/, "12px")}`;
  ctx.save();
  ctx.lineWidth = selected ? 2 : 1.5;
  ctx.strokeStyle = col;
  ctx.setLineDash([]);
  const line = (s: Seg) => {
    ctx.beginPath();
    ctx.moveTo(s[0], s[1]);
    ctx.lineTo(s[2], s[3]);
    ctx.stroke();
  };

  switch (d.type) {
    case "trend":
    case "ray":
    case "ext":
    case "hline":
    case "hray":
    case "vline":
    case "brush":
      for (const s of shape(d, v).segs) line(s);
      if ((d.type === "trend" || d.type === "ray") && a && b && selected) {
        const ch = pct(d.pts[0]!.p, d.pts[1]!.p);
        label(ctx, `${sgn(ch)}${ch.toFixed(2)}%`, b[0] + 8, b[1], col, v);
      }
      if ((d.type === "hline" || d.type === "hray") && a) label(ctx, v.fmt(d.pts[0]!.p), v.right - 4, a[1] - 11, col, v, "right");
      break;
    case "rect":
      if (a && b) {
        ctx.fillStyle = alpha(col, 0.12);
        ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      }
      break;
    case "channel":
      if (a && b) {
        line([a[0], a[1], b[0], b[1]]);
        if (c) {
          const off = chanOffset(a, b, c);
          line([a[0], a[1] + off, b[0], b[1] + off]);
          ctx.fillStyle = alpha(col, 0.1);
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.lineTo(b[0], b[1] + off);
          ctx.lineTo(a[0], a[1] + off);
          ctx.closePath();
          ctx.fill();
          ctx.setLineDash([4, 4]);
          line([a[0], a[1] + off / 2, b[0], b[1] + off / 2]);
          ctx.setLineDash([]);
        }
      }
      break;
    case "fib":
    case "fibext": {
      const lines = fibLines(d, v).sort((p, q) => p[0] - q[0]);
      // Заливка между соседними уровнями; золотой карман 0.618–0.65 — ярче.
      for (let i = 1; i < lines.length; i++) {
        const [l0, y0, x0, x1] = lines[i - 1]!;
        const [l1, y1] = lines[i]!;
        const gold = l0 === 0.618 && l1 === 0.65;
        ctx.fillStyle = gold ? "rgba(240,185,11,0.28)" : alpha(fibColor(l1), 0.06);
        ctx.fillRect(x0, Math.min(y0, y1), x1 - x0, Math.abs(y1 - y0));
      }
      for (const [lv, y, x0, x1] of lines) {
        const color = fibColor(lv);
        ctx.strokeStyle = color;
        ctx.lineWidth = lv === 0.618 || lv === 0.65 ? 1.6 : 1;
        line([x0, y, x1, y]);
        const price = d.type === "fib"
          ? d.pts[1]!.p + (d.pts[0]!.p - d.pts[1]!.p) * lv
          : d.pts[2]!.p + (d.pts[1]!.p - d.pts[0]!.p) * lv;
        ctx.font = v.font;
        ctx.fillStyle = color;
        ctx.textBaseline = "bottom";
        const left = x0 - 4 > v.left + 90;
        ctx.textAlign = left ? "right" : "left";
        ctx.fillText(`${lvTxt(lv)} (${v.fmt(price)})`, left ? x0 - 4 : x0 + 4, y - 1);
      }
      ctx.strokeStyle = alpha(col, 0.6);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (let i = 1; i < P.length; i++) line([P[i - 1]![0], P[i - 1]![1], P[i]![0], P[i]![1]]);
      ctx.setLineDash([]);
      break;
    }
    case "fibfan":
      if (a && b) {
        FAN.forEach((lv) => {
          ctx.strokeStyle = fibColor(lv === 0 ? 1 : lv);
          const s = extend(a[0], a[1], b[0], b[1] + (a[1] - b[1]) * lv, v, false);
          line(s);
          halo(ctx, lvTxt(lv), b[0] + 4, b[1] + (a[1] - b[1]) * lv, fibColor(lv === 0 ? 1 : lv), v.font, "left");
        });
      }
      break;
    case "fibtime":
      if (a && b) {
        for (const k of FIB_TIME) {
          const x = v.x(d.pts[0]!.t + (d.pts[1]!.t - d.pts[0]!.t) * k);
          if (x < v.left - 2 || x > v.right + 2) continue;
          ctx.strokeStyle = k === 0 || k === 1 ? alpha(col, 0.9) : alpha(col, 0.55);
          line([x, v.top, x, v.bottom]);
          halo(ctx, String(k), x + 3, v.bottom - 10, col, v.font, "left");
        }
      }
      break;
    case "ew5":
    case "abc":
    case "tri":
    case "wxy": {
      ctx.strokeStyle = col;
      ctx.lineWidth = selected ? 2 : 1.6;
      ctx.beginPath();
      P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      if (d.type === "tri" && P.length === 6) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = alpha(col, 0.6);
        line([P[1]![0], P[1]![1], P[5]![0], P[5]![1]]);
        line([P[2]![0], P[2]![1], P[4]![0], P[4]![1]]);
        ctx.setLineDash([]);
      }
      const names = EW_LABELS[d.type] ?? [];
      P.forEach(([x, y], k) => {
        const name = names[k];
        if (!name) return;
        const prev = d.pts[k - 1]?.p ?? d.pts[k]!.p;
        const next = d.pts[k + 1]?.p ?? prev;
        const top = d.pts[k]!.p >= prev && d.pts[k]!.p >= next;
        const ly = top ? y - 14 : y + 14;
        halo(ctx, `(${name})`, x, ly, col, bold);
        const ratio = waveRatio(d.type, d.pts, k);
        if (ratio) halo(ctx, ratio, x, top ? ly - 15 : ly + 15, "#9aa7b8", v.font);
      });
      // Правила импульса: ✓ — соблюдены, ⚠ — какое нарушено.
      if (d.type === "ew5" && P.length === 6) {
        const bad = elliottBroken(d.pts);
        const end = P[5]!;
        const color = bad.length ? "#ff9f43" : UP;
        if (selected) {
          const rows = bad.length ? bad.map((k) => `⚠ ${v.tr(k)}`) : [`✓ ${v.tr("chart_ew_ok")}`];
          rows.forEach((r, i) => label(ctx, r, end[0] + 12, end[1] + i * 20, color, v));
        } else halo(ctx, bad.length ? "⚠" : "✓", end[0] + 16, end[1], color, bold);
      }
      break;
    }
    case "long":
    case "short":
      if (a && b && c) {
        const x0 = Math.min(a[0], b[0]);
        const x1 = Math.max(a[0], b[0]);
        const w = Math.max(x1 - x0, 1);
        ctx.fillStyle = alpha(UP, 0.16);
        ctx.fillRect(x0, Math.min(a[1], b[1]), w, Math.abs(b[1] - a[1]));
        ctx.fillStyle = alpha(DN, 0.16);
        ctx.fillRect(x0, Math.min(a[1], c[1]), w, Math.abs(c[1] - a[1]));
        ctx.strokeStyle = "#9aa7b8";
        line([x0, a[1], x1, a[1]]);
        const e = d.pts[0]!.p;
        const tp = d.pts[1]!.p;
        const sl = d.pts[2]!.p;
        const reward = Math.abs(tp - e);
        const risk = Math.abs(e - sl);
        const rr = risk ? reward / risk : 0;
        const cx = (x0 + x1) / 2;
        label(ctx, `${v.fmt(tp)}  ${sgn(pct(e, tp))}${pct(e, tp).toFixed(2)}%`, cx, b[1] + (b[1] < a[1] ? -11 : 11), UP, v, "center");
        label(ctx, `${v.fmt(sl)}  ${sgn(pct(e, sl))}${pct(e, sl).toFixed(2)}%`, cx, c[1] + (c[1] > a[1] ? 11 : -11), DN, v, "center");
        label(ctx, `${d.type === "long" ? "LONG" : "SHORT"} ${v.fmt(e)} · R/R ${rr.toFixed(2)}`, cx, a[1], "#eaf5ff", v, "center");
      }
      break;
    case "measure":
      if (a && b) {
        const p0 = d.pts[0]!.p;
        const p1 = d.pts[1]!.p;
        const up = p1 >= p0;
        const color = up ? "#3a9bff" : DN;
        ctx.fillStyle = alpha(color, 0.14);
        ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        ctx.strokeStyle = color;
        line([(a[0] + b[0]) / 2, a[1], (a[0] + b[0]) / 2, b[1]]);
        line([a[0], (a[1] + b[1]) / 2, b[0], (a[1] + b[1]) / 2]);
        const n = v.bars(d.pts[0]!.t, d.pts[1]!.t);
        const ch = pct(p0, p1);
        const txt = `${sgn(p1 - p0)}${v.fmt(p1 - p0)} (${sgn(ch)}${ch.toFixed(2)}%) · ${n} bars · ${fmtSpan(d.pts[1]!.t - d.pts[0]!.t)}`;
        label(ctx, txt, (a[0] + b[0]) / 2, up ? Math.min(a[1], b[1]) - 12 : Math.max(a[1], b[1]) + 12, "#eaf5ff", v, "center");
      }
      break;
    case "text":
      if (a) {
        ctx.font = `600 ${v.font.replace(/^\d+px/, "14px")}`;
        ctx.fillStyle = col;
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(d.text || "Text", a[0], a[1]);
      }
      break;
  }

  if (selected) {
    for (const h of handles(d, v)) {
      ctx.beginPath();
      ctx.arc(h[0], h[1], 5, 0, Math.PI * 2);
      ctx.fillStyle = "#050b16";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = col;
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Подписи рисунка на осях: цена уровня справа, время вертикали снизу. */
export function axisMarks(d: Drawing): { p?: number; t?: number }[] {
  switch (d.type) {
    case "hline":
    case "hray":
      return d.pts[0] ? [{ p: d.pts[0].p }] : [];
    case "vline":
      return d.pts[0] ? [{ t: d.pts[0].t }] : [];
    case "long":
    case "short":
      return d.pts.map((p) => ({ p: p.p }));
    default:
      return [];
  }
}

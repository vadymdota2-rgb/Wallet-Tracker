/**
 * Рисунки на графике: линии, лучи, уровни, каналы, Фибоначчи, позиции
 * лонг/шорт, линейка, текст и кисть.
 *
 * Точки хранятся во времени и цене (t — мс, p — цена), а не в пикселях и не
 * в номерах свечей: рисунок остаётся на месте при смене таймфрейма, масштаба
 * и подгрузке истории — так же, как в TradingView.
 */

export type DrawType =
  | "trend" | "ray" | "ext" | "hline" | "hray" | "vline" | "rect" | "channel"
  | "fib" | "long" | "short" | "measure" | "text" | "brush";

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
}

/** Сколько точек ставит человек: позиции и текст — одной, кисть — сколько нарисует. */
export const TOOL_POINTS: Record<DrawType, number> = {
  trend: 2, ray: 2, ext: 2, hline: 1, hray: 1, vline: 1, rect: 2, channel: 3,
  fib: 2, long: 1, short: 1, measure: 2, text: 1, brush: 0,
};

export const DRAW_COLORS = ["#3a9bff", "#f0b90b", "#3ddc97", "#ff5c77", "#c38bff", "#eaf5ff"];

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618];
const FIB_COLORS = ["#9aa7b8", "#ff5c77", "#ff9f43", "#3ddc97", "#3a9bff", "#7fd8ff", "#9aa7b8", "#c38bff", "#e86df5"];

/** Как переводить время и цену в пиксели главной панели. */
export interface View {
  x(t: number): number;
  y(p: number): number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  fmt(p: number): string;
  /** Номер свечи по времени — для «N свечей» на линейке. */
  bars(t0: number, t1: number): number;
  font: string;
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

const pct = (a: number, b: number) => (a ? ((b - a) / a) * 100 : 0);
const sgn = (v: number) => (v > 0 ? "+" : "");

function fmtSpan(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60 ? `${m % 60}m` : ""}`.trim();
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24 ? `${h % 24}h` : ""}`.trim();
}

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

/** Отрезки, по которым рисунок ловится пальцем, и прямоугольные области. */
function shape(d: Drawing, v: View): { segs: [number, number, number, number][]; boxes: [number, number, number, number][] } {
  const segs: [number, number, number, number][] = [];
  const boxes: [number, number, number, number][] = [];
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
      if (a && b) {
        for (const lv of FIB_LEVELS) {
          const y = b[1] + (a[1] - b[1]) * lv;
          segs.push([Math.min(a[0], b[0]), y, Math.max(a[0], b[0]), y]);
        }
      }
      break;
    case "long":
    case "short":
      if (a && b && c) boxes.push([Math.min(a[0], b[0]), Math.min(a[1], b[1], c[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1], c[1])]);
      break;
    case "text":
      if (a) boxes.push([a[0] - 4, a[1] - 14, a[0] + Math.max(40, (d.text ?? "").length * 8), a[1] + 6]);
      break;
    case "brush":
      for (let i = 1; i < P.length; i++) segs.push([P[i - 1]![0], P[i - 1]![1], P[i]![0], P[i]![1]]);
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

/** Нарисовать рисунок. */
export function render(ctx: CanvasRenderingContext2D, d: Drawing, v: View, selected: boolean) {
  const P = d.pts.map((p) => [v.x(p.t), v.y(p.p)] as [number, number]);
  const [a, b, c] = P;
  const col = d.color;
  ctx.save();
  ctx.lineWidth = selected ? 2 : 1.5;
  ctx.strokeStyle = col;
  ctx.setLineDash([]);
  const line = (s: [number, number, number, number]) => {
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
      if (a && b) {
        const x0 = Math.min(a[0], b[0]);
        const x1 = Math.max(a[0], b[0]);
        const p0 = d.pts[0]!.p;
        const p1 = d.pts[1]!.p;
        let prevY = NaN;
        FIB_LEVELS.forEach((lv, i) => {
          const y = b[1] + (a[1] - b[1]) * lv;
          const color = FIB_COLORS[i] ?? col;
          if (!Number.isNaN(prevY)) {
            ctx.fillStyle = alpha(color, 0.07);
            ctx.fillRect(x0, Math.min(prevY, y), x1 - x0, Math.abs(y - prevY));
          }
          prevY = y;
          ctx.strokeStyle = color;
          line([x0, y, x1, y]);
          const price = p1 + (p0 - p1) * lv;
          ctx.font = v.font;
          ctx.fillStyle = color;
          ctx.textAlign = "right";
          ctx.textBaseline = "bottom";
          ctx.fillText(`${lv} (${v.fmt(price)})`, x0 - 4 > v.left + 80 ? x0 - 4 : x1 - 4, y - 1);
        });
        ctx.strokeStyle = alpha(col, 0.6);
        ctx.setLineDash([3, 3]);
        line([a[0], a[1], b[0], b[1]]);
      }
      break;
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
export function axisMarks(d: Drawing): { p?: number; t?: number } [] {
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

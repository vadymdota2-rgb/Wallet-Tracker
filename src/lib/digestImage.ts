/**
 * Картинка выпуска для постов в соцсетях: 1080×1350 (4:5 — формат ленты
 * Instagram, Telegram и X без обрезки). Рисуется на canvas прямо в приложении,
 * из тех же данных и теми же словами, что выпуск на экране: итог дня, табло
 * сигналов, главные выводы по вкладкам и ссылка на бота внизу.
 *
 * Цвета — из темы приложения: картинка в ленте узнаётся как наша.
 */
import { t } from "../i18n/t";
import type { DigestItem } from "./types";
import { SIG_KEY, digestLines, sigValue, verdictOf } from "../screens/DigestMore";

type Lang = Parameters<typeof t>[0];

const W = 1080;
const H = 1350;
const PAD = 72;
const C = {
  bg0: "#040912", bg1: "#0a1830", ink: "#eaf5ff", dim: "#7c97bc", glow: "#7fd8ff",
  up: "#3ddc97", dn: "#ff5c77", mix: "#f0b90b", line: "rgba(58,130,214,0.22)", panel: "rgba(127,216,255,0.05)",
};
const FONT = '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, sans-serif';
/** Где нас найти — подпись на каждой картинке. */
const BOT_AT = "@WalletTrackerAppBot";
const BOT_URL = "t.me/WalletTrackerAppBot";

/* Изолирующие символы направления (⁦…⁩) нужны тексту на экране, а canvas
   рисует их как пустые квадраты на части шрифтов — убираем. */
const clean = (s: string) => s.replace(/[⁦-⁩]/g, "");

function dateWord(lang: Lang, tsSec: number): string {
  try {
    return new Intl.DateTimeFormat(lang, { day: "numeric", month: "long", year: "numeric" }).format(new Date(tsSec * 1000));
  } catch {
    return new Date(tsSec * 1000).toISOString().slice(0, 10);
  }
}

/** Перенос по словам в заданную ширину; не больше `max` строк, лишнее — «…». */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= width || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > max) {
    const cut = lines.slice(0, max);
    let last = cut[max - 1]!;
    while (last && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    cut[max - 1] = `${last.trimEnd()}…`;
    return cut;
  }
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const toneColor = (tone?: string) => (tone === "up" ? C.up : tone === "dn" ? C.dn : C.glow);

export async function renderDigestImage(it: DigestItem, lang: Lang): Promise<Blob> {
  try {
    await document.fonts?.ready;
  } catch {
    /* шрифт не догрузился — рисуем системным */
  }
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("canvas");
  const rtl = lang === "ar";
  ctx.direction = rtl ? "rtl" : "ltr";
  /* В арабском всё зеркально: x отсчитывается от правого края. */
  const X = (x: number) => (rtl ? W - x : x);
  const A = (a: CanvasTextAlign): CanvasTextAlign => (!rtl ? a : a === "left" ? "right" : a === "right" ? "left" : a);
  const text = (s: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = "left") => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = A(align);
    ctx.fillText(clean(s), X(x), y);
  };

  /* Фон: тёмный градиент, сетка и мягкое свечение — как в приложении. */
  const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
  g.addColorStop(0, C.bg1);
  g.addColorStop(1, C.bg0);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(58,130,214,0.07)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 54) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 54) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const glow = ctx.createRadialGradient(X(W - 140), 120, 10, X(W - 140), 120, 520);
  glow.addColorStop(0, "rgba(30,155,255,0.22)");
  glow.addColorStop(1, "rgba(30,155,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  /* Шапка: знак, имя и дата выпуска. */
  let y = PAD;
  ctx.strokeStyle = C.glow;
  ctx.lineWidth = 3;
  roundRect(ctx, rtl ? W - PAD - 56 : PAD, y, 56, 56, 14);
  ctx.stroke();
  text("W", PAD + 28, y + 40, `700 30px ${FONT}`, C.glow, "center");
  text("WALLET TRACKER", PAD + 76, y + 25, `700 26px ${FONT}`, C.ink);
  text(t(lang, "dg_img_kicker"), PAD + 76, y + 54, `500 22px ${FONT}`, C.dim);
  text(dateWord(lang, it.to), W - PAD, y + 40, `600 26px ${FONT}`, C.dim, "right");

  /* Заголовок и итог табло. */
  y += 140;
  text(t(lang, "dg_img_title"), PAD, y, `700 60px ${FONT}`, C.ink);
  const v = verdictOf(it, lang);
  if (v) {
    y += 64;
    ctx.font = `700 36px ${FONT}`;
    for (const ln of wrap(ctx, clean(v.text), W - 2 * PAD, 2)) {
      text(ln, PAD, y, `700 36px ${FONT}`, v.cls === "up" ? C.up : v.cls === "dn" ? C.dn : C.mix);
      y += 46;
    }
  }

  /* Табло сигналов: стрелка, что за сигнал, число. */
  const sig = (it.sig ?? []).slice(0, 9);
  if (sig.length) {
    y += 14;
    const rowH = 54;
    const boxH = sig.length * rowH + 28;
    ctx.fillStyle = C.panel;
    roundRect(ctx, PAD, y, W - 2 * PAD, boxH, 22);
    ctx.fill();
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    ctx.stroke();
    let ry = y + 14 + rowH / 2 + 10;
    for (const s of sig) {
      const col = s.d > 0 ? C.up : s.d < 0 ? C.dn : C.dim;
      text(s.d > 0 ? "▲" : s.d < 0 ? "▼" : "●", PAD + 30, ry, `600 24px ${FONT}`, col);
      text(t(lang, SIG_KEY[s.k]), PAD + 72, ry, `500 30px ${FONT}`, C.ink);
      text(sigValue(s), W - PAD - 30, ry, `700 30px ${FONT}`, s.d === 0 ? C.ink : col, "right");
      ry += rowH;
    }
    y += boxH + 50;
  }

  /* Главные выводы — сколько поместится до подвала. */
  const foot = H - PAD - 120;
  text(t(lang, "dg_img_main").toUpperCase(), PAD, y, `700 22px ${FONT}`, C.glow);
  y += 44;
  ctx.font = `600 29px ${FONT}`;
  for (const ln of digestLines(it, lang)) {
    const rows = wrap(ctx, clean(ln.text), W - 2 * PAD - 44, 2);
    if (y + rows.length * 38 > foot) break;
    text(ln.tone === "dn" ? "▼" : ln.tone === "up" ? "▲" : "•", PAD, y, `700 22px ${FONT}`, toneColor(ln.tone));
    for (const r of rows) {
      text(r, PAD + 44, y, `600 29px ${FONT}`, C.ink);
      y += 38;
    }
    y += 16;
  }

  /* Подвал: где нас найти — бот и ссылка — и честная оговорка. */
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, H - PAD - 100);
  ctx.lineTo(W - PAD, H - PAD - 100);
  ctx.stroke();
  text(t(lang, "dg_img_find"), PAD, H - PAD - 58, `500 24px ${FONT}`, C.dim);
  text(BOT_AT, PAD, H - PAD - 14, `700 34px ${FONT}`, C.glow);
  text(BOT_URL, W - PAD, H - PAD - 14, `600 28px ${FONT}`, C.ink, "right");
  text(t(lang, "dg_img_disc"), PAD, H - PAD + 22, `400 18px ${FONT}`, "rgba(124,151,188,0.7)");

  return new Promise((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(new Error("blob"))), "image/png"));
}

/** Blob → base64 для отправки на сервер. */
export function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

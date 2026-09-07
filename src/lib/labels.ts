/**
 * whale_api.py собирает часть подписей готовым русским текстом: «покупка»,
 * «лонг 5×», «вынесло шорт», «лонги платят». Показывать их напрямую нельзя —
 * интерфейс говорит на шестнадцати языках.
 *
 * Здесь строка сводится к типу, а перевод берётся из словаря бота: те же
 * слова, что человек уже видел в чате.
 */
import type { DictKey } from "../i18n/types";

export type TradeKind =
  | "buy" | "sell"
  | "long" | "short"
  | "liqLong" | "liqShort"
  | "closeLong" | "closeShort"
  | "unknown";

const RULES: [RegExp, TradeKind][] = [
  [/вынесло\s+лонг|liq.*long/i, "liqLong"],
  [/вынесло\s+шорт|liq.*short/i, "liqShort"],
  [/закрыл\s+лонг|closed?\s+long/i, "closeLong"],
  [/закрыл\s+шорт|closed?\s+short/i, "closeShort"],
  [/лонг|long/i, "long"],
  [/шорт|short/i, "short"],
  [/куп|покуп|\bbuy\b|\bbought\b/i, "buy"],
  [/прод|\bsell\b|\bsold\b/i, "sell"],
];

export function tradeKind(raw: string | undefined | null): TradeKind {
  const s = String(raw || "");
  for (const [re, kind] of RULES) if (re.test(s)) return kind;
  return "unknown";
}

const KIND_KEY: Record<TradeKind, DictKey> = {
  buy: "alert_buy",
  sell: "alert_sell",
  long: "hl_side_long",
  short: "hl_side_short",
  liqLong: "hl_liq_long",
  liqShort: "hl_liq_short",
  closeLong: "hl_close_long",
  closeShort: "hl_close_short",
  unknown: "hl_trade",
};

export function tradeKindKey(kind: TradeKind): DictKey {
  return KIND_KEY[kind];
}

/** Растёт ли позиция по этой подписи — для цвета строки. */
export function isUpKind(kind: TradeKind): boolean {
  return kind === "buy" || kind === "long" || kind === "liqShort";
}

/** Плечо из строки вида «лонг 5×» — сервер кладёт его прямо в текст. */
export function levFromSide(raw: string | undefined | null): number | null {
  const m = String(raw || "").match(/(\d+(?:[.,]\d+)?)\s*[×xX]/);
  if (!m || m[1] === undefined) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Сторона фандинга: платят лонги или шорты. Считаем по знаку, не по тексту. */
export function fundingSideKey(rate: number): DictKey {
  return rate >= 0 ? "fund_longs_pay" : "fund_shorts_pay";
}

/** «7ч» из рейтинга → часы числом. */
export function holdHours(raw: string | undefined | null): number | null {
  const m = String(raw || "").match(/(\d+)/);
  if (!m || m[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Ключи причин сигнала приходят готовыми: "flow" → ai_why_flow. */
const WHY: Record<string, DictKey> = {
  flow: "ai_why_flow",
  volume: "ai_why_vol",
  top100: "ai_why_top",
  "top100-out": "ai_why_topdir",
  breadth: "ai_why_breadth",
  "liq-skew": "ai_why_liqskew",
  share: "ai_why_share",
  oi: "ai_why_oi",
  rsi: "ai_why_rsi",
  lev: "ai_why_lev",
  liq: "ai_why_liq",
};

export function whyKey(raw: string): DictKey | null {
  return WHY[raw] ?? null;
}

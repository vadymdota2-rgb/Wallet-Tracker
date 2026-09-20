/**
 * whale_api.py собирает часть подписей готовым русским текстом: «покупка»,
 * «лонг 5×», «вынесло шорт», «лонги платят». Показывать их напрямую нельзя —
 * интерфейс говорит на шестнадцати языках.
 *
 * Здесь строка сводится к типу, а перевод берётся из словаря бота: те же
 * слова, что человек уже видел в чате.
 */
import type { DictKey, LangCode } from "../i18n/types";
import { t } from "../i18n/t";

export type TradeKind =
  | "buy" | "sell"
  | "long" | "short"
  | "closeLong" | "closeShort"
  | "unknown";

const RULES: [RegExp, TradeKind][] = [
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
  closeLong: "hl_close_long",
  closeShort: "hl_close_short",
  unknown: "hl_trade",
};

export function tradeKindKey(kind: TradeKind): DictKey {
  return KIND_KEY[kind];
}

/** Растёт ли позиция по этой подписи — для цвета строки. */
export function isUpKind(kind: TradeKind): boolean {
  return kind === "buy" || kind === "long";
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

/**
 * Средний срок удержания. Формат как в боте (formatHoldTime): «21д 15ч»,
 * «8ч 30м», «12м». Прошлая версия огрубляла всё до часов, и трёхнедельная
 * позиция и восьмичасовая выглядели одинаково невнятно.
 */
export function holdTime(sec: number | null | undefined, lang: LangCode): string | null {
  const n = Math.floor(Number(sec) || 0);
  if (!(n > 0)) return null;
  const D = t(lang, "unit_day"), H = t(lang, "unit_hour"),
        M = t(lang, "unit_min"), S = t(lang, "unit_sec");
  const d = Math.floor(n / 86400);
  const h = Math.floor((n % 86400) / 3600);
  const m = Math.floor((n % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}${D} ${h}${H}` : `${d}${D}`;
  if (h > 0) return m > 0 ? `${h}${H} ${m}${M}` : `${h}${H}`;
  if (m > 0) return `${m}${M}`;
  return `${n}${S}`;
}

/**
 * Причина сигнала приходит как вклад признака: имя и сдвиг вероятности.
 *
 * Имена приходят с сервера по-английски и переводятся здесь — все, кроме
 * тех, что читаются одинаково на любом языке: RSI, ATR, MACD. Прежде
 * переведено было пятнадцать имён из сорока одного, и вокруг мозга на
 * японском и арабском крутились «to high», «vol jump» и «breadth» — слова,
 * которые там не читает никто.
 */
const WHY: Record<string, DictKey> = {
  flow: "ai_why_flow",
  volume: "ai_why_vol",
  top100: "ai_why_top",
  "top dir": "ai_why_topdir",
  wallets: "ai_why_breadth",
  "liq skew": "ai_why_liqskew",
  spread: "ai_why_share",
  "OI 1h": "ai_why_oi",
  "OI 24h": "ai_why_oi",
  RSI: "ai_why_rsi",
  leverage: "ai_why_lev",
  liquidity: "ai_why_liq",
  // След события в рядах: листинг, всплеск объёма и резкий ход.
  age: "ai_why_age",
  "vlm z": "ai_why_volz",
  shock: "ai_why_shock",
  // Остальное, что оракул считает по рынку и по потоку.
  accel: "ai_ft_accel",
  trades: "ai_ft_trades",
  ticket: "ai_ft_ticket",
  both: "ai_ft_both",
  "ret 1h": "ai_ft_ret1",
  "ret 6h": "ai_ft_ret6",
  "ret 24h": "ai_ft_ret24",
  "vol 24h": "ai_ft_vol24",
  "vol jump": "ai_ft_voljump",
  "to high": "ai_ft_tohigh",
  "from low": "ai_ft_fromlow",
  trend: "ai_ft_trend",
  funding: "ai_ft_fund",
  "funding z": "ai_ft_fundz",
  "OI/vlm": "ai_ft_oivlm",
  "vlm 24h": "ai_ft_vlm24",
  "liq/OI": "ai_ft_liqoi",
  "BTC 24h": "ai_ft_btc24",
  "BTC vol": "ai_ft_btcvol",
  breadth: "ai_ft_breadth",
  hour: "ai_ft_hour",
  "hour 2": "ai_ft_hour",
};

export function whyKey(raw: string): DictKey | null {
  return WHY[raw] ?? null;
}

/**
 * Имя инструмента для показа: без служебного префикса площадки.
 *
 * Акции и золото приходят с Hyperliquid как «xyz:AAPL» — «xyz» здесь имя
 * рынка HIP-3, а не часть тикера, и человеку оно ничего не говорит. Для
 * запросов и логотипов имя остаётся полным: по нему сервер ищет сделки, а
 * приложение — картинку.
 */
export function showSym(sym: string | undefined | null): string {
  const s = String(sym || "");
  const i = s.lastIndexOf(":");
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Крипта или «не крипта» — акции и металлы.
 *
 * То же правило, что на сервере: акции и товары Hyperliquid живут на
 * отдельных рынках HIP-3 и носят в имени двоеточие — «xyz:NVDA». Обычный перп
 * двоеточия не носит. Плюс список тикеров токенизированных металлов: они
 * торгуются обычными перпами и иначе осели бы в крипте.
 */
const METAL_SYMS = new Set([
  "XAU", "PAXG", "XAUT", "KAU", "GOLD",
  "XAG", "KAG", "SILVER",
  "XPT", "XPD",
]);

export function coinClass(sym: string | undefined | null): "crypto" | "rwa" {
  const s = String(sym || "").toUpperCase();
  return s.includes(":") || METAL_SYMS.has(s) ? "rwa" : "crypto";
}

/**
 * Сторона сделки словами площадки.
 *
 * На перпах позицию открывают в лонг или в шорт, на споте монету покупают или
 * продают — шортить её негде. Бот в чате так и пишет, а в приложении на обеих
 * площадках стояло «Лонг / Шорт»: на споте это обещало сделку, которой там
 * не бывает.
 */
export function sideKey(venue: "perp" | "spot", long: boolean): DictKey {
  if (venue === "perp") return long ? "ai_long" : "ai_short";
  return long ? "ai_buy" : "ai_sell";
}

/*
 * Рынки для криптотрейдера в боковом меню: S&P 500, XYZ100, DXY, золото,
 * доходность 10Y, BVIV (волатильность BTC), BTC.D, USDT.D, ETH/BTC (сервер — wt_markets.py:
 * там же — почему набор такой и что с правами).
 * Проверка ответа сервера (/api/markets) и подписи — без React и без сети:
 * всё проверяется тестами (tests/markets.test.ts).
 *
 * Сервер отдаёт по каждому пункту цену сейчас и сутки назад; изменение
 * считается здесь. У доходности 10-летних облигаций изменение — в базисных
 * пунктах (сотых долях процента), как его пишут трейдеры: «+3 б. п.», а не
 * «+0,6 %» от 4,8 %.
 */

/** Пункты — в порядке экрана (сетка 3 × 3). */
export const MARKET_KEYS = ["SP500", "XYZ100", "DXY", "GOLD", "US10Y", "BVIV", "BTCD", "USDTD", "ETHBTC"] as const;
export type MarketKey = (typeof MARKET_KEYS)[number];
export interface MarketItem {
  k: MarketKey;
  px: number;
  prev: number;
}
export interface MarketsReply {
  at: number;
  items: MarketItem[];
}
/** Цена правдоподобна до этого (сервер — так же, wt_markets.PX_MAX). */
export const MARKET_PX_MAX = 1e7;
/** Время сборки впереди часов телефона больше чем на сутки — не ответ. */
const AHEAD_MAX = 86_400;
/** Сборка старше шести часов — не ответ: вчерашние цены не показываем (сервер
 *  старше получаса и так не отдаёт; запас — на неточные часы телефона). */
const AGE_MAX = 6 * 3_600;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const price = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v < MARKET_PX_MAX;

/** Ответ сервера → рынки или null: неизвестные пункты, повторы и неправдоподобные
 *  цены выпадают, порядок — как на экране. */
export function validMarkets(raw: unknown, now: number = Date.now() / 1000): MarketsReply | null {
  if (!isObj(raw) || raw["ok"] !== true || !Array.isArray(raw["items"])) return null;
  const at = raw["at"];
  if (typeof at !== "number" || !Number.isInteger(at) || at < now - AGE_MAX || at > now + AHEAD_MAX) return null;
  const seen = new Map<MarketKey, MarketItem>();
  for (const it of raw["items"].slice(0, 64)) {
    if (!isObj(it)) continue;
    const k = it["k"];
    if (typeof k !== "string" || !(MARKET_KEYS as readonly string[]).includes(k) || seen.has(k as MarketKey)) continue;
    if (!price(it["px"]) || !price(it["prev"])) continue;
    seen.set(k as MarketKey, { k: k as MarketKey, px: it["px"], prev: it["prev"] });
  }
  const items = MARKET_KEYS.flatMap((k) => (seen.has(k) ? [seen.get(k) as MarketItem] : []));
  return items.length ? { at, items } : null;
}

/** Изменение за сутки: у доходности — базисные пункты, у остальных — проценты. */
export function change(it: MarketItem): { v: number; unit: "bp" | "pct" } {
  return it.k === "US10Y" ? { v: (it.px - it.prev) * 100, unit: "bp" } : { v: (it.px / it.prev - 1) * 100, unit: "pct" };
}

/** Сколько знаков после запятой у цены пункта: индексы — без копеек,
 *  доходность и доли — две, ETH/BTC — пять. */
export function digits(it: MarketItem): number {
  if (it.k === "US10Y" || it.k === "BTCD" || it.k === "USDTD") return 2;
  return it.px >= 1000 ? 0 : it.px >= 10 ? 2 : it.px >= 1 ? 3 : 5;
}

/** Пункт — доля (BTC.D, USDT.D) или доходность: число со знаком «%». */
export const isPercent = (k: MarketKey): boolean => k === "US10Y" || k === "BTCD" || k === "USDTD";

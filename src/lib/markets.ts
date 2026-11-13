/*
 * Рынки для криптотрейдера в боковом меню: S&P 500, XYZ100, DXY, золото,
 * нефть WTI, доходность 10Y, BVIV (волатильность BTC), BTC.D, USDT.D (сервер — wt_markets.py:
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
export const MARKET_KEYS = ["SP500", "XYZ100", "DXY", "GOLD", "OIL", "US10Y", "BVIV", "BTCD", "USDTD"] as const;
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
 *  старше получаса и так не отдаёт; запас — на неточные часы телефона и на
 *  копию на устройстве: её тоже не держим дольше, см. storage.ts). */
export const MARKETS_AGE_MAX = 6 * 3_600;

/** Пунктов в ответе смотрим не больше (их девять; хвост мусора не перебираем). */
const ITEMS_MAX = 64;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const price = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v < MARKET_PX_MAX;

/** Ответ сервера → рынки или null: неизвестные пункты, повторы и неправдоподобные
 *  цены выпадают, порядок — как на экране. */
export function validMarkets(raw: unknown, now: number = Date.now() / 1000): MarketsReply | null {
  if (!isObj(raw) || raw["ok"] !== true || !Array.isArray(raw["items"])) return null;
  const at = raw["at"];
  if (typeof at !== "number" || !Number.isInteger(at) || at < now - MARKETS_AGE_MAX || at > now + AHEAD_MAX) return null;
  const seen = new Map<MarketKey, MarketItem>();
  for (const it of raw["items"].slice(0, ITEMS_MAX)) {
    if (!isObj(it)) continue;
    const k = it["k"];
    if (typeof k !== "string" || !(MARKET_KEYS as readonly string[]).includes(k) || seen.has(k as MarketKey)) continue;
    if (!price(it["px"]) || !price(it["prev"])) continue;
    seen.set(k as MarketKey, { k: k as MarketKey, px: it["px"], prev: it["prev"] });
  }
  const items = MARKET_KEYS.flatMap((k) => seen.get(k) ?? []);
  return items.length ? { at, items } : null;
}

/** Изменение (за сутки; у DXY — от закрытия валютного дня): у доходности — базисные
 *  пункты, у остальных — проценты. */
export function change(it: MarketItem): { v: number; unit: "bp" | "pct" } {
  return it.k === "US10Y" ? { v: (it.px - it.prev) * 100, unit: "bp" } : { v: (it.px / it.prev - 1) * 100, unit: "pct" };
}

/** Сколько знаков после запятой у цены пункта: индексы — без копеек,
 *  доходность и доли — две, остальные — по масштабу. */
export function digits(it: MarketItem): number {
  if (isPercent(it.k)) return 2;
  return it.px >= 1000 ? 0 : it.px >= 10 ? 2 : it.px >= 1 ? 3 : 5;
}

/** Пункт — доходность или доля (BTC.D, USDT.D): число со знаком «%». */
export const isPercent = (k: MarketKey): boolean => k === "US10Y" || k === "BTCD" || k === "USDTD";

/** Полоска под ячейкой — величина изменения за сутки, 0…1: полная — 2 % (у
 *  доходности — 10 б. п.); ненулевое изменение видно всегда (не меньше BAR_MIN). */
const BAR_PCT = 2;
const BAR_BP = 10;
export const BAR_MIN = 0.06;
export function barShare(it: MarketItem): number {
  const c = change(it);
  const a = Math.abs(c.v) / (c.unit === "bp" ? BAR_BP : BAR_PCT);
  if (!Number.isFinite(a) || a === 0) return 0;
  return Math.min(1, Math.max(BAR_MIN, a));
}

/** Сколько минут назад собран ответ (часы телефона отстают — не минус). */
export function ageMin(at: number, now: number = Date.now() / 1000): number {
  return Math.max(0, Math.floor((now - at) / 60));
}

/** Старше этого — время обновления подсвечено: цены не свежие. */
export const MARKETS_STALE_MIN = 15;

/** Цены площадок сервер берёт не чаще раза в столько секунд (wt_markets.SLOW),
 *  а время ответа — когда они получены: раньше новых цен быть не может. */
export const MARKETS_REFRESH = 600;
/** Пора ли спросить сервер: ответа нет, цены старше MARKETS_REFRESH — или по
 *  часам телефона с прошлого вопроса прошло столько же (часы телефона могут
 *  отставать от сервера, и тогда цены казались бы моложе, чем они есть). */
export function marketsDue(at: number | undefined, now: number, askedAgo: number): boolean {
  return at === undefined || now - at >= MARKETS_REFRESH || askedAgo >= MARKETS_REFRESH;
}

/** История для мини-графика (касание ячейки): точек на пункт не больше
 *  (сервер — wt_markets.HIST_MAX), окно — сутки. */
export const HIST_MAX = 300;
export const HIST_SEC = 86_400;
export type MarketsHist = Partial<Record<MarketKey, [number, number][]>>;

/** Ответ /api/markets/hist → ряды по пунктам: только известные пункты, точки
 *  [целое время, правдоподобная цена] по возрастанию времени, за последние
 *  двое суток и не из будущего; меньше двух точек — ряда нет. */
export function validHist(raw: unknown, now: number = Date.now() / 1000): MarketsHist {
  const out: MarketsHist = {};
  if (!isObj(raw) || !isObj(raw["series"]) || raw["ok"] !== true) return out;
  const series = raw["series"];
  for (const k of MARKET_KEYS) {
    const pts = series[k];
    if (!Array.isArray(pts)) continue;
    const good: [number, number][] = [];
    for (const p of pts.slice(-HIST_MAX)) {
      if (!Array.isArray(p) || p.length !== 2) continue;
      const [t, v] = p as unknown[];
      if (typeof t !== "number" || !Number.isInteger(t) || t < now - 2 * HIST_SEC || t > now + AHEAD_MAX || !price(v)) continue;
      if (good.length && t <= good[good.length - 1]![0]) continue;
      good.push([t, v]);
    }
    if (good.length >= 2) out[k] = good;
  }
  return out;
}

/** Ряд для графика ячейки: история за сутки до времени ответа, последняя
 *  точка — цена из ответа (свежее истории — дописывается). */
export function sparkSeries(hist: readonly [number, number][] | undefined, it: MarketItem, at: number): [number, number][] {
  const pts = (hist ?? []).filter(([t]) => t >= at - HIST_SEC && t <= at);
  const last = pts[pts.length - 1];
  if (!last || last[0] < at) pts.push([at, it.px]);
  else pts[pts.length - 1] = [last[0], it.px];
  return pts;
}

export interface Spark {
  line: string;
  area: string;
  /** Где по высоте цена суточной давности (prev) — пунктир. */
  base: number;
  xs: number[];
  ys: number[];
  lo: number;
  hi: number;
}

/** Мини-график в прямоугольнике w × h: время — по ширине, цена — по высоте;
 *  цена суточной давности (base) всегда в кадре — видно, выше ли сейчас. */
export function spark(pts: readonly [number, number][], base: number, w: number, h: number, pad = 3): Spark {
  const t0 = pts[0]?.[0] ?? 0;
  const t1 = pts[pts.length - 1]?.[0] ?? 1;
  let lo = Math.min(base, ...pts.map((p) => p[1]));
  let hi = Math.max(base, ...pts.map((p) => p[1]));
  if (hi === lo) {
    hi += Math.abs(hi) * 0.001 || 1;
    lo -= Math.abs(lo) * 0.001 || 1;
  }
  const x = (t: number) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * w : w);
  const y = (v: number) => pad + ((hi - v) / (hi - lo)) * (h - 2 * pad);
  const xs = pts.map((p) => +x(p[0]).toFixed(2));
  const ys = pts.map((p) => +y(p[1]).toFixed(2));
  const line = xs.map((xv, i) => `${i ? "L" : "M"}${xv},${ys[i]}`).join("");
  const area = xs.length ? `${line}L${xs[xs.length - 1]},${h}L${xs[0]},${h}Z` : "";
  return { line, area, base: +y(base).toFixed(2), xs, ys, lo, hi };
}

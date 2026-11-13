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

/** Дневные свечи для мини-графика (касание ячейки): на пункт — не больше
 *  CANDLES_SHOW (сервер — wt_markets.DAYS_SHOW); принимаем дни не старше
 *  CANDLES_AGE_DAYS (сервер держит DAYS_KEEP). */
export const CANDLES_SHOW = 30;
const CANDLES_AGE_DAYS = 40;
const DAY = 86_400;
/** [начало суток UTC, открытие, максимум, минимум, закрытие]. */
export type Candle = [number, number, number, number, number];
export type MarketsCandles = Partial<Record<MarketKey, Candle[]>>;

/** Ответ /api/markets/candles → свечи по пунктам: только известные пункты,
 *  день — целое начало суток UTC, по возрастанию, не старше CANDLES_AGE_DAYS и
 *  не дальше суток вперёд; цены правдоподобные, максимум не ниже открытия и
 *  закрытия, минимум не выше. */
export function validCandles(raw: unknown, now: number = Date.now() / 1000): MarketsCandles {
  const out: MarketsCandles = {};
  if (!isObj(raw) || !isObj(raw["days"]) || raw["ok"] !== true) return out;
  const days = raw["days"];
  for (const k of MARKET_KEYS) {
    const rows = days[k];
    if (!Array.isArray(rows)) continue;
    const good: Candle[] = [];
    for (const r of rows.slice(-CANDLES_SHOW)) {
      if (!Array.isArray(r) || r.length !== 5) continue;
      const [d, o, h, l, c] = r as unknown[];
      if (typeof d !== "number" || !Number.isInteger(d) || d % DAY !== 0 || d < now - CANDLES_AGE_DAYS * DAY || d > now + DAY) continue;
      if (!price(o) || !price(h) || !price(l) || !price(c) || h < Math.max(o, c) || l > Math.min(o, c)) continue;
      if (good.length && d <= good[good.length - 1]![0]) continue;
      good.push([d, o, h, l, c]);
    }
    if (good.length) out[k] = good;
  }
  return out;
}

/** Свечи для графика ячейки: последняя — с ценой из ответа (свежее свечей:
 *  закрытие — она, тени — с её учётом). */
export function candleSeries(cs: readonly Candle[] | undefined, it: MarketItem): Candle[] {
  const out = (cs ?? []).map((c) => [...c] as Candle);
  const last = out[out.length - 1];
  if (last) out[out.length - 1] = [last[0], last[1], Math.max(last[2], it.px), Math.min(last[3], it.px), it.px];
  return out;
}

interface CandleBar {
  /** Середина свечи по ширине. */
  x: number;
  /** Верх и низ тела, тени. */
  top: number;
  bot: number;
  hi: number;
  lo: number;
  up: boolean;
}
export interface CandleChart {
  bars: CandleBar[];
  /** Ширина тела. */
  bw: number;
  /** Где по высоте последнее закрытие — пунктир цены. */
  last: number;
  lo: number;
  hi: number;
}

/** Запас по высоте графика сверху и снизу — доля размаха цен: тени не
 *  прилипают к краям. */
export const CANDLE_HEADROOM = 0.08;
/** Тело свечи — такая доля места свечи (остальное — промежуток). */
const BODY = 0.64;

/** Свечной график в прямоугольнике w × h: CANDLES_SHOW мест слева направо,
 *  свечи — справа (свечей меньше — слева пусто, ширина свечи та же); цена —
 *  по высоте от минимума до максимума теней, с запасом CANDLE_HEADROOM. Тело
 *  — не тоньше одного пункта (открытие = закрытию). Рост — закрытие не ниже
 *  открытия. */
export function candleChart(cs: readonly Candle[], w: number, h: number, pad = 3): CandleChart {
  const shown = cs.slice(-CANDLES_SHOW);
  let lo = Math.min(...shown.map((c) => c[3]));
  let hi = Math.max(...shown.map((c) => c[2]));
  if (!shown.length) [lo, hi] = [0, 1];
  if (hi === lo) {
    hi += Math.abs(hi) * 0.001 || 1;
    lo -= Math.abs(lo) * 0.001 || 1;
  }
  const room = (hi - lo) * CANDLE_HEADROOM;
  lo -= room;
  hi += room;
  const slot = w / CANDLES_SHOW;
  const y = (v: number) => +(pad + ((hi - v) / (hi - lo)) * (h - 2 * pad)).toFixed(2);
  const first = CANDLES_SHOW - shown.length;
  const bars = shown.map(([, o, ch, cl, c], i) => {
    const top = y(Math.max(o, c));
    const bot = Math.max(y(Math.min(o, c)), top + 0.6);
    return { x: +((first + i + 0.5) * slot).toFixed(2), top, bot: +bot.toFixed(2), hi: y(ch), lo: y(cl), up: c >= o };
  });
  const tail = shown[shown.length - 1];
  return { bars, bw: +(slot * BODY).toFixed(2), last: tail ? y(tail[4]) : h / 2, lo, hi };
}

/** Свечей меньше этого (своя история только копится) — под графиком подпись. */
export const CANDLES_FULL = 7;

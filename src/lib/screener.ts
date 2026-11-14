/*
 * Скринер под графиком: все монеты Binance к USDT с рейтингом индикаторов на
 * всех таймфреймах графика (сервер — wt_screen.py, рейтинг — тот же
 * techRating, что у графика). Здесь — проверка ответа и фильтр без React и
 * без сети: всё проверяется тестами (tests/screener.test.ts).
 *
 * Четыре таймфрейма (SCREEN_WARM) сервер считает всегда, остальные — пока их
 * кто-то фильтрует: приложение называет их в запросе (wanted), первый раз
 * они считаются около минуты (pending).
 *
 * Фильтр — по каждому таймфрейму «любой / покупка / продажа»: например,
 * «15 минут — покупка, час — продажа» находит монеты, где на младшем
 * таймфрейме индикаторы развернулись вверх, а на старшем ещё нет. Покупка —
 * рейтинг выше 0,1, продажа — ниже −0,1: те же пороги, что у слов «покупать»
 * и «продавать» на графике (rateKey).
 */

export const SCREEN_TFS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "3d", "1w", "1M"] as const;
export type ScreenTf = (typeof SCREEN_TFS)[number];
/** Считаются сервером всегда (wt_screen.WARM). */
export const SCREEN_WARM: readonly ScreenTf[] = ["15m", "1h", "4h", "1d"];
export type Want = "any" | "buy" | "sell";
export type ScreenFilter = Record<ScreenTf, Want>;

/** Что ещё сервер считает по таймфрейму (из тех же свечей): скользящие и
 *  осцилляторы рейтинга (−1…+1), RSI 14, ADX 14, объём последней закрытой
 *  свечи к среднему за 20 (×), ATR 14 в % цены, Фибо от лоя — до тейка и до
 *  стопа, % от цены. Нет значения — null. */
export interface Metrics {
  ma: number | null;
  osc: number | null;
  rsi: number | null;
  adx: number | null;
  volx: number | null;
  atrp: number | null;
  tp: number | null;
  sl: number | null;
  /** Сколько цена прошла с закрытия свечи, где нынешний сигнал (покупка или
   *  продажа) появился, % со знаком; нейтрально или давно — null. */
  mv: number | null;
  /** Свечей назад появился сигнал (0 — на этой); больше SINCE_MAX — давно;
   *  нейтрально — null. */
  age: number | null;
}
/** Глубже сервер начало сигнала не ищет (wt_screen.SINCE_MAX). */
export const SINCE_MAX = 100;
export interface ScreenRow {
  s: string;
  px: number | null;
  ch: number | null;
  /** Только на фьючерсах Binance. */
  fut: boolean;
  r: Record<ScreenTf, number | null>;
  m: Partial<Record<ScreenTf, Metrics>>;
}
export interface ScreenReply {
  at: number;
  rows: ScreenRow[];
  /** Таймфреймы, по которым у сервера есть рейтинг. */
  warm: ScreenTf[];
}

/** Ответ старше этого — не ответ (сервер дневной рейтинг держит трое суток). */
const AGE_MAX = 3 * 86_400;
const AHEAD_MAX = 86_400;
const ROWS_MAX = 1000;
const SYM = /^[A-Z0-9]{1,16}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Ответ /api/screener → строки или null: тикер — буквы и цифры, рейтинг — от
 *  −1 до +1 или «нет», повторы и мусор выпадают; ни одного рейтинга — мимо. */
export function validScreener(raw: unknown, now: number = Date.now() / 1000): ScreenReply | null {
  if (!isObj(raw) || raw["ok"] !== true || !Array.isArray(raw["rows"])) return null;
  const at = raw["at"];
  if (!fin(at) || !Number.isInteger(at) || at < now - AGE_MAX || at > now + AHEAD_MAX) return null;
  const seen = new Set<string>();
  const rows: ScreenRow[] = [];
  for (const x of raw["rows"].slice(0, ROWS_MAX)) {
    if (!isObj(x) || typeof x["s"] !== "string" || !SYM.test(x["s"]) || seen.has(x["s"]) || !isObj(x["r"])) continue;
    const src = x["r"];
    const r = {} as Record<ScreenTf, number | null>;
    const m: Partial<Record<ScreenTf, Metrics>> = {};
    let any = false;
    for (const tf of SCREEN_TFS) {
      const v = src[tf];
      const t = Array.isArray(v) ? v[0] : v;
      r[tf] = fin(t) && t >= -1 && t <= 1 ? t : null;
      if (r[tf] !== null && Array.isArray(v)) m[tf] = metricsOf(v);
      any ||= r[tf] !== null;
    }
    if (!any) continue;
    seen.add(x["s"]);
    const px = fin(x["px"]) && x["px"] > 0 && x["px"] < 1e9 ? x["px"] : null;
    const ch = fin(x["ch"]) && Math.abs(x["ch"]) < 1e4 ? x["ch"] : null;
    rows.push({ s: x["s"], px, ch, fut: x["f"] === 1, r, m });
  }
  const warmRaw = Array.isArray(raw["tfs"]) ? raw["tfs"] : [];
  const warm = SCREEN_TFS.filter((tf) => warmRaw.includes(tf) || rows.some((r) => r.r[tf] !== null));
  return rows.length ? { at, rows, warm } : null;
}

/** Число в рамках или null. */
const within = (v: unknown, lo: number, hi: number): number | null => (fin(v) && v >= lo && v <= hi ? v : null);

/** [рейтинг, скользящие, осцилляторы, RSI, ADX, объём ×, ATR %, тейк %, стоп %,
 *  ход с сигнала %, свечей с сигнала] → метрики: каждое значение — в своих
 *  рамках, иначе null. */
function metricsOf(v: unknown[]): Metrics {
  const age = within(v[10], 0, SINCE_MAX + 1);
  return {
    ma: within(v[1], -1, 1), osc: within(v[2], -1, 1), rsi: within(v[3], 0, 100), adx: within(v[4], 0, 100),
    volx: within(v[5], 0, 1e4), atrp: within(v[6], 0, 1e3), tp: within(v[7], 0, 1e4), sl: within(v[8], -100, 0),
    mv: within(v[9], -100, 1e5), age: age !== null && Number.isInteger(age) ? age : null,
  };
}

/** Сколько цена уже прошла в сторону сигнала таймфрейма, % (против — меньше
 *  нуля): покупка — рост, продажа — падение. Нейтрально, давно или нет
 *  данных — null. */
export function chase(row: ScreenRow, tf: ScreenTf): number | null {
  const v = row.r[tf];
  const k = row.m[tf];
  if (v === null || !k || k.mv === null || k.age === null || k.age > SINCE_MAX) return null;
  const s = Math.sign(signal(v));
  return s ? s * k.mv : null;
}

/** Ушло далеко: в сторону сигнала — больше двух ATR этого таймфрейма. */
export function late(row: ScreenRow, tf: ScreenTf): boolean {
  const q = chase(row, tf);
  const a = row.m[tf]?.atrp ?? null;
  return q !== null && a !== null && a > 0 && q > 2 * a;
}

/** Риск/прибыль по Фибо: до тейка к расстоянию до стопа; нет — null. */
export function rr(x: Metrics | undefined): number | null {
  if (!x || x.tp === null || x.sl === null || x.sl >= 0) return null;
  return x.tp / -x.sl;
}

/** Фильтры подтверждения — по основному таймфрейму (младшему выбранному,
 *  без фильтра — 15m): всплеск объёма, сила тренда, зона RSI, риск/прибыль. */
export interface Extra {
  vol: number;
  adx: number;
  rsi: "any" | "os" | "mid" | "ob";
  rr: number;
  /** Цена прошла в сторону сигнала не больше, % (0 — не важно). */
  late: number;
  sort: "sig" | "fresh" | "rr" | "vol" | "adx" | "ch";
}
export const EXTRA_ANY: Extra = { vol: 0, adx: 0, rsi: "any", rr: 0, late: 0, sort: "sig" };
export const VOL_STEPS = [0, 1.5, 2, 3] as const;
export const ADX_STEPS = [0, 20, 25, 40] as const;
export const RR_STEPS = [0, 1.5, 2, 3] as const;
export const RSI_ZONES = ["any", "os", "mid", "ob"] as const;
export const LATE_STEPS = [0, 0.5, 1, 2, 3, 5] as const;
export const SORTS = ["sig", "fresh", "rr", "vol", "adx", "ch"] as const;

/** Фильтры подтверждения с устройства — только известные значения. */
export function validExtra(raw: unknown): Extra {
  const x = isObj(raw) ? raw : {};
  const pick = <T,>(v: unknown, list: readonly T[], def: T): T => (list.includes(v as T) ? (v as T) : def);
  return {
    vol: pick(x["vol"], VOL_STEPS, 0), adx: pick(x["adx"], ADX_STEPS, 0), rsi: pick(x["rsi"], RSI_ZONES, "any"),
    rr: pick(x["rr"], RR_STEPS, 0), late: pick(x["late"], LATE_STEPS, 0), sort: pick(x["sort"], SORTS, "sig"),
  };
}

/** Основной таймфрейм: по нему — подтверждения, детали и сортировка. */
export const mainTf = (f: ScreenFilter): ScreenTf => SCREEN_TFS.find((tf) => f[tf] !== "any") ?? "15m";

/** Монета проходит подтверждения на основном таймфрейме (нет значения — не
 *  проходит, если подтверждение выбрано). */
export function confirms(row: ScreenRow, tf: ScreenTf, x: Extra): boolean {
  const k = row.m[tf];
  if (x.vol && !(k?.volx != null && k.volx >= x.vol)) return false;
  if (x.adx && !(k?.adx != null && k.adx >= x.adx)) return false;
  if (x.rsi !== "any") {
    const v = k?.rsi;
    if (v == null) return false;
    if (x.rsi === "os" ? v >= 30 : x.rsi === "ob" ? v <= 70 : v < 30 || v > 70) return false;
  }
  if (x.rr) {
    const q = rr(k);
    if (q === null || q < x.rr) return false;
  }
  if (x.late) {
    const q = chase(row, tf);
    if (q === null || q > x.late) return false;
  }
  return true;
}

/** Согласие таймфреймов: сколько посчитанных «за покупку», «за продажу» и всего. */
export function consensus(row: ScreenRow): { up: number; dn: number; of: number } {
  let up = 0;
  let dn = 0;
  let of = 0;
  for (const tf of SCREEN_TFS) {
    const v = row.r[tf];
    if (v === null) continue;
    of++;
    if (signal(v) > 0) up++;
    else if (signal(v) < 0) dn++;
  }
  return { up, dn, of };
}

/** Слово рейтинга: −2 активно продавать … +2 активно покупать (пороги rateKey). */
export function signal(v: number): -2 | -1 | 0 | 1 | 2 {
  return v < -0.5 ? -2 : v < -0.1 ? -1 : v <= 0.1 ? 0 : v <= 0.5 ? 1 : 2;
}

export const ANY: ScreenFilter = Object.fromEntries(SCREEN_TFS.map((tf) => [tf, "any"])) as ScreenFilter;

/** Готовые фильтры: младший вверх, старший вниз — и наоборот; все вверх и все вниз. */
export const PRESETS: { key: "scr_p_ub" | "scr_p_bu" | "scr_p_up" | "scr_p_dn"; f: ScreenFilter }[] = [
  { key: "scr_p_ub", f: { ...ANY, "15m": "buy", "1h": "sell" } },
  { key: "scr_p_bu", f: { ...ANY, "15m": "sell", "1h": "buy" } },
  { key: "scr_p_up", f: { ...ANY, "15m": "buy", "1h": "buy", "4h": "buy", "1d": "buy" } },
  { key: "scr_p_dn", f: { ...ANY, "15m": "sell", "1h": "sell", "4h": "sell", "1d": "sell" } },
];

/** Монета подходит: на каждом выбранном таймфрейме рейтинг есть и он нужного знака. */
export function matches(row: ScreenRow, f: ScreenFilter): boolean {
  return SCREEN_TFS.every((tf) => {
    const w = f[tf];
    if (w === "any") return true;
    const v = row.r[tf];
    return v !== null && (w === "buy" ? signal(v) > 0 : signal(v) < 0);
  });
}

/** Отфильтровать и упорядочить. Порядок: сила сигнала на выбранных
 *  таймфреймах (фильтра нет — как прислал сервер, по обороту), риск/прибыль,
 *  всплеск объёма, сила тренда (ADX) или изменение за сутки — по основному
 *  таймфрейму; у кого значения нет — в конце; равные — порядок сервера. */
export function screen(rows: readonly ScreenRow[], f: ScreenFilter, x: Extra = EXTRA_ANY): ScreenRow[] {
  const used = SCREEN_TFS.filter((tf) => f[tf] !== "any");
  const tf = mainTf(f);
  const got = rows.filter((r) => matches(r, f) && confirms(r, tf, x));
  const key = (r: ScreenRow): number | null => {
    if (x.sort === "rr") return rr(r.m[tf]);
    if (x.sort === "fresh") return chase(r, tf) === null ? null : -(r.m[tf]?.age ?? 0);
    if (x.sort === "vol") return r.m[tf]?.volx ?? null;
    if (x.sort === "adx") return r.m[tf]?.adx ?? null;
    if (x.sort === "ch") return r.ch;
    return used.length ? used.reduce((s, t) => s + Math.abs(r.r[t] ?? 0), 0) : null;
  };
  if (x.sort === "sig" && !used.length) return got;
  return got.map((r, i) => ({ r, i, k: key(r) }))
    .sort((a, b) => (a.k === null ? (b.k === null ? a.i - b.i : 1) : b.k === null ? -1 : b.k - a.k || a.i - b.i))
    .map((q) => q.r);
}

/** Таймфрейм, на котором открыть график после касания монеты: младший из
 *  выбранных в фильтре (там сигнал), иначе — нынешний. */
export function chartTf(f: ScreenFilter): ScreenTf | null {
  return SCREEN_TFS.find((tf) => f[tf] !== "any") ?? null;
}

/** Фильтр с устройства или с сервера — только известные значения. */
export function validFilter(raw: unknown): ScreenFilter {
  const out = { ...ANY };
  if (!isObj(raw)) return out;
  for (const tf of SCREEN_TFS) {
    const v = raw[tf];
    if (v === "buy" || v === "sell" || v === "any") out[tf] = v;
  }
  return out;
}

/** Касание таймфрейма в фильтре: любой → покупка → продажа → любой. */
export const nextWant = (w: Want): Want => (w === "any" ? "buy" : w === "buy" ? "sell" : "any");

/** Выбранные в фильтре таймфреймы, по порядку. */
export const picked = (f: ScreenFilter): ScreenTf[] => SCREEN_TFS.filter((tf) => f[tf] !== "any");

/** Какие таймфреймы показать значками у монеты: выбранные человеком
 *  столбцы и те, что в фильтре, — по порядку. */
export const badgeTfs = (f: ScreenFilter, cols: readonly ScreenTf[] = SCREEN_WARM): ScreenTf[] =>
  SCREEN_TFS.filter((tf) => f[tf] !== "any" || cols.includes(tf));

/** Что назвать серверу (?tf=): фильтр и столбцы, кроме тех, что он считает всегда. */
export const wanted = (f: ScreenFilter, cols: readonly ScreenTf[] = SCREEN_WARM): ScreenTf[] =>
  badgeTfs(f, cols).filter((tf) => !SCREEN_WARM.includes(tf));

/** Таймфреймы фильтра и столбцов, рейтинга по которым у сервера ещё нет (считаются). */
export const pending = (f: ScreenFilter, r: ScreenReply | null, cols: readonly ScreenTf[] = SCREEN_WARM): ScreenTf[] =>
  r ? badgeTfs(f, cols).filter((tf) => !r.warm.includes(tf)) : badgeTfs(f, cols);

/** Столбцы с устройства: известные таймфреймы без повторов, по порядку;
 *  не список — четыре основных. Пустой — можно (тогда — только фильтр). */
export function validCols(raw: unknown): ScreenTf[] {
  return Array.isArray(raw) ? SCREEN_TFS.filter((tf) => raw.includes(tf)) : [...SCREEN_WARM];
}

/** Касание столбца: был — убрать, не было — добавить. */
export const toggleCol = (cols: readonly ScreenTf[], tf: ScreenTf): ScreenTf[] =>
  SCREEN_TFS.filter((x) => (x === tf ? !cols.includes(tf) : cols.includes(x)));

/** Поиск монеты в списке: тикер начинается с запроса (прописными). */
export function find(rows: readonly ScreenRow[], q: string): ScreenRow[] {
  const k = q.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return k ? rows.filter((r) => r.s.startsWith(k)) : rows.slice();
}

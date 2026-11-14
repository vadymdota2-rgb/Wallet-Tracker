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

export interface ScreenRow {
  s: string;
  px: number | null;
  ch: number | null;
  r: Record<ScreenTf, number | null>;
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
    let any = false;
    for (const tf of SCREEN_TFS) {
      const v = src[tf];
      r[tf] = fin(v) && v >= -1 && v <= 1 ? v : null;
      any ||= r[tf] !== null;
    }
    if (!any) continue;
    seen.add(x["s"]);
    const px = fin(x["px"]) && x["px"] > 0 && x["px"] < 1e9 ? x["px"] : null;
    const ch = fin(x["ch"]) && Math.abs(x["ch"]) < 1e4 ? x["ch"] : null;
    rows.push({ s: x["s"], px, ch, r });
  }
  const warmRaw = Array.isArray(raw["tfs"]) ? raw["tfs"] : [];
  const warm = SCREEN_TFS.filter((tf) => warmRaw.includes(tf) || rows.some((r) => r.r[tf] !== null));
  return rows.length ? { at, rows, warm } : null;
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

/** Отфильтровать и упорядочить: сильнее сигнал на выбранных таймфреймах —
 *  выше; фильтра нет — как прислал сервер (по обороту). */
export function screen(rows: readonly ScreenRow[], f: ScreenFilter): ScreenRow[] {
  const used = SCREEN_TFS.filter((tf) => f[tf] !== "any");
  const got = rows.filter((r) => matches(r, f));
  if (!used.length) return got;
  const score = (r: ScreenRow) => used.reduce((s, tf) => s + Math.abs(r.r[tf] ?? 0), 0);
  return got.map((r, i) => ({ r, i, k: score(r) })).sort((a, b) => b.k - a.k || a.i - b.i).map((x) => x.r);
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

/** Что назвать серверу (?tf=): выбранные, кроме тех, что он считает всегда. */
export const wanted = (f: ScreenFilter): ScreenTf[] => picked(f).filter((tf) => !SCREEN_WARM.includes(tf));

/** Выбранные таймфреймы, рейтинга по которым у сервера ещё нет (считаются). */
export const pending = (f: ScreenFilter, r: ScreenReply | null): ScreenTf[] =>
  r ? picked(f).filter((tf) => !r.warm.includes(tf)) : picked(f);

/** Какие таймфреймы показать значками у монеты: выбранные (до BADGES), а
 *  без фильтра — четыре основных. */
export const BADGES = 4;
export function badgeTfs(f: ScreenFilter): ScreenTf[] {
  const p = picked(f);
  return p.length ? p.slice(0, BADGES) : [...SCREEN_WARM];
}

/** Поиск монеты в списке: тикер начинается с запроса (прописными). */
export function find(rows: readonly ScreenRow[], q: string): ScreenRow[] {
  const k = q.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return k ? rows.filter((r) => r.s.startsWith(k)) : rows.slice();
}

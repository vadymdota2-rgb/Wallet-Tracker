/**
 * Институциональные потоки — модуль приложения: тип ответа /api/etf, его
 * проверка и все расчёты экрана. Без React и без зависимостей: тесты
 * (node --test) гоняют его как есть.
 *
 * Ответ сервера проверяется целиком, до последней клетки: подменённый или
 * старый ответ (в том числе сохранённый в телефоне до обновления) не роняет
 * экран и не рисует чепуху — такой ответ просто не годится, и экран берёт
 * сохранённый или просит повторить. В память и на устройство идёт только
 * копия с известными полями.
 *
 * Деньги в ответе — тысячи долларов (день, фонд за день), монеты — BTC.
 */

/** Торговый день: [начало суток UTC, поток всех фондов $ тыс., монет, цена, [поток фонда $ тыс. | null]]. */
export type EtfDay = [number, number, number, number, (number | null)[]];

export interface EtfFund {
  /** Тикер. */
  t: string;
  /** Полное имя фонда (из его отчёта в SEC), может быть пустым. */
  n: string;
  /** Страна (ISO), пусто — неизвестна. */
  c?: string;
  /** Активы фонда, $. */
  aum: number;
  /** Запас фонда на сегодня, BTC. */
  hold?: number;
  /** Комиссия фонда, % в год; null — неизвестна. */
  fee: number | null;
  /** Поток с запуска, $ и BTC. */
  cum: number;
  cumc: number;
}

export interface EtfCoin {
  funds: EtfFund[];
  days: EtfDay[];
  /** Цена BTC сейчас. */
  px?: number;
  /** «Данные по» — дата набора (ГГГГ-ММ-ДД). */
  through?: string;
  /** Доля фондов от добытых монет, %. */
  share: number | null;
  /** Активы всех фондов по дням (сводка TFTC, с мая 2025): [начало суток, $]. */
  tna?: [number, number][];
}

/** Держатель: [имя, FUND или COMPANY, страна ISO, тикер, BTC, дата отчёта unix (у фонда 0)]. */
export type BtcHolder = [string, "FUND" | "COMPANY", string, string, number, number];

export interface EtfCbp {
  days: [number, number][];
  now: number | null;
}

export interface EtfReply {
  ok: boolean;
  error?: string;
  coins: { btc?: EtfCoin };
  /** Крупнейшие держатели по убыванию запаса. */
  holders?: BtcHolder[];
  /** Позиции на CME по отчёту CFTC, в монетах, по неделям: [дата, открытый интерес, 4 группы × (лонг, шорт)]. */
  cme?: { btc?: number[][] };
  /** Премия Coinbase к Binance, %: по дням и сейчас. */
  cbp?: { btc?: EtfCbp };
  at: number;
}

/** Ответ живёт столько же, сколько на сервере (wt_etf.TTL): фонды отчитываются раз в сутки. */
export const ETF_TTL_MS = 60 * 60_000;
/** Начало торгов спотовыми биткоин-ETF в США — 11 января 2024 г. */
export const ETF_LAUNCH = 1_704_931_200;

const DAY = 86_400;
/** Пределы правдоподобия: поток всех фондов за день — до $100 млрд (в $ тыс.), монет — до всех 21 млн. */
const USD_K_MAX = 1e8;
const BTC_MAX = 21_000_000;
const AUM_MAX = 1e13;
const PX_MAX = 1e8;
const FUNDS_MAX = 64;
const DAYS_MAX = 10_000;
const HOLDERS_MAX = 500;
const CME_MAX = 2_000;
const CBP_MAX = 2_000;
const NAME_MAX = 120;
/** Активы всех фондов за день, $ — как на сервере (TNA_MIN…TNA_MAX). */
const TNA_MIN = 1e9;
const TNA_MAX = 1e13;
const TICKER = /^[A-Z0-9]{1,10}$/;
const COUNTRY = /^(?:[A-Z]{2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const within = (v: unknown, lo: number, hi: number): v is number => isNum(v) && v >= lo && v <= hi;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function validFund(f: unknown): EtfFund | null {
  if (!isObj(f)) return null;
  const { t, n, c, aum, hold, fee, cum, cumc } = f;
  if (typeof t !== "string" || !TICKER.test(t) || typeof n !== "string" || n.length > NAME_MAX) return null;
  if (c !== undefined && (typeof c !== "string" || !COUNTRY.test(c))) return null;
  if (!within(aum, 0, AUM_MAX) || !within(cum, -AUM_MAX, AUM_MAX) || !within(cumc, -BTC_MAX, BTC_MAX)) return null;
  if (hold !== undefined && !within(hold, 0, BTC_MAX)) return null;
  if (fee !== null && !within(fee, 0, 10)) return null;
  const out: EtfFund = { t, n, aum, fee, cum, cumc };
  if (c) out.c = c;
  if (hold !== undefined) out.hold = hold;
  return out;
}

function validDays(raw: unknown, nf: number, now: number): EtfDay[] | null {
  if (!Array.isArray(raw) || raw.length > DAYS_MAX) return null;
  const out: EtfDay[] = [];
  let prev = 0;
  for (const d of raw) {
    if (!Array.isArray(d) || d.length !== 5) return null;
    const [ts, usd, coin, px, per] = d as unknown[];
    if (!within(ts, ETF_LAUNCH - 7 * DAY, now + 2 * DAY) || ts % DAY !== 0 || ts <= prev) return null;
    if (!within(usd, -USD_K_MAX, USD_K_MAX) || !within(coin, -BTC_MAX, BTC_MAX) || !within(px, 0, PX_MAX)) return null;
    if (!Array.isArray(per) || per.length !== nf) return null;
    const row: (number | null)[] = [];
    for (const v of per) {
      if (v !== null && !within(v, -USD_K_MAX, USD_K_MAX)) return null;
      row.push(v as number | null);
    }
    out.push([ts, usd, coin, px, row]);
    prev = ts;
  }
  return out;
}

/** Ряд активов: дни по возрастанию, суммы правдоподобные; иначе — ряда нет (потоки остаются). */
function validTna(raw: unknown, now: number): [number, number][] | null {
  if (!Array.isArray(raw) || raw.length > DAYS_MAX) return null;
  const out: [number, number][] = [];
  let prev = 0;
  for (const d of raw) {
    if (!Array.isArray(d) || d.length !== 2) return null;
    const [ts, v] = d as unknown[];
    if (!within(ts, ETF_LAUNCH, now + 2 * DAY) || ts % DAY !== 0 || ts <= prev || !within(v, TNA_MIN, TNA_MAX)) return null;
    out.push([ts, v]);
    prev = ts;
  }
  return out;
}

function validCoin(raw: unknown, now: number): EtfCoin | null {
  if (!isObj(raw) || !Array.isArray(raw["funds"]) || raw["funds"].length > FUNDS_MAX) return null;
  const funds: EtfFund[] = [];
  const seen = new Set<string>();
  for (const f of raw["funds"]) {
    const ok = validFund(f);
    if (!ok || seen.has(ok.t)) return null;
    seen.add(ok.t);
    funds.push(ok);
  }
  const days = validDays(raw["days"], funds.length, now);
  if (!days) return null;
  const { px, through, share } = raw;
  if (px !== undefined && !within(px, 0, PX_MAX)) return null;
  if (through !== undefined && (typeof through !== "string" || (through !== "" && !DATE.test(through)))) return null;
  if (share !== null && !within(share, 0, 100)) return null;
  const out: EtfCoin = { funds, days, share };
  if (px !== undefined) out.px = px;
  if (through) out.through = through;
  const tna = validTna(raw["tna"], now);
  if (tna?.length) out.tna = tna;
  return out;
}

/** Строка держателя в нынешнем виде. Старый сервер присылал держателей объектом — такое не годится. */
export function holderRow(r: unknown): r is BtcHolder {
  return Array.isArray(r) && r.length === 6 && typeof r[0] === "string" && r[0].length > 0 && r[0].length <= NAME_MAX
    && (r[1] === "FUND" || r[1] === "COMPANY") && typeof r[2] === "string" && COUNTRY.test(r[2])
    && typeof r[3] === "string" && TICKER.test(r[3]) && within(r[4], 0, BTC_MAX) && within(r[5], 0, 4e9);
}

function validCme(raw: unknown): number[][] | null {
  if (!Array.isArray(raw) || raw.length > CME_MAX) return null;
  for (const r of raw) {
    if (!Array.isArray(r) || r.length !== 10 || !r.every(isNum) || !within(r[0], ETF_LAUNCH - 3650 * DAY, 4e9)) return null;
    if (r.slice(1).some((v: number) => v < 0 || v > BTC_MAX)) return null;
  }
  return raw.map((r: number[]) => [...r]);
}

function validCbp(raw: unknown): EtfCbp | null {
  if (!isObj(raw) || !Array.isArray(raw["days"]) || raw["days"].length > CBP_MAX) return null;
  const days: [number, number][] = [];
  for (const d of raw["days"]) {
    if (!Array.isArray(d) || d.length !== 2 || !within(d[0], 0, 4e9) || !within(d[1], -100, 100)) return null;
    days.push([d[0], d[1]]);
  }
  if (raw["now"] !== null && !within(raw["now"], -100, 100)) return null;
  return { days, now: raw["now"] };
}

/**
 * Проверенная копия ответа /api/etf или null. Потоки фондов — главное:
 * любая ошибка в них — ответ не годится. Дополнения (держатели, CME,
 * премия Coinbase) с ошибкой просто не попадают в копию.
 * now — «сейчас», unix с (по умолчанию — часы телефона).
 */
export function validEtf(raw: unknown, now: number = Date.now() / 1000): EtfReply | null {
  if (!isObj(raw) || raw["ok"] !== true || !isObj(raw["coins"]) || !within(raw["at"], ETF_LAUNCH, now + 7 * DAY)) return null;
  const btc = validCoin(raw["coins"]["btc"], now);
  if (!btc || !btc.days.length) return null;
  const out: EtfReply = { ok: true, coins: { btc }, at: raw["at"] };
  if (Array.isArray(raw["holders"])) out.holders = raw["holders"].filter(holderRow).slice(0, HOLDERS_MAX).map((r) => [...r] as BtcHolder);
  const cme = isObj(raw["cme"]) ? validCme(raw["cme"]["btc"]) : null;
  if (cme?.length) out.cme = { btc: cme };
  const cbp = isObj(raw["cbp"]) ? validCbp(raw["cbp"]["btc"]) : null;
  if (cbp?.days.length) out.cbp = { btc: cbp };
  return out;
}

/* --------------------------------------------------------------------- */

/** Сколько новых биткоинов за сутки: 144 блока × награда за блок. */
export function minedPerDay(ts: number): number {
  if (ts < 1_713_571_200) return 900; // до халвинга 20 апреля 2024
  if (ts < 1_838_900_000) return 450; // до следующего — по оценке ≈ 9 апреля 2028
  return 225;
}

/** Столбец графика: с a по b (начала суток), поток $ тыс., монеты, цена в конце, потоки фондов. */
export interface Bucket { a: number; b: number; usd: number; coin: number; px: number; per: number[] }

export function daily(days: EtfDay[], nf: number): Bucket[] {
  return days.map((d) => ({ a: d[0], b: d[0], usd: d[1], coin: d[2], px: d[3], per: Array.from({ length: nf }, (_, i) => d[4][i] ?? 0) }));
}

/** Недели с понедельника: на годе и всей истории дневные столбцы сливаются в шум. */
export function weekly(days: EtfDay[], nf: number): Bucket[] {
  const out: Bucket[] = [];
  const week = (ts: number) => Math.floor((ts / DAY + 3) / 7); // 1 января 1970 — четверг
  for (const d of days) {
    const last = out[out.length - 1];
    if (last && week(last.a) === week(d[0])) {
      last.b = d[0];
      last.usd += d[1];
      last.coin += d[2];
      if (d[3]) last.px = d[3];
      d[4].forEach((v, i) => { if (i < nf) last.per[i]! += v ?? 0; });
    } else {
      out.push({ a: d[0], b: d[0], usd: d[1], coin: d[2], px: d[3], per: Array.from({ length: nf }, (_, i) => d[4][i] ?? 0) });
    }
  }
  return out;
}

export type Range = "30" | "90" | "365" | "all";
export const RANGES: readonly Range[] = ["30", "90", "365", "all"];

/** Дни за последние n суток до последнего дня (включительно). */
export function lastDays(days: EtfDay[], n: number): EtfDay[] {
  const end = days[days.length - 1]?.[0] ?? 0;
  return days.filter((d) => d[0] > end - n * DAY);
}

/** Столбцы графика: 30 и 90 дней — по дням, год и вся история — по неделям. */
export function chartView(days: EtfDay[], nf: number, range: Range): Bucket[] {
  const src = range === "all" ? days : lastDays(days, Number(range));
  return range === "30" || range === "90" ? daily(src, nf) : weekly(src, nf);
}

/** Накоплено с запуска к концу каждого столбца — от всей истории, а не от начала окна. */
export function cumulative(view: Bucket[], days: EtfDay[]): number[] {
  const first = view[0]?.a ?? 0;
  let acc = days.filter((d) => d[0] < first).reduce((s, d) => s + d[1], 0);
  return view.map((b) => (acc += b.usd));
}

export interface EtfStats {
  /** Последний день. */
  last: EtfDay;
  /** За 7 и 30 дней и с запуска, $. */
  d7: number;
  d30: number;
  cum: number;
  /** Дней подряд в ту же сторону, что последний, и сама сторона. */
  streak: number;
  sign: number;
  /** Монет за 30 дней у фондов и намайнено за те же 30 суток. */
  c30: number;
  mined: number;
  best: EtfDay;
  worst: EtfDay;
  /** Самые длинные серии притоков и оттоков: дней и с какого дня. */
  runs: { up: { n: number; at: number }; dn: { n: number; at: number } };
  /** Лучший и худший завершённый месяц: [начало месяца, $ тыс.]. */
  bestM: [number, number] | null;
  worstM: [number, number] | null;
  /** Активы фондов, $, и их запас, BTC; откуда — сводка TFTC или свои оценки по фондам. */
  aum: number;
  held: number;
  src: "tna" | "funds";
}

/** Итоги экрана. now — «сейчас», unix с: идущий месяц в рекорды не попадает. */
export function etfStats(c: EtfCoin, now: number): EtfStats | null {
  const days = c.days;
  const last = days[days.length - 1];
  if (!last) return null;
  const end = last[0];
  const sumU = (ds: EtfDay[]) => ds.reduce((s, d) => s + d[1], 0) * 1000;
  const sign = Math.sign(last[1]);
  let streak = 0;
  for (let i = days.length - 1; i >= 0 && sign !== 0 && Math.sign(days[i]![1]) === sign; i--) streak++;
  let best = days[0]!;
  let worst = days[0]!;
  const runs = { up: { n: 0, at: 0 }, dn: { n: 0, at: 0 } };
  let run = 0;
  let runSign = 0;
  let runAt = 0;
  for (const d of days) {
    if (d[1] > best[1]) best = d;
    if (d[1] < worst[1]) worst = d;
    const s = Math.sign(d[1]);
    if (s !== 0 && s === runSign) run++;
    else {
      run = s === 0 ? 0 : 1;
      runSign = s;
      runAt = d[0];
    }
    if (runSign > 0 && run > runs.up.n) runs.up = { n: run, at: runAt };
    if (runSign < 0 && run > runs.dn.n) runs.dn = { n: run, at: runAt };
  }
  // Лучший и худший месяц — только завершённые: «худший месяц — октябрь»
  // посреди октября вводил бы в заблуждение.
  const months = new Map<number, number>();
  for (const d of days) {
    const m = new Date(d[0] * 1000);
    const key = Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1) / 1000;
    months.set(key, (months.get(key) ?? 0) + d[1]);
  }
  const nowM = new Date(Math.max(now, end) * 1000);
  const open = Date.UTC(nowM.getUTCFullYear(), nowM.getUTCMonth(), 1) / 1000;
  let bestM: [number, number] | null = null;
  let worstM: [number, number] | null = null;
  for (const [m, v] of months) {
    if (m >= open) continue;
    if (!bestM || v > bestM[1]) bestM = [m, v];
    if (!worstM || v < worstM[1]) worstM = [m, v];
  }
  const m30 = lastDays(days, 30);
  let mined = 0;
  for (let i = 0; i < 30; i++) mined += minedPerDay(end - i * DAY);
  return {
    last, d7: sumU(lastDays(days, 7)), d30: sumU(m30), cum: sumU(days), streak, sign,
    c30: m30.reduce((s, d) => s + d[2], 0), mined, best, worst, runs, bestM, worstM,
    ...assets(c),
  };
}

/** Свежие активы по сводке — не старше недели от последнего дня (как на сервере). */
const TNA_FRESH = 7 * DAY;

/**
 * Активы всех фондов, $, и их запас, BTC. По сводке TFTC, если она свежая:
 * активы того дня в пересчёте на цену сейчас (запас в монетах тот же). Иначе
 * — сумма своих оценок по фондам (отчёты SEC плюс потоки после них).
 */
export function assets(c: EtfCoin): { aum: number; held: number; src: "tna" | "funds" } {
  const lastDay = c.days[c.days.length - 1]?.[0] ?? 0;
  const t = c.tna?.[c.tna.length - 1];
  const px = t ? c.days.find((d) => d[0] === t[0])?.[3] ?? 0 : 0;
  let now = c.px ?? 0;
  for (let i = c.days.length - 1; i >= 0 && !now; i--) now = c.days[i]![3];
  if (t && px > 0 && now > 0 && t[0] >= lastDay - TNA_FRESH) {
    return { aum: (t[1] * now) / px, held: t[1] / px, src: "tna" };
  }
  return {
    aum: c.funds.reduce((s, f) => s + f.aum, 0),
    held: c.funds.reduce((s, f) => s + (f.hold ?? 0), 0),
    src: "funds",
  };
}

/** Запас всех фондов по дням, BTC: активы дня (сводка TFTC) по цене того же дня. */
export function heldSeries(c: EtfCoin): [number, number][] {
  const px = new Map(c.days.map((d) => [d[0], d[3]]));
  return (c.tna ?? []).flatMap(([ts, usd]): [number, number][] => {
    const p = px.get(ts) ?? 0;
    return p > 0 ? [[ts, usd / p]] : [];
  });
}

export type Period = "d" | "w" | "m" | "all";
export const PERIODS: readonly Period[] = ["d", "w", "m", "all"];

export interface FundTotals {
  /** Фонды с движением от $1 тыс., по убыванию потока ($ тыс.). */
  moving: { f: EtfFund; v: number }[];
  /** Сколько фондов без движения. */
  still: number;
  /** Приток и отток за срок, $ тыс.; самый большой поток по модулю. */
  ins: number;
  outs: number;
  span: number;
}

/** Фонды за срок: день, неделя (7 суток), месяц (30 суток) или с запуска. */
export function fundTotals(c: EtfCoin, period: Period): FundTotals {
  const sum = c.funds.map(() => 0);
  if (period === "all") c.funds.forEach((f, i) => { sum[i] = f.cum / 1000; });
  else {
    const n = period === "d" ? 1 : period === "w" ? 7 : 30;
    for (const d of lastDays(c.days, n)) d[4].forEach((v, i) => { if (i < sum.length) sum[i]! += v ?? 0; });
  }
  const rows = c.funds.map((f, i) => ({ f, v: sum[i]! })).sort((x, y) => y.v - x.v);
  const moving = rows.filter((r) => Math.abs(r.v) >= 1);
  return {
    moving, still: rows.length - moving.length,
    ins: moving.filter((r) => r.v > 0).reduce((s, r) => s + r.v, 0),
    outs: moving.filter((r) => r.v < 0).reduce((s, r) => s + r.v, 0),
    span: Math.max(1, ...moving.map((r) => Math.abs(r.v))),
  };
}

/** Самые большие потоки фондов в столбце — для подсказки под пальцем. */
export function topFunds(funds: EtfFund[], b: Bucket, n = 3): { t: string; v: number }[] {
  return funds.map((f, i) => ({ t: f.t, v: b.per[i] ?? 0 }))
    .filter((x) => Math.abs(x.v) >= 1).sort((x, y) => Math.abs(y.v) - Math.abs(x.v)).slice(0, n);
}

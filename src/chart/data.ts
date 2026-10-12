/**
 * Свечи для своего графика: история с подгрузкой назад и живая последняя
 * свеча.
 *
 * История идёт через nginx приложения (браузер ходит только на свой домен):
 *   /klines-vision — Binance spot (публичное зеркало data-api.binance.vision:
 *                    отвечает из любой страны, в отличие от api.binance.com);
 *   /klines        — Binance spot напрямую, если зеркало молчит;
 *   /klines-hl     — Hyperliquid: перпы, в том числе то, чего нет на Binance,
 *                    и рынки HIP-3 (xyz:NVDA, xyz:GOLD — акции, металлы);
 *   /klines-bybit  — Bybit spot и бессрочные;
 *   /klines-kucoin — KuCoin, последний запасной.
 * Какой источник ответил по монете, запоминается — дальше идём сразу к нему.
 *
 * Живая свеча — вебсокетом прямо с биржи (рыночные данные публичны, ключей
 * не нужно): Binance — data-stream.binance.vision, Hyperliquid — api.
 * hyperliquid.xyz/ws, Bybit — stream.bybit.com. Не открылся сокет — раз в
 * десять секунд спрашиваем две последние свечи.
 *
 * Таймфрейм, которого у биржи нет (3 дня у Bybit, 6 часов у Hyperliquid),
 * собирается из меньшего — по тем же границам, что у Binance.
 */

export interface Bar {
  /** Открытие свечи, мс UTC. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Объём в монетах. */
  v: number;
}

export type Tf = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "12h" | "1d" | "3d" | "1w" | "1M";

export const TFS: Tf[] = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "3d", "1w", "1M"];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Длина свечи, мс. У месяца — средняя: для шага по оси и отсчёта до закрытия
 *  месячной свечи точная длина считается отдельно (tfEnd). */
export const TF_MS: Record<Tf, number> = {
  "1m": MIN, "3m": 3 * MIN, "5m": 5 * MIN, "15m": 15 * MIN, "30m": 30 * MIN,
  "1h": HOUR, "2h": 2 * HOUR, "4h": 4 * HOUR, "6h": 6 * HOUR, "12h": 12 * HOUR,
  "1d": DAY, "3d": 3 * DAY, "1w": 7 * DAY, "1M": 30 * DAY,
};

/** Когда закроется свеча, открытая в `t`. */
export function tfEnd(tf: Tf, t: number): number {
  if (tf !== "1M") return t + TF_MS[tf];
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Начало свечи, в которую попадает момент `t`. Недели у Binance — с понедельника. */
export function tfStart(tf: Tf, t: number): number {
  if (tf === "1M") {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  if (tf === "1w") {
    // 1970-01-01 — четверг; понедельник — через 4 дня.
    const off = 4 * DAY;
    return Math.floor((t - off) / TF_MS["1w"]) * TF_MS["1w"] + off;
  }
  return Math.floor(t / TF_MS[tf]) * TF_MS[tf];
}

export type Source = "binance" | "hl" | "bybit" | "bybit-perp" | "kucoin";

export const SOURCE_NAME: Record<Source, string> = {
  binance: "Binance", hl: "Hyperliquid", bybit: "Bybit", "bybit-perp": "Bybit Perp", kucoin: "KuCoin",
};

/** Что у биржи называется так же, как у нас; null — собирать из `base`. */
interface Iv {
  name: string | null;
  base?: Tf;
}

const BINANCE_IV: Record<Tf, Iv> = Object.fromEntries(TFS.map((tf) => [tf, { name: tf }])) as Record<Tf, Iv>;
const HL_IV: Record<Tf, Iv> = { ...BINANCE_IV, "6h": { name: null, base: "2h" } };
const BYBIT_IV: Record<Tf, Iv> = {
  "1m": { name: "1" }, "3m": { name: "3" }, "5m": { name: "5" }, "15m": { name: "15" }, "30m": { name: "30" },
  "1h": { name: "60" }, "2h": { name: "120" }, "4h": { name: "240" }, "6h": { name: "360" }, "12h": { name: "720" },
  "1d": { name: "D" }, "3d": { name: null, base: "1d" }, "1w": { name: "W" }, "1M": { name: "M" },
};
const KUCOIN_IV: Record<Tf, Iv> = {
  "1m": { name: "1min" }, "3m": { name: "3min" }, "5m": { name: "5min" }, "15m": { name: "15min" },
  "30m": { name: "30min" }, "1h": { name: "1hour" }, "2h": { name: "2hour" }, "4h": { name: "4hour" },
  "6h": { name: "6hour" }, "12h": { name: "12hour" }, "1d": { name: "1day" }, "3d": { name: null, base: "1d" },
  "1w": { name: "1week" }, "1M": { name: null, base: "1d" },
};
const IV: Record<Source, Record<Tf, Iv>> = {
  binance: BINANCE_IV, hl: HL_IV, bybit: BYBIT_IV, "bybit-perp": BYBIT_IV, kucoin: KUCOIN_IV,
};

/** Сколько свечей за один запрос. */
const PAGE = 1000;

const num = (x: unknown): number => {
  const v = Number(x);
  return Number.isFinite(v) ? v : 0;
};
const good = (b: Bar) => b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0 && b.t > 0;

async function getJson(url: string, init?: RequestInit, signal?: AbortSignal): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  const stop = () => ctrl.abort();
  signal?.addEventListener("abort", stop);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

/* ── Тикер → символ каждой биржи ────────────────────────────────────────── */

const K_COINS = /^K(PEPE|SHIB|BONK|FLOKI|DOGS|NEIRO|LUNC)$/;

export interface Market {
  /** Как показывать: BTC, NVDA. */
  label: string;
  /** Монета без множителя: kPEPE → PEPE. */
  base: string;
  /** Рынок HIP-3 (xyz:NVDA) — только Hyperliquid. */
  hip3: string | null;
  /** Имя у Hyperliquid: BTC, kPEPE, xyz:NVDA. */
  hl: string;
}

export function market(raw: string): Market {
  const s = String(raw || "").trim();
  const colon = s.indexOf(":");
  if (colon > 0) {
    const dex = s.slice(0, colon).toLowerCase();
    const name = s.slice(colon + 1).toUpperCase().replace(/[^A-Z0-9]/g, "");
    return { label: name, base: name, hip3: `${dex}:${name}`, hl: `${dex}:${name}` };
  }
  let up = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  // BTCUSDT, ETHUSDC — пара целиком: берём монету.
  const m = /^(.+?)(USDT|USDC|FDUSD|USD)$/.exec(up);
  if (m && m[1] && m[1].length >= 2) up = m[1];
  const isK = K_COINS.test(up) || /^1000(PEPE|SHIB|BONK|FLOKI|LUNC)$/.test(up);
  const base = isK ? up.replace(/^K|^1000/, "") : up;
  return { label: up, base, hip3: null, hl: isK ? `k${base}` : base };
}

/* ── Загрузка страницы истории из одного источника ─────────────────────── */

type Page = Bar[] | null;

async function pageBinance(m: Market, iv: string, end: number | null, url: string, signal?: AbortSignal): Promise<Page> {
  const q = `symbol=${m.base}USDT&interval=${iv}&limit=${PAGE}${end ? `&endTime=${end}` : ""}`;
  const raw = await getJson(`${url}?${q}`, undefined, signal);
  if (!Array.isArray(raw)) return null;
  return raw.map((a: unknown[]) => ({ t: num(a[0]), o: num(a[1]), h: num(a[2]), l: num(a[3]), c: num(a[4]), v: num(a[5]) })).filter(good);
}

async function pageHl(m: Market, iv: string, tf: Tf, end: number | null, signal?: AbortSignal): Promise<Page> {
  // Последняя страница: конец округлён вверх до 10 с — у всех, кто смотрит
  // ту же монету, запрос одинаковый, и nginx отдаёт его из кэша.
  const endTime = end ?? Math.ceil(Date.now() / 10_000) * 10_000;
  // Hyperliquid отдаёт до 5000 свечей; берём окно на PAGE свечей назад.
  const startTime = endTime - TF_MS[tf] * PAGE;
  const raw = await getJson("/klines-hl", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin: m.hl, interval: iv, startTime, endTime } }),
  }, signal);
  if (!Array.isArray(raw)) return null;
  return raw
    .map((r: Record<string, unknown>) => ({ t: num(r.t), o: num(r.o), h: num(r.h), l: num(r.l), c: num(r.c), v: num(r.v) }))
    .filter(good);
}

async function pageBybit(m: Market, iv: string, end: number | null, perp: boolean, signal?: AbortSignal): Promise<Page> {
  const q = `category=${perp ? "linear" : "spot"}&symbol=${m.base}USDT&interval=${iv}&limit=${PAGE}${end ? `&end=${end}` : ""}`;
  const raw = (await getJson(`/klines-bybit?${q}`, undefined, signal)) as { result?: { list?: unknown[][] } } | null;
  const list = raw?.result?.list;
  if (!Array.isArray(list)) return null;
  return list.map((a) => ({ t: num(a[0]), o: num(a[1]), h: num(a[2]), l: num(a[3]), c: num(a[4]), v: num(a[5]) })).filter(good).reverse();
}

async function pageKucoin(m: Market, iv: string, tf: Tf, end: number | null, signal?: AbortSignal): Promise<Page> {
  const endAt = end ? Math.floor(end / 1000) : Math.ceil(Date.now() / 10_000) * 10;
  const startAt = endAt - Math.floor((TF_MS[tf] * 1500) / 1000);
  const raw = (await getJson(`/klines-kucoin?symbol=${m.base}-USDT&type=${iv}&startAt=${startAt}&endAt=${endAt}`, undefined, signal)) as
    { data?: unknown[][] } | null;
  const list = raw?.data;
  if (!Array.isArray(list)) return null;
  // KuCoin: [время с, открытие, закрытие, максимум, минимум, объём, оборот]
  return list.map((a) => ({ t: num(a[0]) * 1000, o: num(a[1]), h: num(a[3]), l: num(a[4]), c: num(a[2]), v: num(a[5]) })).filter(good).reverse();
}

async function rawPage(src: Source, m: Market, tf: Tf, end: number | null, signal?: AbortSignal): Promise<Page> {
  const iv = IV[src][tf].name;
  if (!iv) return null;
  switch (src) {
    case "binance": {
      const a = await pageBinance(m, iv, end, "/klines-vision", signal);
      return a && a.length ? a : pageBinance(m, iv, end, "/klines", signal);
    }
    case "hl":
      return pageHl(m, iv, tf, end, signal);
    case "bybit":
      return pageBybit(m, iv, end, false, signal);
    case "bybit-perp":
      return pageBybit(m, iv, end, true, signal);
    case "kucoin":
      return pageKucoin(m, iv, tf, end, signal);
  }
}

/** Свечи меньшего таймфрейма → свечи нужного (по границам tfStart). */
export function aggregate(bars: Bar[], tf: Tf): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of bars) {
    const t = tfStart(tf, b.t);
    if (!cur || cur.t !== t) {
      cur = { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  return out;
}

/** Страница истории нужного таймфрейма — напрямую или собранная из меньшего. */
async function page(src: Source, m: Market, tf: Tf, end: number | null, signal?: AbortSignal): Promise<Page> {
  const iv = IV[src][tf];
  if (iv.name) return rawPage(src, m, tf, end, signal);
  if (!iv.base) return null;
  const small = await rawPage(src, m, iv.base, end, signal);
  if (!small) return null;
  const agg = aggregate(small, tf);
  // Первая собранная свеча неполная (её начало раньше страницы) — отбросим.
  return agg.length > 1 ? agg.slice(1) : agg;
}

/* ── Выбор источника ───────────────────────────────────────────────────── */

const chosen = new Map<string, Source>();

function order(m: Market): Source[] {
  if (m.hip3) return ["hl"];
  return ["binance", "hl", "bybit", "bybit-perp", "kucoin"];
}

export interface History {
  bars: Bar[];
  src: Source;
}

/** Последние свечи монеты: первый ответивший источник. null — котировок нет нигде. */
export async function loadHistory(raw: string, tf: Tf, signal?: AbortSignal): Promise<History | null> {
  const m = market(raw);
  const known = chosen.get(m.hl);
  const list = known ? [known, ...order(m).filter((s) => s !== known)] : order(m);
  for (const src of list) {
    if (signal?.aborted) return null;
    const bars = await page(src, m, tf, null, signal);
    if (bars && bars.length >= 2) {
      chosen.set(m.hl, src);
      return { bars: dedupe(bars), src };
    }
  }
  return null;
}

/** Свечи раньше `before` (мс) из того же источника. Пусто — история кончилась. */
export async function loadOlder(raw: string, tf: Tf, src: Source, before: number, signal?: AbortSignal): Promise<Bar[]> {
  const bars = await page(src, market(raw), tf, before - 1, signal);
  return dedupe((bars ?? []).filter((b) => b.t < before));
}

function dedupe(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const last = out[out.length - 1];
    if (last && b.t <= last.t) {
      if (b.t === last.t) out[out.length - 1] = b;
      continue;
    }
    out.push(b);
  }
  return out;
}

/* ── Живая свеча ───────────────────────────────────────────────────────── */

/**
 * Подписка на последнюю свечу. `on` получает свечу целиком (открытую или
 * только что закрытую) — график сам решает, заменить последнюю или добавить.
 * Возвращает функцию отписки.
 */
export function subscribe(raw: string, tf: Tf, src: Source, on: (b: Bar) => void): () => void {
  const m = market(raw);
  let ws: WebSocket | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let fails = 0;
  // Собранный таймфрейм (6h у Hyperliquid) копим из меньших свечей.
  const iv = IV[src][tf];
  const live = iv.name ? tf : (iv.base ?? tf);
  let acc: Bar | null = null;
  const emit = (b: Bar) => {
    if (!good(b)) return;
    if (live === tf) {
      on(b);
      return;
    }
    const t = tfStart(tf, b.t);
    if (!acc || acc.t !== t) acc = { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
    else {
      acc.h = Math.max(acc.h, b.h);
      acc.l = Math.min(acc.l, b.l);
      acc.c = b.c;
    }
    on({ ...acc });
  };

  const startPoll = () => {
    if (poll || closed) return;
    const tick = async () => {
      const bars = await page(src, m, tf, null);
      const last = bars?.[bars.length - 1];
      if (!closed && last) on(last);
    };
    void tick();
    poll = setInterval(() => void tick(), 10_000);
  };

  const open = () => {
    if (closed) return;
    const name = IV[src][live].name;
    let url = "";
    let hello: string | null = null;
    if (src === "binance" && name) url = `wss://data-stream.binance.vision/ws/${m.base.toLowerCase()}usdt@kline_${name}`;
    else if (src === "hl" && name) {
      url = "wss://api.hyperliquid.xyz/ws";
      hello = JSON.stringify({ method: "subscribe", subscription: { type: "candle", coin: m.hl, interval: name } });
    } else if ((src === "bybit" || src === "bybit-perp") && name) {
      url = `wss://stream.bybit.com/v5/public/${src === "bybit" ? "spot" : "linear"}`;
      hello = JSON.stringify({ op: "subscribe", args: [`kline.${name}.${m.base}USDT`] });
    }
    if (!url || typeof WebSocket === "undefined") {
      startPoll();
      return;
    }
    let s: WebSocket;
    try {
      s = new WebSocket(url);
    } catch {
      startPoll();
      return;
    }
    ws = s;
    let ping: ReturnType<typeof setInterval> | null = null;
    s.onopen = () => {
      fails = 0;
      if (hello) s.send(hello);
      // Hyperliquid и Bybit закрывают молчащее соединение — шлём ping.
      if (src !== "binance") {
        ping = setInterval(() => {
          try {
            s.send(src === "hl" ? JSON.stringify({ method: "ping" }) : JSON.stringify({ op: "ping" }));
          } catch { /* закрылось — разберётся onclose */ }
        }, 20_000);
      }
    };
    s.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (src === "binance") {
        const k = msg.k as Record<string, unknown> | undefined;
        if (k) emit({ t: num(k.t), o: num(k.o), h: num(k.h), l: num(k.l), c: num(k.c), v: num(k.v) });
      } else if (src === "hl") {
        if (msg.channel !== "candle") return;
        const d = msg.data as Record<string, unknown> | undefined;
        if (d) emit({ t: num(d.t), o: num(d.o), h: num(d.h), l: num(d.l), c: num(d.c), v: num(d.v) });
      } else {
        const list = msg.data as Record<string, unknown>[] | undefined;
        if (!Array.isArray(list)) return;
        for (const d of list) emit({ t: num(d.start), o: num(d.open), h: num(d.high), l: num(d.low), c: num(d.close), v: num(d.volume) });
      }
    };
    s.onclose = () => {
      if (ping) clearInterval(ping);
      ws = null;
      if (closed) return;
      // Сокет не держится — переходим на опрос; держится, но оборвался —
      // переподключаемся с растущей паузой.
      if (++fails >= 3) startPoll();
      else retry = setTimeout(open, 1000 * 2 ** fails);
    };
    s.onerror = () => {
      try {
        s.close();
      } catch { /* уже закрыт */ }
    };
  };

  open();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    if (poll) clearInterval(poll);
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch { /* уже закрыт */ }
    }
  };
}

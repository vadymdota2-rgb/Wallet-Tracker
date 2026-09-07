/**
 * Свечи для графика. nginx проксирует четыре источника; идём по ним по
 * очереди, пока кто-нибудь не ответит. Наружу браузер не ходит — только на
 * свой домен, поэтому CORS и ключи бирж не нужны.
 *
 * Если не ответил никто — возвращаем пустой массив, и экран честно говорит,
 * что котировок нет. Прошлая версия в этом месте рисовала 32 точки линейной
 * интерполяции между ценой входа и текущей: по виду обычный график, по сути
 * ничего.
 */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export type Timeframe = "1h" | "1d" | "1w";

const SHAPE: Record<Timeframe, { binance: string; bybit: string; kucoin: string; limit: number }> = {
  "1h": { binance: "1m", bybit: "1", kucoin: "1min", limit: 60 },
  "1d": { binance: "15m", bybit: "15", kucoin: "15min", limit: 96 },
  "1w": { binance: "1h", bybit: "60", kucoin: "1hour", limit: 168 },
};

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

const ok = (c: Candle): boolean => c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0;

async function grab(url: string, signal?: AbortSignal): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function fromBinance(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r): Candle => {
      const a = r as unknown[];
      return { t: n(a[0]), o: n(a[1]), h: n(a[2]), l: n(a[3]), c: n(a[4]) };
    })
    .filter(ok);
}

function fromBybit(raw: unknown): Candle[] {
  const list = (raw as { result?: { list?: unknown[] } })?.result?.list;
  if (!Array.isArray(list)) return [];
  return list
    .map((r): Candle => {
      const a = r as unknown[];
      return { t: n(a[0]), o: n(a[1]), h: n(a[2]), l: n(a[3]), c: n(a[4]) };
    })
    .filter(ok)
    .reverse();
}

function fromKucoin(raw: unknown): Candle[] {
  const list = (raw as { data?: unknown[] })?.data;
  if (!Array.isArray(list)) return [];
  return list
    .map((r): Candle => {
      const a = r as unknown[];
      // KuCoin: [ts, open, close, high, low, volume, turnover]
      return { t: n(a[0]) * 1000, o: n(a[1]), h: n(a[3]), l: n(a[4]), c: n(a[2]) };
    })
    .filter(ok)
    .reverse();
}

/** Тикер → торговая пара. kPEPE и xyz:NVDA у Hyperliquid — не биржевые имена. */
function pair(sym: string): string {
  let s = String(sym || "").toUpperCase().trim();
  s = s.replace(/^XYZ[:_]/, "");
  if (/^K(PEPE|SHIB|BONK|FLOKI|DOGS|NEIRO)$/.test(s)) s = s.slice(1);
  return s.replace(/[^A-Z0-9]/g, "");
}

export async function fetchCandles(
  sym: string,
  tf: Timeframe,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const base = pair(sym);
  if (!base || base === "USDT" || base === "USDC") return [];
  const shape = SHAPE[tf];
  const usdt = `${base}USDT`;

  const sources: [string, (raw: unknown) => Candle[]][] = [
    [`/klines?symbol=${usdt}&interval=${shape.binance}&limit=${shape.limit}`, fromBinance],
    [`/klines-vision?symbol=${usdt}&interval=${shape.binance}&limit=${shape.limit}`, fromBinance],
    [`/klines-bybit?category=spot&symbol=${usdt}&interval=${shape.bybit}&limit=${shape.limit}`, fromBybit],
    [`/klines-kucoin?symbol=${base}-USDT&type=${shape.kucoin}`, fromKucoin],
  ];

  for (const [url, parse] of sources) {
    const candles = parse(await grab(url, signal));
    if (candles.length >= 3) return candles.slice(-shape.limit);
    if (signal?.aborted) return [];
  }
  return [];
}

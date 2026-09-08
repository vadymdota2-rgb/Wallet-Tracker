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
import type { DictKey } from "../i18n/types";

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export type Timeframe = "15m" | "1h" | "4h" | "1d" | "1w" | "1M";

export const TIMEFRAMES: Timeframe[] = ["15m", "1h", "4h", "1d", "1w", "1M"];

/**
 * Имя таймфрейма — размер одной свечи, как на биржах. Раньше им обозначалась
 * ширина окна: «1M» рисовал месяц четырёхчасовыми свечами, и рядом с
 * терминалом это выглядело подменой — тот же график там назывался 4H.
 *
 * Свечей берём около сотни: столько влезает, не сливаясь в кашу.
 * У KuCoin месячных свечей нет вовсе — на этом таймфрейме к нему не идём.
 */
const SHAPE: Record<Timeframe, { binance: string; bybit: string; kucoin: string; limit: number }> = {
  "15m": { binance: "15m", bybit: "15", kucoin: "15min", limit: 96 },
  "1h": { binance: "1h", bybit: "60", kucoin: "1hour", limit: 120 },
  "4h": { binance: "4h", bybit: "240", kucoin: "4hour", limit: 120 },
  "1d": { binance: "1d", bybit: "D", kucoin: "1day", limit: 120 },
  "1w": { binance: "1w", bybit: "W", kucoin: "1week", limit: 104 },
  "1M": { binance: "1M", bybit: "M", kucoin: "", limit: 60 },
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
  ];
  if (shape.kucoin) {
    sources.push([`/klines-kucoin?symbol=${base}-USDT&type=${shape.kucoin}`, fromKucoin]);
  }

  for (const [url, parse] of sources) {
    const candles = parse(await grab(url, signal));
    if (candles.length >= 3) return candles.slice(-shape.limit);
    if (signal?.aborted) return [];
  }
  return [];
}

/** Подписи таймфреймов. Здесь же, чтобы список кнопок был один на все экраны. */
export const TF_LABEL: Record<Timeframe, DictKey> = {
  "15m": "ui_tf_15m",
  "1h": "ui_tf_1h",
  "4h": "ui_tf_4h",
  "1d": "ui_tf_1d",
  "1w": "ui_tf_1w",
  "1M": "ui_tf_1mo",
};

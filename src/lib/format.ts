/**
 * Числа и даты. Локаль берётся из выбранного языка, а не вшита: в прошлой
 * версии всюду стояла `ru-RU`, и разряды отделялись узким пробелом даже в
 * английском интерфейсе.
 */
import type { LangCode } from "../i18n/types";

let locale = "en";

export function setLocale(lang: LangCode): void {
  locale = lang;
}

function nf(opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(locale, opts);
  } catch {
    return new Intl.NumberFormat("en", opts);
  }
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Компактные деньги: $1.2M, $34.5K, $812. */
export function usd(v: unknown, sign = false): string {
  if (!isNum(v)) return "—";
  const a = Math.abs(v);
  const s = v < 0 ? "-" : sign && v > 0 ? "+" : "";
  if (a >= 1e9) return `${s}$${nf({ maximumFractionDigits: 2 }).format(a / 1e9)}B`;
  if (a >= 1e6) return `${s}$${nf({ maximumFractionDigits: 2 }).format(a / 1e6)}M`;
  if (a >= 1e3) return `${s}$${nf({ maximumFractionDigits: 1 }).format(a / 1e3)}K`;
  return `${s}$${nf({ maximumFractionDigits: a < 1 ? 4 : 2 }).format(a)}`;
}

/** Полная сумма с разрядами: $1 234 567. */
export function usdFull(v: unknown): string {
  if (!isNum(v)) return "—";
  return `$${nf({ maximumFractionDigits: 2 }).format(v)}`;
}

export function pct(v: unknown, digits = 1, sign = true): string {
  if (!isNum(v)) return "—";
  const s = sign && v > 0 ? "+" : "";
  return `${s}${nf({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v)}%`;
}

/**
 * Цена: число знаков зависит от масштаба. У монет за доли цента две цифры
 * после запятой превращают цену в $0.00.
 */
export function px(v: unknown): string {
  if (!isNum(v) || v === 0) return "—";
  const a = Math.abs(v);
  const digits = a >= 1000 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 8;
  return `$${nf({ maximumFractionDigits: digits }).format(v)}`;
}

export function num(v: unknown, digits = 0): string {
  if (!isNum(v)) return "—";
  return nf({ maximumFractionDigits: digits }).format(v);
}

export function signed(v: unknown): string {
  return usd(v, true);
}

export function shortAddr(a: string | undefined | null): string {
  const s = String(a || "");
  if (s.length < 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/** Кратность плеча: 5×. */
export function lev(v: unknown): string {
  return isNum(v) && v > 0 ? `${nf({ maximumFractionDigits: 1 }).format(v)}×` : "—";
}

/**
 * «5 минут назад» средствами Intl — на языке интерфейса.
 * Сервер шлёт готовую русскую строку; её сначала разбирает lib/relative.ts.
 */
export function since(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const table: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 3600],
    ["hour", 86400],
    ["day", 2592000],
    ["month", 31536000],
  ];
  let unit: Intl.RelativeTimeFormatUnit = "year";
  let div = 31536000;
  let prev = 1;
  for (const [u, limit] of table) {
    if (s < limit) {
      unit = u;
      div = prev;
      break;
    }
    prev = limit;
    div = limit;
  }
  const value = -Math.max(1, Math.floor(s / (unit === "second" ? 1 : div)));
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" }).format(value, unit);
  } catch {
    return `${Math.abs(value)}${unit[0]}`;
  }
}

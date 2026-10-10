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

/**
 * Процент: число знаков зависит от масштаба — как и у цены.
 *
 * Десятая доля важна, пока число маленькое: −1,1% и −1,6% — разные вещи. На
 * сотнях она не значит ничего, а место занимает: «+157,4%» не влезало в
 * плитку и обрезалось до «+157 …», по которому не отличить сто пятьдесят
 * семь процентов от ста пятидесяти семи тысяч. Обрезанное число хуже
 * округлённого.
 */
export function pct(v: unknown, digits = 1, sign = true): string {
  if (!isNum(v)) return "—";
  const s = sign && v > 0 ? "+" : "";
  const d = Math.abs(v) >= 100 ? 0 : digits;
  return `${s}${nf({ minimumFractionDigits: d, maximumFractionDigits: d }).format(v)}%`;
}

/**
 * Цена: число знаков зависит от масштаба. У монет за доли цента две цифры
 * после запятой превращают цену в $0.00.
 */
export function px(v: unknown): string {
  if (!isNum(v) || v === 0) return "—";
  const a = Math.abs(v);
  /* Выше десяти тысяч копейки снимаем. «$42 484,45» — десять знаков, и в
     плитке на 320 точках они не помещались: строка обрезалась многоточием и
     цена превращалась в «$42 484…», по которой не видно ни уровня, ни
     расстояния до него. Сорок пять центов на сорока двух тысячах не значат
     ничего, а лишние знаки стоили самого числа. */
  const digits = a >= 10000 ? 0 : a >= 1000 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 8;
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

/** Количество монет коротко: 1.41B, 93.75M, 36.8K. */
function qty(v: unknown): string {
  if (!isNum(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `${nf({ maximumFractionDigits: 2 }).format(v / 1e9)}B`;
  if (a >= 1e6) return `${nf({ maximumFractionDigits: 2 }).format(v / 1e6)}M`;
  if (a >= 1e3) return `${nf({ maximumFractionDigits: 1 }).format(v / 1e3)}K`;
  return nf({ maximumFractionDigits: 0 }).format(v);
}

/** Количество с разрядом словом на языке интерфейса: «548,36 млн»,
 *  «2,82 млрд». Буквы M и B в карточках путали: «548M» читалось больше,
 *  чем «2,82B», хотя это в пять раз меньше. */
export function qtyWord(v: unknown): string {
  if (!isNum(v)) return "—";
  if (Math.abs(v) < 1e4) return nf({ maximumFractionDigits: 0 }).format(v);
  try {
    return new Intl.NumberFormat(locale, {
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    return qty(v);
  }
}

/** Сумма в долларах с разрядом словом: «74,38 млн $», «2,35 млрд $». */
export function usdWord(v: unknown): string {
  if (!isNum(v)) return "—";
  if (Math.abs(v) < 1e4) return usd(v);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      notation: "compact",
      compactDisplay: "short",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    return usd(v);
  }
}

/** День календаря на языке интерфейса: «пн, 5 окт.»; год — если не текущий. */
export function day(tsSec: number, nowSec: number): string {
  const d = new Date(tsSec * 1000);
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" };
  if (d.getUTCFullYear() !== new Date(nowSec * 1000).getUTCFullYear()) opts.year = "numeric";
  try {
    return new Intl.DateTimeFormat(locale, opts).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Число и короткий месяц без дня недели: «11 окт.», для другого года —
 *  «26 мар. ’27». По UTC: экспирации назначены на дату биржи. Год
 *  дописывается сам: Intl в русском давал «26 мар. 27 г.», и в столбец дат
 *  это не влезало. */
export function dayMonth(tsSec: number, nowSec: number): string {
  const d = new Date(tsSec * 1000);
  let s: string;
  try {
    s = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
  } catch {
    s = d.toISOString().slice(5, 10);
  }
  const y = d.getUTCFullYear();
  return y !== new Date(nowSec * 1000).getUTCFullYear() ? `${s} ’${String(y).slice(2)}` : s;
}

/** Ровно два знака после запятой: «1,30», а не «1,3» — в столбце рядом с «1,44». */
export function fix2(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}

/** Дата словами: «19 октября»; год — если не текущий. По часам человека:
 *  «до какого числа» он читает по своему календарю. */
export function dateLong(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  try {
    return new Intl.DateTimeFormat(locale, opts).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Сколько осталось до дня: «сегодня», «завтра», «через 12 дн.». Считается
 *  по календарным дням UTC — разлоки назначены на дату, а не на час. */
export function untilDay(tsSec: number, nowSec: number): string {
  const days = Math.round((Math.floor(tsSec / 86400) * 86400 - Math.floor(nowSec / 86400) * 86400) / 86400);
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
    if (days >= 60) return rtf.format(Math.round(days / 30.4), "month");
    return rtf.format(days, "day");
  } catch {
    return `${days}d`;
  }
}

/**
 * «Институциональные потоки» — общее для вида (EtfScreen и EtfMore): цвета
 * притока и оттока, деньги и монеты словами, флаг страны. Расчёты — в
 * lib/etf.ts, здесь — только как показать.
 */
import { num, usdWord } from "../lib/format";

/** Приток — зелёный, отток — красный, как на биржах. */
export const UP = "#0ecb81";
export const DN = "#f6465d";

/** Число или сумма — отдельным куском текста: в арабском не перевернётся. */
export const iso = (x: string | number) => `⁦${x}⁩`;

/** Деньги со знаком словом: «+148,7 млн $», «−1,2 млрд $». */
export function money(v: number): string {
  if (Math.abs(v) < 0.5) return usdWord(0);
  return `${v > 0 ? "+" : "−"}${usdWord(Math.abs(v))}`;
}

/** Монеты коротко: «1,29 млн», «40,4 тыс.»; signed — со знаком «+/−». */
export function coinsShort(lang: string, v: number, sym: string, signed = true): string {
  const s = !signed ? "" : v > 0 ? "+" : v < 0 ? "−" : "";
  try {
    const f = new Intl.NumberFormat(lang, { notation: "compact", compactDisplay: "short", maximumFractionDigits: signed ? 1 : 2 })
      .format(Math.abs(v)).replace(/[  ]/g, " ");
    return `${s}${f}${sym ? ` ${sym}` : ""}`;
  } catch {
    return `${s}${num(Math.abs(v))}${sym ? ` ${sym}` : ""}`;
  }
}

/** Флаг страны по коду ISO: «US» → 🇺🇸; не код — пусто. */
export function flagOf(code?: string): string {
  return code && /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : "";
}

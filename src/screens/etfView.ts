/**
 * «Институциональные потоки» — общее для вида (EtfScreen и EtfMore): цвета
 * притока и оттока, деньги и монеты словами, флаг страны. Расчёты — в
 * lib/etf.ts, здесь — только как показать.
 */
import { useLayoutEffect, useState, type RefObject } from "react";
import { num, usdWord } from "../lib/format";
import { dateStr } from "./timeAxis";

/* Потоки и активы фондов, цена дня — открытый набор TFTC под лицензией CC BY 4.0:
   условие — подпись источника со ссылкой и ссылка на лицензию рядом с
   данными, везде, где их показываем (экран потоков, дайджест). */
export const TFTC_URL = "https://www.tftc.io/bitcoin-etf-flows";
export const CCBY_URL = "https://creativecommons.org/licenses/by/4.0/";

/** Приток — зелёный, отток — красный, как на биржах. */
export const UP = "#0ecb81";
export const DN = "#f6465d";
/** Класс цвета по знаку (стили — .ef .up / .ef .dn): ноль — без цвета, зелёный «0 $» читался бы как приток. */
export const tone = (v: number): "up" | "dn" | "" => (v > 0 ? "up" : v < 0 ? "dn" : "");

/** Число или сумма — отдельным куском текста: в арабском не перевернётся. */
export const iso = (x: string | number) => `⁦${x}⁩`;

/** Деньги со знаком словом: «+148,7 млн $», «−1,2 млрд $». */
export function money(v: number): string {
  if (Math.abs(v) < 0.5) return usdWord(0);
  return `${v > 0 ? "+" : "−"}${usdWord(Math.abs(v))}`;
}

/** Монеты коротко: «1,29 млн», «40,4 тыс.»; signed — со знаком «+/−». Число
 *  с «тыс.» — одним куском: в узкой плитке перенос перед «BTC», а не
 *  «+115,2 / тыс. BTC». */
export function coinsShort(lang: string, v: number, sym: string, signed = true): string {
  const s = !signed ? "" : v > 0 ? "+" : v < 0 ? "−" : "";
  try {
    const f = new Intl.NumberFormat(lang, { notation: "compact", compactDisplay: "short", maximumFractionDigits: signed ? 1 : 2 })
      .format(Math.abs(v)).replace(/[ \u202f]/g, "\u00a0");
    return `${s}${f}${sym ? ` ${sym}` : ""}`;
  } catch {
    return `${s}${num(Math.abs(v))}${sym ? ` ${sym}` : ""}`;
  }
}

/** Китайский, японский, корейский: перенос там разрешён между любыми знаками. */
const CJK = /[\u3000-\u9fff\uac00-\ud7af]/;
const YEAR = new Set(["年", "년"]);

/** Дата одним куском: «30 июн. 2026 г.» не рвётся посередине и не оставляет «г.» одно на строке.
 *  В китайском и японском пробелов нет, а перенос разрешён между любыми знаками:
 *  «2026年6 / 月30日», в корейском — между слогами («6 / 일»): знаки склеены (U+2060). */
export function dateNb(lang: string, ts: number, opts: Intl.DateTimeFormatOptions): string {
  const s = dateStr(lang as Parameters<typeof dateStr>[0], ts, opts).replace(/ /g, "\u00a0");
  return CJK.test(s) ? [...s].join("\u2060") : s;
}

/** Дата для узкой плитки: целиком не влезает, поэтому перенос — только перед
 *  годом («6 мая / 2025 г.», «2025年 / 5月6日»), а не после предлога и не
 *  посреди числа месяца. */
export function dateWrap(lang: string, ts: number, opts: Intl.DateTimeFormatOptions): string {
  const s = dateStr(lang as Parameters<typeof dateStr>[0], ts, opts);
  if (!CJK.test(s)) return s.replace(/ (?!\d{4})/g, "\u00a0");
  // После «年»/«년» — можно, в остальных местах — склейка, пробел — неразрывный.
  return [...s].map((ch, i, all) => {
    // Свободно сразу после «年»/«년» и после пробела за ним («2025년 / 5월»).
    const free = i > 0 && (YEAR.has(all[i - 1]!) || (all[i - 1] === " " && i > 1 && YEAR.has(all[i - 2]!)));
    if (ch === " ") return free ? " " : "\u00a0";
    return (i && !free ? "\u2060" : "") + ch;
  }).join("");
}

/** Флаг страны по коду ISO: «US» → 🇺🇸; не код — пусто. */
export function flagOf(code?: string): string {
  return code && /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : "";
}

/** Уже этого график не рисуется: подписи осей не поместились бы. */
const MIN_W = 240;

/**
 * Ширина элемента в пикселях, с подпиской на изменения (поворот экрана,
 * окно на компьютере, крупный шрифт). Графики рисуются в этих пикселях — не
 * растягиваются. Сдвиг меньше 2 px не считается: иначе полоса прокрутки,
 * появившись от новой высоты графика, могла бы раскачать ширину туда-обратно.
 */
export function useWidth(ref: RefObject<Element | null>, fallback = 330): number {
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const set = (x: number) => {
      if (x > 0) setW((prev) => (Math.abs(prev - x) >= 2 ? Math.round(x) : prev));
    };
    set(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver((es) => {
      const e = es[0];
      if (e) set(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return Math.max(MIN_W, w);
}

/**
 * Во сколько раз график выше обычного: на широком экране — выше (до 1,45),
 * но так, чтобы целиком помещался по высоте окна (телефон боком — 390 px):
 * base — высота графика при множителе 1.
 */
export function heightK(w: number, base: number): number {
  const k = Math.min(1.45, Math.max(1, w / 420));
  const h = typeof window === "undefined" ? Infinity : window.innerHeight;
  return Math.max(0.7, Math.min(k, (h * 0.72) / base));
}

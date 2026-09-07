/**
 * whale_api.py отдаёт время готовой строкой: «5 сек», «12 мин», «3 ч», «2 д».
 * Она собирается на сервере по-русски и уезжает всем шестнадцати языкам.
 *
 * Здесь строка разбирается обратно в секунды, чтобы показать её на языке
 * интерфейса. Разобрать не удалось — отдаём как есть: пусть лучше по-русски,
 * чем пусто.
 */
import { since } from "./format";

const UNITS: [RegExp, number][] = [
  [/^\s*(\d+)\s*(?:сек|s|sec)/i, 1],
  [/^\s*(\d+)\s*(?:мин|m|min)/i, 60],
  [/^\s*(\d+)\s*(?:ч|h|hr)/i, 3600],
  [/^\s*(\d+)\s*(?:д|d|day)/i, 86400],
];

/** Секунды из серверной строки, либо null. */
export function parseAgo(raw: string | undefined | null): number | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  for (const [re, mult] of UNITS) {
    const m = s.match(re);
    if (m && m[1] !== undefined) return Number(m[1]) * mult;
  }
  return null;
}

/** Серверная строка → «5 минут назад» на языке интерфейса. */
export function ago(raw: string | undefined | null): string {
  const sec = parseAgo(raw);
  return sec === null ? String(raw || "") : since(sec);
}

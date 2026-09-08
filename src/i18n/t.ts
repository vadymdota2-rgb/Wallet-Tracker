import { dictFor } from "./index";
import type { DictKey, LangCode } from "./types";

/**
 * Перевод с подстановкой: `t(lang, "rk_days", { n: 30 })` заменит `{n}`.
 * Неизвестный ключ вернётся как есть — это видно на экране и чинится сразу,
 * в отличие от пустой строки.
 */
export function t(lang: LangCode, key: DictKey, params?: Record<string, string | number>): string {
  const raw = dictFor(lang)[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = params[name];
    return v === undefined ? m : String(v);
  });
}

/**
 * Тексты бота часто начинаются с эмодзи: «➕ Add Wallet». В мини-аппе иконка
 * рисуется отдельно, поэтому ведущий значок снимаем.
 */
export function bare(s: string): string {
  return s.replace(/^[\p{Extended_Pictographic}←-⇿⬀-⯿️‍\s]+/u, "").trim() || s;
}

/** Ведущий эмодзи строки — когда наоборот нужен только значок. */
export function icon(s: string): string {
  const m = s.match(/^[\p{Extended_Pictographic}️‍]+/u);
  return m ? m[0].trim() : "";
}

/**
 * Первая строка длинного текста бота и всё остальное отдельно. В чате это
 * одно сообщение: заголовок, пустая строка, пояснение. На экране заголовок
 * набран капителью с разрядкой, и абзац пояснения, загнанный в неё целиком,
 * читать невозможно.
 */
export function split(s: string): [string, string] {
  const i = s.indexOf("\n");
  if (i < 0) return [s.trim(), ""];
  return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
}

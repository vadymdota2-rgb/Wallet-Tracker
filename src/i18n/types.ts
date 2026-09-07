/**
 * Английский словарь задаёт набор ключей. Остальные объявлены как `Dict`,
 * то есть Record без Partial: пропустишь ключ — сборка встанет и назовёт его.
 *
 * В прошлой версии словари были `Partial<Dict>`, недостающее молча
 * подменялось английским, и арабский годами жил с 29 ключами из 427.
 */
import type { en } from "./en";

export type DictKey = keyof typeof en;
export type Dict = Record<DictKey, string>;

export type LangCode =
  | "en" | "ru" | "uk" | "vi" | "ko" | "zh" | "ja" | "es"
  | "pt" | "fr" | "de" | "tr" | "hi" | "id" | "ar" | "pl";

/**
 * Реестр языков. Набор и порядок — как в боте WhaleScanner.
 *
 * Шестнадцать словарей весят 317 КБ. Держать их все в первом же файле
 * незачем: человеку нужен один. Английский вшит — он и запасной вариант, и
 * источник набора ключей; остальные подгружаются отдельным куском при выборе.
 */
import { en } from "./en";
import type { Dict, LangCode } from "./types";

export type { Dict, DictKey, LangCode } from "./types";

export const LANGS: { id: LangCode; name: string; flag: string }[] = [
  { id: "en", name: "English", flag: "🇬🇧" },
  { id: "ru", name: "Русский", flag: "🇷🇺" },
  { id: "uk", name: "Українська", flag: "🇺🇦" },
  { id: "vi", name: "Tiếng Việt", flag: "🇻🇳" },
  { id: "ko", name: "한국어", flag: "🇰🇷" },
  { id: "zh", name: "中文", flag: "🇨🇳" },
  { id: "ja", name: "日本語", flag: "🇯🇵" },
  { id: "es", name: "Español", flag: "🇪🇸" },
  { id: "pt", name: "Português", flag: "🇵🇹" },
  { id: "fr", name: "Français", flag: "🇫🇷" },
  { id: "de", name: "Deutsch", flag: "🇩🇪" },
  { id: "tr", name: "Türkçe", flag: "🇹🇷" },
  { id: "hi", name: "हिन्दी", flag: "🇮🇳" },
  { id: "id", name: "Bahasa Indonesia", flag: "🇮🇩" },
  { id: "ar", name: "العربية", flag: "🇸🇦" },
  { id: "pl", name: "Polski", flag: "🇵🇱" },
];

/** Языки с письмом справа налево — им нужен dir="rtl". */
const RTL = new Set<LangCode>(["ar"]);

export function isRtl(code: LangCode): boolean {
  return RTL.has(code);
}

const LOADERS: Record<Exclude<LangCode, "en">, () => Promise<Dict>> = {
  ru: () => import("./ru").then((m) => m.ru),
  uk: () => import("./uk").then((m) => m.uk),
  vi: () => import("./vi").then((m) => m.vi),
  ko: () => import("./ko").then((m) => m.ko),
  zh: () => import("./zh").then((m) => m.zh),
  ja: () => import("./ja").then((m) => m.ja),
  es: () => import("./es").then((m) => m.es),
  pt: () => import("./pt").then((m) => m.pt),
  fr: () => import("./fr").then((m) => m.fr),
  de: () => import("./de").then((m) => m.de),
  tr: () => import("./tr").then((m) => m.tr),
  hi: () => import("./hi").then((m) => m.hi),
  id: () => import("./id").then((m) => m.id),
  ar: () => import("./ar").then((m) => m.ar),
  pl: () => import("./pl").then((m) => m.pl),
};

const loaded: Partial<Record<LangCode, Dict>> = { en };

export function dictFor(code: LangCode): Dict {
  return loaded[code] ?? en;
}

/** Подгружает словарь. Не вышло — остаёмся на английском, а не на пустом экране. */
export async function ensureLang(code: LangCode): Promise<void> {
  if (loaded[code]) return;
  const load = LOADERS[code as Exclude<LangCode, "en">];
  if (!load) return;
  try {
    loaded[code] = await load();
  } catch {
    /* сеть подведёт — английский на месте */
  }
}

/** Код Telegram (`ru-RU`, `zh-Hans`) → поддерживаемый язык. */
export function normalizeLang(raw: string | undefined | null): LangCode | null {
  const code = String(raw || "").toLowerCase().replace("_", "-").split("-")[0];
  if (!code) return null;
  const hit = LANGS.find((l) => l.id === code);
  return hit ? hit.id : null;
}

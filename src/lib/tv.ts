/*
 * Окна виджетов TradingView для меню (components/Markets.tsx): какие рынки,
 * на каком языке и адрес окна. Без React и без сети — проверяется тестами
 * (tests/tv.test.ts).
 */
import type { LangCode } from "../i18n/types";

export const TV_WIDGET = "https://www.tradingview-widget.com";
export const TV_SITE = "https://www.tradingview.com/";

/** Шесть рынков — в порядке экрана; подпись — как есть или ключ перевода. */
export const TV_SYMBOLS: readonly { s: string; t: string }[] = [
  { s: "CAPITALCOM:US500", t: "US 500" }, { s: "CAPITALCOM:US100", t: "US 100" },
  { s: "CAPITALCOM:DXY", t: "DXY" }, { s: "TVC:GOLD", t: "mk_gold" },
  { s: "FRED:DGS10", t: "US 10Y" }, { s: "DERIBIT:DVOL", t: "DVOL" },
];

/** Язык приложения → язык виджетов TradingView (украинского у них нет — английский). */
export const TV_LOCALE: Record<LangCode, string> = {
  en: "en", ru: "ru", uk: "en", vi: "vi_VN", ko: "kr", zh: "zh_CN", ja: "ja", es: "es",
  pt: "br", fr: "fr", de: "de_DE", tr: "tr", hi: "in", id: "id", ar: "ar_AE", pl: "pl",
};

/** Ширина и высота окна виджета «Tickers»: уже TV_W TradingView обрезает
 *  подписи и прячет цифры под значком, высота у виджета своя. */
export const TV_W = 172;
export const TV_H = 72;

/** Во сколько раз уменьшить окно, чтобы оно легло в ячейку ширины w (не
 *  увеличиваем; совсем узкая или нулевая ячейка — не мельче трети). */
export function tvScale(w: number): number {
  if (!Number.isFinite(w) || w <= 0) return 1;
  return Math.min(1, Math.max(1 / 3, w / TV_W));
}

/** Песочница окна: их скрипты — в их источнике, ссылки — в новом окне. */
export const TV_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/** Адрес окна виджета «Tickers» — как у скрипта TradingView, но страница —
 *  только домен и путь (после «#» у Telegram данные входа). */
export function tvSrc(symbol: string, title: string, locale: string, host: string, path: string): string {
  const cfg = {
    symbols: [{ proName: symbol, title }], colorTheme: "dark", isTransparent: true, showSymbolLogo: false,
    utm_source: host, utm_medium: "widget", utm_campaign: "tickers", "page-uri": `${host}${path}`,
  };
  return `${TV_WIDGET}/embed-widget/tickers/?locale=${encodeURIComponent(locale)}#${encodeURIComponent(JSON.stringify(cfg))}`;
}

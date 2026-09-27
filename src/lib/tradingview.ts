/**
 * График TradingView: символ и адрес встраиваемого окна.
 *
 * Встраиваем их готовое окно (widgetembed), а не библиотеку: в нём уже есть
 * все таймфреймы, индикаторы, рисование и собственный поиск по любым
 * инструментам, а скриптов со стороннего сервера в наше приложение не
 * пускаем — окно живёт в своём iframe.
 */
import type { LangCode as Lang } from "../i18n";

/** Биржи TradingView: символ с такой приставкой человек ввёл сам целиком. */
const TV_EXCHANGES = new Set([
  "BINANCE", "BYBIT", "OKX", "COINBASE", "KRAKEN", "KUCOIN", "MEXC", "GATEIO", "BITGET", "BINGX",
  "HTX", "PANCAKESWAP", "UNISWAP", "CRYPTO", "CRYPTOCAP", "NASDAQ", "NYSE", "AMEX", "TVC", "OANDA",
  "CAPITALCOM", "FX", "SP", "CME", "COMEX", "NYMEX", "INDEX",
]);

/**
 * Тикер из приложения → символ TradingView.
 *
 * Монета — парой к USDT без биржи: TradingView сам выберет площадку, где пара
 * торгуется, и так открываются не только монеты Binance. kPEPE у Hyperliquid —
 * это PEPE, умноженный на тысячу; xyz:NVDA — акция NVDA на площадке HIP-3.
 * Полный символ вроде BINANCE:BTCUSDT или NASDAQ:NVDA идёт как есть.
 */
export function tvSymbol(raw: string): string {
  let s = String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return "BTCUSDT";
  const colon = s.indexOf(":");
  if (colon > 0) {
    const pre = s.slice(0, colon);
    if (TV_EXCHANGES.has(pre)) return s;
    // Площадка HIP-3 (xyz:, flx:, …) — это акции, индексы и металлы.
    return s.slice(colon + 1).replace(/[^A-Z0-9.!]/g, "") || "BTCUSDT";
  }
  if (/^K(PEPE|SHIB|BONK|FLOKI|DOGS|NEIRO)$/.test(s)) s = s.slice(1);
  s = s.replace(/[^A-Z0-9.]/g, "");
  if (/(USDT|USDC|USD|PERP|BTC|ETH)$/.test(s) && s.length > 4) return s;
  return `${s}USDT`;
}

/** Язык окна TradingView — их коды отличаются от наших. */
const TV_LOCALE: Record<Lang, string> = {
  en: "en", ru: "ru", es: "es", pt: "br", fr: "fr", tr: "tr", ar: "ar_AE", pl: "pl",
  de: "de_DE", uk: "uk", hi: "in", id: "id", vi: "vi", ko: "kr", zh: "zh_CN", ja: "ja",
};

export function tvUrl(symbol: string, lang: Lang): string {
  const q = new URLSearchParams({
    symbol,
    interval: "60",
    theme: "dark",
    style: "1",
    locale: TV_LOCALE[lang] ?? "en",
    timezone: "Etc/UTC",
    toolbarbg: "01030A",
    // Поиск монет и смена таймфрейма — прямо в окне графика.
    symboledit: "1",
    allow_symbol_change: "1",
    withdateranges: "1",
    hidesidetoolbar: "0",
    saveimage: "0",
    hideideas: "1",
    studies: "[]",
  });
  return `https://s.tradingview.com/widgetembed/?${q.toString()}`;
}

/**
 * График TradingView: символ и адрес встраиваемого окна.
 *
 * Встраиваем их официальным кодом виджета «Advanced Chart», как его выдаёт
 * конструктор на tradingview.com/widget: их скрипт сам создаёт окно графика и
 * строку атрибуции «Track all markets on TradingView». Их правила требуют,
 * чтобы атрибуция оставалась такой, какой задумана, и была видна всегда, —
 * поэтому ни окно, ни строку мы не собираем сами. В окне уже есть все
 * таймфреймы, индикаторы, рисование и поиск по любым инструментам.
 */
import type { LangCode as Lang } from "../i18n";

/** Биржи TradingView: символ с такой приставкой человек ввёл сам целиком. */
const TV_EXCHANGES = new Set([
  "BINANCE", "BYBIT", "OKX", "COINBASE", "KRAKEN", "KUCOIN", "MEXC", "GATEIO", "BITGET", "BINGX",
  "HTX", "PANCAKESWAP", "UNISWAP", "CRYPTO", "CRYPTOCAP", "NASDAQ", "NYSE", "AMEX", "TVC", "OANDA",
  "CAPITALCOM", "FX", "SP", "CME", "COMEX", "NYMEX", "INDEX",
]);

/* Площадки HIP-3 торгуют металлами, нефтью и индексами под короткими именами.
   На TradingView те же буквы — чужие бумаги: GOLD там акция Barrick Gold, а
   не золото. Поэтому ходовые — сразу на их символы TradingView. */
const HIP3_TV: Record<string, string> = {
  GOLD: "TVC:GOLD", SILVER: "TVC:SILVER", PLATINUM: "TVC:PLATINUM", PALLADIUM: "TVC:PALLADIUM",
  COPPER: "COMEX:HG1!", CL: "TVC:USOIL", WTI: "TVC:USOIL", BRENTOIL: "TVC:UKOIL", NATGAS: "NYMEX:NG1!",
  SP500: "SP:SPX", SPX: "SP:SPX", XYZ100: "NASDAQ:NDX", NDX: "NASDAQ:NDX", DJI: "TVC:DJI",
  JPN225: "TVC:NI225", DXY: "TVC:DXY", VIX: "TVC:VIX",
};

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
    const bare = s.slice(colon + 1).replace(/[^A-Z0-9.!]/g, "");
    return HIP3_TV[bare] ?? (bare || "BTCUSDT");
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

/** Официальный скрипт виджета «Advanced Chart» — тот, что выдаёт их
 *  конструктор виджетов. Он сам создаёт окно графика и оформляет строку
 *  атрибуции TradingView (13px, как требуют их правила). */
export const TV_EMBED_SRC = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

/** Настройки виджета — те же поля, что в их конструкторе. */
export function tvConfig(symbol: string, lang: Lang): Record<string, unknown> {
  return {
    autosize: true,
    symbol,
    interval: "60",
    timezone: "Etc/UTC",
    theme: "dark",
    style: "1",
    locale: TV_LOCALE[lang] ?? "en",
    backgroundColor: "#01030A",
    // Поиск монет и смена таймфрейма — прямо в окне графика.
    allow_symbol_change: true,
    withdateranges: true,
    hide_side_toolbar: false,
    save_image: false,
    calendar: false,
    support_host: "https://www.tradingview.com",
  };
}

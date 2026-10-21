/**
 * Источник доминации — по условиям API CoinMarketCap: рядом с цифрами и со
 * ссылкой на сайт («Капитализация и доминация — по данным CoinMarketCap»).
 * Один на экран доминации и раздел «Рынок» дайджеста.
 */
import { t } from "../i18n/t";
import { openExternal } from "../lib/telegram";

type Lang = Parameters<typeof t>[0];

export const CMC_URL = "https://coinmarketcap.com/";

export function CmcBy({ lang }: { lang: Lang }) {
  const [before = "", after = ""] = t(lang, "dm_d_src").split("CoinMarketCap");
  return (
    <>
      {before}
      <a href={CMC_URL} rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); openExternal(CMC_URL); }}>CoinMarketCap</a>
      {after}
    </>
  );
}

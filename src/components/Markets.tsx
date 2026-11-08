/*
 * Рынки для криптотрейдера сверху бокового меню, сетка 3 × 3: S&P 500,
 * Nasdaq 100, DXY · золото, US 10Y, DVOL · BTC.D, USDT.D, ETH/BTC. Мелко и
 * приглушённо: видно, но в глаза не бросается.
 * Пока данных нет (без подписки, сервер молчит, ответ битый) — прежний
 * заголовок меню. Открытое меню обновляет рынки раз в минуту.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey, LangCode } from "../i18n/types";
import { num } from "../lib/format";
import { fetchMarkets, peekMarkets, refreshMarkets } from "../lib/api";
import { change, digits, isPercent, type MarketItem, type MarketKey, type MarketsReply } from "../lib/markets";

const EVERY = 60_000;

/** Подписи: имена индексов и бирж — как есть на всех языках, металлы — переводом. */
const LABEL: Record<MarketKey, string | DictKey> = {
  SP500: "S&P 500", NDX: "Nasdaq 100", DXY: "DXY", GOLD: "mk_gold", US10Y: "US 10Y", DVOL: "DVOL",
  BTCD: "BTC.D", USDTD: "USDT.D", ETHBTC: "ETH/BTC",
};
const isKey = (l: string): l is DictKey => l.startsWith("mk_");
const HINT: Partial<Record<MarketKey, DictKey>> = { DXY: "mk_dxy_hint", DVOL: "mk_dvol_hint", NDX: "mk_ndx_hint", USDTD: "mk_usdtd_hint" };

function Cell({ it, lang }: { it: MarketItem; lang: LangCode }) {
  const l = LABEL[it.k];
  const name = isKey(l) ? t(lang, l) : l;
  const ch = change(it);
  const d = ch.unit === "bp" ? 1 : 2;
  const v = Number(ch.v.toFixed(d));
  const dir = v > 0 ? "up" : v < 0 ? "dn" : "";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  const txt = ch.unit === "bp" ? `${sign}${num(Math.abs(v), 1)} ${t(lang, "mk_bp")}` : `${sign}${num(Math.abs(v), 2, 2)}%`;
  const hint = HINT[it.k];
  const p = digits(it);
  return (
    <div className="mk-cell" title={hint ? t(lang, hint) : undefined} data-k={it.k}>
      <span className="mk-k">{name}</span>
      <b className="mk-px">{num(it.px, p, p)}{isPercent(it.k) ? "%" : ""}</b>
      <span className={`mk-ch ${dir}`}>{txt}</span>
    </div>
  );
}

export function MarketsStrip({ fallback }: { fallback: ReactNode }) {
  const lang = useApp((s) => s.lang);
  const [m, setM] = useState<MarketsReply | null>(() => peekMarkets() ?? null);
  useEffect(() => {
    let alive = true;
    const put = (r: MarketsReply | null) => {
      if (alive && r) setM(r);
    };
    void fetchMarkets().then(put);
    const id = window.setInterval(() => void refreshMarkets().then(put), EVERY);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  if (!m) return <>{fallback}</>;
  return (
    <section className="mk" aria-label={t(lang, "mk_title")}>
      <div className="mk-grid">
        {m.items.map((it) => <Cell key={it.k} it={it} lang={lang} />)}
      </div>
      <p className="mk-src">{t(lang, "mk_src")}</p>
    </section>
  );
}

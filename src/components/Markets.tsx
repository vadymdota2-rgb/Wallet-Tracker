/*
 * Рынки сверху бокового меню, сетка 3 × 3: S&P 500, XYZ100, DXY · золото,
 * нефть WTI, US 10Y · BVIV, BTC.D, USDT.D. Мелко и приглушённо: видно, но в
 * глаза не бросается.
 * Под сеткой — источники (CoinMarketCap — ссылкой, как требуют его условия)
 * и «ⓘ»: оговорки о товарных знаках и о том, что это
 * цены контрактов, а не значения индексов. Раскрываются касанием —
 * всплывающих подсказок на телефоне нет.
 * Пока данных нет (без подписки, сервер молчит, ответ битый или старый) —
 * прежний заголовок меню. Открытое меню обновляет рынки раз в минуту.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey, LangCode } from "../i18n/types";
import { num } from "../lib/format";
import { fetchMarkets, peekMarkets, refreshMarkets } from "../lib/api";
import { openExternal } from "../lib/telegram";
import { CMC_URL } from "./CmcBy";
import "./Markets.css";
import { change, digits, isPercent, type MarketItem, type MarketKey, type MarketsReply } from "../lib/markets";

const EVERY = 60_000;

/** Подписи: имена индексов и тикеры — как есть на всех языках, золото и нефть — переводом. */
const LABEL: Record<MarketKey, string | DictKey> = {
  SP500: "S&P 500", XYZ100: "XYZ100", DXY: "DXY", GOLD: "mk_gold", OIL: "mk_oil", US10Y: "US 10Y",
  BVIV: "BVIV", BTCD: "BTC.D", USDTD: "USDT.D",
};
const isKey = (l: string): l is DictKey => l.startsWith("mk_");
/** Оговорки по пунктам — в порядке экрана. */
const HINT: Partial<Record<MarketKey, DictKey>> = {
  SP500: "mk_sp_hint", XYZ100: "mk_xyz_hint", DXY: "mk_dxy_hint", OIL: "mk_oil_hint", US10Y: "mk_10y_hint",
  BVIV: "mk_bviv_hint", USDTD: "mk_usdtd_hint",
};

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

/** Источники; CoinMarketCap — ссылкой на сайт. tail («ⓘ») не отрывается от
 *  последнего слова на перенос. */
function Sources({ lang, tail }: { lang: LangCode; tail: ReactNode }) {
  const [before = "", after = ""] = t(lang, "mk_src").split("CoinMarketCap");
  return (
    <>
      {before}
      <span className="mk-nw">
        <a href={CMC_URL} rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); openExternal(CMC_URL); }}>CoinMarketCap</a>
        {after}{tail}
      </span>
    </>
  );
}

export function MarketsStrip({ fallback }: { fallback: ReactNode }) {
  const lang = useApp((s) => s.lang);
  const [m, setM] = useState<MarketsReply | null>(() => peekMarkets() ?? null);
  const [open, setOpen] = useState(false);
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
  const notes = m.items.flatMap((it) => {
    const h = HINT[it.k];
    return h ? [h] : [];
  });
  return (
    <section className="mk" aria-label={t(lang, "mk_title")}>
      <div className="mk-grid">
        {m.items.map((it) => <Cell key={it.k} it={it} lang={lang} />)}
      </div>
      <p className="mk-src">
        <Sources lang={lang} tail={notes.length ? (
          <button type="button" className="mk-i" aria-expanded={open} aria-label={t(lang, "mk_about")}
            onClick={() => setOpen((o) => !o)}>ⓘ</button>
        ) : null} />
      </p>
      {open && notes.length ? (
        <ul className="mk-notes">{notes.map((h) => <li key={h}>{t(lang, h)}</li>)}</ul>
      ) : null}
    </section>
  );
}

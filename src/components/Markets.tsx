/*
 * Рынки сверху бокового меню, сетка 3 × 3: S&P 500, XYZ100, DXY · золото,
 * нефть WTI, US 10Y · BVIV, BTC.D, USDT.D. Мелко и приглушённо: видно, но в
 * глаза не бросается.
 *
 * Ячейка: подпись, цена, изменение и тонкая полоска внизу — её длина —
 * величина изменения за сутки (barShare), цвет — направление: что двигалось
 * сильно, видно, не читая цифр. Касание ячейки раскрывает её пояснение (что
 * это за рынок, оговорки о правах); «ⓘ» под сеткой — все пояснения сразу.
 * Всплывающих подсказок на телефоне нет — поэтому касанием.
 * Сверху — «Рынки» и когда обновлено; старше MARKETS_STALE_MIN — жёлтым.
 * Под сеткой — источники (CoinMarketCap — ссылкой, как требуют его условия).
 *
 * Открытое меню сразу показывает последний ответ с устройства (не старше
 * шести часов, с «N мин назад»), свежий догружается. Ни копии, ни ответа —
 * скелет сетки (меню не прыгает); нет данных совсем (без подписки, сервер
 * молчит, ответ битый или старый) — прежний заголовок меню.
 * Открытое меню обновляет рынки раз в минуту, свёрнутое приложение — не
 * трогает сеть, а вернулись — сразу (если прошлый ответ старше минуты). Цена изменилась — ячейка коротко
 * вспыхивает цветом (без движения, если система просит меньше анимации).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey, LangCode } from "../i18n/types";
import { num } from "../lib/format";
import { fetchMarkets, peekMarkets, refreshMarkets } from "../lib/api";
import { openExternal } from "../lib/telegram";
import { CMC_URL } from "./CmcBy";
import "./Markets.css";
import {
  MARKETS_STALE_MIN, MARKET_KEYS, ageMin, barShare, change, digits, isPercent,
  type MarketItem, type MarketKey, type MarketsReply,
} from "../lib/markets";

const EVERY = 60_000;
const FLASH_MS = 900;

/** Подписи: имена индексов и тикеры — как есть на всех языках, золото и нефть — переводом. */
const LABEL: Record<MarketKey, string | DictKey> = {
  SP500: "S&P 500", XYZ100: "XYZ100", DXY: "DXY", GOLD: "mk_gold", OIL: "mk_oil", US10Y: "US 10Y",
  BVIV: "BVIV", BTCD: "BTC.D", USDTD: "USDT.D",
};
const isKey = (l: string): l is DictKey => l.startsWith("mk_");
/** Пояснения по пунктам — в порядке экрана. */
const HINT: Partial<Record<MarketKey, DictKey>> = {
  SP500: "mk_sp_hint", XYZ100: "mk_xyz_hint", DXY: "mk_dxy_hint", OIL: "mk_oil_hint", US10Y: "mk_10y_hint",
  BVIV: "mk_bviv_hint", USDTD: "mk_usdtd_hint",
};

interface CellProps {
  it: MarketItem; lang: LangCode; on: boolean; flash: "" | "up" | "dn"; note: string; pick: (k: MarketKey) => void;
}

function Cell({ it, lang, on, flash, note, pick }: CellProps) {
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
  const body = (
    <>
      <span className="mk-k">{name}</span>
      <b className="mk-px">{num(it.px, p, p)}{isPercent(it.k) ? "%" : ""}</b>
      <span className={`mk-ch ${dir}`}>{txt}</span>
      <i className={`mk-bar ${dir}`} style={{ inlineSize: `calc((100% - 14px) * ${v ? barShare(it) : 0})` }} aria-hidden="true" />
    </>
  );
  const cls = `mk-cell${flash ? ` mk-flash-${flash}` : ""}`;
  if (!hint) return <div className={cls} data-k={it.k}>{body}</div>;
  return (
    <button type="button" className={cls} data-k={it.k} title={t(lang, hint)} aria-expanded={on} aria-controls={note}
      onClick={() => pick(it.k)}>{body}</button>
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

/** Скелет сетки, пока ждём первый ответ: меню не прыгает. */
function Skeleton({ lang }: { lang: LangCode }) {
  return (
    <section className="mk mk-skel" aria-label={t(lang, "mk_title")} aria-busy="true">
      <div className="mk-head"><span className="mk-ttl">{t(lang, "mk_title")}</span></div>
      <div className="mk-grid">{MARKET_KEYS.map((k) => <div key={k} className="mk-cell"><i /><i /><i /></div>)}</div>
    </section>
  );
}

export function MarketsStrip({ fallback }: { fallback: ReactNode }) {
  const lang = useApp((s) => s.lang);
  const [m, setM] = useState<MarketsReply | null>(() => peekMarkets() ?? null);
  const [waiting, setWaiting] = useState(() => m === null);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<MarketKey | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [flash, setFlash] = useState<Partial<Record<MarketKey, "up" | "dn">>>({});
  const last = useRef<MarketsReply | null>(m);
  const noteId = useId();
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const put = (r: MarketsReply | null) => {
      if (!alive) return;
      setWaiting(false);
      setNow(Date.now() / 1000);
      if (!r) return;
      // Что изменилось с прошлого ответа — коротко вспыхивает своим цветом.
      const before = new Map((last.current?.items ?? []).map((x) => [x.k, x.px]));
      const lit: Partial<Record<MarketKey, "up" | "dn">> = {};
      for (const x of r.items) {
        const b = before.get(x.k);
        if (b !== undefined && b !== x.px) lit[x.k] = x.px > b ? "up" : "dn";
      }
      last.current = r;
      setM(r);
      if (Object.keys(lit).length) {
        setFlash(lit);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => alive && setFlash({}), FLASH_MS);
      }
    };
    void fetchMarkets().then(put);
    // Свёрнутое приложение сеть не трогает; вернулись — ответ из памяти, если
    // он моложе минуты, иначе свежий.
    const tick = () => {
      if (!document.hidden) void refreshMarkets().then(put);
    };
    const back = () => {
      if (!document.hidden) void fetchMarkets().then(put);
    };
    const id = window.setInterval(tick, EVERY);
    document.addEventListener("visibilitychange", back);
    return () => {
      alive = false;
      window.clearInterval(id);
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, []);
  if (!m) return waiting ? <Skeleton lang={lang} /> : <>{fallback}</>;
  const notes = m.items.flatMap((it) => {
    const h = HINT[it.k];
    return h ? [h] : [];
  });
  const age = ageMin(m.at, now);
  // Пояснение выбранной ячейки — пока она на экране и не открыт список всех.
  const note = sel && !open && m.items.some((x) => x.k === sel) ? HINT[sel] : undefined;
  return (
    <section className="mk" aria-label={t(lang, "mk_title")}>
      <div className="mk-head">
        <span className="mk-ttl">{t(lang, "mk_title")}</span>
        <span className={`mk-age${age >= MARKETS_STALE_MIN ? " old" : ""}`}>
          {age < 1 ? t(lang, "mk_now") : age < 60 ? t(lang, "mk_ago", { n: age }) : t(lang, "mk_ago_h", { n: Math.floor(age / 60) })}
        </span>
      </div>
      <div className="mk-grid">
        {m.items.map((it) => (
          <Cell key={it.k} it={it} lang={lang} on={sel === it.k && !open} flash={flash[it.k] ?? ""} note={noteId}
            pick={(k) => setSel((s) => (s === k ? null : k))} />
        ))}
      </div>
      {note ? <p id={noteId} className="mk-note" role="note">{t(lang, note)}</p> : null}
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

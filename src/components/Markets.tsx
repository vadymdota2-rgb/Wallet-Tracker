/*
 * Рынки сверху бокового меню, сетка 3 × 3: S&P 500, XYZ100, DXY · золото,
 * нефть WTI, US 10Y · BVIV, BTC.D, USDT.D. Мелко и приглушённо: видно, но в
 * глаза не бросается.
 *
 * Сетка всегда 3 × 3: пункта нет в ответе (источник молчит) — на его месте
 * «—» и «нет данных» для чтения с экрана, а не сдвиг остальных ячеек.
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
 * Открытое меню раз в минуту проверяет, могли ли появиться новые цены
 * (marketsDue: сервер берёт их раз в 10 минут, время ответа — когда взяты),
 * и только тогда спрашивает сервер — как карточка халвинга, не чаще, чем
 * меняются данные. Свёрнутое приложение сеть не трогает, вернулись — сразу
 * (если прошлый ответ старше минуты). Цена изменилась — ячейка коротко
 * вспыхивает цветом (без движения, если система просит меньше анимации).
 */
import { memo, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey, LangCode } from "../i18n/types";
import { num } from "../lib/format";
import { fetchMarkets, peekMarkets, refreshMarkets } from "../lib/api";
import { openExternal } from "../lib/telegram";
import { CMC_URL } from "./CmcBy";
import "./Markets.css";
import {
  MARKETS_STALE_MIN, MARKET_KEYS, ageMin, barShare, change, digits, isPercent, marketsDue,
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
const label = (k: MarketKey, lang: LangCode): string => {
  const l = LABEL[k];
  return isKey(l) ? t(lang, l) : l;
};
/** Пояснения — у каждого пункта (тип требует все девять), в порядке экрана:
 *  любую ячейку можно коснуться и прочитать, что это. */
const HINT: Record<MarketKey, DictKey> = {
  SP500: "mk_sp_hint", XYZ100: "mk_xyz_hint", DXY: "mk_dxy_hint", GOLD: "mk_gold_hint", OIL: "mk_oil_hint",
  US10Y: "mk_10y_hint", BVIV: "mk_bviv_hint", BTCD: "mk_btcd_hint", USDTD: "mk_usdtd_hint",
};

interface CellProps {
  it: MarketItem; lang: LangCode; on: boolean; flash: "" | "up" | "dn"; note: string; pick: (k: MarketKey) => void;
}

/** Ячейка пункта; перерисовывается, только когда меняются её данные (memo):
 *  вспышка одной цены не трогает остальные восемь. */
const Cell = memo(function Cell({ it, lang, on, flash, note, pick }: CellProps) {
  const name = label(it.k, lang);
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
  return (
    <button type="button" className={cls} data-k={it.k} title={t(lang, hint)} aria-expanded={on} aria-controls={note}
      onClick={() => pick(it.k)}>{body}</button>
  );
});

/** Пункта нет в ответе — ячейка на своём месте: «—», а чтению с экрана —
 *  «нет данных». */
function Empty({ k, lang }: { k: MarketKey; lang: LangCode }) {
  return (
    <div className="mk-cell mk-empty" data-k={k}>
      <span className="mk-k">{label(k, lang)}</span>
      <b className="mk-px"><span aria-hidden="true">—</span><span className="mk-sr">{t(lang, "mk_none")}</span></b>
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

/** «ⓘ» рисунком, а не знаком шрифта: знака U+24D8 нет в части системных
 *  шрифтов (вместо него — пустой квадрат), а рисунок одинаково чёткий на
 *  любом экране и любой плотности точек. */
function InfoIcon() {
  return (
    <svg className="mk-ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 7.25v4M8 4.75v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
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
  const pick = useCallback((k: MarketKey) => setSel((s) => (s === k ? null : k)), []);
  const asked = useRef(Date.now());
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
      if (document.hidden || !marketsDue(last.current?.at, Date.now() / 1000, (Date.now() - asked.current) / 1000)) return;
      asked.current = Date.now();
      void refreshMarkets().then(put);
    };
    const back = () => {
      if (document.hidden) return;
      asked.current = Date.now();
      void fetchMarkets().then(put);
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
  const notes = m.items.map((it) => HINT[it.k]);
  const byKey = new Map(m.items.map((x) => [x.k, x]));
  const age = ageMin(m.at, now);
  // Пояснение выбранной ячейки — пока она на экране и не открыт список всех.
  const note = sel && !open && byKey.has(sel) ? HINT[sel] : undefined;
  return (
    <section className="mk" aria-label={t(lang, "mk_title")}>
      <div className="mk-head">
        <span className="mk-ttl">{t(lang, "mk_title")}</span>
        <span className={`mk-age${age >= MARKETS_STALE_MIN ? " old" : ""}`}>
          {age < 1 ? t(lang, "mk_now") : age < 60 ? t(lang, "mk_ago", { n: age }) : t(lang, "mk_ago_h", { n: Math.floor(age / 60) })}
        </span>
      </div>
      <div className="mk-grid">
        {MARKET_KEYS.map((k) => {
          const it = byKey.get(k);
          return it ? (
            <Cell key={k} it={it} lang={lang} on={sel === k && !open} flash={flash[k] ?? ""} note={noteId} pick={pick} />
          ) : <Empty key={k} k={k} lang={lang} />;
        })}
      </div>
      {note ? <p id={noteId} className="mk-note" role="note">{t(lang, note)}</p> : null}
      <p className="mk-src">
        <Sources lang={lang} tail={notes.length ? (
          <button type="button" className="mk-i" aria-expanded={open} aria-label={t(lang, "mk_about")}
            onClick={() => setOpen((o) => !o)}><InfoIcon /></button>
        ) : null} />
      </p>
      {open && notes.length ? (
        <ul className="mk-notes">{notes.map((h) => <li key={h}>{t(lang, h)}</li>)}</ul>
      ) : null}
    </section>
  );
}

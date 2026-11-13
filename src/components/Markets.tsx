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
import { memo, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey, LangCode } from "../i18n/types";
import { dtf, num } from "../lib/format";
import { fetchMarkets, fetchMarketsCandles, peekMarkets, refreshMarkets } from "../lib/api";
import { openExternal } from "../lib/telegram";
import { CMC_URL } from "./CmcBy";
import "./Markets.css";
import {
  CANDLES_FULL, MARKETS_STALE_MIN, MARKET_KEYS, ageMin, barShare, candleChart, candleSeries, change, digits, isPercent,
  marketsDue,
  type Candle, type MarketItem, type MarketKey, type MarketsCandles, type MarketsReply,
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

/** Цена пункта по-людски: знаков — по масштабу, у доходности и долей — «%». */
const fmtPx = (k: MarketKey, v: number, it: MarketItem) => {
  const p = digits({ ...it, px: v });
  return `${num(v, p, p)}${isPercent(k) ? "%" : ""}`;
};

/** «Сейчас», «N мин назад», «N ч назад». */
const agoText = (lang: LangCode, min: number) =>
  min < 1 ? t(lang, "mk_now") : min < 60 ? t(lang, "mk_ago", { n: min }) : t(lang, "mk_ago_h", { n: Math.floor(min / 60) });

const SW = 240, SH = 64;

/** День свечи: «12 нояб.» — на языке приложения, по UTC (как день свечи). */
const dayText = (lang: LangCode, d: number) => {
  try {
    return dtf(lang, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(d * 1000));
  } catch {
    return new Date(d * 1000).toISOString().slice(5, 10);
  }
};

/** Мини-график — дневные свечи за месяц — в раскрытом пояснении ячейки:
 *  рост — зелёным, падение — красным, пунктир — последняя цена; касание или
 *  стрелки — день, открытие, максимум, минимум, закрытие и изменение к
 *  прошлому закрытию. Свечей меньше CANDLES_FULL (своя история только
 *  копится) — строка под осью. Свечи — от сервера, без запросов к
 *  источникам. */
function CandleChart({ it, cs, lang }: { it: MarketItem; cs: Candle[]; lang: LangCode }) {
  const [at, setAt] = useState(-1);
  const g = candleChart(cs, SW, SH, 3);
  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const target = (rtl ? 1 - f : f) * SW;
    let best = 0;
    for (let i = 1; i < g.bars.length; i++) if (Math.abs(g.bars[i]!.x - target) < Math.abs(g.bars[best]!.x - target)) best = i;
    setAt(best);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = at < 0 ? cs.length - 1 : at + (e.key === "ArrowRight" ? 1 : -1);
    setAt(Math.max(0, Math.min(cs.length - 1, i)));
  };
  const c = at >= 0 ? cs[at] : undefined;
  const prev = at > 0 ? cs[at - 1]![4] : undefined;
  const left = at >= 0 ? (g.bars[at]!.x / SW) * 100 : 0;
  const pct = c && prev ? (c[4] / prev - 1) * 100 : undefined;
  const first = cs[0]!, tail = cs[cs.length - 1]!;
  const fmt = (v: number) => fmtPx(it.k, v, it);
  const firstAt = +(((g.bars[0]!.x - g.bw / 2) / SW) * 100).toFixed(2);
  const roomy = firstAt < 70;
  return (
    <div className="mk-spark" role="img" tabIndex={0}
      aria-label={`${label(it.k, lang)}: ${dayText(lang, first[0])} ${fmt(first[1])} → ${dayText(lang, tail[0])} ${fmt(tail[4])}`}
      onPointerDown={pick} onPointerMove={(e) => (e.pointerType === "mouse" || e.buttons ? pick(e) : undefined)}
      onPointerLeave={() => setAt(-1)} onKeyDown={key} onBlur={() => setAt(-1)}>
      <div className={`mk-spark-plot${c ? " pick" : ""}`}>
        <svg viewBox={`0 0 ${SW} ${SH}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <line x1="0" x2={SW} y1={g.last} y2={g.last} className="mk-spark-base" vectorEffect="non-scaling-stroke" />
          {g.bars.map((b, i) => (
            <g key={cs[i]![0]} className={`mk-cdl ${b.up ? "up" : "dn"}${i === at ? " on" : ""}`}>
              <line x1={b.x} x2={b.x} y1={b.hi} y2={b.lo} vectorEffect="non-scaling-stroke" />
              <rect x={+(b.x - g.bw / 2).toFixed(2)} y={b.top} width={g.bw} height={+(b.bot - b.top).toFixed(2)} />
            </g>
          ))}
        </svg>
        {c ? (
          <span className={`mk-spark-tip${left < 25 ? " start" : left > 75 ? " end" : ""}`} style={{ insetInlineStart: `${left}%` }}>
            <span className="mk-tip-l1">
              <b>{fmt(c[4])}</b>
              {pct !== undefined ? <em className={pct > 0 ? "up" : pct < 0 ? "dn" : ""}>{`${pct > 0 ? "+" : pct < 0 ? "−" : ""}${num(Math.abs(pct), 2, 2)}%`}</em> : null}
              <small>{dayText(lang, c[0])}</small>
            </span>
            <small className="mk-tip-l2">{t(lang, "mk_ohlc", { o: fmt(c[1]), h: fmt(c[2]), l: fmt(c[3]) })}</small>
          </span>
        ) : null}
      </div>
      <div className="mk-spark-ax" aria-hidden="true">
        {/* Первый день — под первой свечой (свечей мало — она не у края); у
            правого края места на две подписи нет — обе справа, через тире. */}
        <span style={{ marginInlineStart: `${firstAt}%` }}>{roomy ? dayText(lang, first[0]) : ""}</span>
        <span>{roomy || cs.length < 2 ? dayText(lang, tail[0]) : `${dayText(lang, first[0])} – ${dayText(lang, tail[0])}`}</span>
      </div>
      {cs.length < CANDLES_FULL ? <span className="mk-spark-wait-t">{t(lang, "mk_hist_short")}</span> : null}
    </div>
  );
}

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
  const cls = `mk-cell${dir ? ` is-${dir}` : ""}${flash ? ` mk-flash-${flash}` : ""}`;
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

/** Значок заголовка — линия графика в кружке, как монета у карточки халвинга. */
function Mark() {
  return (
    <svg className="mk-mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 10.5 6.2 7.3l2.3 2.3L13 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Скелет сетки, пока ждём первый ответ: меню не прыгает. */
function Skeleton({ lang }: { lang: LangCode }) {
  return (
    <section className="mk mk-skel" aria-label={t(lang, "mk_title")} aria-busy="true">
      <div className="mk-head"><span className="mk-ttl"><Mark />{t(lang, "mk_title")}</span></div>
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
  // Дневные свечи — один запрос на все пункты при первом касании ячейки.
  const [cands, setCands] = useState<MarketsCandles | null>(null);
  useEffect(() => {
    if (!sel || cands) return;
    let alive = true;
    fetchMarketsCandles().then((h) => alive && setCands(h), () => alive && setCands({}));
    return () => {
      alive = false;
    };
  }, [sel, cands]);
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
        <span className="mk-ttl"><Mark />{t(lang, "mk_title")}</span>
        <span className={`mk-age${age >= MARKETS_STALE_MIN ? " old" : ""}`}>
          <i className="mk-dot" aria-hidden="true" />
          {agoText(lang, age)}
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
      {note && sel ? (
        <div id={noteId} className="mk-note" role="note">
          {cands === null ? <div className="mk-spark-wait" aria-hidden="true" />
            : (() => {
              const it = byKey.get(sel)!;
              const cs = candleSeries(cands[sel], it);
              return cs.length ? <CandleChart key={sel} it={it} cs={cs} lang={lang} /> : null;
            })()}
          <p className="mk-note-t">{t(lang, note)}</p>
        </div>
      ) : null}
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

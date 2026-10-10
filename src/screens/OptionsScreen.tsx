/**
 * Опционы BTC и ETH: где по страйкам стоят ставки, куда тянет Max Pain, что
 * рынок ждёт от волатильности и что делают крупные игроки.
 *
 * Открытый интерес сервер складывает с Deribit, OKX, Bybit и Binance — в
 * монетах, доллары считаются здесь по цене индекса. Волатильность, перекос,
 * сделки и DVOL — Deribit: там большая часть рынка опционов.
 *
 * Экран идёт от главного к подробностям, и у каждого блока свой вывод
 * словами — человеку без опыта в опционах не нужно самому читать график:
 *   1. Сводка: интерес, Put/Call с настроем, Max Pain ближайшей даты, DVOL.
 *   2. Интерес по страйкам — путы влево, коллы вправо, цена линией; ниже
 *      страйки, где ставок больше всего.
 *   3. Волатильность по датам и перекос — то, на что смотрят профессионалы.
 *   4. Даты экспирации, поток сделок за сутки, крупные сделки, доля бирж.
 *
 * Колл — зелёный и справа, пут — красный и слева. Сторону говорит и место,
 * и подпись, поэтому различать цвет не обязательно. Суммы и подписи — цветом
 * текста, а не цветом полос: так они читаются на тёмном фоне.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey } from "../i18n/types";
import { dayMonth, fix2, num, pct, px, since, untilDay, usd } from "../lib/format";
import { haptic } from "../lib/telegram";
import { fetchOptions, peekOptions, refreshOptions, savedOptions } from "../lib/api";
import { useNow } from "../lib/tick";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Empty, SectionTitle, Segmented, Skeleton } from "../components/ui";
import type { OptExpiry, OptionsReply, OptTrade } from "../lib/types";
import { Frame } from "./Screen";

type Lang = Parameters<typeof t>[0];

const COINS = ["BTC", "ETH"] as const;
/** Строк в лесенке страйков — не больше: дальше они сливаются в полоски. */
const MAX_ROWS = 36;
/** Сколько крупных сделок (или блоков) видно сразу. */
const BIG_PAGE = 10;
/** Как часто открытый экран спрашивает свежие данные: сервер пересобирает раз в три минуты. */
const LIVE_EVERY = 120_000;
/** Самая длинная полоса лесенки — доля ширины: справа от неё остаётся место на сумму. */
const BAR_MAX = 0.74;
/** Подписанных полос на сторону — самые крупные. */
const LABELED = 3;

/** Ширина окна страйков вокруг цены: ближняя дата — узко, дальняя — широко. */
function spanFor(e: OptExpiry | null, nowSec: number): number {
  if (!e) return 0.3;
  const days = (e.ts - nowSec) / 86400;
  return days <= 3 ? 0.08 : days <= 14 ? 0.15 : days <= 60 ? 0.3 : 0.45;
}

/** Круглый шаг не меньше заданного: 1, 2, 2,5, 5 × 10ⁿ. */
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) ?? 10) * p;
}

interface StrikeRow {
  k: number;
  c: number;
  p: number;
}

function strikeMap(list: OptExpiry[]): StrikeRow[] {
  const all = new Map<number, StrikeRow>();
  for (const e of list) {
    for (const [k, c, p] of e.k) {
      const r = all.get(k) ?? { k, c: 0, p: 0 };
      r.c += c;
      r.p += p;
      all.set(k, r);
    }
  }
  return [...all.values()];
}

/** Страйки в окне вокруг цены, сверху вниз; если их много — по круглым корзинам. */
function strikeRows(all: StrikeRow[], price: number, span: number): { rows: StrikeRow[]; step: number } {
  const lo = price * (1 - span);
  const hi = price * (1 + span);
  let rows = all.filter((r) => r.k >= lo && r.k <= hi && r.c + r.p > 0);
  let step = 0;
  if (rows.length > MAX_ROWS) {
    step = niceStep((hi - lo) / MAX_ROWS);
    const b = new Map<number, StrikeRow>();
    for (const r of rows) {
      const k = Math.round(r.k / step) * step;
      const x = b.get(k) ?? { k, c: 0, p: 0 };
      x.c += r.c;
      x.p += r.p;
      b.set(k, x);
    }
    rows = [...b.values()];
  }
  return { rows: rows.sort((a, b) => b.k - a.k), step };
}

/** Настрой по Put/Call открытого интереса — как его читают на рынке. */
function moodOf(pcr: number): "bull" | "bear" | "flat" {
  return pcr < 0.7 ? "bull" : pcr > 1 ? "bear" : "flat";
}

function Spark({ path }: { path: number[] }) {
  if (path.length < 2) return null;
  const lo = Math.min(...path);
  const hi = Math.max(...path);
  const h = 24;
  const w = 120;
  const y = (v: number) => (hi === lo ? h / 2 : 2 + ((hi - v) / (hi - lo)) * (h - 4));
  const pts = path.map((v, i) => `${((i / (path.length - 1)) * (w - 3)).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg className="op-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} vectorEffect="non-scaling-stroke" />
      <circle cx={w - 3} cy={y(path[path.length - 1] ?? lo)} r={2.5} />
    </svg>
  );
}

function LiveAge({ lang, at }: { lang: Lang; at: number }) {
  const now = useNow();
  return (
    <small className="lq-live">
      <i aria-hidden="true" />
      {t(lang, "lq_live", { t: since(Math.max(1, now - at)) })}
    </small>
  );
}

/**
 * Волатильность по датам: IV «на деньгах» каждой экспирации, точки по
 * порядку дат (не по дням — ближние иначе слиплись бы в одну). Пунктир —
 * DVOL, та же шкала % годовых: ориентир «тридцать дней вперёд».
 */
function TermChart({ lang, exps, dvol, nowSec }: { lang: Lang; exps: OptExpiry[]; dvol: number | null; nowSec: number }) {
  const pts = exps.filter((e) => e.iv > 0);
  const [sel, setSel] = useState<number | null>(null);
  if (pts.length < 2) return null;
  const W = 340;
  const H = 120;
  const L = 34;
  const R = 10;
  const T = 14;
  const B = 22;
  const vals = pts.map((e) => e.iv).concat(dvol ? [dvol] : []);
  /* Снизу запас побольше: подпись нижней точки уходит под неё и не должна
     наезжать на даты оси. */
  const lo = Math.max(0, Math.floor((Math.min(...vals) - 5) / 5) * 5);
  const hi = Math.ceil((Math.max(...vals) + 2) / 5) * 5;
  const x = (i: number) => L + (i / (pts.length - 1)) * (W - L - R);
  const y = (v: number) => T + ((hi - v) / Math.max(1, hi - lo)) * (H - T - B);
  const step = niceStep((hi - lo) / 4);
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  const xl = [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
  const s = sel !== null ? pts[sel] : undefined;
  return (
    <>
      <svg className="op-term" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t(lang, "op_vol_title")}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="op-term-grid" />
            <text x={L - 6} y={y(v) + 3.5} className="op-term-ax" textAnchor="end">{num(v)}%</text>
          </g>
        ))}
        {dvol ? (
          <g>
            <line x1={L} x2={W - R} y1={y(dvol)} y2={y(dvol)} className="op-term-dvol" />
            {/* Подпись — у левого края: справа кривая обычно подходит к DVOL вплотную. */}
            <text x={L + 4} y={y(dvol) + (y(dvol) < y(pts[0]!.iv) ? -5 : 13)} className="op-term-dvol-t">DVOL {num(dvol, 1)}%</text>
          </g>
        ) : null}
        <polyline points={pts.map((e, i) => `${x(i).toFixed(1)},${y(e.iv).toFixed(1)}`).join(" ")} className="op-term-l" />
        {pts.map((e, i) => (
          <g key={e.d} onClick={() => { haptic("select"); setSel(sel === i ? null : i); }} className="op-term-p">
            <rect x={x(i) - 12} y={T - 6} width={24} height={H - T - B + 12} fill="transparent" />
            <circle cx={x(i)} cy={y(e.iv)} r={sel === i ? 5 : 3.5} className={sel === i ? "on" : ""} />
          </g>
        ))}
        {/* Значения — у первой и последней точки, со стороны, свободной от кривой. */}
        {[0, pts.length - 1].map((i) => {
          const nb = pts[i ? i - 1 : 1]!.iv;
          const below = i === 0 ? nb > pts[0]!.iv : nb > pts[i]!.iv;
          return (
            <text key={i} x={x(i) + (i ? -2 : 2)} y={y(pts[i]!.iv) + (below ? 16 : -9)} className="op-term-v" textAnchor={i ? "end" : "start"}>
              {num(pts[i]!.iv, 1)}%
            </text>
          );
        })}
        {xl.map((i) => (
          <text key={i} x={x(i)} y={H - 6} className="op-term-ax" textAnchor={i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"}>
            {dayMonth(pts[i]!.ts, nowSec)}
          </text>
        ))}
      </svg>
      <p className="op-term-sel" aria-live="polite">
        {s
          ? t(lang, "op_vol_pt", { d: dayMonth(s.ts, nowSec), iv: num(s.iv, 1), sk: `${s.sk > 0 ? "+" : ""}${num(s.sk, 1)}` })
          : t(lang, "op_vol_hint")}
      </p>
    </>
  );
}

interface BigGroup {
  id: string;
  legs: OptTrade[];
  n: number;
  t: number;
}

/** Ноги одной блочной сделки — вместе: по отдельности они читались как
 *  несколько независимых ставок в одну секунду. */
function groupBig(list: OptTrade[]): BigGroup[] {
  const out: BigGroup[] = [];
  const at = new Map<string, BigGroup>();
  for (const b of list) {
    const g = b.blk ? at.get(b.blk) : undefined;
    if (g) {
      g.legs.push(b);
      g.n += b.n;
      continue;
    }
    const ng = { id: b.blk || `${b.t}-${b.k}-${b.cp}-${out.length}`, legs: [b], n: b.n, t: b.t };
    if (b.blk) at.set(b.blk, ng);
    out.push(ng);
  }
  return out;
}

function Leg({ lang, b, sym, nowSec }: { lang: Lang; b: OptTrade; sym: string; nowSec: number }) {
  const call = b.cp === "C";
  const exp = Math.floor(Date.parse(`${b.e}T08:00:00Z`) / 1000);
  return (
    <span className="op-leg">
      <span className="op-leg-t">
        <i className={`op-dot ${call ? "up" : "dn"}`} aria-hidden="true" />
        <b>{t(lang, call ? "op_call" : "op_put")} {num(b.k)}</b>
        <small>{dayMonth(exp, nowSec)}</small>
      </span>
      <span className="op-leg-s">
        <em className={b.s === "b" ? "op-side buy" : "op-side sell"}>{t(lang, b.s === "b" ? "op_buy" : "op_sell")}</em>
        <small>{num(b.a, b.a < 10 ? 2 : 0)} {sym} · IV {num(b.iv, 1)}%</small>
      </span>
    </span>
  );
}

/**
 * Как называется блок из двух ног — так, как его назовёт трейдер, и что он
 * значит. Больше двух ног или непохожие ноги — просто «Блок».
 */
function strategyOf(legs: OptTrade[]): DictKey | null {
  if (legs.length !== 2) return null;
  const [a, b] = legs as [OptTrade, OptTrade];
  if (a.e !== b.e) return null;
  if (a.cp !== b.cp) {
    const c = a.cp === "C" ? a : b;
    const p = a.cp === "C" ? b : a;
    if (c.s === p.s) {
      const kind = c.k === p.k ? "straddle" : "strangle";
      return `op_st_${kind}_${c.s === "b" ? "b" : "s"}` as DictKey;
    }
    return c.s === "b" ? "op_st_rr" : "op_st_collar";
  }
  if (a.s !== b.s) {
    const buy = a.s === "b" ? a : b;
    const sell = a.s === "b" ? b : a;
    /* Колл-спред с купленным нижним страйком — на рост, пут-спред с
       купленным верхним — на падение; наоборот — сбор премии. */
    if (a.cp === "C") return buy.k < sell.k ? "op_st_cs_bull" : "op_st_cs_bear";
    return buy.k > sell.k ? "op_st_ps_bear" : "op_st_ps_bull";
  }
  return null;
}

function BigCard({ lang, g, sym, nowSec }: { lang: Lang; g: BigGroup; sym: string; nowSec: number }) {
  const prem = g.legs.reduce((a, b) => a + b.pr, 0);
  const st = strategyOf(g.legs);
  return (
    <div className={g.legs.length > 1 ? "op-big-r multi" : "op-big-r"}>
      {g.legs[0]?.blk ? (
        <span className="op-blk-h">
          <em className="op-blk">{t(lang, "op_block")}</em>
          {st ? <span>{t(lang, st)}</span> : null}
        </span>
      ) : null}
      <div className="op-big-l">
        {g.legs.map((b, i) => <Leg key={i} lang={lang} b={b} sym={sym} nowSec={nowSec} />)}
      </div>
      <div className="op-big-c">
        <b>{usd(g.n)}</b>
        <small>{t(lang, "op_prem", { x: usd(prem) })}</small>
        <small>{since(nowSec - g.t)}</small>
      </div>
    </div>
  );
}

export function OptionsScreen() {
  const lang = useApp((s) => s.lang);
  const saved = useApp((s) => s.optSym);
  const setOptSym = useApp((s) => s.setOptSym);
  const [sym, setSym] = useState<string>((COINS as readonly string[]).includes(saved) ? saved : "BTC");
  const [exp, setExp] = useState<string>("all");
  const [sel, setSel] = useState<number | null>(null);
  const [bigN, setBigN] = useState(BIG_PAGE);
  const [reply, setReply] = useState<OptionsReply | null>(() => peekOptions(sym) ?? savedOptions(sym)?.v ?? null);
  const [busy, setBusy] = useState(false);
  const [staleAt, setStaleAt] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const ladderRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setSel(null);
    setExp("all");
    setBigN(BIG_PAGE);
    const cached = peekOptions(sym);
    const kept = cached ? null : savedOptions(sym);
    setReply(cached ?? kept?.v ?? null);
    setBusy(!cached);
    setStaleAt(null);
    void fetchOptions(sym).then((r) => {
      if (!alive) return;
      setBusy(false);
      if (r?.ok || r?.error === "no_data") setReply(r);
      else if (kept) setStaleAt(kept.at);
      else setReply(r ?? ({ ok: false, error: "net" } as OptionsReply));
    });
    setOptSym(sym);
    return () => {
      alive = false;
    };
  }, [sym, setOptSym, retry]);

  /* Пока экран открыт — свежие данные раз в две минуты; выбор даты и
     страйка при этом остаётся. */
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshOptions(sym).then((r) => {
        if (r?.ok) {
          setReply(r);
          setStaleAt(null);
        }
      });
    }, LIVE_EVERY);
    return () => window.clearInterval(id);
  }, [sym]);

  const nowSec = Math.floor(Date.now() / 1000);
  const exps = useMemo(() => (reply?.ok ? reply.exp.filter((e) => e.ts > nowSec) : []), [reply, nowSec]);
  const cur = exp === "all" ? null : exps.find((e) => e.d === exp) ?? null;
  const strikes = useMemo(() => strikeMap(cur ? [cur] : exps), [cur, exps]);
  const view = useMemo(
    () => (reply?.ok ? strikeRows(strikes, reply.px, spanFor(cur, nowSec)) : { rows: [], step: 0 }),
    [reply, strikes, cur, nowSec],
  );
  const groups = useMemo(() => groupBig(reply?.ok ? reply.big : []), [reply]);

  const again = () => {
    haptic("select");
    setRetry((n) => n + 1);
  };

  if (!reply || !reply.ok) {
    return (
      <Frame title={t(lang, "op_title")}>
        <p className="lq-lead">{t(lang, "op_sub")}</p>
        <CoinSwitch sym={sym} onPick={setSym} />
        {!reply ? (
          <Card><Skeleton rows={10} /></Card>
        ) : (
          <Empty
            text={t(lang, "op_err")}
            hint={<button type="button" className="lq-retry" onClick={again}>{t(lang, "ui_retry")}</button>}
          />
        )}
      </Frame>
    );
  }

  const P = reply.px;
  const totC = exps.reduce((a, e) => a + e.c, 0);
  const totP = exps.reduce((a, e) => a + e.p, 0);
  const tot = Math.max(1e-9, totC + totP);
  const volC = exps.reduce((a, e) => a + e.vc, 0);
  const volP = exps.reduce((a, e) => a + e.vp, 0);
  const pcr = totC > 0 ? totP / totC : 0;
  const pcrVol = volC > 0 ? volP / volC : 0;
  const mood = moodOf(pcr);
  const near = exps[0];
  const mpExp = cur ?? near;

  /* Лесенка: масштаб, подписи у самых крупных полос, линии цены и Max Pain. */
  const maxBar = Math.max(1e-9, ...view.rows.map((r) => Math.max(r.c, r.p)));
  const topC = new Set([...view.rows].sort((a, b) => b.c - a.c).slice(0, LABELED).filter((r) => r.c > 0).map((r) => r.k));
  const topP = new Set([...view.rows].sort((a, b) => b.p - a.p).slice(0, LABELED).filter((r) => r.p > 0).map((r) => r.k));
  const rowSel = sel !== null ? view.rows.find((r) => r.k === sel) : undefined;
  const mpK = cur && view.rows.length
    ? view.rows.reduce((b, r) => (Math.abs(r.k - cur.mp) < Math.abs(b.k - cur.mp) ? r : b)).k
    : null;
  const priceAt = view.rows.findIndex((r) => r.k < P);
  const sideC = view.rows.reduce((a, r) => a + r.c, 0);
  const sideP = view.rows.reduce((a, r) => a + r.p, 0);

  /* Где ставок больше всего — по всем страйкам выбранной даты, не только в окне. */
  const wallsC = [...strikes].sort((a, b) => b.c - a.c).slice(0, 3).filter((r) => r.c > 0);
  const wallsP = [...strikes].sort((a, b) => b.p - a.p).slice(0, 3).filter((r) => r.p > 0);
  const wallMax = Math.max(1e-9, ...wallsC.map((r) => r.c), ...wallsP.map((r) => r.p));
  /** Страйк из «крупнейших» — на лесенке; если он за краем окна, лесенка
   *  переходит на все даты, где окно шире. */
  const focus = (k: number) => {
    haptic("select");
    if (cur && Math.abs(k - P) / P > spanFor(cur, nowSec)) setExp("all");
    setSel(k);
    ladderRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  /* Волатильность: ближняя дата против месячной и перекос месячной. */
  const ivs = exps.filter((e) => e.iv > 0);
  const month = ivs.reduce<OptExpiry | null>(
    (b, e) => (!b || Math.abs(e.ts - nowSec - 30 * 86400) < Math.abs(b.ts - nowSec - 30 * 86400) ? e : b), null);
  const first = ivs[0];
  const term = first && month && first !== month
    ? first.iv > month.iv + 2 ? "op_term_up" : first.iv < month.iv - 2 ? "op_term_dn" : "op_term_eq"
    : null;
  const skew = month ? (month.sk > 1 ? "op_skew_put" : month.sk < -1 ? "op_skew_call" : "op_skew_eq") : null;

  const expMax = Math.max(1e-9, ...exps.map((e) => e.c + e.p));
  const f = "cb" in reply.flow ? reply.flow : null;
  const flowKey = !f ? null : f.cb > f.pb * 1.2 ? "op_flow_up" : f.pb > f.cb * 1.2 ? "op_flow_dn" : "op_flow_eq";
  const exTot = reply.ex.reduce((a, [, v]) => a + v, 0);

  return (
    <Frame title={t(lang, "op_title")}>
      <p className="lq-lead">{t(lang, "op_sub")}</p>
      <CoinSwitch sym={sym} onPick={setSym} />

      {staleAt ? (
        <p className="lq-stale">
          {t(lang, "op_stale", { t: since((Date.now() - staleAt) / 1000) })}{" "}
          <button type="button" onClick={again}>{t(lang, "ui_retry")}</button>
        </p>
      ) : null}

      {/* 1. Сводка */}
      <Card>
        <div className="op-head">
          <CoinIcon sym={reply.sym} size={32} />
          <div className="op-head-n">
            <b>{t(lang, "op_head", { s: reply.sym })}</b>
            <small>{t(lang, "op_index", { x: px(P) })}</small>
          </div>
          {busy ? <span className="lq-busy" aria-hidden="true" /> : null}
        </div>
        <LiveAge lang={lang} at={reply.at} />

        <p className="op-verdict">
          <span className={`op-chip ${mood}`}>
            {mood === "bull" ? "▲ " : mood === "bear" ? "▼ " : "● "}
            {t(lang, mood === "bull" ? "op_bull" : mood === "bear" ? "op_bear" : "op_flat")}
          </span>
          <span>{t(lang, mood === "bull" ? "op_mood_up" : mood === "bear" ? "op_mood_dn" : "op_mood_eq")}</span>
        </p>

        <div className="op-tiles">
          <div className="op-tile">
            <small>{t(lang, "op_oi")}</small>
            <b>{usd((totC + totP) * P)}</b>
            <div className="op-split" role="img"
              aria-label={`${t(lang, "op_puts")} ${pct((totP / tot) * 100, 0, false)}, ${t(lang, "op_calls")} ${pct((totC / tot) * 100, 0, false)}`}>
              <i className="dn" style={{ width: `${(totP / tot) * 100}%` }} />
              <i className="up" style={{ width: `${(totC / tot) * 100}%` }} />
            </div>
            <span className="op-key">
              <span><i className="op-dot up" />{t(lang, "op_calls")}<b>{pct((totC / tot) * 100, 0, false)}</b></span>
              <span><i className="op-dot dn" />{t(lang, "op_puts")}<b>{pct((totP / tot) * 100, 0, false)}</b></span>
            </span>
          </div>
          <div className="op-tile">
            <small>{t(lang, "op_pcr")}</small>
            <b>{fix2(pcr)}</b>
            <span className="op-scale" aria-hidden="true">
              <i style={{ left: `${Math.min(100, (pcr / 1.5) * 100)}%` }} />
            </span>
            <span className="op-tile-d">{t(lang, "op_pcr_vol", { x: fix2(pcrVol) })}</span>
          </div>
          {mpExp ? (
            <button
              type="button"
              className="op-tile tap"
              onClick={() => { haptic("select"); setExp(mpExp.d); setSel(null); ladderRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
            >
              <small>{t(lang, "op_mp_d", { d: dayMonth(mpExp.ts, nowSec) })}</small>
              <b>{px(mpExp.mp)}</b>
              <span className="op-tile-d">{t(lang, "op_from_px", { x: pct(((mpExp.mp - P) / P) * 100, 1, true) })}</span>
              <span className="op-tile-d">{untilDay(mpExp.ts, nowSec)} · {usd((mpExp.c + mpExp.p) * P)}</span>
            </button>
          ) : null}
          {reply.dvol ? (
            <div className="op-tile">
              <small>{t(lang, "op_dvol")}</small>
              <b>{num(reply.dvol.v, 1)}%</b>
              <Spark path={reply.dvol.path} />
              <span className="op-tile-d">{t(lang, "op_dvol_sub", { x: `${reply.dvol.chg > 0 ? "+" : ""}${num(reply.dvol.chg, 1)}` })}</span>
            </div>
          ) : null}
        </div>
      </Card>

      {/* 2. Интерес по страйкам */}
      <SectionTitle>{t(lang, "op_strikes")}</SectionTitle>
      <div className="op-exps" role="tablist">
        {[null, ...exps].map((e) => {
          const id = e ? e.d : "all";
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={exp === id}
              className={exp === id ? "chip on" : "chip"}
              onClick={() => { if (exp !== id) { haptic("select"); setExp(id); setSel(null); } }}
            >
              {e ? dayMonth(e.ts, nowSec) : t(lang, "op_all")}
            </button>
          );
        })}
      </div>
      <Card>
        <div className="op-ladder-h">
          <span><i className="op-dot dn" />{t(lang, "op_puts")} <b>{usd(sideP * P)}</b></span>
          <small>{t(lang, "op_strike")}</small>
          <span><b>{usd(sideC * P)}</b> {t(lang, "op_calls")}<i className="op-dot up" /></span>
        </div>
        <div className="op-ladder" ref={ladderRef}>
          {view.rows.map((r, i) => (
            <div key={r.k}>
              {i === priceAt ? (
                <div className="op-line"><span>{t(lang, "op_price", { x: px(P) })}</span></div>
              ) : null}
              <button
                type="button"
                className={`op-row${sel === r.k ? " on" : ""}${mpK === r.k ? " mp" : ""}`}
                aria-pressed={sel === r.k}
                onClick={() => { haptic("select"); setSel(sel === r.k ? null : r.k); }}
              >
                <span className="op-bar l">
                  {topP.has(r.k) ? <small>{usd(r.p * P)}</small> : null}
                  <i style={{ width: `${(r.p / maxBar) * BAR_MAX * 100}%` }} />
                </span>
                <b>{num(r.k)}</b>
                <span className="op-bar r">
                  <i style={{ width: `${(r.c / maxBar) * BAR_MAX * 100}%` }} />
                  {topC.has(r.k) ? <small>{usd(r.c * P)}</small> : null}
                </span>
              </button>
            </div>
          ))}
          {priceAt === -1 && view.rows.length ? (
            <div className="op-line"><span>{t(lang, "op_price", { x: px(P) })}</span></div>
          ) : null}
        </div>
        <div className="op-legend">
          <span><i className="op-dot dn" />{t(lang, "op_puts")}</span>
          <span><i className="op-dot up" />{t(lang, "op_calls")}</span>
          <span><i className="op-lk" />{t(lang, "op_legend_px")}</span>
          {cur ? <span><i className="op-lk mp" />{t(lang, "op_mp")}</span> : null}
        </div>
        {rowSel ? (
          <div className="op-sel" aria-live="polite">
            <div className="op-sel-h">
              <b>{t(lang, "op_strike_n", { x: view.step ? `≈ ${num(rowSel.k)}` : num(rowSel.k) })}</b>
              <span>{pct(((rowSel.k - P) / P) * 100, 1, true)}</span>
            </div>
            <div className="op-sel-r">
              <span><i className="op-dot dn" />{t(lang, "op_puts")}</span>
              <b>{usd(rowSel.p * P)}</b>
              <small>{num(rowSel.p, 1)} {reply.sym}</small>
            </div>
            <div className="op-sel-r">
              <span><i className="op-dot up" />{t(lang, "op_calls")}</span>
              <b>{usd(rowSel.c * P)}</b>
              <small>{num(rowSel.c, 1)} {reply.sym}</small>
            </div>
          </div>
        ) : (
          <p className="lq-hint">{t(lang, cur ? "op_tap_mp" : "op_tap")}</p>
        )}
      </Card>

      {wallsC.length || wallsP.length ? (
        <div className="lq-top op-walls">
          {([["up", "op_top_c", wallsC, "c"], ["dn", "op_top_p", wallsP, "p"]] as const).map(([k, title, list, side]) => (
            <div key={k} className={`lq-top-c ${k}`}>
              <small><i className={`op-dot ${k}`} />{t(lang, title)}</small>
              {list.map((r) => (
                <button key={r.k} type="button" onClick={() => focus(r.k)}>
                  <span className="lq-top-r">
                    <b>{px(r.k)}</b>
                    <em>{usd(r[side] * P)}</em>
                  </span>
                  <span className="lq-top-bar"><i style={{ width: `${(r[side] / wallMax) * 100}%` }} /></span>
                  <small>{pct(((r.k - P) / P) * 100, 1, true)}</small>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {/* 3. Волатильность */}
      {ivs.length > 1 ? (
        <>
          <SectionTitle>{t(lang, "op_vol_title")}</SectionTitle>
          <Card>
            {term ? <p className="op-say">{t(lang, term)}</p> : null}
            <TermChart lang={lang} exps={exps} dvol={reply.dvol?.v ?? null} nowSec={nowSec} />
            {skew && month ? (
              <div className="op-skew">
                <div>
                  <small>{t(lang, "op_skew_t", { d: dayMonth(month.ts, nowSec) })}</small>
                  <b>{month.sk > 0 ? "+" : ""}{num(month.sk, 1)}</b>
                </div>
                <span>{t(lang, skew, { x: num(Math.abs(month.sk), 1) })}</span>
              </div>
            ) : null}
          </Card>
        </>
      ) : null}

      {/* 4. Даты экспирации */}
      <SectionTitle>{t(lang, "op_exp")}</SectionTitle>
      <Card>
        <div className="op-exp-h">
          <small>{t(lang, "op_date")}</small>
          <small>{t(lang, "op_oi_col")}</small>
          <small>P/C</small>
          <small>{t(lang, "op_mp")}</small>
        </div>
        {exps.map((e) => (
          <button
            key={e.d}
            type="button"
            className={exp === e.d ? "op-exp on" : "op-exp"}
            onClick={() => {
              haptic("select");
              setExp(exp === e.d ? "all" : e.d);
              setSel(null);
              if (exp !== e.d) ladderRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            <span className="op-exp-d">
              <b>{dayMonth(e.ts, nowSec)}</b>
              <small>{untilDay(e.ts, nowSec)}</small>
            </span>
            <span className="op-exp-oi">
              <em>{usd((e.c + e.p) * P)}</em>
              <span className="op-exp-bar" style={{ width: `${Math.max(4, ((e.c + e.p) / expMax) * 100)}%` }}>
                <i className="dn" style={{ width: `${(e.p / Math.max(1e-9, e.c + e.p)) * 100}%` }} />
                <i className="up" style={{ width: `${(e.c / Math.max(1e-9, e.c + e.p)) * 100}%` }} />
              </span>
            </span>
            <span className="op-exp-n">{e.c > 0 ? fix2(e.p / e.c) : "—"}</span>
            <span className="op-exp-n">{px(e.mp)}</span>
          </button>
        ))}
      </Card>

      {/* 5. Поток за сутки */}
      {f ? (
        <>
          <SectionTitle>{t(lang, "op_flow", { h: num(Math.min(24, f.h)) })}</SectionTitle>
          <Card>
            {flowKey ? <p className="op-say">{t(lang, flowKey)}</p> : null}
            {([["up", "op_calls", f.cb, f.cs], ["dn", "op_puts", f.pb, f.ps]] as const).map(([k, name, b, s]) => {
              const all = Math.max(1e-9, b + s);
              const net = b - s;
              return (
                <div key={k} className={`op-flow ${k}`}>
                  <div className="op-flow-h">
                    <span><i className={`op-dot ${k}`} />{t(lang, name)}</span>
                    <small>{t(lang, net >= 0 ? "op_net_buy" : "op_net_sell", { x: usd(Math.abs(net)) })}</small>
                  </div>
                  <div className="op-flow-bar" role="img"
                    aria-label={`${t(lang, "op_bought")} ${usd(b)}, ${t(lang, "op_sold")} ${usd(s)}`}>
                    <i className="b" style={{ width: `${(b / all) * 100}%` }} />
                    <i className="s" style={{ width: `${(s / all) * 100}%` }} />
                  </div>
                  <div className="op-flow-k">
                    <span>{t(lang, "op_bought")} <b>{usd(b)}</b></span>
                    <span><b>{usd(s)}</b> {t(lang, "op_sold")}</span>
                  </div>
                </div>
              );
            })}
            <p className="lq-hint">{t(lang, "op_flow_note")}</p>
          </Card>
        </>
      ) : null}

      {/* 6. Крупные сделки */}
      <SectionTitle>{t(lang, "op_big")}</SectionTitle>
      <Card>
        <p className="lq-hint op-big-sub">{t(lang, "op_big_sub", { x: usd(reply.sym === "BTC" ? 1_000_000 : 500_000) })}</p>
        {groups.length ? (
          <>
            {groups.slice(0, bigN).map((g) => (
              <BigCard key={g.id} lang={lang} g={g} sym={reply.sym} nowSec={nowSec} />
            ))}
            {groups.length > bigN ? (
              <button type="button" className="lq-more" onClick={() => setBigN(bigN + BIG_PAGE)}>
                {t(lang, "op_more", { n: groups.length - bigN })}
              </button>
            ) : null}
          </>
        ) : (
          <p className="lq-none">{t(lang, "op_big_none")}</p>
        )}
      </Card>

      {/* 7. Доля бирж */}
      {reply.ex.length > 1 ? (
        <>
          <SectionTitle>{t(lang, "op_ex")}</SectionTitle>
          <Card>
            {reply.ex.map(([name, v]) => (
              <div key={name} className="op-ex">
                <b>{name}</b>
                <span className="op-ex-b"><i style={{ width: `${(v / Math.max(1, reply.ex[0]?.[1] ?? 1)) * 100}%` }} /></span>
                <em>{usd(v)}</em>
                <small>{pct((v / Math.max(1, exTot)) * 100, 0, false)}</small>
              </div>
            ))}
          </Card>
        </>
      ) : null}

      <details className="lq-how">
        <summary>{t(lang, "op_how")}</summary>
        <ul>
          <li>{t(lang, "op_how_1")}</li>
          <li>{t(lang, "op_how_2")}</li>
          <li>{t(lang, "op_how_3")}</li>
          <li>{t(lang, "op_how_6")}</li>
          <li>{t(lang, "op_how_4")}</li>
          <li>{t(lang, "op_how_5")}</li>
        </ul>
      </details>

      <p className="lq-src">
        {t(lang, "op_src", { ex: reply.ex.map(([n]) => n).join(", ") })}{" "}
        {t(lang, "lq_updated", { t: since(Date.now() / 1000 - reply.at) })}
      </p>
    </Frame>
  );
}

function CoinSwitch({ sym, onPick }: { sym: string; onPick: (s: string) => void }) {
  return (
    <div className="lq-ctl">
      <Segmented<string>
        value={sym}
        onChange={onPick}
        options={COINS.map((c) => ({ id: c, label: <span className="op-coin"><CoinIcon sym={c} size={18} /> {c}</span> }))}
      />
    </div>
  );
}

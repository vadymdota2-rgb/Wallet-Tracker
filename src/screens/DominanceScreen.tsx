/**
 * Доминация и альтсезон: доля биткоина, альтов и USDT во всём рынке и кто
 * сильнее — биткоин или альткоины.
 *
 * Доминация — по официальному API CoinMarketCap (сервер — wt_mcap.py): долю
 * во всём рынке без капитализации тысяч монет не посчитать. Нет ключа на
 * сервере — блока нет, остальной экран работает.
 *
 * Всё посчитано своим счётом по дневным ценам Hyperliquid (сервер — wt_dom.py,
 * проверка ответа и расчёты — lib/dom.ts). Чужих индексов здесь нет.
 *
 * Сверху — индекс альтсезона на последний закрытый день: сколько из 100 самых
 * торгуемых монет Hyperliquid обогнали биткоин за 90 дней; 75 и выше —
 * альтсезон, 25 и ниже — сезон биткоина. Под ним — ширина: тот же индекс для
 * 25, 50 и 100 монет. Ниже — его история (корзина на каждый день своя, со
 * снятыми потом с торгов монетами), сила альтов против биткоина (корзина
 * монет поровну), список монет за 90 дней и ETH/BTC.
 *
 * Цвета держатся смысла по всему экрану: оранжевый — биткоин, фиолетовый —
 * альты, синий — эфир, зелёный — USDT.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey } from "../i18n/types";
import { num, pct, usdWord } from "../lib/format";
import { haptic } from "../lib/telegram";
import { fetchDom, fetchMcap, peekDom, peekMcap } from "../lib/api";
import { Card, Empty, SectionTitle, Segmented, Skeleton } from "../components/ui";
import {
  DOM_TTL_MS, MCAP_RANGES, RANGES, STALE_DAYS, ago, altStats, beat, byWeek, change, daysOld, ebStats, everyNth, mcapAgo, mcapWindow, rebase,
  seasonOf, series, thin, windowOf, type DomReply, type McapDay, type McapRange, type McapReply, type Range,
} from "../lib/dom";
import { Frame } from "./Screen";
import { dateStr, timeTicks } from "./FearGreedScreen";
import { heightK, useWidth } from "./etfView";
import "./DominanceScreen.css";

type Lang = Parameters<typeof t>[0];

const C = { btc: "#f7931a", eth: "#627eea", alt: "#8b5cf6", usdt: "#26a17b", mid: "#6b7280" } as const;
const RANGE_KEY = "wt-dom-range";
const RANGE_LABEL = { 365: "fg_r1y", 1095: "fg_r3y", all: "fg_rall" } as const;
/** Сервер ещё собирает цены после первого запуска — спросить снова через столько, мс. */
const BUILD_RETRY_MS = 30_000;
/** Сеть не ответила — спросить снова через столько, мс (на экране тем временем копия). */
const FAIL_RETRY_MS = 60_000;
const iso = (x: string | number) => `⁦${x}⁩`;
/** Индекс узкой и широкой корзин расходится на столько пунктов — рост узкий (или широкий). */
const TIER_GAP = 15;

/** Когда собраны данные — по часам телефона. */
function stamp(lang: Lang, at: number): string {
  try {
    return new Intl.DateTimeFormat(lang, {
      day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
    }).format(new Date(at * 1000));
  } catch {
    return new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ");
  }
}

const SEASON = [
  { key: "dm_s_btc", c: C.btc },
  { key: "dm_s_mid", c: C.mid },
  { key: "dm_s_alt", c: C.alt },
] as const;

function durStr(lang: Lang, d: number): string {
  if (d < 60) return t(lang, "fg_days", { n: num(d) });
  if (d < 730) return t(lang, "dm_mo", { n: num(Math.round(d / 30.44)) });
  return t(lang, "dm_yr", { n: num(d / 365.25, 1) });
}

/* ---------------------------------------------------------------------- */

/** Место под подписи оси справа, px. */
const AXIS = 50;

/** Подписи времени: не теснее одной на 64 px. */
function ticksOf(lang: Lang, a: number, b: number, pw: number) {
  const all = timeTicks(lang, a, b);
  const step = Math.max(1, Math.ceil(all.length / Math.max(3, Math.floor(pw / 64))));
  return all.filter((_, i) => (all.length - 1 - i) % step === 0);
}

/** Ровные деления: 0,02 / 0,04 / 0,06, а не 0,033 / 0,067. */
function niceTicks(lo: number, hi: number): number[] {
  const raw = (hi - lo) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(Number(v.toPrecision(6)));
  return out;
}

/** Деления логарифмической шкалы: 1, 2, 5, 10, 20, 50… в пределах [lo, hi]; не больше пяти. */
function logTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 2, 5]) {
      const v = Number((m * 10 ** e).toPrecision(6));
      if (v >= lo && v <= hi) out.push(v);
    }
  }
  const step = Math.ceil(out.length / 5);
  return out.length < 2 ? niceTicks(lo, hi) : out.filter((_, i) => (out.length - 1 - i) % step === 0);
}

/**
 * Небольшой график одной величины: индекс альтсезона, сила альтов, ETH/BTC.
 * Рисуется в настоящих пикселях ширины (useWidth): подписи одного размера на
 * телефоне, планшете и компьютере; высота растёт с шириной, но график
 * помещается по высоте окна (heightK). Палец ведёт по дням; с клавиатуры —
 * стрелки, Home/End, Esc; подсказка слышна читалке экрана.
 */
function MiniChart({ pts, lang, color, bands, fmt, fixed, label, log }: {
  pts: [number, number][];
  lang: Lang;
  color: (v: number) => string;
  bands?: { from: number; to: number; c: string }[];
  fmt: (v: number) => string;
  fixed?: [number, number];
  label: string;
  /** Логарифмическая шкала: падение в 10 раз и рост в 10 раз — одна высота. */
  log?: boolean;
}) {
  const [picked, setSel] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const W = useWidth(ref);
  const PW = W - AXIS - 4;
  const MH = Math.round(120 * heightK(W, 146));
  const n = pts.length;
  /* Пришёл ответ с другим числом точек (сменилось окно) — выбор за краем не держим. */
  const sel = picked !== null && picked < n ? picked : null;
  const vals = pts.map((p) => p[1]);
  const lo = fixed ? fixed[0] : Math.min(...vals) * (log ? 0.9 : 0.95);
  const hi = fixed ? fixed[1] : Math.max(...vals) * (log ? 1.1 : 1.05);
  const xOf = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * PW);
  const f = log ? (v: number) => Math.log(Math.max(v, 1e-9)) : (v: number) => v;
  const yOf = (v: number) => 6 + (1 - (f(v) - f(lo)) / (f(hi) - f(lo) || 1)) * MH;
  const a = pts[0]?.[0] ?? 0;
  const b = pts[n - 1]?.[0] ?? 1;
  const xOfT = (ts: number) => ((ts - a) / Math.max(1, b - a)) * PW;
  /* Линия кусками своего цвета: у индекса цвет — зона. */
  const segs = useMemo(() => {
    const out: { c: string; pts: string }[] = [];
    let cur: { c: string; p: string[] } | null = null;
    pts.forEach((p, i) => {
      const c = color(p[1]);
      const xy = `${xOf(i).toFixed(1)},${yOf(p[1]).toFixed(1)}`;
      if (!cur || cur.c !== c) {
        if (cur) {
          cur.p.push(xy);
          out.push({ c: cur.c, pts: cur.p.join(" ") });
        }
        cur = { c, p: [xy] };
      } else cur.p.push(xy);
    });
    if (cur) out.push({ c: (cur as { c: string }).c, pts: (cur as { p: string[] }).p.join(" ") });
    return out;
  }, [pts, W, MH]);
  const pick = (clientX: number) => {
    const el = ref.current;
    if (!el || n < 1) return;
    const box = el.getBoundingClientRect();
    const x = ((clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round((x / PW) * (n - 1))));
    if (i !== sel) {
      haptic("select");
      setSel(i);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (!n) return;
    const go = (i: number) => {
      e.preventDefault();
      setSel(Math.max(0, Math.min(n - 1, i)));
    };
    if (e.key === "ArrowRight") go(sel === null ? n - 1 : sel + 1);
    else if (e.key === "ArrowLeft") go(sel === null ? n - 1 : sel - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(n - 1);
    else if (e.key === "Escape" && sel !== null) {
      e.preventDefault();
      setSel(null);
    }
  };
  const ticks = fixed ? [25, 50, 75] : log ? logTicks(lo, hi) : niceTicks(lo, hi);
  const p = sel !== null ? pts[sel] : undefined;
  const H2 = MH + 26;
  return (
    <div className="fg-plot dm-plot" tabIndex={0} role="group" aria-label={t(lang, "ef_keys")}
      onKeyDown={onKey} onBlur={() => setSel(null)}>
      <svg ref={ref} className="fg-svg dm-svg" viewBox={`0 0 ${W} ${H2}`} width="100%" role="img" aria-label={label}
        onPointerDown={(e: PointerEvent) => pick(e.clientX)}
        onPointerMove={(e: PointerEvent) => { if (e.pointerType === "mouse" || e.buttons) pick(e.clientX); }}
        onPointerUp={(e: PointerEvent) => { if (e.pointerType !== "mouse") setSel(null); }}
        onPointerCancel={() => setSel(null)}
        onPointerLeave={() => setSel(null)}
        onContextMenu={(e: MouseEvent) => e.preventDefault()}>
        <rect x={0} y={6} width={PW} height={MH} className="fg-bg" />
        {bands?.map((z) => (
          <rect key={z.from} x={0} y={yOf(z.to)} width={PW} height={yOf(z.from) - yOf(z.to)} fill={z.c} opacity={0.1} />
        ))}
        {ticksOf(lang, a, b, PW).map((x) => (
          <g key={x.t}>
            <line x1={xOfT(x.t)} x2={xOfT(x.t)} y1={6} y2={6 + MH} className="fg-grid" />
            <text x={xOfT(x.t)} y={H2 - 4} textAnchor="middle" className="fg-tick">{x.label}</text>
          </g>
        ))}
        {ticks.map((v) => (
          <g key={v}>
            <line x1={0} x2={PW} y1={yOf(v)} y2={yOf(v)} className="fg-grid" />
            <text x={W - 2} y={yOf(v) + 3.5} textAnchor="end" className="fg-tick">{fmt(v)}</text>
          </g>
        ))}
        {segs.map((sg, i) => <polyline key={i} points={sg.pts} stroke={sg.c} className="fg-line" />)}
        {p ? (
          <g className="fg-cross">
            <line x1={xOf(sel!)} x2={xOf(sel!)} y1={6} y2={6 + MH} />
            <circle cx={xOf(sel!)} cy={yOf(p[1])} r={4} fill={color(p[1])} />
          </g>
        ) : null}
      </svg>
      {p ? (
        <div className={sel! > n / 2 ? "fg-pop left" : "fg-pop"} aria-live="polite">
          <small>{dateStr(lang, p[0], { day: "numeric", month: "long", year: "numeric" })}</small>
          <b style={{ color: color(p[1]) }}><bdi dir="ltr">{fmt(p[1])}</bdi></b>
        </div>
      ) : null}
    </div>
  );
}

/** Индекс по неделям цифрами — для читалки экрана и для тех, кому цифры удобнее линии. */
function AltTable({ pts, lang }: { pts: [number, number][]; lang: Lang }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="dm-tbl dm-atbl" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{t(lang, "ef_tbl")}</summary>
      {open ? (
        <div className="dm-tbl-w">
          <table>
            <thead>
              <tr>
                <th scope="col">{t(lang, "ef_tbl_d")}</th>
                <th scope="col">{t(lang, "dm_tbl_idx")}</th>
                <th scope="col">{t(lang, "dm_tbl_zone")}</th>
              </tr>
            </thead>
            <tbody>
              {everyNth(pts, 7).map(([ts, v]) => (
                <tr key={ts}>
                  <th scope="row">{dateStr(lang, ts, { day: "numeric", month: "short", year: "numeric" })}</th>
                  <td>{v}</td>
                  <td>{t(lang, SEASON[seasonOf(v)].key)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </details>
  );
}

/* ---------------------------------------------------------------------- */

/** Шкала индекса 0–100: три зоны и отметка значения. */
function AltBar({ v, lang }: { v: number; lang: Lang }) {
  return (
    <div className="dm-abar" role="img" aria-label={`${v} — ${t(lang, SEASON[seasonOf(v)].key)}`}>
      <div className="dm-abar-track">
        <i style={{ width: "25%", background: C.btc }} />
        <i style={{ width: "50%", background: C.mid }} />
        <i style={{ width: "25%", background: C.alt }} />
        <b style={{ insetInlineStart: `${v}%` }} />
      </div>
      <div className="dm-abar-ends">
        <span style={{ color: C.btc }}>{t(lang, "dm_s_btc")}</span>
        <span style={{ color: C.alt }}>{t(lang, "dm_s_alt")}</span>
      </div>
    </div>
  );
}

/** Монеты за 90 дней против биткоина. */
function Top({ coins, btc, lang }: { coins: [string, number][]; btc: number; lang: Lang }) {
  const [all, setAll] = useState(false);
  const { up, dn } = beat(coins, btc);
  /* Бары — рост относительно биткоина, в логарифме: +5000% не должны
     сплющить остальных. Центр — сам биткоин. */
  const rel = (p: number) => Math.log((1 + p / 100) / (1 + btc / 100));
  /* Длина — корень из доли от лучшей: одна монета с +5000% не сжимает
     остальных в точку, а порядок полос всегда совпадает с порядком чисел. */
  const span = useMemo(() => Math.max(0.01, ...coins.map((c) => Math.abs(rel(c[1])))), [coins, btc]);
  const shown = all ? coins : coins.slice(0, 10);
  return (
    <Card>
      <p className="dm-top-h">
        {t(lang, "dm_top_n", { n: iso(num(up)), m: iso(num(dn)) })}
        <span> · BTC <bdi dir="ltr">{pct(btc, 1, true)}</bdi></span>
      </p>
      <div className="dm-top">
        {shown.map((c, i) => {
          const x = rel(c[1]) / span;
          const r = Math.sign(x) * Math.sqrt(Math.abs(x));
          return (
            <div key={c[0]} className="dm-top-r">
              <span className="dm-top-rank">{i + 1}</span>
              <span className="dm-top-s">{c[0]}</span>
              <span className="dm-top-bar">
                <i className="dm-top-mid" />
                <i className="dm-top-fill" style={r >= 0
                  ? { insetInlineStart: "50%", width: `${r * 50}%`, background: C.alt }
                  : { insetInlineEnd: "50%", width: `${-r * 50}%`, background: C.mid }} />
              </span>
              <b className={c[1] > btc ? "dm-beat" : ""}><bdi dir="ltr">{pct(c[1], 1, true)}</bdi></b>
            </div>
          );
        })}
      </div>
      {coins.length > 10 ? (
        <button type="button" className="dm-more" onClick={() => setAll((v) => !v)}>
          {all ? t(lang, "dm_less") : t(lang, "dm_all", { n: num(coins.length) })}
        </button>
      ) : null}
      <p className="lq-hint">{t(lang, "dm_top_note")}</p>
    </Card>
  );
}

/** Три плитки роста за 30, 90 и 365 суток. */
function Changes({ ch, lang }: { ch: (number | null)[]; lang: Lang }) {
  return (
    <div className="dm-chs three">
      {(["dm_30d", "dm_90d", "dm_year"] as const).map((k, i) => {
        const v = ch[i];
        return v === null || v === undefined ? null : (
          <div key={k} className="dm-ch">
            <small>{t(lang, k)}</small>
            <b className={v >= 0 ? "up" : "dn"}><bdi dir="ltr">{pct(v, 1, true)}</bdi></b>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------- */

/** Изменение доли в процентных пунктах со знаком: «+0,28 п.п.». Число — отдельным
 *  куском слева направо, иначе в арабском знак уезжает на другую сторону. */
function Pp({ d, lang }: { d: number; lang: Lang }) {
  const [before = "", after = ""] = t(lang, "dm_pp", { v: "\u0000" }).split("\u0000");
  const v = `${d > 0.005 ? "+" : d < -0.005 ? "−" : ""}${num(Math.abs(d), Math.abs(d) >= 10 ? 1 : 2)}`;
  return <>{before}<bdi dir="ltr">{v}</bdi>{after}</>;
}

/** Короткая шкала денег для оси: $2T, $500B, $20M. */
function axisUsd(v: number): string {
  const f = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  if (v >= 1e12) return `$${f(v / 1e12)}T`;
  if (v >= 1e9) return `$${f(v / 1e9)}B`;
  return `$${f(v / 1e6)}M`;
}

function usdTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let e = 6; e <= 15; e++) for (const m of [1, 2, 5]) {
    const v = m * 10 ** e;
    if (v >= lo && v <= hi) out.push(v);
  }
  return out.length > 6 ? out.filter((v) => String(v).startsWith("1")) : out;
}


/**
 * Биткоин против альтов: сверху — капитализация биткоина и всех остальных монет
 * (лог. шкала), снизу — доли рынка стопкой (биткоин, эфир, остальные). Палец и
 * клавиатура ведут по дням, подсказка слышна читалке экрана.
 */
function McapChart({ days, lang }: { days: McapDay[]; lang: Lang }) {
  const [picked, setSel] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const W = useWidth(ref);
  const PW = W - AXIS - 4;
  /* Высота — по ширине, но график целиком помещается в окно (телефон боком). */
  const k = heightK(W, 300);
  const P1 = { y: 6, h: Math.round(150 * k) };
  const P2 = { y: P1.y + P1.h + 14, h: Math.round(112 * k) };
  const MH2 = P2.y + P2.h + 18;
  const n = days.length;
  const sel = picked !== null && picked < n ? picked : null;
  const btcOf = (d: McapDay) => (d[1] * d[2]) / 100;
  const altOf = (d: McapDay) => d[1] - btcOf(d);
  const lo = Math.min(...days.map((d) => Math.min(btcOf(d), altOf(d))));
  const hi = Math.max(...days.map((d) => Math.max(btcOf(d), altOf(d))));
  const L = (v: number) => Math.log(Math.max(1, v));
  const yLo = L(lo * 0.8);
  const yHi = L(hi * 1.15);
  const xOf = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * PW);
  const yUsd = (v: number) => P1.y + (1 - (L(v) - yLo) / (yHi - yLo || 1)) * P1.h;
  const yPct = (v: number) => P2.y + (1 - v / 100) * P2.h;
  const a = days[0]?.[0] ?? 0;
  const b = days[n - 1]?.[0] ?? 1;
  const xOfT = (ts: number) => ((ts - a) / Math.max(1, b - a)) * PW;
  const paths = useMemo(() => {
    const line = (f: (d: McapDay) => number) => days.map((d, i) => `${xOf(i).toFixed(1)},${f(d).toFixed(1)}`).join(" ");
    const edge = (f: (d: McapDay) => number) => days.map((d, i) => `${xOf(i).toFixed(1)},${yPct(f(d)).toFixed(1)}`);
    const e1 = edge((d) => d[2]);
    const e2 = edge((d) => d[2] + (d[3] ?? 0));
    const base = `${PW},${yPct(0)} 0,${yPct(0)}`;
    const band = (lower: string[], upper: string[]) => `${upper.join(" ")} ${[...lower].reverse().join(" ")}`;
    return {
      btc: line((d) => yUsd(btcOf(d))),
      alt: line((d) => yUsd(altOf(d))),
      aBtc: `${e1.join(" ")} ${base}`,
      aEth: band(e1, e2),
      aAlt: band(e2, edge(() => 100)),
      dom: e1.join(" "),
    };
  }, [days, W, k]);
  const pick = (clientX: number) => {
    const el = ref.current;
    if (!el || n < 1) return;
    const box = el.getBoundingClientRect();
    const x = ((clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round((x / PW) * (n - 1))));
    if (i !== sel) {
      haptic("select");
      setSel(i);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (!n) return;
    const go = (i: number) => {
      e.preventDefault();
      setSel(Math.max(0, Math.min(n - 1, i)));
    };
    if (e.key === "ArrowRight") go(sel === null ? n - 1 : sel + 1);
    else if (e.key === "ArrowLeft") go(sel === null ? n - 1 : sel - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(n - 1);
    else if (e.key === "Escape" && sel !== null) {
      e.preventDefault();
      setSel(null);
    }
  };
  const d = sel !== null ? days[sel] : undefined;
  return (
    <div className="fg-plot dm-plot" tabIndex={0} role="group" aria-label={t(lang, "ef_keys")}
      onKeyDown={onKey} onBlur={() => setSel(null)}>
      <svg ref={ref} className="fg-svg dm-svg dm-mc" viewBox={`0 0 ${W} ${MH2}`} width="100%" role="img" aria-label={t(lang, "dm_chart")}
        onPointerDown={(e: PointerEvent) => pick(e.clientX)}
        onPointerMove={(e: PointerEvent) => { if (e.pointerType === "mouse" || e.buttons) pick(e.clientX); }}
        onPointerUp={(e: PointerEvent) => { if (e.pointerType !== "mouse") setSel(null); }}
        onPointerCancel={() => setSel(null)}
        onPointerLeave={() => setSel(null)}
        onContextMenu={(e: MouseEvent) => e.preventDefault()}>
        <rect x={0} y={P1.y} width={PW} height={P1.h} className="fg-bg" />
        <rect x={0} y={P2.y} width={PW} height={P2.h} className="fg-bg" />
        <polygon points={paths.aBtc} fill={C.btc} opacity={0.55} />
        <polygon points={paths.aEth} fill={C.eth} opacity={0.55} />
        <polygon points={paths.aAlt} fill={C.alt} opacity={0.45} />
        <polyline points={paths.dom} className="fg-line" stroke={C.btc} />
        {ticksOf(lang, a, b, PW).map((x) => (
          <g key={x.t}>
            <line x1={xOfT(x.t)} x2={xOfT(x.t)} y1={P1.y} y2={P2.y + P2.h} className="fg-grid" />
            <text x={xOfT(x.t)} y={MH2 - 4} textAnchor="middle" className="fg-tick">{x.label}</text>
          </g>
        ))}
        {usdTicks(lo * 0.8, hi * 1.15).map((v) => (
          <g key={v}>
            <line x1={0} x2={PW} y1={yUsd(v)} y2={yUsd(v)} className="fg-grid" />
            <text x={W - 2} y={yUsd(v) + 3.5} textAnchor="end" className="fg-tick">{axisUsd(v)}</text>
          </g>
        ))}
        {[25, 50, 75].map((v) => (
          <g key={v}>
            <line x1={0} x2={PW} y1={yPct(v)} y2={yPct(v)} className="dm-grid-hi" />
            <text x={W - 2} y={yPct(v) + 3.5} textAnchor="end" className="fg-tick">{v}%</text>
          </g>
        ))}
        <text x={4} y={P1.y + 11} className="fg-ptl">{t(lang, "dm_p1")} · {t(lang, "fg_log")}</text>
        <text x={4} y={P2.y + 11} className="fg-ptl">{t(lang, "dm_p2")}</text>
        <polyline points={paths.alt} className="fg-line" stroke={C.alt} />
        <polyline points={paths.btc} className="fg-line" stroke={C.btc} />
        {d ? (
          <g className="fg-cross">
            <line x1={xOf(sel!)} x2={xOf(sel!)} y1={P1.y} y2={P2.y + P2.h} />
            <circle cx={xOf(sel!)} cy={yUsd(btcOf(d))} r={4} fill={C.btc} />
            <circle cx={xOf(sel!)} cy={yUsd(altOf(d))} r={4} fill={C.alt} />
            <circle cx={xOf(sel!)} cy={yPct(d[2])} r={4} fill={C.btc} />
          </g>
        ) : null}
      </svg>
      {d ? (
        <div className={sel! > n / 2 ? "fg-pop left dm-pop" : "fg-pop dm-pop"} aria-live="polite">
          <small>{dateStr(lang, d[0], { day: "numeric", month: "long", year: "numeric" })}</small>
          <span><i style={{ background: C.btc }} />BTC <bdi dir="ltr">{usdWord(btcOf(d))} · {pct(d[2], 1, false)}</bdi></span>
          <span><i style={{ background: C.alt }} />{t(lang, "dm_alts")} <bdi dir="ltr">{usdWord(altOf(d))}</bdi></span>
          {d[3] !== null ? <span><i style={{ background: C.eth }} />ETH <bdi dir="ltr">{pct(d[3], 1, false)}</bdi></span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Тот же график цифрами — раз в неделю, свежие сверху. */
function McapTable({ days, lang }: { days: McapDay[]; lang: Lang }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="dm-tbl dm-mtbl" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{t(lang, "ef_tbl")}</summary>
      {open ? (
        <div className="dm-tbl-w">
          <table>
            <thead>
              <tr>
                <th scope="col">{t(lang, "ef_tbl_d")}</th>
                <th scope="col">{t(lang, "dm_btc")}</th>
                <th scope="col">{t(lang, "dm_alts")}</th>
                <th scope="col">BTC %</th>
                <th scope="col">ETH %</th>
              </tr>
            </thead>
            <tbody>
              {byWeek(days).map(([ts, cap, btc, eth]) => (
                <tr key={ts}>
                  <th scope="row">{dateStr(lang, ts, { day: "numeric", month: "short", year: "numeric" })}</th>
                  <td><bdi dir="ltr">{usdWord((cap * btc) / 100)}</bdi></td>
                  <td><bdi dir="ltr">{usdWord(cap - (cap * btc) / 100)}</bdi></td>
                  <td><bdi dir="ltr">{pct(btc, 1, false)}</bdi></td>
                  <td>{eth !== null ? <bdi dir="ltr">{pct(eth, 1, false)}</bdi> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </details>
  );
}

const MCAP_RANGE_LABEL = { 365: "fg_r1y", 1095: "fg_r3y", 1825: "dm_r5y", all: "fg_rall" } as const;
const MCAP_RANGE_KEY = "wt-mcap-range";

/**
 * Капитализация и доминация — как в начале модуля, по официальному API
 * CoinMarketCap: сумма рынка и её изменения, доля биткоина (и без
 * стейблкоинов) с изменениями в пунктах, из чего состоит рынок, график
 * «биткоин против альтов» с 2013 г.
 */
function McapBlock({ m, lang }: { m: McapReply; lang: Lang }) {
  const [range, setRange] = useState<McapRange>(() => {
    try {
      return MCAP_RANGES.find((r) => r === localStorage.getItem(MCAP_RANGE_KEY)) ?? "1095";
    } catch {
      return "1095";
    }
  });
  const pickRange = (r: McapRange) => {
    setRange(r);
    try {
      localStorage.setItem(MCAP_RANGE_KEY, r);
    } catch {
      // без памяти выбора — не беда
    }
  };
  const h = m.hist;
  const win = useMemo(() => mcapWindow(h, range), [h, range]);
  const view = useMemo(() => thin(win), [win]);
  const cap = m.cap[0];
  const stable = m.altNs !== null ? Math.max(0, 100 - m.btc[0] - m.altNs) : null;
  const ex = stable !== null && stable < 100 - m.btc[0] ? (m.btc[0] / (100 - stable)) * 100 : null;
  const capCh: [DictKey, number | null][] = [
    ["dm_24h", m.cap[1] ? (cap / m.cap[1] - 1) * 100 : null],
    ...([["dm_7d", 7], ["dm_30d", 30], ["dm_year", 365]] as const).map(([k, n]): [DictKey, number | null] => {
      const p = mcapAgo(h, n);
      return [k, p ? (cap / p[1] - 1) * 100 : null];
    }),
  ];
  const domCh: [DictKey, number | null][] = [
    ["dm_24h", m.btc[1] !== null ? m.btc[0] - m.btc[1] : null],
    ...([["dm_7d", 7], ["dm_30d", 30], ["dm_year", 365]] as const).map(([k, n]): [DictKey, number | null] => {
      const p = mcapAgo(h, n);
      return [k, p ? m.btc[0] - p[2] : null];
    }),
  ];
  /* Куда шли деньги за 30 дней: капитализация биткоина и всех остальных монет. */
  const p30 = mcapAgo(h, 30);
  const flow = p30 ? {
    b: ((cap * m.btc[0]) / (p30[1] * p30[2]) - 1) * 100,
    a: ((cap * (100 - m.btc[0])) / (p30[1] * (100 - p30[2])) - 1) * 100,
  } : null;
  const other = Math.max(0, 100 - m.btc[0] - m.eth[0] - (stable ?? 0));
  const parts: { key: DictKey; c: string; v: number; sub?: string | undefined }[] = [
    { key: "dm_btc", c: C.btc, v: m.btc[0] },
    { key: "dm_eth", c: C.eth, v: m.eth[0] },
    ...(stable !== null ? [{ key: "dm_st" as DictKey, c: C.usdt, v: stable, sub: m.usdt !== null ? `USDT ${pct(m.usdt, 1, false)}` : undefined }] : []),
    { key: "dm_other", c: C.alt, v: other },
  ];
  return (
    <>
      <Card>
        <div className="dm-cap">
          <small>{t(lang, "dm_total")}</small>
          <b><bdi dir="ltr">{usdWord(cap)}</bdi></b>
          <div className="dm-cap-ch">
            {capCh.map(([k, v]) => v === null ? null : (
              <span key={k}>{t(lang, k)} <em className={v >= 0 ? "up" : "dn"}><bdi dir="ltr">{pct(v, 1, true)}</bdi></em></span>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <div className="dm-hero">
          <small>{t(lang, "dm_dom")}</small>
          <b style={{ color: C.btc }}><bdi dir="ltr">{pct(m.btc[0], 1, false)}</bdi></b>
          {ex !== null ? (
            <span className="dm-x">{t(lang, "dm_ex")} <b><bdi dir="ltr">{pct(ex, 1, false)}</bdi></b></span>
          ) : null}
        </div>
        <div className="dm-chs">
          {domCh.map(([k, v]) => v === null ? null : (
            <div key={k} className="dm-ch">
              <small>{t(lang, k)}</small>
              <b><Pp d={v} lang={lang} /></b>
            </div>
          ))}
        </div>
        {flow ? (
          <p className="dm-flow">
            {t(lang, "dm_say_flow", { b: iso(pct(flow.b, 1, true)), a: iso(pct(flow.a, 1, true)) })}{" "}
            <b>{t(lang, Math.abs(flow.a - flow.b) < 2 ? "dm_flow_eq" : flow.a > flow.b ? "dm_flow_alt" : "dm_flow_btc")}</b>
          </p>
        ) : null}
        {ex !== null ? <p className="lq-hint dm-exh">{t(lang, "dm_ex_hint")}</p> : null}
        <p className="dm-cap-t">{t(lang, "dm_split")}</p>
        <div className="fg-dist dm-split" role="img"
          aria-label={parts.map((p) => `${t(lang, p.key)} ${pct(p.v, 1, false)}`).join(", ")}>
          {parts.map((p) => p.v > 0 ? <i key={p.key} style={{ width: `${p.v}%`, background: p.c }} /> : null)}
        </div>
        <div className="fg-rows">
          {parts.map((p) => (
            <div key={p.key} className="fg-row two">
              <span><i style={{ background: p.c }} />{t(lang, p.key)}{p.sub ? <small className="dm-sub"> · {p.sub}</small> : null}</span>
              <b><bdi dir="ltr">{pct(p.v, 1, false)}</bdi><small> · {usdWord((cap * p.v) / 100)}</small></b>
            </div>
          ))}
        </div>
      </Card>

      {view.length > 30 ? (
        <>
          <SectionTitle help={["dm_chart_help"]}>{t(lang, "dm_chart")}</SectionTitle>
          <Card>
            <Segmented<McapRange>
              value={range}
              onChange={pickRange}
              options={MCAP_RANGES.map((id) => ({ id, label: t(lang, MCAP_RANGE_LABEL[id]) }))}
            />
            <div className="fg-legend dm-lines">
              <span><i style={{ background: C.btc }} />{t(lang, "dm_btc")}</span>
              <span><i style={{ background: C.alt }} />{t(lang, "dm_alts")}</span>
            </div>
            <McapChart days={view} lang={lang} />
            <div className="fg-legend">
              <span><i style={{ background: C.btc }} />{t(lang, "dm_btc")}</span>
              <span><i style={{ background: C.eth }} />{t(lang, "dm_eth")}</span>
              <span><i style={{ background: C.alt }} />{t(lang, "dm_other")}</span>
            </div>
            <p className="lq-hint">{t(lang, "dm_chart_hint")}</p>
            <McapTable days={win} lang={lang} />
          </Card>
        </>
      ) : null}
      <p className="dm-dsrc">{t(lang, "dm_d_src")} {stamp(lang, m.at)}</p>
    </>
  );
}

/* ---------------------------------------------------------------------- */

export function DominanceScreen() {
  const lang = useApp((s) => s.lang);
  const [reply, setReply] = useState<DomReply | null>(() => peekDom() ?? null);
  const [state, setState] = useState<"wait" | "failed" | "building">("wait");
  const [retry, setRetry] = useState(0);
  const [mcap, setMcap] = useState<McapReply | null>(() => peekMcap() ?? null);
  const [range, setRange] = useState<Range>(() => {
    try {
      const v = localStorage.getItem(RANGE_KEY);
      return RANGES.find((r) => r === v) ?? "all";
    } catch {
      return "all";
    }
  });

  /* Когда ответ последний раз пришёл из сети (мс): вернувшись в приложение
     через час и больше, экран сам берёт свежий — Telegram держит открытое
     приложение сколько угодно. */
  const got = useRef(0);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    void fetchDom().then((r) => {
      if (!alive) return;
      if (r === "building") {
        setState("building");
        timer = window.setTimeout(() => setRetry((n) => n + 1), BUILD_RETRY_MS);
      } else if (r) {
        setReply(r);
        got.current = Date.now();
        setState("wait");
      } else {
        setState("failed");
        timer = window.setTimeout(() => setRetry((n) => n + 1), FAIL_RETRY_MS);
      }
    });
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [retry]);
  useEffect(() => {
    let alive = true;
    void fetchMcap().then((r) => {
      if (alive && r) setMcap(r);
    });
    return () => {
      alive = false;
    };
  }, [retry]);
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === "visible" && got.current && Date.now() - got.current > DOM_TTL_MS) setRetry((n) => n + 1);
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []);

  const pickRange = (r: Range) => {
    setRange(r);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      // без памяти выбора — не беда
    }
  };

  const rows = useMemo(() => reply?.rows ?? [], [reply]);
  const alt = useMemo(() => series(rows, 1), [rows]);
  const str = useMemo(() => series(rows, 2), [rows]);
  const strW = useMemo(() => rebase(windowOf(str, range)), [str, range]);
  const eb = useMemo(() => series(rows, 3), [rows]);
  const stats = useMemo(() => altStats(alt), [alt]);
  const ebS = useMemo(() => ebStats(eb), [eb]);
  const now = alt[alt.length - 1];
  const coins = reply?.coins ?? [];
  const btc90 = reply?.btc90 ?? null;
  const k = btc90 !== null ? beat(coins, btc90).up : 0;
  const old = daysOld(rows, Date.now() / 1000);
  const tiers = (reply?.tiers ?? []).filter((x): x is [number, number, number] => x[1] !== null);
  const spread = tiers.length > 1 ? tiers[0]![1] - tiers[tiers.length - 1]![1] : 0;

  const altCell = (key: DictKey, p: [number, number] | null) => p ? (
    <div key={key} className="fg-cmp-c">
      <small>{t(lang, key)}</small>
      <b style={{ color: SEASON[seasonOf(p[1])].c }}>{p[1]}</b>
      <span>{t(lang, SEASON[seasonOf(p[1])].key)}</span>
    </div>
  ) : null;

  const rangeSeg = (
    <Segmented<Range>
      value={range}
      onChange={pickRange}
      options={RANGES.map((id) => ({ id, label: t(lang, RANGE_LABEL[id]) }))}
    />
  );

  return (
    <Frame title={t(lang, "dm_title")}>
      <div className="dm">
      <p className="lq-lead">{t(lang, "dm_sub")}</p>

      {mcap ? (
        <>
          <SectionTitle help={["dm_d_what", "dm_how_4"]}>{t(lang, "dm_d_title")}</SectionTitle>
          <McapBlock m={mcap} lang={lang} />
        </>
      ) : null}

      {!reply ? (
        state === "failed" ? (
          <Empty text={t(lang, "dm_err")} hint={
            <button type="button" className="lq-retry" onClick={() => setRetry((n) => n + 1)}>{t(lang, "ui_retry")}</button>
          } />
        ) : state === "building" ? (
          <Card><p className="lq-hint" role="status">{t(lang, "dm_building")}</p><Skeleton rows={6} /></Card>
        ) : <div aria-busy="true"><Card><Skeleton rows={8} /></Card></div>
      ) : (
        <>
          {/* Сеть не ответила, а на экране — сохранённая копия: показываем её молча,
              обновление повторится само (FAIL_RETRY_MS). Hyperliquid давно не присылал
              цен — говорим прямо, иначе вчерашний индекс выглядел бы сегодняшним. */}
          {got.current && old > STALE_DAYS ? (
            <p className="lq-stale" role="status">{t(lang, "dm_old", { n: iso(num(old)) })}</p>
          ) : null}
          {now && stats ? (
            <>
            <SectionTitle help={["dm_how_1", "dm_tiers_help", "dm_how_6"]}>{t(lang, "dm_alt_title")}</SectionTitle>
            <Card>
              <div className="dm-ahero">
                <b style={{ color: SEASON[seasonOf(now[1])].c }}>{now[1]}</b>
                <span>/100</span>
                <em style={{ color: SEASON[seasonOf(now[1])].c }}>{t(lang, SEASON[seasonOf(now[1])].key)}</em>
              </div>
              <AltBar v={now[1]} lang={lang} />
              {coins.length ? <p className="dm-ahint">{t(lang, "dm_alt_what", { k: iso(num(k)), n: iso(num(coins.length)) })}</p> : null}
              <div className="fg-cmp">
                {altCell("fg_yday", ago(alt, 1))}
                {altCell("fg_week", ago(alt, 7))}
                {altCell("fg_month", ago(alt, 30))}
              </div>
              {tiers.length > 1 ? (
                <div className="dm-tiers">
                  <p>{t(lang, "dm_tiers")}</p>
                  <div className="fg-cmp">
                    {tiers.map(([size, v]) => (
                      <div key={size} className="fg-cmp-c">
                        <small>{t(lang, "dm_tier", { n: iso(num(size)) })}</small>
                        <b style={{ color: SEASON[seasonOf(v)].c }}>{v}</b>
                        <span>{t(lang, SEASON[seasonOf(v)].key)}</span>
                      </div>
                    ))}
                  </div>
                  <p>{t(lang, spread >= TIER_GAP ? "dm_tiers_narrow" : spread <= -TIER_GAP ? "dm_tiers_wide" : "dm_tiers_even")}</p>
                </div>
              ) : null}
              <div className="fg-year">
                <span>{t(lang, "fg_hi")} <b style={{ color: SEASON[seasonOf(stats.hi[1])].c }}>{stats.hi[1]}</b>
                  <small> · {dateStr(lang, stats.hi[0], { day: "numeric", month: "short", year: "numeric" })}</small></span>
                <span>{t(lang, "fg_lo")} <b style={{ color: SEASON[seasonOf(stats.lo[1])].c }}>{stats.lo[1]}</b>
                  <small> · {dateStr(lang, stats.lo[0], { day: "numeric", month: "short", year: "numeric" })}</small></span>
              </div>
              {coins.length ? (
                <div className="dm-say">
                  <p>
                    <b style={{ color: SEASON[seasonOf(now[1])].c }}>{t(lang, SEASON[seasonOf(now[1])].key)}.</b>{" "}
                    {t(lang, now[1] >= 75 ? "dm_say_alt" : now[1] <= 25 ? "dm_say_btc" : "dm_say_mid", {
                      k: iso(num(k)), n: iso(num(coins.length)),
                    })}{" "}
                    {/* «9 дн.» уже с точкой — вторую не ставим. */}
                    {t(lang, "dm_say_run", { d: durStr(lang, stats.run) }).replace(/\.\.$/, ".")}
                  </p>
                </div>
              ) : null}
              <p className="fg-date">
                {t(lang, "dm_day", { d: dateStr(lang, now[0], { day: "numeric", month: "long", year: "numeric" }) })}
                {" · "}{stamp(lang, reply.at)}
              </p>
            </Card>
            </>
          ) : null}

          {stats && alt.length > 30 ? (
            <>
              <SectionTitle help={["dm_how_3"]}>{t(lang, "dm_alt_hist")}</SectionTitle>
              <Card>
                {rangeSeg}
                <MiniChart
                  pts={thin(windowOf(alt, range))}
                  lang={lang}
                  label={t(lang, "dm_alt_title")}
                  color={(v) => SEASON[seasonOf(v)].c}
                  bands={[{ from: 0, to: 25, c: C.btc }, { from: 75, to: 100, c: C.alt }]}
                  fmt={(v) => num(v)}
                  fixed={[0, 100]}
                />
                <AltTable pts={windowOf(alt, range)} lang={lang} />
                <p className="dm-share">
                  {t(lang, "dm_alt_days", {
                    d: dateStr(lang, stats.from, { day: "numeric", month: "long", year: "numeric" }),
                    a: iso(num(stats.cnt[2])), b: iso(num(stats.cnt[0])), n: iso(num(stats.n)),
                  })}{" "}
                  {t(lang, "dm_alt_peak", {
                    v: iso(stats.max[1]), d: dateStr(lang, stats.max[0], { day: "numeric", month: "short", year: "numeric" }),
                  })}
                </p>
              </Card>
            </>
          ) : null}

          {strW.length > 30 ? (
            <>
              <SectionTitle help={["dm_how_2", "dm_how_3"]}>{t(lang, "dm_str_title")}</SectionTitle>
              <Card>
                {/* Сила — от начала выбранного срока: 100 — его первый день. За всю
                    историю альты слабели сильно, и от 2023 г. число было бы
                    крошечным, а изменения за год — не видны. */}
                <div className="dm-eb">
                  <b style={{ color: C.alt }}><bdi dir="ltr">{num(strW[strW.length - 1]![1], 1)}</bdi></b>
                  <span>{t(lang, "dm_str_base", { d: dateStr(lang, strW[0]![0], { day: "numeric", month: "long", year: "numeric" }) })}</span>
                </div>
                {rangeSeg}
                <Changes ch={[30, 90, 365].map((n) => change(str, n))} lang={lang} />
                <MiniChart pts={thin(strW)} lang={lang} label={t(lang, "dm_str_title")}
                  color={() => C.alt} fmt={(v) => num(v, v < 10 ? 1 : 0)} log />
                <p className="lq-hint">{t(lang, "dm_str_what", { n: iso(num(reply.n)) })}</p>
              </Card>
            </>
          ) : null}

          {coins.length && btc90 !== null ? (
            <>
              <SectionTitle help={["dm_top_help"]}>{t(lang, "dm_top_title")}</SectionTitle>
              <Top coins={coins} btc={btc90} lang={lang} />
            </>
          ) : null}

          {ebS ? (
            <>
              <SectionTitle help={["dm_how_5"]}>ETH/BTC</SectionTitle>
              <Card>
                <div className="dm-eb">
                  <b style={{ color: C.eth }}><bdi dir="ltr">{num(ebS.cur[1], 5)}</bdi></b>
                  <span>{t(lang, "dm_eb_what")}</span>
                </div>
                <Changes ch={ebS.ch} lang={lang} />
                <MiniChart pts={thin(windowOf(eb, range))} lang={lang} label="ETH/BTC" color={() => C.eth} fmt={(v) => num(v, 3)} />
                <p className="dm-share">
                  {t(lang, "dm_eb_pos", {
                    p: iso(pct(ebS.above * 100, 0, false)), d: dateStr(lang, eb[0]![0], { day: "numeric", month: "long", year: "numeric" }),
                  })}{" "}
                  {t(lang, "dm_eb_range", {
                    hi: iso(num(ebS.hi[1], 4)), hd: dateStr(lang, ebS.hi[0], { month: "short", year: "numeric" }),
                    lo: iso(num(ebS.lo[1], 4)), ld: dateStr(lang, ebS.lo[0], { month: "short", year: "numeric" }),
                  })}
                </p>
              </Card>
            </>
          ) : null}

          <details className="lq-how">
            <summary>{t(lang, "fg_how")}</summary>
            <ul>
              <li>{t(lang, "dm_how_1")}</li>
              <li>{t(lang, "dm_how_2")}</li>
              <li>{t(lang, "dm_how_3")}</li>
              <li>{t(lang, "dm_how_6")}</li>
              <li>{t(lang, "dm_how_5")}</li>
              <li>{t(lang, "dm_d_what")}</li>
              <li>{t(lang, "dm_how_4")}</li>
            </ul>
          </details>
          <p className="lq-src">{t(lang, "dm_src")}</p>
        </>
      )}
      </div>
    </Frame>
  );
}

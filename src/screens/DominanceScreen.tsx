/**
 * Доминация и альтсезон: чья доля рынка растёт — биткоина или альтов.
 *
 * Сверху — главное одной картинкой: доля биткоина сейчас и за 24 часа,
 * неделю, месяц и год, из чего сложен рынок (биткоин, эфир, стейблкоины,
 * остальные альты) и короткий вывод словами. Ниже — индекс альтсезона
 * CoinMarketCap: сколько из 100 крупнейших монет обогнали биткоин за 90
 * дней; 75 и выше — альтсезон, 25 и ниже — сезон биткоина.
 *
 * Главный график — две панели на одной оси времени с 2013 года: капитализация
 * биткоина и альтов в долларах (одна шкала, логарифм) и доли рынка стопкой
 * до 100%. Верх оранжевой полосы и есть доминация.
 *
 * Стейблкоины — не ставка на альты: в страхе деньги уходят в доллар-токены,
 * и доля биткоина падает без всякого альтсезона. Поэтому рядом всегда стоит
 * доля «без стейблкоинов», и волны считаются по ней: волна — движение доли
 * минимум на 10 п.п. без обратного хода на 10 п.п. Из этого же следует
 * уровень, ниже которого нынешняя волна сменится.
 *
 * Цвета держатся смысла по всему экрану: оранжевый — биткоин, фиолетовый —
 * альты, синий — эфир, зелёный — стейблкоины.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey } from "../i18n/types";
import { num, pct, usdWord } from "../lib/format";
import { haptic } from "../lib/telegram";
import { fetchDom, peekDom } from "../lib/api";
import { Card, Empty, SectionTitle, Segmented, Skeleton } from "../components/ui";
import type { AltPoint, DomReply } from "../lib/types";
import { Frame } from "./Screen";
import { dateStr, timeTicks } from "./FearGreedScreen";

type Lang = Parameters<typeof t>[0];
type Range = "365" | "1095" | "1825" | "all";

const C = { btc: "#f7931a", eth: "#627eea", st: "#26a17b", alt: "#8b5cf6", mid: "#6b7280" } as const;
const RANGE_KEY = "wt-dom-range";
/** Порог волны: доля биткоина без стейблкоинов, п.п. */
const WAVE = 10;
const iso = (x: string | number) => `⁦${x}⁩`;

/** День рынка: деньги в долларах, доли в процентах. */
interface Day {
  t: number;
  tot: number;
  btc: number;
  eth: number;
  st: number;
  /** Альты без стейблкоинов (эфир входит). */
  alt: number;
  bd: number;
  ed: number;
  sd: number;
  /** Доля биткоина среди биткоина и альтов — без стейблкоинов. */
  xd: number;
  eb: number;
}

function toDays(r: DomReply): Day[] {
  return r.rows.map((x, i) => {
    const tot = x[0] * 1e6;
    const btc = (tot * x[1]) / 100;
    const st = Math.min(x[3] * 1e6, tot - btc);
    const eth = (tot * x[2]) / 100;
    const alt = Math.max(1, tot - btc - st);
    return {
      t: r.t0 + i * 86400, tot, btc, eth, st, alt,
      bd: x[1], ed: x[2], sd: (st / tot) * 100, xd: (btc / (btc + alt)) * 100, eb: x[4],
    };
  });
}

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

const seasonOf = (v: number) => (v >= 75 ? 2 : v <= 25 ? 0 : 1);
const SEASON = [
  { key: "dm_s_btc", c: C.btc },
  { key: "dm_s_mid", c: C.mid },
  { key: "dm_s_alt", c: C.alt },
] as const;

/** Короткая шкала денег для оси: $2T, $500B, $20M. */
function axisUsd(v: number): string {
  const f = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  if (v >= 1e12) return `$${f(v / 1e12)}T`;
  if (v >= 1e9) return `$${f(v / 1e9)}B`;
  return `$${f(v / 1e6)}M`;
}

/** Процентные пункты со знаком: «+1,2 п.п.». */
function pp(lang: Lang, v: number): string {
  const s = v > 0.005 ? "+" : v < -0.005 ? "−" : "";
  return t(lang, "dm_pp", { v: `${s}${num(Math.abs(v), Math.abs(v) >= 10 ? 1 : 2)}` });
}

/**
 * Волны: движения доли не меньше порога без обратного хода на порог.
 * Возвращает точки разворота и текущую, ещё идущую волну с её крайним днём.
 */
function waves(v: number[], th: number) {
  const piv: number[] = [0];
  let dir = 0;
  let ext = 0;
  for (let i = 1; i < v.length; i++) {
    const x = v[i]!;
    if (dir === 0) {
      if (x - v[0]! >= th) { dir = 1; ext = i; }
      else if (v[0]! - x >= th) { dir = -1; ext = i; }
    } else if (dir === 1) {
      if (x > v[ext]!) ext = i;
      else if (v[ext]! - x >= th) { piv.push(ext); dir = -1; ext = i; }
    } else {
      if (x < v[ext]!) ext = i;
      else if (x - v[ext]! >= th) { piv.push(ext); dir = 1; ext = i; }
    }
  }
  return { piv, dir, ext };
}

function durStr(lang: Lang, d: number): string {
  if (d < 60) return t(lang, "fg_days", { n: num(d) });
  if (d < 730) return t(lang, "dm_mo", { n: num(Math.round(d / 30.44)) });
  return t(lang, "dm_yr", { n: num(d / 365.25, 1) });
}

/* ---------------------------------------------------------------------- */

const W = 360;
const AXIS = 50;
const PW = W - AXIS - 4;
const P1 = { y: 6, h: 150 };
const P2 = { y: 170, h: 112 };
const H = P2.y + P2.h + 18;

function usdTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let e = 6; e <= 14; e++) for (const m of [1, 2, 5]) {
    const v = m * 10 ** e;
    if (v >= lo && v <= hi) out.push(v);
  }
  return out.length > 7 ? out.filter((v) => String(v).startsWith("1")) : out;
}

/** Подписи времени: не больше семи, иначе годы с 2013 слипаются. */
function ticksOf(lang: Lang, a: number, b: number) {
  const all = timeTicks(lang, a, b);
  const step = Math.max(1, Math.ceil(all.length / 7));
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

/** Точки по пальцу: общая часть обоих графиков экрана. */
function useScrub(n: number, width: number, onSel: (i: number | null) => void, sel: number | null) {
  const ref = useRef<SVGSVGElement>(null);
  const pick = (clientX: number) => {
    const el = ref.current;
    if (!el || n < 1) return;
    const box = el.getBoundingClientRect();
    const x = ((clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round((x / width) * (n - 1))));
    if (i !== sel) {
      haptic("select");
      onSel(i);
    }
  };
  return {
    ref,
    handlers: {
      onPointerDown: (e: PointerEvent) => pick(e.clientX),
      onPointerMove: (e: PointerEvent) => { if (e.pointerType === "mouse" || e.buttons) pick(e.clientX); },
      onPointerUp: (e: PointerEvent) => { if (e.pointerType !== "mouse") onSel(null); },
      onPointerCancel: () => onSel(null),
      onPointerLeave: () => onSel(null),
      onContextMenu: (e: MouseEvent) => e.preventDefault(),
    },
  };
}

function MainChart({ days, lang, sel, onSel }: {
  days: Day[];
  lang: Lang;
  sel: number | null;
  onSel: (i: number | null) => void;
}) {
  const n = days.length;
  const lo = Math.min(...days.map((d) => Math.min(d.btc, d.alt)));
  const hi = Math.max(...days.map((d) => Math.max(d.btc, d.alt)));
  const L = (v: number) => Math.log(Math.max(1, v));
  const yLo = L(lo * 0.8);
  const yHi = L(hi * 1.15);
  const xOf = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * PW);
  const yUsd = (v: number) => P1.y + (1 - (L(v) - yLo) / (yHi - yLo)) * P1.h;
  const yPct = (v: number) => P2.y + (1 - v / 100) * P2.h;
  const a = days[0]?.t ?? 0;
  const b = days[n - 1]?.t ?? 1;
  const xOfT = (ts: number) => ((ts - a) / Math.max(1, b - a)) * PW;

  const paths = useMemo(() => {
    const line = (f: (d: Day) => number) => days.map((d, i) => `${xOf(i).toFixed(1)},${f(d).toFixed(1)}`).join(" ");
    /* Полосы стопкой снизу вверх: биткоин, эфир, стейблкоины, остальные. */
    const edge = (f: (d: Day) => number) => days.map((d, i) => `${xOf(i).toFixed(1)},${yPct(f(d)).toFixed(1)}`);
    const e1 = edge((d) => d.bd);
    const e2 = edge((d) => d.bd + d.ed);
    const e3 = edge((d) => d.bd + d.ed + d.sd);
    const base = `${PW},${yPct(0)} 0,${yPct(0)}`;
    const band = (lower: string[], upper: string[]) => `${upper.join(" ")} ${[...lower].reverse().join(" ")}`;
    return {
      btc: line((d) => yUsd(d.btc)),
      alt: line((d) => yUsd(d.alt)),
      aBtc: `${e1.join(" ")} ${base}`,
      aEth: band(e1, e2),
      aSt: band(e2, e3),
      aAlt: band(e3, edge(() => 100)),
      dom: e1.join(" "),
    };
  }, [days]);

  const { ref, handlers } = useScrub(n, PW, onSel, sel);
  const tt = ticksOf(lang, a, b);
  const d = sel !== null ? days[sel] : undefined;

  return (
    <svg ref={ref} className="fg-svg" viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
      aria-label={t(lang, "dm_chart")} {...handlers}>
      <rect x={0} y={P1.y} width={PW} height={P1.h} className="fg-bg" />
      <rect x={0} y={P2.y} width={PW} height={P2.h} className="fg-bg" />
      <polygon points={paths.aBtc} fill={C.btc} opacity={0.55} />
      <polygon points={paths.aEth} fill={C.eth} opacity={0.55} />
      <polygon points={paths.aSt} fill={C.st} opacity={0.55} />
      <polygon points={paths.aAlt} fill={C.alt} opacity={0.45} />
      <polyline points={paths.dom} className="fg-line" stroke={C.btc} />
      {tt.map((x) => (
        <g key={x.t}>
          <line x1={xOfT(x.t)} x2={xOfT(x.t)} y1={P1.y} y2={P2.y + P2.h} className="fg-grid" />
          <text x={xOfT(x.t)} y={H - 4} textAnchor="middle" className="fg-tick">{x.label}</text>
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
          <circle cx={xOf(sel!)} cy={yUsd(d.btc)} r={4} fill={C.btc} />
          <circle cx={xOf(sel!)} cy={yUsd(d.alt)} r={4} fill={C.alt} />
          <circle cx={xOf(sel!)} cy={yPct(d.bd)} r={4} fill={C.btc} />
        </g>
      ) : null}
    </svg>
  );
}

/** Небольшой график одной величины: индекс альтсезона, ETH/BTC. */
function MiniChart({ pts, lang, color, bands, fmt, fixed, label }: {
  pts: [number, number][];
  lang: Lang;
  color: (v: number) => string;
  bands?: { from: number; to: number; c: string }[];
  fmt: (v: number) => string;
  fixed?: [number, number];
  label: string;
}) {
  const [sel, setSel] = useState<number | null>(null);
  const n = pts.length;
  const MW = PW;
  const MH = 120;
  const vals = pts.map((p) => p[1]);
  const lo = fixed ? fixed[0] : Math.min(...vals) * 0.95;
  const hi = fixed ? fixed[1] : Math.max(...vals) * 1.05;
  const xOf = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * MW);
  const yOf = (v: number) => 6 + (1 - (v - lo) / (hi - lo)) * MH;
  const a = pts[0]?.[0] ?? 0;
  const b = pts[n - 1]?.[0] ?? 1;
  const xOfT = (ts: number) => ((ts - a) / Math.max(1, b - a)) * MW;
  const { ref, handlers } = useScrub(n, MW, setSel, sel);
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
  }, [pts]);
  const ticks = fixed ? [25, 50, 75] : niceTicks(lo, hi);
  const p = sel !== null ? pts[sel] : undefined;
  const H2 = MH + 26;
  return (
    <div className="fg-plot">
      <svg ref={ref} className="fg-svg" viewBox={`0 0 ${W} ${H2}`} width="100%" role="img" aria-label={label} {...handlers}>
        <rect x={0} y={6} width={MW} height={MH} className="fg-bg" />
        {bands?.map((z) => (
          <rect key={z.from} x={0} y={yOf(z.to)} width={MW} height={yOf(z.from) - yOf(z.to)} fill={z.c} opacity={0.1} />
        ))}
        {ticksOf(lang, a, b).map((x) => (
          <g key={x.t}>
            <line x1={xOfT(x.t)} x2={xOfT(x.t)} y1={6} y2={6 + MH} className="fg-grid" />
            <text x={xOfT(x.t)} y={H2 - 4} textAnchor="middle" className="fg-tick">{x.label}</text>
          </g>
        ))}
        {ticks.map((v) => (
          <g key={v}>
            <line x1={0} x2={MW} y1={yOf(v)} y2={yOf(v)} className="fg-grid" />
            <text x={W - 2} y={yOf(v) + 3.5} textAnchor="end" className="fg-tick">{fmt(v)}</text>
          </g>
        ))}
        {segs.map((s, i) => <polyline key={i} points={s.pts} stroke={s.c} className="fg-line" />)}
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

/* ---------------------------------------------------------------------- */

function Split({ d, lang }: { d: Day; lang: Lang }) {
  const other = Math.max(0, d.tot - d.btc - d.eth - d.st);
  const parts = [
    { key: "dm_btc", c: C.btc, v: d.btc },
    { key: "dm_eth", c: C.eth, v: d.eth },
    { key: "dm_st", c: C.st, v: d.st },
    { key: "dm_other", c: C.alt, v: other },
  ] as const;
  return (
    <>
      <div className="fg-dist dm-split" role="img" aria-label={t(lang, "dm_split")}>
        {parts.map((p) => p.v > 0 ? <i key={p.key} style={{ width: `${(p.v / d.tot) * 100}%`, background: p.c }} /> : null)}
      </div>
      <div className="fg-rows">
        {parts.map((p) => (
          <div key={p.key} className="fg-row two">
            <span><i style={{ background: p.c }} />{t(lang, p.key)}</span>
            <b><bdi dir="ltr">{pct((p.v / d.tot) * 100, 1, false)}</bdi><small> · {usdWord(p.v)}</small></b>
          </div>
        ))}
      </div>
    </>
  );
}

/** Шкала индекса 0–100: три зоны и отметка значения. */
function AltBar({ v, lang }: { v: number; lang: Lang }) {
  return (
    <div className="dm-abar" role="img" aria-label={`${v} — ${t(lang, SEASON[seasonOf(v)]!.key)}`}>
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

function Top({ top, btc, lang }: { top: [string, string, number][]; btc: number; lang: Lang }) {
  const [all, setAll] = useState(false);
  const coins = useMemo(() => top.filter((c) => c[0] !== "BTC").sort((a, b) => b[2] - a[2]), [top]);
  const beat = coins.filter((c) => c[2] > btc).length;
  /* Бары — рост относительно биткоина, в логарифме: +5000% не должны
     сплющить остальных. Центр — сам биткоин. */
  const rel = (p: number) => Math.log((1 + p / 100) / (1 + btc / 100));
  /* Длина — корень из доли от лучшей: одна монета с +5000% не сжимает
     остальных в точку, а порядок полос всегда совпадает с порядком чисел. */
  const span = useMemo(() => Math.max(0.01, ...coins.map((c) => Math.abs(rel(c[2])))), [coins, btc]);
  const shown = all ? coins : coins.slice(0, 10);
  return (
    <Card>
      <p className="dm-top-h">
        {t(lang, "dm_top_n", { n: iso(num(beat)), m: iso(num(coins.length - beat)) })}
        <span> · BTC <bdi dir="ltr">{pct(btc, 1, true)}</bdi></span>
      </p>
      <div className="dm-top">
        {shown.map((c, i) => {
          const x = rel(c[2]) / span;
          const r = Math.sign(x) * Math.sqrt(Math.abs(x));
          return (
            <div key={c[0] + i} className="dm-top-r">
              <span className="dm-top-rank">{i + 1}</span>
              <span className="dm-top-s" title={c[1]}>{c[0]}</span>
              <span className="dm-top-bar">
                <i className="dm-top-mid" />
                <i className="dm-top-fill" style={r >= 0
                  ? { insetInlineStart: "50%", width: `${r * 50}%`, background: C.alt }
                  : { insetInlineEnd: "50%", width: `${-r * 50}%`, background: C.mid }} />
              </span>
              <b className={c[2] > btc ? "dm-beat" : ""}><bdi dir="ltr">{pct(c[2], 1, true)}</bdi></b>
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

/* ---------------------------------------------------------------------- */

export function DominanceScreen() {
  const lang = useApp((s) => s.lang);
  const [reply, setReply] = useState<DomReply | null>(() => peekDom() ?? null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [range, setRange] = useState<Range>(() => {
    try {
      const v = localStorage.getItem(RANGE_KEY);
      return (["365", "1095", "1825", "all"].includes(v ?? "") ? v : "all") as Range;
    } catch {
      return "all";
    }
  });
  const [sel, setSel] = useState<number | null>(null);
  const [allWaves, setAllWaves] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void fetchDom().then((r) => {
      if (!alive) return;
      if (r?.ok && r.rows.length) setReply(r);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [retry]);

  const pickRange = (r: Range) => {
    setRange(r);
    setSel(null);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      // без памяти выбора — не беда
    }
  };

  const all = useMemo(() => (reply ? toDays(reply) : []), [reply]);
  const last = all[all.length - 1];
  const back = (n: number) => all[Math.max(0, all.length - 1 - n)];

  /* На графике не больше ~600 точек: ширина экрана всё равно меньше. */
  const view = useMemo(() => {
    const src = range === "all" ? all : all.slice(-Number(range));
    const step = Math.max(1, Math.ceil(src.length / 600));
    const out = src.filter((_, i) => i % step === 0);
    const tail = src[src.length - 1];
    if (tail && out[out.length - 1] !== tail) out.push(tail);
    return out;
  }, [all, range]);

  const wave = useMemo(() => {
    if (all.length < 30) return null;
    const v = all.map((d) => d.xd);
    const { piv, dir, ext } = waves(v, WAVE);
    const list = piv.slice(1).map((p, k) => ({ a: piv[k]!, b: p }));
    return { list, from: piv[piv.length - 1]!, dir, ext, v };
  }, [all]);

  const alt = reply?.alt ?? {};
  const altNow = alt.now?.[0];
  const altStats = useMemo(() => {
    const p = alt.pts ?? [];
    if (!p.length) return null;
    const cnt = [0, 0, 0];
    p.forEach(([, v]) => { cnt[seasonOf(v)]! += 1; });
    const maxP = p.reduce((m, x) => (x[1] > m[1] ? x : m), p[0]!);
    const minP = p.reduce((m, x) => (x[1] < m[1] ? x : m), p[0]!);
    return { cnt, n: p.length, from: p[0]![0], maxP, minP };
  }, [alt.pts]);
  const btc90 = alt.top?.find((c) => c[0] === "BTC")?.[2];

  const eb = useMemo(() => {
    const e = all.filter((d) => d.eb > 0);
    if (e.length < 60) return null;
    const cur = e[e.length - 1]!;
    const ago = (n: number) => e[Math.max(0, e.length - 1 - n)]!.eb;
    const hi = e.reduce((m, d) => (d.eb > m.eb ? d : m), e[0]!);
    const lo = e.reduce((m, d) => (d.eb < m.eb ? d : m), e[0]!);
    const above = e.filter((d) => d.eb > cur.eb).length / e.length;
    return { e, cur, ch: [30, 90, 365].map((n) => (cur.eb / ago(n) - 1) * 100), hi, lo, above };
  }, [all]);

  const selDay = sel !== null ? view[sel] : undefined;

  const flow30 = last ? (() => {
    const p = back(30)!;
    /* Доля без стейблкоинов: иначе рост стейблов мог дать «доля упала,
       хотя биткоин был сильнее альтов». */
    return { b: (last.btc / p.btc - 1) * 100, a: (last.alt / p.alt - 1) * 100, d: last.xd - p.xd };
  })() : null;

  const cmp = (lbl: DictKey, p: Day | undefined) => {
    if (!last || !p) return null;
    const v = last.bd - p.bd;
    return (
      <div key={lbl} className="dm-ch">
        <small>{t(lang, lbl)}</small>
        <b><i style={{ color: v >= 0 ? C.btc : C.alt }}>{v >= 0 ? "▲" : "▼"}</i><bdi dir="ltr">{pp(lang, v)}</bdi></b>
      </div>
    );
  };

  const altCell = (k: DictKey, p: AltPoint | null | undefined) => p ? (
    <div key={k} className="fg-cmp-c">
      <small>{t(lang, k)}</small>
      <b style={{ color: SEASON[seasonOf(p[0])]!.c }}>{p[0]}</b>
      <span>{t(lang, SEASON[seasonOf(p[0])]!.key)}</span>
    </div>
  ) : null;

  return (
    <Frame title={t(lang, "dm_title")}>
      <p className="lq-lead">{t(lang, "dm_sub")}</p>

      {!reply ? (
        failed ? (
          <Empty text={t(lang, "dm_err")} hint={
            <button type="button" className="lq-retry" onClick={() => setRetry((n) => n + 1)}>{t(lang, "ui_retry")}</button>
          } />
        ) : <Card><Skeleton rows={8} /></Card>
      ) : !last ? null : (
        <>
          <Card>
            <div className="dm-cap">
              <small>{t(lang, "dm_total")}</small>
              <b><bdi dir="ltr">{usdWord(last.tot)}</bdi></b>
              <div className="dm-cap-ch">
                {([["dm_24h", 1], ["dm_7d", 7], ["dm_30d", 30], ["dm_year", 365]] as const).map(([k, n]) => {
                  const ch = (last.tot / back(n)!.tot - 1) * 100;
                  return (
                    <span key={k}>{t(lang, k)} <em className={ch >= 0 ? "up" : "dn"}><bdi dir="ltr">{pct(ch, 1, true)}</bdi></em></span>
                  );
                })}
              </div>
              <p className="fg-date">{stamp(lang, reply.at)}</p>
            </div>
          </Card>

          <Card>
            <div className="dm-hero">
              <small>{t(lang, "dm_dom")}</small>
              <b style={{ color: C.btc }}><bdi dir="ltr">{pct(last.bd, 1, false)}</bdi></b>
              <span className="dm-x">
                {t(lang, "dm_ex")} <b><bdi dir="ltr">{pct(last.xd, 1, false)}</bdi></b>
              </span>
            </div>
            <div className="dm-chs">
              {cmp("dm_24h", back(1))}
              {cmp("dm_7d", back(7))}
              {cmp("dm_30d", back(30))}
              {cmp("dm_year", back(365))}
            </div>
            <p className="lq-hint dm-exh">{t(lang, "dm_ex_hint")}</p>
            <p className="dm-cap-t">{t(lang, "dm_split")}</p>
            <Split d={last} lang={lang} />
          </Card>

          <Card>
            <div className="dm-say">
              {altNow !== undefined ? (
                <p>
                  <b style={{ color: SEASON[seasonOf(altNow)]!.c }}>{t(lang, SEASON[seasonOf(altNow)]!.key)}.</b>{" "}
                  {t(lang, altNow >= 75 ? "dm_say_alt" : altNow <= 25 ? "dm_say_btc" : "dm_say_mid", { n: iso(altNow) })}
                </p>
              ) : null}
              {flow30 ? (
                <p>
                  {t(lang, "dm_say_flow", {
                    b: iso(pct(flow30.b, 1, true)), a: iso(pct(flow30.a, 1, true)), d: iso(pp(lang, flow30.d)),
                  })}{" "}
                  {t(lang, Math.abs(flow30.a - flow30.b) < 2 ? "dm_flow_eq" : flow30.a > flow30.b ? "dm_flow_alt" : "dm_flow_btc")}
                </p>
              ) : null}
              {wave ? (() => {
                const from = all[wave.from]!;
                const peak = all[wave.ext]!;
                const up = wave.dir >= 0;
                const lvl = up ? peak.xd - WAVE : peak.xd + WAVE;
                return (
                  <p>
                    {t(lang, up ? "dm_say_wave_btc" : "dm_say_wave_alt", {
                      d: dateStr(lang, from.t, { day: "numeric", month: "long", year: "numeric" }),
                      a: iso(pct(from.xd, 1, false)), b: iso(pct(last.xd, 1, false)),
                    })}{" "}
                    {t(lang, up ? "dm_say_flip_alt" : "dm_say_flip_btc", {
                      l: `${iso(pct(lvl, 1, false))} (${iso(pp(lang, lvl - last.xd))})`,
                    })}
                  </p>
                );
              })() : null}
            </div>
          </Card>

          {altNow !== undefined ? (
            <>
              <SectionTitle>{t(lang, "dm_alt_title")}</SectionTitle>
              <Card>
                <div className="dm-ahero">
                  <b style={{ color: SEASON[seasonOf(altNow)]!.c }}>{altNow}</b>
                  <span>/100</span>
                  <em style={{ color: SEASON[seasonOf(altNow)]!.c }}>{t(lang, SEASON[seasonOf(altNow)]!.key)}</em>
                </div>
                <AltBar v={altNow} lang={lang} />
                <p className="dm-ahint">{t(lang, "dm_alt_what", { n: iso(altNow) })}</p>
                <div className="fg-cmp">
                  {altCell("fg_yday", alt.d1)}
                  {altCell("fg_week", alt.d7)}
                  {altCell("fg_month", alt.d30)}
                </div>
                {alt.hi && alt.lo ? (
                  <div className="fg-year">
                    <span>{t(lang, "fg_hi")} <b style={{ color: SEASON[seasonOf(alt.hi[0])]!.c }}>{alt.hi[0]}</b>
                      <small> · {dateStr(lang, alt.hi[1], { day: "numeric", month: "short", year: "numeric" })}</small></span>
                    <span>{t(lang, "fg_lo")} <b style={{ color: SEASON[seasonOf(alt.lo[0])]!.c }}>{alt.lo[0]}</b>
                      <small> · {dateStr(lang, alt.lo[1], { day: "numeric", month: "short", year: "numeric" })}</small></span>
                  </div>
                ) : null}
                {alt.pts && alt.pts.length > 30 ? (
                  <MiniChart
                    pts={alt.pts}
                    lang={lang}
                    label={t(lang, "dm_alt_title")}
                    color={(v) => SEASON[seasonOf(v)]!.c}
                    bands={[{ from: 0, to: 25, c: C.btc }, { from: 75, to: 100, c: C.alt }]}
                    fmt={(v) => num(v)}
                    fixed={[0, 100]}
                  />
                ) : null}
                {altStats ? (
                  <p className="dm-share">
                    {t(lang, "dm_alt_days", {
                      d: dateStr(lang, altStats.from, { day: "numeric", month: "long", year: "numeric" }),
                      a: iso(num(altStats.cnt[2])), b: iso(num(altStats.cnt[0])), n: iso(num(altStats.n)),
                    })}{" "}
                    {t(lang, "dm_alt_peak", {
                      v: iso(altStats.maxP[1]), d: dateStr(lang, altStats.maxP[0], { day: "numeric", month: "short", year: "numeric" }),
                    })}
                  </p>
                ) : null}
              </Card>
            </>
          ) : null}

          <SectionTitle>{t(lang, "dm_chart")}</SectionTitle>
          <Card>
            <Segmented<Range>
              value={range}
              onChange={pickRange}
              options={[
                { id: "365", label: t(lang, "fg_r1y") },
                { id: "1095", label: t(lang, "fg_r3y") },
                { id: "1825", label: t(lang, "dm_r5y") },
                { id: "all", label: t(lang, "fg_rall") },
              ]}
            />
            <div className="fg-legend dm-lines">
              <span><i style={{ background: C.btc }} />{t(lang, "dm_btc")}</span>
              <span><i style={{ background: C.alt }} />{t(lang, "dm_alts_ex")}</span>
            </div>
            <div className="fg-plot">
              <MainChart days={view} lang={lang} sel={sel} onSel={setSel} />
              {selDay ? (
                <div className={sel! > view.length / 2 ? "fg-pop left dm-pop" : "fg-pop dm-pop"} aria-live="polite">
                  <small>{dateStr(lang, selDay.t, { day: "numeric", month: "long", year: "numeric" })}</small>
                  <span><i style={{ background: C.btc }} />BTC <bdi dir="ltr">{usdWord(selDay.btc)} · {pct(selDay.bd, 1, false)}</bdi></span>
                  <span><i style={{ background: C.alt }} />{t(lang, "dm_alts")} <bdi dir="ltr">{usdWord(selDay.alt)}</bdi></span>
                  {selDay.ed > 0 ? <span><i style={{ background: C.eth }} />ETH <bdi dir="ltr">{pct(selDay.ed, 1, false)}</bdi></span> : null}
                  {selDay.sd >= 0.05 ? <span><i style={{ background: C.st }} />{t(lang, "dm_st")} <bdi dir="ltr">{pct(selDay.sd, 1, false)}</bdi></span> : null}
                  <em>BTC · {t(lang, "dm_ex")} <bdi dir="ltr">{pct(selDay.xd, 1, false)}</bdi></em>
                </div>
              ) : null}
            </div>
            <div className="fg-legend">
              <span><i style={{ background: C.btc }} />{t(lang, "dm_btc")}</span>
              <span><i style={{ background: C.eth }} />{t(lang, "dm_eth")}</span>
              <span><i style={{ background: C.st }} />{t(lang, "dm_st")}</span>
              <span><i style={{ background: C.alt }} />{t(lang, "dm_other")}</span>
            </div>
            <p className="lq-hint">{t(lang, "dm_chart_hint")} {t(lang, "fg_hint")}</p>
          </Card>

          {alt.top?.length && btc90 !== undefined ? (
            <>
              <SectionTitle>{t(lang, "dm_top_title")}</SectionTitle>
              <Top top={alt.top} btc={btc90} lang={lang} />
            </>
          ) : null}

          {wave && wave.list.length ? (() => {
            const cur = { a: wave.from, b: all.length - 1 };
            const every = [...wave.list, cur].reverse();
            const rows = allWaves ? every : every.slice(0, 6);
            const dur = (w: { a: number; b: number }) => (all[w.b]!.t - all[w.a]!.t) / 86400;
            const altW = wave.list.filter((w) => wave.v[w.b]! < wave.v[w.a]!);
            const btcW = wave.list.filter((w) => wave.v[w.b]! > wave.v[w.a]!);
            const avg = (ws: typeof altW) => (ws.length ? ws.reduce((s, w) => s + dur(w), 0) / ws.length : 0);
            return (
              <>
                <SectionTitle>{t(lang, "dm_w_title")}</SectionTitle>
                <Card>
                  <p className="dm-w-lead">
                    {t(lang, "dm_w_avg", {
                      a: iso(num(altW.length)), ad: durStr(lang, avg(altW)), b: iso(num(btcW.length)), bd: durStr(lang, avg(btcW)),
                    })}
                  </p>
                  <div className="dm-waves">
                    {rows.map((w, k) => {
                      const up = k === 0 ? wave.dir >= 0 : wave.v[w.b]! > wave.v[w.a]!;
                      const c = up ? C.btc : C.alt;
                      return (
                        <div key={w.a} className={k === 0 ? "dm-w now" : "dm-w"} style={{ borderInlineStartColor: c }}>
                          <span>
                            <b style={{ color: c }}>{t(lang, up ? "dm_w_btc" : "dm_w_alt")}</b>
                            {k === 0 ? <em>{t(lang, "dm_w_now")}</em> : null}
                          </span>
                          <b className="dm-w-v"><bdi dir="ltr">{pct(wave.v[w.a]!, 1, false)} → {pct(wave.v[w.b]!, 1, false)}</bdi></b>
                          <small>
                            {dateStr(lang, all[w.a]!.t, { month: "short", year: "numeric" })} — {k === 0
                              ? t(lang, "dm_w_today") : dateStr(lang, all[w.b]!.t, { month: "short", year: "numeric" })}
                          </small>
                          <small className="dm-w-d">{durStr(lang, dur(w))}</small>
                          {k === 0 && wave.ext !== w.b ? (
                            <small className="dm-w-pk">
                              {t(lang, up ? "dm_w_peak" : "dm_w_low", {
                                v: iso(pct(wave.v[wave.ext]!, 1, false)), d: dateStr(lang, all[wave.ext]!.t, { month: "short", year: "numeric" }),
                              })}
                            </small>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  {every.length > 6 ? (
                    <button type="button" className="dm-more" onClick={() => setAllWaves((v) => !v)}>
                      {allWaves ? t(lang, "dm_less") : t(lang, "dm_all", { n: num(every.length) })}
                    </button>
                  ) : null}
                  <p className="lq-hint">{t(lang, "dm_w_note", { n: iso(WAVE) })}</p>
                </Card>
              </>
            );
          })() : null}

          {eb ? (
            <>
              <SectionTitle>ETH/BTC</SectionTitle>
              <Card>
                <div className="dm-eb">
                  <b style={{ color: C.eth }}><bdi dir="ltr">{num(eb.cur.eb, 5)}</bdi></b>
                  <span>{t(lang, "dm_eb_what")}</span>
                </div>
                <div className="dm-chs three">
                  {(["dm_30d", "dm_90d", "dm_year"] as const).map((k, i) => (
                    <div key={k} className="dm-ch">
                      <small>{t(lang, k)}</small>
                      <b className={eb.ch[i]! >= 0 ? "up" : "dn"}><bdi dir="ltr">{pct(eb.ch[i]!, 1, true)}</bdi></b>
                    </div>
                  ))}
                </div>
                <MiniChart
                  pts={eb.e.filter((_, i) => i % 3 === 0 || i === eb.e.length - 1).map((d) => [d.t, d.eb])}
                  lang={lang}
                  label="ETH/BTC"
                  color={() => C.eth}
                  fmt={(v) => num(v, 3)}
                />
                <p className="dm-share">
                  {t(lang, "dm_eb_pos", {
                    p: iso(pct(eb.above * 100, 0, false)), d: dateStr(lang, eb.e[0]!.t, { day: "numeric", month: "long", year: "numeric" }),
                  })}{" "}
                  {t(lang, "dm_eb_range", {
                    hi: iso(num(eb.hi.eb, 4)), hd: dateStr(lang, eb.hi.t, { month: "short", year: "numeric" }),
                    lo: iso(num(eb.lo.eb, 4)), ld: dateStr(lang, eb.lo.t, { month: "short", year: "numeric" }),
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
              <li>{t(lang, "dm_how_4", { n: WAVE })}</li>
              <li>{t(lang, "dm_how_5")}</li>
            </ul>
          </details>
          <p className="lq-src">{t(lang, "dm_src")}</p>
        </>
      )}
    </Frame>
  );
}

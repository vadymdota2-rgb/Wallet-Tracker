/**
 * Страх и жадность: индекс настроения крипторынка alternative.me рядом с
 * ценой биткоина — за все дни с февраля 2018.
 *
 * Сверху — главное: где индекс сейчас (шкала-полукруг) и куда он шёл за
 * день, неделю и месяц, плюс крайние значения за год. Ниже — две панели на
 * одной оси времени: цена BTC, окрашенная по настроению того дня, и сам
 * индекс на фоне пяти зон. Это две оси цены и индекса на двух панелях, а не
 * две шкалы поверх одного поля: так каждая читается сама по себе, а общее
 * время связывает их. Палец на графике показывает любой день целиком.
 *
 * Внизу — что было в каждой зоне: сколько дней рынок в ней провёл и как в
 * среднем менялась цена за следующие 30 дней. Это история, а не прогноз, и
 * экран так и говорит.
 *
 * Цвета зон — привычные по Binance и CoinMarketCap: красный — крайний
 * страх, оранжевый, жёлтый — нейтрально, салатовый, зелёный — крайняя
 * жадность. Границы — как у самого индекса alternative.me.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { num, pct, px } from "../lib/format";
import { haptic } from "../lib/telegram";
import { fetchFng, peekFng } from "../lib/api";
import { Card, Empty, SectionTitle, Segmented, Skeleton } from "../components/ui";
import type { FngReply } from "../lib/types";
import { Frame } from "./Screen";
import { FearGreedInsights } from "./FearGreedInsights";

type Lang = Parameters<typeof t>[0];
type Day = [number, number, number];
type Range = "30" | "90" | "365" | "1095" | "all";

const ZONES = [
  { max: 25, key: "fg_z0", c: "#ea3943" },
  { max: 46, key: "fg_z1", c: "#f5841f" },
  { max: 54, key: "fg_z2", c: "#f3d42f" },
  { max: 75, key: "fg_z3", c: "#93d900" },
  { max: 100, key: "fg_z4", c: "#16c784" },
] as const;
const zoneOf = (v: number) => ZONES.findIndex((z) => v <= z.max);
const colorOf = (v: number) => ZONES[Math.max(0, zoneOf(v))]?.c ?? "#888";
const RANGE_KEY = "wt-fg-range";

function dateStr(lang: Lang, ts: number, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(lang, { timeZone: "UTC", ...opts }).format(new Date(ts * 1000));
  } catch {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }
}

/** Шкала-полукруг: пять зон, стрелка на значении, число и зона под ней. */
function Gauge({ v, lang }: { v: number; lang: Lang }) {
  const cx = 110;
  const cy = 104;
  const r = 86;
  const pt = (val: number, rr = r) => {
    const a = Math.PI - (val / 100) * Math.PI;
    return [cx + rr * Math.cos(a), cy - rr * Math.sin(a)] as const;
  };
  let lo = 0;
  const arcs = ZONES.map((z, i) => {
    const a0 = lo + (i ? 0.8 : 0);
    const a1 = z.max - (i < ZONES.length - 1 ? 0.8 : 0);
    lo = z.max;
    const [x0, y0] = pt(a0);
    const [x1, y1] = pt(a1);
    return <path key={z.key} d={`M${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1}`} stroke={z.c}
      strokeWidth={14} fill="none" opacity={zoneOf(v) === i ? 1 : 0.35} />;
  });
  const [nx, ny] = pt(v, r - 20);
  const zi = Math.max(0, zoneOf(v));
  return (
    <svg className="fg-gauge" viewBox="0 0 220 124" role="img"
      aria-label={`${v} — ${t(lang, ZONES[zi]!.key)}`}>
      {arcs}
      <line x1={cx} y1={cy} x2={nx} y2={ny} className="fg-needle" />
      <circle cx={cx} cy={cy} r={5.5} className="fg-hub" />
      <text x={16} y={122} className="fg-end">0</text>
      <text x={204} y={122} className="fg-end" textAnchor="end">100</text>
    </svg>
  );
}

const W = 360;
const AXIS = 50;
const PW = W - AXIS - 4;
const P1 = { y: 6, h: 168 };
const P2 = { y: 188, h: 92 };
const H = P2.y + P2.h + 18;

function priceTicks(lo: number, hi: number, log: boolean): number[] {
  if (log) {
    const out: number[] = [];
    for (let e = 2; e <= 7; e++) for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= lo && v <= hi) out.push(v);
    }
    return out;
  }
  const raw = (hi - lo) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

function timeTicks(lang: Lang, a: number, b: number): { t: number; label: string }[] {
  const span = (b - a) / 86400;
  const out: { t: number; label: string }[] = [];
  const d0 = new Date(a * 1000);
  const y0 = d0.getUTCFullYear();
  const y1 = new Date(b * 1000).getUTCFullYear();
  if (span > 800) {
    for (let y = y0 + 1; y <= y1; y++) out.push({ t: Date.UTC(y, 0, 1) / 1000, label: String(y) });
  } else if (span > 200) {
    for (let y = y0; y <= y1; y++) for (const m of [0, 3, 6, 9]) {
      const ts = Date.UTC(y, m, 1) / 1000;
      if (ts > a && ts < b) out.push({ t: ts, label: m === 0 ? String(y) : dateStr(lang, ts, { month: "short" }) });
    }
  } else if (span > 45) {
    for (let y = y0; y <= y1; y++) for (let m = 0; m < 12; m++) {
      const ts = Date.UTC(y, m, 1) / 1000;
      if (ts > a && ts < b) out.push({ t: ts, label: dateStr(lang, ts, { month: "short" }) });
    }
  } else {
    for (let ts = a + 3 * 86400; ts < b; ts += 7 * 86400) out.push({ t: ts, label: dateStr(lang, ts, { day: "numeric", month: "short" }) });
  }
  return out;
}

/** Линия по дням, разрезанная на куски одного цвета — по зоне дня. */
function runs(days: Day[], xOf: (i: number) => number, yOf: (d: Day) => number) {
  const out: { c: string; pts: string }[] = [];
  let cur: { c: string; pts: string[] } | null = null;
  days.forEach((d, i) => {
    const c = colorOf(d[1]);
    const p = `${xOf(i).toFixed(1)},${yOf(d).toFixed(1)}`;
    if (!cur || cur.c !== c) {
      if (cur) {
        cur.pts.push(p);
        out.push({ c: cur.c, pts: cur.pts.join(" ") });
      }
      cur = { c, pts: [p] };
    } else {
      cur.pts.push(p);
    }
  });
  if (cur) out.push({ c: (cur as { c: string }).c, pts: (cur as { pts: string[] }).pts.join(" ") });
  return out;
}

function Chart({ days, lang, sel, onSel }: {
  days: Day[];
  lang: Lang;
  sel: number | null;
  onSel: (i: number | null) => void;
}) {
  const withPx = days.filter((d) => d[2] > 0);
  const lo = Math.min(...withPx.map((d) => d[2]));
  const hi = Math.max(...withPx.map((d) => d[2]));
  const log = hi / Math.max(1, lo) > 4;
  const f = (v: number) => (log ? Math.log(v) : v);
  const pLo = f(lo * (log ? 0.92 : 0.98));
  const pHi = f(hi * (log ? 1.08 : 1.02));
  const n = days.length;
  const xOf = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * PW);
  const yPx = (v: number) => P1.y + (1 - (f(v) - pLo) / (pHi - pLo)) * P1.h;
  const yIx = (v: number) => P2.y + (1 - v / 100) * P2.h;
  const a = days[0]?.[0] ?? 0;
  const b = days[n - 1]?.[0] ?? 1;
  const xOfT = (ts: number) => ((ts - a) / Math.max(1, b - a)) * PW;

  const priceRuns = useMemo(() => runs(days, xOf, (d) => yPx(d[2] > 0 ? d[2] : lo)), [days]);
  const idxRuns = useMemo(() => runs(days, xOf, (d) => yIx(d[1])), [days]);
  const ticks = priceTicks(lo, hi, log);
  const tt = timeTicks(lang, a, b);

  const svgRef = useRef<SVGSVGElement>(null);
  const pick = (clientX: number) => {
    const el = svgRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const x = ((clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round((x / PW) * (n - 1))));
    if (i !== sel) {
      haptic("select");
      onSel(i);
    }
  };
  const d = sel !== null ? days[sel] : undefined;
  let lastBand = 0;

  return (
    <svg
      ref={svgRef}
      className="fg-svg"
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={t(lang, "fg_title")}
      onPointerDown={(e) => pick(e.clientX)}
      onPointerMove={(e) => { if (e.pointerType === "mouse" || e.buttons) pick(e.clientX); }}
      onPointerUp={(e) => { if (e.pointerType !== "mouse") onSel(null); }}
      onPointerCancel={() => onSel(null)}
      onPointerLeave={() => onSel(null)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <rect x={0} y={P1.y} width={PW} height={P1.h} className="fg-bg" />
      <rect x={0} y={P2.y} width={PW} height={P2.h} className="fg-bg" />
      {/* Зоны индекса — полосами на фоне нижней панели. */}
      {ZONES.map((z) => {
        const y0 = yIx(z.max);
        const y1 = yIx(lastBand);
        lastBand = z.max;
        return <rect key={z.key} x={0} y={y0} width={PW} height={y1 - y0} fill={z.c} opacity={0.1} />;
      })}
      {tt.map((x) => (
        <g key={x.t}>
          <line x1={xOfT(x.t)} x2={xOfT(x.t)} y1={P1.y} y2={P2.y + P2.h} className="fg-grid" />
          <text x={xOfT(x.t)} y={H - 4} textAnchor="middle" className="fg-tick">{x.label}</text>
        </g>
      ))}
      {ticks.map((v) => (
        <g key={v}>
          <line x1={0} x2={PW} y1={yPx(v)} y2={yPx(v)} className="fg-grid" />
          <text x={W - 2} y={yPx(v) + 3.5} textAnchor="end" className="fg-tick">{px(v).replace(/[,.]\d+$/, "")}</text>
        </g>
      ))}
      {[25, 50, 75].map((v) => (
        <g key={v}>
          <line x1={0} x2={PW} y1={yIx(v)} y2={yIx(v)} className="fg-grid" />
          <text x={W - 2} y={yIx(v) + 3.5} textAnchor="end" className="fg-tick">{v}</text>
        </g>
      ))}
      <text x={4} y={P1.y + 11} className="fg-ptl">{t(lang, "fg_price")}{log ? " · log" : ""}</text>
      <text x={4} y={P2.y + 11} className="fg-ptl">{t(lang, "fg_index")}</text>

      {priceRuns.map((r, i) => <polyline key={`p${i}`} points={r.pts} stroke={r.c} className="fg-line" />)}
      {idxRuns.map((r, i) => <polyline key={`i${i}`} points={r.pts} stroke={r.c} className="fg-line thin" />)}

      {d ? (
        <g className="fg-cross">
          <line x1={xOf(sel!)} x2={xOf(sel!)} y1={P1.y} y2={P2.y + P2.h} />
          {d[2] > 0 ? <circle cx={xOf(sel!)} cy={yPx(d[2])} r={4} fill={colorOf(d[1])} /> : null}
          <circle cx={xOf(sel!)} cy={yIx(d[1])} r={4} fill={colorOf(d[1])} />
        </g>
      ) : null}
    </svg>
  );
}

interface Streak {
  n: number;
  sum: number;
  max: number;
  maxAt: number;
  next: number[];
}

/**
 * Полосы — дни подряд в одной зоне. Для каждой зоны: сколько полос
 * закончилось, их средняя длина, рекорд (с днём начала) и куда индекс
 * уходил после. Ещё идущая полоса в среднее не входит — она не закончилась,
 * но в рекорд попадает. Первая полоса окна тоже не входит, если окно
 * начинается не с начала истории: её начало обрезано.
 */
function streakStats(days: Day[], cutStart: boolean): Streak[] {
  const out = ZONES.map(() => ({ n: 0, sum: 0, max: 0, maxAt: 0, next: ZONES.map(() => 0) }));
  let i = 0;
  while (i < days.length) {
    const zi = zoneOf(days[i]![1]);
    let j = i;
    while (j + 1 < days.length && zoneOf(days[j + 1]![1]) === zi) j++;
    const len = j - i + 1;
    const s = out[zi];
    const after = days[j + 1];
    if (s && !(cutStart && i === 0)) {
      if (len > s.max) {
        s.max = len;
        s.maxAt = days[i]![0];
      }
      if (after) {
        s.n += 1;
        s.sum += len;
        const nz = zoneOf(after[1]);
        if (nz >= 0) s.next[nz]! += 1;
      }
    }
    i = j + 1;
  }
  return out;
}

export function FearGreedScreen() {
  const lang = useApp((s) => s.lang);
  const [reply, setReply] = useState<FngReply | null>(() => peekFng() ?? null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [range, setRange] = useState<Range>(() => {
    try {
      const v = localStorage.getItem(RANGE_KEY);
      return (["30", "90", "365", "1095", "all"].includes(v ?? "") ? v : "all") as Range;
    } catch {
      return "all";
    }
  });
  const [sel, setSel] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void fetchFng().then((r) => {
      if (!alive) return;
      if (r?.ok && r.days.length) setReply(r);
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

  const all = reply?.days ?? [];
  const days = useMemo(() => (range === "all" ? all : all.slice(-Number(range))), [all, range]);
  const last = all[all.length - 1];
  const back = (n: number) => all[all.length - 1 - n];

  const yearly = useMemo(() => {
    const y = all.slice(-365);
    if (!y.length) return null;
    const hi = y.reduce((m, d) => (d[1] > m[1] ? d : m), y[0]!);
    const lo = y.reduce((m, d) => (d[1] < m[1] ? d : m), y[0]!);
    return { hi, lo };
  }, [all]);

  /* Дни по зонам и что было с ценой через 30 дней после дня в зоне. */
  const stats = useMemo(() => {
    const cnt = ZONES.map(() => 0);
    const ret = ZONES.map(() => ({ s: 0, n: 0 }));
    const start = all.length - days.length;
    days.forEach((d, i) => {
      const z = zoneOf(d[1]);
      if (z < 0) return;
      cnt[z]! += 1;
      const later = all[start + i + 30];
      if (later && d[2] > 0 && later[2] > 0) {
        ret[z]!.s += later[2] / d[2] - 1;
        ret[z]!.n += 1;
      }
    });
    const avg = days.length ? days.reduce((s, d) => s + d[1], 0) / days.length : 0;
    return { cnt, ret, avg, total: days.length };
  }, [all, days]);

  const streaks = useMemo(() => streakStats(days, range !== "all"), [days, range]);
  const streaksAll = useMemo(() => streakStats(all, false), [all]);
  /* Текущая полоса — по всей истории: сколько дней подряд индекс в той же зоне. */
  const cur = useMemo(() => {
    if (!all.length) return null;
    const zi = zoneOf(all[all.length - 1]![1]);
    let k = all.length - 1;
    while (k > 0 && zoneOf(all[k - 1]![1]) === zi) k -= 1;
    return { zi, len: all.length - k };
  }, [all]);
  const daysStr = (v: number, digits = 0) => t(lang, "fg_days", { n: num(v, digits) });

  const selDay = sel !== null ? days[sel] : undefined;
  const tipLeft = sel !== null && sel > days.length / 2;

  return (
    <Frame title={t(lang, "fg_title")}>
      <p className="lq-lead">{t(lang, "fg_sub")}</p>

      {!reply ? (
        failed ? (
          <Empty text={t(lang, "fg_err")} hint={
            <button type="button" className="lq-retry" onClick={() => setRetry((n) => n + 1)}>{t(lang, "ui_retry")}</button>
          } />
        ) : <Card><Skeleton rows={8} /></Card>
      ) : !last ? null : (
        <>
          <Card>
            <div className="fg-hero">
              <Gauge v={last[1]} lang={lang} />
              <b className="fg-val" style={{ color: colorOf(last[1]) }}>{last[1]}</b>
              <p className="fg-zone" style={{ color: colorOf(last[1]) }}>{t(lang, ZONES[Math.max(0, zoneOf(last[1]))]!.key)}</p>
              <p className="fg-date">{dateStr(lang, last[0], { day: "numeric", month: "long", year: "numeric" })} · BTC {px(last[2])}</p>
            </div>
            <div className="fg-cmp">
              {([["fg_yday", back(1)], ["fg_week", back(7)], ["fg_month", back(30)]] as const).map(([k, d]) => d ? (
                <div key={k} className="fg-cmp-c">
                  <small>{t(lang, k)}</small>
                  <b style={{ color: colorOf(d[1]) }}>{d[1]}</b>
                  <span>{t(lang, ZONES[Math.max(0, zoneOf(d[1]))]!.key)}</span>
                </div>
              ) : null)}
            </div>
            {yearly ? (
              <div className="fg-year">
                <span>{t(lang, "fg_hi")} <b style={{ color: colorOf(yearly.hi[1]) }}>{yearly.hi[1]}</b>
                  <small> · {dateStr(lang, yearly.hi[0], { day: "numeric", month: "short", year: "numeric" })}</small></span>
                <span>{t(lang, "fg_lo")} <b style={{ color: colorOf(yearly.lo[1]) }}>{yearly.lo[1]}</b>
                  <small> · {dateStr(lang, yearly.lo[0], { day: "numeric", month: "short", year: "numeric" })}</small></span>
              </div>
            ) : null}
          </Card>

          <Card>
            <Segmented<Range>
              value={range}
              onChange={pickRange}
              options={[
                { id: "30", label: t(lang, "fg_r30") },
                { id: "90", label: t(lang, "fg_r90") },
                { id: "365", label: t(lang, "fg_r1y") },
                { id: "1095", label: t(lang, "fg_r3y") },
                { id: "all", label: t(lang, "fg_rall") },
              ]}
            />
            <div className="fg-plot">
              <Chart days={days} lang={lang} sel={sel} onSel={setSel} />
              {selDay ? (
                <div className={tipLeft ? "fg-pop left" : "fg-pop"} aria-live="polite">
                  <small>{dateStr(lang, selDay[0], { day: "numeric", month: "long", year: "numeric" })}</small>
                  <b style={{ color: colorOf(selDay[1]) }}>
                    {selDay[1]} · {t(lang, ZONES[Math.max(0, zoneOf(selDay[1]))]!.key)}
                  </b>
                  {selDay[2] > 0 ? <span>BTC {px(selDay[2])}</span> : null}
                </div>
              ) : null}
            </div>
            <div className="fg-legend">
              {ZONES.map((z) => (
                <span key={z.key}><i style={{ background: z.c }} />{t(lang, z.key)}</span>
              ))}
            </div>
            <p className="lq-hint">{t(lang, "fg_hint")}</p>
          </Card>

          <SectionTitle>{t(lang, "fg_dist")}</SectionTitle>
          <Card>
            <div className="fg-dist" role="img" aria-label={t(lang, "fg_dist")}>
              {ZONES.map((z, i) => stats.cnt[i] ? (
                <i key={z.key} style={{ width: `${(stats.cnt[i]! / stats.total) * 100}%`, background: z.c }} />
              ) : null)}
            </div>
            <div className="fg-rows">
              <div className="fg-row fg-row-h">
                <span />
                <small>{t(lang, "fg_share")}</small>
                <small>{t(lang, "fg_ret")}</small>
              </div>
              {ZONES.map((z, i) => {
                const r = stats.ret[i]!;
                const avg = r.n ? (r.s / r.n) * 100 : null;
                return (
                  <div key={z.key} className="fg-row">
                    <span><i style={{ background: z.c }} />{t(lang, z.key)}</span>
                    <b>{!stats.total ? "—" : stats.cnt[i]! > 0 && stats.cnt[i]! / stats.total < 0.01 ? "<1%"
                      : pct((stats.cnt[i]! / stats.total) * 100, 0, false)}
                      <small> · {t(lang, "fg_days", { n: num(stats.cnt[i]) })}</small></b>
                    <em className={avg === null ? "" : avg >= 0 ? "up" : "dn"}>{avg === null ? "—" : pct(avg, 1, true)}</em>
                  </div>
                );
              })}
            </div>
            <p className="fg-avg">
              {t(lang, "fg_avg")} <b style={{ color: colorOf(Math.round(stats.avg)) }}>{num(stats.avg, 0)}</b>
            </p>
            <p className="lq-hint">{t(lang, "fg_ret_note")}</p>
          </Card>

          <SectionTitle>{t(lang, "fg_st_title")}</SectionTitle>
          <Card>
            {cur && cur.zi >= 0 ? (() => {
              const z = ZONES[cur.zi]!;
              const sa = streaksAll[cur.zi]!;
              return (
                <div className="fg-now" style={{ borderColor: z.c }}>
                  <p>
                    {t(lang, "fg_st_now", { z: t(lang, z.key), n: num(cur.len) }).split(t(lang, z.key)).flatMap((part, i, arr) =>
                      i < arr.length - 1 ? [part, <b key={i} style={{ color: z.c }}>{t(lang, z.key)}</b>] : [part])}
                  </p>
                  {sa.n ? (
                    <small>{t(lang, "fg_st_cmp", { a: daysStr(sa.sum / sa.n, 1), m: daysStr(sa.max) })}</small>
                  ) : null}
                </div>
              );
            })() : null}
            <div className="fg-st fg-st-h">
              <span />
              <small>{t(lang, "fg_st_avg")}</small>
              <small>{t(lang, "fg_st_max")}</small>
            </div>
            {ZONES.map((z, i) => {
              const st = streaks[i]!;
              const tot = st.next.reduce((a, b) => a + b, 0);
              const best = tot ? st.next.indexOf(Math.max(...st.next)) : -1;
              const nz = best >= 0 ? ZONES[best] : undefined;
              return (
                <div key={z.key} className="fg-st">
                  <span><i style={{ background: z.c }} />{t(lang, z.key)}</span>
                  <b>{st.n ? daysStr(st.sum / st.n, 1) : "—"}</b>
                  <b>{st.max ? daysStr(st.max) : "—"}
                    {st.maxAt ? <small>{dateStr(lang, st.maxAt, { month: "short", year: "numeric" })}</small> : null}</b>
                  <p>
                    {t(lang, "fg_times", { n: num(st.n) })}
                    {nz ? (
                      <>
                        {" · "}{t(lang, "fg_st_next")} <i style={{ background: nz.c }} />
                        <em style={{ color: nz.c }}>{t(lang, nz.key)}</em> {pct((st.next[best]! / tot) * 100, 0, false)}
                      </>
                    ) : null}
                  </p>
                </div>
              );
            })}
            <p className="lq-hint">{t(lang, "fg_st_note")}</p>
          </Card>

          <FearGreedInsights lang={lang} days={all} />

          <details className="lq-how">
            <summary>{t(lang, "fg_how")}</summary>
            <ul>
              <li>{t(lang, "fg_how_1")}</li>
              <li>{t(lang, "fg_how_2")}</li>
              <li>{t(lang, "fg_how_3")}</li>
              <li>{t(lang, "fg_how_4")}</li>
            </ul>
          </details>
          <p className="lq-src">{t(lang, "fg_src")}</p>
        </>
      )}
    </Frame>
  );
}

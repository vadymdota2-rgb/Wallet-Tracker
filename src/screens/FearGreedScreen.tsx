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
 * Внизу — сколько дней рынок провёл в каждой зоне, сколько держится каждая
 * зона и (отдельным блоком) что обычно было после. Это история, а не
 * прогноз, и экран так и говорит.
 *
 * Цвета зон — привычные: красный — крайний страх, оранжевый, жёлтый —
 * нейтрально, салатовый, зелёный — крайняя жадность. Границы — как у самого
 * индекса alternative.me. Все расчёты — в lib/fng.ts (их проверяют тесты).
 *
 * Права: индекс — alternative.me (их условие — источник рядом с данными:
 * ссылка под шкалой), цена BTC — mempool.space (тоже ссылкой рядом). Цен
 * бирж здесь нет: их условия запрещают показывать рыночные данные.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { num, pct, px } from "../lib/format";
import { haptic, openExternal } from "../lib/telegram";
import { fetchFng, peekFng } from "../lib/api";
import { Card, Empty, SectionTitle, Segmented, Skeleton } from "../components/ui";
import {
  F_EST, F_FILL, ZONES, colorOf, currentStreak, distribution, estUntil, streakLeft, streakStats, windowOf,
  yearExtremes, zoneKey, zoneOf, type FngDay, type FngReply,
} from "../lib/fng";
import { Frame } from "./Screen";
import { heightK, useWidth } from "./etfView";
import { dateStr, timeTicks } from "./timeAxis";
import { FearGreedInsights } from "./FearGreedInsights";
import "./FearGreedScreen.css";

/** Источники рядом с данными: условие alternative.me — ссылка на них. */
export const FNG_URL = "https://alternative.me/crypto/fear-and-greed-index/";
export const PX_URL = "https://mempool.space/";

type Lang = Parameters<typeof t>[0];
type Day = FngDay;
type Range = "30" | "90" | "365" | "1095" | "all";
const RANGES: readonly Range[] = ["30", "90", "365", "1095", "all"];

const RANGE_KEY = "wt-fg-range";
const DAY = 86_400;
/** Число внутри фразы — слева направо и в арабском (см. FearGreedInsights). */
const iso = (x: string | number) => `\u2066${x}\u2069`;
/** Цена дня: досчитанная между недельными точками — со знаком «≈». */
const pxOf = (d: Day) => `${d[3] & F_EST ? "≈ " : ""}${px(d[2])}`;

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
  return (
    <svg className="fg-gauge" viewBox="0 0 220 124" role="img" aria-label={`${v} — ${t(lang, zoneKey(v))}`}>
      {arcs}
      <line x1={cx} y1={cy} x2={nx} y2={ny} className="fg-needle" />
      <circle cx={cx} cy={cy} r={5.5} className="fg-hub" />
      <text x={16} y={122} className="fg-end">0</text>
      <text x={204} y={122} className="fg-end" textAnchor="end">100</text>
    </svg>
  );
}

/** Под подписи оси справа, px. */
const AXIS = 50;

/**
 * Размеры графика в настоящих пикселях ширины w: подписи одного размера на
 * телефоне, планшете и компьютере, а высота растёт с шириной, но график
 * целиком помещается по высоте окна (телефон боком).
 */
function geom(w: number, withPx: boolean) {
  const k = heightK(w, withPx ? 300 : 120);
  // Цены в окне нет ни за один день (сервер ещё не получил её) — панели
  // цены нет: пустая шкала «$1–$2» хуже, чем один индекс.
  const P1 = { y: 6, h: withPx ? Math.round(168 * k) : 0 };
  const P2 = { y: withPx ? P1.y + P1.h + 14 : 6, h: Math.round(92 * k) };
  return { W: w, PW: w - AXIS - 4, P1, P2, H: P2.y + P2.h + 18 };
}

/** Деления времени: не теснее одного на 64 px. */
function ticksOf(lang: Lang, a: number, b: number, pw: number) {
  const all = timeTicks(lang, a, b);
  const step = Math.max(1, Math.ceil(all.length / Math.max(3, Math.floor(pw / 64))));
  return all.filter((_, i) => (all.length - 1 - i) % step === 0);
}

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

/** Линия по дням, разрезанная на куски одного цвета — по зоне дня; у цены
 *  ещё и по точности (досчитанная — бледнее). День, где yOf — null (цены
 *  нет), рвёт линию: падения в ноль на графике не бывает. */
function runs(days: readonly Day[], xOf: (i: number) => number, yOf: (d: Day) => number | null, est: boolean) {
  const out: { c: string; e: boolean; pts: string }[] = [];
  let cur: { c: string; e: boolean; pts: string[] } | null = null;
  const close = () => {
    if (cur && cur.pts.length > 1) out.push({ c: cur.c, e: cur.e, pts: cur.pts.join(" ") });
    cur = null;
  };
  days.forEach((d, i) => {
    const y = yOf(d);
    if (y === null) {
      close();
      return;
    }
    const c = colorOf(d[1]);
    const e = est && (d[3] & F_EST) !== 0;
    const p = `${xOf(i).toFixed(1)},${y.toFixed(1)}`;
    if (cur && (cur.c !== c || cur.e !== e)) {
      cur.pts.push(p);
      close();
    }
    if (!cur) cur = { c, e, pts: [] };
    cur.pts.push(p);
  });
  close();
  return out;
}

function Chart({ days, lang, sel, onSel }: {
  days: readonly Day[];
  lang: Lang;
  sel: number | null;
  onSel: (i: number | null) => void;
}) {
  /* Края цены — циклом: Math.min(...) на тысячах дней упирается в предел
     аргументов на слабых телефонах. Цены нет ни в один день — шкала $1–2. */
  let lo = Infinity;
  let hi = 0;
  for (const d of days) if (d[2] > 0) {
    lo = Math.min(lo, d[2]);
    hi = Math.max(hi, d[2]);
  }
  const withPx = hi > 0;
  if (!withPx) {
    lo = 1;
    hi = 2;
  }
  const svgRef = useRef<SVGSVGElement>(null);
  const { W, PW, P1, P2, H } = geom(useWidth(svgRef), withPx);
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

  /* Линии — один раз на данные и размер, а не на каждое движение пальца. */
  const priceRuns = useMemo(() => runs(days, xOf, (d) => (d[2] > 0 ? yPx(d[2]) : null), true), [days, W, P1.h]);
  const idxRuns = useMemo(() => runs(days, xOf, (d) => yIx(d[1]), false), [days, W, P2.y, P2.h]);
  const ticks = useMemo(() => priceTicks(lo, hi, log), [lo, hi, log]);
  const tt = useMemo(() => ticksOf(lang, a, b, PW), [lang, a, b, PW]);

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
      height={H}
      role="img"
      aria-label={t(lang, "fg_title")}
      onPointerDown={(e) => pick(e.clientX)}
      onPointerMove={(e) => { if (e.pointerType === "mouse" || e.buttons) pick(e.clientX); }}
      onPointerUp={(e) => { if (e.pointerType !== "mouse") onSel(null); }}
      onPointerCancel={() => onSel(null)}
      onPointerLeave={() => onSel(null)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {withPx ? <rect x={0} y={P1.y} width={PW} height={P1.h} className="fg-bg" /> : null}
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
      {withPx ? ticks.map((v) => (
        <g key={v}>
          <line x1={0} x2={PW} y1={yPx(v)} y2={yPx(v)} className="fg-grid" />
          <text x={W - 2} y={yPx(v) + 3.5} textAnchor="end" className="fg-tick">{px(v).replace(/[,.]\d+$/, "")}</text>
        </g>
      )) : null}
      {[25, 50, 75].map((v) => (
        <g key={v}>
          <line x1={0} x2={PW} y1={yIx(v)} y2={yIx(v)} className="fg-grid" />
          <text x={W - 2} y={yIx(v) + 3.5} textAnchor="end" className="fg-tick">{v}</text>
        </g>
      ))}
      {withPx ? <text x={4} y={P1.y + 11} className="fg-ptl">{t(lang, "fg_price")}{log ? ` · ${t(lang, "fg_log")}` : ""}</text> : null}
      <text x={4} y={P2.y + 11} className="fg-ptl">{t(lang, "fg_index")}</text>

      {priceRuns.map((r, i) => <polyline key={`p${i}`} points={r.pts} stroke={r.c} className={r.e ? "fg-line est" : "fg-line"} />)}
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

/** Дни таблицы: подневно в коротком окне, по неделям в длинном — от
 *  последнего (свежие — первыми). */
function tableDays(days: readonly Day[]): Day[] {
  const step = days.length > 120 ? 7 : 1;
  const out: Day[] = [];
  for (let i = days.length - 1; i >= 0; i -= step) out.push(days[i]!);
  return out;
}

/** Дни окна цифрами — для читалки экрана и для тех, кому цифры удобнее линии. */
function DaysTable({ days, lang }: { days: readonly Day[]; lang: Lang }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="fg-tbl" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{t(lang, "ef_tbl")}</summary>
      {open ? (
        <div className="fg-tbl-w">
          <table>
            <thead>
              <tr>
                <th scope="col">{t(lang, "ef_tbl_d")}</th>
                <th scope="col">{t(lang, "dm_tbl_idx")}</th>
                <th scope="col">{t(lang, "dm_tbl_zone")}</th>
                <th scope="col">{t(lang, "fg_price")}</th>
              </tr>
            </thead>
            <tbody>
              {tableDays(days).map((d) => (
                <tr key={d[0]}>
                  <th scope="row">{dateStr(lang, d[0], { day: "numeric", month: "short", year: "numeric" })}</th>
                  <td>{d[1]}{d[3] & F_FILL ? "*" : ""}</td>
                  <td>{t(lang, zoneKey(d[1]))}</td>
                  <td><bdi dir="ltr">{d[2] > 0 ? pxOf(d) : "—"}</bdi></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </details>
  );
}

export function FearGreedScreen() {
  const lang = useApp((s) => s.lang);
  const [reply, setReply] = useState<FngReply | null>(() => peekFng() ?? null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [range, setRange] = useState<Range>(() => {
    try {
      const v = localStorage.getItem(RANGE_KEY);
      return RANGES.find((r) => r === v) ?? "all";
    } catch {
      return "all";
    }
  });
  const [sel, setSel] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void fetchFng().then((r) => {
        if (!alive) return;
        if (r) {
          setReply(r);
          setFailed(false);
        } else setFailed(true);
      });
    };
    load();
    /* Вернулись к экрану (свернули Telegram на ночь) — свежий ответ: индекс
       выходит раз в сутки. Внутри получаса fetchFng отдаёт тот же из памяти. */
    const onShow = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onShow);
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

  const all = useMemo<readonly Day[]>(() => reply?.days ?? [], [reply]);
  const days = useMemo(() => windowOf(all, range), [all, range]);
  const last = all[all.length - 1];
  const back = (n: number) => all[all.length - 1 - n];

  const yearly = useMemo(() => yearExtremes(all), [all]);
  /* Дни по зонам. Что было с ценой после — в блоке ниже, по медиане и по
     всей истории: здесь была вторая, средняя по окну, и цифры спорили. */
  const stats = useMemo(() => distribution(days), [days]);
  const streaks = useMemo(() => streakStats(days, range !== "all"), [days, range]);
  const streaksAll = useMemo(() => streakStats(all, false), [all]);
  /* Текущая полоса — по всей истории: сколько дней подряд индекс в той же зоне. */
  const cur = useMemo(() => currentStreak(all), [all]);
  const left = useMemo(() => (cur ? streakLeft(all, cur) : null), [all, cur]);
  /* До какого дня цена в окне досчитана по недельным точкам. */
  const est = useMemo(() => estUntil(days), [days]);
  const daysStr = (v: number, digits = 0) => t(lang, "fg_days", { n: num(v, digits) });

  const selDay = sel !== null ? days[sel] : undefined;
  const tipLeft = sel !== null && sel > days.length / 2;
  /* Клавиатура: стрелки — день (с Shift — неделя), Home и End — края, Esc — убрать. */
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = days.length;
    if (!n) return;
    const go = (i: number) => {
      e.preventDefault();
      setSel(Math.max(0, Math.min(n - 1, i)));
    };
    const step = e.shiftKey ? 7 : 1;
    if (e.key === "ArrowRight") go(sel === null ? n - 1 : sel + step);
    else if (e.key === "ArrowLeft") go(sel === null ? n - 1 : sel - step);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(n - 1);
    else if (e.key === "Escape" && sel !== null) {
      e.preventDefault();
      setSel(null);
    }
  };
  const open = (url: string) => (e: { preventDefault: () => void }) => {
    e.preventDefault();
    openExternal(url);
  };

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
          <SectionTitle help={["fg_how_1", "fg_q_zones"]}>{t(lang, "fg_now_t")}</SectionTitle>
          <Card>
            <div className="fg-hero">
              <Gauge v={last[1]} lang={lang} />
              <b className="fg-val" style={{ color: colorOf(last[1]) }}>{last[1]}</b>
              <p className="fg-zone" style={{ color: colorOf(last[1]) }}>{t(lang, zoneKey(last[1]))}</p>
              <p className="fg-date">
                {dateStr(lang, last[0], { day: "numeric", month: "long", year: "numeric" })}
                {last[2] > 0 ? <> · BTC <bdi dir="ltr">{pxOf(last)}</bdi></> : null}
              </p>
              {/* Условие alternative.me: источник — рядом с данными и явной ссылкой. */}
              <p className="fg-by">
                {t(lang, "fg_by")}{" "}
                <a href={FNG_URL} onClick={open(FNG_URL)}>alternative.me</a>
                <span>{t(lang, "fg_px_by")} <a href={PX_URL} onClick={open(PX_URL)}>mempool.space</a></span>
              </p>
            </div>
            <div className="fg-cmp">
              {([["fg_yday", back(1)], ["fg_week", back(7)], ["fg_month", back(30)]] as const).map(([k, d]) => d ? (
                <div key={k} className="fg-cmp-c">
                  <small>{t(lang, k)}</small>
                  <b style={{ color: colorOf(d[1]) }}>{d[1]}</b>
                  <span>{t(lang, zoneKey(d[1]))}</span>
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

          <SectionTitle help={["fg_how_2", "fg_q_chart"]}>{t(lang, "fg_hist_t")}</SectionTitle>
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
            <div className="fg-plot fg-keys" tabIndex={0} role="group" aria-label={t(lang, "ef_keys")}
              onKeyDown={onKey} onBlur={() => setSel(null)}>
              <Chart days={days} lang={lang} sel={sel} onSel={setSel} />
              {selDay ? (
                <div className={tipLeft ? "fg-pop left" : "fg-pop"} aria-live="polite">
                  <small>{dateStr(lang, selDay[0], { day: "numeric", month: "long", year: "numeric" })}</small>
                  <b style={{ color: colorOf(selDay[1]) }}>
                    {selDay[1]} · {t(lang, zoneKey(selDay[1]))}
                  </b>
                  {selDay[3] & F_FILL ? <small className="fg-note">{t(lang, "fg_fill")}</small> : null}
                  {selDay[2] > 0 ? <span>BTC <bdi dir="ltr">{pxOf(selDay)}</bdi></span> : null}
                  {selDay[2] > 0 && last[2] > 0 && selDay[0] < last[0] ? (() => {
                    const ch = (last[2] / selDay[2] - 1) * 100;
                    return <em className={ch >= 0 ? "up" : "dn"}>{t(lang, "fg_since_then", { p: iso(pct(ch, 0, true)) })}</em>;
                  })() : null}
                </div>
              ) : null}
            </div>
            <div className="fg-legend">
              {ZONES.map((z) => (
                <span key={z.key}><i style={{ background: z.c }} />{t(lang, z.key)}</span>
              ))}
            </div>
            <p className="lq-hint">{t(lang, "fg_hint")}</p>
            {est ? <p className="fg-est">{t(lang, "fg_est", { d: dateStr(lang, est + DAY, { day: "numeric", month: "long", year: "numeric" }) })}</p> : null}
            <DaysTable days={days} lang={lang} />
          </Card>

          <SectionTitle help={["fg_q_dist", "fg_how_3"]}>{t(lang, "fg_dist")}</SectionTitle>
          <Card>
            <div className="fg-dist" role="img" aria-label={t(lang, "fg_dist")}>
              {ZONES.map((z, i) => stats.cnt[i] ? (
                <i key={z.key} style={{ width: `${(stats.cnt[i]! / stats.total) * 100}%`, background: z.c }} />
              ) : null)}
            </div>
            <div className="fg-rows">
              {ZONES.map((z, i) => (
                <div key={z.key} className="fg-row two">
                  <span><i style={{ background: z.c }} />{t(lang, z.key)}</span>
                  <b><bdi dir="ltr">{!stats.total ? "—" : stats.cnt[i]! > 0 && stats.cnt[i]! / stats.total < 0.01 ? "<1%"
                    : pct((stats.cnt[i]! / stats.total) * 100, 0, false)}</bdi>
                    <small> · {t(lang, "fg_days", { n: num(stats.cnt[i]) })}</small></b>
                </div>
              ))}
            </div>
            <p className="fg-avg">
              {t(lang, "fg_avg")} <b style={{ color: colorOf(Math.round(stats.avg)) }}>{num(stats.avg, 0)}</b>
            </p>
          </Card>

          <SectionTitle help={["fg_st_note", "fg_q_st"]}>{t(lang, "fg_st_title")}</SectionTitle>
          <Card>
            {cur ? (() => {
              const z = ZONES[cur.zi]!;
              const sa = streaksAll[cur.zi]!;
              const name = t(lang, z.key);
              return (
                <div className="fg-now" style={{ borderColor: z.c }}>
                  <p>
                    {t(lang, "fg_st_now", { z: name, n: num(cur.len) }).split(name).flatMap((part, i, arr) =>
                      i < arr.length - 1 ? [part, <b key={i} style={{ color: z.c }}>{name}</b>] : [part])}
                  </p>
                  {sa.n ? (
                    <small>{t(lang, "fg_st_cmp", { a: daysStr(sa.sum / sa.n, 1), m: daysStr(sa.max) })}</small>
                  ) : null}
                  {left ? (
                    <small className="fg-left">
                      {t(lang, "fg_st_left", {
                        n: iso(num(left.n)), l: daysStr(cur.len), r: daysStr(left.med), p: iso(pct(left.week * 100, 0, false)),
                      })}
                    </small>
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
                        <em style={{ color: nz.c }}>{t(lang, nz.key)}</em> <bdi dir="ltr">{pct((st.next[best]! / tot) * 100, 0, false)}</bdi>
                      </>
                    ) : null}
                  </p>
                </div>
              );
            })}
          </Card>

          {/* Выводы — про цену после настроения: без цен их нет (а не «×0,00»). */}
          {all.some((d) => d[2] > 0) ? <FearGreedInsights lang={lang} days={all} /> : null}

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

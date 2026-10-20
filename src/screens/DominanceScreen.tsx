/**
 * Альтсезон: кто сильнее — биткоин или альткоины.
 *
 * Всё посчитано своим счётом по дневным ценам Hyperliquid (сервер — wt_dom.py,
 * проверка ответа и расчёты — lib/dom.ts). Чужих индексов здесь нет.
 *
 * Сверху — индекс альтсезона: сколько из 50 крупнейших монет Hyperliquid
 * обогнали биткоин за 90 дней; 75 и выше — альтсезон, 25 и ниже — сезон
 * биткоина. Ниже — его история, сила альтов против биткоина (корзина монет
 * поровну), список монет за 90 дней и ETH/BTC.
 *
 * Доли биткоина во всём рынке нет: для неё нужна капитализация всех монет, а
 * открытых данных о ней с правом показа нет ни у кого — об этом сказано в
 * «Как это считается».
 *
 * Цвета держатся смысла по всему экрану: оранжевый — биткоин, фиолетовый —
 * альты, синий — эфир.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey } from "../i18n/types";
import { num, pct } from "../lib/format";
import { haptic } from "../lib/telegram";
import { fetchDom, peekDom } from "../lib/api";
import { Card, Empty, SectionTitle, Segmented, Skeleton } from "../components/ui";
import {
  RANGES, ago, altStats, beat, change, ebStats, seasonOf, series, thin, windowOf,
  type DomReply, type Range,
} from "../lib/dom";
import { Frame } from "./Screen";
import { dateStr, timeTicks } from "./FearGreedScreen";

type Lang = Parameters<typeof t>[0];

const C = { btc: "#f7931a", eth: "#627eea", alt: "#8b5cf6", mid: "#6b7280" } as const;
const RANGE_KEY = "wt-dom-range";
const RANGE_LABEL = { 365: "fg_r1y", 1095: "fg_r3y", all: "fg_rall" } as const;
/** Сервер ещё собирает цены после первого запуска — спросить снова через столько, мс. */
const BUILD_RETRY_MS = 30_000;
const iso = (x: string | number) => `⁦${x}⁩`;

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

const W = 360;
const AXIS = 50;
const PW = W - AXIS - 4;

/** Подписи времени: не больше семи, иначе годы слипаются. */
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

/** Точки по пальцу. */
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

/** Небольшой график одной величины: индекс альтсезона, сила альтов, ETH/BTC. */
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
  const MH = 120;
  const vals = pts.map((p) => p[1]);
  const lo = fixed ? fixed[0] : Math.min(...vals) * 0.95;
  const hi = fixed ? fixed[1] : Math.max(...vals) * 1.05;
  const xOf = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * PW);
  const yOf = (v: number) => 6 + (1 - (v - lo) / (hi - lo || 1)) * MH;
  const a = pts[0]?.[0] ?? 0;
  const b = pts[n - 1]?.[0] ?? 1;
  const xOfT = (ts: number) => ((ts - a) / Math.max(1, b - a)) * PW;
  const { ref, handlers } = useScrub(n, PW, setSel, sel);
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
  }, [pts]);
  const ticks = fixed ? [25, 50, 75] : niceTicks(lo, hi);
  const p = sel !== null ? pts[sel] : undefined;
  const H2 = MH + 26;
  return (
    <div className="fg-plot">
      <svg ref={ref} className="fg-svg" viewBox={`0 0 ${W} ${H2}`} width="100%" role="img" aria-label={label} {...handlers}>
        <rect x={0} y={6} width={PW} height={MH} className="fg-bg" />
        {bands?.map((z) => (
          <rect key={z.from} x={0} y={yOf(z.to)} width={PW} height={yOf(z.from) - yOf(z.to)} fill={z.c} opacity={0.1} />
        ))}
        {ticksOf(lang, a, b).map((x) => (
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

export function DominanceScreen() {
  const lang = useApp((s) => s.lang);
  const [reply, setReply] = useState<DomReply | null>(() => peekDom() ?? null);
  const [state, setState] = useState<"wait" | "failed" | "building">("wait");
  const [retry, setRetry] = useState(0);
  const [range, setRange] = useState<Range>(() => {
    try {
      const v = localStorage.getItem(RANGE_KEY);
      return RANGES.find((r) => r === v) ?? "all";
    } catch {
      return "all";
    }
  });

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
        setState("wait");
      } else setState("failed");
    });
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [retry]);

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
  const eb = useMemo(() => series(rows, 3), [rows]);
  const stats = useMemo(() => altStats(alt), [alt]);
  const ebS = useMemo(() => ebStats(eb), [eb]);
  const now = alt[alt.length - 1];
  const coins = reply?.coins ?? [];
  const btc90 = reply?.btc90 ?? null;
  const k = btc90 !== null ? beat(coins, btc90).up : 0;

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
      <p className="lq-lead">{t(lang, "dm_sub")}</p>

      {!reply ? (
        state === "failed" ? (
          <Empty text={t(lang, "dm_err")} hint={
            <button type="button" className="lq-retry" onClick={() => setRetry((n) => n + 1)}>{t(lang, "ui_retry")}</button>
          } />
        ) : state === "building" ? (
          <Card><p className="lq-hint" role="status">{t(lang, "dm_building")}</p><Skeleton rows={6} /></Card>
        ) : <Card><Skeleton rows={8} /></Card>
      ) : (
        <>
          {now && stats ? (
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
              <p className="fg-date">{stamp(lang, reply.at)}</p>
            </Card>
          ) : null}

          {stats && alt.length > 30 ? (
            <>
              <SectionTitle help={["dm_how_1", "dm_how_3"]}>{t(lang, "dm_alt_title")}</SectionTitle>
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

          {str.length > 30 ? (
            <>
              <SectionTitle help={["dm_how_2", "dm_how_3"]}>{t(lang, "dm_str_title")}</SectionTitle>
              <Card>
                <div className="dm-eb">
                  <b style={{ color: C.alt }}><bdi dir="ltr">{num(str[str.length - 1]![1], 1)}</bdi></b>
                  <span>{t(lang, "dm_str_base", { d: dateStr(lang, str[0]![0], { day: "numeric", month: "long", year: "numeric" }) })}</span>
                </div>
                <Changes ch={[30, 90, 365].map((n) => change(str, n))} lang={lang} />
                <MiniChart pts={thin(windowOf(str, range))} lang={lang} label={t(lang, "dm_str_title")}
                  color={() => C.alt} fmt={(v) => num(v)} />
                <p className="lq-hint">{t(lang, "dm_str_what", { n: iso(num(reply.n)) })}</p>
              </Card>
            </>
          ) : null}

          {coins.length && btc90 !== null ? (
            <>
              <SectionTitle>{t(lang, "dm_top_title")}</SectionTitle>
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
              <li>{t(lang, "dm_how_5")}</li>
              <li>{t(lang, "dm_how_4")}</li>
            </ul>
          </details>
          <p className="lq-src">{t(lang, "dm_src")}</p>
        </>
      )}
    </Frame>
  );
}

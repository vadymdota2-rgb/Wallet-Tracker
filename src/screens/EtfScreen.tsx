/**
 * Институциональные потоки биткоина: сколько монет держат спотовые
 * биржевые фонды США и куда идут их деньги.
 *
 * База — официальные отчёты фондов в SEC (раз в квартал): запас каждого
 * фонда и поток за квартал. По дням — только своя цепочка: фонды, чьи
 * кошельки знает сканер бота. Сверху — последний квартал, за год и с
 * запуска, сколько фонды держат; для биткоина — сколько монет забрали фонды
 * за квартал против новой добычи. Ниже — цена и потоки на двух панелях одной
 * оси времени (две шкалы, а не две оси на одном поле), фонды поимённо,
 * рекорды и крупнейшие держатели.
 *
 * Приток — зелёный, отток — красный, как на биржах.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { num, pct, px, usdWord } from "../lib/format";
import { haptic } from "../lib/telegram";
import { fetchEtf, peekEtf } from "../lib/api";
import { Card, Chips, Empty, SectionTitle, Segmented, Skeleton } from "../components/ui";
import type { EtfCoin, EtfReply } from "../lib/types";
import { Boundary } from "../components/Boundary";
import { Frame } from "./Screen";
import { CbpSection, CmeSection, Holders } from "./EtfMore";
import { dateStr, timeTicks } from "./FearGreedScreen";
import { EtfAlertsCard, FundBell, useEtfAlerts, type EtfAlerts } from "./EtfAlerts";

type Lang = Parameters<typeof t>[0];
type Range = "q" | "30" | "90";
type Period = "q" | "y" | "all";

const sym = "BTC";
const MODE_KEY = "wt-etf-mode";
const RANGE_KEY = "wt-etf-range";
const UP = "#0ecb81";
const DN = "#f6465d";
const iso = (x: string | number) => `⁦${x}⁩`;

/** Управляющие компании по тикеру — короче полного имени фонда и узнаваемее. */
const ISSUER: Record<string, string> = {
  IBIT: "BlackRock", FBTC: "Fidelity", GBTC: "Grayscale", BITB: "Bitwise", ARKB: "ARK 21Shares",
  HODL: "VanEck", EZBC: "Franklin", BTCO: "Invesco Galaxy", BTCW: "WisdomTree", BRRR: "CoinShares",
  MSBT: "Morgan Stanley",
};
/** Мини-фонд Grayscale делит тикер с монетой — без пометки «BTC» в списке фондов читается как сама монета. */
const MINI: Record<string, string> = { BTC: "Grayscale Mini" };


/** Деньги со знаком словом: «+148,7 млн $», «−1,2 млрд $». */
function money(v: number): string {
  if (Math.abs(v) < 0.5) return usdWord(0);
  return `${v > 0 ? "+" : "−"}${usdWord(Math.abs(v))}`;
}

/** То же коротко — три значащие цифры, как и везде на экране: для плиток в три столбца. */
function moneyShort(lang: Lang, v: number): string {
  try {
    const f = new Intl.NumberFormat(lang, {
      style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", notation: "compact", compactDisplay: "short",
      maximumSignificantDigits: 3,
    }).format(Math.abs(v));
    /* Пробелы обычные, а не неразрывные: в узкой плитке «+59.1 مليار US$»
       должно переноситься между словами, а не вылезать за край. */
    return `${v > 0 ? "+" : v < 0 ? "−" : ""}${f.replace(/[\u00a0\u202f]/g, " ")}`;
  } catch {
    return money(v);
  }
}

/** Монеты без лишней точности: «1,31 млн», «903 млн», «48 тыс.». */
function coinsRound(lang: Lang, v: number): string {
  try {
    return new Intl.NumberFormat(lang, { notation: "compact", compactDisplay: "short", maximumFractionDigits: 2 })
      .format(v).replace(/[\u00a0\u202f]/g, " ");
  } catch {
    return num(v);
  }
}

/** Монеты со знаком: «+1 778 BTC». */
function coins(v: number, sym: string): string {
  const d = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 1 ? 1 : 3;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${num(Math.abs(v), d)} ${sym}`;
}

/** Сколько новых биткоинов за сутки: 144 блока × награда за блок. */
function minedPerDay(ts: number): number {
  if (ts < 1713571200) return 900; // до халвинга 20 апреля 2024
  if (ts < 1838900000) return 450; // до следующего — по оценке ≈ 9 апреля 2028
  return 225;
}

interface Bucket { a: number; b: number; usd: number; coin: number; px: number; per: number[] }

/** Кварталы по отчётам — те же столбцы, что и дни: конец квартала, поток, монеты, цена отчётов. */
function quarterly(qs: EtfCoin["quarters"]): Bucket[] {
  return qs.map((q) => ({ a: q[0], b: q[0], usd: q[1], coin: q[2], px: q[3], per: q[4].map((v) => v ?? 0) }));
}

/** «2 кв. 2026» на языке приложения. */
function quarterOf(lang: Lang, ts: number): string {
  const d = new Date(ts * 1000);
  return t(lang, "ef_qn", { q: String(Math.floor(d.getUTCMonth() / 3) + 1), y: String(d.getUTCFullYear()) });
}

function daily(days: EtfCoin["days"]): Bucket[] {
  return days.map((d) => ({ a: d[0], b: d[0], usd: d[1], coin: d[2], px: d[3], per: d[4].map((v) => v ?? 0) }));
}

/* ---------------------------------------------------------------------- */

const W = 360;
const AXIS = 50;
const PW = W - AXIS - 4;
const P1 = { y: 6, h: 118 };
const P2 = { y: 138, h: 130 };
const H = P2.y + P2.h + 18;

function ticksOf(lang: Lang, a: number, b: number) {
  const all = timeTicks(lang, a, b);
  const step = Math.max(1, Math.ceil(all.length / 6));
  return all.filter((_, i) => (all.length - 1 - i) % step === 0);
}

function niceStep(span: number, parts: number): number {
  const raw = span / parts;
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
}

/**
 * Короткие деньги для оси — тем же языком, что и весь экран: «−1,5 млрд $»,
 * «40 Mio. $», «$250K». Ось — 50 единиц ширины: подпись длиннее 11 знаков
 * (арабское «40 مليون US$») не влезла бы — тогда «$40M».
 */
function axisMoney(lang: Lang, vK: number): string {
  const v = vK * 1000;
  const a = Math.abs(v);
  const s = v < 0 ? "−" : "";
  try {
    const f = new Intl.NumberFormat(lang, {
      style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", notation: "compact", maximumSignificantDigits: 2,
    }).format(a);
    if (f.length + s.length <= 11) return s + f;
  } catch {
    // старый WebView — короткая запись ниже
  }
  const f = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  if (a >= 1e9) return `${s}$${f(a / 1e9)}B`;
  if (a >= 1e6) return `${s}$${f(a / 1e6)}M`;
  return `${s}$${f(a / 1e3)}K`;
}

function FlowChart({ data, cum, zero, lang, sel, onSel }: {
  data: Bucket[];
  /** Накопленный поток с запуска к концу каждого столбца, $ тыс.; null — режим «по дням». */
  cum: number[] | null;
  /** Шкала накопленного от нуля — на всей истории; на коротком окне — по самим значениям. */
  zero: boolean;
  lang: Lang;
  sel: number | null;
  onSel: (i: number | null) => void;
}) {
  const n = data.length;
  const bw = PW / Math.max(1, n);
  const xOf = (i: number) => i * bw + bw / 2;
  const prices = data.map((d) => d.px).filter((v) => v > 0);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const log = hi / Math.max(1e-9, lo) > 3;
  const f = (v: number) => (log ? Math.log(v) : v);
  const pLo = f(lo * (log ? 0.93 : 0.98));
  const pHi = f(hi * (log ? 1.07 : 1.02));
  const yPx = (v: number) => P1.y + (1 - (f(v) - pLo) / (pHi - pLo || 1)) * P1.h;
  const maxAbs = Math.max(1, ...data.map((d) => Math.abs(d.usd)));
  const step = niceStep(maxAbs, 2);
  const top = Math.ceil(maxAbs / step) * step;
  const yF = (v: number) => P2.y + P2.h / 2 - (v / top) * (P2.h / 2 - 2);
  /* «Накоплено»: одна линия от нуля, шкала — от меньшего из нуля и минимума
     до большего из нуля и максимума. */
  /* На 90 днях линия на $55–59 млрд при шкале от нуля лежала бы плоско у
     верхнего края — изменения не видно. Поэтому ноль — только на всей истории. */
  const rawLo = cum ? Math.min(...cum) : 0;
  const rawHi = cum ? Math.max(...cum) : 1;
  const pad = Math.max(1, (rawHi - rawLo) * 0.08);
  const cLo = zero ? Math.min(0, rawLo) : rawLo - pad;
  const cHi = zero ? Math.max(0, rawHi) : rawHi + pad;
  const cStep = niceStep(Math.max(1, cHi - cLo), 3);
  const cTop = Math.ceil(cHi / cStep) * cStep;
  const cBot = Math.floor(cLo / cStep) * cStep;
  const yC = (v: number) => P2.y + 4 + (1 - (v - cBot) / Math.max(1, cTop - cBot)) * (P2.h - 8);
  const cTicks: number[] = [];
  if (cum) for (let v = cBot; v <= cTop + 1e-6; v += cStep) cTicks.push(v);
  const cLine = cum ? cum.map((v, i) => `${xOf(i).toFixed(1)},${yC(v).toFixed(1)}`).join(" ") : "";
  const cBase = zero ? yC(0) : P2.y + P2.h - 4;
  const cArea = cum && cum.length ? `${xOf(0).toFixed(1)},${cBase.toFixed(1)} ${cLine} ${xOf(cum.length - 1).toFixed(1)},${cBase.toFixed(1)}` : "";
  const a = data[0]?.a ?? 0;
  const b = data[n - 1]?.b ?? 1;
  const xOfT = (ts: number) => ((ts - a) / Math.max(1, b - a)) * PW;
  const line = data.map((d, i) => (d.px > 0 ? `${xOf(i).toFixed(1)},${yPx(d.px).toFixed(1)}` : "")).filter(Boolean).join(" ");

  const ref = useRef<SVGSVGElement>(null);
  const pick = (clientX: number) => {
    const el = ref.current;
    if (!el || !n) return;
    const box = el.getBoundingClientRect();
    const x = ((clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.floor(x / bw)));
    if (i !== sel) {
      haptic("select");
      onSel(i);
    }
  };
  const priceTicks = (() => {
    const out: number[] = [];
    if (log) {
      for (let e = -2; e <= 6; e++) for (const m of [1, 2, 5]) {
        const v = m * 10 ** e;
        if (v >= lo && v <= hi) out.push(v);
      }
      return out.length > 4 ? out.filter((_, i) => i % 2 === 0) : out;
    }
    const s = niceStep(hi - lo || hi * 0.1, 3);
    for (let v = Math.ceil(lo / s) * s; v <= hi; v += s) out.push(v);
    return out;
  })();
  const d = sel !== null ? data[sel] : undefined;

  return (
    <svg
      ref={ref}
      className="fg-svg"
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={t(lang, "ef_chart")}
      onPointerDown={(e: PointerEvent) => pick(e.clientX)}
      onPointerMove={(e: PointerEvent) => { if (e.pointerType === "mouse" || e.buttons) pick(e.clientX); }}
      onPointerUp={(e: PointerEvent) => { if (e.pointerType !== "mouse") onSel(null); }}
      onPointerCancel={() => onSel(null)}
      onPointerLeave={() => onSel(null)}
      onContextMenu={(e: MouseEvent) => e.preventDefault()}
    >
      <rect x={0} y={P1.y} width={PW} height={P1.h} className="fg-bg" />
      <rect x={0} y={P2.y} width={PW} height={P2.h} className="fg-bg" />
      {ticksOf(lang, a, b).map((x) => (
        <g key={x.t}>
          <line x1={xOfT(x.t)} x2={xOfT(x.t)} y1={P1.y} y2={P2.y + P2.h} className="fg-grid" />
          <text x={xOfT(x.t)} y={H - 4} textAnchor="middle" className="fg-tick">{x.label}</text>
        </g>
      ))}
      {priceTicks.map((v) => (
        <g key={v}>
          <line x1={0} x2={PW} y1={yPx(v)} y2={yPx(v)} className="fg-grid" />
          <text x={W - 2} y={yPx(v) + 3.5} textAnchor="end" className="fg-tick">{px(v).replace(/[,.]\d+$/, (m) => (v < 10 ? m : ""))}</text>
        </g>
      ))}
      {(cum ? cTicks : [top, 0, -top]).map((v) => (
        <g key={v}>
          <line x1={0} x2={PW} y1={cum ? yC(v) : yF(v)} y2={cum ? yC(v) : yF(v)} className={v === 0 ? "ef-zero" : "fg-grid"} />
          <text x={W - 2} y={(cum ? yC(v) : yF(v)) + 3.5} textAnchor="end" className="fg-tick">{v === 0 ? "0" : axisMoney(lang, v)}</text>
        </g>
      ))}
      <text x={4} y={P1.y + 11} className="fg-ptl">{t(lang, "ef_price")}{log ? ` · ${t(lang, "fg_log")}` : ""}</text>
      <text x={4} y={P2.y + 11} className="fg-ptl">{t(lang, cum ? "ef_cum_chart" : "ef_flows")}</text>
      {cum ? (
        <>
          <polygon points={cArea} fill={UP} opacity={0.12} />
          <polyline points={cLine} className="fg-line" stroke={UP} />
        </>
      ) : null}
      {cum ? null : data.map((x, i) => {
        const y0 = yF(0);
        const y1 = yF(x.usd);
        const w = Math.max(1, bw - (bw > 4 ? 1.5 : 0.4));
        return x.usd === 0 ? null : (
          <rect key={x.a} x={i * bw + (bw - w) / 2} y={Math.min(y0, y1)} width={w} height={Math.max(1, Math.abs(y1 - y0))}
            fill={x.usd > 0 ? UP : DN} opacity={sel === null || sel === i ? 0.9 : 0.45} rx={bw > 6 ? 1.5 : 0} />
        );
      })}
      <polyline points={line} className="fg-line" stroke="#e2e8f0" />
      {d ? (
        <g className="fg-cross">
          <line x1={xOf(sel!)} x2={xOf(sel!)} y1={P1.y} y2={P2.y + P2.h} />
          {d.px > 0 ? <circle cx={xOf(sel!)} cy={yPx(d.px)} r={4} fill="#e2e8f0" /> : null}
          {cum ? <circle cx={xOf(sel!)} cy={yC(cum[sel!] ?? 0)} r={4} fill={UP} /> : null}
        </g>
      ) : null}
    </svg>
  );
}

/* ---------------------------------------------------------------------- */

/** Флаг страны по коду ISO: «US» → 🇺🇸. */
function flagOf(code?: string): string {
  return code && /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : "";
}

function fundLabel(f: EtfCoin["funds"][number]): string {
  if (MINI[f.t] && /mini/i.test(f.n || "Mini")) return MINI[f.t]!;
  return ISSUER[f.t] ?? f.n.replace(/ (ETF|Trust|Fund).*$/i, "");
}

function Funds({ c, al, lang }: { c: EtfCoin; al: EtfAlerts; lang: Lang }) {
  const [period, setPeriod] = useState<Period>("q");
  const aumAll = c.funds.reduce((s, f) => s + (f.aum || 0), 0);
  const qs = c.quarters ?? [];
  const rows = useMemo(() => {
    const sum = c.funds.map(() => 0);
    if (period === "all") c.funds.forEach((f, i) => { sum[i] = f.cum / 1000; });
    else for (const q of qs.slice(period === "q" ? -1 : -4)) q[4].forEach((v, i) => { sum[i]! += v ?? 0; });
    return c.funds.map((f, i) => ({ f, v: sum[i]! })).sort((x, y) => y.v - x.v);
  }, [c, qs, period]);
  const moving = rows.filter((r) => Math.abs(r.v) >= 1);
  const still = rows.length - moving.length;
  const span = Math.max(1, ...moving.map((r) => Math.abs(r.v)));
  const ins = moving.filter((r) => r.v > 0).reduce((s, r) => s + r.v, 0);
  const outs = moving.filter((r) => r.v < 0).reduce((s, r) => s + r.v, 0);
  const lastQ = qs[qs.length - 1];
  return (
    <Card>
      <Chips<Period>
        value={period}
        onChange={(p) => { haptic("select"); setPeriod(p); }}
        options={[
          { id: "q", label: lastQ ? quarterOf(lang, lastQ[0]) : t(lang, "ef_p_q") },
          { id: "y", label: t(lang, "ef_p_y") },
          { id: "all", label: t(lang, "ef_p_all") },
        ]}
      />
      <p className="ef-fsum">
        {/* Ноль — без цвета: зелёный «Приток 0 $» читался как приток. */}
        <span className={ins ? "up" : "dim"}>{t(lang, "ef_in")} <bdi dir="ltr">{money(ins * 1000)}</bdi></span>
        <span className={outs ? "dn" : "dim"}>{t(lang, "ef_out")} <bdi dir="ltr">{money(outs * 1000)}</bdi></span>
      </p>
      <div className="ef-funds">
        {moving.map(({ f, v }) => {
          const r = Math.sqrt(Math.abs(v) / span);
          const label = fundLabel(f);
          return (
            <div key={f.t} className="ef-f">
              <span className="ef-f-id">
                <b>{f.c ? <span aria-hidden="true">{flagOf(f.c)} </span> : null}{f.t}<FundBell fund={f.t} al={al} lang={lang} /></b>
                {label && label !== f.t ? <small>{label}</small> : null}
              </span>
              <span className="ef-f-bar">
                <i className="ef-f-mid" />
                <i className="ef-f-fill" style={v >= 0
                  ? { insetInlineStart: "50%", width: `${r * 50}%`, background: UP }
                  : { insetInlineEnd: "50%", width: `${r * 50}%`, background: DN }} />
              </span>
              <b className={v >= 0 ? "ef-f-v up" : "ef-f-v dn"}><bdi dir="ltr">{money(v * 1000)}</bdi></b>
              {f.aum > 0 ? (
                <small className="ef-f-sub">
                  {t(lang, "ef_aum", { v: iso(usdWord(f.aum)) })}
                  {aumAll > 0 ? ` · ${t(lang, "ef_mshare", { p: iso(pct((f.aum / aumAll) * 100, 1, false)) })}` : ""}
                  {f.fee !== null && f.fee !== undefined ? ` · ${t(lang, "ef_fee", { v: iso(pct(f.fee, 2, false)) })}` : ""}
                  {f.src === "chain" ? ` · ${t(lang, f.part ? "ef_src_part" : "ef_src_chain")}` : ""}
                </small>
              ) : null}
            </div>
          );
        })}
      </div>
      {still > 0 ? <p className="lq-hint">{t(lang, "ef_still", { n: iso(num(still)) })}</p> : null}
      <p className="lq-hint">{t(lang, "ef_funds_note")}</p>
    </Card>
  );
}

/* ---------------------------------------------------------------------- */

export function EtfScreen() {
  const lang = useApp((s) => s.lang);
  const [reply, setReply] = useState<EtfReply | null>(() => peekEtf() ?? null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [range, setRange] = useState<Range>(() => {
    try {
      const v = localStorage.getItem(RANGE_KEY);
      return (["q", "30", "90"].includes(v ?? "") ? v : "q") as Range;
    } catch {
      return "q";
    }
  });
  const [sel, setSel] = useState<number | null>(null);
  const alerts = useEtfAlerts(lang);
  const [mode, setMode] = useState<"d" | "c">(() => {
    try {
      return localStorage.getItem(MODE_KEY) === "c" ? "c" : "d";
    } catch {
      return "d";
    }
  });

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void fetchEtf().then((r) => {
      if (!alive) return;
      if (r?.ok && r.coins?.btc) setReply(r);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [retry]);

  const remember = (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // без памяти выбора — не беда
    }
  };

  const c = reply?.coins?.btc;
  /* Старый ответ (до перехода на отчёты SEC) кварталов не знает — такой
     ответ экран не рисует, а ждёт свежий. */
  const qs = Array.isArray(c?.quarters) ? c!.quarters : [];
  const days = c?.days ?? [];
  const lastQ = qs[qs.length - 1];
  const lastPx = c?.px || ([...days].reverse().find((d) => d[3] > 0)?.[3] ?? 0);
  const chainFunds = (c?.funds ?? []).filter((f) => f.src === "chain")
    .map((f) => (f.part ? `${f.t} (${t(lang, "ef_src_part")})` : f.t));

  const stats = useMemo(() => {
    if (!c || !qs.length) return null;
    const lq = qs[qs.length - 1]!;
    const prev = qs[qs.length - 2];
    const year = qs.slice(-4).reduce((s, q) => s + q[1], 0) * 1000;
    const cum = c.funds.reduce((s, f) => s + f.cum, 0);
    const aum = c.funds.reduce((s, f) => s + f.aum, 0);
    const held = c.funds.reduce((s, f) => s + (f.hold ?? 0), 0);
    // Добыча за квартал: сутки от конца прошлого квартала до конца этого.
    let mined = 0;
    for (let t0 = (prev?.[0] ?? lq[0] - 91 * 86400) + 86400; t0 <= lq[0]; t0 += 86400) mined += minedPerDay(t0);
    let best = qs[0]!;
    let worst = qs[0]!;
    let fin: [number, number, number] | null = null; // квартал, фонд, $ тыс.
    let fout: [number, number, number] | null = null;
    for (const q of qs) {
      if (q[1] > best[1]) best = q;
      if (q[1] < worst[1]) worst = q;
      q[4].forEach((v, i) => {
        if (v === null) return;
        if (!fin || v > fin[2]) fin = [q[0], i, v];
        if (!fout || v < fout[2]) fout = [q[0], i, v];
      });
    }
    // По дням — своя цепочка: только фонды с известными кошельками.
    const end = days[days.length - 1]?.[0] ?? 0;
    const win = (n: number) => days.filter((d) => d[0] > end - n * 86400).reduce((s, d) => s + d[1], 0) * 1000;
    return { lq, year, cum, aum, held, mined, best, worst, fin, fout, d7: win(7), d30: win(30) };
  }, [c, qs, days]);

  const view = useMemo(() => {
    if (!c) return [];
    if (range === "q" || !days.length) return quarterly(qs);
    const end = days[days.length - 1]![0];
    return daily(days.filter((d) => d[0] > end - Number(range) * 86400));
  }, [c, qs, days, range]);
  const isQ = range === "q" || !days.length;
  const selB = sel !== null ? view[sel] : undefined;
  /* Накоплено с запуска фондов к концу каждого квартала. */
  const cumView = useMemo(() => {
    let acc = 0;
    return view.map((b) => (acc += b.usd));
  }, [view]);

  const pickRange = (r: Range) => {
    setRange(r);
    setSel(null);
    remember(RANGE_KEY, r);
  };

  const dayTxt = (ts: number) => dateStr(lang, ts, { weekday: "short", day: "numeric", month: "long" });
  /* «30 июня 2026 г.» — точку даты текст ставит сам, иначе «г..». */
  const asofTxt = c?.asof ? dateStr(lang, c.asof, { day: "numeric", month: "long", year: "numeric" }).replace(/\.$/, "") : "";
  const lastDay = days[days.length - 1];

  return (
    <Frame title={t(lang, "ef_title")}>
      <p className="lq-lead">{t(lang, "ef_sub")}</p>
      {!reply ? (
        failed ? (
          <Empty text={t(lang, "ef_err")} hint={
            <button type="button" className="lq-retry" onClick={() => setRetry((n) => n + 1)}>{t(lang, "ui_retry")}</button>
          } />
        ) : <Card><Skeleton rows={8} /></Card>
      ) : !c || !lastQ || !stats ? <Card><Skeleton rows={8} /></Card> : (
        <>
          <Card>
            <div className="ef-hero">
              <small>{t(lang, "ef_lastq", { q: quarterOf(lang, lastQ[0]) })}</small>
              <b className={lastQ[1] > 0 ? "up" : lastQ[1] < 0 ? "dn" : ""}><bdi dir="ltr">{money(lastQ[1] * 1000)}</bdi></b>
              <span>
                {t(lang, lastQ[1] > 0 ? "ef_inflow" : lastQ[1] < 0 ? "ef_outflow" : "ef_flat")}
                {lastQ[2] ? <> · <bdi dir="ltr">{coins(lastQ[2], sym)}</bdi></> : null}
              </span>
            </div>
            <div className="dm-chs three ef-chs">
              {([["ef_y_sum", stats.year], ["ef_cum", stats.cum]] as const).map(([k, v]) => (
                <div key={k} className="dm-ch">
                  <small>{t(lang, k)}</small>
                  <b className={v >= 0 ? "up" : "dn"}><bdi dir="ltr">{moneyShort(lang, v)}</bdi></b>
                </div>
              ))}
              <div className="dm-ch">
                <small>{t(lang, "ef_hold_t")}</small>
                <b><bdi dir="ltr">{coinsRound(lang, stats.held)} {sym}</bdi></b>
              </div>
            </div>
            {stats.aum > 0 ? (
              <p className="ef-held">
                {t(lang, "ef_held", {
                  a: iso(usdWord(stats.aum)), c: iso(`${coinsRound(lang, stats.held)} ${sym}`),
                })}
                {c.share ? ` ${t(lang, "ef_share", { p: iso(pct(c.share, 2, false)) })}` : ""}
              </p>
            ) : null}
            {asofTxt ? <p className="lq-hint">{t(lang, "ef_asof", { d: asofTxt })}</p> : null}
          </Card>

          {lastDay ? (
            <Card>
              <p className="ef-mine-t">{t(lang, "ef_d_title")}</p>
              <div className="ef-hero">
                <small>{t(lang, "ef_last", { d: dayTxt(lastDay[0]) })}</small>
                <b className={lastDay[1] > 0 ? "up" : lastDay[1] < 0 ? "dn" : ""}><bdi dir="ltr">{money(lastDay[1] * 1000)}</bdi></b>
                <span>
                  {t(lang, lastDay[1] > 0 ? "ef_inflow" : lastDay[1] < 0 ? "ef_outflow" : "ef_flat")}
                  {lastDay[2] ? <> · <bdi dir="ltr">{coins(lastDay[2], sym)}</bdi></> : null}
                </span>
              </div>
              <div className="dm-chs ef-chs">
                {([["ef_7d_sum", stats.d7], ["ef_30d_sum", stats.d30]] as const).map(([k, v]) => (
                  <div key={k} className="dm-ch">
                    <small>{t(lang, k)}</small>
                    <b className={v > 0 ? "up" : v < 0 ? "dn" : ""}><bdi dir="ltr">{moneyShort(lang, v)}</bdi></b>
                  </div>
                ))}
              </div>
              <p className="lq-hint">{t(lang, "ef_d_note", { f: chainFunds.join(", ") || "—" })}</p>
            </Card>
          ) : null}

          {stats.mined > 0 ? (
            <Card>
              <p className="ef-mine-t">{t(lang, "ef_mine_title")}</p>
              <div className="ef-mine">
                <div>
                  <small>{t(lang, stats.lq[2] >= 0 ? "ef_mine_etf_in" : "ef_mine_etf_out")}</small>
                  <span className="ef-mine-bar"><i style={{
                    width: `${Math.min(100, (Math.abs(stats.lq[2]) / Math.max(Math.abs(stats.lq[2]), stats.mined)) * 100)}%`,
                    background: stats.lq[2] >= 0 ? UP : DN,
                  }} /></span>
                  <b><bdi dir="ltr">{num(Math.abs(stats.lq[2]))} BTC</bdi></b>
                </div>
                <div>
                  <small>{t(lang, "ef_mine_new")}</small>
                  <span className="ef-mine-bar"><i style={{
                    width: `${Math.min(100, (stats.mined / Math.max(Math.abs(stats.lq[2]), stats.mined)) * 100)}%`,
                    background: "#f7931a",
                  }} /></span>
                  <b><bdi dir="ltr">{num(stats.mined)} BTC</bdi></b>
                </div>
              </div>
              <p className="ef-mine-say">
                {stats.lq[2] > 0
                  ? stats.lq[2] >= stats.mined
                    ? t(lang, "ef_mine_more", { x: iso(num(stats.lq[2] / stats.mined, 1)) })
                    : t(lang, "ef_mine_less", { x: iso(pct((stats.lq[2] / stats.mined) * 100, 0, false)) })
                  : t(lang, "ef_mine_sell")}
              </p>
            </Card>
          ) : null}

          <SectionTitle>{t(lang, "ef_chart")}</SectionTitle>
          <Card>
            {days.length ? (
              <Segmented<Range>
                value={isQ ? "q" : range}
                onChange={pickRange}
                options={[
                  { id: "q", label: t(lang, "ef_rng_q") },
                  { id: "30", label: t(lang, "fg_r30") },
                  { id: "90", label: t(lang, "fg_r90") },
                ]}
              />
            ) : null}
            <div className="fg-plot">
              <FlowChart data={view} cum={isQ && mode === "c" ? cumView : null} zero={isQ} lang={lang} sel={sel} onSel={setSel} />
              {selB ? (() => {
                const tops = c.funds.map((f, i) => ({ t: f.t, v: selB.per[i] ?? 0 }))
                  .filter((x) => Math.abs(x.v) >= 1).sort((x, y) => Math.abs(y.v) - Math.abs(x.v)).slice(0, 3);
                return (
                  <div className={sel! > view.length / 2 ? "fg-pop left ef-pop" : "fg-pop ef-pop"} aria-live="polite">
                    <small>{isQ ? quarterOf(lang, selB.a) : dayTxt(selB.a)}</small>
                    <b className={selB.usd >= 0 ? "up" : "dn"}><bdi dir="ltr">{money(selB.usd * 1000)}</bdi></b>
                    {isQ && mode === "c" && cumView[sel!] !== undefined ? (
                      <span>{t(lang, "ef_cum")} <bdi dir="ltr" className={cumView[sel!]! >= 0 ? "up" : "dn"}>{money(cumView[sel!]! * 1000)}</bdi></span>
                    ) : null}
                    {selB.px > 0 ? <span>{sym} <bdi dir="ltr">{px(selB.px)}</bdi></span> : null}
                    {tops.map((x) => (
                      <span key={x.t} className="ef-pop-f"><i>{x.t}</i> <bdi dir="ltr" className={x.v >= 0 ? "up" : "dn"}>{money(x.v * 1000)}</bdi></span>
                    ))}
                  </div>
                );
              })() : null}
            </div>
            {isQ ? (
              <Chips<"d" | "c">
                value={mode}
                onChange={(m) => { haptic("select"); setMode(m); setSel(null); remember(MODE_KEY, m); }}
                options={[
                  { id: "d", label: t(lang, "ef_mode_d") },
                  { id: "c", label: t(lang, "ef_mode_c") },
                ]}
              />
            ) : null}
            <p className="lq-hint">
              {isQ && mode === "c" ? t(lang, "ef_cum_hint") : t(lang, isQ ? "ef_chart_q" : "ef_chart_d")} {t(lang, "fg_hint")}
            </p>
          </Card>

          <SectionTitle>{t(lang, "ef_f_title")}</SectionTitle>
          <Funds c={c} al={alerts} lang={lang} />
          <EtfAlertsCard al={alerts} lang={lang} />

          <SectionTitle>{t(lang, "ef_r_title")}</SectionTitle>
          <Card>
            <div className="fg-rows ef-rec">
              <div className="fg-row two">
                <span>{t(lang, "ef_r_bestq")}<small> · {quarterOf(lang, stats.best[0])}</small></span>
                <b className={stats.best[1] >= 0 ? "up" : "dn"}><bdi dir="ltr">{money(stats.best[1] * 1000)}</bdi></b>
              </div>
              <div className="fg-row two">
                <span>{t(lang, "ef_r_worstq")}<small> · {quarterOf(lang, stats.worst[0])}</small></span>
                <b className={stats.worst[1] >= 0 ? "up" : "dn"}><bdi dir="ltr">{money(stats.worst[1] * 1000)}</bdi></b>
              </div>
              {stats.fin ? (
                <div className="fg-row two">
                  <span>{t(lang, "ef_r_fin")}<small> · {c.funds[stats.fin[1]]?.t} · {quarterOf(lang, stats.fin[0])}</small></span>
                  <b className="up"><bdi dir="ltr">{money(stats.fin[2] * 1000)}</bdi></b>
                </div>
              ) : null}
              {stats.fout ? (
                <div className="fg-row two">
                  <span>{t(lang, "ef_r_fout")}<small> · {c.funds[stats.fout[1]]?.t} · {quarterOf(lang, stats.fout[0])}</small></span>
                  <b className="dn"><bdi dir="ltr">{money(stats.fout[2] * 1000)}</bdi></b>
                </div>
              ) : null}
            </div>
            <p className="lq-hint">{t(lang, "ef_r_note", { d: quarterOf(lang, qs[0]![0]) })}</p>
          </Card>

          {/* Блок упал (чужой ответ, старый формат) — пропадает только он, а не весь экран. */}
          <Boundary name="etf-holders"><Holders raw={reply.holders} price={lastPx} lang={lang} /></Boundary>
          <Boundary name="etf-cme">
            {reply.cme?.btc?.length ? <CmeSection rows={reply.cme.btc} sym={sym} price={lastPx} lang={lang} /> : null}
          </Boundary>
          <Boundary name="etf-cbp">
            {reply.cbp?.btc?.days?.length ? <CbpSection d={reply.cbp.btc} sym={sym} lang={lang} /> : null}
          </Boundary>

          <details className="lq-how">
            <summary>{t(lang, "fg_how")}</summary>
            <ul>
              <li>{t(lang, "ef_how_1")}</li>
              <li>{t(lang, "ef_how_2")}</li>
              <li>{t(lang, "ef_how_3")}</li>
              <li>{t(lang, "ef_how_5")}</li>
              <li>{t(lang, "ef_how_6")}</li>
            </ul>
          </details>
        </>
      )}
    </Frame>
  );
}

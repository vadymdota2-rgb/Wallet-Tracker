/**
 * Институциональные потоки биткоина: сколько денег заходит в спотовые
 * биржевые фонды и кто из крупных держателей покупает или продаёт.
 *
 * Сверху — последний торговый день фондов и суммы за неделю, месяц и с
 * запуска, серия притоков или оттоков подряд. Для биткоина — главное
 * сравнение: сколько монет забрали ETF и сколько за то же время намайнено.
 * Ниже — цена и потоки на двух панелях одной оси времени (это две шкалы, а не
 * две оси на одном поле), затем фонды поимённо за выбранный срок, рекорды и
 * крупнейшие держатели — фонды и публичные компании.
 *
 * Потоки фондов по дням — открытый набор TFTC (CC BY 4.0): источник и
 * лицензия подписаны рядом с цифрами.
 *
 * Приток — зелёный, отток — красный, как на биржах. Цифры фондов приходят
 * раз в сутки после закрытия торгов в США, поэтому «сегодня» здесь нет:
 * последний день — последний, по которому фонды отчитались.
 *
 * Расчёты и проверка ответа — в lib/etf.ts (их гоняют тесты); здесь — вид.
 * График доступен и без пальца: стрелки клавиатуры ведут по столбцам, а
 * под графиком — те же столбцы таблицей.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { num, pct, px, usdWord } from "../lib/format";
import { haptic, openExternal } from "../lib/telegram";
import { fetchEtf, peekEtf } from "../lib/api";
import { Card, Chips, Empty, SectionTitle, Segmented, Skeleton } from "../components/ui";
import {
  PERIODS, RANGES, chartView, cumulative, etfStats, fundTotals, topFunds,
  type Bucket, type EtfCoin, type EtfFund, type EtfReply, type Period, type Range,
} from "../lib/etf";
import { Boundary } from "../components/Boundary";
import { Frame } from "./Screen";
import { CbpSection, CmeSection, Holders } from "./EtfMore";
import { dateStr, timeTicks } from "./FearGreedScreen";
import "./EtfScreen.css";

type Lang = Parameters<typeof t>[0];

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
  MSBT: "Morgan Stanley", DEFI: "Hashdex",
};
/* Потоки фондов по дням — открытый набор TFTC под лицензией CC BY 4.0:
   условие — подпись источника со ссылкой и ссылка на лицензию рядом с данными. */
const TFTC_URL = "https://www.tftc.io/bitcoin-etf-flows";
const CCBY_URL = "https://creativecommons.org/licenses/by/4.0/";
const PERIOD_KEY = { d: "ef_p_d", w: "ef_p_w", m: "ef_p_m", all: "ef_p_all" } as const;
const RANGE_LABEL = { 30: "fg_r30", 90: "fg_r90", 365: "fg_r1y", all: "fg_rall" } as const;
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

function FlowChart({ data, cum, zero, lang, sel, onSel, label }: {
  data: Bucket[];
  /** Что на графике словами — для читалки экрана. */
  label: string;
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
      aria-label={label}
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

/** Те же столбцы цифрами — для читалки экрана и для тех, кому цифры удобнее полос. */
function FlowTable({ view, cum, daily, lang }: { view: Bucket[]; cum: number[] | null; daily: boolean; lang: Lang }) {
  const [open, setOpen] = useState(false);
  const when = (b: Bucket) => (daily ? dateStr(lang, b.a, { day: "numeric", month: "short", year: "numeric" })
    : `${dateStr(lang, b.a, { day: "numeric", month: "short" })} — ${dateStr(lang, b.b, { day: "numeric", month: "short", year: "numeric" })}`);
  return (
    <details className="ef-tbl" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{t(lang, "ef_tbl")}</summary>
      {open ? (
        <div className="ef-tbl-w">
          <table>
            <thead>
              <tr>
                <th scope="col">{t(lang, daily ? "ef_tbl_d" : "ef_tbl_w")}</th>
                <th scope="col">{t(lang, cum ? "ef_cum" : "ef_flows")}</th>
                <th scope="col">{t(lang, "ef_price")}</th>
              </tr>
            </thead>
            <tbody>
              {view.map((b, i) => {
                const v = cum ? (cum[i] ?? 0) : b.usd;
                return (
                  <tr key={b.a}>
                    <th scope="row">{when(b)}</th>
                    <td className={v > 0 ? "up" : v < 0 ? "dn" : ""}><bdi dir="ltr">{money(v * 1000)}</bdi></td>
                    <td><bdi dir="ltr">{b.px > 0 ? px(b.px) : "—"}</bdi></td>
                  </tr>
                );
              }).reverse()}
            </tbody>
          </table>
        </div>
      ) : null}
    </details>
  );
}

/* ---------------------------------------------------------------------- */

/** Флаг страны по коду ISO: «US» → 🇺🇸. */
function flagOf(code?: string): string {
  return code && /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : "";
}

function fundLabel(f: EtfFund): string {
  if (MINI[f.t] && /mini/i.test(f.n || "Mini")) return MINI[f.t]!;
  return ISSUER[f.t] ?? f.n.replace(/ (ETF|Trust|Fund).*$/i, "");
}

function Funds({ c, lang }: { c: EtfCoin; lang: Lang }) {
  const [period, setPeriod] = useState<Period>("w");
  const aumAll = c.funds.reduce((s, f) => s + (f.aum || 0), 0);
  const { moving, still, span, ins, outs } = useMemo(() => fundTotals(c, period), [c, period]);
  return (
    <Card>
      <Chips<Period>
        value={period}
        onChange={(p) => { haptic("select"); setPeriod(p); }}
        options={PERIODS.map((id) => ({ id, label: t(lang, PERIOD_KEY[id]) }))}
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
                <b>{f.c ? <span aria-hidden="true">{flagOf(f.c)} </span> : null}{f.t}</b>
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
      return RANGES.find((r) => r === v) ?? "90";
    } catch {
      return "90";
    }
  });
  const [sel, setSel] = useState<number | null>(null);
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
      if (r) setReply(r);
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

  /* Ответ уже проверен (validEtf): в нём всегда есть фонды и хотя бы один день. */
  const c = reply?.coins.btc;
  const days = useMemo(() => c?.days ?? [], [c]);
  const lastPx = c?.px || ([...days].reverse().find((d) => d[3] > 0)?.[3] ?? 0);
  const stats = useMemo(() => (c ? etfStats(c, Date.now() / 1000) : null), [c]);
  const view = useMemo(() => (c ? chartView(days, c.funds.length, range) : []), [c, days, range]);
  const selB = sel !== null ? view[sel] : undefined;
  const cumView = useMemo(() => cumulative(view, days), [view, days]);
  const daily = range === "30" || range === "90";

  const pickRange = (r: Range) => {
    setRange(r);
    setSel(null);
    remember(RANGE_KEY, r);
  };
  /* Клавиатура: стрелки — соседний столбец, Home/End — первый и последний,
     Esc — убрать подсказку. Время на графике идёт слева направо и в RTL. */
  const onKey = (e: KeyboardEvent) => {
    const n = view.length;
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

  const dayTxt = (ts: number) => dateStr(lang, ts, { weekday: "short", day: "numeric", month: "long" });

  return (
    <Frame title={t(lang, "ef_title")}>
      <p className="lq-lead">{t(lang, "ef_sub")}</p>
      {!reply ? (
        failed ? (
          <Empty text={t(lang, "ef_err")} hint={
            <button type="button" className="lq-retry" onClick={() => setRetry((n) => n + 1)}>{t(lang, "ui_retry")}</button>
          } />
        ) : <div aria-busy="true"><Card><Skeleton rows={8} /></Card></div>
      ) : !c || !stats ? null : (
        <>
          <Card>
            <div className="ef-hero">
              <small>{t(lang, "ef_last", { d: dayTxt(stats.last[0]) })}</small>
              <b className={stats.last[1] > 0 ? "up" : stats.last[1] < 0 ? "dn" : ""}><bdi dir="ltr">{money(stats.last[1] * 1000)}</bdi></b>
              <span>
                {t(lang, stats.last[1] > 0 ? "ef_inflow" : stats.last[1] < 0 ? "ef_outflow" : "ef_flat")}
                {stats.last[2] ? <> · <bdi dir="ltr">{coins(stats.last[2], sym)}</bdi></> : null}
              </span>
              {stats.streak >= 2 ? (
                <em className={stats.sign > 0 ? "up" : "dn"}>
                  {t(lang, stats.sign > 0 ? "ef_streak_in" : "ef_streak_out", { n: iso(num(stats.streak)) })}
                </em>
              ) : null}
            </div>
            <div className="dm-chs three ef-chs">
              {([["ef_7d_sum", stats.d7], ["ef_30d_sum", stats.d30], ["ef_cum", stats.cum]] as const).map(([k, v]) => (
                <div key={k} className="dm-ch">
                  <small>{t(lang, k)}</small>
                  <b className={v >= 0 ? "up" : "dn"}><bdi dir="ltr">{moneyShort(lang, v)}</bdi></b>
                </div>
              ))}
            </div>
            {stats.aum > 0 ? (
              <p className="ef-held">
                {t(lang, "ef_held", {
                  a: iso(usdWord(stats.aum)), c: iso(`${coinsRound(lang, stats.held)} ${sym}`),
                })}
                {c.share ? ` ${t(lang, "ef_share", { p: iso(pct(c.share, 2, false)) })}` : ""}
              </p>
            ) : null}
            <p className="fg-by">
              {t(lang, "ef_by")}{" "}
              <a href={TFTC_URL} onClick={(e) => { e.preventDefault(); openExternal(TFTC_URL); }}>TFTC</a>
              {" ("}<a href={CCBY_URL} onClick={(e) => { e.preventDefault(); openExternal(CCBY_URL); }}>CC BY 4.0</a>{"). "}
              {t(lang, "ef_by_ch")}
            </p>
          </Card>

          {stats.mined > 0 && stats.c30 !== 0 ? (
            <Card>
              <p className="ef-mine-t">{t(lang, "ef_mine_title")}</p>
              <div className="ef-mine">
                <div>
                  <small>{t(lang, stats.c30 >= 0 ? "ef_mine_etf_in" : "ef_mine_etf_out")}</small>
                  <span className="ef-mine-bar"><i style={{
                    width: `${Math.min(100, (Math.abs(stats.c30) / Math.max(Math.abs(stats.c30), stats.mined)) * 100)}%`,
                    background: stats.c30 >= 0 ? UP : DN,
                  }} /></span>
                  <b><bdi dir="ltr">{num(Math.abs(stats.c30))} BTC</bdi></b>
                </div>
                <div>
                  <small>{t(lang, "ef_mine_new")}</small>
                  <span className="ef-mine-bar"><i style={{
                    width: `${Math.min(100, (stats.mined / Math.max(Math.abs(stats.c30), stats.mined)) * 100)}%`,
                    background: "#f7931a",
                  }} /></span>
                  <b><bdi dir="ltr">{num(stats.mined)} BTC</bdi></b>
                </div>
              </div>
              <p className="ef-mine-say">
                {stats.c30 > 0
                  ? stats.c30 >= stats.mined
                    ? t(lang, "ef_mine_more", { x: iso(num(stats.c30 / stats.mined, 1)) })
                    : t(lang, "ef_mine_less", { x: iso(pct((stats.c30 / stats.mined) * 100, 0, false)) })
                  : t(lang, "ef_mine_sell")}
              </p>
            </Card>
          ) : null}

          <SectionTitle>{t(lang, "ef_chart")}</SectionTitle>
          <Card>
            <Segmented<Range>
              value={range}
              onChange={pickRange}
              options={RANGES.map((id) => ({ id, label: t(lang, RANGE_LABEL[id]) }))}
            />
            <div className="fg-plot ef-plot" tabIndex={0} role="group" aria-label={t(lang, "ef_chart_keys")}
              onKeyDown={onKey} onBlur={() => setSel(null)}>
              <FlowChart data={view} cum={mode === "c" ? cumView : null} zero={range === "all"} lang={lang} sel={sel} onSel={setSel}
                label={t(lang, "ef_chart_sum", { v: iso(money(view.reduce((s, b) => s + b.usd, 0) * 1000)) })} />
              {selB ? (() => {
                const tops = topFunds(c.funds, selB);
                return (
                  <div className={sel! > view.length / 2 ? "fg-pop left ef-pop" : "fg-pop ef-pop"} aria-live="polite">
                    <small>{selB.a === selB.b ? dayTxt(selB.a)
                      : `${dateStr(lang, selB.a, { day: "numeric", month: "short" })} — ${dateStr(lang, selB.b, { day: "numeric", month: "short", year: "numeric" })}`}</small>
                    <b className={selB.usd >= 0 ? "up" : "dn"}><bdi dir="ltr">{money(selB.usd * 1000)}</bdi></b>
                    {mode === "c" && cumView[sel!] !== undefined ? (
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
            <Chips<"d" | "c">
              value={mode}
              onChange={(m) => { haptic("select"); setMode(m); setSel(null); remember(MODE_KEY, m); }}
              options={[
                { id: "d", label: t(lang, "ef_mode_d") },
                { id: "c", label: t(lang, "ef_mode_c") },
              ]}
            />
            <p className="lq-hint">
              {mode === "c" ? t(lang, "ef_cum_hint")
                : t(lang, daily ? "ef_chart_d" : "ef_chart_w")} {t(lang, "fg_hint")}
            </p>
            <FlowTable view={view} cum={mode === "c" ? cumView : null} daily={daily} lang={lang} />
          </Card>

          <SectionTitle>{t(lang, "ef_f_title")}</SectionTitle>
          <Funds c={c} lang={lang} />

          <SectionTitle>{t(lang, "ef_r_title")}</SectionTitle>
          <Card>
            <div className="fg-rows ef-rec">
              <div className="fg-row two">
                <span>{t(lang, "ef_r_best")}<small> · {dateStr(lang, stats.best[0], { day: "numeric", month: "short", year: "numeric" })}</small></span>
                <b className="up"><bdi dir="ltr">{money(stats.best[1] * 1000)}</bdi></b>
              </div>
              <div className="fg-row two">
                <span>{t(lang, "ef_r_worst")}<small> · {dateStr(lang, stats.worst[0], { day: "numeric", month: "short", year: "numeric" })}</small></span>
                <b className="dn"><bdi dir="ltr">{money(stats.worst[1] * 1000)}</bdi></b>
              </div>
              {stats.bestM ? (
                <div className="fg-row two">
                  <span>{t(lang, "ef_r_bestm")}<small> · {dateStr(lang, stats.bestM[0], { month: "long", year: "numeric" })}</small></span>
                  <b className={stats.bestM[1] >= 0 ? "up" : "dn"}><bdi dir="ltr">{money(stats.bestM[1] * 1000)}</bdi></b>
                </div>
              ) : null}
              {stats.worstM && stats.worstM[0] !== stats.bestM?.[0] ? (
                <div className="fg-row two">
                  <span>{t(lang, "ef_r_worstm")}<small> · {dateStr(lang, stats.worstM[0], { month: "long", year: "numeric" })}</small></span>
                  <b className={stats.worstM[1] >= 0 ? "up" : "dn"}><bdi dir="ltr">{money(stats.worstM[1] * 1000)}</bdi></b>
                </div>
              ) : null}
              <div className="fg-row two">
                <span>{t(lang, "ef_r_runup")}<small> · {t(lang, "ef_since", { d: dateStr(lang, stats.runs.up.at, { day: "numeric", month: "short", year: "numeric" }) })}</small></span>
                <b>{t(lang, "ef_days_n", { n: num(stats.runs.up.n) })}</b>
              </div>
              <div className="fg-row two">
                <span>{t(lang, "ef_r_rundn")}<small> · {t(lang, "ef_since", { d: dateStr(lang, stats.runs.dn.at, { day: "numeric", month: "short", year: "numeric" }) })}</small></span>
                <b>{t(lang, "ef_days_n", { n: num(stats.runs.dn.n) })}</b>
              </div>
            </div>
            <p className="lq-hint">{t(lang, "ef_r_note", { d: dateStr(lang, days[0]?.[0] ?? 0, { day: "numeric", month: "long", year: "numeric" }) })}</p>
          </Card>

          {/* Блок упал (чужой ответ, старый формат) — пропадает только он, а не весь экран. */}
          <Boundary name="etf-holders"><Holders rows={reply.holders ?? []} price={lastPx} lang={lang} /></Boundary>
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

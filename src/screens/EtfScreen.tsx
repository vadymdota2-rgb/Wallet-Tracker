/**
 * Институциональные потоки: сколько денег заходит в спотовые биржевые фонды и
 * кто из крупных держателей покупает или продаёт.
 *
 * Сверху — последний торговый день фондов и суммы за неделю, месяц и с
 * запуска, серия притоков или оттоков подряд. Для биткоина — главное
 * сравнение: сколько монет забрали ETF и сколько за то же время намайнено.
 * Ниже — цена и потоки на двух панелях одной оси времени (это две шкалы, а не
 * две оси на одном поле), затем фонды поимённо за выбранный срок, рекорды и
 * крупные держатели: компании, государства, фонды — кто сколько держит и кто
 * докупал за неделю.
 *
 * Приток — зелёный, отток — красный, как на биржах. Цифры фондов приходят
 * раз в сутки после закрытия торгов в США, поэтому «сегодня» здесь нет:
 * последний день — последний, по которому фонды отчитались.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey } from "../i18n/types";
import { num, pct, px, usdWord } from "../lib/format";
import { haptic } from "../lib/telegram";
import { fetchEtf, peekEtf } from "../lib/api";
import { Card, Chips, Empty, SectionTitle, Segmented, Skeleton } from "../components/ui";
import type { BtcHolder, EtfCoin, EtfReply } from "../lib/types";
import { Frame } from "./Screen";
import { AltHolders, CbpSection, CmeSection, HoldersAll } from "./EtfMore";
import { dateStr, timeTicks } from "./FearGreedScreen";

type Lang = Parameters<typeof t>[0];
type Coin = "btc" | "eth" | "sol" | "xrp" | "hype";
type Range = "30" | "90" | "365" | "all";
type Period = "d" | "w" | "m" | "all";

const COINS: Coin[] = ["btc", "eth", "sol", "xrp", "hype"];
const SYM: Record<Coin, string> = { btc: "BTC", eth: "ETH", sol: "SOL", xrp: "XRP", hype: "HYPE" };
const COIN_KEY = "wt-etf-coin";
const MODE_KEY = "wt-etf-mode";
const RANGE_KEY = "wt-etf-range";
const UP = "#0ecb81";
const DN = "#f6465d";
const iso = (x: string | number) => `⁦${x}⁩`;

/**
 * Управляющие компании по тикеру — только те, в которых нет сомнений. У
 * биткоина и эфира полное имя фонда приходит с данными; у остальных монет его
 * нет, и без бренда тикер «BSOL» человеку ничего не говорит.
 */
const ISSUER: Record<string, string> = {
  IBIT: "BlackRock", ETHA: "BlackRock",
  FBTC: "Fidelity", FETH: "Fidelity", FSOL: "Fidelity",
  GBTC: "Grayscale", ETHE: "Grayscale", GSOL: "Grayscale", GXRP: "Grayscale",
  BITB: "Bitwise", ETHW: "Bitwise", BSOL: "Bitwise",
  ARKB: "ARK 21Shares", CETH: "21Shares",
  HODL: "VanEck", ETHV: "VanEck", VSOL: "VanEck",
  EZBC: "Franklin", EZET: "Franklin", SOEZ: "Franklin", XRPZ: "Franklin",
  BTCO: "Invesco Galaxy", QETH: "Invesco Galaxy",
  BTCW: "WisdomTree", BRRR: "CoinShares", XRPC: "Canary",
};
/** Мини-фонды Grayscale делят тикер с монетой — без пометки «BTC» в списке фондов читается как сама монета. */
const MINI: Record<string, string> = { BTC: "Grayscale Mini", ETH: "Grayscale Mini" };

const GROUPS: Record<string, { key: DictKey; c: string }> = {
  FUND: { key: "ef_g_fund", c: "#3b82f6" },
  PUBLIC_COMPANY: { key: "ef_g_pub", c: "#f7931a" },
  GOVERNMENT: { key: "ef_g_gov", c: "#a855f7" },
  DEFI: { key: "ef_g_defi", c: "#14b8a6" },
  PRIVATE_COMPANY: { key: "ef_g_priv", c: "#eab308" },
  EXCHANGE: { key: "ef_g_ex", c: "#94a3b8" },
};
const BTC_SUPPLY = 21_000_000;

/** Деньги со знаком словом: «+148,7 млн $», «−1,2 млрд $». */
function money(v: number): string {
  if (Math.abs(v) < 0.5) return usdWord(0);
  return `${v > 0 ? "+" : "−"}${usdWord(Math.abs(v))}`;
}

/** То же коротко — один знак после запятой: для плиток в три столбца. */
function moneyShort(lang: Lang, v: number): string {
  try {
    const f = new Intl.NumberFormat(lang, {
      style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", notation: "compact", compactDisplay: "short",
      maximumFractionDigits: 1,
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

/** Когда собраны данные — по часам телефона. */
function stamp(lang: Lang, at: number): string {
  try {
    return new Intl.DateTimeFormat(lang, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(at * 1000));
  } catch {
    return new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ");
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
  if (ts < 1837000000) return 450; // до следующего, весна 2028
  return 225;
}

interface Bucket { a: number; b: number; usd: number; coin: number; px: number; per: number[] }

/** Дни в недели: на годе и всей истории дневные столбцы сливаются в шум. */
function weekly(days: EtfCoin["days"], nf: number): Bucket[] {
  const out: Bucket[] = [];
  for (const d of days) {
    const wk = Math.floor((d[0] / 86400 + 3) / 7); // недели с понедельника
    const last = out[out.length - 1];
    if (last && Math.floor((last.a / 86400 + 3) / 7) === wk) {
      last.b = d[0];
      last.usd += d[1];
      last.coin += d[2];
      if (d[3]) last.px = d[3];
      d[4].forEach((v, i) => { last.per[i]! += v ?? 0; });
    } else {
      const per = Array.from({ length: nf }, (_, i) => d[4][i] ?? 0);
      out.push({ a: d[0], b: d[0], usd: d[1], coin: d[2], px: d[3], per });
    }
  }
  return out;
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

/** Короткие деньги для оси: $1.2B, −$300M. */
function axisMoney(vK: number): string {
  const v = vK * 1000;
  const a = Math.abs(v);
  const s = v < 0 ? "−" : "";
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
          <text x={W - 2} y={(cum ? yC(v) : yF(v)) + 3.5} textAnchor="end" className="fg-tick">{v === 0 ? "0" : axisMoney(v)}</text>
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

function fundLabel(f: EtfCoin["funds"][number]): string {
  if (MINI[f.t] && /mini/i.test(f.n || "Mini")) return MINI[f.t]!;
  return ISSUER[f.t] ?? f.n.replace(/ (ETF|Trust|Fund).*$/i, "");
}

function Funds({ c, coin, lang }: { c: EtfCoin; coin: Coin; lang: Lang }) {
  const [period, setPeriod] = useState<Period>("w");
  const aumAll = c.funds.reduce((s, f) => s + (f.aum || 0), 0);
  const rows = useMemo(() => {
    const days = c.days;
    const last = days[days.length - 1]?.[0] ?? 0;
    const from = period === "d" ? last : period === "w" ? last - 6 * 86400 : period === "m" ? last - 29 * 86400 : 0;
    const sum = c.funds.map(() => 0);
    if (period === "all") c.funds.forEach((f, i) => { sum[i] = f.cum / 1000; });
    else for (const d of days) if (d[0] >= from) d[4].forEach((v, i) => { sum[i]! += v ?? 0; });
    return c.funds.map((f, i) => ({ f, v: sum[i]! })).sort((x, y) => y.v - x.v);
  }, [c, period]);
  const moving = rows.filter((r) => Math.abs(r.v) >= 1);
  const still = rows.length - moving.length;
  const span = Math.max(1, ...moving.map((r) => Math.abs(r.v)));
  const ins = moving.filter((r) => r.v > 0).reduce((s, r) => s + r.v, 0);
  const outs = moving.filter((r) => r.v < 0).reduce((s, r) => s + r.v, 0);
  return (
    <Card>
      <Chips<Period>
        value={period}
        onChange={(p) => { haptic("select"); setPeriod(p); }}
        options={[
          { id: "d", label: t(lang, "ef_p_d") },
          { id: "w", label: t(lang, "ef_p_w") },
          { id: "m", label: t(lang, "ef_p_m") },
          { id: "all", label: t(lang, "ef_p_all") },
        ]}
      />
      <p className="ef-fsum">
        <span className="up">{t(lang, "ef_in")} <bdi dir="ltr">{money(ins * 1000)}</bdi></span>
        <span className="dn">{t(lang, "ef_out")} <bdi dir="ltr">{money(outs * 1000)}</bdi></span>
      </p>
      <div className="ef-funds">
        {moving.map(({ f, v }) => {
          const r = Math.sqrt(Math.abs(v) / span);
          const label = fundLabel(f);
          return (
            <div key={f.t} className="ef-f">
              <span className="ef-f-id">
                <b>{f.t}</b>
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
                  {typeof f.prem === "number" && Math.abs(f.prem) >= 0.01
                    ? ` · ${t(lang, f.prem > 0 ? "ef_prem" : "ef_disc", { v: iso(pct(Math.abs(f.prem), 2, false)) })}` : ""}
                </small>
              ) : null}
            </div>
          );
        })}
      </div>
      {still > 0 ? <p className="lq-hint">{t(lang, "ef_still", { n: iso(num(still)) })}</p> : null}
      <p className="lq-hint">{t(lang, coin === "btc" || coin === "eth" ? "ef_funds_note" : "ef_funds_note2")}</p>
    </Card>
  );
}

function Holders({ h, price, lang }: { h: EtfReply["holders"]; price: number; lang: Lang }) {
  const groups = h.groups ?? [];
  const total = groups.reduce((s, g) => s + g[2], 0);
  const movers = (h.movers ?? []).filter((m) => Math.abs(m[6]) >= 0.5);
  const typeName = (r: BtcHolder) => t(lang, GROUPS[r[1]]?.key ?? "ef_g_other");
  if (!groups.length) return null;
  return (
    <>
      <SectionTitle>{t(lang, "ef_h_title")}</SectionTitle>
      <Card>
        <p className="ef-h-lead">
          {t(lang, "ef_h_lead", { b: iso(num(total)), p: iso(pct((total / BTC_SUPPLY) * 100, 1, false)) })}
        </p>
        <div className="fg-dist ef-split" role="img" aria-label={t(lang, "ef_h_title")}>
          {groups.map((g) => (
            <i key={g[0]} style={{ width: `${(g[2] / total) * 100}%`, background: GROUPS[g[0]]?.c ?? "#64748b" }} />
          ))}
        </div>
        <div className="fg-rows">
          {groups.map((g) => (
            <div key={g[0]} className="fg-row two">
              <span><i style={{ background: GROUPS[g[0]]?.c ?? "#64748b" }} />{t(lang, GROUPS[g[0]]?.key ?? "ef_g_other")}
                <small className="ef-cnt"> · {num(g[1])}</small></span>
              <b><bdi dir="ltr">{num(g[2])} BTC</bdi>
                <small> · {pct((g[2] / BTC_SUPPLY) * 100, 2, false)}</small></b>
            </div>
          ))}
        </div>
        <p className="lq-hint">{t(lang, "ef_h_note")}</p>
      </Card>

      {movers.length ? (
        <>
          <SectionTitle>{t(lang, "ef_m_title")}</SectionTitle>
          <Card>
            <div className="ef-hl">
              {movers.map((m) => (
                <div key={m[0]} className="ef-hr">
                  <span className="ef-hr-id">
                    <b>{m[3] ? `${m[3]} ` : ""}{m[0]}</b>
                    <small>{typeName(m)}{m[4] ? ` · ${m[4]}` : ""}</small>
                  </span>
                  <span className="ef-hr-v">
                    <b className={m[6] > 0 ? "up" : "dn"}><bdi dir="ltr">{coins(m[6], "BTC")}</bdi></b>
                    {price > 0 ? <small><bdi dir="ltr">{money(m[6] * price)}</bdi></small> : null}
                  </span>
                </div>
              ))}
            </div>
            <p className="lq-hint">{t(lang, "ef_m_note")}</p>
          </Card>
        </>
      ) : null}

    </>
  );
}

/* ---------------------------------------------------------------------- */

export function EtfScreen() {
  const lang = useApp((s) => s.lang);
  const [reply, setReply] = useState<EtfReply | null>(() => peekEtf() ?? null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [coin, setCoin] = useState<Coin>(() => {
    try {
      const v = localStorage.getItem(COIN_KEY) as Coin | null;
      return v && COINS.includes(v) ? v : "btc";
    } catch {
      return "btc";
    }
  });
  const [range, setRange] = useState<Range>(() => {
    try {
      const v = localStorage.getItem(RANGE_KEY);
      return (["30", "90", "365", "all"].includes(v ?? "") ? v : "90") as Range;
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

  const have = COINS.filter((c) => reply?.coins?.[c]?.days?.length);
  const cur: Coin = have.includes(coin) ? coin : "btc";
  const c = reply?.coins?.[cur];
  const sym = SYM[cur];
  const days = c?.days ?? [];
  const last = days[days.length - 1];
  const lastPx = [...days].reverse().find((d) => d[3] > 0)?.[3] ?? 0;
  const btcPx = (() => {
    const b = reply?.coins?.btc?.days ?? [];
    return [...b].reverse().find((d) => d[3] > 0)?.[3] ?? 0;
  })();

  const stats = useMemo(() => {
    if (!c || !days.length) return null;
    const end = days[days.length - 1]![0];
    const win = (n: number) => days.filter((d) => d[0] > end - n * 86400);
    const sumU = (ds: typeof days) => ds.reduce((s, d) => s + d[1], 0) * 1000;
    const sumC = (ds: typeof days) => ds.reduce((s, d) => s + d[2], 0);
    const cum = c.funds.reduce((s, f) => s + f.cum, 0);
    let streak = 0;
    const sign = Math.sign(days[days.length - 1]![1]);
    for (let i = days.length - 1; i >= 0 && sign !== 0 && Math.sign(days[i]![1]) === sign; i--) streak++;
    let best = days[0]!;
    let worst = days[0]!;
    const runs = { up: { n: 0, at: 0 }, dn: { n: 0, at: 0 } };
    let run = 0;
    let runSign = 0;
    let runAt = 0;
    for (const d of days) {
      if (d[1] > best[1]) best = d;
      if (d[1] < worst[1]) worst = d;
      const s = Math.sign(d[1]);
      if (s !== 0 && s === runSign) run++;
      else {
        run = s === 0 ? 0 : 1;
        runSign = s;
        runAt = d[0];
      }
      if (runSign > 0 && run > runs.up.n) runs.up = { n: run, at: runAt };
      if (runSign < 0 && run > runs.dn.n) runs.dn = { n: run, at: runAt };
    }
    const m30 = win(30);
    const mined = m30.length ? Array.from({ length: 30 }, (_, i) => minedPerDay(end - i * 86400)).reduce((a, b) => a + b, 0) : 0;
    const aum = c.funds.reduce((s, f) => s + f.aum, 0);
    const cumc = c.funds.reduce((s, f) => s + f.cumc, 0);
    return {
      cumc,
      d7: sumU(win(7)), d30: sumU(m30), cum, streak, sign,
      c30: sumC(m30), mined, best, worst, runs, aum,
      held: aum > 0 && lastPx > 0 ? aum / lastPx : 0,
    };
  }, [c, days, lastPx]);

  const view = useMemo(() => {
    if (!c) return [];
    const src = range === "all" ? days : days.filter((d) => d[0] > (days[days.length - 1]?.[0] ?? 0) - Number(range) * 86400);
    return range === "30" || range === "90" ? daily(src) : weekly(src, c.funds.length);
  }, [c, days, range]);
  const selB = sel !== null ? view[sel] : undefined;
  /* Накоплено с запуска к концу каждого столбца: от всей истории, а не от
     начала выбранного окна — иначе на «90 дней» линия начиналась бы с нуля. */
  const cumView = useMemo(() => {
    const first = view[0]?.a ?? 0;
    let acc = days.filter((d) => d[0] < first).reduce((s, d) => s + d[1], 0);
    return view.map((b) => (acc += b.usd));
  }, [view, days]);

  const pickCoin = (v: Coin) => {
    setCoin(v);
    setSel(null);
    remember(COIN_KEY, v);
  };
  const pickRange = (r: Range) => {
    setRange(r);
    setSel(null);
    remember(RANGE_KEY, r);
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
        ) : <Card><Skeleton rows={8} /></Card>
      ) : !c || !last || !stats ? null : (
        <>
          <Segmented<Coin>
            value={cur}
            onChange={pickCoin}
            options={have.map((k) => ({ id: k, label: SYM[k] }))}
          />

          <Card>
            <div className="ef-hero">
              <small>{t(lang, "ef_last", { d: dayTxt(last[0]) })}</small>
              <b className={last[1] > 0 ? "up" : last[1] < 0 ? "dn" : ""}><bdi dir="ltr">{money(last[1] * 1000)}</bdi></b>
              <span>
                {t(lang, last[1] > 0 ? "ef_inflow" : last[1] < 0 ? "ef_outflow" : "ef_flat")}
                {last[2] ? <> · <bdi dir="ltr">{coins(last[2], sym)}</bdi></> : null}
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
            ) : stats.cumc > 0 && lastPx > 0 ? (
              /* У новых фондов (SOL, XRP, HYPE) активов в данных нет, но и
                 старых запасов, как у GBTC, нет: накопленные с запуска монеты
                 и есть то, что у них лежит. */
              <p className="ef-held">
                {t(lang, "ef_held2", {
                  c: iso(`${coinsRound(lang, stats.cumc)} ${sym}`), a: iso(usdWord(stats.cumc * lastPx)),
                })}
              </p>
            ) : null}
          </Card>

          {cur === "btc" && stats.mined > 0 ? (
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
              options={[
                { id: "30", label: t(lang, "fg_r30") },
                { id: "90", label: t(lang, "fg_r90") },
                { id: "365", label: t(lang, "fg_r1y") },
                { id: "all", label: t(lang, "fg_rall") },
              ]}
            />
            <div className="fg-plot">
              <FlowChart data={view} cum={mode === "c" ? cumView : null} zero={range === "all"} lang={lang} sel={sel} onSel={setSel} />
              {selB ? (() => {
                const tops = c.funds.map((f, i) => ({ t: f.t, v: selB.per[i] ?? 0 }))
                  .filter((x) => Math.abs(x.v) >= 1).sort((x, y) => Math.abs(y.v) - Math.abs(x.v)).slice(0, 3);
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
                : t(lang, range === "30" || range === "90" ? "ef_chart_d" : "ef_chart_w")} {t(lang, "fg_hint")}
            </p>
          </Card>

          <SectionTitle>{t(lang, "ef_f_title")}</SectionTitle>
          <Funds c={c} coin={cur} lang={lang} />

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
              {c.best ? (
                <div className="fg-row two">
                  <span>{t(lang, "ef_r_bestm")}<small> · {dateStr(lang, c.best[0], { month: "long", year: "numeric" })}</small></span>
                  <b className={c.best[1] >= 0 ? "up" : "dn"}><bdi dir="ltr">{money(c.best[1])}</bdi></b>
                </div>
              ) : null}
              {c.worst ? (
                <div className="fg-row two">
                  <span>{t(lang, "ef_r_worstm")}<small> · {dateStr(lang, c.worst[0], { month: "long", year: "numeric" })}</small></span>
                  <b className={c.worst[1] >= 0 ? "up" : "dn"}><bdi dir="ltr">{money(c.worst[1])}</bdi></b>
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
            <p className="lq-hint">{t(lang, "ef_r_note", { d: dateStr(lang, days[0]![0], { day: "numeric", month: "long", year: "numeric" }) })}</p>
          </Card>

          {reply.cme?.[cur]?.length ? <CmeSection rows={reply.cme[cur]!} sym={sym} price={lastPx} lang={lang} /> : null}
          {reply.cbp?.[cur]?.days?.length ? <CbpSection d={reply.cbp[cur]!} sym={sym} lang={lang} /> : null}
          {cur === "btc" ? (
            <>
              <Holders h={reply.holders ?? {}} price={btcPx} lang={lang} />
              <HoldersAll h={reply.holders ?? {}} price={btcPx} lang={lang} />
            </>
          ) : null}
          {reply.holders?.alts?.[cur]?.length
            ? <AltHolders list={reply.holders.alts[cur]!} sym={sym} price={lastPx} lang={lang} />
            : cur === "eth" && reply.holders?.eth?.length
              ? <AltHolders list={reply.holders.eth} sym={sym} price={lastPx} lang={lang} /> : null}

          <details className="lq-how">
            <summary>{t(lang, "fg_how")}</summary>
            <ul>
              <li>{t(lang, "ef_how_1")}</li>
              <li>{t(lang, "ef_how_2")}</li>
              <li>{t(lang, "ef_how_3")}</li>
              <li>{t(lang, "ef_how_4")}</li>
              <li>{t(lang, "ef_how_5")}</li>
              <li>{t(lang, "ef_how_6")}</li>
            </ul>
          </details>
          <p className="lq-src">{t(lang, "ef_src")} {t(lang, "ef_upd", { t: stamp(lang, reply.at) })}</p>
        </>
      )}
    </Frame>
  );
}

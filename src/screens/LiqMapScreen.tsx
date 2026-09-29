/**
 * Карта ликвидаций: где по цене лежат ликвидации открытых позиций.
 *
 * Это оценка сервера (whale_api.liq_map): за свечу открытый интерес вырос —
 * на её цене открылись позиции, объём разложен по плечам 10×/25×/50×/100×, у
 * каждого своя цена ликвидации; то, что цена уже прошла, снято. Настоящих цен
 * ликвидации биржи не публикуют, и экран так и говорит.
 *
 * Экран отвечает на три вопроса по порядку. Сначала — главное словами и
 * цифрами: где ближайшее крупное скопление сверху и снизу и на какой стороне
 * ликвидаций больше. Потом — сама карта. Потом — итоги и крупнейшие уровни,
 * которые по касанию показываются на карте.
 *
 * Цена идёт по вертикали — телефон держат стоя, и уровни читаются сверху
 * вниз, как стакан: шорты над текущей ценой, лонги под ней. Сторону говорит
 * место, подпись и лёгкая заливка зоны: зелёная сверху, красная снизу.
 *
 * Цвет полосы — плечо, у каждого свой оттенок (палитра проверена на тёмном
 * фоне и при дальтонизме). Насыщенность — размер: мелкие уровни приглушены,
 * средние в полный цвет, крупные скопления (от половины самого большого) —
 * в ярком варианте того же оттенка и с подсветкой. Глаз сразу находит их.
 *
 * Слева от уровней — свечи цены за то же окно на той же ценовой оси: видно,
 * откуда цена пришла и где открывались позиции, чьи ликвидации справа. Это
 * две панели с общей осью цены, а не две оси на одном поле.
 *
 * Накопленное «до этой цены» — другой масштаб. Второй осью поверх полос оно
 * превратило бы карту в ребус, поэтому у него своя узкая колонка справа с той
 * же ценовой осью.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp, type LiqRange } from "../store/app";
import { t } from "../i18n/t";
import { num, pct, px, since, usd } from "../lib/format";
import { haptic } from "../lib/telegram";
import { fetchLiqCoins, fetchLiqMap, peekLiqCoins, peekLiqMap } from "../lib/api";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Chips, Empty, SectionTitle, Segmented, Skeleton } from "../components/ui";
import type { LiqCoin, LiqMapReply } from "../lib/types";
import { Frame } from "./Screen";

type Lang = Parameters<typeof t>[0];

/** Плечи 10× / 25× / 50× / 100×: голубой, фиолетовый, янтарный, розовый. */
const LEV_C = ["#1a9fc9", "#8f6cf0", "#c98500", "#e8589c"];
/** Тот же оттенок ярче — для крупных скоплений. */
const LEV_HOT = ["#46d2ff", "#b89cff", "#ffb31f", "#ff7fc0"];
/** Доля от самого большого уровня, с которой скопление считается крупным. */
const HOT = 0.5;
const COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE", "SUI", "ADA", "LINK"];
type Span = "5" | "10" | "15";
const SPANS: Span[] = ["5", "10", "15"];
const TICK: Record<Span, number> = { "5": 1, "10": 2, "15": 3 };

const W = 360;
const AXIS = 58;
const CUMW = 38;
const GAP = 5;
const PLOT = W - AXIS - CUMW - GAP * 2;
/** Панель свечей слева, полосы уровней — от BX0 до PLOT. */
const CAND = 96;
const BX0 = CAND + GAP;
const BW = PLOT - BX0;
const CX0 = PLOT + GAP;
const CX1 = CX0 + CUMW;

const SUB = "₀₁₂₃₄₅₆₇₈₉";
/**
 * Цена для оси: «$0,00000441» не влезает в шестьдесят точек и наезжает на
 * соседнюю колонку. Нули после запятой сворачиваются в индекс — «$0,0₅441»,
 * как пишут на биржах; значащих цифр остаётся четыре.
 */
function pxAxis(v: number): string {
  /* От тысячи копейки на оси не нужны: «$4 159,59» не влезал в ярлык цены. */
  const s = px(Math.abs(v) >= 1000 ? Math.round(v) : v);
  const m = s.match(/^(-?\$0[.,])(0{3,})(\d+)/);
  if (!m) return s;
  const z = String(m[2]!.length).split("").map((d) => SUB[Number(d)]).join("");
  return `${m[1]}0${z}${m[3]!.slice(0, 4)}`;
}

interface ViewRow {
  lo: number;
  hi: number;
  mid: number;
  L: number[];
  S: number[];
}

/** Корзины сервера (по 0,25%) — в строки экрана: не больше шестидесяти. */
function rowsOf(r: LiqMapReply, span: number): { rows: ViewRow[]; rowH: number } {
  const lo = r.px * (1 - span / 100);
  const hi = r.px * (1 + span / 100);
  const base = Math.max(1, Math.round(((hi - lo) / r.step) / 60));
  const size = r.step * base;
  const n = Math.max(1, Math.ceil((hi - lo) / size));
  const rows: ViewRow[] = Array.from({ length: n }, (_, i) => ({
    lo: lo + i * size,
    hi: lo + (i + 1) * size,
    mid: lo + (i + 0.5) * size,
    L: [0, 0, 0, 0],
    S: [0, 0, 0, 0],
  }));
  for (const b of r.buckets) {
    const i = Math.floor((b.p - lo) / size);
    const row = rows[i];
    if (!row) continue;
    for (let j = 0; j < 4; j++) {
      row.L[j] = (row.L[j] ?? 0) + (b.L[j] ?? 0);
      row.S[j] = (row.S[j] ?? 0) + (b.S[j] ?? 0);
    }
  }
  const rowH = Math.max(7, Math.min(14, 520 / n));
  return { rows: rows.reverse(), rowH };
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const sumOn = (a: number[], on: boolean[]) => a.reduce((x, y, j) => x + (on[j] ? y : 0), 0);
const side = (w: ViewRow, p: number) => (w.mid > p ? w.S : w.L);

/** Накопленное от цены до каждой строки — на её стороне. */
function cumOf(rows: ViewRow[], p: number, on: boolean[]): number[] {
  const out = rows.map(() => 0);
  let acc = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const w = rows[i];
    if (w && w.mid > p) {
      acc += sumOn(w.S, on);
      out[i] = acc;
    }
  }
  acc = 0;
  for (let i = 0; i < rows.length; i++) {
    const w = rows[i];
    if (w && w.mid < p) {
      acc += sumOn(w.L, on);
      out[i] = acc;
    }
  }
  return out;
}

/** Строка экрана, в которую попадает цена, — для касания по списку. */
function rowAt(r: LiqMapReply, span: number, price: number): number {
  return rowsOf(r, span).rows.findIndex((w) => price >= w.lo && price < w.hi);
}

interface Cluster {
  p: number;
  v: number;
  d: number;
}

/**
 * Ближайшее крупное скопление на стороне: корзины по 0,5% в пределах ±10%,
 * «крупное» — не меньше половины самого большого на этой стороне. Самое
 * большое часто далеко, а до ближайшего крупного цена доходит первой.
 */
function nearest(r: LiqMapReply, up: boolean): Cluster | null {
  const groups = new Map<number, { v: number; pv: number }>();
  for (const b of r.buckets) {
    const d = (b.p - r.px) / r.px;
    if (up ? d <= 0 || d > 0.1 : d >= 0 || d < -0.1) continue;
    const v = sum(up ? b.S : b.L);
    if (v <= 0) continue;
    const k = Math.floor(Math.abs(d) / 0.005);
    const g = groups.get(k) ?? { v: 0, pv: 0 };
    g.v += v;
    g.pv += v * b.p;
    groups.set(k, g);
  }
  const list = [...groups.entries()].map(([k, g]) => ({ k, p: g.pv / g.v, v: g.v }));
  const max = Math.max(0, ...list.map((g) => g.v));
  if (max <= 0) return null;
  const hit = list.filter((g) => g.v >= max * 0.5).sort((a, b) => a.k - b.k)[0];
  return hit ? { p: hit.p, v: hit.v, d: ((hit.p - r.px) / r.px) * 100 } : null;
}

function Spark({ path, up }: { path: number[]; up: boolean }) {
  if (path.length < 2) return null;
  const lo = Math.min(...path);
  const hi = Math.max(...path);
  const h = 34;
  const w = 300;
  const y = (v: number) => (hi === lo ? h / 2 : 3 + ((hi - v) / (hi - lo)) * (h - 6));
  const pts = path.map((v, i) => `${((i / (path.length - 1)) * (w - 4)).toFixed(1)},${y(v).toFixed(1)}`);
  const last = path[path.length - 1] ?? lo;
  return (
    <svg className={`lq-spark ${up ? "up" : "dn"}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,${h} ${pts.join(" ")} ${w - 4},${h}`} className="lq-spark-a" />
      <polyline points={pts.join(" ")} className="lq-spark-l" vectorEffect="non-scaling-stroke" />
      <circle cx={w - 4} cy={y(last)} r={3} className="lq-spark-d" />
    </svg>
  );
}

/**
 * Свечи окна на той же оси цены, что и уровни. Что выходит за окно карты,
 * обрезается по краю — цена за месяц бывает дальше ±5%.
 */
function Candles({ r, yOf, H }: { r: LiqMapReply; yOf: (p: number) => number; H: number }) {
  const list = r.ohlc ?? [];
  if (list.length < 2) return null;
  const cw = (CAND - 6) / list.length;
  const bw = Math.max(1, cw * 0.64);
  const cy = (p: number) => Math.max(0, Math.min(H, yOf(p)));
  return (
    <g className="lq-candles">
      <clipPath id="lq-cclip"><rect x={0} y={0} width={CAND} height={H} /></clipPath>
      <g clipPath="url(#lq-cclip)">
        {list.map(([o, h, l, c], i) => {
          const x = 2 + i * cw + cw / 2;
          const up = c >= o;
          const y1 = cy(Math.max(o, c));
          const y2 = cy(Math.min(o, c));
          return (
            <g key={i} className={up ? "up" : "dn"}>
              <line x1={x} x2={x} y1={cy(h)} y2={cy(l)} />
              <rect x={x - bw / 2} y={y1} width={bw} height={Math.max(0.8, y2 - y1)} />
            </g>
          );
        })}
      </g>
      <circle cx={2 + (list.length - 0.5) * cw} cy={yOf(r.px)} r={2.6} className="lq-cp-now" />
    </g>
  );
}

function Chart({ r, lang, span, sel, onSel, on, win }: {
  r: LiqMapReply;
  lang: Lang;
  span: Span;
  sel: number | null;
  onSel: (i: number | null) => void;
  on: boolean[];
  win: string;
}) {
  const spanN = Number(span);
  const { rows, rowH } = useMemo(() => rowsOf(r, spanN), [r, spanN]);
  const H = rows.length * rowH;
  /* Самая длинная полоса короче поля на подпись: сумма всегда стоит снаружи. */
  const top = Math.max(1, ...rows.map((w) => sumOn(side(w, r.px), on)));
  const max = top * (BW / (BW - 42));
  const cum = useMemo(() => cumOf(rows, r.px, on), [rows, r.px, on]);
  const cmax = Math.max(1, ...cum);
  const yOf = (price: number) => ((r.px * (1 + spanN / 100) - price) / (r.px * spanN * 2 / 100)) * H;
  const yNow = yOf(r.px);
  const step = TICK[span];
  const ticks: number[] = [];
  /* Крайние риски не подписываем: у края подпись наползала на соседнюю. */
  for (let p = -spanN + step; p < spanN - 1e-9; p += step) if (Math.abs(p) > 1e-9) ticks.push(p);

  /* Подписи — у двух крупнейших строк каждой стороны, не у всех. */
  const labelled = useMemo(() => {
    const idx = rows.map((w, i) => ({ i, up: w.mid > r.px, v: sumOn(side(w, r.px), on) })).filter((x) => x.v > 0);
    const pick = (up: boolean) => idx.filter((x) => x.up === up).sort((a, b) => b.v - a.v).slice(0, 2).map((x) => x.i);
    return [...pick(true), ...pick(false)];
  }, [rows, r.px, on]);

  /* Площадь «накоплено»: от линии цены наружу, по серединам строк. */
  const area = (up: boolean) => {
    const pts: string[] = [`${CX0},${yNow}`];
    const order = up ? [...rows.keys()].reverse() : [...rows.keys()];
    for (const i of order) {
      const w = rows[i];
      if (!w || (up ? w.mid < r.px : w.mid > r.px)) continue;
      pts.push(`${(CX0 + ((cum[i] ?? 0) / cmax) * CUMW).toFixed(1)},${(i * rowH + rowH / 2).toFixed(1)}`);
    }
    pts.push(`${CX0},${up ? 0 : H}`);
    return pts.join(" ");
  };

  const pick = (clientY: number, el: SVGSVGElement) => {
    const box = el.getBoundingClientRect();
    const y = ((clientY - box.top) / box.height) * H;
    const i = Math.max(0, Math.min(rows.length - 1, Math.floor(y / rowH)));
    haptic("select");
    onSel(i === sel ? null : i);
  };

  const selRow = sel !== null ? rows[sel] : undefined;
  const selY = sel !== null ? sel * rowH + rowH / 2 : 0;

  return (
    <svg
      className="lq-svg"
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={t(lang, "lq_title")}
      onPointerDown={(e) => pick(e.clientY, e.currentTarget)}
    >
      <rect x={BX0} y={0} width={CX1 - BX0} height={yNow} className="lq-zone up" />
      <rect x={BX0} y={yNow} width={CX1 - BX0} height={H - yNow} className="lq-zone dn" />
      <rect x={0} y={0} width={CAND} height={H} className="lq-cpanel" />
      <line x1={BX0 - GAP / 2} x2={BX0 - GAP / 2} y1={0} y2={H} className="lq-sep" />
      <line x1={CX0 - GAP / 2} x2={CX0 - GAP / 2} y1={0} y2={H} className="lq-sep" />

      {ticks.map((p) => {
        const y = yOf(r.px * (1 + p / 100));
        return (
          <g key={p}>
            <line x1={0} x2={CX1} y1={y} y2={y} className="lq-grid" />
            <text x={W - 2} y={Math.max(9, y - 1)} className="lq-tick" textAnchor="end">{pxAxis(r.px * (1 + p / 100))}</text>
            <text x={W - 2} y={Math.min(H - 2, y + 10)} className={`lq-tick-p ${p > 0 ? "up" : "dn"}`} textAnchor="end">
              {p > 0 ? "+" : "−"}{Math.abs(p)}%
            </text>
          </g>
        );
      })}

      {sel !== null ? <rect x={0} y={sel * rowH} width={CX1} height={rowH} className="lq-hl" /> : null}

      <Candles r={r} yOf={yOf} H={H} />
      <text x={4} y={11} className="lq-cp-t">{t(lang, "lq_price_w", { w: win })}</text>

      <defs>
        <filter id="lq-glow" x="-10%" y="-150%" width="120%" height="400%">
          <feGaussianBlur stdDeviation="2.4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g key={`${r.sym}-${r.range}-${span}`} className="lq-bars">
        {rows.map((w, i) => {
          const parts = side(w, r.px);
          const k = sumOn(parts, on) / top;
          const hot = k >= HOT;
          const pal = hot ? LEV_HOT : LEV_C;
          /* Мелкое — бледнее, крупное — насыщеннее. */
          const alpha = hot ? 1 : 0.3 + 0.62 * Math.pow(k / HOT, 0.8);
          const y = i * rowH + 0.75;
          const h = Math.max(2, rowH - 1.5);
          let x = BX0;
          return (
            <g key={i} fillOpacity={alpha} filter={hot ? "url(#lq-glow)" : undefined}
              className={sel !== null && sel !== i ? "lq-row dim" : "lq-row"}>
              {parts.map((v, j) => {
                if (v <= 0 || !on[j]) return null;
                const wdt = (v / max) * BW;
                const el = (
                  <rect key={j} x={x} y={y} width={Math.max(1, wdt - (wdt > 3 ? 1.2 : 0))} height={h}
                    rx={Math.min(1.5, h / 2)} fill={pal[j]} />
                );
                x += wdt;
                return el;
              })}
            </g>
          );
        })}
      </g>

      {labelled.map((i) => {
        const w = rows[i];
        if (!w) return null;
        const v = sumOn(side(w, r.px), on);
        const end = BX0 + (v / max) * BW;
        return (
          <text key={`l${i}`} x={end + 4} y={i * rowH + rowH / 2 + 3.5} className="lq-val">
            {usd(v)}
          </text>
        );
      })}

      <polygon points={area(true)} className="lq-cum-a up" />
      <polygon points={area(false)} className="lq-cum-a dn" />

      <line x1={0} x2={W - AXIS} y1={yNow} y2={yNow} className="lq-now" />
      <rect x={W - AXIS + 1} y={yNow - 11} width={AXIS - 1} height={22} rx={6} className="lq-now-box" />
      <text x={W - AXIS / 2 + 0.5} y={yNow + 4} textAnchor="middle" className="lq-now-t">{pxAxis(r.px)}</text>

      {selRow ? (
        <g className="lq-cross">
          <line x1={0} x2={W - AXIS} y1={selY} y2={selY} />
          <circle cx={CX0 + ((cum[sel ?? 0] ?? 0) / cmax) * CUMW} cy={selY} r={3.5} />
          <rect x={W - AXIS + 1} y={selY - 11} width={AXIS - 1} height={22} rx={6} />
          <text x={W - AXIS / 2 + 0.5} y={selY + 4} textAnchor="middle">{pxAxis(selRow.mid)}</text>
        </g>
      ) : null}
    </svg>
  );
}

/** Сколько строк списка монет рисовать за раз: значки грузятся картинками. */
const PAGE = 60;

/**
 * Выбор монеты: популярные — чипами, остальные — поиском и полным списком.
 * Список — все бессрочные фьючерсы к USDT на Binance, OKX и Gate, по
 * обороту за сутки; пока он грузится, есть десяток крупных монет.
 */
function CoinPicker({ lang, sym, onPick }: { lang: Lang; sym: string; onPick: (s: string) => void }) {
  const [list, setList] = useState<LiqCoin[]>(() => peekLiqCoins()?.coins ?? []);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    let alive = true;
    void fetchLiqCoins().then((r) => {
      if (alive && r?.ok && r.coins.length) setList(r.coins);
    });
    return () => {
      alive = false;
    };
  }, []);

  const chips = list.length ? list.slice(0, 12).map((c) => c.s) : COINS;
  const q = query.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const found = useMemo(() => {
    if (!q) return list;
    const head = list.filter((c) => c.s.startsWith(q));
    const rest = list.filter((c) => !c.s.startsWith(q) && c.s.includes(q));
    return [...head, ...rest];
  }, [list, q]);
  const showList = open || q.length > 0;

  const pick = (s: string) => {
    haptic("select");
    onPick(s);
    setQuery("");
    setOpen(false);
    setShown(PAGE);
  };

  return (
    <div className="lq-pick">
      <Chips
        value={sym}
        options={[...(chips.includes(sym) ? [] : [{ id: sym, label: sym }]), ...chips.map((c) => ({ id: c, label: c }))]}
        onChange={(c) => c && pick(c)}
      />
      <form
        className="lq-find"
        onSubmit={(e) => {
          e.preventDefault();
          const first = found[0];
          if (first) pick(first.s);
          else if (q) pick(q);
        }}
      >
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }}
          placeholder={t(lang, "lq_search")}
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={12}
          enterKeyHint="search"
        />
        <button
          type="button"
          className={open ? "on" : ""}
          aria-expanded={showList}
          onClick={() => { haptic("select"); setOpen(!showList); setQuery(""); setShown(PAGE); }}
        >
          {showList ? t(lang, "lq_hide_all") : t(lang, "lq_all", { n: list.length || "…" })}
        </button>
      </form>
      {showList ? (
        <div className="lq-list" role="listbox">
          {found.length ? (
            <>
              {found.slice(0, shown).map((c, i) => (
                <button key={c.s} type="button" role="option" aria-selected={c.s === sym}
                  className={c.s === sym ? "lq-li on" : "lq-li"} onClick={() => pick(c.s)}>
                  <span className="lq-li-n">{list.indexOf(c) + 1 || i + 1}</span>
                  <CoinIcon sym={c.s} size={24} />
                  <b>{c.s}</b>
                  <small>{c.ex.join(" · ")}</small>
                  <em>{usd(c.v)}</em>
                </button>
              ))}
              {found.length > shown ? (
                <button type="button" className="lq-more" onClick={() => setShown(shown + PAGE)}>
                  {t(lang, "lq_more", { n: found.length - shown })}
                </button>
              ) : null}
            </>
          ) : (
            <p className="lq-none">
              {t(lang, "lq_nothing")}{" "}
              {q ? <button type="button" onClick={() => pick(q)}>{t(lang, "lq_try", { s: q })}</button> : null}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function LiqMapScreen() {
  const lang = useApp((s) => s.lang);
  const saved = useApp((s) => s.liqSym);
  const savedRange = useApp((s) => s.liqRange);
  const setLiq = useApp((s) => s.setLiq);
  const open = useApp((s) => s.open);
  const [sym, setSym] = useState(saved || "BTC");
  const [range, setRange] = useState<LiqRange>(savedRange || "1d");
  const [span, setSpan] = useState<Span>("10");
  const [sel, setSel] = useState<number | null>(null);
  const [on, setOn] = useState<boolean[]>([true, true, true, true]);
  const [reply, setReply] = useState<LiqMapReply | null>(() => peekLiqMap(sym, range) ?? null);
  const [busy, setBusy] = useState(false);
  const plotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setSel(null);
    const cached = peekLiqMap(sym, range);
    setReply(cached ?? null);
    setBusy(!cached);
    void fetchLiqMap(sym, range).then((r) => {
      if (!alive) return;
      setBusy(false);
      setReply(r ?? { ok: false, error: "net" } as LiqMapReply);
    });
    setLiq(sym, range);
    return () => {
      alive = false;
    };
  }, [sym, range, setLiq]);

  /* Окно карты подбирается под ход цены: свечи должны занимать высоту, а
     не жаться полоской у линии цены. Раз на монету и период — дальше решает
     человек. */
  const autoKey = useRef("");
  useEffect(() => {
    if (!reply?.ok) return;
    const key = `${reply.sym}-${reply.range}`;
    if (autoKey.current === key) return;
    autoKey.current = key;
    const d = Math.max(0, ...(reply.ohlc ?? []).flatMap(([, h, l]) => [h, l]).map((p) => Math.abs(p / reply.px - 1) * 100));
    setSpan(SPANS.find((s) => d < Number(s) * 0.92) ?? "15");
    setSel(null);
  }, [reply]);

  const spanN = Number(span);
  const view = useMemo(() => (reply?.ok ? rowsOf(reply, spanN) : { rows: [], rowH: 1 }), [reply, spanN]);
  const row = sel !== null ? view.rows[sel] : undefined;
  const cum = useMemo(() => (reply?.ok ? cumOf(view.rows, reply.px, on) : []), [reply, view, on]);

  const near = useMemo(() => (reply?.ok ? { up: nearest(reply, true), dn: nearest(reply, false) } : null), [reply]);

  const top = useMemo(() => {
    if (!reply?.ok) return { up: [], dn: [] };
    const all = reply.buckets.map((b) => ({ p: b.p, up: b.p > reply.px, v: b.p > reply.px ? sum(b.S) : sum(b.L) }))
      .filter((b) => b.v > 0)
      .sort((a, b) => b.v - a.v);
    return { up: all.filter((b) => b.up).slice(0, 3), dn: all.filter((b) => !b.up).slice(0, 3) };
  }, [reply]);
  const topMax = Math.max(1, ...top.up.map((b) => b.v), ...top.dn.map((b) => b.v));


  /** Показать цену на карте: если она за краем, окно расширяется. */
  const focus = (p: number) => {
    if (!reply?.ok) return;
    const d = Math.abs((p - reply.px) / reply.px) * 100;
    const fit = d < spanN ? span : SPANS.find((s) => d < Number(s)) ?? "15";
    const i = rowAt(reply, Number(fit), p);
    haptic("select");
    setSpan(fit);
    setSel(i >= 0 ? i : null);
    plotRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const toggle = (j: number) => {
    const next = on.map((v, k) => (k === j ? !v : v));
    if (!next.some(Boolean)) return;
    haptic("select");
    setOn(next);
  };

  const levs = reply?.levs ?? [10, 25, 50, 100];
  const winLabel = t(lang, range === "1d" ? "big_win_24h" : range === "7d" ? "big_win_7d" : "big_win_30d");

  let hero = null;
  if (reply?.ok) {
    const path = reply.path ?? [];
    const first = path[0];
    const chg = first ? ((reply.px - first) / first) * 100 : null;
    const bal = reply.cum["5"] ?? { L: 0, S: 0 };
    const tot = bal.L + bal.S;
    const ratio = bal.S > 0 && bal.L > 0 ? Math.max(bal.S / bal.L, bal.L / bal.S) : 0;
    const bias = !tot ? null
      : bal.L === 0 ? "lq_bias_up_only" : bal.S === 0 ? "lq_bias_dn_only"
      : ratio < 1.2 ? "lq_bias_eq" : bal.S > bal.L ? "lq_bias_up" : "lq_bias_dn";
    hero = (
      <Card>
        <div className="lq-hero">
          <CoinIcon sym={reply.sym} size={34} />
          <div className="lq-hero-n">
            <b>{reply.sym}</b>
            {reply.oi ? <small>{t(lang, "lq_oi")} {usd(reply.oi)}</small> : null}
          </div>
          <div className="lq-hero-p">
            <b>{px(reply.px)}</b>
            {chg !== null ? (
              <small className={chg >= 0 ? "up" : "dn"}>{pct(chg, 2, true)} · {winLabel}</small>
            ) : null}
          </div>
          {busy ? <span className="lq-busy" aria-hidden="true" /> : null}
        </div>
        {path.length > 1 ? <Spark path={path} up={(chg ?? 0) >= 0} /> : null}

        <div className="lq-mag">
          {([["up", near?.up], ["dn", near?.dn]] as const).map(([k, c]) => (
            <button
              key={k}
              type="button"
              className={`lq-mag-c ${k}`}
              disabled={!c}
              onClick={() => c && focus(c.p)}
            >
              <small>{k === "up" ? "▲" : "▼"} {t(lang, k === "up" ? "lq_near_up" : "lq_near_dn")}</small>
              {c ? (
                <>
                  <b>{px(c.p)}</b>
                  <span><em>{pct(c.d, 1, true)}</em> · {usd(c.v)}</span>
                </>
              ) : (
                <span>{t(lang, "lq_none")}</span>
              )}
            </button>
          ))}
        </div>

        {tot > 0 ? (
          <div className="lq-bal">
            <p className="lq-bal-t">
              {bias ? t(lang, bias, { x: num(ratio, 1) }) : null}
              <small>{t(lang, "lq_bal")}</small>
            </p>
            <div className="lq-bal-bar" role="img"
              aria-label={`${t(lang, "lq_longs")} ${usd(bal.L)}, ${t(lang, "lq_shorts")} ${usd(bal.S)}`}>
              <i className="dn" style={{ width: `${(bal.L / tot) * 100}%` }} />
              <i className="up" style={{ width: `${(bal.S / tot) * 100}%` }} />
            </div>
            <div className="lq-bal-k">
              <span className="dn">▼ {t(lang, "lq_longs")} <b>{usd(bal.L)}</b></span>
              <span className="up"><b>{usd(bal.S)}</b> {t(lang, "lq_shorts")} ▲</span>
            </div>
          </div>
        ) : null}
      </Card>
    );
  }

  const cumMax = reply?.ok
    ? Math.max(1, ...["2", "5", "10"].map((k) => Math.max(reply.cum[k]?.L ?? 0, reply.cum[k]?.S ?? 0)))
    : 1;
  const rowUp = row && reply?.ok ? row.mid > reply.px : false;
  const tipBelow = sel !== null && view.rows.length ? (sel + 0.5) / view.rows.length < 0.34 : false;

  return (
    <Frame title={t(lang, "lq_title")}>
      <p className="lq-lead">{t(lang, "lq_sub")}</p>

      <CoinPicker lang={lang} sym={sym} onPick={setSym} />
      <div className="lq-ctl">
        <Segmented<LiqRange>
          value={range}
          onChange={setRange}
          options={[
            { id: "1d", label: t(lang, "big_win_24h") },
            { id: "7d", label: t(lang, "big_win_7d") },
            { id: "30d", label: t(lang, "big_win_30d") },
          ]}
        />
      </div>

      {!reply ? (
        <Card><Skeleton rows={10} /></Card>
      ) : !reply.ok ? (
        <Empty
          text={reply.error === "no_data" ? t(lang, "lq_no_data", { s: sym }) : t(lang, "lq_err")}
        />
      ) : (
        <>
          {hero}

          <Card>
            <Segmented<Span>
              value={span}
              onChange={(v) => { setSpan(v); setSel(null); }}
              options={SPANS.map((s) => ({ id: s, label: `±${s}%` }))}
            />
            <div className="lq-zone-h up">
              <span style={{ maxWidth: `calc(${(CX0 / W) * 100}% - 12px)` }}>▲ {t(lang, "lq_zone_up")}</span>
              <small style={{ right: `${(AXIS / W) * 100}%` }}>
                {t(lang, "lq_cum_axis")}
              </small>
            </div>
            <div className="lq-plot" ref={plotRef}>
              <Chart r={reply} lang={lang} span={span} sel={sel} onSel={setSel} on={on} win={winLabel} />
              {row ? (
                <div
                  className={`lq-pop ${rowUp ? "up" : "dn"}${tipBelow ? " below" : ""}`}
                  style={{ top: `${(((sel ?? 0) + 0.5) / view.rows.length) * 100}%` }}
                  aria-live="polite"
                >
                  <div className="lq-pop-h">
                    <b>{px(row.mid)}</b>
                    <span>{pct(((row.mid - reply.px) / reply.px) * 100, 2, true)}</span>
                    <button type="button" aria-label="×" onClick={() => setSel(null)}>×</button>
                  </div>
                  <em>{rowUp ? "▲" : "▼"} {t(lang, rowUp ? "lq_shorts" : "lq_longs")}</em>
                  <div className="lq-pop-levs">
                    {side(row, reply.px).map((v, j) => (
                      <span key={j} className={on[j] ? "" : "off"}>
                        <i style={{ background: LEV_C[j] }} />
                        {levs[j]}× <b>{v > 0 ? usd(v) : "—"}</b>
                      </span>
                    ))}
                  </div>
                  <p>{t(lang, "lq_at_level")} <b>{usd(sumOn(side(row, reply.px), on))}</b></p>
                  <p>{t(lang, "lq_tip_cum")} <b>{usd(cum[sel ?? 0] ?? 0)}</b></p>
                </div>
              ) : null}
            </div>
            <div className="lq-zone-h dn"><span>▼ {t(lang, "lq_zone_dn")}</span></div>

            <div className="lq-legend">
              <span className="lq-legend-t">{t(lang, "lq_lev")}</span>
              {levs.map((l, j) => (
                <button key={l} type="button" aria-pressed={on[j]} className={on[j] ? "lq-lev" : "lq-lev off"}
                  onClick={() => toggle(j)}>
                  <i style={{ background: LEV_C[j] }} />
                  {l}×
                </button>
              ))}
            </div>
            <p className="lq-hint">
              <span className="lq-hot-k" aria-hidden="true"><i /><i /><i /></span>
              {t(lang, "lq_hot")} {row ? t(lang, "lq_lev_tap") : t(lang, "lq_hint")}
            </p>
          </Card>

          <SectionTitle>{t(lang, "lq_cum_title")}</SectionTitle>
          <Card>
            <div className="lq-div-h">
              <span className="dn">▼ {t(lang, "lq_longs")}</span>
              <span className="up">{t(lang, "lq_shorts")} ▲</span>
            </div>
            {["2", "5", "10"].map((k) => {
              const c = reply.cum[k] ?? { L: 0, S: 0 };
              return (
                <div key={k} className="lq-div">
                  <span className="lq-div-v">{usd(c.L)}</span>
                  <div className="lq-div-b l"><i style={{ width: `${(c.L / cumMax) * 100}%` }} /></div>
                  <b>±{k}%</b>
                  <div className="lq-div-b r"><i style={{ width: `${(c.S / cumMax) * 100}%` }} /></div>
                  <span className="lq-div-v">{usd(c.S)}</span>
                </div>
              );
            })}
          </Card>

          {top.up.length || top.dn.length ? (
            <>
              <SectionTitle>{t(lang, "lq_top")}</SectionTitle>
              <div className="lq-top">
                {([["up", top.up], ["dn", top.dn]] as const).map(([k, list]) => (
                  <div key={k} className={`lq-top-c ${k}`}>
                    <small>{k === "up" ? "▲" : "▼"} {t(lang, k === "up" ? "lq_top_up" : "lq_top_dn")}</small>
                    {list.map((b) => (
                      <button key={b.p} type="button" onClick={() => focus(b.p)}>
                        <span className="lq-top-r">
                          <b>{px(b.p)}</b>
                          <em>{usd(b.v)}</em>
                        </span>
                        <span className="lq-top-bar"><i style={{ width: `${(b.v / topMax) * 100}%` }} /></span>
                        <small>{pct(((b.p - reply.px) / reply.px) * 100, 2, true)}</small>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </>
          ) : null}

          <details className="lq-how">
            <summary>{t(lang, "lq_how")}</summary>
            <ul>
              <li>{t(lang, "lq_how_1")}</li>
              <li>{t(lang, "lq_how_2")}</li>
              <li>{t(lang, "lq_how_3")}</li>
              <li>{t(lang, "lq_how_4")}</li>
              <li>{t(lang, "lq_how_5")}</li>
              <li>{t(lang, "lq_how_6")}</li>
            </ul>
          </details>

          <p className="lq-src">
            {t(lang, "lq_src", { ex: reply.ex.join(", ") })}{" "}
            {t(lang, "lq_updated", { t: since(Date.now() / 1000 - reply.at) })}{" · "}
            <button type="button" className="lq-chart" onClick={() => open("chart", reply.sym)}>
              {t(lang, "lq_open_chart")}
            </button>
          </p>
        </>
      )}
    </Frame>
  );
}

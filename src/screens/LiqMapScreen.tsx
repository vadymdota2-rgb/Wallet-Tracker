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
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useApp, type LiqRange } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey } from "../i18n/types";
import { num, pct, px, since, usd } from "../lib/format";
import { haptic } from "../lib/telegram";
import { fetchLiqMap, peekLiqMap, refreshLiqMap, savedLiqMap } from "../lib/api";
import { CoinFind, useLiqCoins } from "../components/CoinFind";
import { useNow } from "../lib/tick";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Chips, Empty, SectionTitle, Segmented, Skeleton } from "../components/ui";
import type { LiqMapReply } from "../lib/types";
import { LIQ_OLD_MIN, ageMin, cumOf, nearest, rowAt, rowsOf, side, sumOn, topLevels } from "../lib/liqmap";
import { Frame } from "./Screen";
import { useWidth } from "./etfView";

type Lang = Parameters<typeof t>[0];

/** Плечи: фиолетовый, голубой, жёлтый, оранжевый, почти белый — самые
 * рискованные 125–500×. Пары различимы и при дальтонизме (OKLab, ΔE ≥ 12 у
 * белого со всеми). */
const LEV_C = ["#7b61ff", "#38bdf8", "#facc15", "#f97316", "#e2e8f0"];
/** Группы плеч модели (wt_liqmap.LEVS): 3–10×, 20–25×, 50×, 75–100×, 125–500×.
 *  Сервер шлёт верхнюю границу группы (levs), подпись — диапазон. */
const LEV_NAME = ["3–10×", "20–25×", "50×", "75–100×", "125–500×"];
const levName = (levs: number[], j: number) => LEV_NAME[j] ?? `${levs[j] ?? ""}×`;
/** Тот же оттенок ярче — для крупных скоплений. */
const LEV_HOT = ["#a594ff", "#7dd3fc", "#fde047", "#fb923c", "#ffffff"];
/** Доля от самого большого уровня, с которой скопление считается крупным. */
const HOT = 0.5;
/** Подписи сумм у полос — не ближе этого друг к другу, px. */
const LABEL_GAP = 18;
const COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE", "SUI", "ADA", "LINK"];
type Span = "5" | "10" | "15" | "30" | "50" | "100";
/** Приближение карты: сервер считает уровни до ±100 % от цены. */
const SPANS: Span[] = ["5", "10", "15", "30", "50", "100"];
const TICK: Record<Span, number> = { "5": 1, "10": 2, "15": 3, "30": 5, "50": 10, "100": 20 };

const AXIS = 58;
const CUMW = 38;
const GAP = 5;
/** Карта рисуется в настоящих пикселях своей ширины (как графики ETF):
 *  подписи — своего размера, линии — чёткие на телефоне, планшете и
 *  компьютере. Раньше рисунок в 360 точек растягивался на всю ширину, и на
 *  компьютере подписи были в три раза крупнее, а карта — на несколько
 *  экранов. Ширина — от 300 до 1100; панель свечей — четверть ширины. */
interface Geom { W: number; PLOT: number; CAND: number; BX0: number; BW: number; CX0: number; CX1: number }
function geom(width: number): Geom {
  const W = Math.round(Math.max(300, Math.min(1100, width)));
  const PLOT = W - AXIS - CUMW - GAP * 2;
  /* Панель свечей слева, полосы уровней — от BX0 до PLOT. */
  const CAND = Math.round(Math.max(96, Math.min(260, W * 0.27)));
  const BX0 = CAND + GAP;
  const CX0 = PLOT + GAP;
  return { W, PLOT, CAND, BX0, BW: PLOT - BX0, CX0, CX1: CX0 + CUMW };
}

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
function Candles({ r, yOf, H, CAND }: { r: LiqMapReply; yOf: (p: number) => number; H: number; CAND: number }) {
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

function Chart({ r, lang, span, sel, onSel, on, win, g }: {
  g: Geom;
  r: LiqMapReply;
  lang: Lang;
  span: Span;
  sel: number | null;
  onSel: (i: number | null) => void;
  on: boolean[];
  win: string;
}) {
  const { W, CAND, BX0, BW, CX0, CX1 } = g;
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

  /* Подписи — у двух крупнейших уровней каждой стороны, не у всех, и не
     соседних: у карты плотности крупнейшие строки идут подряд, и две подписи
     налезали одна на другую («$11,2M» поверх «$11,44M»). Следующая — не
     ближе LABEL_GAP пикселей от уже подписанной. */
  const labelled = useMemo(() => {
    const idx = rows.map((w, i) => ({ i, up: w.mid > r.px, v: sumOn(side(w, r.px), on) })).filter((x) => x.v > 0);
    const gap = Math.ceil(LABEL_GAP / rowH);
    const pick = (up: boolean) => {
      const out: number[] = [];
      for (const x of idx.filter((y) => y.up === up).sort((a, b) => b.v - a.v)) {
        if (out.length >= 2) break;
        if (out.every((i) => Math.abs(i - x.i) >= gap)) out.push(x.i);
      }
      return out;
    };
    return [...pick(true), ...pick(false)];
  }, [rows, rowH, r.px, on]);

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

  /*
   * Уровень показывается, пока палец на карте, и прячется, как только его
   * убрали. Палец можно вести вверх-вниз — подсказка идёт за ним. Чтобы
   * карта не мешала листать экран, ведение включается после короткого
   * удержания: быстрый мазок остаётся прокруткой страницы, и подсказка
   * тогда гаснет. Мышью — наведение, как на обычном графике.
   */
  const svgRef = useRef<SVGSVGElement>(null);
  const live = useRef({ rows: rows.length, rowH, H, cur: -1 });
  live.current.rows = rows.length;
  live.current.rowH = rowH;
  live.current.H = H;
  const onSelRef = useRef(onSel);
  onSelRef.current = onSel;

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const at = (clientY: number) => {
      const { rows: n, rowH: rh, H: h } = live.current;
      const box = el.getBoundingClientRect();
      const y = ((clientY - box.top) / box.height) * h;
      return Math.max(0, Math.min(n - 1, Math.floor(y / rh)));
    };
    const show = (clientY: number) => {
      const i = at(clientY);
      if (i === live.current.cur) return;
      live.current.cur = i;
      haptic("select");
      onSelRef.current(i);
    };
    const hide = () => {
      live.current.cur = -1;
      onSelRef.current(null);
    };
    let x0 = 0;
    let y0 = 0;
    let held = false;
    let timer = 0;
    const start = (e: TouchEvent) => {
      const tt = e.touches[0];
      if (!tt || e.touches.length > 1) return;
      x0 = tt.clientX;
      y0 = tt.clientY;
      held = false;
      show(tt.clientY);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { held = true; }, 160);
    };
    const move = (e: TouchEvent) => {
      const tt = e.touches[0];
      if (!tt) return;
      if (held) {
        e.preventDefault();
        show(tt.clientY);
      } else if (Math.abs(tt.clientY - y0) > 8 || Math.abs(tt.clientX - x0) > 8) {
        window.clearTimeout(timer);
        hide();
      }
    };
    const end = () => {
      window.clearTimeout(timer);
      held = false;
      hide();
    };
    /* Только настоящая мышь. После касания Android шлёт вдогонку
       «мышиные» события в ту же точку, и слушатель mousemove показывал
       уровень снова — уже без пальца, и тот не гас. */
    const mouse = (e: PointerEvent) => {
      if (e.pointerType === "mouse") show(e.clientY);
    };
    const leave = (e: PointerEvent) => {
      if (e.pointerType === "mouse") hide();
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    /* Палец отпустили — гасим в любом случае, даже если событие ушло не
       карте: элемент под пальцем мог смениться при перерисовке. */
    const anyEnd = () => {
      if (live.current.cur !== -1) end();
    };
    window.addEventListener("touchend", anyEnd);
    window.addEventListener("touchcancel", anyEnd);
    el.addEventListener("pointermove", mouse);
    el.addEventListener("pointerleave", leave);
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      window.removeEventListener("touchend", anyEnd);
      window.removeEventListener("touchcancel", anyEnd);
      el.removeEventListener("pointermove", mouse);
      el.removeEventListener("pointerleave", leave);
    };
  }, []);

  const selRow = sel !== null ? rows[sel] : undefined;
  const selY = sel !== null ? sel * rowH + rowH / 2 : 0;

  return (
    <svg
      className="lq-svg"
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={t(lang, "lq_title")}
      ref={svgRef}
      onContextMenu={(e) => e.preventDefault()}
    >
      <rect x={0} y={0} width={W - AXIS} height={H} className="lq-bg" />
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

      <Candles r={r} yOf={yOf} H={H} CAND={CAND} />
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
          const alpha = hot ? 1 : 0.45 + 0.5 * Math.pow(k / HOT, 0.8);
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
      {/* Перевес — прямо на колонке «Накоплено», вдоль неё: сколько всего
          сгорит сверху и снизу в видимом окне и какая это доля. */}
      {(() => {
        const sTot = cum[0] ?? 0;
        const lTot = cum[cum.length - 1] ?? 0;
        const all = sTot + lTot;
        if (all <= 0) return null;
        const share = (v: number) => `${Math.round((v / all) * 100)}%`;
        const x = CX0 + CUMW / 2 + 3.5;
        const yS = yNow / 2;
        const yL = yNow + (H - yNow) / 2;
        return (
          <>
            <text x={x} y={yS} transform={`rotate(-90 ${x} ${yS})`} textAnchor="middle" className="lq-share up">
              {t(lang, "lq_share_s", { p: share(sTot), v: usd(sTot) })}
            </text>
            <text x={x} y={yL} transform={`rotate(-90 ${x} ${yL})`} textAnchor="middle" className="lq-share dn">
              {t(lang, "lq_share_l", { p: share(lTot), v: usd(lTot) })}
            </text>
          </>
        );
      })()}

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

/**
 * Выбор монеты: популярные — чипами, остальные — поиском и полным списком
 * (CoinFind, общий с ликвидациями и историей интереса).
 */
function CoinPicker({ lang, sym, onPick }: { lang: Lang; sym: string; onPick: (s: string) => void }) {
  const list = useLiqCoins();
  const chips = list.length ? list.slice(0, 12).map((c) => c.s) : COINS;
  return (
    <div className="lq-pick">
      <Chips
        value={sym}
        options={[...(chips.includes(sym) ? [] : [{ id: sym, label: sym }]), ...chips.map((c) => ({ id: c, label: c }))]}
        onChange={(c) => { if (c) { haptic("select"); onPick(c); } }}
      />
      <CoinFind lang={lang} sym={sym} onPick={onPick} list={list} />
    </div>
  );
}

/** Как часто открытый экран спрашивает свежую карту: сервер на каждый
 *  запрос снимает уровни, до которых дошла текущая цена, — карта живая. */
const LIVE_EVERY = 20_000;
/** Окна карты и их подписи (длинные — дневными свечами на сервере). */
const RANGES: readonly { id: LiqRange; key: DictKey }[] = [
  { id: "1d", key: "big_win_24h" }, { id: "7d", key: "big_win_7d" }, { id: "30d", key: "big_win_30d" },
  { id: "90d", key: "lq_win_90d" }, { id: "180d", key: "lq_win_180d" }, { id: "365d", key: "lq_win_365d" },
];
/* Карты этой монеты на сервере ещё нет: он собирает её в фоне и отвечает
   «собираем» (building) или «все сборщики заняты» (busy). Экран не пугает
   ошибкой, а переспрашивает сам — BUILD_TRIES раз через BUILD_RETRY. */
const BUILD_RETRY = 3_000;
const BUILD_TRIES = 8;

/** «Обновляется сама · 40 сек назад» — тикает каждую секунду отдельно от карты. */
function LiveAge({ lang, at }: { lang: Lang; at: number }) {
  const now = useNow();
  return (
    <small className="lq-live">
      <i aria-hidden="true" />
      {t(lang, "lq_live", { t: since(Math.max(1, now - at)) })}
    </small>
  );
}

export function LiqMapScreen() {
  const lang = useApp((s) => s.lang);
  const saved = useApp((s) => s.liqSym);
  const savedRange = useApp((s) => s.liqRange);
  const setLiq = useApp((s) => s.setLiq);
  const open = useApp((s) => s.open);
  const [sym, setSym] = useState(saved || "BTC");
  const [range, setRange] = useState<LiqRange>(RANGES.some((x) => x.id === savedRange) ? savedRange : "1d");
  const [span, setSpan] = useState<Span>("10");
  const [sel, setSel] = useState<number | null>(null);
  const [on, setOn] = useState<boolean[]>(LEV_NAME.map(() => true));
  const [reply, setReply] = useState<LiqMapReply | null>(
    () => peekLiqMap(sym, range) ?? savedLiqMap(sym, range)?.v ?? null,
  );
  const [busy, setBusy] = useState(false);
  /* Когда показана карта с устройства, а свежая не пришла, — её время. */
  const [staleAt, setStaleAt] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const plotRef = useRef<HTMLDivElement>(null);
  /* Ширина экрана карты (без полей карточки) — для рисунка в настоящих пикселях. */
  const scrRef = useRef<HTMLDivElement>(null);
  const g = geom(useWidth(scrRef, 392) - 32);
  /* Сколько раз подряд сервер ответил «собираем» по этой карте. */
  const tries = useRef({ key: "", n: 0 });

  /* Сразу — то, что есть: из памяти или с устройства (прошлая карта этой
     монеты и окна). Свежая догружается поверх, и экран не пустеет. Не
     пришла — остаётся прежняя с пометкой, когда она снята. */
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const key = `${sym}|${range}`;
    if (tries.current.key !== key) tries.current = { key, n: 0 };
    setSel(null);
    const cached = peekLiqMap(sym, range);
    const saved = cached ? null : savedLiqMap(sym, range);
    setReply(cached ?? saved?.v ?? null);
    setBusy(!cached);
    setStaleAt(null);
    void fetchLiqMap(sym, range).then((r) => {
      if (!alive) return;
      if ((r?.error === "building" || r?.error === "busy") && tries.current.n < BUILD_TRIES) {
        tries.current.n += 1;
        timer = window.setTimeout(() => setRetry((n) => n + 1), BUILD_RETRY);
        return;
      }
      setBusy(false);
      if (r?.ok || r?.error === "no_data") {
        setReply(r);
      } else if (saved) {
        setStaleAt(saved.at);
      } else {
        setReply(r ?? ({ ok: false, error: "net" } as LiqMapReply));
      }
    });
    setLiq(sym, range);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [sym, range, setLiq, retry]);

  /* Пока экран открыт, карта обновляется сама каждые 20 секунд: сервер
     сводит её с живой ценой при каждом запросе (уровни, которые цена уже
     прошла, — ликвидированы и уходят), а позиции, закрытые за это время, —
     при пересборке раз в 2–30 минут, по окну.
     Выбранный уровень и масштаб при этом не сбрасываются. Скрытое
     приложение не спрашивает. */
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshLiqMap(sym, range).then((r) => {
        if (r?.ok) {
          setReply(r);
          setStaleAt(null);
        }
      });
    }, LIVE_EVERY);
    return () => window.clearInterval(id);
  }, [sym, range]);

  const again = () => {
    haptic("select");
    tries.current.n = 0;
    setRetry((n) => n + 1);
  };

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
    setSpan(SPANS.find((s) => d < Number(s) * 0.92) ?? "100");
    setSel(null);
  }, [reply]);

  const spanN = Number(span);
  const view = useMemo(() => (reply?.ok ? rowsOf(reply, spanN) : { rows: [], rowH: 1 }), [reply, spanN]);
  const row = sel !== null ? view.rows[sel] : undefined;
  const cum = useMemo(() => (reply?.ok ? cumOf(view.rows, reply.px, on) : []), [reply, view, on]);
  /* С клавиатуры: стрелки вверх и вниз — соседний уровень (первый раз — у
     цены), Home и End — края окна, Escape — убрать подсказку. */
  const onKey = (e: KeyboardEvent) => {
    const n = view.rows.length;
    if (!reply?.ok || !n) return;
    const go = (i: number) => {
      e.preventDefault();
      setSel(Math.max(0, Math.min(n - 1, i)));
    };
    const start = Math.max(0, rowAt(reply, spanN, reply.px));
    if (e.key === "ArrowUp") go(sel === null ? start : sel - 1);
    else if (e.key === "ArrowDown") go(sel === null ? start : sel + 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(n - 1);
    else if (e.key === "Escape" && sel !== null) {
      e.preventDefault();
      setSel(null);
    }
  };
  /* Таблица уровней — то же, что на карте, словами: строки окна с деньгами. */
  const table = useMemo(() => {
    if (!reply?.ok) return [];
    return view.rows
      .map((w, i) => ({ p: w.mid, up: w.mid > reply.px, v: sumOn(side(w, reply.px), on), c: cum[i] ?? 0 }))
      .filter((x) => x.v > 0);
  }, [reply, view, on, cum]);
  const old = reply?.ok && ageMin(reply.at) >= LIQ_OLD_MIN
    ? new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit" }).format(new Date(reply.at * 1000))
    : null;

  const near = useMemo(() => (reply?.ok ? { up: nearest(reply, true), dn: nearest(reply, false) } : null), [reply]);

  /* Крупнейшие уровни — скопления в видимом окне (topLevels). */
  const top = useMemo(
    () => (reply?.ok ? { up: topLevels(reply, true, spanN), dn: topLevels(reply, false, spanN) } : { up: [], dn: [] }),
    [reply, spanN],
  );
  const topMax = Math.max(1, ...top.up.map((b) => b.v), ...top.dn.map((b) => b.v));


  /** Показать цену на карте: если она за краем, окно расширяется. */
  const focus = (p: number) => {
    if (!reply?.ok) return;
    const d = Math.abs((p - reply.px) / reply.px) * 100;
    const fit = d < spanN ? span : SPANS.find((s) => d < Number(s)) ?? "100";
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

  const levs = reply?.ok ? reply.levs : [];
  const winLabel = t(lang, RANGES.find((x) => x.id === range)?.key ?? "big_win_24h");

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
            <LiveAge lang={lang} at={reply.at} />
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
        {reply.seen && reply.oi ? (
          <p className="lq-seen">{t(lang, "lq_seen", { a: usd(reply.seen), p: pct((reply.seen / reply.oi) * 100, 1, false) })}</p>
        ) : null}

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
      {/* Своя сетка в одну колонку minmax(0, 1fr): общая сетка экрана берёт
          ширину по самому широкому ряду, и при крупном шрифте (200 %) кнопки
          окна раздвигали весь экран шире телефона. */}
      <div className="lq-scr" ref={scrRef}>
      <p className="lq-lead">{t(lang, "lq_sub")}</p>

      <CoinPicker lang={lang} sym={sym} onPick={setSym} />
      <div className="lq-ctl">
        <Segmented<LiqRange>
          tight
          value={range}
          onChange={setRange}
          options={RANGES.map((x) => ({ id: x.id, label: t(lang, x.key) }))}
        />
      </div>

      {staleAt ? (
        <p className="lq-stale">
          {t(lang, "lq_stale", { t: since((Date.now() - staleAt) / 1000) })}{" "}
          <button type="button" onClick={again}>{t(lang, "ui_retry")}</button>
        </p>
      ) : null}

      {!reply ? (
        <Card><Skeleton rows={10} /></Card>
      ) : !reply.ok ? (
        <Empty
          text={reply.error === "no_data" ? t(lang, "lq_no_data", { s: sym }) : t(lang, "lq_err")}
          hint={reply.error === "no_data" ? undefined : (
            <button type="button" className="lq-retry" onClick={again}>{t(lang, "ui_retry")}</button>
          )}
        />
      ) : (
        <>
          {old ? <p className="lq-stale" role="status">{t(lang, "lq_old", { t: old })}</p> : null}
          {hero}

          <Card>
            <Segmented<Span>
              value={span}
              onChange={(v) => { setSpan(v); setSel(null); }}
              tight
              options={SPANS.map((s) => ({ id: s, label: `±${s}%` }))}
            />
            <div className="lq-zone-h up">
              <span style={{ maxWidth: `calc(${(g.CX0 / g.W) * 100}% - 12px)` }}>▲ {t(lang, "lq_zone_up")}</span>
              <small style={{ right: `${(AXIS / g.W) * 100}%` }}>
                {t(lang, "lq_cum_axis")}
              </small>
            </div>
            <div className="lq-plot" ref={plotRef} tabIndex={0} role="group" aria-label={t(lang, "lq_keys")}
              onKeyDown={onKey}>
              <Chart r={reply} lang={lang} span={span} sel={sel} onSel={setSel} on={on} win={winLabel} g={g} />
              {row ? (
                <div
                  className={`lq-pop ${rowUp ? "up" : "dn"}${tipBelow ? " below" : ""}`}
                  style={{ top: `${(((sel ?? 0) + 0.5) / view.rows.length) * 100}%` }}
                  aria-live="polite"
                >
                  <div className="lq-pop-h">
                    <b>{px(row.mid)}</b>
                    <span>{pct(((row.mid - reply.px) / reply.px) * 100, 2, true)}</span>
                  </div>
                  <em>{rowUp ? "▲" : "▼"} {t(lang, rowUp ? "lq_shorts" : "lq_longs")}</em>
                  <div className="lq-pop-levs">
                    {side(row, reply.px).map((v, j) => (
                      <span key={j} className={on[j] ? "" : "off"}>
                        <i style={{ background: LEV_C[j] }} />
                        <bdi dir="ltr">{levName(levs, j)}</bdi> <b>{v > 0 ? usd(v) : "—"}</b>
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
                  <bdi dir="ltr">{levName(levs, j)}</bdi>
                </button>
              ))}
            </div>
            <p className="lq-hint">
              <span className="lq-hot-k" aria-hidden="true"><i /><i /><i /></span>
              {t(lang, "lq_hot")} {t(lang, "lq_hint")}
            </p>
            {table.length ? (
              <details className="lq-tbl">
                <summary>{t(lang, "ef_tbl")}</summary>
                <div className="lq-tbl-w">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{t(lang, "lq_tbl_px")}</th>
                        <th scope="col">{t(lang, "lq_tbl_v")}</th>
                        <th scope="col">{t(lang, "lq_cum_axis")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {table.map((x) => (
                        <tr key={x.p} className={x.up ? "up" : "dn"}>
                          <th scope="row"><bdi dir="ltr">{px(x.p)}</bdi> <small>{x.up ? "▲" : "▼"} {t(lang, x.up ? "lq_shorts" : "lq_longs")}</small></th>
                          <td><bdi dir="ltr">{usd(x.v)}</bdi></td>
                          <td><bdi dir="ltr">{usd(x.c)}</bdi></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : null}
          </Card>

          <SectionTitle help={["lq_how_1", "lq_how_2", "lq_how_4"]}>{t(lang, "lq_cum_title")}</SectionTitle>
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
              <SectionTitle help={["lq_how_5", "lq_how_7"]}>{t(lang, "lq_top")}</SectionTitle>
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
              <li>{t(lang, "lq_how_7")}</li>
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
      </div>
    </Frame>
  );
}

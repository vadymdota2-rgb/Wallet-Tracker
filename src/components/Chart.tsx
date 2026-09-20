/**
 * Графики. Рисуем сами: библиотека свечей весит больше, чем всё приложение.
 *
 * Ни один из этих компонентов ничего не досочиняет. Нет точек — ничего не
 * рисуется, и экран говорит об этом словами. Прошлая версия при отсутствии
 * котировок строила 32 точки линейной интерполяции между ценой входа и
 * текущей: по виду обычный график, по сути ничего.
 */
import { useId } from "react";
import type { Candle } from "../lib/klines";

const W = 320;

interface Box {
  h: number;
  pad: number;
}

function extent(values: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) return [lo - Math.abs(lo) * 0.01 - 1e-9, hi + Math.abs(hi) * 0.01 + 1e-9];
  return [lo, hi];
}

/** Линия с заливкой под ней. Для истории цены и «пульса». */
export function Area({
  points,
  height = 96,
  up,
}: {
  points: number[];
  height?: number;
  up?: boolean;
}) {
  const gid = useId();
  const vals = points.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return null;

  const box: Box = { h: height, pad: 6 };
  const [lo, hi] = extent(vals);
  const span = hi - lo;
  const stepX = W / (vals.length - 1);
  const y = (v: number) => box.pad + (1 - (v - lo) / span) * (box.h - box.pad * 2);

  const first = vals[0] ?? 0;
  const last = vals[vals.length - 1] ?? 0;
  const rising = up ?? last >= first;
  const line = vals.map((v, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(2)},${y(v).toFixed(2)}`).join("");
  const fill = `${line}L${W},${box.h}L0,${box.h}Z`;
  const color = rising ? "var(--up)" : "var(--dn)";

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${box.h}`} preserveAspectRatio="none" role="img">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fill} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"
            strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={W} cy={y(last)} r="2.5" fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Свечи с ценовой шкалой справа: тело — открытие и закрытие, ус — минимум и
 * максимум. Последняя цена вынесена пунктиром и подписана — по ней читают
 * позицию, а не по общему виду графика.
 *
 * `entry` рисует цену входа отдельной линией, `note` подписывает линию
 * текущей цены слева — там выводим ROI и прибыль позиции. Вход входит в
 * масштаб, но только пока он рядом со свечами: вход вдвое ниже минимума
 * сплющил бы весь график в полоску, поэтому такую линию просто не рисуем.
 */
/**
 * Уровень плана на графике: цена, её смысл и подпись.
 *
 * Цвет здесь означает состояние — стоп это потеря, цель это прибыль, — а не
 * принадлежность к ряду. Поэтому у каждой линии всегда есть подпись со
 * значком: по одному цвету различать их нельзя, и не всем это доступно.
 */
export interface PlanLevel {
  v: number;
  tone: "up" | "dn" | "warn";
  /** Короткая подпись слева, например «🛑 Стоп». */
  label: string;
}

/** Полоса между двумя ценами: риск от входа до стопа, прибыль до цели. */
export interface PlanZone {
  from: number;
  to: number;
  tone: "up" | "dn";
}

export function Candles({
  candles,
  height = 190,
  format = (v: number) => String(v),
  entry = 0,
  entryLabel,
  note,
  noteTone,
  levels,
  zones,
}: {
  candles: Candle[];
  height?: number;
  format?: (v: number) => string;
  /** Цена входа в позицию. 0 — не рисуем. */
  entry?: number;
  /** Короткая подпись у линии входа, например «Вход». */
  entryLabel?: string;
  /** Подпись у линии текущей цены: ROI и PnL. */
  note?: string;
  noteTone?: "up" | "dn";
  /** Уровни плана: вход, стоп, цели. Входят в масштаб целиком — план,
   *  наполовину уехавший за край, не план. */
  levels?: PlanLevel[];
  /** Полосы риска и прибыли. Рисуются под свечами, без обводки. */
  zones?: PlanZone[];
}) {
  if (candles.length < 2) return null;

  // Место под подписи цен справа — иначе они лягут поверх свечей.
  const axis = 62;
  const plot = W - axis;
  const pad = 10;
  const vals: number[] = [];
  for (const c of candles) vals.push(c.h, c.l);
  const [rawLo, rawHi] = extent(vals);
  // Вход растягивает шкалу, только если он не дальше размаха свечей от них.
  const reach = (rawHi - rawLo) * 1.5;
  const showEntry = entry > 0 && entry > rawLo - reach && entry < rawHi + reach;
  if (showEntry) vals.push(entry);
  /* Уровни плана входят в масштаб без всяких условий. Свечи от этого могут
     сжаться — и это правда о плане: цель, до которой цена за всё показанное
     время близко не подходила, должна выглядеть далёкой. */
  const plan = (levels ?? []).filter((l) => Number.isFinite(l.v) && l.v > 0);
  for (const l of plan) vals.push(l.v);
  const [lo, hi] = extent(vals);
  const span = hi - lo;
  const y = (v: number) => pad + (1 - (v - lo) / span) * (height - pad * 2);

  const slot = plot / candles.length;
  const body = Math.max(1.2, Math.min(slot * 0.64, 9));
  const last = candles[candles.length - 1];
  const lastPx = last ? last.c : 0;
  const rows = [hi, lo + span * 0.5, lo];
  // Подпись сетки прячем, если рядом уже стоит плашка входа или текущей цены:
  // иначе две цены наезжают друг на друга и не читается ни одна.
  const busy = [showEntry ? y(entry) : NaN, lastPx > 0 ? y(lastPx) : NaN,
                ...plan.map((l) => y(l.v))];
  const free = (v: number) => !busy.some((b) => Number.isFinite(b) && Math.abs(b - y(v)) < 11);

  /* Подписи ставятся по важности, а не по месту на экране, и каждая
     следующая пропускается, если налезает на уже поставленную: две цены друг
     на друге не читаются ни одна.
     Порядок — тот, в котором уровни пришли, и зовущий присылает их по
     важности: стоп, вход, цели. Прежде подписи ставились сверху вниз и
     первой выбывала нижняя — то есть стоп у лонга, самое важное число на
     карточке, — а плашка текущей цены оставалась. Текущая цена теперь
     уступает плану: карточка про план. */
  const taken: number[] = [];
  const place = (v: number): boolean => {
    const at = y(v);
    if (taken.some((b) => Math.abs(b - at) < 11)) return false;
    taken.push(at);
    return true;
  };
  const labelled = new Set<number>();
  plan.forEach((l, i) => { if (place(l.v)) labelled.add(i); });
  const nowText = lastPx > 0 && place(lastPx);
  // Рисуем сверху вниз, чтобы линии не прыгали при пересортировке.
  const shown = plan
    .map((l, i) => ({ ...l, text: labelled.has(i) }))
    .sort((a, b) => y(a.v) - y(b.v));

  return (
    <svg className="chart candles" viewBox={`0 0 ${W} ${height}`} role="img">
      {/* Риск и прибыль полосами: их высоты и есть то самое отношение, ради
          которого сделку берут. Заливка бледная и без обводки — это фон
          свечей, а не ещё один ряд данных. */}
      {(zones ?? []).map((z, i) => {
        const a = y(z.from);
        const b = y(z.to);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
        return (
          <rect key={`z${i}`} x="0" width={plot} y={Math.min(a, b)}
                height={Math.max(1, Math.abs(b - a))}
                fill={z.tone === "up" ? "var(--up)" : "var(--dn)"} opacity="0.07" />
        );
      })}
      {rows.map((v, i) => (
        <g key={i}>
          <line x1="0" x2={plot} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" />
          {free(v) ? (
            <text className="ax" x={W - 4} y={y(v) + 3} textAnchor="end">{format(v)}</text>
          ) : null}
        </g>
      ))}

      {candles.map((c, i) => {
        const cx = i * slot + slot / 2;
        const color = c.c >= c.o ? "var(--up)" : "var(--dn)";
        const top = y(Math.max(c.o, c.c));
        const bottom = y(Math.min(c.o, c.c));
        return (
          <g key={c.t || i}>
            <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} stroke={color} strokeWidth="1" opacity="0.85" />
            <rect x={cx - body / 2} y={top} width={body} height={Math.max(1, bottom - top)} fill={color} />
          </g>
        );
      })}

      {shown.map((l, i) => {
        const at = y(l.v);
        const color = l.tone === "up" ? "var(--up)" : l.tone === "dn" ? "var(--dn)" : "var(--warn)";
        return (
          <g key={`l${i}`}>
            <line x1="0" x2={plot} y1={at} y2={at} stroke={color} strokeWidth="1"
                  strokeDasharray="3 3" opacity="0.9" />
            <circle cx={plot - 2} cy={at} r="2.6" fill={color} />
            {l.text ? (
              <>
                <rect x={plot + 2} y={at - 8} width={axis - 6} height="16" rx="3"
                      fill={color} opacity="0.2" />
                <text className="ax lvl" x={W - 5} y={at + 3} textAnchor="end" fill={color}>
                  {format(l.v)}
                </text>
                {/* Подпись уходит под линию, если над ней не осталось места:
                    у верхнего уровня она иначе наполовину вылезает за край
                    поля и читается половиной букв. */}
                <rect className="ax-bg" x="2" y={at < 16 ? at + 3 : at - 14}
                      width={l.label.length * 5.6 + 8} height="12" rx="2" />
                <text className="ax lvl" x="5" y={at < 16 ? at + 12 : at - 5} fill={color}>
                  {l.label}
                </text>
              </>
            ) : null}
          </g>
        );
      })}

      {showEntry ? (
        <g>
          <line x1="0" x2={plot} y1={y(entry)} y2={y(entry)} stroke="var(--warn)"
                strokeWidth="1" strokeDasharray="2 3" opacity="0.9" />
          <circle cx={plot - 2} cy={y(entry)} r="2.6" fill="var(--warn)" />
          <rect x={plot + 2} y={y(entry) - 8} width={axis - 6} height="16" rx="3"
                fill="var(--warn)" opacity="0.22" />
          <text className="ax entry" x={W - 5} y={y(entry) + 3} textAnchor="end">{format(entry)}</text>
          {entryLabel ? (
            <>
              <rect className="ax-bg" x="2" y={y(entry) - 14} width={entryLabel.length * 5.6 + 6} height="12" rx="2" />
              <text className="ax entry" x="5" y={y(entry) - 5}>{entryLabel}</text>
            </>
          ) : null}
        </g>
      ) : null}

      {lastPx > 0 ? (
        <g>
          <line x1="0" x2={plot} y1={y(lastPx)} y2={y(lastPx)} stroke="var(--glow)"
                strokeWidth="1" strokeDasharray="4 4" opacity="0.75" />
          {nowText ? (
            <>
              <rect x={plot + 2} y={y(lastPx) - 8} width={axis - 6} height="16" rx="3"
                    fill="var(--blue)" />
              <text className="ax now" x={W - 5} y={y(lastPx) + 3} textAnchor="end">
                {format(lastPx)}
              </text>
            </>
          ) : null}
          {note ? (
            <>
              <rect className="ax-bg" x="2" y={y(lastPx) - 14} width={note.length * 5.6 + 6} height="12" rx="2" />
              <text className={noteTone ? `ax pos ${noteTone}` : "ax pos"} x="5" y={y(lastPx) - 5}>
                {note}
              </text>
            </>
          ) : null}
        </g>
      ) : null}
    </svg>
  );
}

/** Крошечная линия в строке списка. */
export function Spark({ values, width = 56, height = 20 }: { values: number[]; width?: number; height?: number }) {
  const vals = (values || []).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return <span className="spark-gap" style={{ width, height }} />;
  const [lo, hi] = extent(vals);
  const span = hi - lo;
  const stepX = width / (vals.length - 1);
  const first = vals[0] ?? 0;
  const last = vals[vals.length - 1] ?? 0;
  const d = vals
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(1)},${(2 + (1 - (v - lo) / span) * (height - 4)).toFixed(1)}`)
    .join("");
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-hidden="true">
      <path d={d} fill="none" stroke={last >= first ? "var(--up)" : "var(--dn)"} strokeWidth="1.5"
            strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Линия накопленного потока денег.
 *
 * Отличается от Spark двумя вещами, и обе важны. Цвет берётся от конечного
 * значения, а не от «последняя точка выше первой»: рядом стоит итоговая
 * сумма, и линия обязана согласовываться именно с ней. И рисуется нулевая
 * ось — без неё не видно, ушёл ли поток в минус или просто замедлился.
 */
export function FlowSpark({
  values,
  width = 64,
  height = 26,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  const gid = useId();
  const vals = (values || []).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return <span className="spark-gap" style={{ width, height }} />;

  const last = vals[vals.length - 1] ?? 0;
  const up = last >= 0;
  // Ноль всегда внутри поля: иначе ось уезжала бы за край и линия
  // «полностью в плюсе» выглядела бы так же, как «полностью в минусе».
  const hi = Math.max(0, ...vals);
  const lo = Math.min(0, ...vals);
  const span = hi - lo || 1;
  const pad = 2;
  const y = (v: number) => pad + (1 - (v - lo) / span) * (height - pad * 2);
  const stepX = width / (vals.length - 1);
  const pts = vals.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`);
  const zero = y(0);

  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
         role="img" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1={up ? 0 : height} x2="0" y2={up ? height : 0}
                        gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={up ? "var(--up)" : "var(--dn)"} stopOpacity="0.30" />
          <stop offset="1" stopColor={up ? "var(--up)" : "var(--dn)"} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`M0,${zero.toFixed(1)}H${width}`} stroke="var(--line)" strokeWidth="1" fill="none" />
      <path d={`M${pts.join("L")}L${width},${zero.toFixed(1)}L0,${zero.toFixed(1)}Z`} fill={`url(#${gid})`} />
      <path d={`M${pts.join("L")}`} fill="none" strokeWidth="1.6"
            stroke={up ? "var(--up)" : "var(--dn)"} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Полоса покупок против продаж. Ноль сделок — полосы нет вовсе, а не деления
 * на ноль: прошлая версия в этом месте показывала NaN и пропадала.
 */
/**
 * Линия рынка целиком: накопленный поток по всем монетам окна.
 *
 * Не спарклайн — у неё есть ось нуля, подпись краёв и точка на конце, потому
 * что читают её как самостоятельный график, а не как значок рядом с числом.
 *
 * Координаты фиксированные, ширина тянется: масштабируется равномерно, и
 * толщина линии не расползается на широком экране.
 */
export function TrendChart({ values }: { values: number[] }) {
  const gid = useId();
  const vals = (values || []).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return <div className="trend-gap" />;

  const W = 320;
  const H = 86;
  const last = vals[vals.length - 1] ?? 0;
  const up = last >= 0;
  // Ноль внутри поля всегда: иначе «весь месяц в плюсе» рисовалось бы тем же
  // самым, что «весь месяц в минусе», только другим цветом.
  const hi = Math.max(0, ...vals);
  const lo = Math.min(0, ...vals);
  const span = hi - lo || 1;
  const pad = 6;
  const y = (v: number) => pad + (1 - (v - lo) / span) * (H - pad * 2);
  // Линия не доходит до правого края на радиус точки: иначе её половина
  // оказывалась бы за пределами поля и «сейчас» выглядело бы обрубленным.
  const R = 3.5;
  const right = W - R;
  const stepX = right / (vals.length - 1);
  const pts = vals.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`);
  const zero = y(0);
  const line = `M${pts.join("L")}`;
  const tone = up ? "var(--up)" : "var(--dn)";

  return (
    <svg className="trend-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
         role="img" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1={up ? 0 : H} x2="0" y2={up ? H : 0}
                        gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={tone} stopOpacity="0.26" />
          <stop offset="1" stopColor={tone} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line}L${right},${zero.toFixed(1)}L0,${zero.toFixed(1)}Z`} fill={`url(#${gid})`} />
      <path d={`M0,${zero.toFixed(1)}H${W}`} stroke="var(--line-2)" strokeWidth="1"
            strokeDasharray="3 4" fill="none" vectorEffect="non-scaling-stroke" />
      <path d={line} fill="none" stroke={tone} strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {/* Точка на конце: край линии — это «сейчас», и взгляд должен попадать
          в него сразу, не проходя всю линию глазами. */}
      <circle cx={right} cy={y(last)} r={R} fill={tone} />
    </svg>
  );
}


export function BuySellBar({ buy, sell }: { buy: number; sell: number }) {
  const total = (Number(buy) || 0) + (Number(sell) || 0);
  if (!(total > 0)) return null;
  const share = Math.round(((Number(buy) || 0) / total) * 100);
  return (
    <div className="bsbar" role="img" aria-label={`${share}%`}>
      <span className="bs-buy" style={{ width: `${share}%` }} />
      <span className="bs-sell" style={{ width: `${100 - share}%` }} />
    </div>
  );
}

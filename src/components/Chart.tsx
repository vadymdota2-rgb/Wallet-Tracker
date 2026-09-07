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
 */
export function Candles({
  candles,
  height = 190,
  format = (v: number) => String(v),
}: {
  candles: Candle[];
  height?: number;
  format?: (v: number) => string;
}) {
  if (candles.length < 2) return null;

  // Место под подписи цен справа — иначе они лягут поверх свечей.
  const axis = 62;
  const plot = W - axis;
  const pad = 10;
  const vals: number[] = [];
  for (const c of candles) vals.push(c.h, c.l);
  const [lo, hi] = extent(vals);
  const span = hi - lo;
  const y = (v: number) => pad + (1 - (v - lo) / span) * (height - pad * 2);

  const slot = plot / candles.length;
  const body = Math.max(1.2, Math.min(slot * 0.64, 9));
  const last = candles[candles.length - 1];
  const lastPx = last ? last.c : 0;
  const rows = [hi, lo + span * 0.5, lo];

  return (
    <svg className="chart candles" viewBox={`0 0 ${W} ${height}`} role="img">
      {rows.map((v, i) => (
        <g key={i}>
          <line x1="0" x2={plot} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" />
          <text className="ax" x={W - 4} y={y(v) + 3} textAnchor="end">{format(v)}</text>
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

      {lastPx > 0 ? (
        <g>
          <line x1="0" x2={plot} y1={y(lastPx)} y2={y(lastPx)} stroke="var(--glow)"
                strokeWidth="1" strokeDasharray="4 4" opacity="0.75" />
          <rect x={plot + 2} y={y(lastPx) - 8} width={axis - 6} height="16" rx="3" fill="var(--blue)" />
          <text className="ax now" x={W - 5} y={y(lastPx) + 3} textAnchor="end">{format(lastPx)}</text>
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
 * Полоса покупок против продаж. Ноль сделок — полосы нет вовсе, а не деления
 * на ноль: прошлая версия в этом месте показывала NaN и пропадала.
 */
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

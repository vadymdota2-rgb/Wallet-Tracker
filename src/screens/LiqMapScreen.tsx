/**
 * Карта ликвидаций: где по цене лежат ликвидации открытых позиций.
 *
 * Это оценка сервера (whale_api.liq_map): за свечу открытый интерес вырос —
 * на её цене открылись позиции, объём разложен по плечам 10×/25×/50×/100×, у
 * каждого своя цена ликвидации; то, что цена уже прошла, снято. Настоящих цен
 * ликвидации биржи не публикуют, и экран так и говорит.
 *
 * Цена идёт по вертикали — телефон держат стоя, и уровни читаются сверху
 * вниз, как стакан: шорты над текущей ценой, лонги под ней. Полосы уровня
 * сложены по плечам в одном порядке, цвет — у плеча, а не у стороны: сторону
 * говорит место относительно линии цены.
 *
 * Ось одна — сумма на уровне. Накопленное «до этой цены» — другой масштаб, и
 * второй осью на том же графике оно превратило бы карту в ребус; поэтому оно
 * в плитках и в подсказке при касании.
 */
import { useEffect, useMemo, useState } from "react";
import { useApp, type LiqRange } from "../store/app";
import { t } from "../i18n/t";
import { pct, px, usd } from "../lib/format";
import { haptic } from "../lib/telegram";
import { fetchLiqMap, peekLiqMap } from "../lib/api";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Chips, Empty, Row, SectionTitle, Segmented, Skeleton } from "../components/ui";
import type { LiqMapReply } from "../lib/types";
import { Frame } from "./Screen";

type Lang = Parameters<typeof t>[0];

/** Цвета плеч — проверенная палитра проекта (тёмный фон, дальтонизм). */
const LEV_COLORS = ["#3987e5", "#199e70", "#c98500", "#d55181"];
const COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE", "SUI", "ADA", "LINK"];
type Span = "5" | "10" | "15";

const W = 360;
const AXIS = 66;
const PLOT = W - AXIS - 6;

interface ViewRow {
  lo: number;
  hi: number;
  mid: number;
  L: number[];
  S: number[];
}

/** Корзины сервера (по 0,25%) — в строки экрана: не тоньше семи точек. */
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

function Chart({ r, lang, span, sel, onSel }: {
  r: LiqMapReply;
  lang: Lang;
  span: number;
  sel: number | null;
  onSel: (i: number | null) => void;
}) {
  const { rows, rowH } = useMemo(() => rowsOf(r, span), [r, span]);
  const H = rows.length * rowH;
  const max = Math.max(1, ...rows.map((w) => Math.max(sum(w.L), sum(w.S))));
  const yOf = (price: number) => ((r.px * (1 + span / 100) - price) / (r.px * span * 2 / 100)) * H;
  const yNow = yOf(r.px);
  const ticks = [-span, -span / 2, 0, span / 2, span];

  const pick = (clientY: number, el: SVGSVGElement) => {
    const box = el.getBoundingClientRect();
    const y = ((clientY - box.top) / box.height) * H;
    const i = Math.max(0, Math.min(rows.length - 1, Math.floor(y / rowH)));
    if (i !== sel) {
      haptic("select");
      onSel(i);
    }
  };

  return (
    <svg
      className="lq-svg"
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={t(lang, "lq_title")}
      onPointerDown={(e) => pick(e.clientY, e.currentTarget)}
      onPointerMove={(e) => {
        if (e.pointerType === "mouse" || e.buttons) pick(e.clientY, e.currentTarget);
      }}
    >
      {/* Сетка: риски процентов от цены — едва видны, данные важнее. */}
      {ticks.map((p) => {
        const y = yOf(r.px * (1 + p / 100));
        return (
          <g key={p}>
            <line x1={0} x2={PLOT} y1={y} y2={y} className="lq-grid" />
            <text x={W - 2} y={Math.min(H - 3, Math.max(10, y + 4))} className="lq-tick" textAnchor="end">
              {p === 0 ? "" : `${p > 0 ? "+" : ""}${p}%`}
            </text>
          </g>
        );
      })}
      {rows.map((w, i) => {
        const above = w.mid > r.px;
        const parts = above ? w.S : w.L;
        const total = sum(parts);
        const y = i * rowH + 1;
        const h = Math.max(2, rowH - 2);
        let x = 0;
        return (
          <g key={i} className={sel === i ? "lq-row on" : "lq-row"}>
            {sel === i ? <rect x={0} y={i * rowH} width={W} height={rowH} className="lq-hl" /> : null}
            {total > 0
              ? parts.map((v, j) => {
                  if (v <= 0) return null;
                  const wdt = (v / max) * PLOT;
                  const gap = wdt > 4 ? 1.5 : 0;
                  const el = (
                    <rect key={j} x={x} y={y} width={Math.max(1, wdt - gap)} height={h}
                      rx={Math.min(2, h / 2)} fill={LEV_COLORS[j]} />
                  );
                  x += wdt;
                  return el;
                })
              : null}
          </g>
        );
      })}
      <line x1={0} x2={W} y1={yNow} y2={yNow} className="lq-now" />
      <rect x={W - AXIS} y={yNow - 10} width={AXIS} height={20} rx={5} className="lq-now-box" />
      <text x={W - AXIS / 2} y={yNow + 4.5} textAnchor="middle" className="lq-now-t">{px(r.px)}</text>
      <text x={4} y={Math.max(12, yNow - 8)} className="lq-side">{t(lang, "lq_shorts")} ↑</text>
      <text x={4} y={Math.min(H - 4, yNow + 18)} className="lq-side">{t(lang, "lq_longs")} ↓</text>
    </svg>
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
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<number | null>(null);
  const [reply, setReply] = useState<LiqMapReply | null>(() => peekLiqMap(sym, range) ?? null);
  const [busy, setBusy] = useState(false);

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

  const spanN = Number(span);
  const view = useMemo(() => (reply?.ok ? rowsOf(reply, spanN).rows : []), [reply, spanN]);
  const row = sel !== null ? view[sel] : undefined;

  /* Накопленное от цены до выбранного уровня — на его стороне. */
  const cumTo = useMemo(() => {
    if (!reply?.ok || sel === null || !row) return 0;
    const above = row.mid > reply.px;
    return view.reduce((acc, w) => {
      if (above && w.mid > reply.px && w.mid <= row.mid) return acc + sum(w.S);
      if (!above && w.mid < reply.px && w.mid >= row.mid) return acc + sum(w.L);
      return acc;
    }, 0);
  }, [reply, view, sel, row]);

  const top = useMemo(() => {
    if (!reply?.ok) return [];
    return reply.buckets
      .map((b) => ({ p: b.p, long: b.p < reply.px, v: b.p < reply.px ? sum(b.L) : sum(b.S) }))
      .filter((b) => b.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, 6);
  }, [reply]);

  const pick = () => {
    const s = query.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!s) return;
    haptic("select");
    setSym(s);
    setQuery("");
  };

  const levs = reply?.levs ?? [10, 25, 50, 100];

  return (
    <Frame title={t(lang, "lq_title")}>
      <p className="lq-lead">{t(lang, "lq_sub")}</p>

      <Chips
        value={sym}
        options={[...(COINS.includes(sym) ? [] : [{ id: sym, label: sym }]), ...COINS.map((c) => ({ id: c, label: c }))]}
        onChange={(c) => c && setSym(c)}
      />
      <form className="lq-find" onSubmit={(e) => { e.preventDefault(); pick(); }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t(lang, "lq_search")}
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={12}
        />
        <button type="submit" disabled={!query.trim()}>{t(lang, "lq_show")}</button>
      </form>
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
        <Segmented<Span>
          value={span}
          onChange={(v) => { setSpan(v); setSel(null); }}
          options={[
            { id: "5", label: "±5%" },
            { id: "10", label: "±10%" },
            { id: "15", label: "±15%" },
          ]}
        />
      </div>

      {!reply ? (
        <Card><Skeleton rows={8} /></Card>
      ) : !reply.ok ? (
        <Empty
          text={reply.error === "no_data" ? t(lang, "lq_no_data", { s: sym }) : t(lang, "lq_err")}
        />
      ) : (
        <>
          <Card>
            <div className="lq-head">
              <CoinIcon sym={reply.sym} size={30} />
              <div>
                <b>{reply.sym}</b>
                <small>{t(lang, "lq_price_now")} {px(reply.px)}</small>
              </div>
              {busy ? <span className="lq-busy" aria-hidden="true">…</span> : null}
            </div>

            {/* Подсказка касания: цена уровня, сторона, раскладка по плечам и
                сколько накопится, если цена дойдёт сюда. */}
            <div className="lq-tip" aria-live="polite">
              {row ? (
                <>
                  <div className="lq-tip-h">
                    <b>{px(row.mid)}</b>
                    <span>{pct(((row.mid - reply.px) / reply.px) * 100, 2, true)}</span>
                    <em>{t(lang, row.mid > reply.px ? "lq_shorts" : "lq_longs")}</em>
                  </div>
                  <div className="lq-tip-levs">
                    {(row.mid > reply.px ? row.S : row.L).map((v, j) => (
                      <span key={j}>
                        <i style={{ background: LEV_COLORS[j] }} />
                        {levs[j]}× <b>{usd(v)}</b>
                      </span>
                    ))}
                  </div>
                  <p>{t(lang, "lq_tip_cum")} <b>{usd(cumTo)}</b></p>
                </>
              ) : (
                <p className="lq-tip-hint">{t(lang, "lq_hint")}</p>
              )}
            </div>

            <Chart r={reply} lang={lang} span={spanN} sel={sel} onSel={setSel} />

            <div className="lq-legend">
              <span className="lq-legend-t">{t(lang, "lq_lev")}</span>
              {levs.map((l, j) => (
                <span key={l}><i style={{ background: LEV_COLORS[j] }} />{l}×</span>
              ))}
            </div>
          </Card>

          <SectionTitle>{t(lang, "lq_cum_title")}</SectionTitle>
          <div className="lq-cum">
            {["2", "5", "10"].map((k) => (
              <div key={k} className="lq-cum-c">
                <small>±{k}%</small>
                <span>{t(lang, "lq_shorts")} <b>{usd(reply.cum[k]?.S ?? 0)}</b></span>
                <span>{t(lang, "lq_longs")} <b>{usd(reply.cum[k]?.L ?? 0)}</b></span>
              </div>
            ))}
          </div>

          {top.length ? (
            <>
              <SectionTitle>{t(lang, "lq_top")}</SectionTitle>
              <Card pad={false}>
                {top.map((b) => (
                  <Row
                    key={b.p}
                    title={px(b.p)}
                    sub={`${t(lang, b.long ? "lq_longs" : "lq_shorts")} · ${pct(((b.p - reply.px) / reply.px) * 100, 2, true)}`}
                    value={usd(b.v)}
                    tone={b.long ? "dn" : "up"}
                  />
                ))}
              </Card>
            </>
          ) : null}

          <p className="lq-src">
            {t(lang, "lq_src", { ex: reply.ex.join(", ") })}{" "}
            <button type="button" className="lq-chart" onClick={() => open("chart", reply.sym)}>
              {t(lang, "lq_open_chart")}
            </button>
          </p>
        </>
      )}
    </Frame>
  );
}

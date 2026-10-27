/**
 * Остальное на экране «Институциональные потоки»: запас фондов по дням,
 * позиции на CME по отчёту CFTC и крупнейшие держатели — фонды (из списка
 * фондов экрана) и публичные компании (по их отчётам в SEC).
 *
 * CME — то, как институционалы держат фьючерсы. Отчёт CFTC делит крупных
 * участников на управляющих активами (пенсионные и инвестиционные фонды),
 * хедж-фонды и дилеров (банки). Нетто — лонг минус шорт. Шорт хедж-фондов
 * обычно не ставка на падение: они держат ETF или монеты и продают фьючерс,
 * зарабатывая на разнице цен; экран так и говорит, когда картина такая.
 */
import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { t } from "../i18n/t";
import type { DictKey } from "../i18n/types";
import { num, usdWord } from "../lib/format";
import { haptic } from "../lib/telegram";
import { Card, Chips, SectionTitle } from "../components/ui";
import { type BtcHolder } from "../lib/etf";
import { dateStr, timeTicks } from "./timeAxis";
import { DN, UP, coinsShort, dateNb, flagOf, heightK, iso, money, tone, useWidth } from "./etfView";

type Lang = Parameters<typeof t>[0];
/**
 * Размер малого графика в настоящих пикселях ширины w (как у графика потоков,
 * geom в EtfScreen): справа — место под подписи оси, высота растёт с
 * шириной, но график помещается по высоте окна (heightK).
 */
function box(w: number, h: number) {
  const k = heightK(w, h + 26);
  return { W: w, PW: w - 58, MH: Math.round(h * k) };
}

/**
 * Линии на одной шкале и палец по дням. zero — шкала от нуля (позиции CME
 * бывают и в плюсе, и в минусе); без него — по самим значениям (запас
 * фондов: 1,2–1,3 млн у нуля лежал бы плоской линией). С клавиатуры —
 * стрелки, Home/End, Esc, как у графика потоков.
 */
function LinesChart({ xs, series, lang, fmt, axis = fmt, label, zero = true }: {
  xs: number[];
  series: { c: string; v: number[]; name: string }[];
  lang: Lang;
  fmt: (v: number) => string;
  /** Подписи оси — короче fmt: в 58 px справа «+99,3 тыс. BTC» не помещалось и налезало на линии. */
  axis?: (v: number) => string;
  label: string;
  zero?: boolean;
}) {
  const [picked, setSel] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const { W, PW, MH } = box(useWidth(ref), 130);
  const n = xs.length;
  /* Пришёл свежий ответ с другим числом точек — выбор за краем не держим. */
  const sel = picked !== null && picked < n ? picked : null;
  const all = series.flatMap((s) => s.v);
  const pad = zero ? 0 : (Math.max(...all) - Math.min(...all)) * 0.08 || 1;
  const lo = zero ? Math.min(0, ...all) : Math.min(...all) - pad;
  const hi = zero ? Math.max(0, ...all) : Math.max(...all) + pad;
  const span = hi - lo || 1;
  const yOf = (v: number) => 6 + (1 - (v - lo) / span) * MH;
  const xOf = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * PW);
  const a = xs[0] ?? 0;
  const b = xs[n - 1] ?? 1;
  const xOfT = (ts: number) => ((ts - a) / Math.max(1, b - a)) * PW;
  const ticksT = (() => {
    const tt = timeTicks(lang, a, b);
    const step = Math.max(1, Math.ceil(tt.length / Math.max(3, Math.floor(PW / 64))));
    return tt.filter((_, i) => (tt.length - 1 - i) % step === 0);
  })();
  const pick = (clientX: number) => {
    const el = ref.current;
    if (!el || !n) return;
    const box = el.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round((((clientX - box.left) / box.width) * W / PW) * (n - 1))));
    if (i !== sel) {
      haptic("select");
      setSel(i);
    }
  };
  const H = MH + 26;
  const onKey = (e: KeyboardEvent) => {
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
  return (
    <div className="fg-plot ef-plot" tabIndex={0} role="group" aria-label={t(lang, "ef_keys")}
      onKeyDown={onKey} onBlur={() => setSel(null)}>
      <svg ref={ref} className="fg-svg ef-svg" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label}
        onPointerDown={(e: PointerEvent) => pick(e.clientX)}
        onPointerMove={(e: PointerEvent) => { if (e.pointerType === "mouse" || e.buttons) pick(e.clientX); }}
        onPointerUp={(e: PointerEvent) => { if (e.pointerType !== "mouse") setSel(null); }}
        onPointerCancel={() => setSel(null)}
        onPointerLeave={() => setSel(null)}
        onContextMenu={(e: MouseEvent) => e.preventDefault()}>
        <rect x={0} y={6} width={PW} height={MH} className="fg-bg" />
        {ticksT.map((x) => (
          <g key={x.t}>
            <line x1={xOfT(x.t)} x2={xOfT(x.t)} y1={6} y2={6 + MH} className="fg-grid" />
            <text x={xOfT(x.t)} y={H - 4} textAnchor="middle" className="fg-tick">{x.label}</text>
          </g>
        ))}
        {(zero ? [hi, 0, lo] : [hi - pad, lo + pad]).filter((v, i, arr) => arr.indexOf(v) === i).map((v) => (
          <g key={v}>
            <line x1={0} x2={PW} y1={yOf(v)} y2={yOf(v)} className={v === 0 ? "ef-zero" : "fg-grid"} />
            <text x={W - 2} y={yOf(v) + 3.5} textAnchor="end" className="fg-tick">{v === 0 ? "0" : axis(v)}</text>
          </g>
        ))}
        {series.map((s) => (
          <polyline key={s.name} className="fg-line" stroke={s.c}
            points={s.v.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ")} />
        ))}
        {sel !== null ? (
          <g className="fg-cross">
            <line x1={xOf(sel)} x2={xOf(sel)} y1={6} y2={6 + MH} />
            {series.map((s) => <circle key={s.name} cx={xOf(sel)} cy={yOf(s.v[sel] ?? 0)} r={3.5} fill={s.c} />)}
          </g>
        ) : null}
      </svg>
      {sel !== null ? (
        <div className={sel > n / 2 ? "fg-pop left ef-pop" : "fg-pop ef-pop"} aria-live="polite">
          <small>{dateStr(lang, xs[sel]!, { day: "numeric", month: "long", year: "numeric" })}</small>
          {series.map((s) => (
            <span key={s.name} className="ef-pop-f"><i style={{ color: s.c }}>{s.name}</i> <bdi dir="ltr">{fmt(s.v[sel] ?? 0)}</bdi></span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------- */

/**
 * Сколько биткоинов держат фонды по дням: активы всех фондов (сводка TFTC)
 * по цене того же дня. Растёт — фонды забирают монеты, падает — отдают,
 * независимо от того, что делает цена.
 */
export function HeldSection({ series, lang }: { series: [number, number][]; lang: Lang }) {
  const last = series[series.length - 1];
  const first = series[0];
  if (!last || !first || series.length < 10) return null;
  const back = series.find(([ts]) => ts >= last[0] - 30 * 86400) ?? first;
  const fmt = (v: number) => coinsShort(lang, v, "", false);
  const tiles: [string, number, boolean][] = [
    [t(lang, "ef_hd_now"), last[1], false],
    [t(lang, "ef_hd_30"), last[1] - back[1], true],
    // С полной датой: «С 6 мая 2025 г.» — месяц без дня Intl даёт в именительном («С май»).
    [t(lang, "ef_hd_since", { d: dateStr(lang, first[0], { day: "numeric", month: "short", year: "numeric" }) }), last[1] - first[1], true],
  ];
  return (
    <>
      <SectionTitle>{t(lang, "ef_hd_title")}</SectionTitle>
      <Card>
        <div className="dm-chs three ef-chs">
          {tiles.map(([k, v, signed]) => (
            <div key={k} className="dm-ch">
              <small>{k}</small>
              <b className={signed ? tone(v) : ""}><bdi dir="ltr">{coinsShort(lang, v, "BTC", signed)}</bdi></b>
            </div>
          ))}
        </div>
        <LinesChart xs={series.map((d) => d[0])} lang={lang} fmt={fmt} zero={false} label={t(lang, "ef_hd_title")}
          series={[{ c: "#f7931a", name: "BTC", v: series.map((d) => d[1]) }]} />
        <p className="lq-hint">{t(lang, "ef_hd_note")}</p>
      </Card>
    </>
  );
}

export function CmeSection({ rows, sym, price, lang }: { rows: number[][]; sym: string; price: number; lang: Lang }) {
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  if (!last) return null;
  const net = (r: number[] | undefined, i: number) => (r ? (r[i] ?? 0) - (r[i + 1] ?? 0) : 0);
  const groups = [
    { key: "ef_cme_am" as DictKey, i: 2, c: "#60a5fa" },
    { key: "ef_cme_lev" as DictKey, i: 4, c: "#f472b6" },
    { key: "ef_cme_dl" as DictKey, i: 6, c: "#cbd5e1" },
    { key: "ef_cme_nr" as DictKey, i: 8, c: "#facc15" },
  ];
  const span = Math.max(1, ...groups.map((g) => Math.abs(net(last, g.i))));
  const levNet = net(last, 4);
  const amNet = net(last, 2);
  const xs = rows.map((r) => r[0]!);
  const fmt = (v: number) => coinsShort(lang, v, sym);
  /* Ось — две значащие цифры и без «BTC» (монеты подписаны в заголовке и подсказке). */
  const axis = (v: number) => {
    try {
      const f = new Intl.NumberFormat(lang, { notation: "compact", compactDisplay: "short", maximumSignificantDigits: 2 })
        .format(Math.abs(v)).replace(/[\u00a0\u202f]/g, " ");
      return `${v > 0 ? "+" : v < 0 ? "−" : ""}${f}`;
    } catch {
      return coinsShort(lang, v, "");
    }
  };
  return (
    <>
      {/* Карточка — из слов «лонг», «шорт», «открытый интерес»: их объяснение — тут же. */}
      <SectionTitle help={["ef_how_6", "q_ls_1", "oih_how_1"]}>{t(lang, "ef_cme_title")}</SectionTitle>
      <Card>
        <p className="ef-h-lead">
          {/* Дата — целиком, без «2026 / г.» на отдельной строке. */}
          {t(lang, "ef_cme_sub", { d: dateNb(lang, last[0]!, { day: "numeric", month: "long", year: "numeric" }) })}
        </p>
        <div className="ef-cme-oi">
          <small>{t(lang, "ef_cme_oi")}</small>
          <b><bdi dir="ltr">{coinsShort(lang, last[1]!, sym).replace(/^\+/, "")}</bdi></b>
          {price > 0 ? <span><bdi dir="ltr">{usdWord(last[1]! * price)}</bdi></span> : null}
        </div>
        <div className="ef-funds">
          {groups.map((g) => {
            const v = net(last, g.i);
            const d = v - net(prev, g.i);
            const r = Math.sqrt(Math.abs(v) / span);
            return (
              /* Своя раскладка, а не строка фонда: длинные названия групп и
                 «лонг · шорт» в три столбца не помещались и обрезались. */
              <div key={g.key} className="ef-cmr">
                <span className="ef-cmr-n"><i className="ef-dot" style={{ background: g.c }} />{t(lang, g.key)}</span>
                <b className={`ef-f-v ${tone(v)}`}><bdi dir="ltr">{fmt(v)}</bdi></b>
                <span className="ef-f-bar ef-cmr-bar">
                  <i className="ef-f-mid" />
                  <i className="ef-f-fill" style={v >= 0
                    ? { insetInlineStart: "50%", width: `${r * 50}%`, background: UP }
                    : { insetInlineEnd: "50%", width: `${r * 50}%`, background: DN }} />
                </span>
                <small className="ef-cmr-s">
                  {t(lang, "ef_cme_ls", { l: iso(coinsShort(lang, last[g.i]!, "").replace(/^\+/, "")), s: iso(coinsShort(lang, last[g.i + 1]!, "").replace(/^\+/, "")) })}
                  {/* Долларовая оценка — сразу за позицией: после «за неделю» она
                      читалась как недельное изменение, а это вся позиция. */}
                  {price > 0 ? ` · ${t(lang, "ef_cme_usd", { v: iso(money(v * price)) })}` : ""}
                  {prev ? ` · ${t(lang, "ef_cme_wk", { v: iso(fmt(d)) })}` : ""}
                </small>
              </div>
            );
          })}
        </div>
        {levNet < 0 && amNet > 0 ? <p className="ef-say">{t(lang, "ef_cme_basis")}</p> : null}
        {rows.length > 8 ? (
          <>
            <p className="ef-sub-t">{t(lang, "ef_cme_chart")}</p>
            <LinesChart
              xs={xs}
              lang={lang}
              fmt={fmt}
              axis={axis}
              label={t(lang, "ef_cme_chart")}
              series={[
                { c: "#60a5fa", name: t(lang, "ef_cme_am"), v: rows.map((r) => net(r, 2)) },
                { c: "#f472b6", name: t(lang, "ef_cme_lev"), v: rows.map((r) => net(r, 4)) },
              ]}
            />
            <div className="fg-legend">
              <span><i style={{ background: "#60a5fa" }} />{t(lang, "ef_cme_am")}</span>
              <span><i style={{ background: "#f472b6" }} />{t(lang, "ef_cme_lev")}</span>
            </div>
          </>
        ) : null}
        <p className="lq-hint">{t(lang, "ef_cme_note")}</p>
      </Card>
    </>
  );
}

const PAGE = 20;
const TAIL = 5;
type Group = "all" | BtcHolder[1];
const GROUPS: { id: Group; key: DictKey }[] = [
  { id: "all", key: "ef_h_all" },
  { id: "FUND", key: "ef_g_fund" },
  { id: "COMPANY", key: "ef_g_co" },
];

/** Крупнейшие держатели: фонды и компании, с выбором группы. */
export function Holders({ rows, price, lang }: { rows: BtcHolder[]; price: number; lang: Lang }) {
  const [picked, setGrp] = useState<Group>("all");
  const [shown, setShown] = useState(PAGE);
  /* Свежий ответ без выбранной группы (её кнопка пропала) — показываем всех,
     а не пустой список без способа вернуться. */
  const grp: Group = picked === "all" || rows.some((r) => r[1] === picked) ? picked : "all";
  const list = useMemo(() => rows.filter((r) => grp === "all" || r[1] === grp), [rows, grp]);
  /* Хвост до TAIL строк показываем сразу: кнопка «Показать ещё 1» — лишнее нажатие ради одной строки. */
  const lim = list.length - shown <= TAIL ? list.length : shown;
  if (!rows.length) return null;
  return (
    <>
      <SectionTitle>{t(lang, "ef_t_title")}</SectionTitle>
      <Card>
        <Chips<Group>
          value={grp}
          onChange={(g) => { haptic("select"); setGrp(g); setShown(PAGE); }}
          options={GROUPS.filter((g) => g.id === "all" || rows.some((r) => r[1] === g.id))
            .map((g) => ({ id: g.id, label: t(lang, g.key) }))}
        />
        <div className="ef-hl">
          {list.slice(0, lim).map((r, i) => (
            <div key={r[1] + r[3]} className="ef-hr">
              <span className="ef-hr-rank">{i + 1}</span>
              <span className="ef-hr-id">
                <b>{r[2] ? <span aria-hidden="true">{flagOf(r[2])} </span> : null}{r[0]}</b>
                <small>
                  {r[1] === "FUND" ? `${t(lang, "ef_g_fund")} · ` : ""}{r[3]}
                  {r[5] ? ` · ${t(lang, "ef_h_rep", { d: dateNb(lang, r[5], { day: "numeric", month: "short", year: "numeric" }) })}` : ""}
                </small>
              </span>
              <span className="ef-hr-v">
                <b><bdi dir="ltr">{num(r[4])} BTC</bdi></b>
                {price > 0 ? <small><bdi dir="ltr">{usdWord(r[4] * price)}</bdi></small> : null}
              </span>
            </div>
          ))}
        </div>
        {list.length > lim ? (
          <button type="button" className="dm-more" onClick={() => setShown((v) => v + PAGE)}>
            {t(lang, "ef_h_more", { n: num(list.length - lim - PAGE <= TAIL ? list.length - lim : PAGE) })}
          </button>
        ) : null}
        <p className="lq-hint">{t(lang, "ef_h_note")}</p>
      </Card>
    </>
  );
}

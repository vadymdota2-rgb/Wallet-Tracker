/**
 * Остальное на экране «Институциональные потоки»: позиции на CME по отчёту
 * CFTC, премия Coinbase и все держатели — с поиском и делением по группам.
 *
 * CME — то, как институционалы держат фьючерсы. Отчёт CFTC делит крупных
 * участников на управляющих активами (пенсионные и инвестиционные фонды),
 * хедж-фонды и дилеров (банки). Нетто — лонг минус шорт. Шорт хедж-фондов
 * обычно не ставка на падение: они держат ETF или монеты и продают фьючерс,
 * зарабатывая на разнице цен; экран так и говорит, когда картина такая.
 *
 * Премия Coinbase — на сколько процентов монета на Coinbase дороже, чем на
 * Binance. Coinbase — главная площадка фондов и компаний США, поэтому её
 * читают как спрос из Америки.
 */
import { useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { t } from "../i18n/t";
import type { DictKey } from "../i18n/types";
import { num, pct, px, usdWord } from "../lib/format";
import { haptic } from "../lib/telegram";
import { Card, Chips, SectionTitle } from "../components/ui";
import type { BtcHolder, EtfReply } from "../lib/types";
import { dateStr, timeTicks } from "./FearGreedScreen";

type Lang = Parameters<typeof t>[0];
const UP = "#0ecb81";
const DN = "#f6465d";
const iso = (x: string | number) => `⁦${x}⁩`;

const GROUPS: Record<string, { key: DictKey; c: string }> = {
  FUND: { key: "ef_g_fund", c: "#3b82f6" },
  PUBLIC_COMPANY: { key: "ef_g_pub", c: "#f7931a" },
  GOVERNMENT: { key: "ef_g_gov", c: "#a855f7" },
  DEFI: { key: "ef_g_defi", c: "#14b8a6" },
  PRIVATE_COMPANY: { key: "ef_g_priv", c: "#eab308" },
  EXCHANGE: { key: "ef_g_ex", c: "#94a3b8" },
};
const groupKey = (typ: string): DictKey => GROUPS[typ]?.key ?? "ef_g_other";

/** Монеты коротко: «40,4 тыс. BTC», «1,51 млн ETH». */
function coinsShort(lang: Lang, v: number, sym: string): string {
  const s = v > 0 ? "+" : v < 0 ? "−" : "";
  try {
    const f = new Intl.NumberFormat(lang, { notation: "compact", compactDisplay: "short", maximumFractionDigits: 1 })
      .format(Math.abs(v)).replace(/[  ]/g, " ");
    return `${s}${f} ${sym}`;
  } catch {
    return `${s}${num(Math.abs(v))} ${sym}`;
  }
}

function money(v: number): string {
  if (Math.abs(v) < 0.5) return usdWord(0);
  return `${v > 0 ? "+" : "−"}${usdWord(Math.abs(v))}`;
}

const W = 360;
const PW = 306;

/** Линии на одной шкале с нулём посередине и пальцем по дням. */
function LinesChart({ xs, series, lang, fmt, label }: {
  xs: number[];
  series: { c: string; v: number[]; name: string }[];
  lang: Lang;
  fmt: (v: number) => string;
  label: string;
}) {
  const [sel, setSel] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const n = xs.length;
  const MH = 130;
  const all = series.flatMap((s) => s.v);
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const span = hi - lo || 1;
  const yOf = (v: number) => 6 + (1 - (v - lo) / span) * MH;
  const xOf = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * PW);
  const a = xs[0] ?? 0;
  const b = xs[n - 1] ?? 1;
  const xOfT = (ts: number) => ((ts - a) / Math.max(1, b - a)) * PW;
  const ticksT = (() => {
    const tt = timeTicks(lang, a, b);
    const step = Math.max(1, Math.ceil(tt.length / 6));
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
  return (
    <div className="fg-plot">
      <svg ref={ref} className="fg-svg" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label}
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
        {[hi, 0, lo].filter((v, i, arr) => arr.indexOf(v) === i).map((v) => (
          <g key={v}>
            <line x1={0} x2={PW} y1={yOf(v)} y2={yOf(v)} className={v === 0 ? "ef-zero" : "fg-grid"} />
            <text x={W - 2} y={yOf(v) + 3.5} textAnchor="end" className="fg-tick">{v === 0 ? "0" : fmt(v)}</text>
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
  return (
    <>
      <SectionTitle>{t(lang, "ef_cme_title")}</SectionTitle>
      <Card>
        <p className="ef-h-lead">
          {t(lang, "ef_cme_sub", { d: dateStr(lang, last[0]!, { day: "numeric", month: "long", year: "numeric" }) })}
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
                <b className={v >= 0 ? "ef-f-v up" : "ef-f-v dn"}><bdi dir="ltr">{fmt(v)}</bdi></b>
                <span className="ef-f-bar ef-cmr-bar">
                  <i className="ef-f-mid" />
                  <i className="ef-f-fill" style={v >= 0
                    ? { insetInlineStart: "50%", width: `${r * 50}%`, background: UP }
                    : { insetInlineEnd: "50%", width: `${r * 50}%`, background: DN }} />
                </span>
                <small className="ef-cmr-s">
                  {t(lang, "ef_cme_ls", { l: iso(coinsShort(lang, last[g.i]!, "").trim().replace(/^\+/, "")), s: iso(coinsShort(lang, last[g.i + 1]!, "").trim().replace(/^\+/, "")) })}
                  {prev ? ` · ${t(lang, "ef_cme_wk", { v: iso(fmt(d)) })}` : ""}
                  {price > 0 ? ` · ${t(lang, "ef_cme_usd", { v: iso(money(v * price)) })}` : ""}
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

export function CbpSection({ d, sym, lang }: { d: { days: [number, number][]; now: number | null }; sym: string; lang: Lang }) {
  const days = d.days;
  const m30 = days.slice(-30);
  const avg = m30.length ? m30.reduce((s, x) => s + x[1], 0) / m30.length : 0;
  const plus = m30.filter((x) => x[1] > 0).length;
  const nowV = d.now ?? days[days.length - 1]?.[1] ?? 0;
  const fmt = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${num(Math.abs(v), 3)}%`;
  const view = days.slice(-180);
  const n = view.length;
  const maxAbs = Math.max(0.05, ...view.map((x) => Math.abs(x[1])));
  const MH = 90;
  const bw = PW / Math.max(1, n);
  const y0 = 6 + MH / 2;
  return (
    <>
      <SectionTitle>{t(lang, "ef_cbp_title")}</SectionTitle>
      <Card>
        <div className="dm-chs three ef-chs">
          <div className="dm-ch">
            <small>{t(lang, "ef_cbp_now")}</small>
            <b className={nowV >= 0 ? "up" : "dn"}><bdi dir="ltr">{fmt(nowV)}</bdi></b>
          </div>
          <div className="dm-ch">
            <small>{t(lang, "ef_cbp_avg")}</small>
            <b className={avg >= 0 ? "up" : "dn"}><bdi dir="ltr">{fmt(avg)}</bdi></b>
          </div>
          <div className="dm-ch">
            <small>{t(lang, "ef_cbp_plus")}</small>
            <b><bdi dir="ltr">{num(plus)} / {num(m30.length)}</bdi></b>
          </div>
        </div>
        <svg className="fg-svg" viewBox={`0 0 ${W} ${MH + 26}`} width="100%" role="img" aria-label={t(lang, "ef_cbp_title")}>
          <rect x={0} y={6} width={PW} height={MH} className="fg-bg" />
          {(() => {
            const a = view[0]?.[0] ?? 0;
            const b = view[n - 1]?.[0] ?? 1;
            return timeTicks(lang, a, b).filter((_, i, arr) => (arr.length - 1 - i) % Math.max(1, Math.ceil(arr.length / 6)) === 0).map((x) => {
              const xx = ((x.t - a) / Math.max(1, b - a)) * PW;
              return (
                <g key={x.t}>
                  <line x1={xx} x2={xx} y1={6} y2={6 + MH} className="fg-grid" />
                  <text x={xx} y={MH + 22} textAnchor="middle" className="fg-tick">{x.label}</text>
                </g>
              );
            });
          })()}
          <line x1={0} x2={PW} y1={y0} y2={y0} className="ef-zero" />
          <text x={W - 2} y={y0 + 3.5} textAnchor="end" className="fg-tick">0</text>
          <text x={W - 2} y={10 + 3.5} textAnchor="end" className="fg-tick">{fmt(maxAbs).replace(/\.?0+%$/, "%")}</text>
          {view.map((x, i) => {
            const h = (Math.abs(x[1]) / maxAbs) * (MH / 2 - 2);
            return x[1] === 0 ? null : (
              <rect key={x[0]} x={i * bw} width={Math.max(1, bw - 0.4)} y={x[1] > 0 ? y0 - h : y0} height={Math.max(0.8, h)}
                fill={x[1] > 0 ? UP : DN} opacity={0.85} />
            );
          })}
        </svg>
        <p className="lq-hint">{t(lang, "ef_cbp_what", { s: sym })}</p>
      </Card>
    </>
  );
}

const PAGE = 20;

export function HoldersAll({ h, price, lang }: { h: EtfReply["holders"]; price: number; lang: Lang }) {
  const [grp, setGrp] = useState<string>("all");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const top = h.top ?? [];
  const groups = (h.groups ?? []).map((g) => g[0]);
  const list = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return top.filter((r) => (grp === "all" || r[1] === grp)
      && (!qq || r[0].toLowerCase().includes(qq) || r[4].toLowerCase().includes(qq)));
  }, [top, grp, q]);
  const sum = list.reduce((s, r) => s + r[5], 0);
  const row = (r: BtcHolder, i: number) => (
    <div key={r[0] + i} className="ef-hr">
      <span className="ef-hr-rank">{i + 1}</span>
      <span className="ef-hr-id">
        <b>{r[3] ? `${r[3]} ` : ""}{r[0]}</b>
        <small>{t(lang, groupKey(r[1]))}{r[4] ? ` · ${r[4]}` : ""}
          {r[6] ? <em className={r[6] > 0 ? "up" : "dn"}> · <bdi dir="ltr">{coinsShort(lang, r[6], "BTC")}</bdi></em> : null}</small>
        {r[7] > 0 && r[5] > 0 && price > 0 ? (() => {
          const avg = r[7] / r[5];
          const gain = (price / avg - 1) * 100;
          return (
            <small className="ef-cost">
              {t(lang, "ef_cost", { p: iso(px(avg)) })}{" "}
              <em className={gain >= 0 ? "up" : "dn"}><bdi dir="ltr">{pct(gain, 0, true)}</bdi></em>
            </small>
          );
        })() : null}
      </span>
      <span className="ef-hr-v">
        <b><bdi dir="ltr">{num(r[5])} BTC</bdi></b>
        {price > 0 ? <small><bdi dir="ltr">{usdWord(r[5] * price)}</bdi></small> : null}
      </span>
    </div>
  );
  if (!top.length) return null;
  return (
    <>
      <SectionTitle>{t(lang, "ef_t_title")}</SectionTitle>
      <Card>
        <input
          className="find ef-find"
          type="search"
          value={q}
          placeholder={t(lang, "ef_h_search")}
          onChange={(e) => { setQ(e.target.value); setShown(PAGE); }}
          aria-label={t(lang, "ef_h_search")}
        />
        <Chips<string>
          value={grp}
          onChange={(g) => { haptic("select"); setGrp(g); setShown(PAGE); }}
          options={[{ id: "all", label: t(lang, "ef_h_all") }, ...groups.map((g) => ({ id: g, label: t(lang, groupKey(g)) }))]}
        />
        <p className="ef-fsum">
          <span>{t(lang, "ef_h_found", { n: iso(num(list.length)), b: iso(`${num(sum)} BTC`) })}</span>
        </p>
        {list.length ? (
          <div className="ef-hl">{list.slice(0, shown).map(row)}</div>
        ) : (
          <p className="lq-hint">{t(lang, "ef_h_none")}</p>
        )}
        {list.length > shown ? (
          <button type="button" className="dm-more" onClick={() => setShown((v) => v + PAGE * 2)}>
            {t(lang, "ef_h_more", { n: num(Math.min(PAGE * 2, list.length - shown)) })}
          </button>
        ) : null}
      </Card>
    </>
  );
}

export function AltHolders({ list, sym, price, lang }: { list: [string, string, number][]; sym: string; price: number; lang: Lang }) {
  const [all, setAll] = useState(false);
  if (!list.length) return null;
  const total = list.reduce((s, r) => s + r[2], 0);
  const shown = all ? list : list.slice(0, 12);
  return (
    <>
      <SectionTitle>{t(lang, "ef_a_title", { s: sym })}</SectionTitle>
      <Card>
        <p className="ef-h-lead">
          {t(lang, "ef_a_lead", { n: iso(num(list.length)), b: iso(`${num(total)} ${sym}`) })}
          {price > 0 ? ` ${t(lang, "ef_a_usd", { v: iso(usdWord(total * price)) })}` : ""}
        </p>
        <div className="ef-hl">
          {shown.map((r, i) => (
            <div key={r[0] + i} className="ef-hr">
              <span className="ef-hr-rank">{i + 1}</span>
              <span className="ef-hr-id">
                <b>{r[0]}</b>
                <small>{t(lang, groupKey(r[1]))}</small>
              </span>
              <span className="ef-hr-v">
                <b><bdi dir="ltr">{num(r[2])} {sym}</bdi></b>
                {price > 0 ? <small><bdi dir="ltr">{usdWord(r[2] * price)}</bdi></small> : null}
              </span>
            </div>
          ))}
        </div>
        {list.length > 12 ? (
          <button type="button" className="dm-more" onClick={() => setAll((v) => !v)}>
            {all ? t(lang, "dm_less") : t(lang, "dm_all", { n: num(list.length) })}
          </button>
        ) : null}
      </Card>
    </>
  );
}

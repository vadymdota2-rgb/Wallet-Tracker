/**
 * «Что скрыто в данных» — выводы по всей истории индекса страха и жадности
 * и цены биткоина, которых сервисы обычно не показывают: не само число, а
 * что после него обычно происходило.
 *
 * 1. Крайний страх — ещё не дно (и крайняя жадность — не вершина): после
 *    первого дня такой зоны — насколько цена уходила дальше и когда.
 * 2. Что было с ценой через 7 дней … 1 год после дня в каждой зоне:
 *    медиана и как часто BTC был выше.
 * 3. Если бы человек покупал на одну и ту же сумму каждый день — всегда,
 *    только в страхе или только в жадности.
 * 4. Похожие дни в прошлом — по уровню индекса, его ходу за месяц и ходу
 *    цены — и что было после них.
 * Плюс расхождение цены и настроения, если оно есть прямо сейчас.
 *
 * Всё считается здесь, по уже загруженной истории. Это история около двух
 * рыночных циклов, а не закон, и экран так и говорит.
 */
import { useMemo, useState } from "react";
import { t } from "../i18n/t";
import { num, pct, since, usd } from "../lib/format";
import { Card, Chips, SectionTitle, Segmented } from "../components/ui";
import { ZONES, afterEntry, analogs, dca, divergence, forward, zoneOf, type FngDay } from "../lib/fng";

type Lang = Parameters<typeof t>[0];

const ZC = ZONES.map((z) => z.c);
const ZK = ZONES.map((z) => z.key);
const zone = zoneOf;

/** Число внутри фразы — отдельным слева-направо фрагментом: в арабском
 *  «$163.4K» иначе превращалось в «163.4K$», а «52%» — в «%52». */
const iso = (x: string | number) => `\u2066${x}\u2069`;

const HORIZONS = ["7", "30", "90", "180", "365"] as const;
type Horizon = (typeof HORIZONS)[number];
const H_KEY: Record<Horizon, "fi_h7" | "fg_r30" | "fg_r90" | "fi_h180" | "fg_r1y"> = {
  "7": "fi_h7", "30": "fg_r30", "90": "fg_r90", "180": "fi_h180", "365": "fg_r1y",
};

export function FearGreedInsights({ lang, days }: { lang: Lang; days: readonly FngDay[] }) {
  const [h, setH] = useState<Horizon>("90");
  const [amount, setAmount] = useState(10);
  /* Годы покупок — с первого дня с ценой: где цены нет (запасная история
     Hyperliquid — с августа 2020), год дал бы тот же итог, что следующий. */
  const firstYear = new Date(((days.find((d) => d[2] > 0) ?? days[0])?.[0] ?? 0) * 1000).getUTCFullYear();
  const lastYear = new Date((days[days.length - 1]?.[0] ?? 0) * 1000).getUTCFullYear();
  const [picked, setYear] = useState(firstYear);
  const year = Math.max(picked, firstYear);

  const ef = useMemo(() => afterEntry(days, 0, true), [days]);
  const eg = useMemo(() => afterEntry(days, 4, false), [days]);
  const fwd = useMemo(() => forward(days, Number(h)), [days, h]);
  const sim = useMemo(() => analogs(days), [days]);
  const div = useMemo(() => divergence(days), [days]);
  const from = Date.UTC(year, 0, 1) / 1000;
  const plans = useMemo(() => ([
    ["fi_dca_all", () => true],
    ["fi_dca_fear", (z: number) => z <= 1],
    ["fi_dca_ef", (z: number) => z === 0],
    ["fi_dca_greed", (z: number) => z >= 3],
  ] as const).map(([k, pick]) => ({ k, ...dca(days, amount, from, pick) })), [days, amount, from]);
  const bestX = Math.max(1, ...plans.map((p) => (p.inv ? p.val / p.inv : 0)));
  const fwdMax = Math.max(0.01, ...fwd.map((f) => Math.abs(f.med)));

  const lastOf = (z: number) => {
    for (let i = days.length - 1; i >= 0; i--) if (zone(days[i]![1]) === z) return days.length - 1 - i;
    return -1;
  };
  /* Точное число дней, а не «в прошлом месяце»: разница в неделю тут важна. */
  const ago = (n: number) => {
    if (n <= 0) return t(lang, "fi_now");
    try {
      return new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(-n, "day");
    } catch {
      return since(n * 86400);
    }
  };
  const nowZone = days.length ? zone(days[days.length - 1]![1]) : -1;
  const efAgo = lastOf(0);
  const egAgo = lastOf(4);
  const years: number[] = [];
  for (let y = firstYear; y <= lastYear - 1; y++) years.push(y);

  return (
    <>
      <SectionTitle help={["fi_q_what", "fi_caveat"]}>{t(lang, "fi_title")}</SectionTitle>
      <p className="lq-lead">{t(lang, "fi_sub")}</p>

      {div ? (
        <div className={`fi-div ${div.kind}`}>
          {t(lang, div.kind === "hi" ? "fi_div_hi" : "fi_div_lo", { n: iso(num(div.n)), m: iso(pct(div.med * 100, 1, true)) })}
        </div>
      ) : null}

      {/* 1. Край — ещё не разворот. */}
      <SectionTitle help={["fi_q_edge", "fi_edge_note"]}>{t(lang, "fi_edge_t")}</SectionTitle>
      <Card>
        {([[ef, 0, "fi_ef_t", "fi_t_fell", "fi_t_bottom"], [eg, 4, "fi_eg_t", "fi_t_rose", "fi_t_top"]] as const).map(
          ([s, z, title, moveKey, whenKey]) => (
            <div key={z} className="fi-edge">
              <h3 style={{ color: ZC[z] }}>{t(lang, title)}</h3>
              <div className="fi-tiles">
                <div><b style={{ color: z === 0 ? "var(--dn)" : "var(--up)" }}>{pct(s.move * 100, 0, true)}</b><small>{t(lang, moveKey)}</small></div>
                <div><b>{t(lang, "fg_days", { n: num(s.days) })}</b><small>{t(lang, whenKey)}</small></div>
                <div><b>{num(s.n)}</b><small>{t(lang, "fi_t_times")}</small></div>
              </div>
              {z === 0 ? <p className="fi-note">{t(lang, "fi_ef_safe", { p: iso(pct(s.calm * 100, 0, false)) })}</p> : null}
            </div>
          ),
        )}
        <p className="fi-since">
          {t(lang, "fi_since", { a: efAgo < 0 ? "—" : ago(efAgo), b: egAgo < 0 ? "—" : ago(egAgo) })}
        </p>
      </Card>

      {/* 2. Что было с ценой после дня в каждой зоне. */}
      <SectionTitle help={["fi_fwd_hint", "fi_q_fwd"]}>{t(lang, "fi_fwd_t")}</SectionTitle>
      <Card>
        <Segmented<Horizon>
          value={h}
          onChange={setH}
          options={HORIZONS.map((x) => ({ id: x, label: t(lang, H_KEY[x]) }))}
        />
        <div className="fi-fwd">
          {fwd.map((f, z) => (
            <div key={z} className={z === nowZone ? "fi-fwd-r on" : "fi-fwd-r"}>
              <span><i style={{ background: ZC[z] }} />{t(lang, ZK[z]!)}
                {z === nowZone ? <em className="fi-nowtag">{t(lang, "fi_now")}</em> : null}</span>
              <div className="fi-bar">
                <i className={f.med >= 0 ? "up" : "dn"}
                  style={{ width: `${(Math.abs(f.med) / fwdMax) * 50}%`, [f.med >= 0 ? "left" : "right"]: "50%" }} />
              </div>
              <b className={f.med >= 0 ? "up" : "dn"}>{f.n ? pct(f.med * 100, 0, true) : "—"}</b>
              <small>{f.n ? t(lang, "fi_up", { p: iso(pct(f.up * 100, 0, false)) }) : ""}</small>
            </div>
          ))}
        </div>
      </Card>

      {/* 3. Если бы покупали каждый день. */}
      <SectionTitle help={["fi_q_dca"]}>{t(lang, "fi_dca_t")}</SectionTitle>
      <Card>
        <Chips<number>
          value={amount}
          options={[10, 50, 100].map((v) => ({ id: v, label: `${usd(v)} / ${t(lang, "fi_day")}` }))}
          onChange={setAmount}
        />
        <div className="fi-years">
          <small>{t(lang, "fi_from")}</small>
          <Chips<number> value={year} options={years.map((y) => ({ id: y, label: String(y) }))} onChange={setYear} />
        </div>
        <div className="fi-dca">
          {plans.map((p) => {
            const x = p.inv ? p.val / p.inv : 0;
            return (
              <div key={p.k} className="fi-dca-r">
                <span>{t(lang, p.k)}</span>
                <b className={x >= 1 ? "up" : "dn"}>×{num(x, 2)}</b>
                <div className="fi-dca-bar"><i style={{ width: `${(x / bestX) * 100}%` }} /></div>
                <small>{t(lang, "fi_dca_line", { inv: iso(usd(p.inv)), val: iso(usd(p.val)) })}</small>
              </div>
            );
          })}
        </div>
        <p className="fi-note">{t(lang, "fi_dca_note")}</p>
      </Card>

      {/* 4. Похожие дни в прошлом. */}
      <SectionTitle help={["fi_q_sim"]}>{t(lang, "fi_sim_t")}</SectionTitle>
      <Card>
        {sim && sim.n >= 10 ? (
          <>
            <p className="fi-text">
              {t(lang, "fi_sim_d", {
                v: iso(sim.v),
                c: iso(`${sim.c >= 0 ? "+" : "−"}${Math.abs(sim.c)}`),
                dir: t(lang, sim.up ? "fi_dir_up" : "fi_dir_dn"),
                n: iso(num(sim.n)),
              })}
            </p>
            <div className="fi-tiles">
              <div><b className={sim.med30 >= 0 ? "up" : "dn"}>{pct(sim.med30 * 100, 1, true)}</b>
                <small>{t(lang, "fi_sim_30", { p: iso(pct(sim.up30 * 100, 0, false)) })}</small></div>
              <div><b className={sim.med90 >= 0 ? "up" : "dn"}>{pct(sim.med90 * 100, 1, true)}</b>
                <small>{t(lang, "fi_sim_90", { p: iso(pct(sim.up90 * 100, 0, false)) })}</small></div>
            </div>
          </>
        ) : (
          <p className="fi-text">{t(lang, "fi_sim_none")}</p>
        )}
      </Card>

      <p className="fi-caveat">{t(lang, "fi_caveat")}</p>
    </>
  );
}

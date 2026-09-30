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

type Lang = Parameters<typeof t>[0];
type Day = [number, number, number];

const ZC = ["#ea3943", "#f5841f", "#f3d42f", "#93d900", "#16c784"];
const ZK = ["fg_z0", "fg_z1", "fg_z2", "fg_z3", "fg_z4"] as const;
const zone = (v: number) => (v <= 25 ? 0 : v <= 46 ? 1 : v <= 54 ? 2 : v <= 75 ? 3 : 4);

/** Число внутри фразы — отдельным слева-направо фрагментом: в арабском
 *  «$163.4K» иначе превращалось в «163.4K$», а «52%» — в «%52». */
const iso = (x: string | number) => `\u2066${x}\u2069`;

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * После начала зоны: куда цена ушла дальше за 90 дней и через сколько.
 * Началом считается первый день зоны после недели без неё: индекс часто
 * выскакивает из крайнего страха на день и возвращается, и такие «новые
 * начала» считали бы один и тот же эпизод по нескольку раз.
 */
const FRESH = 7;
function afterEntry(days: Day[], z: number, down: boolean) {
  const moves: number[] = [];
  const when: number[] = [];
  for (let i = FRESH; i < days.length - 90; i++) {
    if (zone(days[i]![1]) !== z || !(days[i]![2] > 0)) continue;
    let fresh = true;
    for (let k = i - FRESH; k < i; k++) if (zone(days[k]![1]) === z) fresh = false;
    if (!fresh) continue;
    const w = days.slice(i, i + 91).map((d) => d[2]).filter((p) => p > 0);
    const ext = down ? Math.min(...w) : Math.max(...w);
    moves.push(ext / days[i]![2] - 1);
    when.push(w.indexOf(ext));
  }
  return {
    n: moves.length,
    move: median(moves),
    days: median(when),
    calm: moves.length ? moves.filter((m) => m > -0.05).length / moves.length : 0,
  };
}

/** Цена через h дней после дня в каждой зоне: медиана и доля случаев выше. */
function forward(days: Day[], h: number) {
  return ZK.map((_, z) => {
    const r: number[] = [];
    for (let i = 0; i + h < days.length; i++) {
      const a = days[i]!;
      const b = days[i + h]!;
      if (zone(a[1]) === z && a[2] > 0 && b[2] > 0) r.push(b[2] / a[2] - 1);
    }
    return { n: r.length, med: median(r), up: r.length ? r.filter((x) => x > 0).length / r.length : 0 };
  });
}

/** Покупка на сумму в день с даты — только в дни, что проходят отбор. */
function dca(days: Day[], amount: number, from: number, pick: (z: number) => boolean) {
  let inv = 0;
  let btc = 0;
  for (const d of days) {
    if (d[0] < from || !(d[2] > 0) || !pick(zone(d[1]))) continue;
    inv += amount;
    btc += amount / d[2];
  }
  const last = days[days.length - 1]?.[2] ?? 0;
  return { inv, val: btc * last };
}

/** Похожие дни: индекс ±5, его ход за месяц ±10, цена за месяц в ту же сторону. */
function analogs(days: Day[]) {
  const n = days.length;
  const i0 = n - 1;
  if (n < 400) return null;
  const v = days[i0]![1];
  const c = v - days[i0 - 30]![1];
  const up = days[i0]![2] >= days[i0 - 30]![2];
  const r30: number[] = [];
  const r90: number[] = [];
  let count = 0;
  for (let i = 30; i < n - 30; i++) {
    const d = days[i]!;
    if (Math.abs(d[1] - v) > 5 || Math.abs(d[1] - days[i - 30]![1] - c) > 10) continue;
    if ((d[2] >= days[i - 30]![2]) !== up || !(d[2] > 0)) continue;
    count += 1;
    r30.push(days[i + 30]![2] / d[2] - 1);
    if (i + 90 < n) r90.push(days[i + 90]![2] / d[2] - 1);
  }
  const share = (a: number[]) => (a.length ? a.filter((x) => x > 0).length / a.length : 0);
  return { v, c, up, n: count, up30: share(r30), med30: median(r30), up90: share(r90), med90: median(r90) };
}

/** Расхождение сейчас: цена на краю 60 дней, а настроение — с другой стороны. */
function divergence(days: Day[]) {
  const n = days.length;
  const high = (i: number) => days[i]![2] >= Math.max(...days.slice(i - 60, i).map((d) => d[2]));
  const low = (i: number) => days[i]![2] <= Math.min(...days.slice(i - 60, i).map((d) => d[2]).filter((p) => p > 0));
  const hist = (test: (i: number) => boolean) => {
    const r: number[] = [];
    for (let i = 60; i < n - 30; i++) if (test(i)) r.push(days[i + 30]![2] / days[i]![2] - 1);
    return { n: r.length, med: median(r) };
  };
  const i0 = n - 1;
  if (n < 120) return null;
  if (high(i0) && days[i0]![1] <= 50) return { kind: "hi" as const, ...hist((i) => high(i) && days[i]![1] <= 50) };
  if (low(i0) && days[i0]![1] >= 50) return { kind: "lo" as const, ...hist((i) => low(i) && days[i]![1] >= 50) };
  return null;
}

const HORIZONS = ["7", "30", "90", "180", "365"] as const;
type Horizon = (typeof HORIZONS)[number];
const H_KEY: Record<Horizon, "fi_h7" | "fg_r30" | "fg_r90" | "fi_h180" | "fg_r1y"> = {
  "7": "fi_h7", "30": "fg_r30", "90": "fg_r90", "180": "fi_h180", "365": "fg_r1y",
};

export function FearGreedInsights({ lang, days }: { lang: Lang; days: Day[] }) {
  const [h, setH] = useState<Horizon>("90");
  const [amount, setAmount] = useState(10);
  const firstYear = new Date((days[0]?.[0] ?? 0) * 1000).getUTCFullYear();
  const lastYear = new Date((days[days.length - 1]?.[0] ?? 0) * 1000).getUTCFullYear();
  const [year, setYear] = useState(firstYear);

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
      <SectionTitle>{t(lang, "fi_title")}</SectionTitle>
      <p className="lq-lead">{t(lang, "fi_sub")}</p>

      {div ? (
        <div className={`fi-div ${div.kind}`}>
          {t(lang, div.kind === "hi" ? "fi_div_hi" : "fi_div_lo", { n: iso(num(div.n)), m: iso(pct(div.med * 100, 1, true)) })}
        </div>
      ) : null}

      {/* 1. Край — ещё не разворот. */}
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
        <p className="fi-note">{t(lang, "fi_edge_note")}</p>
        <p className="fi-since">
          {t(lang, "fi_since", { a: efAgo < 0 ? "—" : ago(efAgo), b: egAgo < 0 ? "—" : ago(egAgo) })}
        </p>
      </Card>

      {/* 2. Что было с ценой после дня в каждой зоне. */}
      <Card>
        <h3 className="fi-h">{t(lang, "fi_fwd_t")}</h3>
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
        <p className="fi-note">{t(lang, "fi_fwd_hint")}</p>
      </Card>

      {/* 3. Если бы покупали каждый день. */}
      <Card>
        <h3 className="fi-h">{t(lang, "fi_dca_t")}</h3>
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
      <Card>
        <h3 className="fi-h">{t(lang, "fi_sim_t")}</h3>
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

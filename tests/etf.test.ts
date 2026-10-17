/* «Институциональные потоки» — проверка ответа и расчёты: npm test (node --test). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ETF_LAUNCH, assets, chartView, heldSeries, cumulative, daily, etfStats, fundTotals, holderRow, lastDays, minedPerDay, topFunds, validEtf, weekly,
  type EtfCoin, type EtfDay, type EtfReply,
} from "../src/lib/etf.ts";

// Настоящий ответ сервера от 17.10.2026 — общий образец с тестами сервера и браузера.
const REAL = JSON.parse(readFileSync(new URL("./fixtures/etf.json", import.meta.url), "utf8")) as EtfReply & { now: number };
const NOW = REAL.now;
const DAY = 86_400;
const MON = 1_791_763_200; // понедельник, 12 октября 2026 г.

const clone = <T>(v: T): T => structuredClone(v);
function coin(days: EtfDay[], funds = ["IBIT", "FBTC"]): EtfCoin {
  return { funds: funds.map((t) => ({ t, n: "", aum: 1e9, hold: 10_000, fee: 0.25, cum: 0, cumc: 0 })), days, share: null };
}

test("validEtf: настоящий ответ годится, копия — только известные поля", () => {
  const v = validEtf(REAL, NOW);
  assert.ok(v);
  assert.equal(v.coins.btc!.days.length, REAL.coins.btc!.days.length);
  assert.equal(v.coins.btc!.funds.length, 13);
  assert.ok(v.holders && v.holders.length > 10);
  assert.ok(v.cme?.btc?.length && v.cbp?.btc?.days.length);
  // Лишнее от сервера (или подменённого ответа) в копию не идёт.
  const extra = { ...clone(REAL), junk: "x".repeat(1000), __proto__: { evil: 1 } } as unknown;
  const got = validEtf(extra, NOW) as unknown as Record<string, unknown>;
  assert.equal(got["junk"], undefined);
  assert.equal(got["now"], undefined);
  assert.deepEqual(Object.keys(got).sort(), ["at", "cbp", "cme", "coins", "holders", "ok"]);
  // Повторная проверка копии даёт то же самое.
  assert.deepEqual(validEtf(v, NOW), v);
});

test("validEtf: мусор и испорченные потоки не годятся", () => {
  const bad: ((r: EtfReply) => unknown)[] = [
    () => null, () => "x", () => 42, () => ({}), (r) => ({ ...r, ok: false }), (r) => ({ ...r, at: 0 }),
    (r) => ({ ...r, at: NOW + 30 * DAY }), (r) => ({ ...r, coins: {} }), (r) => ({ ...r, coins: { btc: null } }),
    (r) => { r.coins.btc!.funds[0]!.t = "<b>"; return r; },
    (r) => { r.coins.btc!.funds[1]!.t = r.coins.btc!.funds[0]!.t; return r; },
    (r) => { r.coins.btc!.funds[0]!.aum = Number.NaN; return r; },
    (r) => { r.coins.btc!.funds[0]!.fee = 50; return r; },
    (r) => { (r.coins.btc!.funds[0] as unknown as Record<string, unknown>)["c"] = "USA"; return r; },
    (r) => { r.coins.btc!.days[3]![4].pop(); return r; },
    (r) => { r.coins.btc!.days[3]![1] = Infinity; return r; },
    (r) => { r.coins.btc!.days[3]![1] = 5e9; return r; }, // $5 трлн за день
    (r) => { r.coins.btc!.days[3]![0] += 3600; return r; }, // не начало суток
    (r) => { r.coins.btc!.days.reverse(); return r; },
    (r) => { r.coins.btc!.days[4]![0] = r.coins.btc!.days[3]![0]; return r; }, // один день дважды
    (r) => { r.coins.btc!.days.push([NOW - (NOW % DAY) + 10 * DAY, 1, 1, 1, r.coins.btc!.funds.map(() => null)]); return r; },
    (r) => { r.coins.btc!.days[0]![0] = ETF_LAUNCH - 30 * DAY; return r; },
    (r) => { r.coins.btc!.days[3]![4][0] = "5" as unknown as number; return r; },
    (r) => { r.coins.btc!.days = []; return r; },
    (r) => { r.coins.btc!.share = 150; return r; },
    (r) => { r.coins.btc!.through = "<script>"; return r; },
  ];
  bad.forEach((f, i) => assert.equal(validEtf(f(clone(REAL)), NOW), null, `случай ${i}`));
});

test("validEtf: испорченные дополнения пропадают, потоки остаются", () => {
  const r = clone(REAL) as unknown as Record<string, unknown>;
  r["holders"] = { IBIT: 1 }; // старый сервер присылал объект
  r["cme"] = { btc: [[1, 2, 3]] };
  r["cbp"] = { btc: { days: [[1, "x"]], now: 0 } };
  const v = validEtf(r, NOW);
  assert.ok(v);
  assert.equal(v.holders, undefined);
  assert.equal(v.cme, undefined);
  assert.equal(v.cbp, undefined);
  // Битые строки держателей отсеиваются по одной.
  const h = clone(REAL);
  h.holders = [...h.holders!, ["<b>", "FUND", "US", "x y", 1, 0] as never, ["A", "STATE", "US", "A", 1, 0] as never];
  assert.equal(validEtf(h, NOW)!.holders!.length, REAL.holders!.length);
  assert.equal(holderRow(["Strategy", "COMPANY", "US", "MSTR", 846_000, 1_782_777_600]), true);
  assert.equal(holderRow(["Strategy", "COMPANY", "US", "MSTR", -1, 0]), false);
});

test("недели: с понедельника, суммы сохраняются", () => {
  const days: EtfDay[] = [
    [MON - 3 * DAY, 10, 1, 100, [10, null]], // пятница прошлой недели
    [MON - 1 * DAY, 0, 0, 0, [0, 0]], // воскресенье — ещё прошлая неделя
    [MON, 20, 2, 110, [15, 5]],
    [MON + 1 * DAY, -5, -1, 120, [null, -5]],
    [MON + 4 * DAY, 7, 1, 0, [7, 0]], // пятница, цены нет — остаётся прошлая
    [MON + 7 * DAY, 1, 0.1, 130, [1, 0]],
  ];
  const w = weekly(days, 2);
  assert.deepEqual(w.map((b) => [b.a, b.b, b.usd, b.px]), [
    [MON - 3 * DAY, MON - DAY, 10, 100], [MON, MON + 4 * DAY, 22, 120], [MON + 7 * DAY, MON + 7 * DAY, 1, 130],
  ]);
  assert.deepEqual(w[1]!.per, [22, 0]);
  assert.equal(w.reduce((s, b) => s + b.usd, 0), days.reduce((s, d) => s + d[1], 0));
  assert.deepEqual(daily(days, 2)[0]!.per, [10, 0]);
});

test("график: окна, по дням и по неделям, накопленное от всей истории", () => {
  const c = validEtf(REAL, NOW)!.coins.btc!;
  const end = c.days[c.days.length - 1]![0];
  assert.ok(chartView(c.days, c.funds.length, "90").every((b) => b.a === b.b)); // 90 дней — по дням
  const d30 = chartView(c.days, c.funds.length, "30");
  assert.ok(d30.length <= 30 && d30.length >= 18);
  assert.ok(d30.every((b) => b.a > end - 30 * DAY && b.a === b.b));
  const y = chartView(c.days, c.funds.length, "365");
  assert.ok(y.length >= 50 && y.length <= 54);
  const all = chartView(c.days, c.funds.length, "all");
  const total = c.days.reduce((s, d) => s + d[1], 0);
  assert.equal(Math.round(all.reduce((s, b) => s + b.usd, 0)), Math.round(total));
  // Накопленное в последнем столбце любого окна — весь поток с запуска.
  for (const r of ["30", "90", "365", "all"] as const) {
    const v = chartView(c.days, c.funds.length, r);
    assert.equal(Math.round(cumulative(v, c.days).at(-1)!), Math.round(total), r);
  }
});

test("итоги: серия, рекорды, месяцы без идущего, добыча", () => {
  const days: EtfDay[] = [
    [MON - 40 * DAY, 100, 1, 100, [100, null]], // начало сентября
    [MON - 39 * DAY, -300, -3, 100, [-300, null]],
    [MON - 10 * DAY, 50, 0.5, 100, [25, 25]], // октябрь
    [MON - 9 * DAY, -20, -0.2, 100, [-20, null]],
    [MON - 3 * DAY, 30, 0.3, 100, [30, null]],
    [MON, 40, 0.4, 100, [0, 40]],
    [MON + DAY, 50, 0.5, 100, [50, null]],
  ];
  const s = etfStats(coin(days), MON + 2 * DAY)!;
  assert.equal(s.last, days[6]);
  assert.equal(s.sign, 1);
  assert.equal(s.streak, 3);
  assert.equal(s.best[1], 100);
  assert.equal(s.worst[1], -300);
  assert.deepEqual(s.runs.up, { n: 3, at: MON - 3 * DAY });
  assert.deepEqual(s.runs.dn, { n: 1, at: MON - 39 * DAY });
  // Идущий месяц (октябрь) — не в рекордах: лучший и худший — сентябрь.
  assert.equal(s.bestM?.[1], -200);
  assert.equal(s.worstM?.[1], -200);
  assert.equal(s.d7, (30 + 40 + 50) * 1000);
  assert.equal(s.cum, (100 - 300 + 50 - 20 + 30 + 40 + 50) * 1000);
  assert.equal(s.mined, 30 * 450);
  assert.equal(s.held, 20_000);
  assert.equal(etfStats(coin([]), NOW), null);
  // Последний день без движения — серии нет (нули подряд — не серия).
  const zero = etfStats(coin([...days, [MON + 2 * DAY, 0, 0, 100, [0, null]]]), MON + 3 * DAY)!;
  assert.equal(zero.streak, 0);
  // Часы уже в ноябре, последний день — в октябре: октябрь завершён и в рекордах.
  const nov = etfStats(coin(days), Date.UTC(2026, 10, 2) / 1000)!;
  assert.equal(nov.bestM?.[1], 150);
});

test("фонды за срок: день, неделя, месяц, с запуска", () => {
  const days: EtfDay[] = [[MON - 20 * DAY, 0, 0, 0, [500, -100]], [MON - 6 * DAY, 0, 0, 0, [2, null]],
    [MON - 3 * DAY, 0, 0, 0, [7, null]], [MON, 0, 0, 0, [-3, 1]]];
  const c = coin(days);
  c.funds[0]!.cum = 9e6;
  c.funds[1]!.cum = -1e6;
  // $1 тыс. — уже движение.
  assert.deepEqual(fundTotals(c, "d").moving.map((r) => [r.f.t, r.v]), [["FBTC", 1], ["IBIT", -3]]);
  assert.equal(fundTotals(c, "d").still, 0);
  assert.deepEqual(fundTotals(c, "w").moving.map((r) => r.v), [6, 1]); // 7 суток — со вторника прошлой недели
  const m = fundTotals(c, "m");
  assert.deepEqual([m.ins, m.outs, m.span], [506, -99, 506]);
  assert.deepEqual(fundTotals(c, "all").moving.map((r) => [r.f.t, r.v]), [["IBIT", 9000], ["FBTC", -1000]]);
  assert.deepEqual(topFunds(c.funds, daily(days, 2)[0]!), [{ t: "IBIT", v: 500 }, { t: "FBTC", v: -100 }]);
  // По модулю: отток −600 крупнее притока 500.
  const b = daily([[MON, 0, 0, 0, [500, -600]]], 2)[0]!;
  assert.deepEqual(topFunds(c.funds, b, 1), [{ t: "FBTC", v: -600 }]);
  assert.deepEqual(lastDays(days, 7).map((d) => d[0]), [MON - 6 * DAY, MON - 3 * DAY, MON]);
});

test("добыча за сутки: 900 → 450 → 225 по халвингам", () => {
  assert.equal(minedPerDay(1_713_571_199), 900);
  assert.equal(minedPerDay(1_713_571_200), 450);
  assert.equal(minedPerDay(1_838_899_999), 450);
  assert.equal(minedPerDay(1_838_900_000), 225);
});

test("настоящие цифры: итог дня — сумма фондов, «с запуска» везде одно", () => {
  const c = validEtf(REAL, NOW)!.coins.btc!;
  for (const d of c.days) {
    const known = d[4].filter((v): v is number => v !== null);
    if (known.length) assert.ok(Math.abs(known.reduce((s, v) => s + v, 0) - d[1]) <= known.length, String(d[0]));
  }
  const s = etfStats(c, NOW)!;
  const funds = c.funds.reduce((sum, f) => sum + f.cum, 0);
  assert.ok(Math.abs(s.cum - funds) < 1e6, `${s.cum} ≠ ${funds}`); // до округления фондов до доллара
  assert.ok(s.held > 1_000_000 && s.held < 2_000_000);
});

test("активы фондов по дням: проверка ряда, свежесть, запас в монетах", () => {
  const v = validEtf(REAL, NOW)!;
  const c = v.coins.btc!;
  assert.equal(c.tna!.length, 364);
  // Свежая сводка: активы того дня по цене сейчас, запас — по цене того дня.
  const a = assets(c);
  const t = c.tna!.at(-1)!;
  const px = c.days.find((d) => d[0] === t[0])![3];
  assert.equal(a.src, "tna");
  assert.equal(a.held, t[1] / px);
  assert.equal(a.aum, (t[1] * c.px!) / px);
  // Сводка старше недели — свои оценки по фондам.
  const old = structuredClone(c);
  old.tna = old.tna!.filter((d) => d[0] < t[0] - 8 * DAY);
  assert.equal(assets(old).src, "funds");
  assert.equal(assets(old).held, old.funds.reduce((s, f) => s + (f.hold ?? 0), 0));
  // Запас по дням: в монетах, правдоподобный (миллион с лишним).
  const h = heldSeries(c);
  assert.equal(h.length, 364);
  assert.ok(h.every(([, b]) => b > 900_000 && b < 1_600_000));
  // День без цены — в запас по дням не идёт (на ноль не делим).
  const nopx = structuredClone(c);
  nopx.days.find((d) => d[0] === t[0])![3] = 0;
  assert.equal(heldSeries(nopx).length, 363);
  assert.ok(heldSeries(nopx).every(([, b]) => Number.isFinite(b) && b < 1_600_000));
  // Испорченный ряд пропадает, потоки остаются.
  for (const bad of [[[1, 2]], [[t[0], 1e20]], [[t[0], 5e10], [t[0], 5e10]], "x", [[t[0] + 1, 5e10]]]) {
    const r = structuredClone(REAL) as unknown as { coins: { btc: Record<string, unknown> } };
    r.coins.btc["tna"] = bad;
    const got = validEtf(r, NOW);
    assert.ok(got);
    assert.equal(got.coins.btc!.tna, undefined);
  }
});

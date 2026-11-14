/* Скринер графика и Фибо от лоя (src/lib/screener.ts, src/lib/fibo.ts): npm test. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANY, badgeTfs, chartTf, chase, confirms, consensus, EXTRA_ANY, find, late, mainTf, matches, nextWant, pending, picked, PRESETS, rr,
  SCREEN_TFS, SCREEN_WARM, screen, signal, SINCE_MAX, toggleCol, validCols, validExtra, validFilter, validScreener, wanted,
  type Metrics, type ScreenRow,
} from "../src/lib/screener.ts";
import { FIBO_LEVELS, fiboFromLow, fiboPlan, swingDev } from "../src/lib/fibo.ts";
import { rateKey } from "../src/chart/indicators.ts";
import type { Bar } from "../src/chart/data.ts";

const NOW = 1_794_100_000;
const NONE = Object.fromEntries(SCREEN_TFS.map((tf) => [tf, null])) as ScreenRow["r"];
const row = (s: string, r: Partial<Record<(typeof SCREEN_TFS)[number], number | null>>): ScreenRow =>
  ({ s, px: 1, ch: 0, fut: false, r: { ...NONE, ...r }, m: {} });
const NOM: Metrics = { ma: null, osc: null, rsi: null, adx: null, volx: null, atrp: null, tp: null, sl: null, mv: null, age: null };
/** Строка с метриками на 15m. */
const mrow = (s: string, k: Partial<Metrics>, ch: number | null = 0, r15 = 0.3): ScreenRow =>
  ({ s, px: 1, ch, fut: false, r: { ...NONE, "15m": r15 }, m: { "15m": { ...NOM, ...k } } });

test("ответ скринера: только годные строки, рейтинг от −1 до +1, повторы и мусор — мимо", () => {
  const raw = {
    ok: true, at: NOW - 60, tfs: ["15m", "1h", "1m", "evil"], rows: [
      { s: "BTC", px: 100000, ch: 1.5, r: { "15m": 0.6, "1h": -0.3, "4h": 2, "1d": "x", "1m": 0.2, "2m": 0.5 } },
      { s: "BTC", px: 1, ch: 0, r: { "15m": 0.1 } }, // повтор — первый
      { s: "<B>", px: 1, ch: 0, r: { "15m": 0.1 } },
      { s: "ETH", px: -1, ch: 1e9, r: { "15m": -0.2 } },
      { s: "SOL", r: { "15m": null } }, // ни одного рейтинга — мимо
      { s: "DOGE", r: "x" },
      null, 5,
    ],
  };
  const v = validScreener(raw, NOW)!;
  assert.deepEqual(v.rows, [
    { s: "BTC", px: 100000, ch: 1.5, fut: false, r: { ...NONE, "15m": 0.6, "1h": -0.3, "1m": 0.2 }, m: {} },
    { s: "ETH", px: null, ch: null, fut: false, r: { ...NONE, "15m": -0.2 }, m: {} },
  ]);
  assert.deepEqual(v.warm, ["1m", "15m", "1h"]); // только известные таймфреймы, по порядку
  assert.equal(SCREEN_TFS.length, 14);
  for (const bad of [null, "x", { ok: false }, { ok: true, at: NOW, rows: [] }, { ok: true, at: NOW - 4 * 86_400, rows: raw.rows },
    { ok: true, at: NOW + 2 * 86_400, rows: raw.rows }, { ok: true, at: 1.5, rows: raw.rows }, { ok: false, at: NOW, rows: raw.rows },
    { ok: "true", at: NOW, rows: raw.rows }, { ok: 1, at: NOW, rows: raw.rows }, { ok: true, at: NOW - 60.5, rows: raw.rows }]) {
    assert.equal(validScreener(bad, NOW), null, JSON.stringify(bad).slice(0, 60));
  }
});

test("слово рейтинга — те же пороги, что у графика (rateKey)", () => {
  const key = ["chart_r_ss", "chart_r_s", "chart_r_n", "chart_r_b", "chart_r_sb"];
  for (let v = -1; v <= 1.0001; v += 0.005) {
    const x = +v.toFixed(3);
    assert.equal(key[signal(x) + 2], rateKey(x), String(x));
  }
  for (const x of [-0.5, -0.1, 0.1, 0.5]) assert.equal(key[signal(x) + 2], rateKey(x), String(x));
});

test("фильтр: на выбранных таймфреймах — нужный знак, нет рейтинга — не подходит; порядок — по силе сигнала", () => {
  const rows = [
    row("A", { "15m": 0.6, "1h": -0.3 }),
    row("B", { "15m": 0.35, "1h": -0.6 }),
    row("C", { "15m": 0.05, "1h": -0.9 }), // 15m нейтрально — не покупка
    row("D", { "15m": 0.9 }), // часа нет — не подходит
    row("E", { "15m": -0.4, "1h": 0.5 }),
  ];
  const ub = PRESETS.find((p) => p.key === "scr_p_ub")!.f;
  assert.deepEqual(screen(rows, ub).map((r) => r.s), ["B", "A"]);
  assert.deepEqual(screen(rows, PRESETS.find((p) => p.key === "scr_p_bu")!.f).map((r) => r.s), ["E"]);
  assert.deepEqual(screen(rows, ANY).map((r) => r.s), ["A", "B", "C", "D", "E"]); // без фильтра — как прислал сервер
  assert.equal(matches(row("X", {}), ANY), true);
  assert.equal(matches(row("X", { "1d": 0.11 }), { ...ANY, "1d": "buy" }), true);
  assert.equal(matches(row("X", { "1d": 0.1 }), { ...ANY, "1d": "buy" }), false);
  assert.equal(matches(row("X", { "1d": -0.11 }), { ...ANY, "1d": "sell" }), true);
  // Равная сила — порядок сервера (по обороту).
  assert.deepEqual(screen([row("P", { "4h": 0.3 }), row("Q", { "4h": 0.3 })], { ...ANY, "4h": "buy" }).map((r) => r.s), ["P", "Q"]);
});

test("все таймфреймы: касание — любой → покупка → продажа; серверу — только не основные; ждём — выбранные без рейтинга", () => {
  assert.deepEqual([nextWant("any"), nextWant("buy"), nextWant("sell")], ["buy", "sell", "any"]);
  const f = { ...ANY, "1m": "buy" as const, "15m": "sell" as const, "1w": "buy" as const };
  assert.deepEqual(picked(f), ["1m", "15m", "1w"]);
  assert.deepEqual(wanted(f), ["1m", "1w"]); // 15m сервер считает всегда
  assert.deepEqual(wanted(ANY), []);
  const reply = { at: NOW, rows: [], warm: [...SCREEN_WARM, "1m" as const] };
  assert.deepEqual(pending(f, reply), ["1w"]);
  assert.deepEqual(pending(f, null), ["1m", "15m", "1h", "4h", "1d", "1w"]); // ответа нет — ждём и столбцы
  assert.deepEqual(pending(f, null, []), ["1m", "15m", "1w"]);
  assert.deepEqual(badgeTfs(ANY), [...SCREEN_WARM]);
  // Значки — все столбцы и все таймфреймы фильтра, по порядку.
  assert.deepEqual(badgeTfs({ ...ANY, "1m": "buy", "3m": "buy", "5m": "sell", "30m": "buy", "2h": "sell" }),
    ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"]);
  assert.deepEqual(badgeTfs({ ...ANY, "1w": "buy" }, ["5m", "1h"]), ["5m", "1h", "1w"]);
  assert.deepEqual(badgeTfs(ANY, []), []);
  // Фильтр по минутному таймфрейму работает так же, как по основным.
  assert.deepEqual(screen([row("A", { "1m": 0.6 }), row("B", { "1m": -0.6 }), row("C", {})], { ...ANY, "1m": "buy" }).map((r) => r.s), ["A"]);
});

test("поиск монеты в списке — по началу тикера, без учёта регистра и мусора", () => {
  const rows = [row("BTC", { "15m": 0.2 }), row("BNB", { "15m": 0.2 }), row("WBTC", { "15m": 0.2 })];
  assert.deepEqual(find(rows, "b").map((r) => r.s), ["BTC", "BNB"]);
  assert.deepEqual(find(rows, " bt<c ").map((r) => r.s), ["BTC"]);
  assert.deepEqual(find(rows, "").map((r) => r.s), ["BTC", "BNB", "WBTC"]);
});

test("таймфрейм графика после касания — младший из выбранных; фильтр с устройства — только известные значения", () => {
  assert.equal(chartTf(ANY), null);
  assert.equal(chartTf({ ...ANY, "4h": "sell", "1h": "buy" }), "1h");
  assert.equal(chartTf({ ...ANY, "1M": "sell", "5m": "buy" }), "5m");
  assert.equal(chartTf(PRESETS[0]!.f), "15m");
  assert.deepEqual(validFilter({ "15m": "buy", "1h": "x", "4h": "sell", "1m": "sell", evil: "buy" }), { ...ANY, "15m": "buy", "4h": "sell", "1m": "sell" });
  assert.deepEqual(validFilter(null), ANY);
});

/** Свечи: спад со 100 до лоя 80, потом рост до 95 (или без роста). */
function bars(rise: number, n = 300): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const mid = i <= 200 ? 100 - (20 * i) / 200 : 80 + (rise * (i - 200)) / (n - 201);
    const w = Math.sin(i / 3) * 0.4;
    const o = mid + w;
    const c = mid - w * 0.5;
    out.push({ t: i * 60_000, o, h: Math.max(o, c) + 0.3, l: i === 200 ? 80 : Math.max(Math.min(o, c) - 0.3, 80.5), c, v: 1 });
  }
  return out;
}

test("Фибо от лоя: от последней впадины до вершины после неё, тейки выше цены, стоп — лой", () => {
  const f = fiboFromLow(bars(15))!;
  assert.equal(f.mode, "up");
  assert.equal(f.lo.p, 80);
  assert.equal(f.lo.t, 200 * 60_000);
  assert.ok(f.hi.p > 94 && f.hi.p < 96, String(f.hi.p));
  assert.deepEqual(f.levels.map((x) => x.lv), FIBO_LEVELS);
  for (const x of f.levels) {
    assert.ok(Math.abs(x.p - (80 + (f.hi.p - 80) * x.lv)) < 1e-9);
    assert.ok(Math.abs(x.pct - (x.p / f.px - 1) * 100) < 1e-9);
  }
  const plan = fiboPlan(f);
  assert.ok(plan.tp.length >= 1 && plan.tp.length <= 3);
  for (const x of plan.tp) assert.ok(x.p > f.px);
  for (let i = 1; i < plan.tp.length; i++) assert.ok(plan.tp[i]!.p > plan.tp[i - 1]!.p); // ближний — первый
  for (const x of plan.sup) assert.ok(x.p < f.px && x.lv > 0);
  for (let i = 1; i < plan.sup.length; i++) assert.ok(plan.sup[i]!.p < plan.sup[i - 1]!.p);
  assert.equal(plan.stop.lv, 0);
  assert.equal(plan.stop.p, 80);
  assert.ok(plan.stop.pct < 0);
});

test("свежий лой (роста после него ещё нет) — цели отскока до прошлой вершины; мало свечей — нет Фибо", () => {
  const b = bars(0.2);
  const f = fiboFromLow(b)!;
  assert.equal(f.mode, "bounce");
  assert.equal(f.lo.p, 80);
  assert.ok(f.hi.t < f.lo.t, "вершина — до лоя");
  assert.ok(f.hi.p > 95, String(f.hi.p));
  assert.ok(fiboPlan(f).tp.every((x) => x.p > f.px));
  assert.equal(fiboFromLow(b.slice(0, 19)), null);
  // Ровная цена — размаха нет.
  const flat: Bar[] = Array.from({ length: 100 }, (_, i) => ({ t: i, o: 5, h: 5, l: 5, c: 5, v: 1 }));
  assert.equal(fiboFromLow(flat), null);
});

test("порог разворота — три ATR к цене, от 1 до 20 %", () => {
  assert.ok(swingDev(bars(15)) >= 1 && swingDev(bars(15)) <= 20);
  const calm: Bar[] = Array.from({ length: 100 }, (_, i) => ({ t: i, o: 100, h: 100.01, l: 99.99, c: 100, v: 1 }));
  assert.equal(swingDev(calm), 1);
  const wild: Bar[] = Array.from({ length: 100 }, (_, i) => ({ t: i, o: 100, h: 160, l: 50, c: 100, v: 1 }));
  assert.equal(swingDev(wild), 20);
  assert.equal(swingDev(calm.slice(0, 10)), 5);
});

test("метрики в ответе: массив [рейтинг, MA, осц., RSI, ADX, объём ×, ATR %, тейк %, стоп %], каждое — в рамках, «f»: 1 — фьючерсы", () => {
  const raw = {
    ok: true, at: NOW, rows: [
      { s: "AAA", px: 2, ch: 1, f: 1, r: { "15m": [0.4, 0.5, 0.3, 61.2, 27.5, 2.4, 1.1, 3.5, -1.75], "1h": -0.2 } },
      { s: "BBB", px: 2, ch: 1, r: { "15m": [0.2, 7, "x", 101, -1, -2, 1e9, -3, 5], "4h": [2, 0.1] } },
      { s: "CCC", px: 2, ch: 1, r: { "15m": [] } }, // рейтинга нет — строки нет
    ],
  };
  const v = validScreener(raw, NOW)!;
  assert.deepEqual(v.rows.map((r) => r.s), ["AAA", "BBB"]);
  const [a, b] = v.rows as [ScreenRow, ScreenRow];
  assert.equal(a.fut, true);
  assert.equal(b.fut, false);
  // Фьючерсы — только «f»: 1 (не «1», не true).
  for (const f of ["1", true, 2]) {
    assert.equal(validScreener({ ok: true, at: NOW, rows: [{ s: "Z", f, r: { "15m": 0.2 } }] }, NOW)!.rows[0]!.fut, false, String(f));
  }
  assert.deepEqual(a.m["15m"], { ma: 0.5, osc: 0.3, rsi: 61.2, adx: 27.5, volx: 2.4, atrp: 1.1, tp: 3.5, sl: -1.75, mv: null, age: null });
  assert.equal(a.r["15m"], 0.4);
  assert.equal(a.r["1h"], -0.2);
  assert.equal(a.m["1h"], undefined); // старый вид — только рейтинг
  assert.deepEqual(b.m["15m"], NOM); // всё вне рамок — null
  assert.equal(b.r["4h"], null); // рейтинг вне −1…+1 — нет рейтинга и метрик
  assert.equal(b.m["4h"], undefined);
  assert.equal(rr(a.m["15m"]), 2);
  assert.equal(rr(b.m["15m"]), null);
  assert.equal(rr(undefined), null);
});

test("подтверждения на основном таймфрейме: объём, ADX, зона RSI, риск/прибыль; нет значения — не проходит", () => {
  const tf = "15m";
  const r = mrow("A", { volx: 2, adx: 25, rsi: 29.9, tp: 4, sl: -2 });
  assert.equal(confirms(r, tf, EXTRA_ANY), true);
  assert.equal(confirms(mrow("Z", {}), tf, EXTRA_ANY), true); // без подтверждений метрики не нужны
  assert.equal(confirms(r, tf, { ...EXTRA_ANY, vol: 2 }), true);
  assert.equal(confirms(r, tf, { ...EXTRA_ANY, vol: 3 }), false);
  assert.equal(confirms(r, tf, { ...EXTRA_ANY, adx: 25 }), true);
  assert.equal(confirms(r, tf, { ...EXTRA_ANY, adx: 40 }), false);
  assert.equal(confirms(r, tf, { ...EXTRA_ANY, rsi: "os" }), true);
  assert.equal(confirms(r, tf, { ...EXTRA_ANY, rsi: "mid" }), false);
  assert.equal(confirms(r, tf, { ...EXTRA_ANY, rsi: "ob" }), false);
  assert.equal(confirms(mrow("M", { rsi: 30 }), tf, { ...EXTRA_ANY, rsi: "mid" }), true);
  assert.equal(confirms(mrow("M", { rsi: 70 }), tf, { ...EXTRA_ANY, rsi: "mid" }), true);
  assert.equal(confirms(mrow("M", { rsi: 70.1 }), tf, { ...EXTRA_ANY, rsi: "ob" }), true);
  assert.equal(confirms(mrow("M", { rsi: 70.1 }), tf, { ...EXTRA_ANY, rsi: "mid" }), false);
  assert.equal(confirms(mrow("M", { rsi: 29.9 }), tf, { ...EXTRA_ANY, rsi: "mid" }), false);
  assert.equal(confirms(r, tf, { ...EXTRA_ANY, rr: 2 }), true);
  assert.equal(confirms(r, tf, { ...EXTRA_ANY, rr: 3 }), false);
  for (const x of [{ vol: 1.5 }, { adx: 20 }, { rsi: "os" as const }, { rr: 1.5 }]) {
    assert.equal(confirms(mrow("Z", {}), tf, { ...EXTRA_ANY, ...x }), false, JSON.stringify(x));
  }
  assert.equal(confirms(r, "1h", { ...EXTRA_ANY, vol: 1.5 }), false); // на 1h метрик нет
  assert.equal(mainTf(ANY), "15m");
  assert.equal(mainTf({ ...ANY, "4h": "buy", "1h": "sell" }), "1h");
});

test("порядок: риск/прибыль, объём, ADX, сутки — по убыванию, без значения — в конце, равные — порядок сервера", () => {
  const rows = [
    mrow("A", { tp: 2, sl: -2, volx: 1, adx: 10 }, 5),
    mrow("B", { tp: 6, sl: -2, volx: 3 }, -1),
    mrow("C", {}, null),
    mrow("D", { tp: 3, sl: -1, volx: 3, adx: 30 }, 5),
  ];
  const by = (sort: "rr" | "vol" | "adx" | "ch") => screen(rows, ANY, { ...EXTRA_ANY, sort }).map((r) => r.s);
  assert.deepEqual(by("rr"), ["B", "D", "A", "C"]);
  assert.deepEqual(by("vol"), ["B", "D", "A", "C"]);
  assert.deepEqual(by("adx"), ["D", "A", "B", "C"]);
  assert.deepEqual(by("ch"), ["A", "D", "B", "C"]);
  assert.deepEqual(screen(rows, ANY).map((r) => r.s), ["A", "B", "C", "D"]);
  // Подтверждение вместе с фильтром по знаку.
  const f = { ...ANY, "15m": "buy" as const };
  assert.deepEqual(screen([...rows, mrow("E", { volx: 9 }, 0, -0.4)], f, { ...EXTRA_ANY, vol: 2, sort: "vol" }).map((r) => r.s), ["B", "D"]);
});

test("согласие таймфреймов и подтверждения с устройства", () => {
  assert.deepEqual(consensus(row("A", { "1m": 0.6, "15m": 0.2, "1h": 0, "4h": -0.3, "1d": 0.11 })), { up: 3, dn: 1, of: 5 });
  assert.deepEqual(consensus(row("B", {})), { up: 0, dn: 0, of: 0 });
  assert.deepEqual(validExtra({ vol: 2, adx: 25, rsi: "os", rr: 3, late: 1, sort: "fresh" }), { vol: 2, adx: 25, rsi: "os", rr: 3, late: 1, sort: "fresh" });
  assert.deepEqual(validExtra({ vol: 2.5, adx: "25", rsi: "x", rr: -1, late: 4, sort: "evil" }), EXTRA_ANY);
  assert.deepEqual(validExtra(null), EXTRA_ANY);
  assert.deepEqual(validExtra([1]), EXTRA_ANY);
});

test("ход с сигнала: со знаком сигнала, давно и нейтрально — нет; «далеко ушло» — больше двух ATR", () => {
  const raw = {
    ok: true, at: NOW, rows: [
      { s: "A", r: { "15m": [0.4, 0, 0, 50, 20, 1, 1, 2, -1, 2.5, 6] } },
      { s: "B", r: { "15m": [-0.4, 0, 0, 50, 20, 1, 1, 2, -1, -3, 2] } },
      { s: "C", r: { "15m": [0.4, 0, 0, 50, 20, 1, 1, 2, -1, null, SINCE_MAX + 1] } }, // давно
      { s: "D", r: { "15m": [0.05, 0, 0, 50, 20, 1, 1, 2, -1, null, null] } }, // нейтрально
      { s: "E", r: { "15m": [0.4, 0, 0, 50, 20, 1, 1, 2, -1, 1, 2.5] } }, // свечей — не целое
      { s: "F", r: { "15m": [0.4, 0, 0, 50, 20, 1, 1, 2, -1, 1, SINCE_MAX + 2] } }, // вне рамок
    ],
  };
  const v = validScreener(raw, NOW)!;
  const by = (s: string) => v.rows.find((r) => r.s === s)!;
  assert.deepEqual([by("A").m["15m"]!.mv, by("A").m["15m"]!.age], [2.5, 6]);
  assert.equal(chase(by("A"), "15m"), 2.5);
  assert.equal(chase(by("B"), "15m"), 3); // продажа: цена упала на 3 % — ушла на 3 % в сторону сигнала
  assert.equal(chase(by("C"), "15m"), null);
  assert.equal(by("C").m["15m"]!.age, SINCE_MAX + 1);
  assert.equal(chase(by("D"), "15m"), null);
  assert.equal(by("E").m["15m"]!.age, null);
  assert.equal(by("F").m["15m"]!.age, null);
  assert.equal(chase(by("A"), "1h"), null);
  assert.equal(late(by("A"), "15m"), true); // 2,5 % > 2 × ATR 1 %
  assert.equal(late(by("E"), "15m"), false);
  // Между одним и двумя ATR — ещё не поздно.
  assert.equal(late(mrow("L", { mv: 1.5, age: 2, atrp: 1 }), "15m"), false);
  assert.equal(late(mrow("L", { mv: 2.01, age: 2, atrp: 1 }), "15m"), true);
  assert.equal(late(by("C"), "15m"), false);
});

test("фильтр «ход с сигнала» и порядок «свежесть»: давно и без сигнала — не проходят и в конце", () => {
  const rows = [
    mrow("A", { mv: 2.5, age: 6, atrp: 1 }),
    mrow("B", { mv: 0.4, age: 1 }),
    mrow("C", { mv: null, age: SINCE_MAX + 1 }),
    mrow("D", { mv: -1, age: 3 }), // против сигнала — подходит
    mrow("E", { mv: 0.2, age: 0 }, 0, 0.05), // нейтрально
  ];
  assert.deepEqual(screen(rows, ANY, { ...EXTRA_ANY, late: 1 }).map((r) => r.s), ["B", "D"]);
  assert.deepEqual(screen(rows, ANY, { ...EXTRA_ANY, late: 3 }).map((r) => r.s), ["A", "B", "D"]);
  assert.deepEqual(screen(rows, ANY, { ...EXTRA_ANY, sort: "fresh" }).map((r) => r.s), ["B", "D", "A", "C", "E"]);
});

test("столбцы: с устройства — только известные, по порядку; касание — добавить или убрать; серверу — и столбцы", () => {
  assert.deepEqual(validCols(["1d", "1m", "evil", "1m"]), ["1m", "1d"]);
  assert.deepEqual(validCols([]), []);
  assert.deepEqual(validCols(undefined), [...SCREEN_WARM]);
  assert.deepEqual(validCols("1m"), [...SCREEN_WARM]);
  assert.deepEqual(toggleCol(SCREEN_WARM, "1m"), ["1m", "15m", "1h", "4h", "1d"]);
  assert.deepEqual(toggleCol(SCREEN_WARM, "1h"), ["15m", "4h", "1d"]);
  const cols = ["5m", "15m", "1w"] as const;
  assert.deepEqual(wanted(ANY, cols), ["5m", "1w"]);
  assert.deepEqual(wanted({ ...ANY, "1m": "buy" }, cols), ["1m", "5m", "1w"]);
  assert.deepEqual(pending(ANY, { at: NOW, rows: [], warm: [...SCREEN_WARM, "5m"] }, cols), ["1w"]);
});

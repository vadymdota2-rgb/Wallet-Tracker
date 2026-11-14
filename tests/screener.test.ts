/* Скринер графика и Фибо от лоя (src/lib/screener.ts, src/lib/fibo.ts): npm test. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANY, badgeTfs, chartTf, find, matches, nextWant, pending, picked, PRESETS, SCREEN_TFS, SCREEN_WARM, screen, signal,
  validFilter, validScreener, wanted, type ScreenRow,
} from "../src/lib/screener.ts";
import { FIBO_LEVELS, fiboFromLow, fiboPlan, swingDev } from "../src/lib/fibo.ts";
import { rateKey } from "../src/chart/indicators.ts";
import type { Bar } from "../src/chart/data.ts";

const NOW = 1_794_100_000;
const NONE = Object.fromEntries(SCREEN_TFS.map((tf) => [tf, null])) as ScreenRow["r"];
const row = (s: string, r: Partial<Record<(typeof SCREEN_TFS)[number], number | null>>): ScreenRow =>
  ({ s, px: 1, ch: 0, r: { ...NONE, ...r } });

test("ответ скринера: только годные строки, рейтинг от −1 до +1, повторы и мусор — мимо", () => {
  const raw = {
    ok: true, at: NOW - 60, tfs: ["15m", "1h", "1m", "evil"], rows: [
      { s: "BTC", px: 100000, ch: 1.5, r: { "15m": 0.6, "1h": -0.3, "4h": 2, "1d": "x", "1m": 0.2, "2m": 0.5 } },
      { s: "BTC", px: 1, ch: 0, r: { "15m": 0.1 } }, // повтор — первый
      { s: "<b>", px: 1, ch: 0, r: { "15m": 0.1 } },
      { s: "ETH", px: -1, ch: 1e9, r: { "15m": -0.2 } },
      { s: "SOL", r: { "15m": null } }, // ни одного рейтинга — мимо
      { s: "DOGE", r: "x" },
      null, 5,
    ],
  };
  const v = validScreener(raw, NOW)!;
  assert.deepEqual(v.rows, [
    { s: "BTC", px: 100000, ch: 1.5, r: { ...NONE, "15m": 0.6, "1h": -0.3, "1m": 0.2 } },
    { s: "ETH", px: null, ch: null, r: { ...NONE, "15m": -0.2 } },
  ]);
  assert.deepEqual(v.warm, ["1m", "15m", "1h"]); // только известные таймфреймы, по порядку
  assert.equal(SCREEN_TFS.length, 14);
  for (const bad of [null, "x", { ok: false }, { ok: true, at: NOW, rows: [] }, { ok: true, at: NOW - 4 * 86_400, rows: raw.rows },
    { ok: true, at: NOW + 2 * 86_400, rows: raw.rows }, { ok: true, at: 1.5, rows: raw.rows }]) {
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
  assert.deepEqual(pending(f, null), ["1m", "15m", "1w"]);
  assert.deepEqual(badgeTfs(ANY), [...SCREEN_WARM]);
  assert.deepEqual(badgeTfs({ ...ANY, "1m": "buy", "3m": "buy", "5m": "sell", "30m": "buy", "2h": "sell" }), ["1m", "3m", "5m", "30m"]);
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

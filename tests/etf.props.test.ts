/*
 * Свойства (инварианты) «Институциональных потоков» на тысячах случайных входов.
 *
 * Как у халвинга: не «пример → ответ», а правила, которые обязаны выполняться
 * всегда. Генератор детерминированный (зерно SEED) — найденное нарушение
 * воспроизводится, номер случая есть в сообщении.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ETF_LAUNCH, PERIODS, RANGES, chartView, cumulative, etfStats, fundTotals, validEtf, weekly,
  type EtfDay, type EtfReply,
} from "../src/lib/etf.ts";

const SEED = 0x5eed_e7f;
const CASES = 3_000;
const DAY = 86_400;
const NOW = 1_792_211_449;
const REAL = JSON.parse(readFileSync(new URL("./fixtures/etf.json", import.meta.url), "utf8")) as EtfReply;

/** mulberry32 — маленький детерминированный генератор. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Правдоподобный ответ сервера: любое число фондов и дней, пропуски, нули. */
function reply(r: () => number): EtfReply {
  const nf = 1 + Math.floor(r() * 14);
  const funds = Array.from({ length: nf }, (_, i) => ({
    t: `F${i}`, n: r() < 0.3 ? "" : `Fund ${i}`, c: "US", aum: r() * 1e11, hold: r() * 9e5,
    fee: r() < 0.2 ? null : Math.round(r() * 150) / 100, cum: (r() - 0.5) * 1e11, cumc: (r() - 0.5) * 1e6,
  }));
  const days: EtfDay[] = [];
  let ts = ETF_LAUNCH + Math.floor(r() * 600) * DAY;
  const n = 1 + Math.floor(r() * 400);
  for (let i = 0; i < n && ts < NOW; i++) {
    const per = funds.map(() => (r() < 0.2 ? null : r() < 0.2 ? 0 : Math.round((r() - 0.5) * 2e6)));
    const usd = per.reduce<number>((s, v) => s + (v ?? 0), 0);
    const px = r() < 0.05 ? 0 : 20_000 + r() * 130_000;
    days.push([ts, usd, px ? Math.round((usd * 1000 / px) * 100) / 100 : 0, px, per]);
    ts += DAY * (1 + Math.floor(r() * 4));
  }
  return { ok: true, coins: { btc: { funds, days, share: r() * 10 } }, at: NOW };
}

/** Испортить одну случайную клетку ответа — мусором любого типа. */
const JUNK: unknown[] = [null, undefined, "", "x", "1", NaN, Infinity, -Infinity, 1e300, -1, true, [], {}, [1, 2], { ok: 1 }];
function spoil(v: unknown, r: () => number, depth = 0): unknown {
  if (Array.isArray(v) && v.length && depth < 6) {
    const c = [...v];
    const i = Math.floor(r() * c.length);
    c[i] = r() < 0.3 ? JUNK[Math.floor(r() * JUNK.length)] : spoil(c[i], r, depth + 1);
    return c;
  }
  if (v && typeof v === "object" && depth < 6) {
    const c = { ...(v as Record<string, unknown>) };
    const keys = Object.keys(c);
    const k = keys[Math.floor(r() * keys.length)]!;
    c[k] = r() < 0.3 ? JUNK[Math.floor(r() * JUNK.length)] : spoil(c[k], r, depth + 1);
    return c;
  }
  return JUNK[Math.floor(r() * JUNK.length)];
}

test("правдоподобный ответ принимается, проверка копии — та же копия", () => {
  const r = rng(SEED);
  for (let i = 0; i < CASES; i++) {
    const x = reply(r);
    const v = validEtf(x, NOW);
    assert.ok(v, `случай ${i}`);
    assert.deepEqual(validEtf(v, NOW), v, `случай ${i}`);
  }
});

test("испорченный ответ — никогда не исключение; принятое всегда цело", () => {
  const r = rng(SEED + 1);
  let taken = 0;
  for (let i = 0; i < CASES; i++) {
    const bad = spoil(r() < 0.5 ? reply(r) : structuredClone(REAL), r);
    const v = validEtf(bad, NOW);
    if (!v) continue;
    taken++;
    const c = v.coins.btc!;
    for (const d of c.days) {
      assert.equal(d[4].length, c.funds.length, `случай ${i}`);
      assert.ok(d.slice(0, 4).every((x) => typeof x === "number" && Number.isFinite(x)), `случай ${i}`);
    }
    // Расчёты экрана на принятом не падают и дают конечные числа.
    const s = etfStats(c, NOW)!;
    assert.ok([s.d7, s.d30, s.cum, s.c30, s.mined, s.aum, s.held].every(Number.isFinite), `случай ${i}`);
    for (const p of PERIODS) assert.ok(Number.isFinite(fundTotals(c, p).span), `случай ${i}`);
  }
  // Порча клетки обычно ломает ответ, но не всегда (испорчено необязательное).
  assert.ok(taken > 0 && taken < CASES, String(taken));
});

test("графики: недели сохраняют суммы, окно не длиннее истории, накопленное — весь поток", () => {
  const r = rng(SEED + 2);
  for (let i = 0; i < CASES / 3; i++) {
    const c = reply(r).coins.btc!;
    const total = c.days.reduce((s, d) => s + d[1], 0);
    const w = weekly(c.days, c.funds.length);
    assert.ok(Math.abs(w.reduce((s, b) => s + b.usd, 0) - total) < 1e-6 * Math.max(1, Math.abs(total)), `случай ${i}`);
    assert.ok(w.every((b, j) => b.a <= b.b && (j === 0 || b.a > w[j - 1]!.b) && b.b - b.a < 7 * DAY), `случай ${i}`);
    for (const range of RANGES) {
      const v = chartView(c.days, c.funds.length, range);
      assert.ok(v.length <= c.days.length && v.length > 0, `случай ${i} ${range}`);
      const cum = cumulative(v, c.days);
      assert.ok(Math.abs(cum.at(-1)! - total) < 1e-6 * Math.max(1, Math.abs(total)), `случай ${i} ${range}`);
    }
  }
});

test("фонды за срок: приток и отток — суммы движущихся, «с запуска» — из итогов фондов", () => {
  const r = rng(SEED + 3);
  for (let i = 0; i < CASES / 3; i++) {
    const c = reply(r).coins.btc!;
    for (const p of PERIODS) {
      const t = fundTotals(c, p);
      assert.equal(t.moving.length + t.still, c.funds.length, `случай ${i} ${p}`);
      assert.ok(t.ins >= 0 && t.outs <= 0, `случай ${i} ${p}`);
      assert.ok(t.moving.every((m, j) => j === 0 || t.moving[j - 1]!.v >= m.v), `случай ${i} ${p}`);
      assert.ok(t.moving.every((m) => Math.abs(m.v) <= t.span), `случай ${i} ${p}`);
    }
  }
});

test("серии и рекорды согласованы с днями", () => {
  const r = rng(SEED + 4);
  for (let i = 0; i < CASES / 3; i++) {
    const c = reply(r).coins.btc!;
    const s = etfStats(c, NOW)!;
    assert.ok(s.best[1] >= s.worst[1], `случай ${i}`);
    assert.ok(c.days.every((d) => d[1] <= s.best[1] && d[1] >= s.worst[1]), `случай ${i}`);
    assert.ok(s.streak <= c.days.length && s.runs.up.n <= c.days.length && s.runs.dn.n <= c.days.length, `случай ${i}`);
    if (s.sign > 0) assert.ok(s.streak <= s.runs.up.n, `случай ${i}`);
    if (s.sign < 0) assert.ok(s.streak <= s.runs.dn.n, `случай ${i}`);
    if (s.bestM && s.worstM) assert.ok(s.bestM[1] >= s.worstM[1], `случай ${i}`);
    assert.ok(s.mined >= 30 * 225 && s.mined <= 30 * 900, `случай ${i}`);
  }
});

/*
 * Свойства (инварианты) карты ликвидаций на тысячах случайных входов.
 *
 * Как у халвинга, ETF и доминации: не «пример → ответ», а правила, которые
 * обязаны выполняться всегда. Генератор детерминированный (зерно SEED) —
 * найденное нарушение воспроизводится, номер случая есть в сообщении.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIQ_RANGES, cumOf, nearest, rowsOf, sum, topLevels, validLiqMap } from "../src/lib/liqmap.ts";
import type { LiqBucket, LiqMapReply } from "../src/lib/types.ts";

const SEED = 0x11_9a_ab;
const CASES = 2_000;
const NOW = 1_793_000_000;

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

/** Правдоподобный ответ сервера: любая цена, любые корзины от нуля до удвоения. */
function reply(r: () => number): LiqMapReply {
  const px = 10 ** (r() * 10 - 5);
  const step = (px * 2) / 800;
  const levs = [10, 25, 50, 100, 500];
  const buckets: LiqBucket[] = [];
  for (let b = 0; b < 800; b++) {
    if (r() < 0.6) continue;
    const p = step * (b + 0.5);
    const up = p > px;
    const vals = () => levs.map(() => (r() < 0.5 ? 0 : Math.floor(r() * 1e7)));
    buckets.push({ p, L: up ? levs.map(() => 0) : vals(), S: up ? vals() : levs.map(() => 0) });
  }
  const cum = { "2": { L: 1, S: 2 }, "5": { L: 3, S: 4 }, "10": { L: 5, S: 6 } };
  const path = Array.from({ length: 1 + Math.floor(r() * 60) }, () => px * (0.9 + r() * 0.2));
  const ohlc: [number, number, number, number][] = path.map((c) => [c, c * 1.01, c * 0.99, c]);
  const oi = Math.floor(r() * 1e11);
  return {
    ok: true, sym: "BTC", range: LIQ_RANGES[Math.floor(r() * 6)]!, px, step, lo: 0, ex: ["OKX"], levs, buckets, cum, path,
    oi, seen: Math.floor(r() * oi), ohlc, at: NOW - Math.floor(r() * 3600),
  };
}

test("правдоподобный ответ проходит проверку без изменений", () => {
  const r = rng(SEED);
  for (let i = 0; i < CASES / 4; i++) {
    const m = reply(r);
    assert.deepEqual(validLiqMap(JSON.parse(JSON.stringify(m)), NOW), m, `случай ${i}`);
  }
});

test("порча любого числа ответа — не ответ, а не падение экрана", () => {
  const r = rng(SEED + 1);
  const junk = [NaN, Infinity, -1, "1", null, true, [], {}];
  for (let i = 0; i < CASES / 4; i++) {
    const m = JSON.parse(JSON.stringify(reply(r))) as Record<string, unknown>;
    const v = junk[Math.floor(r() * junk.length)];
    const field = ["px", "step", "oi", "at", "path", "ohlc", "levs", "buckets", "cum", "sym", "range"][Math.floor(r() * 11)]!;
    if (field === "sym" && v === "1") continue; // «1» — годный тикер (бывают монеты из цифр)
    if (field === "ohlc" && Array.isArray(v)) continue; // пустые свечи — карта без графика цены, не порча
    if (field === "buckets" && Array.isArray(m["buckets"]) && (m["buckets"] as unknown[]).length) {
      const b = (m["buckets"] as Record<string, unknown>[])[0]!;
      b[["p", "L", "S"][Math.floor(r() * 3)]!] = v;
    } else {
      m[field] = v;
    }
    assert.doesNotThrow(() => validLiqMap(m, NOW));
    assert.equal(validLiqMap(m, NOW), null, `случай ${i}: ${field} = ${String(v)}`);
  }
});

test("строки экрана: те же деньги, что в корзинах окна; накопленное растёт наружу", () => {
  const r = rng(SEED + 2);
  for (let i = 0; i < CASES / 10; i++) {
    const m = reply(r);
    const span = [5, 10, 15, 30, 50, 100, 500][Math.floor(r() * 7)]!;
    const { rows } = rowsOf(m, span);
    const top = rows[0]!.hi;
    const bottom = rows[rows.length - 1]!.lo;
    const want = m.buckets.filter((b) => b.p >= bottom && b.p < top).reduce((a, b) => a + sum(b.L) + sum(b.S), 0);
    const got = rows.reduce((a, w) => a + sum(w.L) + sum(w.S), 0);
    assert.equal(got, want, `случай ${i}`);
    const on = m.levs.map(() => r() < 0.7);
    const c = cumOf(rows, m.px, on);
    for (let k = 1; k < rows.length; k++) {
      if (rows[k]!.mid > m.px) assert.ok(c[k - 1]! >= c[k]!, `случай ${i}: шорты`);
      if (rows[k - 1]!.mid < m.px) assert.ok(c[k]! >= c[k - 1]!, `случай ${i}: лонги`);
    }
  }
});

test("скопления: на своей стороне, в окне, не соседние, по убыванию", () => {
  const r = rng(SEED + 3);
  for (let i = 0; i < CASES / 10; i++) {
    const m = reply(r);
    for (const up of [true, false]) {
      const n = nearest(m, up);
      if (n) assert.ok(up ? n.p > m.px && n.d <= 10.5 : n.p < m.px && n.d >= -10.5, `случай ${i}`);
      const span = [5, 10, 15, 30, 50, 100, 500][Math.floor(r() * 7)]!;
      const t = topLevels(m, up, span);
      assert.ok(t.length <= 3);
      for (const x of t) assert.ok((up ? x.p > m.px : x.p < m.px) && Math.abs(x.p / m.px - 1) <= span / 100 + 1e-9, `случай ${i}`);
      for (let a = 1; a < t.length; a++) assert.ok(t[a - 1]!.v >= t[a]!.v);
      for (let a = 0; a < t.length; a++) for (let b = a + 1; b < t.length; b++) assert.ok(Math.abs(t[a]!.k - t[b]!.k) >= 2);
    }
  }
});

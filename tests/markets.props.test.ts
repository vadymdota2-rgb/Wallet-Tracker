/*
 * Свойства (инварианты) проверки ответа рынков и подписей на тысячах
 * случайных входов (node --test).
 *
 * Как у халвинга: не «пример → ответ», а правила, которые обязаны
 * выполняться всегда. Генератор детерминированный (зерно SEED), поэтому
 * найденное нарушение воспроизводится — номер случая есть в сообщении.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAR_MIN, MARKET_KEYS, MARKET_PX_MAX, barShare, change, digits, isPercent, validMarkets, type MarketItem } from "../src/lib/markets.ts";

const SEED = 0x3a_4e75;
const CASES = 20_000;
const NOW = 1_794_100_000;
const JUNK: unknown[] = [null, undefined, "", "x", "1", NaN, Infinity, -Infinity, -1, 0, 1e300, MARKET_PX_MAX, true, [], {}, "<b>"];

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

function pick<T>(r: () => number, a: readonly T[]): T {
  return a[Math.floor(r() * a.length)]!;
}

/** Ответ сервера: чаще годный, иногда с мусором в любом месте. */
function reply(r: () => number): unknown {
  if (r() < 0.03) return pick(r, JUNK);
  const n = Math.floor(r() * 14);
  const items: unknown[] = [];
  for (let i = 0; i < n; i++) {
    if (r() < 0.04) {
      items.push(pick(r, JUNK));
      continue;
    }
    const k = r() < 0.9 ? pick(r, MARKET_KEYS) : pick(r, ["VIX", "DVOL", "NDX", "<b>", "", "sp500"]);
    const px = r() < 0.92 ? 10 ** (r() * 8 - 2) : pick(r, JUNK);
    const prev = r() < 0.92 ? (typeof px === "number" ? px * (0.5 + r()) : 1) : pick(r, JUNK);
    items.push({ k, px, prev, ...(r() < 0.05 ? { evil: "<img>" } : {}) });
  }
  const at = r() < 0.95 ? NOW - Math.floor(r() * 30_000) + 3_000 : pick(r, [...JUNK, NOW + 0.5, NOW + 3 * 86_400]);
  return { ok: r() < 0.97 ? true : pick(r, JUNK), at, items: r() < 0.97 ? items : pick(r, JUNK) };
}

test("проверка ответа: только наши пункты, по порядку, без повторов, правдоподобные цены", () => {
  const r = rng(SEED);
  let ok = 0;
  for (let i = 0; i < CASES; i++) {
    const raw = reply(r);
    const v = validMarkets(raw, NOW);
    if (!v) continue;
    ok++;
    const m = `случай ${i}`;
    assert.ok(v.items.length > 0, m);
    const keys = v.items.map((x) => x.k);
    assert.deepEqual(keys, MARKET_KEYS.filter((k) => keys.includes(k)), m);
    for (const it of v.items) {
      assert.deepEqual(Object.keys(it).sort(), ["k", "prev", "px"], m);
      for (const p of [it.px, it.prev]) assert.ok(Number.isFinite(p) && p > 0 && p < MARKET_PX_MAX, m);
    }
    assert.ok(Number.isInteger(v.at) && v.at >= NOW - 6 * 3_600 && v.at <= NOW + 86_400, m);
    // Повторная проверка ничего не меняет; каждый пункт — первый из одноимённых.
    assert.deepEqual(validMarkets({ ok: true, ...v }, NOW), v, m);
    const src = (raw as { items: unknown[] }).items;
    for (const it of v.items) {
      const first = src.find((x) => typeof x === "object" && x !== null && (x as { k?: unknown }).k === it.k
        && typeof (x as { px?: unknown }).px === "number" && (x as { px: number }).px > 0 && (x as { px: number }).px < MARKET_PX_MAX
        && typeof (x as { prev?: unknown }).prev === "number" && (x as { prev: number }).prev > 0 && (x as { prev: number }).prev < MARKET_PX_MAX
        && Number.isFinite((x as { px: number }).px) && Number.isFinite((x as { prev: number }).prev));
      assert.deepEqual({ k: it.k, px: it.px, prev: it.prev }, { k: (first as MarketItem).k, px: (first as MarketItem).px, prev: (first as MarketItem).prev }, m);
    }
  }
  // Генератор даёт и годные ответы, и отказы — иначе он ничего не проверяет.
  assert.ok(ok > CASES / 2 && ok < CASES, String(ok));
});

test("изменение: знак — как у разницы цен, у доходности — базисные пункты", () => {
  const r = rng(SEED + 1);
  for (let i = 0; i < CASES; i++) {
    const k = pick(r, MARKET_KEYS);
    const px = 10 ** (r() * 8 - 2);
    const prev = r() < 0.1 ? px : px * (0.5 + r());
    const c = change({ k, px, prev });
    const m = `случай ${i}: ${k} ${px} ${prev}`;
    assert.ok(Number.isFinite(c.v), m);
    assert.equal(Math.sign(c.v), Math.sign(px - prev), m);
    assert.equal(c.unit, k === "US10Y" ? "bp" : "pct", m);
    if (k === "US10Y") assert.ok(Math.abs(c.v - (px - prev) * 100) < 1e-6 * Math.max(1, Math.abs(c.v)), m);
    else assert.ok(Math.abs(c.v / 100 + 1 - px / prev) < 1e-12 * Math.max(1, px / prev), m);
  }
});

test("знаки после запятой: доли и доходность — две, остальное — по масштабу, не меньше четырёх значащих", () => {
  const r = rng(SEED + 2);
  for (let i = 0; i < CASES; i++) {
    const k = pick(r, MARKET_KEYS);
    const px = 10 ** (r() * 8 - 2);
    const d = digits({ k, px, prev: 1 });
    const m = `случай ${i}: ${k} ${px}`;
    assert.ok([0, 2, 3, 5].includes(d), m);
    if (isPercent(k)) assert.equal(d, 2, m);
    else if (px >= 0.01) assert.ok(Math.floor(Math.log10(px)) + 1 + d >= 4, m); // 7 373, 90,21, 4,066, 0,02947
  }
});

test("полоска: 0…1, растёт с величиной изменения, ноль — только без изменения", () => {
  const r = rng(SEED + 3);
  for (let i = 0; i < CASES; i++) {
    const k = pick(r, MARKET_KEYS);
    const prev = 10 ** (r() * 6 - 1);
    const a = prev * (1 + (r() - 0.5) * 0.1);
    const b = prev * (1 + (r() - 0.5) * 0.1);
    const m = `случай ${i}: ${k} ${prev} ${a} ${b}`;
    const sa = barShare({ k, px: a, prev });
    const sb = barShare({ k, px: b, prev });
    for (const x of [sa, sb]) assert.ok(x === 0 || (x >= BAR_MIN && x <= 1), m);
    assert.equal(sa === 0, change({ k, px: a, prev }).v === 0, m);
    if (Math.abs(change({ k, px: a, prev }).v) < Math.abs(change({ k, px: b, prev }).v)) assert.ok(sa <= sb, m);
  }
});

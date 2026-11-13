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
import {
  BAR_MIN, CANDLES_SHOW, MARKET_KEYS, MARKET_PX_MAX, barShare, candleChart, candleSeries, change, digits, isPercent, validCandles,
  validMarkets, type Candle, type MarketItem,
} from "../src/lib/markets.ts";

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

const D = 86_400;

/** Свечи с сервера: чаще годные, иногда с мусором в любом месте. */
function days(r: () => number): unknown {
  if (r() < 0.03) return pick(r, JUNK);
  const out: Record<string, unknown> = {};
  for (const k of [...MARKET_KEYS, "VIX", "<b>"]) {
    if (r() < 0.3) continue;
    if (r() < 0.04) {
      out[k] = pick(r, JUNK);
      continue;
    }
    const n = Math.floor(r() * 50);
    let d = NOW - (NOW % D) - Math.floor(r() * 45) * D;
    const base = 10 ** (r() * 6 - 1);
    out[k] = Array.from({ length: n }, () => {
      if (r() < 0.03) return pick(r, JUNK);
      d += pick(r, [D, D, D, 0, -D, 1.5, 7]);
      const o = base * (0.8 + r() * 0.4), c = base * (0.8 + r() * 0.4);
      const row: unknown[] = [d, o, Math.max(o, c) * (1 + r() * 0.02), Math.min(o, c) * (1 - r() * 0.02), c];
      if (r() < 0.05) row[Math.floor(r() * 5)] = pick(r, JUNK);
      if (r() < 0.02) row.pop();
      return row;
    });
  }
  return { ok: r() < 0.97 ? true : pick(r, JUNK), at: NOW, days: r() < 0.97 ? out : pick(r, JUNK) };
}

test("свечи: только наши пункты, день — начало суток по возрастанию, не больше CANDLES_SHOW, тени охватывают тело", () => {
  const r = rng(SEED + 7);
  let rows = 0;
  for (let i = 0; i < 3000; i++) {
    const h = validCandles(days(r), NOW);
    for (const [k, cs] of Object.entries(h)) {
      const m = `случай ${i}, ${k}`;
      assert.ok((MARKET_KEYS as readonly string[]).includes(k), m);
      assert.ok(cs.length >= 1 && cs.length <= CANDLES_SHOW, m);
      for (let j = 0; j < cs.length; j++) {
        const [d, o, hi, lo, c] = cs[j]!;
        assert.ok(Number.isInteger(d) && d % D === 0 && d >= NOW - 40 * D && d <= NOW + D, m);
        for (const v of [o, hi, lo, c]) assert.ok(Number.isFinite(v) && v > 0 && v < MARKET_PX_MAX, m);
        assert.ok(lo <= Math.min(o, c) && Math.max(o, c) <= hi, m);
        if (j) assert.ok(d > cs[j - 1]![0], m);
      }
      rows += 1;
      // Принятое принимается снова тем же — проверка устойчива.
      assert.deepEqual(validCandles({ ok: true, days: { [k]: cs } }, NOW)[k as "GOLD"], cs, m);
    }
  }
  assert.ok(rows > 3000, `годных рядов слишком мало: ${rows}`);
});

test("свечной график: свечи внутри поля, слева направо, тени охватывают тело, последняя — с ценой ответа", () => {
  const r = rng(SEED + 8);
  for (let i = 0; i < 5000; i++) {
    const n = 1 + Math.floor(r() * 45);
    const base = 10 ** (r() * 6 - 2);
    const cs: Candle[] = Array.from({ length: n }, (_, j) => {
      const o = base * (0.8 + r() * 0.4), c = r() < 0.1 ? o : base * (0.8 + r() * 0.4);
      return [NOW - (NOW % D) - (n - 1 - j) * D, o, Math.max(o, c) * (1 + r() * 0.03), Math.min(o, c) * (1 - r() * 0.03), c];
    });
    const it: MarketItem = { k: pick(r, MARKET_KEYS), px: base * (0.7 + r() * 0.6), prev: base };
    const ser = candleSeries(cs, it);
    const m = `случай ${i}`;
    assert.equal(ser[ser.length - 1]![4], it.px, m);
    const g = candleChart(ser, 240, 64, 3);
    assert.equal(g.bars.length, Math.min(n, CANDLES_SHOW), m);
    assert.ok(Math.abs(g.bars[g.bars.length - 1]!.x - 236) < 1e-6, m);
    for (let j = 1; j < g.bars.length; j++) assert.ok(g.bars[j]!.x > g.bars[j - 1]!.x, m);
    for (const b of g.bars) {
      assert.ok(b.x - g.bw / 2 >= 0 && b.x + g.bw / 2 <= 240, m);
      assert.ok(b.hi <= b.top + 1e-6 && b.top < b.bot && b.bot <= b.lo + 0.61, `${m}: ${JSON.stringify(b)}`);
      for (const y of [b.hi, b.top, b.bot, b.lo]) assert.ok(y >= 3 - 1e-6 && y <= 61 + 0.61, `${m}: ${y}`);
    }
    assert.ok(g.last >= 3 - 1e-6 && g.last <= 61 + 1e-6, m);
  }
});

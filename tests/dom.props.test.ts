/*
 * Свойства (инварианты) «Альтсезона» на тысячах случайных входов.
 *
 * Как у халвинга и ETF: не «пример → ответ», а правила, которые обязаны
 * выполняться всегда. Генератор детерминированный (зерно SEED) — найденное
 * нарушение воспроизводится, номер случая есть в сообщении.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MIN_BASKET, PX_FROM, RANGES, ago, altStats, beat, change, daysOld, ebStats, everyNth, seasonOf, series, thin, validDom, windowOf,
  type DomDay, type DomReply, type DomTier,
} from "../src/lib/dom.ts";

const SEED = 0xd0_5eed;
const CASES = 3_000;
const DAY = 86_400;
const REAL = JSON.parse(readFileSync(new URL("./fixtures/dom.json", import.meta.url), "utf8")) as DomReply & { now: number };
const NOW = REAL.now;

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

/** Правдоподобный ответ сервера: любое число дней, пропуски индекса (а с ним и корзины) и ETH/BTC. */
function reply(r: () => number): DomReply {
  const n = 1 + Math.floor(r() * 900);
  const start = Math.floor(NOW / DAY) * DAY - (n - 1) * DAY - Math.floor(r() * 5) * DAY;
  const rows: DomDay[] = [];
  let s = 100;
  for (let i = 0; i < n; i++) {
    s *= Math.exp((r() - 0.5) * 0.05);
    const idx = i < 90 || r() < 0.02 ? null : Math.round(r() * 100);
    rows.push([start + i * DAY, idx, i < 30 && idx === null ? null : s, r() < 0.05 ? null : 0.01 + r() * 0.07, 10_000 + r() * 100_000,
      idx === null ? null : MIN_BASKET + Math.floor(r() * 21)]);
  }
  const coins = Array.from({ length: Math.floor(r() * 50) }, (_, i): [string, number] => [`C${i}`, (r() - 0.3) * 300]);
  const tiers = [25, 50, 100].map((size): DomTier => {
    const k = Math.floor(r() * (size + 1));
    return [size, k >= Math.min(MIN_BASKET, size) ? Math.round(r() * 100) : null, k];
  });
  return { ok: true, rows, coins, btc90: (r() - 0.3) * 100, tiers, n: 50, at: NOW };
}

/** Порча: одна клетка ответа — чем угодно. */
const JUNK: unknown[] = [null, undefined, "", "5", NaN, Infinity, -1, 1e300, true, [], {}, "<b>", 0.5];
function spoil(r: () => number, v: DomReply): unknown {
  const c = structuredClone(v) as unknown as Record<string, unknown>;
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const k = r();
  if (k < 0.6 && v.rows.length) {
    const row = pick(c["rows"] as unknown[][]);
    row[Math.floor(r() * 7)] = pick(JUNK);
  } else if (k < 0.8) {
    c[pick(["ok", "rows", "at", "coins", "btc90", "tiers", "n"])] = pick(JUNK);
  } else if (k < 0.9) {
    (c["tiers"] as unknown[][])[Math.floor(r() * 3)]![Math.floor(r() * 4)] = pick(JUNK);
  } else if (v.coins.length) {
    (c["coins"] as unknown[][])[0]![Math.floor(r() * 3)] = pick(JUNK);
  }
  return c;
}

test("годный ответ принимается целиком, а копия проверки — та же копия", () => {
  const r = rng(SEED);
  for (let i = 0; i < CASES; i++) {
    const v = reply(r);
    const got = validDom(v, NOW);
    assert.ok(got, `случай ${i}`);
    assert.equal(got.rows.length, v.rows.length, `случай ${i}`);
    assert.deepEqual(got.coins, v.coins, `случай ${i}`);
    assert.deepEqual(got.tiers, v.tiers, `случай ${i}`);
    assert.deepEqual(validDom(got, NOW), got, `случай ${i}`);
  }
  // И настоящий ответ сервера.
  assert.ok(validDom(REAL, NOW));
});

test("испорченный ответ — никогда не исключение; принятое всегда цело", () => {
  const r = rng(SEED + 1);
  let rejected = 0;
  for (let i = 0; i < CASES; i++) {
    const bad = spoil(r, reply(r));
    let got: DomReply | null = null;
    assert.doesNotThrow(() => { got = validDom(bad, NOW); }, `случай ${i}`);
    if (!got) {
      rejected++;
      continue;
    }
    const v = got as DomReply;
    let prev = 0;
    for (const d of v.rows) {
      assert.ok(d[0] > prev && d[0] % DAY === 0 && d[0] >= PX_FROM, `случай ${i}`);
      prev = d[0];
      assert.ok(d[1] === null || (Number.isInteger(d[1]) && d[1] >= 0 && d[1] <= 100), `случай ${i}`);
      assert.ok(d[2] === null || (Number.isFinite(d[2]) && d[2] > 0), `случай ${i}`);
      assert.ok(d[3] === null || (d[3] > 0 && d[3] <= 10), `случай ${i}`);
      assert.ok((d[1] === null) === (d[5] === null) && (d[5] === null || (Number.isInteger(d[5]) && d[5] >= MIN_BASKET)), `случай ${i}`);
    }
    for (const [size, idx, k] of v.tiers) {
      assert.ok(Number.isInteger(size) && size >= 1 && Number.isInteger(k) && k >= 0 && k <= size, `случай ${i}`);
      assert.ok(idx === null || (Number.isInteger(idx) && idx >= 0 && idx <= 100), `случай ${i}`);
    }
    for (const c of v.coins) assert.ok(/^[A-Za-z0-9]{1,20}$/.test(c[0]) && Number.isFinite(c[1]), `случай ${i}`);
    assert.ok(v.btc90 === null || Number.isFinite(v.btc90), `случай ${i}`);
  }
  // Порча то ломает ответ, то задевает лишь монету — оба исхода встречаются.
  assert.ok(rejected > CASES / 10 && rejected < CASES, String(rejected));
});

test("ряды, окна и точки назад согласованы с днями", () => {
  const r = rng(SEED + 2);
  for (let i = 0; i < 500; i++) {
    const v = reply(r);
    for (const col of [1, 2, 3, 4, 5] as const) {
      const s = series(v.rows, col);
      assert.ok(s.every((p, j) => j === 0 || p[0] > s[j - 1]![0]), `случай ${i}`);
      assert.equal(s.length, v.rows.filter((d) => d[col] !== null).length, `случай ${i}`);
      for (const range of RANGES) {
        const w = windowOf(s, range);
        assert.ok(w.length <= s.length && (w.length === 0 || w[w.length - 1] === s[s.length - 1]), `случай ${i}`);
        const th = thin(w, 600);
        assert.ok(th.length <= 601 && (w.length === 0 || th[th.length - 1] === w[w.length - 1]), `случай ${i}`);
      }
      for (const n of [1, 7, 30, 365]) {
        const p = ago(s, n);
        if (p) assert.ok(p[0] <= s[s.length - 1]![0] - n * DAY, `случай ${i}`);
        const ch = change(s, n);
        assert.ok(ch === null || (Number.isFinite(ch) && ch >= -100), `случай ${i}`);
      }
      const e = everyNth(s, 7);
      assert.ok(e.length === Math.ceil(s.length / 7) && (s.length === 0 || e[0] === s[s.length - 1]), `случай ${i}`);
    }
    assert.ok(daysOld(v.rows, NOW) >= 0, `случай ${i}`);
  }
});

test("итоги индекса и ETH/BTC согласованы с рядом", () => {
  const r = rng(SEED + 3);
  for (let i = 0; i < 500; i++) {
    const v = reply(r);
    const s = series(v.rows, 1);
    const st = altStats(s);
    if (!s.length) {
      assert.equal(st, null);
      continue;
    }
    assert.ok(st, `случай ${i}`);
    assert.equal(st.cnt[0] + st.cnt[1] + st.cnt[2], s.length, `случай ${i}`);
    assert.ok(s.every((p) => p[1] <= st.max[1]), `случай ${i}`);
    assert.ok(st.lo[1] <= st.hi[1] && st.hi[1] <= st.max[1], `случай ${i}`);
    assert.ok(st.run >= 1, `случай ${i}`);
    // Серия не длиннее истории, а день её начала — в той же зоне, что сегодня.
    const last = s[s.length - 1]!;
    assert.ok(st.run <= (last[0] - s[0]![0]) / DAY + 1, `случай ${i}`);
    const from = s.find((p) => p[0] >= last[0] - (st.run - 1) * DAY)!;
    assert.equal(seasonOf(from[1]), seasonOf(last[1]), `случай ${i}`);
    const e = ebStats(series(v.rows, 3));
    if (e) {
      assert.ok(e.lo[1] <= e.cur[1] && e.cur[1] <= e.hi[1], `случай ${i}`);
      assert.ok(e.above >= 0 && e.above < 1, `случай ${i}`);
    }
    if (v.btc90 !== null) {
      const b = beat(v.coins, v.btc90);
      assert.equal(b.up + b.dn, v.coins.length, `случай ${i}`);
    }
  }
});

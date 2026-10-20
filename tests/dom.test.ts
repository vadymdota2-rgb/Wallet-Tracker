/* Альтсезон — проверка ответа и расчёты: npm test (node --test). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PX_FROM, STALE_DAYS, ago, altStats, beat, change, daysOld, ebStats, everyNth, seasonOf, series, thin, validDom, windowOf,
  type DomDay,
} from "../src/lib/dom.ts";

const DAY = 86_400;
const T0 = 1_700_006_400; // 15 ноября 2023 г.
const NOW = T0 + 400 * DAY;

/** n дней с T0: индекс, сила, ETH/BTC и цена — от номера дня. */
function rows(n: number, idx: (i: number) => number | null = () => 50): DomDay[] {
  return Array.from({ length: n }, (_, i): DomDay => [T0 + i * DAY, idx(i), 100 + i, 0.03 + i / 1e5, 30_000 + i]);
}
const reply = (r: DomDay[] = rows(300)) => ({ ok: true, rows: r, coins: [["NEAR", 158.3], ["ETH", -5]], btc90: 24.2, n: 50, by: "Hyperliquid", at: NOW });

test("validDom: годный ответ — копия только с известными полями", () => {
  const v = validDom({ ...reply(), extra: "<b>" }, NOW);
  assert.ok(v);
  assert.equal(v.rows.length, 300);
  assert.deepEqual(v.coins, [["NEAR", 158.3], ["ETH", -5]]);
  assert.equal(v.btc90, 24.2);
  assert.equal(v.n, 50);
  assert.equal("extra" in v, false);
  assert.equal("by" in v, false);
});

test("validDom: старый ответ с долями CoinMarketCap и чужие ответы не годятся", () => {
  const old = { ok: true, t0: 1367193600, rows: [[2e6, 58, 11, 2e5, 0.03]], alt: {}, at: NOW };
  for (const bad of [old, null, "x", [], { ok: false, error: "building" }, { ...reply(), ok: "true" },
    { ...reply(), at: NOW + 30 * DAY }, { ...reply(), rows: [] }, { ...reply(), rows: "x" }]) {
    assert.equal(validDom(bad, NOW), null, JSON.stringify(bad).slice(0, 60));
  }
});

test("validDom: любая ошибка в днях — ответ не годится", () => {
  const ok = rows(5);
  const cases: unknown[][] = [
    [[PX_FROM - DAY, 50, 100, 0.03, 30_000]],               // раньше цен Hyperliquid
    [[T0 + 5, 50, 100, 0.03, 30_000]],                      // не начало суток
    [ok[1], ok[0]],                                         // не по порядку
    [ok[0], ok[0]],                                         // повтор
    [[T0, 101, 100, 0.03, 30_000]], [[T0, 50.5, 100, 0.03, 30_000]], [[T0, -1, 100, 0.03, 30_000]],
    [[T0, 50, 0, 0.03, 30_000]], [[T0, 50, Infinity, 0.03, 30_000]], [[T0, 50, 100, 11, 30_000]],
    [[T0, 50, 100, 0.03, 0]], [[T0, 50, 100, 0.03]], [[T0, "50", 100, 0.03, 30_000]],
    [[NOW + 3 * DAY, 50, 100, 0.03, 30_000]],
  ];
  for (const r of cases) assert.equal(validDom({ ...reply(), rows: r }, NOW), null, JSON.stringify(r));
  // Индекса и ETH/BTC может не быть — это годится.
  assert.ok(validDom({ ...reply(), rows: [[T0, null, 100, null, 30_000]] }, NOW));
});

test("validDom: битая монета просто не попадает в список", () => {
  const v = validDom({ ...reply(), coins: [["NEAR", 1], ["<img>", 2], ["X", "3"], ["Y", -101], ["Z"], "q", ["OK", 1e7], ["kPEPE", 5]], btc90: "x", n: 1.5 }, NOW);
  assert.ok(v);
  assert.deepEqual(v.coins, [["NEAR", 1], ["kPEPE", 5]]);
  assert.equal(v.btc90, null);
  assert.equal(v.n, 2);
});

test("seasonOf: границы зон", () => {
  assert.deepEqual([0, 25, 26, 74, 75, 100].map(seasonOf), [0, 0, 1, 1, 2, 2]);
});

test("series, ago, change", () => {
  const r = rows(100, (i) => (i < 10 ? null : i));
  const s = series(r, 1);
  assert.equal(s.length, 90);
  assert.deepEqual(s[0], [T0 + 10 * DAY, 10]);
  assert.deepEqual(ago(s, 1), [T0 + 98 * DAY, 98]);
  assert.deepEqual(ago(s, 30), [T0 + 69 * DAY, 69]);
  assert.equal(ago(s, 1000), null);
  assert.equal(ago([], 1), null);
  assert.ok(Math.abs(change(series(r, 2), 30)! - ((199 / 169 - 1) * 100)) < 1e-9);
  assert.equal(change(s, 1000), null);
  // Пропуск в ряду: берётся ближайший день не позже.
  const gap: [number, number][] = [[T0, 1], [T0 + 5 * DAY, 2], [T0 + 10 * DAY, 4]];
  assert.deepEqual(ago(gap, 3), [T0 + 5 * DAY, 2]);
});

test("altStats: дни в зонах, максимум, год, сколько подряд в нынешней зоне", () => {
  // 400 дней: первые 30 — альтсезон (90), дальше — нейтрально (50), последние 20 — сезон биткоина (10).
  const r = rows(400, (i) => (i < 30 ? 90 : i < 380 ? 50 : 10));
  const st = altStats(series(r, 1))!;
  assert.deepEqual(st.cnt, [20, 350, 30]);
  assert.equal(st.n, 400);
  assert.deepEqual(st.max, [T0, 90]);
  // Год — последние 365 суток: альтсезона в нём нет.
  assert.equal(st.hi[1], 50);
  assert.equal(st.lo[1], 10);
  assert.equal(st.run, 20);
  assert.equal(altStats([]), null);
});

test("ebStats: рост, максимум, минимум, сколько дней было выше", () => {
  const r = rows(400);
  const st = ebStats(series(r, 3))!;
  assert.deepEqual(st.cur, [T0 + 399 * DAY, 0.03 + 399 / 1e5]);
  assert.deepEqual(st.hi, st.cur);
  assert.equal(st.lo[1], 0.03);
  assert.equal(st.above, 0);
  assert.equal(st.ch.length, 3);
  assert.ok(st.ch.every((x) => x !== null && x > 0));
  assert.equal(ebStats(series(rows(59), 3)), null);
});

test("thin: не больше max точек, последняя — всегда", () => {
  const s = Array.from({ length: 2000 }, (_, i) => i);
  const t = thin(s, 600);
  assert.ok(t.length <= 601);
  assert.equal(t[t.length - 1], 1999);
  assert.deepEqual(thin([1, 2, 3], 600), [1, 2, 3]);
  assert.deepEqual(thin([], 600), []);
});

test("windowOf: год, три года, вся история", () => {
  const s = series(rows(1200), 2);
  assert.equal(windowOf(s, "365").length, 365);
  assert.equal(windowOf(s, "1095").length, 1095);
  assert.equal(windowOf(s, "all").length, 1200);
  assert.deepEqual(windowOf([], "365"), []);
});

test("beat: обогнали и отстали", () => {
  assert.deepEqual(beat([["A", 30], ["B", 10], ["C", 20]], 20), { up: 1, dn: 2 });
  assert.deepEqual(beat([], 0), { up: 0, dn: 0 });
});

test("daysOld: сколько полных суток с последнего дня; день из будущего — ноль", () => {
  const r = rows(10);
  const last = r[r.length - 1]![0];
  assert.equal(daysOld(r, last + 3600), 0);
  assert.equal(daysOld(r, last + 3 * DAY + 5), 3);
  assert.equal(daysOld(r, last - 2 * DAY), 0);
  assert.equal(daysOld([], NOW), 0);
  assert.equal(STALE_DAYS, 2);
});

test("everyNth: раз в n суток от последней точки", () => {
  const s: [number, number][] = Array.from({ length: 15 }, (_, i) => [T0 + i * DAY, i]);
  assert.deepEqual(everyNth(s, 7).map((p) => p[1]), [14, 7, 0]);
  assert.deepEqual(everyNth([], 7), []);
});

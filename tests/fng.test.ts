/*
 * «Страх и жадность» — расчёты приложения (src/lib/fng.ts): npm test.
 *
 * Образец ответа — tests/fixtures/fng.json: его собирает сам сервер (wt_fng)
 * из выдуманных источников (tests/fng_fake.py), чужих данных в нём нет.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  F_EST, F_FILL, F_HL, FNG_START, ZONES, afterEntry, analogs, colorOf, currentStreak, dca, distribution, divergence, estUntil,
  forward, median, streakLeft, streakStats, validFng, windowOf, yearExtremes, zoneKey, zoneOf, type FngDay, type FngReply,
} from "../src/lib/fng.ts";

const DAY = 86_400;
const REAL = JSON.parse(readFileSync(new URL("./fixtures/fng.json", import.meta.url), "utf8")) as FngReply & { now: number };
const NOW = REAL.now;
const ok = (r: unknown) => validFng(r, NOW);
/** Ответ из дней с индексами vs (цена — 10 000 + день, флаги 0). */
const make = (vs: number[], start = FNG_START): FngDay[] => vs.map((v, i) => [start + i * DAY, v, 10_000 + i, 0]);
const copy = () => JSON.parse(JSON.stringify(REAL)) as { ok: boolean; days: unknown[][]; at: number; now: number };

test("образец сервера принимается целиком и как есть", () => {
  const v = ok(REAL);
  assert.ok(v);
  assert.equal(v.days.length, REAL.days.length);
  assert.deepEqual(v.days, REAL.days);
  assert.equal(v.at, REAL.at);
  // Только известные поля: now (и любое лишнее) в копию не идёт.
  assert.deepEqual(Object.keys(v).sort(), ["at", "days", "ok"]);
  // В образце есть и досчитанные цены, и заполненные дни.
  assert.ok(v.days.some((d) => d[3] & F_EST));
  assert.ok(v.days.some((d) => d[3] & F_FILL));
});

test("испорченный ответ не принимается", () => {
  const bad: [string, (r: ReturnType<typeof copy>) => void][] = [
    ["ok false", (r) => { r.ok = false; }],
    ["at строкой", (r) => { (r as Record<string, unknown>)["at"] = "1"; }],
    ["at из далёкого будущего", (r) => { r.at = NOW + 400 * DAY; }],
    ["мало дней", (r) => { r.days = r.days.slice(0, 999); }],
    ["дыра", (r) => { r.days.splice(500, 1); }],
    ["дубль", (r) => { r.days.splice(500, 0, r.days[500]!); }],
    ["не по порядку", (r) => { [r.days[3], r.days[4]] = [r.days[4]!, r.days[3]!]; }],
    ["первый день до начала индекса", (r) => { r.days = r.days.map((d) => [Number(d[0]) - 400 * DAY, ...d.slice(1)]); }],
    ["первый день не в полночь", (r) => { r.days = r.days.map((d) => [Number(d[0]) + 3600, ...d.slice(1)]); }],
    ["последний день далеко впереди ответа", (r) => { r.at -= 3 * DAY; }],
    ["индекс 101", (r) => { r.days[7]![1] = 101; }],
    ["индекс −1", (r) => { r.days[7]![1] = -1; }],
    ["индекс дробью", (r) => { r.days[7]![1] = 50.5; }],
    ["индекс строкой", (r) => { r.days[7]![1] = "50"; }],
    ["цена копейками", (r) => { r.days[7]![2] = 5; }],
    ["цена миллиардом", (r) => { r.days[7]![2] = 1e9; }],
    ["цена NaN (null в JSON)", (r) => { r.days[7]![2] = null; }],
    ["флаг 8", (r) => { r.days[7]![3] = 8; }],
    ["флаг дробью", (r) => { r.days[7]![3] = 1.5; }],
    ["день из трёх чисел (старый ответ с Binance)", (r) => { r.days[7] = r.days[7]!.slice(0, 3); }],
    ["день не список", (r) => { r.days[7] = { t: 1 } as unknown as unknown[]; }],
  ];
  for (const [name, spoil] of bad) {
    const r = copy();
    spoil(r);
    assert.equal(ok(r), null, name);
  }
  for (const r of [null, undefined, 1, "x", [], {}, { ok: true }, { ok: true, days: "x", at: 1 }]) assert.equal(ok(r), null);
});

test("цена Hyperliquid (флаг 4) — годный день", () => {
  const r = copy();
  r.days[7]![3] = F_HL;
  assert.equal(ok(r)!.days[7]![3], F_HL);
});

test("история может начинаться и позже 1 февраля 2018", () => {
  const r = copy();
  r.days = r.days.slice(10);
  assert.ok(ok(r));
});

test("часы телефона отстали на полгода — ответ годен", () => {
  assert.ok(validFng(REAL, NOW - 180 * DAY));
  assert.equal(validFng(REAL, NOW - 400 * DAY), null);
});

test("зоны: границы alternative.me", () => {
  const z = [0, 25, 26, 46, 47, 54, 55, 75, 76, 100].map(zoneOf);
  assert.deepEqual(z, [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(zoneKey(50), "fg_z2");
  assert.equal(colorOf(10), ZONES[0].c);
  assert.equal(colorOf(90), ZONES[4].c);
  assert.equal(zoneOf(120), 4);
});

test("медиана", () => {
  assert.equal(median([]), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("окно — последние n дней или вся история", () => {
  const d = make(Array.from({ length: 400 }, () => 50));
  assert.equal(windowOf(d, "30").length, 30);
  assert.equal(windowOf(d, "30")[29], d[399]);
  assert.equal(windowOf(d, "1095").length, 400);
  assert.equal(windowOf(d, "all"), d);
});

test("крайние за год — первый такой день", () => {
  const vs = Array.from({ length: 400 }, () => 50);
  vs[10] = 99; // старше года — не в счёт
  vs[100] = 80;
  vs[200] = 80;
  vs[150] = 5;
  const e = yearExtremes(make(vs))!;
  assert.equal(e.hi[1], 80);
  assert.equal(e.hi[0], FNG_START + 100 * DAY);
  assert.equal(e.lo[1], 5);
  assert.equal(yearExtremes([]), null);
});

test("дни по зонам и среднее", () => {
  const s = distribution(make([10, 10, 30, 50, 60, 90]));
  assert.deepEqual(s.cnt, [2, 1, 1, 1, 1]);
  assert.equal(s.total, 6);
  assert.equal(s.avg, 250 / 6);
  assert.deepEqual(distribution([]), { cnt: [0, 0, 0, 0, 0], avg: 0, total: 0 });
});

test("полосы: средняя по законченным, рекорд — и по идущей, куда дальше", () => {
  // Страх 3 дня → жадность 2 → страх 4 (идёт).
  const d = make([30, 30, 30, 60, 60, 30, 30, 30, 30]);
  const s = streakStats(d, false);
  assert.deepEqual(s[1], { n: 1, sum: 3, max: 4, maxAt: FNG_START + 5 * DAY, next: [0, 0, 0, 1, 0] });
  assert.deepEqual(s[3], { n: 1, sum: 2, max: 2, maxAt: FNG_START + 3 * DAY, next: [0, 1, 0, 0, 0] });
  // Окно с обрезанным началом: первая полоса не в счёт.
  const c = streakStats(d, true);
  assert.equal(c[1]!.n, 0);
  assert.equal(c[1]!.max, 4);
  assert.deepEqual(currentStreak(d), { zi: 1, len: 4 });
  assert.equal(currentStreak([]), null);
});

test("остаток полосы — по прошлым полосам, дожившим до нынешней длины", () => {
  // Пять прошлых полос страха по 4, 6, 7, 11, 20 дней, между ними — день жадности; сейчас — 4 дня страха.
  const vs: number[] = [];
  for (const n of [4, 6, 7, 11, 20]) vs.push(...Array<number>(n).fill(30), 60);
  vs.push(30, 30, 30, 30);
  const d = make(vs);
  const cur = currentStreak(d)!;
  assert.deepEqual(cur, { zi: 1, len: 4 });
  const l = streakLeft(d, cur)!;
  assert.equal(l.n, 5); // и полоса ровно в 4 дня: она дожила до нынешней длины (остаток 0)
  assert.equal(l.med, 3); // остатки 0, 2, 3, 7, 16
  assert.equal(l.week, 2 / 5); // ещё неделя и дольше — 7 и 16
  // Меньше пяти таких полос — выводов нет.
  assert.equal(streakLeft(make([30, 30, 60, 30, 60, 30, 60, 30, 60, 30]), { zi: 1, len: 1 }), null);
});

test("рекорд полосы — первая из равных; полоса с первого дня истории", () => {
  const d = make([10, 10, 60, 10, 10, 60]);
  assert.equal(streakStats(d, false)[0]!.maxAt, FNG_START);
  assert.deepEqual(currentStreak(make([10, 10, 10])), { zi: 0, len: 3 });
});

test("что было с ценой через h дней", () => {
  const d: FngDay[] = make([10, 10, 60, 60]).map((x, i) => [x[0], x[1], [100_000, 110_000, 99_000, 121_000][i]!, 0]);
  const f = forward(d, 1);
  assert.equal(f[0]!.n, 2);
  assert.ok(Math.abs(f[0]!.med) < 1e-12); // +10 % и −10 %
  assert.equal(f[0]!.up, 0.5);
  assert.equal(f[3]!.n, 1);
  assert.ok(Math.abs(f[3]!.med - (121_000 / 99_000 - 1)) < 1e-12);
  // Цены нет — день не в счёт.
  const z = d.map((x, i): FngDay => (i === 1 ? [x[0], x[1], 0, 0] : x));
  assert.equal(forward(z, 1)[0]!.n, 0);
});

test("покупка каждый день: сколько вложено и сколько стало", () => {
  const d: FngDay[] = make([10, 60, 10]).map((x, i) => [x[0], x[1], [10_000, 20_000, 40_000][i]!, 0]);
  const all = dca(d, 10, 0, () => true);
  assert.equal(all.inv, 30);
  assert.ok(Math.abs(all.val - (10 / 10_000 + 10 / 20_000 + 10 / 40_000) * 40_000) < 1e-9);
  const fear = dca(d, 10, 0, (z) => z === 0);
  assert.equal(fear.inv, 20);
  assert.deepEqual(dca(d, 10, FNG_START + 5 * DAY, () => true), { inv: 0, val: 0 });
});

test("после начала зоны: только «свежие» входы (неделя без зоны до)", () => {
  // Крайний страх в день 10 (свежий) и в день 12 (не свежий: был в день 10).
  const vs = Array.from({ length: 200 }, () => 50);
  vs[10] = 10;
  vs[12] = 10;
  const d: FngDay[] = make(vs).map((x, i) => [x[0], x[1], i === 40 ? 5_000 : 10_000, 0]);
  const e = afterEntry(d, 0, true);
  assert.equal(e.n, 1);
  assert.equal(e.move, -0.5);
  assert.equal(e.days, 30);
  assert.equal(e.calm, 0);
});

test("похожие дни и расхождение — на образце сервера без падений", () => {
  const days = ok(REAL)!.days;
  const a = analogs(days);
  assert.ok(a);
  assert.ok(a.n >= 0 && a.up30 >= 0 && a.up30 <= 1);
  assert.equal(analogs(days.slice(0, 399)), null);
  const v = divergence(days);
  assert.ok(v === null || v.kind === "hi" || v.kind === "lo");
  assert.equal(divergence(days.slice(0, 119)), null);
});

test("расхождение: цена на верху 60 дней, настроение — страх", () => {
  const vs = Array.from({ length: 200 }, () => 60);
  vs[199] = 30;
  const d: FngDay[] = make(vs).map((x, i) => [x[0], x[1], 10_000 + i * 10, 0]);
  const v = divergence(d)!;
  assert.equal(v.kind, "hi");
  // Дни без цены не ломают максимум окна.
  const z = d.map((x, i): FngDay => (i === 150 ? [x[0], x[1], 0, 0] : x));
  assert.equal(divergence(z)!.kind, "hi");
});

test("до какого дня цена досчитана", () => {
  const days = ok(REAL)!.days;
  const e = estUntil(days);
  assert.equal(e, days.filter((d) => d[3] & F_EST).at(-1)![0]);
  assert.equal(estUntil(make([50, 50])), 0);
  // Заполненный индекс — не досчитанная цена.
  assert.equal(estUntil(make([50, 50]).map((d): FngDay => [d[0], d[1], d[2], F_FILL])), 0);
});

test("расхождение: цена на дне 60 дней, а настроение не ниже нейтрального; день без цены не дно", () => {
  const vs = Array.from({ length: 200 }, () => 40);
  vs[199] = 60;
  const d: FngDay[] = make(vs).map((x, i) => [x[0], x[1], 20_000 - i * 10, 0]);
  assert.equal(divergence(d)!.kind, "lo");
  const z = d.map((x, i): FngDay => (i === 170 ? [x[0], x[1], 0, 0] : x));
  assert.equal(divergence(z)!.kind, "lo");
});

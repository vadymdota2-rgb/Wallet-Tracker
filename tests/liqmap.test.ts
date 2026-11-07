/*
 * Карта ликвидаций — модуль приложения (src/lib/liqmap.ts): проверка ответа
 * сервера и расчёты экрана; тексты экрана (tools/i18n.json, ключи lq_*), 16 языков.
 * Модель и кэш проверяются на сервере (tests/test_liqmap.py), экран — в
 * браузере (tests/e2e/liqmap.e2e.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AHEAD_MAX, LIQ_OLD_MIN, LIQ_RANGES, ageMin, cumOf, nearest, rowAt, rowsOf, side, sum, sumOn, topLevels, validLiqMap,
} from "../src/lib/liqmap.ts";
import type { LiqMapReply } from "../src/lib/types.ts";

const i18n = JSON.parse(readFileSync(new URL("../tools/i18n.json", import.meta.url), "utf8")) as
  Record<string, Record<string, string>>;
const CJK = "[\\u3040-\\u30ff\\u4e00-\\u9fff]";

test("тексты карты: число не отрывается от слова, французские «:» и «;» — от слова, у китайского и японского — без пробелов у числа (16 языков)", () => {
  const keys = Object.keys(i18n).filter((k) => k.startsWith("lq_"));
  assert.ok(keys.length > 40, String(keys.length));
  for (const key of keys) {
    assert.equal(Object.keys(i18n[key]!).length, 16, key);
    for (const [lang, text] of Object.entries(i18n[key]!)) {
      // {x} — «в 2,1 раза», {p} — доля, {n} — сколько: за ними неразрывный пробел.
      assert.doesNotMatch(text, /\{[nabpkmxv]\} (?=[\p{L}%])/u, `${key}.${lang}`);
      if (lang === "fr") assert.doesNotMatch(text, / [:;?!»]|« /, `${key}.fr`);
      if (lang === "zh" || lang === "ja") {
        assert.doesNotMatch(text, new RegExp(`${CJK}[ \\u00a0]\\{[nabpkmxv]\\}|\\{[nabpkmxv]\\}[ \\u00a0]${CJK}`, "u"), `${key}.${lang}`);
        assert.doesNotMatch(text, /[。，：；！？] /, `${key}.${lang}`);
      }
    }
  }
  assert.ok(i18n["lq_bias_dn"]!["ru"]!.includes("{x} раза"));
  assert.ok(i18n["lq_at_level"]!["fr"]!.endsWith("niveau :"));
  assert.equal(i18n["lq_bias_dn"]!["zh"], "价格下方的清算是上方的{x}倍");
});

test("плечи в «Как читать» — те же пять групп, что в легенде экрана (16 языков)", () => {
  for (const [lang, text] of Object.entries(i18n["lq_how_3"]!)) {
    for (const g of ["3–10×", "20–25×", "50×", "75–100×", "125–500×"]) assert.ok(text.includes(g), `${lang}: ${g}`);
  }
});

const FIX = JSON.parse(readFileSync(new URL("./fixtures/liqmap.json", import.meta.url), "utf8")) as Record<string, LiqMapReply> & { now: number };
const NOW = FIX.now + 60;
const map = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...JSON.parse(JSON.stringify(FIX["1d"])), ...over });

test("ответ сервера: образец всех шести окон проходит как есть", () => {
  for (const rng of LIQ_RANGES) {
    const v = validLiqMap(FIX[rng], NOW);
    assert.ok(v?.ok, rng);
    assert.deepEqual(v, { ...FIX[rng], seen: Math.min(FIX[rng]!.seen!, FIX[rng]!.oi!) }, rng);
  }
});

test("ответ сервера: ошибки — только известные, лишние поля отбрасываются", () => {
  for (const e of ["no_data", "building", "busy", "bad_args"]) assert.deepEqual(validLiqMap({ ok: false, error: e, x: 1 }, NOW), { ok: false, error: e });
  for (const bad of [null, 1, "x", [], { ok: false }, { ok: false, error: "<script>" }, { ok: "true" }]) assert.equal(validLiqMap(bad, NOW), null);
  const v = validLiqMap(map({ evil: "<img>", px: 100 }), NOW) as unknown as Record<string, unknown>;
  assert.ok(v && !("evil" in v));
});

test("ответ сервера: каждое неправдоподобное поле — не ответ", () => {
  const b0 = (FIX["1d"]!.buckets[0])!;
  const bads: Record<string, unknown>[] = [
    { sym: "btc" }, { sym: "B".repeat(13) }, { sym: 1 }, { range: "2d" }, { px: 0 }, { px: -1 }, { px: Infinity }, { px: "1" },
    { step: 0 }, { lo: -1 }, { lo: 1e12 }, { ex: "OKX" }, { ex: [""] }, { ex: Array(65).fill("A") },
    { levs: [] }, { levs: [10, 10] }, { levs: [25, 10] }, { levs: [1.5] }, { levs: Array(9).fill(0).map((_, i) => i + 1) },
    { buckets: "x" }, { buckets: Array(1001).fill(b0) }, { buckets: [{ ...b0, p: 0 }] }, { buckets: [{ ...b0, L: [1, 2] }] },
    { buckets: [{ ...b0, S: [0, 0, 0, 0, -1] }] }, { buckets: [{ ...b0, L: [0.5, 0, 0, 0, 0] }] }, { buckets: [null] },
    { cum: {} }, { cum: { "2": { L: 1, S: 1 }, "5": { L: 1, S: 1 } } }, { cum: { "2": { L: -1, S: 0 }, "5": { L: 0, S: 0 }, "10": { L: 0, S: 0 } } },
    { path: [] }, { path: [0] }, { path: Array(201).fill(1) }, { ohlc: [[1, 2, 3]] }, { ohlc: [[1, 1, 2, 1]] }, { ohlc: [[3, 2, 1, 2]] },
    { ohlc: Array(101).fill([1, 1, 1, 1]) }, { oi: -1 }, { oi: 1.5 }, { seen: -1 }, { at: 0 }, { at: 1.5 }, { at: NOW + AHEAD_MAX + 1 },
  ];
  for (const over of bads) assert.equal(validLiqMap(map(over), NOW), null, JSON.stringify(over).slice(0, 80));
  // Часы телефона отстают меньше чем на сутки — ответ годится.
  assert.ok(validLiqMap(map({ at: NOW + AHEAD_MAX - 10 }), NOW));
  // «Видно» не больше всего интереса.
  assert.equal(validLiqMap(map({ seen: 10 ** 15 }), NOW)?.seen, FIX["1d"]!.oi);
});

test("ответ сервера: каждая проверка — сама по себе", () => {
  const five = (v: number) => [v, 0, 0, 0, 0];
  assert.equal(validLiqMap(map({ ok: 1 }), NOW), null);
  assert.equal(validLiqMap(map({ levs: [], buckets: [] }), NOW), null);
  assert.equal(validLiqMap(map({ levs: [1, 2, 3, 4, 5, 6, 7, 8, 9], buckets: [] }), NOW), null);
  assert.equal(validLiqMap(map({ levs: [25, 10, 50, 100, 500] }), NOW), null);
  assert.equal(validLiqMap(map({ levs: [10, 25, 25, 100, 500] }), NOW), null);
  assert.ok(validLiqMap(map({ levs: [10, 25, 50, 100, 500], buckets: [{ p: 1, L: five(1), S: five(0) }] }), NOW));
});

/** Карта по корзинам: [цена, лонги группы 0, шорты группы 0]. */
function synth(px: number, cells: [number, number, number][]): LiqMapReply {
  return {
    ok: true, sym: "X", range: "1d", px, step: px / 400, lo: 0, ex: [], levs: [10, 25, 50, 100, 500],
    buckets: cells.map(([p, l, sh]) => ({ p, L: [l, l, 0, 0, 0], S: [sh, sh, 0, 0, 0] })),
    cum: {}, path: [px], oi: 0, ohlc: [], at: 1,
  };
}

test("накопленное и скопления — только своей стороны, выключенная группа вычитается", () => {
  // Шорты ниже цены и лонги выше быть не должны — но если пришли, не считаются.
  const r = synth(100, [[95, 10, 7], [99, 5, 0], [101, 0, 3], [105, 9, 4]]);
  const { rows } = rowsOf(r, 10);
  const on = r.levs.map(() => true);
  const c = cumOf(rows, 100, on);
  const at = (p: number) => c[rows.findIndex((w) => p >= w.lo && p < w.hi)]!;
  assert.equal(at(101), 6);
  assert.equal(at(105), 14);
  assert.equal(at(99), 10);
  assert.equal(at(95), 30);
  const off = cumOf(rows, 100, on.map((_, j) => j !== 0));
  assert.equal(off[rows.findIndex((w) => 95 >= w.lo && 95 < w.hi)], 15);
  const up = nearest(r, true)!;
  assert.ok(up.p > 100);
  assert.equal(up.v, 6);
  const dn = topLevels(r, false, 10);
  assert.ok(dn.every((x) => x.p < 100));
  assert.equal(dn[0]!.v, 20);
});

test("ближайшее скопление — первое крупное, а не первое любое", () => {
  // У цены — мелочь ($1), дальше — крупное ($100) и самое крупное ($150).
  const r = synth(100, [[99.7, 1, 0], [97.2, 50, 0], [93.1, 75, 0]]);
  const n = nearest(r, false)!;
  assert.ok(Math.abs(n.p - 97.2) < 1e-9, String(n.p));
  assert.equal(n.v, 100);
});

test("настоящие ликвидации: по свече на каждую, битые — отбрасываются сами, карта остаётся", () => {
  const base = FIX["7d"]!;
  const n = base.ohlc!.length;
  const real = Array.from({ length: n }, (_, i) => [i * 10, i] as [number, number]);
  const ok = validLiqMap({ ...base, real, real_from: 1_700_000_000 }, NOW)!;
  assert.deepEqual(ok.real, real);
  assert.equal(ok.realFrom, 1_700_000_000);
  for (const bad of [real.slice(1), [...real, [1, 1]], real.map(([l]) => [l]), real.map(([l, s]) => [l, -s]),
    real.map(([l, s]) => [l + 0.5, s]), "x", null, real.map(() => ["1", "2"])]) {
    const v = validLiqMap({ ...base, real: bad, real_from: 1 }, NOW)!;
    assert.ok(v.ok, String(bad));
    assert.equal(v.real, undefined);
    assert.equal(v.realFrom, undefined);
  }
  const noFrom = validLiqMap({ ...base, real, real_from: -5 }, NOW)!;
  assert.deepEqual(noFrom.real, real);
  assert.equal(noFrom.realFrom, undefined);
});

test("карта без предыстории — пометка partial только при true", () => {
  const base = FIX["1d"]!;
  assert.equal(validLiqMap({ ...base, partial: true }, NOW)!.partial, true);
  for (const v of [false, 1, "true", null]) assert.equal(validLiqMap({ ...base, partial: v }, NOW)!.partial, undefined, String(v));
  assert.equal(validLiqMap(base, NOW)!.partial, undefined);
});

test("строки экрана: деньги окна не теряются и не берутся из-за края", () => {
  const r = FIX["7d"]!;
  for (const span of [5, 10, 15, 30, 50, 100, 500]) {
    const { rows, rowH } = rowsOf(r, span);
    assert.ok(rows.length <= 81 && rows.length >= 40, `${span}: ${rows.length}`);
    assert.ok(rowH >= 7 && rowH <= 14);
    const lo = Math.max(0, r.px * (1 - span / 100)); // вниз — не ниже нуля
    const hi = r.px * (1 + span / 100);
    const inside = r.buckets.filter((b) => b.p >= lo && b.p < rows[0]!.hi);
    const want = inside.reduce((a, b) => a + sum(b.L) + sum(b.S), 0);
    const got = rows.reduce((a, w) => a + sum(w.L) + sum(w.S), 0);
    assert.equal(got, want, String(span));
    assert.ok(rows[0]!.hi >= hi && rows[rows.length - 1]!.lo <= lo + 1e-9);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i]!.mid < rows[i - 1]!.mid);
  }
});

test("накопленное: растёт от цены наружу, выключенная группа не считается", () => {
  const r = FIX["30d"]!;
  const { rows } = rowsOf(r, 10);
  const on = r.levs.map(() => true);
  const c = cumOf(rows, r.px, on);
  const up = rows.map((w, i) => ({ w, c: c[i]! })).filter((x) => x.w.mid > r.px);
  for (let i = 1; i < up.length; i++) assert.ok(up[i - 1]!.c >= up[i]!.c);
  const dn = rows.map((w, i) => ({ w, c: c[i]! })).filter((x) => x.w.mid < r.px);
  for (let i = 1; i < dn.length; i++) assert.ok(dn[i]!.c >= dn[i - 1]!.c);
  const off = cumOf(rows, r.px, on.map((_, j) => j !== 0));
  assert.ok(off.every((v, i) => v <= c[i]!));
  assert.equal(sumOn([1, 2, 3], [true, false, true]), 4);
  assert.equal(side(rows[0]!, r.px), rows[0]!.S);
  assert.equal(side(rows[rows.length - 1]!, r.px), rows[rows.length - 1]!.L);
});

test("строка у цены, ближайшее и крупнейшие скопления", () => {
  const r = FIX["7d"]!;
  const i = rowAt(r, 10, r.px);
  const { rows } = rowsOf(r, 10);
  assert.ok(r.px >= rows[i]!.lo && r.px < rows[i]!.hi);
  assert.equal(rowAt(r, 10, r.px * 3), -1);
  for (const up of [true, false]) {
    const n = nearest(r, up);
    assert.ok(n, String(up));
    assert.ok(up ? n.d > 0 && n.d <= 10.5 : n.d < 0 && n.d >= -10.5);
    for (const span of [5, 15, 100]) {
      const top = topLevels(r, up, span);
      assert.ok(top.length <= 3);
      for (const x of top) assert.ok(Math.abs(x.p / r.px - 1) <= span / 100 + 1e-9 && (up ? x.p > r.px : x.p < r.px));
      for (let a = 0; a < top.length; a++) for (let b = a + 1; b < top.length; b++) assert.ok(Math.abs(top[a]!.k - top[b]!.k) >= 2);
      for (let a = 1; a < top.length; a++) assert.ok(top[a - 1]!.v >= top[a]!.v);
    }
  }
  assert.equal(nearest({ ...r, buckets: [] }, true), null);
});

test("возраст карты: пометка о старых данных — с 40 минут, часы назад — не минус", () => {
  assert.equal(LIQ_OLD_MIN, 40);
  assert.equal(ageMin(1000, 1000 + 39 * 60 + 59), 39);
  assert.equal(ageMin(1000, 1000 + 40 * 60), 40);
  assert.equal(ageMin(1000, 0), 0);
});

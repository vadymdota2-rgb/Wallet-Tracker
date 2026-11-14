/*
 * Свойства (инварианты) скринера на тысячах случайных входов (node --test).
 *
 * Не «пример → ответ», а правила, которые обязаны выполняться всегда:
 * проверка ответа сервера не падает на мусоре и пропускает только годное;
 * фильтр отдаёт подмножество в правильном порядке; подтверждения и порядок
 * не теряют и не дублируют монеты. Генератор детерминированный (SEED):
 * нарушение воспроизводится — номер случая в сообщении.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANY, badgeTfs, chase, confirms, consensus, EXTRA_ANY, LATE_STEPS, late, mainTf, matches, pending, RR_STEPS, RSI_ZONES, rr,
  SCREEN_TFS, SCREEN_WARM, SINCE_MAX, SORTS, screen, signal, toggleCol, validCols, validExtra, validFilter, validScreener,
  VOL_STEPS, ADX_STEPS, wanted, type Extra, type ScreenFilter, type ScreenTf,
} from "../src/lib/screener.ts";

const SEED = 0x5c_2ee7;
const CASES = 3_000;
const NOW = 1_794_100_000;
const JUNK: unknown[] = [null, undefined, "", "x", "1", NaN, Infinity, -Infinity, -1, 0, 0.5, 1e300, true, [], {}, "<b>", [NaN], { s: 1 }];

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
const pick = <T,>(r: () => number, a: readonly T[]): T => a[Math.floor(r() * a.length)]!;
const maybe = (r: () => number, v: unknown, p = 0.05): unknown => (r() < p ? pick(r, JUNK) : v);

function packed(r: () => number): unknown {
  if (r() < 0.2) return maybe(r, +(r() * 2.4 - 1.2).toFixed(3));
  const age = r() < 0.1 ? SINCE_MAX + 1 : r() < 0.2 ? null : Math.floor(r() * (SINCE_MAX + 1));
  return [r() * 2.4 - 1.2, r() * 2 - 1, r() * 2 - 1, r() * 120 - 10, r() * 110, r() * 6, r() * 8, r() * 20 - 2, -r() * 30,
    age === SINCE_MAX + 1 || age === null ? null : r() * 20 - 10, age].map((v) => maybe(r, v, 0.03)).slice(0, r() < 0.05 ? Math.floor(r() * 11) : 11);
}

function reply(r: () => number): unknown {
  if (r() < 0.03) return pick(r, JUNK);
  const rows: unknown[] = [];
  const n = Math.floor(r() * 40);
  for (let i = 0; i < n; i++) {
    const rr_: Record<string, unknown> = {};
    for (const tf of SCREEN_TFS) if (r() < 0.4) rr_[tf] = packed(r);
    if (r() < 0.05) rr_["evil"] = 0.5;
    rows.push(maybe(r, {
      s: maybe(r, pick(r, ["BTC", "ETH", "SOL", "1000SATS", "btc", "<b>", "A".repeat(17), "X" + i]), 0.1),
      px: maybe(r, r() * 1e5), ch: maybe(r, r() * 40 - 20), f: pick(r, [1, 0, undefined, "1", true]), r: maybe(r, rr_, 0.03),
    }));
  }
  return maybe(r, { ok: maybe(r, true, 0.02), at: maybe(r, NOW - Math.floor(r() * 4000), 0.02), tfs: maybe(r, ["15m", "1m", "x"]), rows }, 0.02);
}

function filter(r: () => number): ScreenFilter {
  const f = { ...ANY };
  for (const tf of SCREEN_TFS) if (r() < 0.15) f[tf] = pick(r, ["buy", "sell"] as const);
  return f;
}
function extra(r: () => number): Extra {
  return {
    vol: r() < 0.3 ? pick(r, VOL_STEPS) : 0, adx: r() < 0.3 ? pick(r, ADX_STEPS) : 0, rsi: r() < 0.3 ? pick(r, RSI_ZONES) : "any",
    rr: r() < 0.3 ? pick(r, RR_STEPS) : 0, late: r() < 0.3 ? pick(r, LATE_STEPS) : 0, sort: pick(r, SORTS),
  };
}
const within = (v: number | null, lo: number, hi: number) => v === null || (Number.isFinite(v) && v >= lo && v <= hi);

test("ответ: мусор не роняет, проходит только годное — тикер, рамки каждого числа, без повторов", () => {
  const r = rng(SEED);
  let good = 0;
  for (let i = 0; i < CASES; i++) {
    const v = validScreener(reply(r), NOW);
    if (!v) continue;
    good++;
    assert.ok(v.rows.length > 0, `случай ${i}`);
    assert.equal(new Set(v.rows.map((x) => x.s)).size, v.rows.length, `случай ${i}: повтор`);
    for (const row of v.rows) {
      assert.match(row.s, /^[A-Z0-9]{1,16}$/, `случай ${i}`);
      assert.ok(within(row.px, 0, 1e9) && within(row.ch, -1e4, 1e4), `случай ${i}`);
      assert.ok(SCREEN_TFS.some((tf) => row.r[tf] !== null), `случай ${i}: строка без рейтинга`);
      for (const tf of SCREEN_TFS) {
        assert.ok(within(row.r[tf], -1, 1), `случай ${i}`);
        const m = row.m[tf];
        if (!m) continue;
        assert.notEqual(row.r[tf], null, `случай ${i}: метрики без рейтинга`);
        assert.ok(within(m.rsi, 0, 100) && within(m.adx, 0, 100) && within(m.sl, -100, 0) && within(m.tp, 0, 1e4), `случай ${i}`);
        assert.ok(m.age === null || (Number.isInteger(m.age) && m.age >= 0 && m.age <= SINCE_MAX + 1), `случай ${i}`);
        const q = rr(m);
        assert.ok(q === null || (Number.isFinite(q) && q >= 0), `случай ${i}`);
      }
      const c = consensus(row);
      assert.ok(c.up + c.dn <= c.of && c.of <= SCREEN_TFS.length, `случай ${i}`);
    }
    for (const tf of v.warm) assert.ok(SCREEN_TFS.includes(tf));
  }
  assert.ok(good > CASES / 3, String(good));
});

test("фильтр: подмножество, каждая монета подходит, без повторов; порядок «сигнал» — по убыванию силы", () => {
  const r = rng(SEED + 1);
  for (let i = 0; i < CASES; i++) {
    const v = validScreener(reply(r), NOW);
    if (!v) continue;
    const f = filter(r);
    const x = extra(r);
    const tf = mainTf(f);
    const got = screen(v.rows, f, x);
    assert.equal(new Set(got).size, got.length, `случай ${i}`);
    for (const row of got) {
      assert.ok(v.rows.includes(row), `случай ${i}`);
      assert.ok(matches(row, f) && confirms(row, tf, x), `случай ${i}`);
    }
    // Всё, что подходит, — в ответе (фильтр ничего не теряет).
    assert.equal(got.length, v.rows.filter((row) => matches(row, f) && confirms(row, tf, x)).length, `случай ${i}`);
    const used = SCREEN_TFS.filter((t) => f[t] !== "any");
    if (x.sort === "sig" && used.length) {
      const k = got.map((row) => used.reduce((s, t) => s + Math.abs(row.r[t] ?? 0), 0));
      for (let j = 1; j < k.length; j++) assert.ok(k[j - 1]! >= k[j]!, `случай ${i}`);
    }
    if (x.late) {
      for (const row of got) {
        const q = chase(row, tf);
        assert.ok(q !== null && q <= x.late, `случай ${i}`);
      }
    }
    // Без фильтра и подтверждений — все и в порядке сервера.
    if (!used.length) assert.deepEqual(screen(v.rows, f, EXTRA_ANY), v.rows, `случай ${i}`);
  }
});

test("ход с сигнала: знак — по сигналу, «давно» и нейтрально — нет; «поздно» — только при ходе в сторону сигнала", () => {
  const r = rng(SEED + 2);
  for (let i = 0; i < CASES; i++) {
    const v = validScreener(reply(r), NOW);
    if (!v) continue;
    for (const row of v.rows) {
      for (const tf of SCREEN_TFS) {
        const q = chase(row, tf);
        const m = row.m[tf];
        const s = row.r[tf] === null ? 0 : Math.sign(signal(row.r[tf]!));
        if (q !== null) {
          assert.ok(m && m.mv !== null && m.age !== null && m.age <= SINCE_MAX && s !== 0, `случай ${i}`);
          assert.equal(q, s * m.mv!, `случай ${i}`);
        }
        if (late(row, tf)) assert.ok(q !== null && q > 0, `случай ${i}`);
      }
    }
  }
});

test("с устройства: фильтр, подтверждения и столбцы — только известные значения, повторная проверка ничего не меняет", () => {
  const r = rng(SEED + 3);
  const any = (): unknown => {
    const o: Record<string, unknown> = {};
    for (const k of [...SCREEN_TFS, "vol", "adx", "rsi", "rr", "late", "sort", "evil"]) {
      if (r() < 0.4) o[k] = pick(r, [...JUNK, "buy", "sell", "any", "os", "ob", "mid", "fresh", "rr", 0, 1, 1.5, 2, 3, 5, 20, 25, 40]);
    }
    return r() < 0.1 ? pick(r, JUNK) : r() < 0.2 ? Object.keys(o) : o;
  };
  for (let i = 0; i < CASES; i++) {
    const raw = any();
    const f = validFilter(raw);
    assert.deepEqual(validFilter(f), f);
    const x = validExtra(raw);
    assert.deepEqual(validExtra(x), x);
    assert.ok((VOL_STEPS as readonly number[]).includes(x.vol) && (LATE_STEPS as readonly number[]).includes(x.late), `случай ${i}`);
    const c = validCols(raw);
    assert.deepEqual(validCols(c), c);
    assert.equal(new Set(c).size, c.length);
    // Касание столбца дважды — как было.
    const tf = pick(r, SCREEN_TFS);
    assert.deepEqual(toggleCol(toggleCol(c, tf), tf), c);
    // Значки — по порядку таймфреймов; серверу — только не основные; ждём — подмножество значков.
    const b = badgeTfs(f, c);
    assert.deepEqual(b, SCREEN_TFS.filter((t) => b.includes(t)));
    for (const t of wanted(f, c)) assert.ok(b.includes(t) && !SCREEN_WARM.includes(t));
    for (const t of pending(f, null, c)) assert.ok(b.includes(t as ScreenTf));
  }
});

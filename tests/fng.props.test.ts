/*
 * Свойства (инварианты) «Страха и жадности» на тысячах случайных входов.
 *
 * Как у халвинга, ETF и альтсезона: не «пример → ответ», а правила, которые
 * обязаны выполняться всегда. Генератор детерминированный (зерно SEED) —
 * найденное нарушение воспроизводится, номер случая есть в сообщении.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  F_EST, F_FILL, FNG_START, ZONES, currentStreak, dca, distribution, forward, streakLeft, streakStats, validFng, windowOf,
  yearExtremes, zoneOf, type FngDay, type FngReply,
} from "../src/lib/fng.ts";

const SEED = 0xfe_a12;
const CASES = 2_000;
const DAY = 86_400;
const REAL = JSON.parse(readFileSync(new URL("./fixtures/fng.json", import.meta.url), "utf8")) as FngReply & { now: number };
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

/** Случайная история: индекс бродит по зонам, цена — случайное блуждание, иногда без цены. */
function history(r: () => number, n: number): FngDay[] {
  const out: FngDay[] = [];
  let v = Math.floor(r() * 101);
  let p = 1000 + r() * 100_000;
  for (let i = 0; i < n; i++) {
    v = Math.max(0, Math.min(100, v + Math.round((r() - 0.5) * (r() < 0.1 ? 60 : 12))));
    p = Math.max(1001, Math.min(9_999_999, p * Math.exp((r() - 0.5) * 0.1)));
    const f = (r() < 0.3 ? F_EST : 0) | (r() < 0.01 ? F_FILL : 0);
    out.push([FNG_START + i * DAY, v, r() < 0.02 ? 0 : Math.round(p * 100) / 100, f]);
  }
  return out;
}

test("годный ответ принимается, любая порча одного поля — нет", () => {
  const r = rng(SEED);
  for (let c = 0; c < 300; c++) {
    const days = history(r, 1000 + Math.floor(r() * 300));
    const at = days[days.length - 1]![0] + Math.floor(r() * DAY);
    const good = { ok: true, days, at };
    assert.ok(validFng(good, at), `случай ${c}`);
    const bad = JSON.parse(JSON.stringify(good)) as { days: unknown[][] };
    const i = Math.floor(r() * days.length);
    const k = Math.floor(r() * 4);
    const spoil: unknown[] = [
      [Number(bad.days[i]![0]) + 1, -1, 101, 5][k],
      [null, "1", 1.5, NaN][Math.floor(r() * 4)],
    ];
    bad.days[i]![k] = r() < 0.5 ? spoil[0] : spoil[1];
    // Цена 0 — законна (дня без цены), флаг 1 или 2 — тоже: такие «порчи» не проверяем.
    const v = bad.days[i]![k];
    if ((k === 2 && v === 0) || (k === 3 && (v === 1 || v === 2 || v === 3))) continue;
    if (k === 0 && i === 0 && typeof v === "number" && v >= FNG_START && v % DAY === 0) continue;
    assert.equal(validFng(bad, at), null, `случай ${c}: день ${i}, поле ${k} = ${String(v)}`);
  }
});

test("распределение по зонам — все дни окна, доли в сумме 1", () => {
  const r = rng(SEED + 1);
  for (let c = 0; c < CASES; c++) {
    const days = history(r, 1 + Math.floor(r() * 400));
    const s = distribution(days);
    assert.equal(s.cnt.reduce((a, b) => a + b, 0), days.length, `случай ${c}`);
    assert.ok(s.avg >= 0 && s.avg <= 100, `случай ${c}`);
    const e = yearExtremes(days)!;
    const y = days.slice(-365);
    assert.ok(y.every((d) => d[1] <= e.hi[1] && d[1] >= e.lo[1]), `случай ${c}`);
  }
});

test("полосы: длины складываются в дни, рекорд не меньше средней, переходы — в другую зону", () => {
  const r = rng(SEED + 2);
  for (let c = 0; c < CASES; c++) {
    const days = history(r, 1 + Math.floor(r() * 400));
    const s = streakStats(days, false);
    const cur = currentStreak(days)!;
    // Все законченные полосы + идущая = все дни.
    assert.equal(s.reduce((a, x) => a + x.sum, 0) + cur.len, days.length, `случай ${c}`);
    for (let z = 0; z < ZONES.length; z++) {
      const x = s[z]!;
      assert.equal(x.next.reduce((a, b) => a + b, 0), x.n, `случай ${c}`);
      assert.equal(x.next[z], 0, `случай ${c}: полоса не переходит в свою же зону`);
      if (x.n) assert.ok(x.max >= x.sum / x.n, `случай ${c}`);
      if (x.max) assert.equal(zoneOf(days.find((d) => d[0] === x.maxAt)![1]), z, `случай ${c}`);
    }
    // Идущая полоса — действительно последние cur.len дней одной зоны.
    const tail = days.slice(-cur.len);
    assert.ok(tail.every((d) => zoneOf(d[1]) === cur.zi), `случай ${c}`);
    const before = days[days.length - cur.len - 1];
    assert.ok(!before || zoneOf(before[1]) !== cur.zi, `случай ${c}`);
    const l = streakLeft(days, cur);
    if (l) {
      assert.ok(l.n >= 5 && l.med >= 0 && l.week >= 0 && l.week <= 1, `случай ${c}`);
    }
    // Окно с обрезанным началом не считает первую полосу.
    const w = streakStats(windowOf(days, "30"), true);
    assert.ok(w.reduce((a, x) => a + x.sum, 0) <= Math.min(30, days.length), `случай ${c}`);
  }
});

test("что было после: доли 0–1, случаев не больше дней", () => {
  const r = rng(SEED + 3);
  for (let c = 0; c < 400; c++) {
    const days = history(r, 50 + Math.floor(r() * 400));
    const h = 1 + Math.floor(r() * 40);
    const f = forward(days, h);
    assert.ok(f.reduce((a, x) => a + x.n, 0) <= Math.max(0, days.length - h), `случай ${c}`);
    for (const x of f) {
      assert.ok(x.up >= 0 && x.up <= 1 && Number.isFinite(x.med) && x.med > -1, `случай ${c}`);
    }
    const all = dca(days, 10, 0, () => true);
    const some = dca(days, 10, 0, (z) => z <= 1);
    assert.ok(some.inv <= all.inv && Number.isFinite(all.val) && all.val >= 0, `случай ${c}`);
  }
});

test("образец сервера переживает круг «сохранить на устройство → прочитать»", () => {
  const v = validFng(REAL, NOW)!;
  const back = validFng(JSON.parse(JSON.stringify(v)), NOW);
  assert.deepEqual(back, v);
});

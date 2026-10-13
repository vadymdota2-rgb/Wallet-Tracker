/*
 * Свойства (инварианты) расчёта халвинга на тысячах случайных входов.
 *
 * Как в коде блокчейнов: не «пример → ответ», а правила, которые обязаны
 * выполняться всегда. Генератор детерминированный (зерно SEED), поэтому
 * найденное нарушение воспроизводится — номер случая есть в сообщении.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { halvingView, subsidySats, validHalving, type HalvingReply } from "../src/lib/halving.ts";

const SEED = 0x5eed_2028;
const CASES = 20_000;
const GENESIS = 1_231_006_505;

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

/** Правдоподобный ответ сервера: любая эпоха, любая точка в ней. */
function reply(r: () => number): HalvingReply {
  const every = 210_000;
  const epoch = 4 + Math.floor(r() * 6);
  const next = (epoch + 1) * every;
  const height = next - every + Math.floor(r() * every);
  const avg = 300 + r() * 900;
  // at — не раньше, чем высота могла быть достигнута при блоке раз в 5 минут.
  const at = Math.max(1_700_000_000, GENESIS + height * 300) + Math.floor(r() * 1e8);
  const tip = at - Math.floor(r() * 86_400);
  const h: HalvingReply = { ok: true, height, next, every, avg, at, src: (["epoch", "period", "nominal"] as const)[Math.floor(r() * 3)]! };
  if (r() < 0.9) h.tip = tip;
  if (r() < 0.9) h.eta = Math.floor(tip + (next - height) * avg * (0.8 + r() * 0.4));
  if (r() < 0.5) h.prev = at - Math.floor(r() * 4e7);
  if (r() < 0.5) h.skew = Math.floor((r() - 0.5) * 7200);
  return h;
}

test(`инварианты отсчёта на ${CASES} случайных ответах`, () => {
  const r = rng(SEED);
  for (let i = 0; i < CASES; i++) {
    const h = reply(r);
    assert.equal(validHalving(h), true, `случай ${i}: правдоподобный ответ отвергнут`);
    const now = h.at - 1e6 + Math.floor(r() * 2e8);
    const v = halvingView(h, now);
    const start = h.next - h.every;
    const msg = `случай ${i}: ${JSON.stringify({ h, now, v })}`;
    // Остаток — целые неотрицательные секунды, разложенные без потерь.
    assert.ok(Number.isInteger(v.left) && v.left >= 0, msg);
    const [d, hh, m, s] = v.parts;
    assert.ok(hh < 24 && m < 60 && s < 60 && [d, hh, m, s].every((x) => Number.isInteger(x) && x >= 0), msg);
    assert.equal(d * 86400 + hh * 3600 + m * 60 + s, v.left, msg);
    // Высота — внутри эпохи; номер блока халвинга — только когда остаток 0.
    assert.ok(v.height >= start && v.height <= h.next, msg);
    assert.equal(v.height === h.next, v.left === 0, msg);
    // Полоса 0–100; подпись до халвинга не больше 99,9 и не дальше 0,05 от полосы.
    assert.ok(v.done >= 0 && v.done <= 100, msg);
    assert.ok(v.left > 0 ? v.donePct <= 99.9 && Math.abs(v.donePct - v.done) <= 0.05 + 1e-9 || v.donePct === 99.9 : v.donePct === 100, msg);
    // Награда — по эпохе, следующая — ровно вдвое меньше (с отбрасыванием, как в сети).
    assert.equal(v.reward, subsidySats(start / h.every), msg);
    assert.equal(v.rewardNext, Math.floor(v.reward / 2), msg);
    // Дата — настоящее время: формат даты не должен падать.
    assert.ok(Number.isFinite(v.eta) && !Number.isNaN(new Date(v.eta * 1000).getTime()), msg);
    // «Состоялся» — только про prev и только в окне двух недель.
    assert.ok(v.justHappened === null || (v.justHappened === h.prev && now - h.prev >= 0 && now - h.prev < 14 * 86400), msg);
  }
});

test("монотонность: с ходом времени остаток не растёт, высота и полоса не убывают", () => {
  const r = rng(SEED + 1);
  for (let i = 0; i < 2_000; i++) {
    const h = reply(r);
    let t = h.at - 1e5;
    let prev = halvingView(h, t);
    for (let k = 1; k <= 40; k++) {
      t += Math.floor(1 + r() * 5e6); // время только вперёд
      const v = halvingView(h, t);
      const msg = `случай ${i}, шаг ${k}`;
      assert.ok(v.left <= prev.left, msg);
      assert.ok(v.height >= prev.height, msg);
      assert.ok(v.done >= prev.done, msg);
      prev = v;
    }
  }
});

test("мусор на входе: проверка не падает, а пропущенное не ломает расчёт", () => {
  const r = rng(SEED + 2);
  const junk = [undefined, null, true, false, "", "1", "abc", -1, 0, 0.5, 1e30, -1e30, NaN, Infinity, -Infinity, [], {}, [1], 1e15];
  const pick = () => (r() < 0.5 ? junk[Math.floor(r() * junk.length)] : Math.floor(r() * 4e9));
  const base = reply(rng(SEED + 3));
  let accepted = 0;
  for (let i = 0; i < CASES; i++) {
    const h: Record<string, unknown> = { ...base };
    for (const k of Object.keys(base).concat(["now", "skew", "prev"])) if (r() < 0.25) h[k] = pick();
    let ok = false;
    assert.doesNotThrow(() => { ok = validHalving(h); }, `случай ${i}`);
    if (!ok) continue;
    accepted++;
    const v = halvingView(h as unknown as HalvingReply, base.at);
    const nums = [v.left, v.height, v.done, v.donePct, v.eta, v.reward, v.rewardNext, ...v.parts];
    assert.ok(nums.every(Number.isFinite), `случай ${i}: ${JSON.stringify(h)} → ${JSON.stringify(v)}`);
    assert.ok(!Number.isNaN(new Date(v.eta * 1000).getTime()), `случай ${i}`);
  }
  assert.ok(accepted > 100, `проверка пропустила слишком мало (${accepted}) — генератор сломан`);
});

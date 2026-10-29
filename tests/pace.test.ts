/*
 * Частота запросов приложения (src/lib/pace.ts): npm test.
 *
 * Норма nginx — 120 запросов в минуту на человека. Раньше неполная выгрузка
 * переспрашивалась каждые 2,5 с, и каждый раз заново шла подгрузка (~60
 * запросов): у одного телефона выходило 254 запроса за минуту и сотни
 * отказов. Здесь — правила, которые это исключают.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PREFETCH_GAP, SOON_DELAY, SOON_MAX, drain, gate, nextSoon } from "../src/lib/pace.ts";

test("неполная выгрузка: 2,5 → 5 → 10 → 20 → 30 с, дальше не чаще раза в 30 с", () => {
  const seq: number[] = [];
  for (let d = SOON_DELAY, i = 0; i < 8; i++, d = nextSoon(d)) seq.push(d);
  assert.deepEqual(seq, [2_500, 5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000]);
  // За первую минуту — не больше шести выгрузок, а не двадцать четыре.
  let t = 0;
  let n = 0;
  for (let d = SOON_DELAY; t + d <= 60_000; d = nextSoon(d)) {
    t += d;
    n++;
  }
  assert.ok(n <= 6, `${n} выгрузок за минуту`);
  assert.equal(SOON_MAX, 30_000);
});

test("подгрузка — не чаще раза в минуту, сколько бы ни было выгрузок", () => {
  const due = gate(PREFETCH_GAP);
  assert.equal(PREFETCH_GAP, 60_000);
  assert.equal(due(1_000), true);
  // Выгрузки каждые 2,5 с в течение минуты — подгрузка не повторяется.
  for (let t = 3_500; t < 61_000; t += 2_500) assert.equal(due(t), false, `t=${t}`);
  assert.equal(due(61_000), true);
  assert.equal(due(61_001), false);
});

test("очередь: не больше parallel разом и все задания по порядку", async () => {
  let now = 0;
  let peak = 0;
  const done: number[] = [];
  const jobs = Array.from({ length: 10 }, (_, i) => async () => {
    now++;
    peak = Math.max(peak, now);
    await new Promise((ok) => setTimeout(ok, 5));
    now--;
    done.push(i);
  });
  await drain(jobs, 4);
  assert.equal(peak, 4);
  assert.deepEqual([...done].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("очередь: сервер сказал «слишком часто» — остальное не шлём", async () => {
  let limited = false;
  const sent: number[] = [];
  const jobs = Array.from({ length: 60 }, (_, i) => async () => {
    sent.push(i);
    if (i === 5) limited = true; // шестой запрос получил 429
    await Promise.resolve();
  });
  await drain(jobs, 4, () => limited);
  // Уже начатые доходят, новых — нет: из шестидесяти ушло меньше десяти.
  assert.ok(sent.length < 10, `ушло ${sent.length}`);
  assert.ok(sent.includes(5));
});

test("очередь: упавшее задание не останавливает остальные", async () => {
  const done: number[] = [];
  const jobs = [0, 1, 2].map((i) => async () => {
    if (i === 1) throw new Error("сеть");
    done.push(i);
  });
  await drain(jobs, 1);
  assert.deepEqual(done, [0, 2]);
});

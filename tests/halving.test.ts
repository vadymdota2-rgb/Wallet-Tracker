/* Отсчёт до халвинга: npm test (node --test, типы Node снимает сам). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clockSkew, halvingView, subsidySats, validHalving } from "../src/lib/halving.ts";

// Настоящий ответ сервера от 13.10.2026.
const REAL = {
  ok: true, height: 971219, next: 1050000, every: 210000, avg: 596.8, src: "epoch" as const,
  tip: 1791881177, eta: 1838896423, at: 1791881255,
};

test("validHalving: настоящий ответ годится", () => {
  assert.equal(validHalving(REAL), true);
});

test("validHalving: мусор не годится", () => {
  const bad: unknown[] = [
    null, undefined, "x", 42, {}, { ...REAL, ok: false }, { ...REAL, height: 0 }, { ...REAL, height: 971219.5 },
    { ...REAL, next: 1049999 }, { ...REAL, height: 1050000 }, { ...REAL, height: 839999 }, { ...REAL, every: 0 },
    { ...REAL, avg: 0 }, { ...REAL, avg: Number.NaN }, { ...REAL, avg: 5000 }, { ...REAL, at: 0 },
  ];
  for (const b of bad) assert.equal(validHalving(b), false, JSON.stringify(b));
});

test("clockSkew: мелочь не трогаем, большие расхождения учитываем", () => {
  assert.equal(clockSkew(1000, 990), 0);
  assert.equal(clockSkew(1000, 1060), 0);
  assert.equal(clockSkew(10_000, 6_400), 3600);
  assert.equal(clockSkew(1000, 1200), -200);
  assert.equal(clockSkew(undefined, 1000), 0);
  assert.equal(clockSkew(Number.NaN, 1000), 0);
});

test("subsidySats: как в консенсусе биткоина", () => {
  assert.equal(subsidySats(0), 5_000_000_000);
  assert.equal(subsidySats(3), 625_000_000);
  assert.equal(subsidySats(4), 312_500_000);
  assert.equal(subsidySats(5), 156_250_000);
  assert.equal(subsidySats(32), 1);
  assert.equal(subsidySats(33), 0);
  assert.equal(subsidySats(64), 0);
});

test("halvingView: через минуту после ответа", () => {
  const now = REAL.tip + 60;
  const v = halvingView(REAL, now);
  assert.equal(v.left, REAL.eta - now);
  const [d, h, m, s] = v.parts;
  assert.equal(d * 86400 + h * 3600 + m * 60 + s, v.left);
  assert.ok(h < 24 && m < 60 && s < 60);
  assert.equal(v.height, REAL.height);
  assert.ok(Math.abs(v.done - 62.485) < 0.001);
  assert.equal(v.reward, 312_500_000);
  assert.equal(v.rewardNext, 156_250_000);
  assert.equal(v.eta, REAL.eta);
});

test("halvingView: высота растёт по среднему, но не доходит до халвинга раньше времени", () => {
  assert.equal(halvingView(REAL, REAL.tip + Math.ceil(10 * REAL.avg)).height, REAL.height + 10);
  // Оценка скорости ошиблась: по среднему блоков «вышло» больше, чем осталось.
  const off = { ...REAL, eta: REAL.tip + 10 * 365 * 86400 };
  assert.equal(halvingView(off, REAL.tip + 9 * 365 * 86400).height, REAL.next - 1);
});

test("halvingView: халвинг прошёл — ноль, полная полоса, номер блока халвинга", () => {
  const v = halvingView(REAL, REAL.eta + 5);
  assert.equal(v.left, 0);
  assert.deepEqual(v.parts, [0, 0, 0, 0]);
  assert.equal(v.height, REAL.next);
  assert.equal(v.done, 100);
});

test("halvingView: часы телефона раньше времени ответа — полоса не уходит назад", () => {
  const v = halvingView(REAL, REAL.tip - 3600);
  assert.equal(v.height, REAL.height);
  assert.ok(v.done >= 0 && v.done <= 100);
});

test("halvingView: старый ответ без eta и tip считается от at", () => {
  const old = { ok: true, height: 971219, next: 1050000, every: 210000, avg: 600, at: 1791881255 };
  const v = halvingView(old, old.at);
  assert.equal(v.left, (old.next - old.height) * 600);
});

test("halvingView: первая эпоха и следующие — награда по эпохе", () => {
  const e0 = { ...REAL, height: 100, next: 210000, tip: undefined, eta: undefined };
  assert.equal(halvingView(e0, REAL.at).reward, 5_000_000_000);
  const e5 = { ...REAL, height: 1050001, next: 1260000, tip: undefined, eta: undefined };
  const v = halvingView(e5, REAL.at);
  assert.equal(v.reward, 156_250_000);
  assert.equal(v.rewardNext, 78_125_000);
});

test("halvingView: подпись процента не показывает 100 % до халвинга", () => {
  // До халвинга 10 блоков из 210 000: 99,995 %.
  const near = { ...REAL, height: REAL.next - 10, tip: REAL.at, eta: REAL.at + 6000 };
  const v = halvingView(near, REAL.at);
  assert.ok(v.done > 99.99);
  assert.equal(v.donePct, 99.9);
  assert.equal(halvingView(REAL, REAL.eta + 1).donePct, 100);
  // Обычное округление в остальном: 62,485 → 62,5, а не 62,4.
  assert.equal(halvingView(REAL, REAL.tip + 60).donePct, 62.5);
});

test("validHalving: повреждённые необязательные поля — ответ отбрасывается", () => {
  // Каждый из них раньше проходил проверку и ронял отрисовку или отсчёт.
  const bad: Record<string, unknown>[] = [
    { eta: "abc" }, { eta: 1e30 }, { eta: Number.NaN }, { tip: "x" }, { now: -1 }, { prev: true },
    { skew: "5" }, { skew: Number.POSITIVE_INFINITY }, { skew: 400 * 86400 }, { src: "magic" },
  ];
  for (const b of bad) assert.equal(validHalving({ ...REAL, ...b }), false, JSON.stringify(b));
  // А пустые — нормально: старый формат ответа.
  assert.equal(validHalving({ ...REAL, eta: undefined, tip: null, skew: 0, prev: 1713571767 }), true);
});

test("halvingView: две недели после халвинга карточка говорит, что он состоялся", () => {
  const after = { ...REAL, height: 1050100, next: 1260000, prev: 1838900000, tip: 1838900000 + 100 * 600, eta: undefined };
  assert.equal(halvingView(after, after.prev + 3 * 86400).justHappened, after.prev);
  assert.equal(halvingView(after, after.prev + 15 * 86400).justHappened, null);
  assert.equal(halvingView(REAL, REAL.at).justHappened, null);
});

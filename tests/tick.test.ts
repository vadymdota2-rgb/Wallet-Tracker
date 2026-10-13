/* Общие часы отсчётов (lib/tick.ts). */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

test("часы без подписчиков не отдают устаревшее время", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_791_881_000_000 });
  const { nowSnapshot } = await import("../src/lib/tick.ts");
  assert.equal(nowSnapshot(), 1_791_881_000);
  // Меню закрыто час: таймер стоит, подписчиков нет. Открыли — первый кадр
  // должен считаться от «сейчас», а не от времени последнего тика.
  mock.timers.tick(3600_000);
  assert.equal(nowSnapshot(), 1_791_881_000 + 3600);
  mock.timers.reset();
});

test("один таймер на всех: тикает, пока есть подписчики, и встаёт без них", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_800_000_000_000 });
  const { nowSnapshot, subscribe } = await import("../src/lib/tick.ts");
  let a = 0;
  let b = 0;
  const offA = subscribe(() => a++);
  const offB = subscribe(() => b++);
  mock.timers.tick(3000);
  assert.deepEqual([a, b], [3, 3], "оба подписчика — от одного таймера");
  assert.equal(nowSnapshot(), 1_800_000_003);
  offA();
  mock.timers.tick(2000);
  assert.deepEqual([a, b], [3, 5], "отписанный больше не будится");
  offB();
  mock.timers.tick(5000);
  assert.equal(b, 5, "без подписчиков таймер остановлен");
  // А снимок всё равно свежий — от «сейчас», не от последнего тика.
  assert.equal(nowSnapshot(), 1_800_000_010);
  // Часы телефона перевели на час назад, пока меню закрыто.
  mock.timers.setTime(1_800_000_010_000 - 3600_000);
  assert.equal(nowSnapshot(), 1_800_000_010 - 3600);
  mock.timers.reset();
});

test("useNow отдаёт секунды (отрисовка на сервере React)", async () => {
  const { useNow } = await import("../src/lib/tick.ts");
  let got = 0;
  renderToString(createElement(() => { got = useNow(); return null; }));
  assert.ok(Math.abs(got - Date.now() / 1000) < 2);
});

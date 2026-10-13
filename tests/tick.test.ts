/* Общие часы отсчётов (lib/tick.ts). */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

/** Промотать время шагами по 50 мс: тестовые часы Node за один большой
 *  прыжок запускают переставляющий себя таймер лишь однажды — не как браузер. */
function advance(ms: number): void {
  for (let left = ms; left > 0; left -= 50) mock.timers.tick(Math.min(50, left));
}

test("часы без подписчиков не отдают устаревшее время", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_791_881_000_000 });
  const { nowSnapshot } = await import("../src/lib/tick.ts");
  assert.equal(nowSnapshot(), 1_791_881_000);
  // Меню закрыто час: таймер стоит, подписчиков нет. Открыли — первый кадр
  // должен считаться от «сейчас», а не от времени последнего тика.
  advance(3600_000);
  assert.equal(nowSnapshot(), 1_791_881_000 + 3600);
  mock.timers.reset();
});

test("один таймер на всех: тикает, пока есть подписчики, и встаёт без них", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  const { nowSnapshot, subscribe } = await import("../src/lib/tick.ts");
  let a = 0;
  let b = 0;
  const offA = subscribe(() => a++);
  const offB = subscribe(() => b++);
  advance(3010);
  assert.deepEqual([a, b], [3, 3], "оба подписчика — от одного таймера");
  assert.equal(nowSnapshot(), 1_800_000_003);
  offA();
  advance(2000);
  assert.deepEqual([a, b], [3, 5], "отписанный больше не будится");
  offB();
  advance(5000);
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

test("тик — на границе секунды: ни одна секунда не пропадает и не повторяется", async () => {
  // Старт в середине секунды (…,537): первый тик — сразу после границы.
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_100_537 });
  const { nowSnapshot, subscribe } = await import("../src/lib/tick.ts");
  const seen: number[] = [];
  const off = subscribe(() => seen.push(nowSnapshot()));
  advance(470);
  assert.deepEqual(seen, [1_800_000_101], "первый тик — на 101-й секунде, через 468 мс");
  // Сто секунд: каждое значение на 1 больше предыдущего.
  advance(100_000);
  assert.equal(seen.length, 101);
  assert.ok(seen.every((v, i) => i === 0 || v === seen[i - 1]! + 1), "секунды идут подряд");
  off();
  mock.timers.reset();
});

test("отписка последнего прямо в тике — таймер не продолжает тикать", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_200_000 });
  const { subscribe } = await import("../src/lib/tick.ts");
  // Считаем, сколько раз модуль ставит таймер: пустой таймер без подписчиков
  // будил бы телефон каждую секунду впустую.
  const spy = mock.method(globalThis, "setTimeout");
  let n = 0;
  const off: () => void = subscribe(() => { n++; off(); });
  advance(5000);
  assert.equal(n, 1);
  assert.equal(spy.mock.callCount(), 1, "только первый таймер — после отписки новых нет");
  spy.mock.restore();
  mock.timers.reset();
});

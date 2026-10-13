/* Общие часы отсчётов (lib/tick.ts). */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

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

/* Самоочистка хранилища на устройстве (src/lib/storage.ts): npm test (node --test). */
import { test } from "node:test";
import assert from "node:assert/strict";

/** localStorage браузера — словарём в памяти. */
class Mem {
  m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

const mem = new Mem();
(globalThis as { localStorage?: unknown }).localStorage = mem;
const { sweepStorage } = await import("../src/lib/storage.ts");

const DAY = 86_400_000;
const copy = (agoMs: number) => JSON.stringify({ all: { at: Date.now() - agoMs, v: { ok: true } } });

test("доминация живёт на устройстве трое суток, а не общие 30 дней; остальные запасы — 30 дней", () => {
  mem.m.clear();
  mem.setItem("wt-mcap-v1", copy(4 * DAY));
  mem.setItem("wt-dom-v2", copy(4 * DAY));
  mem.setItem("wt-etf-v1", copy(29 * DAY));
  mem.setItem("wt-fng-v2", copy(31 * DAY));
  sweepStorage();
  assert.equal(mem.getItem("wt-mcap-v1"), null, "доминации 4 дня — стёрта");
  assert.notEqual(mem.getItem("wt-dom-v2"), null, "альтсезону 4 дня — остаётся");
  assert.notEqual(mem.getItem("wt-etf-v1"), null, "29 дней — остаётся");
  assert.equal(mem.getItem("wt-fng-v2"), null, "31 день — стёрт");
});

test("рынки в меню живут на устройстве шесть часов (MARKETS_AGE_MAX), не 30 дней", () => {
  mem.m.clear();
  mem.setItem("wt-markets-v1", copy(7 * 3_600_000));
  sweepStorage();
  assert.equal(mem.getItem("wt-markets-v1"), null, "7 часов — стёрта");
  mem.setItem("wt-markets-v1", copy(5 * 3_600_000));
  sweepStorage();
  assert.notEqual(mem.getItem("wt-markets-v1"), null, "5 часов — остаётся");
});

test("доминация моложе трёх суток остаётся", () => {
  mem.m.clear();
  mem.setItem("wt-mcap-v1", copy(2 * DAY));
  sweepStorage();
  assert.notEqual(mem.getItem("wt-mcap-v1"), null);
});

test("чужие для приложения «wt-…» ключи стираются, ключи Telegram не трогаются", () => {
  mem.m.clear();
  mem.setItem("wt-dom-v1", "{}");
  mem.setItem("tg-web-app", "x");
  sweepStorage();
  assert.equal(mem.getItem("wt-dom-v1"), null);
  assert.equal(mem.getItem("tg-web-app"), "x");
});

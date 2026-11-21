/* Автоторговля — проверка ответа до показа: npm test (node --test). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkAutotrade, shortInst, validAutotrade } from "../src/lib/autotrade.ts";

const SUMMARY = JSON.parse(readFileSync(new URL("./fixtures/autotrade_summary.json", import.meta.url), "utf8")) as Record<string, unknown>;
const LIVE = JSON.parse(readFileSync(new URL("./fixtures/autotrade_live.json", import.meta.url), "utf8")) as Record<string, unknown>;
const GOOD = { ok: true, stage: "live", on: true, backtest: SUMMARY, running: false, started: 1, finished: 2, error: "",
  next: 3, paper: null, live: LIVE };

test("образцы — годный ответ", () => {
  assert.ok(validAutotrade(GOOD));
  assert.ok(validAutotrade({ ...GOOD, backtest: null, live: null, stage: "backtest" }));
});

test("любое рисуемое поле не того типа — отказ", () => {
  const stats = LIVE["stats"] as Record<string, unknown>;
  const open = LIVE["open"] as Record<string, unknown>;
  for (const bad of [
    { ...GOOD, ok: "true" }, { ...GOOD, stage: "x" }, { ...GOOD, on: 1 }, { ...GOOD, started: Number.NaN },
    { ...GOOD, error: null }, { ...GOOD, live: { ...LIVE, stats: { ...stats, net: "1" } } },
    { ...GOOD, live: { ...LIVE, stats: { ...stats, win_pct: Number.POSITIVE_INFINITY } } },
    { ...GOOD, live: { ...LIVE, open: { ...open, side: 2 } } }, { ...GOOD, live: { ...LIVE, open: { ...open, tp: "1" } } },
    { ...GOOD, live: { ...LIVE, positions: [{ instId: 1, pos: "1" }] } }, { ...GOOD, live: { ...LIVE, events: [1] } },
    { ...GOOD, live: { ...LIVE, equity_curve: [[1]] } }, { ...GOOD, live: { ...LIVE, trades: [{}] } },
    { ...GOOD, backtest: { ...SUMMARY, equity: [[1, "x"]] } }, { ...GOOD, backtest: { ...SUMMARY, verdict: "no" } },
    { ...GOOD, backtest: { ...SUMMARY, full: { ...(SUMMARY["full"] as Record<string, unknown>), pf: "1" } } },
    { ...GOOD, live: { ...LIVE, stats: { ...stats, pf: "0.8" } } },
    null, [], "ok", 1,
  ]) {
    assert.equal(validAutotrade(bad), false, JSON.stringify(bad).slice(0, 120));
  }
});

test("кнопки: отказ с причиной — как есть; испорчен только бэктест — без него; остальное — null", () => {
  const no = { ok: false, error: "no_write" };
  assert.equal(checkAutotrade(no), no);
  assert.equal(checkAutotrade(null), null);
  assert.equal(checkAutotrade({ ok: false } as { ok: boolean }), null);
  const brokenBt = checkAutotrade({ ...GOOD, backtest: { ...SUMMARY, top: "x" } });
  assert.ok(brokenBt && brokenBt.backtest === null && brokenBt.live !== null);
  assert.equal(checkAutotrade({ ...GOOD, live: { ...LIVE, alive: "yes" } }), null);
  assert.equal(checkAutotrade(GOOD), GOOD);
});

test("короткое имя контракта", () => {
  for (const [inst, want] of [["BTC-USDT-SWAP", "BTC"], ["BTC-USD_UM_XPERP-310404", "BTC"],
    ["H-USD_UM_XPERP-310815", "H"], ["XAU-USDT-SWAP", "XAU"], ["ETH-USDC-SWAP", "ETH-USDC-SWAP"]] as const) {
    assert.equal(shortInst(inst), want);
  }
});

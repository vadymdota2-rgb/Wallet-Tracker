/* Автоторговля — проверка ответа до показа: npm test (node --test). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkAutotrade, shortInst, skipsLine, validAutotrade } from "../src/lib/autotrade.ts";

const SUMMARY = JSON.parse(readFileSync(new URL("./fixtures/autotrade_summary.json", import.meta.url), "utf8")) as Record<string, unknown>;
const LIVE = JSON.parse(readFileSync(new URL("./fixtures/autotrade_live.json", import.meta.url), "utf8")) as Record<string, unknown>;
const GOOD = { ok: true, on: true, backtest: SUMMARY, running: false, started: 1, error: "",
  next: 3, live: LIVE };


test("образцы — годный ответ", () => {
  assert.ok(validAutotrade(GOOD));
  assert.ok(validAutotrade({ ...GOOD, backtest: { ...SUMMARY, halves: undefined, full: { ...(SUMMARY["full"] as Record<string, unknown>), fees: undefined } } }),
    "итог прежней версии (без комиссий и половин) — годен");
  assert.ok(validAutotrade({ ...GOOD, backtest: { ...SUMMARY, variants: [1], edge: "x" } }), "прежние поля вариантов не рисуются — не мешают");
  assert.ok(validAutotrade({ ...GOOD, live: { ...LIVE, opens: undefined } }), "служба прежней версии (одна open) — годна");
  assert.ok(validAutotrade({ ...GOOD, backtest: null, live: null }));
  assert.ok(validAutotrade({ ...GOOD, running: true, progress: "повтор: 40 %" }));
});

test("любое рисуемое поле не того типа — отказ", () => {
  const stats = LIVE["stats"] as Record<string, unknown>;
  const open = LIVE["open"] as Record<string, unknown>;
  for (const bad of [
    { ...GOOD, ok: "true" }, { ...GOOD, on: 1 }, { ...GOOD, started: Number.NaN },
    { ...GOOD, error: null }, { ...GOOD, live: { ...LIVE, stats: { ...stats, net: "1" } } },
    { ...GOOD, live: { ...LIVE, stats: { ...stats, win_pct: Number.POSITIVE_INFINITY } } },
    { ...GOOD, live: { ...LIVE, open: { ...open, side: 2 } } }, { ...GOOD, live: { ...LIVE, open: { ...open, tp: "1" } } },
    { ...GOOD, live: { ...LIVE, positions: [{ instId: 1 }] } }, { ...GOOD, live: { ...LIVE, blocked: { "BTC-USDT-SWAP": {} } } }, { ...GOOD, live: { ...LIVE, events: [1] } },
    { ...GOOD, live: { ...LIVE, equity_curve: [[1]] } }, { ...GOOD, live: { ...LIVE, trades: [{}] } },
    { ...GOOD, backtest: { ...SUMMARY, equity: [[1, "x"]] } }, { ...GOOD, backtest: { ...SUMMARY, verdict: "no" } },
    { ...GOOD, backtest: { ...SUMMARY, full: { ...(SUMMARY["full"] as Record<string, unknown>), pf: "1" } } },
    { ...GOOD, live: { ...LIVE, stats: { ...stats, pf: "0.8" } } },
    { ...GOOD, live: { ...LIVE, key_problem: 50124 } }, { ...GOOD, live: { ...LIVE, skips_24h: { market: "7" } } },
    { ...GOOD, live: { ...LIVE, skips_24h: [7] } }, { ...GOOD, live: { ...LIVE, open: { ...open, exit_why: 1 } } },
    { ...GOOD, live: { ...LIVE, open: { ...open, usd_against: "9000" } } },
    { ...GOOD, live: { ...LIVE, opens: {} } }, { ...GOOD, live: { ...LIVE, opens: [{ ...open, tp: "1" }] } },
    { ...GOOD, live: { ...LIVE, opens: [{ ...open, fade: "да" }] } },
    { ...GOOD, live: { ...LIVE, opens: [{ ...open, big: 1 }] } },
    { ...GOOD, live: { ...LIVE, pending: { inst: "SOL", side: 1, px: "1", until: 1 } } },
    { ...GOOD, live: { ...LIVE, pending: { inst: "SOL", side: 3, px: 1, until: 1 } } },
    { ...GOOD, backtest: { ...SUMMARY, full: { ...(SUMMARY["full"] as Record<string, unknown>), fees: "1" } } },
    { ...GOOD, backtest: { ...SUMMARY, halves: [1] } }, { ...GOOD, backtest: { ...SUMMARY, halves: [1, "2"] } },
    { ...GOOD, backtest: { ...SUMMARY, halves: { 0: 1, 1: 2 } } },
    { ...GOOD, progress: 40 },
    { ...GOOD, backtest: { ...SUMMARY, skips: { own_open: "1" } } },
    { ...GOOD, backtest: { ...SUMMARY, last: null } }, { ...GOOD, backtest: { ...SUMMARY, active: [{}] } },
    { ...GOOD, backtest: { ...SUMMARY, trades: [{ ...(SUMMARY["trades"] as Record<string, unknown>[])[0], why: 1 }] } },
    // Итог прежней сетки (мог остаться на сервере) — не по договору.
    { ...GOOD, backtest: { ...SUMMARY, last: undefined, top: [] } },
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
  const brokenBt = checkAutotrade({ ...GOOD, backtest: { ...SUMMARY, first: "x" } });
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

test("пропуски за сутки — по убыванию, по-русски; неизвестный код — как есть", () => {
  assert.equal(skipsLine({ chase: 2, market: 7, new_code: 1 }),
    "ключу OKX закрыт рынок — 7 · цена не на 1 % лучше китов — 2 · new_code — 1");
  assert.equal(skipsLine({}), "");
  assert.equal(skipsLine({ bigger_against: 4 }), "против — киты крупнее — 4");
});

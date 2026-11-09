/* Расчёты экрана кошелька Hyperliquid (src/lib/walletDash.ts): npm test. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BIAS_EDGE, PTS_MAX, acctLev, exposure, geom, lean, nearest, portfolio, share, validAccount, validCurve, validFlow, validPerf, validWindow,
} from "../src/lib/walletDash.ts";
import type { Position, SpotHold } from "../src/lib/types.ts";

const P = (o: Partial<Position>): Position => ({
  sym: "BTC", long: true, lev: 10, size: 0, entry: 1, now: 1, margin: 0, liq: 0, pnl: 0, pct: 0, funding: 0, isolated: false, ...o,
});
const WIN = { pnl: 10, trades: 3, wins: 2, win: 66.7, pf: 2, avg_w: 8, avg_l: -3, best: 9, worst: -3, dd: 3, pts: [[1, 0], [2, 10]] };

test("доля — 0…1; делить не на что — 0", () => {
  assert.equal(share(5, 10), 0.5);
  assert.equal(share(20, 10), 1);
  assert.equal(share(-1, 10), 0);
  assert.equal(share(1, 0), 0);
  assert.equal(share(Number.NaN, 10), 0);
});

test("направление: объём лонгов и шортов, перевес от 60 %, PnL, ROE к марже, фандинг", () => {
  const e = exposure([P({ long: false, size: 900, pnl: 50, margin: 100, funding: 7 }), P({ size: 100, pnl: -10, margin: 100, funding: -2 })]);
  assert.deepEqual([e.long, e.short, e.total], [100, 900, 1000]);
  assert.equal(e.bias, "short");
  assert.equal(e.upnl, 40);
  assert.equal(e.roe, 20);
  assert.equal(e.funding, 5);
  assert.equal(exposure([P({ size: 60 }), P({ long: false, size: 40 })]).bias, "long"); // ровно 60 % — уже перевес
  assert.equal(exposure([P({ size: 59 }), P({ long: false, size: 41 })]).bias, "flat");
  assert.equal(exposure([P({ size: 40 }), P({ long: false, size: 60 })]).bias, "short");
  assert.equal(BIAS_EDGE, 0.6);
  const none = exposure([]);
  assert.deepEqual([none.bias, none.roe, none.total], ["flat", null, 0]);
  // Битые числа не ломают сумму.
  assert.equal(exposure([P({ size: Number.NaN, pnl: Number.POSITIVE_INFINITY, margin: -5 })]).roe, null);
});

test("плечо счёта — объём к капиталу; капитала нет — null", () => {
  assert.equal(acctLev({ equity: 100, ntl: 469, margin: 0, free: 0, maint: 0 }), 4.69);
  assert.equal(acctLev({ equity: 0, ntl: 469, margin: 0, free: 0, maint: 0 }), null);
});

test("счёт с сервера: только конечные неотрицательные числа", () => {
  const a = { equity: 1, margin: 0, free: 1, ntl: 0, maint: 0 };
  assert.deepEqual(validAccount(a), a);
  assert.equal(validAccount({ ...a, free: -1 }), null);
  assert.equal(validAccount({ ...a, ntl: Number.NaN }), null);
  assert.equal(validAccount({ ...a, equity: "1" }), null);
  assert.equal(validAccount(null), null);
  assert.deepEqual(Object.keys(validAccount({ ...a, evil: "<b>" })!), ["equity", "margin", "free", "ntl", "maint"]);
});

test("результат с сервера: окна с годными числами и точками по времени", () => {
  assert.ok(validWindow(WIN));
  assert.ok(validWindow({ ...WIN, pf: null })); // проигрышей нет — без профит-фактора
  for (const bad of [{ ...WIN, pnl: Number.NaN }, { ...WIN, pf: "2" }, { ...WIN, trades: 0 }, { ...WIN, pts: [[1, 0]] },
    { ...WIN, pts: [[2, 0], [1, 1]] }, { ...WIN, pts: [[1, 0], [2, "x"]] }, { ...WIN, pts: [[1, 0, 3], [2, 1]] },
    { ...WIN, pts: Array.from({ length: PTS_MAX + 1 }, (_, i) => [i, 0]) }, null, "x"]) {
    assert.equal(validWindow(bad), null, JSON.stringify(bad)?.slice(0, 80));
  }
  assert.deepEqual(Object.keys(validPerf({ "7": WIN, "30": { ...WIN, dd: Infinity }, "90": WIN })), ["7"]);
  assert.deepEqual(validPerf(null), {});
});

test("кривая: ноль всегда в кадре, концы — края поля, ближайшая точка по касанию", () => {
  const g = geom([[0, 100], [5, 200], [10, 300]], 300, 120, 6);
  assert.deepEqual(g.xs, [0, 150, 300]);
  assert.equal(g.zero, 114); // всё выше нуля — ноль у нижнего края
  assert.equal(g.ys[2], 6);
  assert.ok(g.line.startsWith("M0,") && g.area.endsWith("Z"));
  const neg = geom([[0, 0], [1, -50], [2, 50]], 300, 120, 6);
  assert.equal(neg.zero, 60);
  const flat = geom([[0, 0], [1, 0]], 300, 120);
  assert.ok(Number.isFinite(flat.zero) && flat.ys.every(Number.isFinite));
  assert.equal(nearest([0, 150, 300], 300, 0.55), 1);
  assert.equal(nearest([0, 150, 300], 300, 2), 2);
  assert.equal(nearest([], 300, 0.5), -1);
});

test("перевес двух сторон: накопление от 60 % покупок, распределение до 40 %, пусто — нейтрально", () => {
  assert.equal(lean(180, 60), "a");
  assert.equal(lean(60, 40), "a");
  assert.equal(lean(59, 41), "flat");
  assert.equal(lean(40, 60), "b");
  assert.equal(lean(0, 0), "flat");
  assert.equal(lean(Number.NaN, 5), "b");
});

test("поток BSC и кривая биткоина с сервера: только годные", () => {
  const f = { buy: 1, sell: 2, nb: 1, ns: 1, days: 30 };
  assert.deepEqual(validFlow(f), f);
  assert.equal(validFlow({ ...f, nb: 0, ns: 0 }), null);
  assert.equal(validFlow({ ...f, buy: -1 }), null);
  assert.equal(validFlow(null), null);
  assert.ok(validCurve([[1, -5], [2, 5]]));
  assert.equal(validCurve([[1, 0]]), null);
  assert.equal(validCurve([[2, 0], [1, 0]]), null);
  assert.equal(validCurve([[1, 0], [2, Number.POSITIVE_INFINITY]]), null);
  assert.equal(validCurve(Array.from({ length: PTS_MAX + 1 }, (_, i) => [i, 0])), null);
});

test("портфель BSC: стоимость, вложено, PnL, доля в плюсе и крупнейшая монета", () => {
  const H = (sym: string, cost: number, value: number): SpotHold => ({
    token: sym, sym, cost, value, pnl: value - cost, pct: 0, entry: 1, price: 1, buys: 1, since: 0 });
  const p = portfolio([H("CAKE", 40000, 52000), H("PEPE", 20000, 15000), H("BNB", 8000, 9000)]);
  assert.deepEqual([p.n, p.value, p.cost, p.pnl, p.goodN, p.topSym], [3, 76000, 68000, 8000, 2, "CAKE"]);
  assert.ok(Math.abs(p.inProfit - 61000 / 76000) < 1e-12);
  assert.ok(Math.abs(p.top - 52000 / 76000) < 1e-12);
  assert.ok(Math.abs(p.pct! - (8000 / 68000) * 100) < 1e-9);
  const none = portfolio([]);
  assert.deepEqual([none.value, none.pct, none.inProfit, none.top], [0, null, 0, 0]);
});

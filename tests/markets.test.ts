/* Рынки в меню: проверка ответа сервера и подписи изменений (node --test). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKET_KEYS, MARKET_PX_MAX, change, digits, isPercent, validMarkets } from "../src/lib/markets.ts";

const NOW = 1_794_100_000;
const good = {
  ok: true,
  at: NOW - 30,
  items: [
    { k: "OIL", px: 90.205, prev: 89.617 },
    { k: "SP500", px: 7373.1, prev: 7392.9 },
    { k: "US10Y", px: 4.875, prev: 4.8777 },
    { k: "DXY", px: 102.115, prev: 101.92 },
  ],
};

test("рынки — в порядке экрана, только известные", () => {
  const r = validMarkets(good, NOW);
  assert.ok(r);
  assert.deepEqual(r.items.map((x) => x.k), ["SP500", "DXY", "US10Y", "OIL"]);
  assert.equal(r.at, NOW - 30);
  assert.equal(MARKET_KEYS.length, 9);
});

test("битые пункты выпадают, повторы — первый", () => {
  const bad = [
    { k: "VIX", px: 20, prev: 20 }, { k: "DVOL", px: 40, prev: 39 }, { k: "NDX", px: 1, prev: 1 }, { k: "SILVER", px: 52, prev: 52 }, { k: "GOLD", px: 0, prev: 1 }, { k: "GOLD", px: -1, prev: 1 },
    { k: "BTCD", px: Number.NaN, prev: 1 }, { k: "OIL", px: 90, prev: Number.POSITIVE_INFINITY },
    { k: "ETHBTC", px: "0.03", prev: 0.03 }, { k: "XYZ100", px: MARKET_PX_MAX, prev: 1 }, { k: "<b>x</b>", px: 1, prev: 1 },
    null, "SP500", [1, 2], { k: "SP500", px: 1, prev: 2 }, { k: "SP500", px: 3, prev: 4 },
  ];
  const r = validMarkets({ ok: true, at: NOW, items: bad }, NOW);
  assert.ok(r);
  assert.deepEqual(r.items, [{ k: "SP500", px: 1, prev: 2 }]);
  // Только поля k, px, prev — лишнее не тащится.
  const extra = validMarkets({ ok: true, at: NOW, items: [{ k: "GOLD", px: 1, prev: 1, evil: "<img>" }] }, NOW);
  assert.deepEqual(extra?.items[0], { k: "GOLD", px: 1, prev: 1 });
});

test("старая сборка (за шесть часов) — не ответ, свежая — ответ", () => {
  assert.ok(validMarkets({ ok: true, at: NOW - 6 * 3_600, items: good.items }, NOW));
});

test("не ответ — null, и меню показывает прежний заголовок", () => {
  for (const raw of [null, "x", [], { ok: false, error: "no_data" }, { ok: true }, { ok: true, at: NOW, items: "x" },
    { ok: true, at: NOW, items: [] }, { ok: true, at: NOW + 2 * 86_400, items: good.items },
    { ok: true, at: 1.5, items: good.items }, { ok: true, at: -1, items: good.items }, { ok: "true", at: NOW, items: good.items },
    { ok: true, at: NOW - 6 * 3_600 - 1, items: good.items }]) {
    assert.equal(validMarkets(raw, NOW), null, JSON.stringify(raw));
  }
});

test("изменение: проценты, у доходности — базисные пункты", () => {
  const sp = change({ k: "SP500", px: 7373.1, prev: 7392.9 });
  assert.equal(sp.unit, "pct");
  assert.ok(Math.abs(sp.v - (7373.1 / 7392.9 - 1) * 100) < 1e-9);
  const y = change({ k: "US10Y", px: 4.875, prev: 4.8777 });
  assert.equal(y.unit, "bp");
  assert.ok(Math.abs(y.v - -0.27) < 1e-9);
});

test("знаки после запятой — по масштабу", () => {
  assert.equal(digits({ k: "SP500", px: 7373.1, prev: 1 }), 0);
  assert.equal(digits({ k: "DXY", px: 102.1, prev: 1 }), 2);
  assert.equal(digits({ k: "OIL", px: 90.2, prev: 1 }), 2);
  assert.equal(digits({ k: "OIL", px: 9.5, prev: 1 }), 3);
  assert.equal(digits({ k: "XYZ100", px: 26925, prev: 1 }), 0);
  assert.equal(digits({ k: "US10Y", px: 4.875, prev: 1 }), 2);
  assert.equal(digits({ k: "BTCD", px: 60.44, prev: 1 }), 2);
  assert.equal(digits({ k: "ETHBTC", px: 0.03296, prev: 1 }), 5);
  assert.deepEqual(MARKET_KEYS.filter(isPercent), ["US10Y", "BTCD", "USDTD"]);
});

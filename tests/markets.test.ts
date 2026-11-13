/* Рынки в меню: проверка ответа сервера и подписи изменений (node --test). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BAR_MIN, CANDLE_HEADROOM, CANDLES_SHOW, MARKET_KEYS, MARKET_PX_MAX, MARKETS_REFRESH, MARKETS_STALE_MIN, ageMin, barShare,
  candleChart, candleSeries, change, digits, isPercent, marketsDue, validCandles, validMarkets, type Candle,
} from "../src/lib/markets.ts";

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
  assert.deepEqual(r.items.map((x) => x.k), ["SP500", "DXY", "OIL", "US10Y"]);
  assert.equal(r.at, NOW - 30);
  assert.equal(MARKET_KEYS.length, 9);
});

test("битые пункты выпадают, повторы — первый", () => {
  const bad = [
    { k: "VIX", px: 20, prev: 20 }, { k: "DVOL", px: 40, prev: 39 }, { k: "NDX", px: 1, prev: 1 }, { k: "SILVER", px: 52, prev: 52 }, { k: "GOLD", px: 0, prev: 1 }, { k: "GOLD", px: -1, prev: 1 },
    { k: "GOLD", px: Number.NaN, prev: 1 }, { k: "OIL", px: 40, prev: Number.POSITIVE_INFINITY },
    { k: "ETHBTC", px: 0.03, prev: 0.03 }, { k: "BTCD", px: Number.NaN, prev: 60 }, { k: "OIL", px: "90", prev: 90 }, { k: "XYZ100", px: MARKET_PX_MAX, prev: 1 }, { k: "<b>x</b>", px: 1, prev: 1 },
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
  assert.equal(digits({ k: "GOLD", px: 4066.2, prev: 1 }), 0);
  assert.equal(digits({ k: "GOLD", px: 1000, prev: 1 }), 0);
  assert.equal(digits({ k: "GOLD", px: 999.9, prev: 1 }), 2);
  assert.equal(digits({ k: "BVIV", px: 42.4, prev: 1 }), 2);
  assert.equal(digits({ k: "BTCD", px: 60.44, prev: 1 }), 2);
  assert.equal(digits({ k: "USDTD", px: 4.1, prev: 1 }), 2);
  assert.deepEqual(MARKET_KEYS.filter(isPercent), ["US10Y", "BTCD", "USDTD"]);
});

test("полоска: 2 % (10 б. п. у доходности) — полная, ноль — без полоски, мелочь — видна", () => {
  assert.ok(barShare({ k: "SP500", px: 102, prev: 100 }) > 0.999999);
  assert.equal(barShare({ k: "SP500", px: 110, prev: 100 }), 1);
  assert.ok(Math.abs(barShare({ k: "SP500", px: 101, prev: 100 }) - 0.5) < 1e-9);
  assert.equal(barShare({ k: "SP500", px: 100, prev: 100 }), 0);
  assert.equal(barShare({ k: "SP500", px: 100.001, prev: 100 }), BAR_MIN);
  assert.ok(Math.abs(barShare({ k: "US10Y", px: 4.85, prev: 4.8 }) - 0.5) < 1e-9); // 5 б. п.
  assert.equal(barShare({ k: "US10Y", px: 4.6, prev: 4.8 }), 1); // 20 б. п. — больше полной
  assert.ok(Math.abs(barShare({ k: "BTCD", px: 60.6, prev: 60 }) - 0.5) < 1e-9); // доля — в процентах изменения
});

test("возраст ответа — целые минуты, часы телефона отстают — не минус; старые — с 15 минут", () => {
  assert.equal(ageMin(1000, 1000), 0);
  assert.equal(ageMin(1000, 1059), 0);
  assert.equal(ageMin(1000, 1060), 1);
  assert.equal(ageMin(1000, 1000 + 20 * 60 + 30), 20);
  assert.equal(ageMin(1000, 500), 0);
  assert.equal(MARKETS_STALE_MIN, 15);
});

test("спрашивать сервер — только когда могли появиться новые цены (как карточка халвинга)", () => {
  assert.equal(MARKETS_REFRESH, 600);
  // Ответа нет — спрашиваем каждую минуту.
  assert.equal(marketsDue(undefined, 1000, 0), true);
  // Цены моложе десяти минут — новых ещё нет, сеть не трогаем.
  assert.equal(marketsDue(1000, 1000 + 599, 60), false);
  assert.equal(marketsDue(1000, 1000, 0), false);
  // Десять минут — пора.
  assert.equal(marketsDue(1000, 1000 + 600, 60), true);
  // Часы телефона отстают на час: цены кажутся «из будущего», но с прошлого
  // вопроса по часам телефона прошло десять минут — спрашиваем.
  assert.equal(marketsDue(1000 + 3600, 1000 + 600, 599), false);
  assert.equal(marketsDue(1000 + 3600, 1000 + 600, 600), true);
});

const D = 86_400;
const DAY0 = NOW - (NOW % D);

test("дневные свечи с сервера: известные пункты, день — начало суток UTC по возрастанию, правдоподобные цены", () => {
  const ok = { ok: true, at: NOW, days: {
    GOLD: [[DAY0 - 2 * D, 4000, 4010, 3990, 4005], [DAY0 - D, 4005, 4020, 4000, 4010], [DAY0 - D, 1, 1, 1, 1],
      [DAY0 - D + 5, 4000, 4000, 4000, 4000], [DAY0, 4010, 4000, 3990, 4005], [DAY0, 4010, 4030, 4020, 4005],
      [DAY0, "4010", 4030, 4000, 4020], [DAY0, -1, 4030, 4000, 4020], [DAY0, 4010, 4030, 4000]],
    VIX: [[DAY0, 20, 21, 19, 20]],
    OIL: [[DAY0 - 41 * D, 80, 81, 79, 80], [DAY0 + 2 * D, 80, 81, 79, 80]], // старая и из будущего — мимо
    BVIV: [[DAY0, 42, 43, 41, 42.5]],
  } };
  const c = validCandles(ok, NOW);
  assert.deepEqual(Object.keys(c), ["GOLD", "BVIV"]);
  assert.deepEqual(c.GOLD, [[DAY0 - 2 * D, 4000, 4010, 3990, 4005], [DAY0 - D, 4005, 4020, 4000, 4010]]);
  for (const bad of [null, "x", { ok: false }, { ok: false, days: ok.days }, { ok: true, days: [] }, { ok: true }]) {
    assert.deepEqual(validCandles(bad, NOW), {});
  }
  const many = { ok: true, days: { GOLD: Array.from({ length: 39 }, (_, i) => [DAY0 - (38 - i) * D, 4000, 4001, 3999, 4000]) } };
  const g = validCandles(many, NOW).GOLD!;
  assert.equal(g.length, CANDLES_SHOW); // хвост — последние
  assert.equal(g[g.length - 1]![0], DAY0);
});

test("свечи ячейки: последняя — с ценой из ответа", () => {
  const it = { k: "GOLD" as const, px: 4066, prev: 4080 };
  const cs: Candle[] = [[DAY0 - D, 4000, 4010, 3990, 4005], [DAY0, 4005, 4020, 4000, 4010]];
  assert.deepEqual(candleSeries(cs, it), [[DAY0 - D, 4000, 4010, 3990, 4005], [DAY0, 4005, 4066, 4000, 4066]]);
  assert.deepEqual(candleSeries(cs, { ...it, px: 3900 })[1], [DAY0, 4005, 4020, 3900, 3900]);
  assert.deepEqual(cs[1], [DAY0, 4005, 4020, 4000, 4010]); // исходные не меняются
  assert.deepEqual(candleSeries(undefined, it), []);
});

test("геометрия свечей: места справа налево, тени — в кадре с запасом, рост и падение, тело не тоньше пункта", () => {
  const cs: Candle[] = [[DAY0 - D, 10, 12, 8, 11], [DAY0, 11, 11.5, 10, 10]];
  const g = candleChart(cs, 240, 64, 3);
  assert.equal(g.bars.length, 2);
  // 30 мест по 8: свечи — в двух последних, тело — 64 % места.
  assert.deepEqual(g.bars.map((b) => b.x), [228, 236]);
  assert.equal(g.bw, 5.12);
  assert.deepEqual(g.bars.map((b) => b.up), [true, false]);
  assert.ok(Math.abs(g.lo - (8 - 4 * CANDLE_HEADROOM)) < 1e-9 && Math.abs(g.hi - (12 + 4 * CANDLE_HEADROOM)) < 1e-9);
  for (const b of g.bars) assert.ok(b.hi <= b.top && b.top < b.bot && b.bot <= b.lo && b.hi > 3 && b.lo < 61);
  assert.equal(g.last, g.bars[1]!.bot); // пунктир — на закрытии последней (у падения — низ тела)
  const flat = candleChart([[DAY0, 5, 5, 5, 5]], 240, 64);
  assert.ok(flat.bars[0]!.bot - flat.bars[0]!.top >= 0.6 && Number.isFinite(flat.last));
  assert.equal(flat.bars[0]!.up, true); // без изменения — как рост (зелёным)
  const full = candleChart(Array.from({ length: 40 }, (_, i): Candle => [DAY0 - (39 - i) * D, 10, 11, 9, 10]), 240, 64);
  assert.equal(full.bars.length, CANDLES_SHOW);
  assert.equal(full.bars[0]!.x, 4);
});

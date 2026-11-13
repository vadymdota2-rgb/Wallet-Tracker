/* Рынки в меню: проверка ответа сервера и подписи изменений (node --test). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BAR_MIN, HIST_MAX, HIST_SEC, MARKET_KEYS, MARKET_PX_MAX, MARKETS_REFRESH, MARKETS_STALE_MIN, ageMin, barShare, change, digits,
  isPercent, marketsDue, SPARK_FULL_SEC, SPARK_HEADROOM, spark, sparkCover, sparkFrom, sparkSeries, validHist, validMarkets,
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

test("история мини-графика с сервера: известные пункты, целое время по возрастанию, правдоподобная цена", () => {
  const ok = { ok: true, at: NOW, series: {
    GOLD: [[NOW - 600, 4000], [NOW - 300, 4001], [NOW - 300, 4002], [NOW - 200, -1], [NOW - 100, "x"], [NOW - 50.5, 4003], [NOW, 4004]],
    VIX: [[NOW - 600, 20], [NOW, 21]],
    BVIV: [[NOW, 42]], // одна точка — не ряд
    OIL: [[NOW - 3 * HIST_SEC, 80], [NOW + 2 * 86_400, 81], [NOW - 10, 82]], // старое и из будущего — мимо
  } };
  const h = validHist(ok, NOW);
  assert.deepEqual(Object.keys(h), ["GOLD"]);
  assert.deepEqual(h.GOLD, [[NOW - 600, 4000], [NOW - 300, 4001], [NOW, 4004]]);
  for (const bad of [null, "x", { ok: false }, { ok: false, series: ok.series }, { ok: true, series: [] }, { ok: true }]) {
    assert.deepEqual(validHist(bad, NOW), {});
  }
  const many = { ok: true, series: { GOLD: Array.from({ length: HIST_MAX + 50 }, (_, i) => [NOW - 1000 + i, 4000 + i]) } };
  assert.equal(validHist(many, NOW).GOLD!.length, HIST_MAX); // хвост — последние
});

test("ряд ячейки: сутки до ответа, последняя точка — нынешняя цена", () => {
  const it = { k: "GOLD" as const, px: 4066, prev: 4080 };
  assert.deepEqual(sparkSeries([[NOW - HIST_SEC - 1, 1], [NOW - 600, 4070], [NOW - 300, 4068]], it, NOW),
    [[NOW - 600, 4070], [NOW - 300, 4068], [NOW, 4066]]);
  // Последняя точка истории — то же время: цена — из ответа.
  assert.deepEqual(sparkSeries([[NOW - 600, 4070], [NOW, 4060]], it, NOW), [[NOW - 600, 4070], [NOW, 4066]]);
  // Точки новее ответа (часы) — мимо; истории нет — одна точка, графика не будет.
  assert.deepEqual(sparkSeries([[NOW + 60, 1]], it, NOW), [[NOW, 4066]]);
  assert.deepEqual(sparkSeries(undefined, it, NOW), [[NOW, 4066]]);
});

test("геометрия мини-графика: цена суточной давности в кадре, запас по высоте, окно времени — до целого часа", () => {
  const g = spark([[0, 10], [5, 12], [10, 11]], 8, 240, 56, 3);
  assert.deepEqual(g.xs, [0, 120, 240]);
  // Размах 8…12 и запас SPARK_HEADROOM сверху и снизу.
  assert.ok(Math.abs(g.lo - (8 - 4 * SPARK_HEADROOM)) < 1e-9 && Math.abs(g.hi - (12 + 4 * SPARK_HEADROOM)) < 1e-9);
  assert.ok(g.base > g.ys[1]! && g.base < 53 && g.ys[1]! > 3); // ни пунктир, ни линия не прилипают к краям
  // Короткая история (сервер только что запущен) — справа, на своём месте во времени.
  const late = spark([[NOW - 1800, 10], [NOW, 11]], 10, 240, 56, 3, NOW - HIST_SEC, NOW);
  assert.deepEqual(late.xs, [235, 240]); // полчаса из суток — последние 5 точек ширины из 240
  // Точка раньше окна — на левом краю, а не за ним.
  assert.equal(spark([[NOW - 2 * HIST_SEC, 10], [NOW, 11]], 10, 240, 56, 3, NOW - HIST_SEC, NOW).xs[0], 0);
  assert.equal(sparkCover([[1, 1], [SPARK_FULL_SEC + 1, 1]]), SPARK_FULL_SEC);
  assert.equal(sparkCover([[1, 1]]), 0);
  // Окно: история до целого часа вверх, от часа до суток.
  assert.equal(sparkFrom([[NOW - 1440, 1], [NOW, 1]], NOW), NOW - 3_600);
  assert.equal(sparkFrom([[NOW, 1]], NOW), NOW - 3_600);
  assert.equal(sparkFrom([[NOW - 3_600, 1], [NOW, 1]], NOW), NOW - 3_600);
  assert.equal(sparkFrom([[NOW - 3_601, 1], [NOW, 1]], NOW), NOW - 7_200);
  assert.equal(sparkFrom([[NOW - HIST_SEC + 600, 1], [NOW, 1]], NOW), NOW - HIST_SEC);
  assert.equal(sparkFrom([[NOW - 3 * HIST_SEC, 1], [NOW, 1]], NOW), NOW - HIST_SEC);
  // 24 минуты в часовом окне — справа, 40 % ширины, а не чёрточка и не вся ширина.
  const short: [number, number][] = [[NOW - 1440, 10], [NOW, 11]];
  assert.deepEqual(spark(short, 10, 240, 56, 3, sparkFrom(short, NOW), NOW).xs, [144, 240]);
  assert.ok(g.line.startsWith("M0,") && g.area.endsWith("Z"));
  const flat = spark([[0, 5], [1, 5]], 5, 240, 56);
  assert.ok(flat.ys.every(Number.isFinite) && Number.isFinite(flat.base));
  const zero = spark([[0, 0.000001], [1, 0.000001]], 0.000001, 240, 56);
  assert.ok(zero.hi > zero.lo);
});

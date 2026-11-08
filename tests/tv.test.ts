/* Рынки в меню — окна TradingView: адрес окна, набор, языки (node --test). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TV_LOCALE, TV_SANDBOX, TV_SYMBOLS, TV_W, TV_WIDGET, tvScale, tvSrc } from "../src/lib/tv.ts";

const hash = (src: string) => JSON.parse(decodeURIComponent(src.split("#")[1]!)) as Record<string, unknown>;

test("адрес окна — виджет Tickers TradingView, один рынок, наша подпись", () => {
  const src = tvSrc("DERIBIT:DVOL", "DVOL", "ru", "app.example", "/");
  assert.ok(src.startsWith(`${TV_WIDGET}/embed-widget/tickers/?locale=ru#`), src);
  const cfg = hash(src);
  assert.deepEqual(cfg["symbols"], [{ proName: "DERIBIT:DVOL", title: "DVOL" }]);
  assert.equal(cfg["colorTheme"], "dark");
  assert.equal(cfg["isTransparent"], true);
  assert.equal(cfg["utm_source"], "app.example");
});

test("TradingView не получает адрес страницы после «#» и «?» (данные входа Telegram)", () => {
  const cfg = hash(tvSrc("TVC:GOLD", "Золото", "ru", "app.example", "/app/"));
  assert.equal(cfg["page-uri"], "app.example/app/");
  const all = decodeURIComponent(tvSrc("TVC:GOLD", "x", "ru", "app.example", "/"));
  assert.ok(!all.includes("tgWebAppData") && !all.includes("hash="), all);
  // Подпись с кавычками и «#» не ломает адрес.
  assert.deepEqual(hash(tvSrc("TVC:GOLD", 'a"#b', "ru", "h", "/"))["symbols"], [{ proName: "TVC:GOLD", title: 'a"#b' }]);
});

test("шесть рынков, только доступные в виджетах; песочница; языки", () => {
  assert.deepEqual(TV_SYMBOLS.map((x) => x.s),
    ["CAPITALCOM:US500", "CAPITALCOM:US100", "CAPITALCOM:DXY", "TVC:GOLD", "FRED:DGS10", "DERIBIT:DVOL"]);
  // Биржевые индексы в виджетах TradingView запрещены — их нет.
  for (const bad of ["SP:SPX", "NASDAQ:NDX", "CBOE:VIX", "TVC:DXY", "TVC:US10Y"]) assert.ok(!TV_SYMBOLS.some((x) => x.s === bad), bad);
  // Имена индексов — как у CFD, без чужих товарных знаков.
  assert.ok(!TV_SYMBOLS.some((x) => /S&P|Nasdaq/i.test(x.t)));
  assert.equal(TV_SANDBOX, "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
  assert.equal(Object.keys(TV_LOCALE).length, 16);
  for (const l of Object.values(TV_LOCALE)) assert.match(l, /^[a-z]{2}(_[A-Z]{2})?$/);
});

test("масштаб окна — по ширине ячейки, не крупнее и не мельче трети", () => {
  assert.equal(tvScale(TV_W), 1);
  assert.equal(tvScale(2 * TV_W), 1);
  assert.ok(Math.abs(tvScale(122) - 122 / TV_W) < 1e-12);
  assert.equal(tvScale(10), 1 / 3);
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(tvScale(bad), 1);
});

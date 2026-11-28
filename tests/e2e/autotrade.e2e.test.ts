/*
 * «Автоторговля» — закрытая вкладка владельца в настоящем браузере.
 *
 * Владельцу (me.owner) — пункт в меню и экран со статистикой бэктеста
 * (образец — tests/fixtures/autotrade_summary.json, синтетика). Остальным —
 * ни пункта, ни запроса к закрытому адресу. Ответ сервера «нет» (404) —
 * экран говорит об этом, а не падает. Узкий экран — ничего не вылезает.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const HTML = fileURLToPath(new URL("../../html/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".woff2": "font/woff2", ".ttf": "font/ttf", ".ico": "image/x-icon",
};
const SUMMARY = JSON.parse(await readFile(new URL("../fixtures/autotrade_summary.json", import.meta.url), "utf8")) as
  Record<string, unknown>;
const T = 1_795_000_000;

let server: Server;
let base = "";
let browser: Browser;

before(async () => {
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]!)).replace(/^(\.\.[/\\])+/, "");
    const file = join(HTML, path.endsWith("/") ? "index.html" : path);
    try {
      const body = await readFile(file.startsWith(HTML) ? file : join(HTML, "index.html"));
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(200, { "Content-Type": TYPES[".html"] }).end(await readFile(join(HTML, "index.html")));
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((ok) => server?.close(ok));
});

interface Opts { owner: boolean; reply?: "ok" | "404"; width?: number; on?: boolean; live?: Record<string, unknown>;
  backtest?: Record<string, unknown>; running?: boolean; progress?: string }

/** Реальная торговля — ответ сервера из образцов файлов службы (договор:
 *  tests/test_autotrade_contract.py сверяет его с wt_autotrade.live). */
const LIVE = JSON.parse(await readFile(new URL("../fixtures/autotrade_live.json", import.meta.url), "utf8")) as
  Record<string, unknown>;

async function open(o: Opts): Promise<{ ctx: BrowserContext; page: Page; errors: string[]; asked: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: o.width ?? 360, height: 1400 }, timezoneId: "UTC" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const asked: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => asked.push(r.url()));
  await page.clock.setFixedTime(T * 1000);
  await ctx.route((url) => !url.href.startsWith(base), (r) => r.abort());
  await ctx.route(`${base}/api/**`, (r) => r.fulfill({ contentType: "application/json", body: '{"ok":false}' }));
  await ctx.route(`${base}/api/bootstrap`, (r) => r.fulfill({ contentType: "application/json",
    body: JSON.stringify({ ok: true, live: true, me: { plan: "premium", ...(o.owner ? { owner: true } : {}) }, wallets: [] }) }));
  let on = o.on ?? true;
  const reply = () => JSON.stringify({
    ok: true, on, backtest: o.backtest ?? SUMMARY, running: o.running ?? false, started: T - 7200,
    error: "", next: T + 40_000, live: o.live ?? null,
    ...(o.progress ? { progress: o.progress } : {}) });
  await ctx.route(`${base}/api/owner/autotrade`, (r) => o.reply === "404"
    ? r.fulfill({ status: 404, contentType: "application/json", body: '{"ok":false,"error":"not_found"}' })
    : r.fulfill({ contentType: "application/json", body: reply() }));
  for (const [path, value] of [["start", true], ["stop", false]] as const) {
    await ctx.route(`${base}/api/owner/autotrade/${path}`, (r) => {
      asked.push(`POST ${path}`);
      on = value;
      return r.fulfill({ contentType: "application/json", body: reply() });
    });
  }
  await page.addInitScript(() => {
    if (window !== window.top || sessionStorage.getItem("e2e")) return;
    sessionStorage.setItem("e2e", "1");
    localStorage.clear();
    localStorage.setItem("wt-miniapp-v7", JSON.stringify({ state: { lang: "ru", langPinned: true }, version: 9 }));
  });
  await page.goto(`${base}/#tgWebAppData=${encodeURIComponent(`user=${encodeURIComponent('{"id":1}')}&hash=x`)}`);
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: "#sp{display:none!important}" });
  await page.locator(".burger").click();
  await page.locator(".drawer-row").first().waitFor();
  return { ctx, page, errors, asked };
}

describe("закрытая вкладка «Автоторговля»", () => {
  test("не владельцу — ни пункта, ни запроса", async () => {
    const { ctx, page, errors, asked } = await open({ owner: false });
    assert.equal(await page.locator(".drawer-row", { hasText: "Автоторговля" }).count(), 0);
    assert.ok(!asked.some((u) => u.includes("/api/owner/")), asked.join("\n"));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("владельцу — пункт меню и статистика бэктеста", async () => {
    const { ctx, page, errors } = await open({ owner: true });
    await page.locator(".drawer-row", { hasText: "Автоторговля" }).click();
    const screen = page.locator(".sheet .screen");
    await screen.getByText(SUMMARY["verdict"] ? "Правила окупаются" : "Правила пока не окупаются").waitFor();
    for (const s of ["Бэктест: общая статистика", "Винрейт", "Макс. просадка", "Худшая серия", "Критерий", "Правила",
      "Сигналы в повторе", "вошли — 2 · у бота уже 3 позиции — 1", "Последняя четверть периода",
      "Первые три четверти", "Капитал на всём периоде", "По бумагам", "Последние сделки модели",
      "Бэктест: откуда плюс и минус", "Тейк", "Открыта на конец данных", "Винрейт для нуля",
      "Пересчитать сейчас", "Бэктест: открытая позиция модели", "ETH · шорт", "Открытые на конец"]) {
      assert.ok(await screen.getByText(s).first().isVisible(), s);
    }
    assert.ok(await screen.locator(".trend-svg").isVisible());
    const wr = await screen.getByText("Винрейт").first().locator("xpath=ancestor::*[@class='row'][1]").innerText();
    assert.match(wr, /50[.,]0/, wr);
    // Откуда минус: открытая — весь минус; винрейт для нуля 0.06 / (1.11 + 0.06) = 5.1 %.
    const lossRow = await screen.getByText("Открыта на конец данных").locator("xpath=ancestor::*[@class='row'][1]").innerText();
    assert.match(lossRow, /100\s*% всех минусов/, lossRow);
    assert.match(lossRow, /1 сделка/, lossRow);
    const need = await screen.getByText("Винрейт для нуля").locator("xpath=ancestor::*[@class='row'][1]").innerText();
    assert.match(need, /5[.,]1/, need);
    // Один расчёт — по текущим правилам: вариантов и разбора сигналов нет.
    for (const s of ["Бэктест: варианты правил", "Бэктест: куда идёт цена после сигнала"]) {
      assert.equal(await screen.getByText(s).count(), 0, s);
    }
    // До комиссий: 1,05 + 0,5 = +1,55; половины периода +0,6 / +0,45 — плюс в обеих.
    const gross = await screen.getByText("До комиссий").locator("xpath=ancestor::*[@class='row'][1]").innerText();
    assert.match(gross, /\+\$1[.,]55/, gross);
    assert.match(gross, /комиссии \$0[.,]50?/, gross);
    const half = await screen.getByText("Половины периода").locator("xpath=ancestor::*[@class='row'][1]").innerText();
    assert.match(half, /\+\$0[.,]60? \/ \+\$0[.,]45/, half);
    assert.match(half, /плюс в обеих — похоже, не случайность/, half);
    // Открытая позиция модели: вход, цена сейчас, тейк и сколько до него.
    const act = await screen.getByText("ETH · шорт").first().locator("xpath=ancestor::*[@class='row'][1]").innerText();
    for (const s of [/по 2\s998,5/, /сейчас 3\s000/, /тейк 2\s968,51/, /ещё 1\.05%/, /держим 235 ч/]) assert.match(act, s);
    assert.ok(await screen.getByText(/капитал \$124[.,]8\d? → \$125[.,]9/).first().isVisible(), "капитал на начало и конец");
    // Прежней сетки во вкладке нет.
    for (const s of ["Лучший набор", "По пределу догона", "Против китов", "Торгуем на"]) {
      assert.equal(await screen.getByText(s).count(), 0, s);
    }
    // Ничего не вылезает за правый край узкого экрана.
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(wide <= 0, `шире экрана на ${wide}px`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("«Старт» и «Стоп» переключают модуль", async () => {
    const { ctx, page, errors, asked } = await open({ owner: true, on: false });
    await page.locator(".drawer-row", { hasText: "Автоторговля" }).click();
    const screen = page.locator(".sheet .screen");
    await screen.getByText("Остановлен", { exact: true }).waitFor();
    const start = screen.getByRole("button", { name: "Старт", exact: true });
    const stop = screen.getByRole("button", { name: "Стоп", exact: true });
    assert.ok(await stop.isDisabled());
    assert.ok(await screen.getByRole("button", { name: "Пересчитать сейчас" }).isDisabled());
    await start.click();
    await screen.getByText("Включён", { exact: true }).waitFor();
    assert.ok(await start.isDisabled());
    await stop.click();
    await screen.getByText("Остановлен", { exact: true }).waitFor();
    assert.deepEqual(asked.filter((u) => u.startsWith("POST")), ["POST start", "POST stop"]);
    // Кнопки рядом и целиком на узком экране.
    const [a, b] = [await start.boundingBox(), await stop.boundingBox()];
    assert.ok(a && b && Math.abs(a.y - b.y) < 1 && a.x + a.width <= b.x && b.x + b.width <= 360, JSON.stringify([a, b]));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("реальная торговля: бот, позиция, чужая позиция, статистика, сделки", async () => {
    const { ctx, page, errors } = await open({ owner: true, live: LIVE });
    await page.locator(".drawer-row", { hasText: "Автоторговля" }).click();
    const screen = page.locator(".sheet .screen");
    await screen.getByRole("heading", { name: "Реальная торговля на OKX" }).waitFor();
    for (const s of ["торгует", "Капитал счёта", "Позиции бота: 2 из 3", "ETH · шорт", "H · не бота",
      "OKX не даёт торговать", "STX — исключены на 7 дней",
      "Последний пропуск", "у бота уже есть своя позиция", "маржа 5%", "маржа на сделку всегда 5 % × 10× — позиция",
      "бот на эту бумагу не входит; размер его входа это не меняет (5 %)", "Статистика реальной торговли", "Винрейт", "Макс. просадка",
      "Сделки бота", "BTC · лонг", "Журнал бота", "Пропуски сигналов за сутки",
      "у бота уже 3 позиции — 4 · цена ушла от китов — 3 · бумаги нет на OKX — 3"]) {
      assert.ok(await screen.getByText(s).first().isVisible(), s);
    }
    assert.equal(await screen.getByText("OKX не принимает ордера бота").count(), 0, "ключ в порядке — плашки нет");
    assert.ok(await screen.getByText(/тейк \+1,5 %, стоп — 1,5 % от входа \(лонг — ниже, шорт — выше\); усреднения нет/).isVisible());
    assert.equal(await screen.getByText("Закрываем по рынку").count(), 0);
    assert.ok(await screen.getByText(/тейк \+1,5 % — или по рынку: стоп 3\s?060 или кто-то из китов/).isVisible(), "стоп — в строке выхода");
    assert.ok(await screen.getByText(/приоритетный кит 0xabcdef12…/).isVisible(), "вошли с приоритетным китом — видно");
    assert.ok(await screen.getByText(/китов 3 \(\$42K, против \$9K\)/).first().isVisible(), "объёмы за и против");
    assert.ok(await screen.getByText(/тейк 2\s?970/).first().isVisible(), "тейк 2 970");
    // Вторая позиция бота — своя строка, свой тейк и стоп; не «ручная».
    assert.ok(await screen.getByText(/тейк 95\s?950/).first().isVisible(), "тейк второй позиции");
    assert.ok(await screen.getByText(/тейк \+1,5 % — или по рынку: стоп 93\s?575/).isVisible(), "стоп второй позиции");
    assert.equal(await screen.getByText("BTC · не бота").count(), 0, "своя вторая позиция — не ручная");
    assert.equal(await screen.getByText("Выход", { exact: true }).count(), 2, "у каждой позиции — свой выход");
    assert.ok(await screen.getByText(/позиций до 3/).first().isVisible());
    // Ордер входа (по рынку с границей) ещё не проверен — своей строкой.
    assert.ok(await screen.getByText("SOL · лонг · вход").isVisible());
    assert.ok(await screen.getByText(/по рынку не хуже 150[.,]12 — проверяем исполнение до .+; не исполнится — снимется/).isVisible());
    assert.ok(await screen.getByText(/вход — по рынку, но не хуже средней цены китов \(хуже — не входим, за ценой не гонимся\)/).first().isVisible());
    assert.equal(await screen.getByText("Реальная торговля не установлена").count(), 0);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(wide <= 0, `шире экрана на ${wide}px`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("ключу OKX закрыт рынок — вкладка говорит об этом прямо", async () => {
    const why = "OKX 50124: This API Key does not have trading permission for the market — ключу API закрыт этот рынок";
    const { ctx, page, errors } = await open({ owner: true, live: { ...LIVE, open: null, key_problem: why,
      skips_24h: { market: 7, chase: 1 } } });
    await page.locator(".drawer-row", { hasText: "Автоторговля" }).click();
    const screen = page.locator(".sheet .screen");
    await screen.getByText("OKX не принимает ордера бота").waitFor();
    assert.ok(await screen.getByText(/ключу API закрыт этот рынок.*бумаги не исключаются/).first().isVisible());
    assert.ok(await screen.getByText("ключу OKX закрыт рынок — 7 · цена ушла от китов — 1").isVisible());
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(wide <= 0, `шире экрана на ${wide}px`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("кит сигнала закрыл в убыток — вкладка говорит, что бот выходит", async () => {
    const [open0, ...rest] = LIVE["opens"] as Record<string, unknown>[];
    const leaving = { ...open0, exit_why: "кит 0xabcdef12… закрыл в убыток -120 $" };
    const { ctx, page, errors } = await open({ owner: true, live: { ...LIVE, open: leaving, opens: [leaving, ...rest] } });
    await page.locator(".drawer-row", { hasText: "Автоторговля" }).click();
    const screen = page.locator(".sheet .screen");
    await screen.getByText("Закрываем по рынку").waitFor();
    assert.ok(await screen.getByText(/закрыл в убыток -120 \$ — бот снял тейк и закрывает позицию рыночным ордером/).isVisible());
    assert.equal(await screen.getByText("Выход", { exact: true }).count(), 1, "вторая позиция — со своим тейком");
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("бэктест-повтор по актуальным правилам и ход пересчёта", async () => {
    const { ctx, page, errors } = await open({ owner: true, running: true,
      progress: "повтор: 40 % (400 000 из 1 000 000 сделок китов), сделок 3, запросов к OKX 120" });
    await page.locator(".drawer-row", { hasText: "Автоторговля" }).click();
    const screen = page.locator(".sheet .screen");
    await screen.getByText(/повтор: 40 % \(400 000 из 1 000 000 сделок китов\)/).waitFor();
    assert.ok(await screen.getByText(/стоп 1,5 % от входа или вслед за китом в убытке; усреднения нет/).first().isVisible());
    assert.ok(await screen.getByText(/MA30 15м: лонг — цена выше, шорт — ниже; уровней 4ч нет/).first().isVisible());
    assert.ok(await screen.getByText(/рейтинг китов по нашим сделкам: выше винрейт — раньше, выше 90 % \(от 5\)/).first().isVisible());
    assert.ok(await screen.getByText(/от 2 китов \(каждый от 10 000 \$\) в одну сторону за 2 ч/).first().isVisible(), "кит — от 10 000 $");
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(wide <= 0, `шире экрана на ${wide}px`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("испорченный ответ — вкладка не падает и не рисует мусор", async () => {
    const stats = { ...(LIVE["stats"] as Record<string, unknown>), net: "1e999" };
    const { ctx, page, errors } = await open({ owner: true, live: { ...LIVE, stats } });
    await page.locator(".drawer-row", { hasText: "Автоторговля" }).click();
    await page.getByText("Нет доступа или нет связи с сервером").waitFor();
    assert.equal(await page.getByText("Статистика реальной торговли").count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("сервер ответил «нет» — экран так и говорит", async () => {
    const { ctx, page, errors } = await open({ owner: true, reply: "404" });
    await page.locator(".drawer-row", { hasText: "Автоторговля" }).click();
    await page.getByText("Нет доступа или нет связи с сервером").waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

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

interface Opts { owner: boolean; reply?: "ok" | "404"; width?: number; on?: boolean }

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
    ok: true, stage: "backtest", on, backtest: SUMMARY, running: false, started: T - 7200, finished: T - 3600,
    error: "", next: T + 40_000, paper: null, live: null });
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
    await screen.getByText(SUMMARY.verdict ? "Вердикт: можно дальше" : "Вердикт: нет").waitFor();
    for (const s of ["Лучший набор на отложенных данных", "кросс-маржа", "Сигнал", "Торгуем на Hyperliquid", "То же имя — другой актив", "Нет на OKX", "Против китов (наоборот)", "По пределу догона", "Пересиживание", "Сколько сделок в день", "депозит кончился", "Капитал на всём периоде", "По бумагам", "Последние сделки",
      "Пересчитать сейчас"]) {
      assert.ok(await screen.getByText(s).first().isVisible(), s);
    }
    assert.ok(await screen.locator(".trend-svg").isVisible());
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

  test("сервер ответил «нет» — экран так и говорит", async () => {
    const { ctx, page, errors } = await open({ owner: true, reply: "404" });
    await page.locator(".drawer-row", { hasText: "Автоторговля" }).click();
    await page.getByText("Нет доступа или нет связи с сервером").waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

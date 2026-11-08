/*
 * Рынки сверху бокового меню — окна TradingView (node --test, Playwright,
 * собранное приложение из html/): шесть окон сеткой 2 × 3, в песочнице,
 * адрес — без данных входа Telegram, под сеткой ссылка на TradingView и
 * «ⓘ» с пояснением; влезает в 320 точек; к нашему серверу за рынками не
 * ходит. Сеть наружу в тестах закрыта — окна пустые; со снимком (MK_SHOT)
 * TradingView настоящий.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const HTML = fileURLToPath(new URL("../../html/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".ttf": "font/ttf", ".ico": "image/x-icon",
};
const I18N = JSON.parse(await readFile(new URL("../../tools/i18n.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
const T = 1_794_100_000;
const sp = (s: string | null) => (s ?? "").replace(/[\s  ]+/g, " ").trim();

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

interface Opts { lang?: string; width?: number; scale?: number; live?: boolean }

async function open(o: Opts = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[]; asked: string[] }> {
  const lang = o.lang ?? "ru";
  const ctx = await browser.newContext({ viewport: { width: o.width ?? 360, height: 780 }, deviceScaleFactor: o.scale ?? 1, timezoneId: "UTC" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const asked: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => asked.push(r.url()));
  if (!o.live) await page.clock.setFixedTime(T * 1000);
  await ctx.route((url) => !url.href.startsWith(base) && !(o.live && url.hostname.endsWith("tradingview-widget.com")), (r) => r.abort());
  await ctx.route(`${base}/api/**`, (r) => r.fulfill({ contentType: "application/json", body: '{"ok":false}' }));
  await ctx.route(`${base}/api/bootstrap`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, me: { plan: "premium" } }) }));
  await page.addInitScript((a: { lang: string }) => {
    if (window !== window.top) return; // окна TradingView — не наше приложение
    if (sessionStorage.getItem("e2e")) return;
    sessionStorage.setItem("e2e", "1");
    localStorage.clear();
    localStorage.setItem("wt-miniapp-v7", JSON.stringify({ state: { lang: a.lang, langPinned: true }, version: 9 }));
  }, { lang });
  await page.goto(`${base}/#tgWebAppData=${encodeURIComponent(`user=${encodeURIComponent('{"id":1}')}&hash=x`)}`);
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: "#sp{display:none!important}" });
  await page.locator(".burger").click();
  return { ctx, page, errors, asked };
}

const WIDGET = "https://www.tradingview-widget.com/embed-widget/tickers/";
const hash = (src: string) => JSON.parse(decodeURIComponent(src.split("#")[1]!)) as { symbols: { proName: string; title: string }[]; "page-uri": string };

test("сверху меню — шесть окон TradingView, сетка 2 × 3", async () => {
  const { ctx, page, errors, asked } = await open();
  const frames = page.locator(".drawer .mk-tv");
  await frames.first().waitFor();
  assert.equal(await frames.count(), 6);
  const srcs = await frames.evaluateAll((els) => els.map((el) => el.getAttribute("src") ?? ""));
  for (const src of srcs) assert.ok(src.startsWith(`${WIDGET}?locale=ru#`), src);
  assert.deepEqual(srcs.map((x) => hash(x).symbols),
    [["CAPITALCOM:US500", "US 500"], ["CAPITALCOM:US100", "US 100"], ["CAPITALCOM:DXY", "DXY"], ["TVC:GOLD", "Золото"],
      ["FRED:DGS10", "US 10Y"], ["DERIBIT:DVOL", "DVOL"]].map(([proName, title]) => [{ proName, title }]));
  // Данные входа Telegram (в адресе после «#») TradingView не уходят.
  for (const src of srcs) {
    assert.ok(!decodeURIComponent(src).includes("tgWebAppData"), src);
    assert.equal(hash(src)["page-uri"], new URL(base).host + "/");
  }
  // Песочница и заголовки окон.
  for (const f of await frames.all()) {
    assert.equal(await f.getAttribute("sandbox"), "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    assert.match((await f.getAttribute("title")) ?? "", / — TradingView$/);
  }
  // Сетка: два равных столбца, три ряда; пункты меню — ниже. Окно — своих
  // 172 точек, уменьшено ровно до ячейки.
  const boxes = await page.locator(".drawer .mk-cell").evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width)]; }));
  const fit = await frames.evaluateAll((els) => els.map((el) => [(el as HTMLElement).offsetWidth, Math.round(el.getBoundingClientRect().width), Math.round(el.parentElement!.getBoundingClientRect().width)]));
  for (const [w, seen, cell] of fit) {
    assert.equal(w, 172);
    assert.ok(Math.abs(seen! - cell!) <= 1, String(fit));
  }
  assert.equal(new Set(boxes.map((b) => b[0])).size, 2, String(boxes));
  assert.equal(new Set(boxes.map((b) => b[1])).size, 3, String(boxes));
  assert.equal(new Set(boxes.map((b) => b[2])).size, 1, String(boxes));
  const row = await page.locator(".drawer-row").first().boundingBox();
  const grid = await page.locator(".mk-grid").boundingBox();
  assert.ok(row && grid && row.y > grid.y + grid.height);
  // Ссылка на TradingView — как требуют их условия; «ⓘ» — пояснение.
  const link = page.locator(".mk-src a");
  assert.equal(sp(await link.textContent()), I18N["mk_tv"]!["ru"]);
  assert.match((await link.getAttribute("href")) ?? "", /^https:\/\/www\.tradingview\.com\/\?utm_source=/);
  assert.equal(await page.locator(".mk-notes").count(), 0);
  await page.locator(".mk-i").click();
  assert.equal(sp(await page.locator(".mk-notes").textContent()), sp(I18N["mk_tv_note"]!["ru"]!));
  await page.locator(".mk-i").click();
  assert.equal(await page.locator(".mk-notes").count(), 0);
  // К нашему серверу за рынками не ходит; заголовка «Wallet Tracker» нет.
  assert.ok(!asked.some((u) => u.includes("/api/markets")), String(asked));
  assert.equal(await page.locator(".drawer .drawer-ttl").count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("влезает в 320 точек на всех языках", async () => {
  for (const lang of ["ru", "en", "de", "ar", "hi", "ja", "uk"]) {
    const { ctx, page } = await open({ lang, width: 320 });
    await page.locator(".drawer .mk-tv").first().waitFor();
    // Окно не уже своих 172 точек (уже TradingView обрезает цифры), а на
    // экране — по ячейке, не мельче 0,55 (подписи ещё читаются).
    const k = await page.locator(".drawer .mk-tv").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth));
    assert.ok(k.every((x) => x >= 0.55 && x <= 1), `${lang} ${k}`);
    const over = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".mk, .mk-src")]
      .filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className));
    assert.deepEqual(over, [], lang);
    await ctx.close();
  }
});

test("снимок меню", async () => {
  const shot = process.env["MK_SHOT"];
  if (!shot) return;
  const { ctx, page } = await open({ scale: 2, live: true });
  await page.locator(".drawer .mk-tv").first().waitFor();
  if (process.env["MK_NOTES"]) await page.locator(".mk-i").click();
  await page.waitForTimeout(9000); // TradingView грузит котировки
  await page.screenshot({ path: shot });
  await ctx.close();
});

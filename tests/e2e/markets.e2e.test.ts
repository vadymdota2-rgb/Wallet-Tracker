/*
 * Рынки для криптотрейдера сверху бокового меню (node --test, Playwright,
 * собранное приложение из html/): сетка 3 × 3 вместо заголовка, подписи и
 * изменения, мелко (не крупнее пунктов меню), влезает в 320 точек, нет
 * данных — прежний заголовок «Wallet Tracker»; источники и оговорки о
 * товарных знаках видны на телефоне (касанием «ⓘ»), CoinMarketCap — ссылкой.
 * Сетка 3 × 3.
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
const MARKETS = {
  ok: true, at: T - 20, items: [
    { k: "SP500", px: 7373.1, prev: 7392.9 }, { k: "XYZ100", px: 26925, prev: 26996 }, { k: "DXY", px: 102.115, prev: 101.92 },
    { k: "GOLD", px: 4066.2, prev: 4079.9 }, { k: "US10Y", px: 4.875, prev: 4.8777 }, { k: "OIL", px: 90.205, prev: 89.617 },
    { k: "BVIV", px: 42.399, prev: 41 }, { k: "BTCD", px: 60.44, prev: 60.35 }, { k: "USDTD", px: 4.1, prev: 4.22 },
  ],
};
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

interface Opts { lang?: string; width?: number; reply?: unknown; scale?: number }

async function open(o: Opts = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const lang = o.lang ?? "ru";
  const ctx = await browser.newContext({ viewport: { width: o.width ?? 360, height: 780 }, deviceScaleFactor: o.scale ?? 1, timezoneId: "UTC" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.clock.setFixedTime(T * 1000);
  await ctx.route((url) => !url.href.startsWith(base), (r) => r.abort());
  await ctx.route(`${base}/api/**`, (r) => r.fulfill({ contentType: "application/json", body: '{"ok":false}' }));
  await ctx.route(`${base}/api/bootstrap`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, me: { plan: "premium" } }) }));
  await ctx.route(`${base}/api/markets`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(o.reply ?? MARKETS) }));
  await page.addInitScript((a: { lang: string }) => {
    if (sessionStorage.getItem("e2e")) return;
    sessionStorage.setItem("e2e", "1");
    localStorage.clear();
    localStorage.setItem("wt-miniapp-v7", JSON.stringify({ state: { lang: a.lang, langPinned: true }, version: 9 }));
  }, { lang });
  await page.goto(`${base}/#tgWebAppData=${encodeURIComponent(`user=${encodeURIComponent('{"id":1}')}&hash=x`)}`);
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: "#sp{display:none!important}" });
  await page.locator(".burger").click();
  return { ctx, page, errors };
}

test("сверху меню — девять рынков вместо заголовка, сетка 3 × 3", async () => {
  const { ctx, page, errors } = await open();
  const cells = page.locator(".drawer .mk-cell");
  await cells.first().waitFor();
  assert.equal(await cells.count(), 9);
  assert.equal(await page.locator(".drawer .drawer-ttl").count(), 0);
  const text = (await cells.evaluateAll((els) => els.map((el) => [...el.children].map((c) => c.textContent).join(" ")))).map(sp);
  assert.match(text[0]!, /^S&P 500 7 373 −0,27%$/);
  assert.match(text[3]!, /^Золото 4 066 −0,34%$/);
  assert.match(text[1]!, /^XYZ100 26 925 −0,26%$/);
  assert.match(text[4]!, /^Нефть WTI 90,2[01] \+0,66%$/);
  assert.match(text[5]!, /^US 10Y 4,88% −0,3 б\. п\.$/);
  assert.match(text[6]!, /^BVIV 42,40 \+3,41%$/);
  assert.match(text[7]!, /^BTC\.D 60,44% \+0,15%$/);
  assert.match(text[8]!, /^USDT\.D 4,10% −2,84%$/);
  assert.equal(await page.locator('.mk-cell[data-k="DXY"] .mk-ch.up').count(), 1);
  assert.equal(await page.locator('.mk-cell[data-k="SP500"] .mk-ch.dn').count(), 1);
  assert.equal(sp(await page.locator(".mk-src").textContent()), `${I18N["mk_src"]!["ru"]}ⓘ`);
  assert.equal(await page.locator('.mk-src a[href="https://coinmarketcap.com/"]').textContent(), "CoinMarketCap");
  assert.ok((await page.locator('.mk-cell[data-k="DXY"]').getAttribute("title"))?.includes("ICE"));
  assert.ok(!(await page.locator(".drawer").textContent())?.includes("Deribit"));
  // Оговорки — касанием «ⓘ»: товарные знаки S&P, XYZ100 — не Nasdaq-100, DXY — наш расчёт.
  assert.equal(await page.locator(".mk-notes").count(), 0);
  await page.locator(".mk-i").click();
  assert.equal(await page.locator(".mk-i").getAttribute("aria-expanded"), "true");
  const notes = (await page.locator(".mk-notes li").allTextContents()).map(sp);
  assert.deepEqual(notes, ["mk_sp_hint", "mk_xyz_hint", "mk_dxy_hint", "mk_oil_hint", "mk_10y_hint", "mk_bviv_hint", "mk_usdtd_hint"].map((k) => sp(I18N[k]!["ru"]!)));
  await page.locator(".mk-i").click();
  assert.equal(await page.locator(".mk-notes").count(), 0);
  // Мелко: цифры рынков меньше пунктов меню, сетка — ровные три столбца и три ряда.
  const fs = await page.evaluate(() => [".mk-px", ".drawer-row"].map((q) => parseFloat(getComputedStyle(document.querySelector(q)!).fontSize)));
  assert.ok(fs[0]! < fs[1]!, String(fs));
  const xs = await cells.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
  assert.equal(new Set(xs).size, 1, String(xs));
  const pos = await cells.evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; }));
  assert.equal(new Set(pos.map((p) => p[0])).size, 3, String(pos));
  assert.equal(new Set(pos.map((p) => p[1])).size, 3, String(pos));
  // Пункты меню на месте, под рынками.
  const row = await page.locator(".drawer-row").first().boundingBox();
  const grid = await page.locator(".mk-grid").boundingBox();
  assert.ok(row && grid && row.y > grid.y + grid.height);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("влезает в 320 точек на всех языках", async () => {
  for (const lang of ["ru", "en", "de", "ar", "hi", "ja"]) {
    const { ctx, page } = await open({ lang, width: 320 });
    await page.locator(".drawer .mk-cell").first().waitFor();
    const over = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".mk-px, .mk-ch")]
      .filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
    assert.deepEqual(over, [], lang);
    await ctx.close();
  }
});

test("нет данных — прежний заголовок меню", async () => {
  for (const reply of [{ ok: false, error: "no_data" }, { ok: true, at: T, items: [{ k: "VIX", px: 20, prev: 20 }] }, "мусор"]) {
    const { ctx, page, errors } = await open({ reply });
    await page.locator(".drawer-row").first().waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".drawer .mk").count(), 0);
    assert.equal(sp(await page.locator(".drawer .drawer-ttl").textContent()), "Wallet Tracker");
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test("снимок меню", async () => {
  const shot = process.env["MK_SHOT"];
  if (!shot) return;
  const { ctx, page } = await open({ scale: 2 });
  await page.locator(".drawer .mk-cell").first().waitFor();
  if (process.env["MK_NOTES"]) await page.locator(".mk-i").click();
  await page.waitForTimeout(800); // меню выезжает с анимацией
  await page.screenshot({ path: shot });
  await ctx.close();
});

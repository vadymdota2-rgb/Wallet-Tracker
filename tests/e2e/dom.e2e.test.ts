/*
 * «Альтсезон» в настоящем браузере: npm run test:e2e.
 *
 * Тест поднимает собранное приложение (html/) на случайном порту, подменяет
 * ответ сервера настоящим образцом (tests/fixtures/dom.json — сборка wt_dom по
 * ценам Hyperliquid), закрывает сеть наружу и проверяет то, что видит
 * человек: индекс и его зону, «k из n», разделы, сбои сервера и «собираем»,
 * старый запас на устройстве, узкий экран, арабский и 16 языков.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const HTML = fileURLToPath(new URL("../../html/", import.meta.url));
const FONTS = fileURLToPath(new URL("../../fonts/", import.meta.url));
const FACES = (base: string) => [["Regular", 400], ["Medium", 500], ["SemiBold", 600], ["Bold", 700]]
  .map(([n, w]) => `@font-face{font-family:"IBM Plex Sans";font-weight:${w};font-display:block;src:url(${base}/__fonts/IBMPlexSans-${n}.ttf) format("truetype")}`)
  .join("");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".ttf": "font/ttf", ".ico": "image/x-icon",
};

type Row = [number, number | null, number, number | null, number];
const REAL = JSON.parse(await readFile(new URL("../fixtures/dom.json", import.meta.url), "utf8")) as
  { rows: Row[]; coins: [string, number][]; btc90: number; n: number; at: number; now: number };
const T = REAL.now;
const I18N = JSON.parse(await readFile(new URL("../../tools/i18n.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
const LANGS = ["ar", "de", "en", "es", "fr", "hi", "id", "ja", "ko", "pl", "pt", "ru", "tr", "uk", "vi", "zh"];
const sp = (s: string | null) => (s ?? "").replace(/[⁦-⁩]/g, "").replace(/[\s  ]+/g, " ").trim();

let server: Server;
let base = "";
let browser: Browser;

before(async () => {
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]!)).replace(/^(\.\.[/\\])+/, "");
    if (path.startsWith("/__fonts/")) {
      const font = join(FONTS, path.slice("/__fonts/".length));
      if (font.startsWith(FONTS)) return void res.writeHead(200, { "Content-Type": TYPES[".ttf"] }).end(await readFile(font));
    }
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

interface Opts { lang?: string; width?: number; reply?: unknown; store?: Record<string, string> }
interface Opened { ctx: BrowserContext; page: Page; errors: string[]; asked: () => number }

async function open(o: Opts = {}): Promise<Opened> {
  const lang = o.lang ?? "ru";
  const ctx = await browser.newContext({ viewport: { width: o.width ?? 360, height: 780 }, locale: lang === "ar" ? "ar" : "ru-RU", timezoneId: "UTC" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.clock.setFixedTime(T * 1000);
  await ctx.route((url) => !url.href.startsWith(base) && !url.href.startsWith("https://fonts.googleapis.com/"), (r) => r.abort());
  await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ contentType: "text/css", body: FACES(base) }));
  await ctx.route(`${base}/api/**`, (r) => r.fulfill({ contentType: "application/json", body: '{"ok":false}' }));
  let n = 0;
  await ctx.route(`${base}/api/dom`, (r) => {
    n++;
    return r.fulfill({ contentType: "application/json", body: JSON.stringify(o.reply ?? REAL) });
  });
  await page.addInitScript((a: { lang: string; store: Record<string, string> }) => {
    if (sessionStorage.getItem("e2e")) return;
    sessionStorage.setItem("e2e", "1");
    localStorage.clear();
    localStorage.setItem("wt-miniapp-v7", JSON.stringify({ state: { lang: a.lang, langPinned: true }, version: 9 }));
    for (const [k, v] of Object.entries(a.store)) localStorage.setItem(k, v);
  }, { lang, store: o.store ?? {} });
  await page.goto(`${base}/`);
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".burger").click();
  await page.locator(".drawer-row", { hasText: I18N["dm_title"]![lang]! }).evaluate((el: HTMLElement) => el.click());
  return { ctx, page, errors, asked: () => n };
}

const last = REAL.rows[REAL.rows.length - 1]!;
const beat = REAL.coins.filter((c) => c[1] > REAL.btc90).length;

describe("Альтсезон", () => {
  test("индекс, зона, «k из n», разделы и источник — по настоящему ответу", async () => {
    const { ctx, page, errors } = await open();
    await page.locator(".dm-ahero").waitFor();
    assert.equal(sp(await page.locator(".dm-ahero b").innerText()), String(last[1]));
    const zone = last[1]! >= 75 ? "dm_s_alt" : last[1]! <= 25 ? "dm_s_btc" : "dm_s_mid";
    assert.equal(sp(await page.locator(".dm-ahero em").innerText()), I18N[zone]!["ru"]);
    assert.equal(sp(await page.locator(".dm-ahint").innerText()),
      sp(I18N["dm_alt_what"]!["ru"]!.replace("{k}", String(beat)).replace("{n}", String(REAL.coins.length))));
    const titles = (await page.locator(".sect").allInnerTexts()).map(sp);
    for (const k of ["dm_alt_title", "dm_str_title", "dm_top_title"]) {
      assert.ok(titles.some((x) => x.toLowerCase().includes(I18N[k]!["ru"]!.toLowerCase())), k);
    }
    assert.ok(titles.some((x) => x.includes("ETH/BTC")));
    assert.equal(sp(await page.locator(".lq-src").innerText()), sp(I18N["dm_src"]!["ru"]!));
    // Никаких следов прежних источников.
    const body = await page.locator("body").innerText();
    assert.doesNotMatch(body, /CoinMarketCap|DefiLlama|Binance/);
    // Монеты: 10, по кнопке — все.
    assert.equal(await page.locator(".dm-top-r").count(), 10);
    await page.locator(".dm-more").click();
    assert.equal(await page.locator(".dm-top-r").count(), REAL.coins.length);
    // Три графика: индекс, сила альтов, ETH/BTC.
    assert.equal(await page.locator(".fg-svg[role=img]").count(), 3);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("сервер ещё собирает цены — так и сказано, и через 30 с спросит снова", async () => {
    const { ctx, page, asked } = await open({ reply: { ok: false, error: "building" } });
    await page.locator("[role=status]", { hasText: I18N["dm_building"]!["ru"]! }).waitFor();
    const n = asked();
    await page.clock.runFor(31_000);
    for (let i = 0; i < 30 && asked() === n; i++) await page.waitForTimeout(100);
    assert.ok(asked() > n);
    await ctx.close();
  });

  test("сбой и мусор от сервера — ошибка с кнопкой «Повторить», а не пустой или упавший экран", async () => {
    for (const reply of [{ ok: false, error: "no_data" }, { ok: true, rows: "x" }, "<html>"]) {
      const { ctx, page, errors } = await open({ reply });
      await page.locator(".lq-retry").waitFor();
      assert.ok(sp(await page.locator("body").innerText()).includes(sp(I18N["dm_err"]!["ru"]!)));
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  });

  test("старый запас прежнего формата (доли CoinMarketCap) не роняет экран и стирается", async () => {
    const old = JSON.stringify({ all: { at: T * 1000, v: { ok: true, t0: 1367193600, rows: [[2e6, 58, 11, 2e5, 0.03]], alt: {}, at: T } } });
    const { ctx, page, errors } = await open({ store: { "wt-dom-v1": old } });
    await page.locator(".dm-ahero").waitFor();
    // Уборка хранилища — через 4 с после запуска (main.tsx): ключ прежнего формата не в списке и стирается.
    await page.waitForFunction(() => localStorage.getItem("wt-dom-v1") === null, null, { timeout: 8000 });
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("узкий экран и арабский — ничего не вылезает вбок", async () => {
    for (const [lang, width] of [["ru", 320], ["ar", 320], ["de", 360]] as const) {
      const { ctx, page, errors } = await open({ lang, width });
      await page.locator(".dm-ahero").waitFor();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(over <= 0, `${lang} ${width}: ${over}`);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  });

  test("16 языков: без ключей вместо текста и без незаполненных {n}", async () => {
    for (const lang of LANGS) {
      const { ctx, page } = await open({ lang });
      await page.locator(".dm-ahero").waitFor();
      const text = await page.locator(".screen-body, body").first().innerText();
      assert.doesNotMatch(text, /\bdm_[a-z0-9_]+|\{[a-z]\}/, lang);
      assert.doesNotMatch(text, /[^.]\.\.(\s|$)/, `${lang}: две точки подряд`);
      await ctx.close();
    }
  });
});

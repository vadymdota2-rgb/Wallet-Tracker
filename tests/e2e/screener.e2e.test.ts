/*
 * Скринер под графиком и Фибо от лоя — в браузере: фильтр по таймфреймам
 * (готовые «15m ↑ · 1H ↓» и наоборот, «любой / покупка / продажа»),
 * порядок по силе сигнала, касание монеты — график на младшем выбранном
 * таймфрейме и Фибо от последнего лоя с тейками, поддержками и стопом в
 * процентах; 16 языков на 320 точках, арабский. Свечи — подменённый
 * Binance (/klines-vision), скринер — подменённый /api/screener; к
 * Hyperliquid экран не ходит.
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
const LANGS = ["ru", "en", "uk", "de", "es", "fr", "pt", "pl", "tr", "id", "vi", "hi", "ar", "ja", "ko", "zh"];
const T = 1_794_100_000;
const TF_MS: Record<string, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
const sp = (s: string | null) => (s ?? "").replace(/[\s  ]+/g, " ").trim();

/** Свечи: спад со 100 до лоя 80 (свеча 200), потом рост до ~95. */
const LOW = 80;
function bars(interval: string, n = 300): unknown[] {
  const step = TF_MS[interval] ?? 900_000;
  const end = Math.floor((T * 1000) / step) * step;
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const mid = i <= 200 ? 100 - (20 * i) / 200 : 80 + (15 * (i - 200)) / 99;
    const wig = Math.sin(i / 3) * 0.4;
    const o = mid + wig;
    const c = mid - wig * 0.5;
    const h = Math.max(o, c) + 0.3;
    const l = i === 200 ? LOW : Math.max(Math.min(o, c) - 0.3, LOW + 0.5);
    out.push([end - (n - 1 - i) * step, `${o}`, `${h}`, `${l}`, `${c}`, "1000", 0, "0", 1, "500", "0", "0"]);
  }
  return out;
}

const SCREEN = {
  ok: true, at: T - 120, tfs: ["15m", "1h", "4h", "1d"], by: "Binance", rows: [
    { s: "BTC", px: 103250.5, ch: 1.25, vol: 2e9, r: { "15m": 0.6, "1h": -0.3, "4h": 0.2, "1d": 0.7 } },
    { s: "ETH", px: 3820.1, ch: -2.4, vol: 1e9, r: { "15m": -0.4, "1h": 0.5, "4h": -0.6, "1d": null } },
    { s: "SOL", px: 182.3, ch: 0.5, vol: 5e8, r: { "15m": 0.35, "1h": -0.6, "4h": 0.05, "1d": -0.2 } },
    { s: "DOGE", px: 0.18234, ch: 0, vol: 3e8, r: { "15m": null, "1h": 0.12, "4h": null, "1d": null } },
  ],
};

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

interface Opts { lang?: string; width?: number; screen?: unknown }

async function open(o: Opts = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[]; asked: string[] }> {
  const lang = o.lang ?? "ru";
  const ctx = await browser.newContext({ viewport: { width: o.width ?? 360, height: 760 }, timezoneId: "UTC" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const asked: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => asked.push(r.url()));
  await page.clock.setFixedTime(T * 1000);
  await ctx.route((url) => !url.href.startsWith(base), (r) => r.abort());
  await ctx.route(`${base}/api/**`, (r) => r.fulfill({ contentType: "application/json", body: '{"ok":false}' }));
  await ctx.route(`${base}/api/bootstrap`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, me: { plan: "premium" } }) }));
  await ctx.route(`${base}/api/screener`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(o.screen ?? SCREEN) }));
  await ctx.route(`${base}/klines-vision**`, (r) => {
    const u = new URL(r.request().url());
    return r.fulfill({ contentType: "application/json", body: JSON.stringify(bars(u.searchParams.get("interval") ?? "15m")) });
  });
  await page.addInitScript((l: string) => {
    if (window !== window.top || sessionStorage.getItem("e2e")) return;
    sessionStorage.setItem("e2e", "1");
    localStorage.clear();
    localStorage.setItem("wt-miniapp-v7", JSON.stringify({ state: { lang: l, langPinned: true }, version: 9 }));
  }, lang);
  await page.goto(`${base}/#tgWebAppData=${encodeURIComponent(`user=${encodeURIComponent('{"id":1}')}&hash=x`)}`);
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: "#sp{display:none!important}" });
  await page.locator(".burger").click();
  await page.locator(".drawer").getByText(I18N["chart_title"]![lang]!, { exact: true }).first().click();
  await page.locator(".ch-cv").waitFor();
  return { ctx, page, errors, asked };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const scrBtn = (page: Page, _lang = "ru") => page.locator(".ch-foot .scr-open");
const names = (page: Page) => page.locator(".scr-row .scr-name b").allTextContents();

/** Что не влезло: за краем экрана или обрезано. */
function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(".ch-sheet.scr, .ch-sheet.scr *, .ch-fibcard, .ch-fibcard *, .ch-foot, .ch-foot *")) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.left < -1 || r.right > innerWidth + 1)) out.push(`за краем: ${el.className || el.tagName} «${(el.textContent ?? "").slice(0, 20)}»`);
    }
    for (const el of document.querySelectorAll<HTMLElement>(".scr-presets button, .scr-name b, .ch-fib-row b, .ch-fib-row em, .scr-sig i, .ch-foot-btn span")) {
      if (el.scrollWidth > el.clientWidth + 1) out.push(`обрезано «${el.textContent}»`);
    }
    return out;
  });
}

test("скринер: все монеты, готовый фильтр «15m ↑ · 1H ↓» — сильнее сигнал выше, свой фильтр, пусто — так и сказано", async () => {
  const { ctx, page, errors, asked } = await open();
  await scrBtn(page).click();
  await page.locator(".scr-row").first().waitFor();
  assert.deepEqual(await names(page), ["BTC", "ETH", "SOL", "DOGE"]);
  assert.equal(sp(await page.locator(".scr-count").textContent()), "Найдено: 4 из 4");
  // Рейтинг на каждом таймфрейме — значком и словом для чтения с экрана.
  const btc = page.locator(".scr-row").first();
  assert.deepEqual((await btc.locator(".scr-sig i").allTextContents()).map(sp), ["15m▲▲", "1H▼", "4H▲", "1D▲▲"]);
  assert.equal(await btc.locator(".scr-sig i").first().getAttribute("aria-label"), `15m: ${I18N["chart_r_sb"]!["ru"]}`);
  assert.equal(sp(await btc.locator(".scr-name small").textContent()), "103,250.50 +1,25%");
  await page.getByRole("button", { name: "15m ↑ · 1H ↓" }).click();
  assert.deepEqual(await names(page), ["SOL", "BTC"]); // 0,35 + 0,6 сильнее, чем 0,6 + 0,3
  await page.getByRole("button", { name: "15m ↓ · 1H ↑" }).click();
  assert.deepEqual(await names(page), ["ETH"]);
  // Свой фильтр: 4H — продажа поверх «15m ↓ · 1H ↑».
  await page.locator(".scr-frow").nth(2).getByRole("radio", { name: "Продажа" }).click();
  assert.deepEqual(await names(page), ["ETH"]);
  await page.locator(".scr-frow").nth(0).getByRole("radio", { name: "Покупка" }).click();
  assert.deepEqual(await names(page), []);
  assert.equal(sp(await page.locator(".scr-list .ch-hint").textContent()), sp(I18N["scr_none"]!["ru"]!));
  // Готовый фильтр снимается повторным касанием.
  await page.getByRole("button", { name: "Всё ↑" }).click();
  assert.deepEqual(await names(page), []);
  await page.getByRole("button", { name: "Всё ↑" }).click();
  assert.equal((await names(page)).length, 4);
  assert.match(sp(await page.locator(".ch-sheet.scr > .ch-hint").textContent()), /не инвестиционный совет\. Данные Binance, обновлено 2 мин назад$/);
  assert.equal(asked.filter((u) => u.endsWith("/api/screener")).length, 1);
  assert.equal(asked.filter((u) => /hyperliquid|klines-hl/.test(u)).length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("касание монеты — график на младшем таймфрейме фильтра и Фибо от последнего лоя: тейки, цена, поддержки, стоп в процентах", async () => {
  const { ctx, page, errors } = await open();
  await scrBtn(page).click();
  await page.getByRole("button", { name: "15m ↑ · 1H ↓" }).click();
  await page.locator(".scr-row", { hasText: "SOL" }).click();
  await page.locator(".ch-fibcard").waitFor();
  assert.equal(await page.locator(".ch-sheet.scr").count(), 0);
  assert.equal(sp(await page.locator(".chart-sym").textContent()), "SOL");
  assert.equal(sp(await page.locator(".ch-tf.on").first().textContent()), "15m");
  const rows = (await page.locator(".ch-fib-row").evaluateAll((els) => els.map((el) => [el.className, (el as HTMLElement).innerText]))).map(([c, t]) => [c, sp(t!)]);
  const tp = rows.filter(([c]) => c!.includes("tp"));
  const stop = rows.find(([c]) => c!.includes("stop"))!;
  assert.ok(tp.length >= 1 && tp.length <= 3, JSON.stringify(rows));
  for (const [, txt] of tp) assert.match(txt!, /^Тейк \d · [\d.]+ [\d,.]+ \+\d+,\d\d%$/);
  // Тейки — по возрастанию сверху вниз: дальний сверху, ближний над ценой.
  assert.match(tp[tp.length - 1]![1]!, /^Тейк 1 /);
  assert.match(stop[1]!, /^Стоп \(лой\) 80\.0+ −\d+,\d\d%$/);
  assert.ok(rows.some(([c]) => c!.includes("now")));
  // На графике — рисунок Фибо (сохранён с рисунками монеты).
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("wt-chart-draw-v1") || "{}"));
  const fib = (saved.SOL ?? []).find((d: { id: string }) => d.id === "fib-low");
  assert.ok(fib, JSON.stringify(saved));
  assert.equal(fib.type, "fib");
  assert.equal(fib.pts[1].p, 80);
  assert.ok(fib.levels.includes(1.618));
  // Кнопка «Фибо от лоя» прячет карточку и ставит её снова.
  const fibBtn = page.locator(".ch-foot .fib-open");
  assert.equal(sp(await fibBtn.textContent()), I18N["fib_btn"]!["ru"]);
  await fibBtn.click();
  assert.equal(await page.locator(".ch-fibcard").count(), 0);
  await fibBtn.click();
  await page.locator(".ch-fibcard").waitFor();
  assert.deepEqual(await overflow(page), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("скринер и Фибо на 16 языках при 320 точках: переведено, ничего не вылезает", async () => {
  for (const lang of LANGS) {
    const { ctx, page, errors } = await open({ lang, width: 320 });
    await scrBtn(page, lang).click();
    await page.locator(".scr-row").first().waitFor();
    assert.equal(sp(await page.locator(".ch-sheet.scr .ch-sheet-hd b").textContent()), sp(I18N["scr_title"]![lang]!), lang);
    for (const w of ["any", "buy", "sell"]) {
      assert.equal(await page.locator(".scr-frow").first().getByRole("radio", { name: I18N[`scr_${w}`]![lang]!, exact: true }).count(), 1, `${lang} ${w}`);
    }
    assert.deepEqual(await overflow(page), [], lang);
    await page.locator(".scr-row", { hasText: "ETH" }).click();
    await page.locator(".ch-fibcard").waitFor();
    assert.equal(sp(await page.locator(".ch-fib-hd b").textContent()), sp(I18N["fib_title"]![lang]!), lang);
    assert.deepEqual(await overflow(page), [], `${lang}: Фибо`);
    assert.deepEqual(errors, [], lang);
    await ctx.close();
  }
});

test("скринер ещё не собран или ответ битый — так и сказано, без ошибок", async () => {
  for (const screen of [{ ok: false, error: "no_data" }, { ok: true, at: T, rows: [{ s: "<b>", r: {} }] }, "мусор"]) {
    const { ctx, page, errors } = await open({ screen });
    await scrBtn(page).click();
    await page.locator(".ch-sheet.scr .ch-hint").waitFor();
    await page.waitForTimeout(200);
    assert.equal(await page.locator(".scr-row").count(), 0);
    assert.equal(sp(await page.locator(".ch-sheet.scr .ch-hint").textContent()), sp(I18N["scr_wait"]!["ru"]!));
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test("снимок скринера и Фибо", async () => {
  const shot = process.env["SCR_SHOT"];
  if (!shot) return;
  const { ctx, page } = await open({ width: 390 });
  await scrBtn(page).click();
  await page.locator(".scr-row").first().waitFor();
  await page.getByRole("button", { name: "15m ↑ · 1H ↓" }).click();
  await page.screenshot({ path: shot.replace(".png", "-list.png") });
  await page.locator(".scr-row", { hasText: "SOL" }).click();
  await page.locator(".ch-fibcard").waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot });
  await page.locator(".ch-fib-hd .ch-lg-x").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot.replace(".png", "-plain.png") });
  await ctx.close();
});

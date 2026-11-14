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
    // 15m — с метриками: [рейтинг, MA, осц., RSI, ADX, объём ×, ATR %, тейк %, стоп %,
    // ход с сигнала %, свечей с сигнала]: BTC — покупка час назад, +1,2 %; ETH — продажа
    // полчаса назад, цена −4 % (больше двух ATR — поздно); SOL — покупка давно.
    { s: "BTC", px: 103250.5, ch: 1.25, vol: 2e9, r: { "15m": [0.6, 0.5, 0.7, 62, 31, 2.4, 1.2, 4, -2, 1.2, 4], "1h": -0.3, "4h": 0.2, "1d": 0.7 } },
    { s: "ETH", px: 3820.1, ch: -2.4, vol: 1e9, r: { "15m": [-0.4, -0.5, -0.3, 28, 18, 0.8, 1.5, 6, -1.5, -4, 2], "1h": 0.5, "4h": -0.6, "1d": null } },
    { s: "SOL", px: 182.3, ch: 0.5, vol: 5e8, f: 1, r: { "15m": [0.35, 0.3, 0.4, 55, 26, 3.1, 2, 2.5, -2.5, null, 101], "1h": -0.6, "4h": 0.05, "1d": -0.2 } },
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

interface Opts { lang?: string; width?: number; screen?: unknown; screenFor?: (url: string, n: number) => unknown }

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
  let n = 0;
  await ctx.route(`${base}/api/screener**`, (r) => {
    const url = r.request().url();
    const body = o.screenFor ? o.screenFor(url, n++) : (o.screen ?? SCREEN);
    return r.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
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
const names = (page: Page) => page.locator(".scr-row .scr-name b").evaluateAll((els) => els.map((el) => el.firstChild?.textContent ?? ""));
const TFS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "3d", "1w", "1M"];
const chip = (page: Page, tf: string) => page.locator(".ch-sheet.scr > .scr-tfs .scr-chip").nth(TFS.indexOf(tf));

/** Что не влезло: за краем экрана или обрезано. */
function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(".ch-sheet.scr, .ch-sheet.scr *, .ch-fibcard, .ch-fibcard *, .ch-foot, .ch-foot *")) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.left < -1 || r.right > innerWidth + 1)) out.push(`за краем: ${el.className || el.tagName} «${(el.textContent ?? "").slice(0, 20)}»`);
    }
    for (const el of document.querySelectorAll<HTMLElement>(".scr-presets button, .scr-name b, .ch-fib-row b, .ch-fib-row em, .scr-sig i, .ch-foot-btn span, .scr-x label > span, .scr-x-ttl")) {
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
  assert.deepEqual((await btc.locator(".scr-sig i").allTextContents()).map(sp), ["15m▲▲+1,2%", "1H▼", "4H▲", "1D▲▲"]);
  assert.equal(sp(await btc.locator(".scr-sig i").first().getAttribute("aria-label")), `15m: ${I18N["chart_r_sb"]!["ru"]}. Сигнал 1 ч назад, цена +1,20%`);
  // ETH: продажа полчаса назад, цена уже −4 % — больше двух ATR, подсвечено «поздно».
  const eth = page.locator(".scr-row", { hasText: "ETH" });
  assert.equal(sp(await eth.locator(".scr-sig i").first().textContent()), "15m▼−4,0%");
  assert.match(await eth.locator(".scr-sig i").first().getAttribute("class") ?? "", /\blate\b/);
  assert.equal(sp(await btc.locator(".scr-name small").textContent()), "103,250.50 +1,25%");
  await page.getByRole("button", { name: "15m ↑ · 1H ↓" }).click();
  assert.deepEqual(await names(page), ["SOL", "BTC"]); // 0,35 + 0,6 сильнее, чем 0,6 + 0,3
  await page.getByRole("button", { name: "15m ↓ · 1H ↑" }).click();
  assert.deepEqual(await names(page), ["ETH"]);
  // Свой фильтр — касанием таймфрейма: 4H — продажа поверх «15m ↓ · 1H ↑».
  await chip(page, "4h").click();
  assert.equal(await chip(page, "4h").getAttribute("aria-label"), "4H: Покупка");
  await chip(page, "4h").click();
  assert.equal(sp(await chip(page, "4h").textContent()), "4H▼");
  assert.deepEqual(await names(page), ["ETH"]);
  await chip(page, "15m").click(); // продажа → любой
  await chip(page, "15m").click(); // → покупка
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
    assert.equal(await page.locator(".ch-sheet.scr > .scr-tfs .scr-chip").count(), 14, lang);
    assert.equal(sp(await page.locator(".scr-how").textContent()), sp(I18N["scr_how"]![lang]!), lang);
    await chip(page, "1m").click();
    assert.match(await chip(page, "1m").getAttribute("aria-label") ?? "", new RegExp(`: ${I18N["scr_buy"]![lang]!}$`), lang);
    await page.locator(".scr-wait").waitFor();
    await chip(page, "1m").click();
    await chip(page, "1m").click();
    assert.equal(sp(await page.locator(".scr-x-ttl").textContent()), sp(I18N["scr_x_title"]![lang]!.replace("{tf}", "15m")), lang);
    await page.locator(".scr-x select").nth(5).selectOption("fresh");
    await page.locator(".scr-cols summary").click();
    await page.locator(".scr-cols .scr-chip").nth(0).click(); // + 1m
    await page.locator(".scr-cols .scr-chip").nth(13).click(); // + 1M
    assert.equal(await page.locator(".scr-row .scr-det").count(), 4, lang);
    assert.equal(await page.locator(".scr-row .scr-fut").count(), 1, lang);
    assert.deepEqual(await overflow(page), [], lang);
    await page.locator(".scr-row", { hasText: "ETH" }).click();
    await page.locator(".ch-fibcard").waitFor();
    assert.equal(sp(await page.locator(".ch-fib-hd b").textContent()), sp(I18N["fib_title"]![lang]!), lang);
    assert.deepEqual(await overflow(page), [], `${lang}: Фибо`);
    assert.deepEqual(errors, [], lang);
    await ctx.close();
  }
});

test("подтверждения и детали: объём, ADX, RSI, риск/прибыль на основном таймфрейме, порядок, согласие таймфреймов, фьючерсы", async () => {
  const { ctx, page, errors } = await open();
  await scrBtn(page).click();
  await page.locator(".scr-row").first().waitFor();
  assert.equal(sp(await page.locator(".scr-x-ttl").textContent()), "Подтверждения по 15m");
  const btc = page.locator(".scr-row").first();
  assert.equal(sp(await btc.locator(".scr-det").textContent()),
    "▲3 ▼1 /4 15m Сигнал 1 ч назад, цена +1,20% RSI 62 ADX 31 Об. ×2,4 ATR 1,2% TP +4,0% SL −2,0% R:R 2,0");
  assert.equal(sp(await page.locator(".scr-row", { hasText: "ETH" }).locator(".scr-since").textContent()), "Сигнал 30 мин назад, цена −4,00%");
  assert.match(await page.locator(".scr-row", { hasText: "ETH" }).locator(".scr-since").getAttribute("class") ?? "", /\blate\b/);
  assert.equal(await btc.locator(".scr-agree").getAttribute("aria-label"), "Таймфреймов за покупку: 3, за продажу: 1 из 4");
  assert.equal(await btc.locator(".scr-det .hot").count(), 3); // ADX ≥ 25, объём ≥ ×2, R:R ≥ 2
  // Фьючерсы — значком с подсказкой.
  const sol = page.locator(".scr-row", { hasText: "SOL" });
  assert.equal(await sol.locator(".scr-fut").getAttribute("title"), "Только фьючерсы Binance");
  assert.equal(sp(await sol.locator(".scr-since").textContent()), "Сигнал давно");
  // DOGE: на 15m рейтинга нет — только согласие таймфреймов.
  assert.equal(sp(await page.locator(".scr-row", { hasText: "DOGE" }).locator(".scr-det").textContent()), "▲1 ▼0 /1 15m");
  const sel = (i: number) => page.locator(".scr-x select").nth(i);
  await sel(0).selectOption("2");
  assert.deepEqual(await names(page), ["BTC", "SOL"]);
  await sel(1).selectOption("40");
  assert.deepEqual(await names(page), []);
  await sel(1).selectOption("0");
  await sel(0).selectOption("0");
  await sel(2).selectOption("os");
  assert.deepEqual(await names(page), ["ETH"]);
  await sel(2).selectOption("any");
  await sel(3).selectOption("2");
  assert.deepEqual(await names(page), ["BTC", "ETH"]);
  await sel(5).selectOption("rr");
  assert.deepEqual(await names(page), ["ETH", "BTC"]);
  await sel(3).selectOption("0");
  assert.deepEqual(await names(page), ["ETH", "BTC", "SOL", "DOGE"]); // у DOGE нет R:R — в конце
  // Не заходить поздно: цена с сигнала прошла не больше 2 % — только BTC (ETH ушла на 4 %, у SOL сигнал давно).
  await sel(4).selectOption("2");
  assert.deepEqual(await names(page), ["BTC"]);
  await sel(4).selectOption("5");
  assert.deepEqual(await names(page), ["ETH", "BTC"]);
  await sel(4).selectOption("0");
  await sel(5).selectOption("fresh");
  assert.deepEqual(await names(page), ["ETH", "BTC", "SOL", "DOGE"]); // полчаса, час, давно, без сигнала
  await sel(5).selectOption("ch");
  assert.deepEqual(await names(page), ["BTC", "SOL", "DOGE", "ETH"]);
  // Подтверждения запоминаются: после повторного открытия — тот же порядок.
  await page.locator(".ch-sheet.scr .ch-close").click();
  await scrBtn(page).click();
  assert.equal(await sel(5).inputValue(), "ch");
  // Основной таймфрейм — младший выбранный: по 1H метрик нет, подтверждение не проходит никто.
  await chip(page, "1h").click();
  assert.equal(sp(await page.locator(".scr-x-ttl").textContent()), "Подтверждения по 1H");
  await sel(0).selectOption("1.5");
  assert.deepEqual(await names(page), []);
  assert.deepEqual(await overflow(page), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("все таймфреймы: минутный фильтр — сервер получает его в запросе, пока считается — так и сказано, посчитал — монеты", async () => {
  const withMin = { ...SCREEN, tfs: [...SCREEN.tfs, "1m"], rows: SCREEN.rows.map((r, i) => ({ ...r, r: { ...r.r, "1m": [0.7, -0.5, 0.3, null][i] } })) };
  const urls: string[] = [];
  const { ctx, page, errors } = await open({
    screenFor: (url) => {
      urls.push(url);
      return url.includes("tf=1m") && urls.filter((u) => u.includes("tf=1m")).length > 1 ? withMin : SCREEN;
    },
  });
  await scrBtn(page).click();
  await page.locator(".scr-row").first().waitFor();
  await chip(page, "1m").click();
  // Сервер ещё не считал 1m — сообщение, точка на фишке, монет нет (а не «ничего не подошло»).
  await page.locator(".scr-wait").waitFor();
  assert.equal(sp(await page.locator(".scr-wait").textContent()), "Считается: 1m — около минуты");
  assert.match(await chip(page, "1m").getAttribute("class") ?? "", /\bwait\b/);
  assert.ok(urls.some((u) => u.endsWith("/api/screener?tf=1m")), urls.join(" "));
  assert.equal(await page.locator(".scr-list .ch-hint").count(), 0);
  // Через 15 секунд приложение спрашивает снова — 1m посчитан.
  await page.locator(".scr-row").first().waitFor({ timeout: 30_000 });
  assert.deepEqual(await names(page), ["BTC", "SOL"]);
  assert.equal(await page.locator(".scr-wait").count(), 0);
  // Значки у монеты — таймфрейм фильтра и столбцы.
  assert.deepEqual((await page.locator(".scr-row").first().locator(".scr-sig i").allTextContents()).map(sp), ["1m▲▲", "15m▲▲+1,2%", "1H▼", "4H▲", "1D▲▲"]);
  // Касание монеты — график на 1m.
  await page.locator(".scr-row", { hasText: "SOL" }).click();
  await page.locator(".ch-fibcard").waitFor();
  assert.equal(sp(await page.locator(".ch-tf.on").first().textContent()), "1m");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("столбцы: любой таймфрейм можно добавить или убрать; новый — серверу в запросе, пока считается — так и сказано; запоминается", async () => {
  const urls: string[] = [];
  const with5 = { ...SCREEN, tfs: [...SCREEN.tfs, "5m"], rows: SCREEN.rows.map((r, i) => ({ ...r, r: { ...r.r, "5m": [-0.7, 0.2, 0.4, null][i] } })) };
  const { ctx, page, errors } = await open({
    screenFor: (url) => {
      urls.push(url);
      return url.includes("tf=5m") && urls.filter((u) => u.includes("tf=5m")).length > 1 ? with5 : SCREEN;
    },
  });
  await scrBtn(page).click();
  await page.locator(".scr-row").first().waitFor();
  assert.equal(sp(await page.locator(".scr-cols summary").textContent()), "Таймфреймы в списке: 15m, 1H, 4H, 1D");
  await page.locator(".scr-cols summary").click();
  const col = (tf: string) => page.locator(".scr-cols .scr-chip").nth(TFS.indexOf(tf));
  assert.equal(await col("15m").getAttribute("aria-pressed"), "true");
  await col("5m").click();
  await col("4h").click();
  await col("1d").click();
  assert.equal(await col("5m").getAttribute("aria-pressed"), "true");
  assert.equal(await col("4h").getAttribute("aria-pressed"), "false");
  assert.equal(sp(await page.locator(".scr-cols summary").textContent()), "Таймфреймы в списке: 5m, 15m, 1H");
  // 5m сервер ещё не считал: монеты видны, у столбца — «—», сообщение «считается».
  await page.locator(".scr-wait").waitFor();
  assert.equal(sp(await page.locator(".scr-wait").textContent()), "Считается: 5m — около минуты");
  assert.ok(urls.some((u) => u.endsWith("/api/screener?tf=5m")), urls.join(" "));
  assert.match(await col("5m").getAttribute("class") ?? "", /\bwait\b/); // точка — на столбце,
  assert.doesNotMatch(await chip(page, "5m").getAttribute("class") ?? "", /\bwait\b/); // а не на фильтре
  assert.deepEqual((await page.locator(".scr-row").first().locator(".scr-sig i").allTextContents()).map(sp), ["5m—", "15m▲▲+1,2%", "1H▼"]);
  await page.locator(".scr-wait").waitFor({ state: "detached", timeout: 30_000 });
  assert.deepEqual((await page.locator(".scr-row").first().locator(".scr-sig i").allTextContents()).map(sp), ["5m▼▼", "15m▲▲+1,2%", "1H▼"]);
  // Убрать все — значков нет (кроме тех, что в фильтре).
  for (const tf of ["5m", "15m", "1h"]) await col(tf).click();
  assert.equal(sp(await page.locator(".scr-cols summary").textContent()), "Таймфреймы в списке: —");
  assert.equal(await page.locator(".scr-row").first().locator(".scr-sig i").count(), 0);
  await chip(page, "4h").click();
  assert.deepEqual((await page.locator(".scr-row").first().locator(".scr-sig i").allTextContents()).map(sp), ["4H▲"]);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("wt-chart-v1") || "{}"));
  assert.deepEqual(saved.scrc, []);
  assert.deepEqual(await overflow(page), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("поиск и «показать ещё»: сотни монет — по 60, поиск по тикеру", async () => {
  const many = { ...SCREEN, rows: Array.from({ length: 150 }, (_, i) => ({ s: `C${i}`, px: 1 + i, ch: 0, vol: 1e6, r: { "15m": 0.3 } })) };
  const { ctx, page, errors } = await open({ screen: many });
  await scrBtn(page).click();
  await page.locator(".scr-row").first().waitFor();
  assert.equal(await page.locator(".scr-row").count(), 60);
  assert.equal(sp(await page.locator(".scr-count").textContent()), "Найдено: 150 из 150");
  await page.locator(".scr-more").click();
  assert.equal(await page.locator(".scr-row").count(), 120);
  assert.equal(sp(await page.locator(".scr-more").textContent()), "Показать ещё 30");
  await page.locator(".scr-find").fill("c14");
  assert.deepEqual(await names(page), ["C14", "C140", "C141", "C142", "C143", "C144", "C145", "C146", "C147", "C148", "C149"]);
  assert.deepEqual(errors, []);
  await ctx.close();
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
  await page.locator(".scr-cols summary").click();
  await page.locator(".scr-cols .scr-chip").nth(2).click();
  await page.screenshot({ path: shot.replace(".png", "-cols.png") });
  await page.locator(".scr-cols summary").click();
  await page.locator(".scr-list").scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot.replace(".png", "-rows.png") });
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

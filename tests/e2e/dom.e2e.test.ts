/*
 * «Альтсезон» в настоящем браузере: npm run test:e2e.
 *
 * Тест поднимает собранное приложение (html/) на случайном порту, подменяет
 * ответ сервера настоящим образцом (tests/fixtures/dom.json — сборка wt_dom по
 * ценам Hyperliquid), закрывает сеть наружу и проверяет то, что видит
 * человек: индекс и его зону, «k из n», разделы, сбои сервера и «собираем»,
 * запас на устройстве, свежесть данных, графики пальцем и с клавиатуры,
 * таблицу, 16 языков, ширины 320–1280, телефон боком, арабский, крупный
 * шрифт, высокую контрастность и доступность.
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

type Row = [number, number | null, number, number | null, number, number | null];
const REAL = JSON.parse(await readFile(new URL("../fixtures/dom.json", import.meta.url), "utf8")) as {
  rows: Row[]; coins: [string, number][]; btc90: number; tiers: [number, number | null, number][]; n: number; at: number; now: number;
};
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

interface Opts {
  lang?: string;
  width?: number;
  height?: number;
  /** Ответ /api/dom; replies — по очереди (последний — дальше всегда). */
  reply?: unknown;
  replies?: unknown[];
  delay?: number;
  store?: Record<string, string>;
  forcedColors?: boolean;
  /** Вошёл с Премиумом (подпись Telegram, /api/bootstrap — plan: premium). */
  premium?: boolean;
  /** Ответ /api/mcap (доминация); по умолчанию — MCAP. */
  mcap?: unknown;
}

/** Доминация, как её отдаёт wt_mcap по ответу CoinMarketCap. */
const MCAP = {
  ok: true, btc: [57.49, 57.21], eth: [11.2, 11.4], alt: [42.51, 42.79], alt_ns: 33.39, usdt: 6.32,
  cap: [2_850_000_000_000, 2_900_000_000_000], by: "CoinMarketCap", at: 0,
};
interface Opened { ctx: BrowserContext; page: Page; errors: string[]; asked: () => number }

async function open(o: Opts = {}): Promise<Opened> {
  const lang = o.lang ?? "ru";
  const ctx = await browser.newContext({
    viewport: { width: o.width ?? 360, height: o.height ?? 780 }, locale: lang === "ar" ? "ar" : "ru-RU", timezoneId: "UTC",
    forcedColors: o.forcedColors ? "active" : "none",
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.clock.setFixedTime(T * 1000);
  await ctx.route((url) => !url.href.startsWith(base) && !url.href.startsWith("https://fonts.googleapis.com/"), (r) => r.abort());
  await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ contentType: "text/css", body: FACES(base) }));
  await ctx.route(`${base}/api/**`, (r) => r.fulfill({ contentType: "application/json", body: '{"ok":false}' }));
  await ctx.route(`${base}/api/mcap`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(o.mcap ?? { ...MCAP, at: T }) }));
  let n = 0;
  const replies = o.replies ?? [o.reply ?? REAL];
  await ctx.route(`${base}/api/dom`, async (r) => {
    const body = replies[Math.min(n, replies.length - 1)];
    n++;
    if (o.delay) await new Promise((ok) => setTimeout(ok, o.delay));
    await r.fulfill({ contentType: "application/json", body: typeof body === "string" ? body : JSON.stringify(body) });
  });
  if (o.premium) {
    await ctx.route(`${base}/api/bootstrap`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, me: { plan: "premium" } }) }));
  }
  await page.addInitScript((a: { lang: string; store: Record<string, string> }) => {
    if (sessionStorage.getItem("e2e")) return;
    sessionStorage.setItem("e2e", "1");
    localStorage.clear();
    localStorage.setItem("wt-miniapp-v7", JSON.stringify({ state: { lang: a.lang, langPinned: true }, version: 9 }));
    for (const [k, v] of Object.entries(a.store)) localStorage.setItem(k, v);
  }, { lang, store: o.store ?? {} });
  const tg = o.premium ? `#tgWebAppData=${encodeURIComponent(`user=${encodeURIComponent('{"id":1}')}&hash=x`)}` : "";
  await page.goto(`${base}/${tg}`);
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".burger").click();
  await page.locator(".drawer-row", { hasText: I18N["dm_title"]![lang]! }).evaluate((el: HTMLElement) => el.click());
  return { ctx, page, errors, asked: () => n };
}

/** Ничего не вылезает за край экрана (таблица и переключатели листаются сами). */
function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const W = document.documentElement.clientWidth;
    if (document.scrollingElement!.scrollWidth > W + 1) out.push(`страница шире экрана: ${document.scrollingElement!.scrollWidth} > ${W}`);
    for (const el of document.querySelectorAll<HTMLElement>(".sheet *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || el.closest(".dm-tbl-w, .chips, .seg")) continue;
      if (r.left < -0.5 || r.right > W + 0.5) out.push(`${el.tagName}.${el.className} «${(el.textContent ?? "").slice(0, 40)}» ${r.left.toFixed(0)}–${r.right.toFixed(0)}`);
    }
    return out.slice(0, 8);
  });
}

const ready = (page: Page) => page.locator(".dm-ahero").waitFor();
const saved = (v: unknown, agoMs: number) => ({ "wt-dom-v2": JSON.stringify({ all: { at: T * 1000 - agoMs, v } }) });

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
    assert.doesNotMatch(body, /DefiLlama|Binance/);
    // Монеты: 10, по кнопке — все.
    assert.equal(await page.locator(".dm-top-r").count(), 10);
    await page.locator(".dm-more").click();
    assert.equal(await page.locator(".dm-top-r").count(), REAL.coins.length);
    // Ширина рынка: индекс для корзин 25, 50 и 100 монет и вывод по ним.
    const cells = (await page.locator(".dm-tiers .fg-cmp-c b").allInnerTexts()).map(sp);
    assert.deepEqual(cells, REAL.tiers.map((x) => String(x[1])));
    const gap = REAL.tiers[0]![1]! - REAL.tiers[REAL.tiers.length - 1]![1]!;
    const say = gap >= 15 ? "dm_tiers_narrow" : gap <= -15 ? "dm_tiers_wide" : "dm_tiers_even";
    assert.ok((await page.locator(".dm-tiers > p").allInnerTexts()).map(sp).includes(sp(I18N[say]!["ru"]!)), say);
    // Индекс — на последний закрытый день, и это сказано.
    const day = new Intl.DateTimeFormat("ru", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(new Date(last[0] * 1000));
    assert.ok(sp(await page.locator(".fg-date").first().innerText()).startsWith(sp(I18N["dm_day"]!["ru"]!.replace("{d}", day))));
    // Три графика: индекс, сила альтов, ETH/BTC.
    assert.equal(await page.locator(".fg-svg[role=img]").count(), 3);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("доминация: доли BTC, альтов, ETH и USDT, за сутки, источник; нет ключа или мусор — блока нет", async () => {
    const { ctx, page, errors } = await open();
    await page.locator(".dm-dgrid").waitFor();
    const tiles = (await page.locator(".dm-dtile b").allInnerTexts()).map(sp);
    assert.deepEqual(tiles, ["57,5%", "42,5%", "11,2%", "6,3%"]);
    // Изменение за сутки — в пунктах; у USDT вчерашней доли нет.
    const minus = (x: string) => x.replace(/\u2212/g, "-");
    const deltas = (await page.locator(".dm-dtile span").allInnerTexts()).map((x) => minus(sp(x)));
    assert.deepEqual(deltas, ["+0,28", "-0,28", "-0,2"].map((v) => sp(I18N["dm_d_pp"]!["ru"]!.replace("{v}", v))));
    // Знак — у числа, слева направо даже в арабском.
    assert.deepEqual(await page.locator(".dm-dtile span bdi").evaluateAll((els) => els.map((e) => e.getAttribute("dir"))), ["ltr", "ltr", "ltr"]);
    assert.ok(sp(await page.locator(".dm-dsrc").innerText()).startsWith(sp(I18N["dm_d_src"]!["ru"]!)));
    assert.equal(await page.locator(".dm-dbar span").count(), 4);
    // Подпись полосы — для экранного диктора.
    assert.match(sp(await page.locator(".dm-dbar").getAttribute("aria-label")), /^BTC 57,5%, ETH 11,2%, USDT 6,3%, /);
    // Доминация — над альтсезоном.
    const order = await page.evaluate(() => {
      const d = document.querySelector(".dm-dgrid")!, h = document.querySelector(".dm-ahero")!;
      return Boolean(d.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.ok(order);
    assert.deepEqual(errors, []);
    await ctx.close();
    for (const mcap of [{ ok: false, error: "no_key" }, { ...MCAP, at: T, btc: [57.49, null], alt: [10, null] }, { ...MCAP, at: T, cap: [5, null] }]) {
      const o = await open({ mcap });
      await ready(o.page);
      await o.page.waitForTimeout(200);
      assert.equal(await o.page.locator(".dm-dgrid").count(), 0, JSON.stringify(mcap));
      assert.deepEqual(o.errors, []);
      await o.ctx.close();
    }
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

  test("сервер пересобирает, а на телефоне есть копия — человек сразу видит индекс, без «собираем»", async () => {
    const { ctx, page, errors } = await open({ reply: { ok: false, error: "building" }, store: saved(REAL, 2 * 3600_000) });
    await ready(page);
    assert.equal(sp(await page.locator(".dm-ahero b").innerText()), String(last[1]));
    await page.waitForTimeout(300);
    assert.equal(await page.locator("[role=status]", { hasText: I18N["dm_building"]!["ru"]! }).count(), 0);
    assert.deepEqual(errors, []);
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
  test("графики в настоящих пикселях: подписи одного размера на телефоне, планшете и компьютере; колонка по центру", async () => {
    const sizes: number[] = [];
    for (const width of [360, 768, 1280]) {
      const { ctx, page } = await open({ width, height: 900 });
      await ready(page);
      const svgs = await page.locator(".dm-svg").evaluateAll((els) => els.map((el) => {
        const sv = el as SVGSVGElement;
        return { vb: sv.viewBox.baseVal.width, w: sv.getBoundingClientRect().width };
      }));
      assert.equal(svgs.length, 3, String(width));
      for (const sv of svgs) assert.ok(Math.abs(sv.vb - sv.w) <= 2.5, `${width}: viewBox ${sv.vb} ≠ ${sv.w}`);
      sizes.push(await page.locator(".dm-svg .fg-tick").first().evaluate((el) => el.getBoundingClientRect().height));
      const col = await page.locator(".dm").evaluate((el) => { const r = el.getBoundingClientRect(); return [r.left, r.right, innerWidth]; });
      assert.ok(col[1]! - col[0]! <= 760.5, String(width));
      assert.ok(Math.abs(col[0]! - (col[2]! - col[1]!)) <= 20, `${width}: колонка не по центру`);
      await ctx.close();
    }
    assert.ok(Math.max(...sizes) - Math.min(...sizes) < 1.5, sizes.join(", "));
  });

  test("телефон боком: график помещается по высоте окна", async () => {
    const { ctx, page } = await open({ width: 844, height: 390 });
    await ready(page);
    const h = await page.locator(".dm-svg").first().evaluate((el) => el.getBoundingClientRect().height);
    assert.ok(h <= 390 * 0.75, String(h));
    assert.deepEqual(await overflow(page), []);
    await ctx.close();
  });

  test("ширины 320–1280 px: ничего не вылезает (и с открытой таблицей)", async () => {
    for (const width of [320, 375, 414, 768, 1280]) {
      const { ctx, page } = await open({ width });
      await ready(page);
      await page.locator(".dm-tbl summary").click();
      assert.deepEqual(await overflow(page), [], String(width));
      await ctx.close();
    }
  });

  test("крупный шрифт (до 160 %): текст переносится, а не вылезает", async () => {
    const { ctx, page } = await open({ width: 360 });
    await ready(page);
    await page.evaluate(() => {
      const els = [...document.querySelectorAll<HTMLElement>(".sheet *")];
      const px = els.map((el) => parseFloat(getComputedStyle(el).fontSize) * 1.6);
      els.forEach((el, i) => { el.style.fontSize = `${px[i]}px`; });
    });
    await page.waitForTimeout(100);
    assert.deepEqual(await overflow(page), []);
    await ctx.close();
  });

  test("высокая контрастность: шкала индекса и полосы монет — своими цветами", async () => {
    const { ctx, page, errors } = await open({ forcedColors: true });
    await ready(page);
    for (const sel of [".dm-top-fill", ".dm-abar-track i"]) {
      const el = page.locator(sel).first();
      assert.equal(await el.evaluate((x) => getComputedStyle(x).forcedColorAdjust), "none", sel);
      assert.notEqual(await el.evaluate((x) => getComputedStyle(x).backgroundColor), "rgba(0, 0, 0, 0)", sel);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("график с клавиатуры: стрелки, Home/End, Esc; подсказка слышна", async () => {
    const { ctx, page, errors } = await open();
    await ready(page);
    const plot = page.locator(".dm-plot").first();
    assert.equal(await plot.getAttribute("tabindex"), "0");
    assert.equal(sp(await plot.getAttribute("aria-label")), sp(I18N["ef_keys"]!["ru"]!));
    assert.equal(sp(await plot.locator("svg").getAttribute("aria-label")), I18N["dm_alt_title"]!["ru"]);
    await plot.focus();
    await page.keyboard.press("End");
    const pop = plot.locator(".fg-pop");
    assert.equal(await pop.getAttribute("aria-live"), "polite");
    assert.equal(sp(await pop.locator("b").innerText()), String(last[1]));
    const end = sp(await pop.locator("small").innerText());
    await page.keyboard.press("ArrowLeft");
    assert.notEqual(sp(await pop.locator("small").innerText()), end);
    await page.keyboard.press("Home");
    // Начало истории — с настоящих торгов на Hyperliquid (2023 г.), не раньше.
    const first = REAL.rows.find((x) => x[1] !== null)!;
    assert.match(sp(await pop.locator("small").innerText()), new RegExp(String(new Date(first[0] * 1000).getUTCFullYear())));
    await page.keyboard.press("Escape");
    assert.equal(await pop.count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("график пальцем: подсказка с датой и значением, уходит с пальцем", async () => {
    const { ctx, page } = await open();
    await ready(page);
    const svg = page.locator(".dm-svg").nth(2);
    await svg.scrollIntoViewIfNeeded();
    const box = (await svg.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    const pop = page.locator(".dm-plot").nth(2).locator(".fg-pop");
    await pop.waitFor();
    assert.match(sp(await pop.locator("b").innerText()), /^0,0\d+$/);
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height + 200);
    await pop.waitFor({ state: "detached" });
    await ctx.close();
  });

  test("сроки графиков: год, три года, вся история; выбор запоминается", async () => {
    const { ctx, page } = await open();
    await ready(page);
    const first = () => page.locator(".dm-svg").first().locator(".fg-tick").first().textContent();
    const all = await first();
    await page.locator(".seg button", { hasText: I18N["fg_r1y"]!["ru"]! }).first().click();
    assert.notEqual(await first(), all);
    assert.equal(await page.evaluate(() => localStorage.getItem("wt-dom-range")), "365");
    await ctx.close();
  });

  test("таблица под индексом: точки раз в неделю, свежие сверху", async () => {
    const { ctx, page } = await open();
    await ready(page);
    assert.equal(await page.locator(".dm-tbl table").count(), 0);
    await page.locator(".dm-tbl summary").click();
    await page.locator(".dm-tbl table").waitFor();
    const heads = (await page.locator(".dm-tbl thead th").allInnerTexts()).map(sp);
    assert.deepEqual(heads, [I18N["ef_tbl_d"]!["ru"], I18N["dm_tbl_idx"]!["ru"], I18N["dm_tbl_zone"]!["ru"]]);
    const first = (await page.locator(".dm-tbl tbody tr").first().locator("td").allInnerTexts()).map(sp);
    assert.equal(first[0], String(last[1]));
    const rows = await page.locator(".dm-tbl tbody tr").count();
    const withIdx = REAL.rows.filter((x) => x[1] !== null).length;
    assert.equal(rows, Math.ceil(withIdx / 7));
    await ctx.close();
  });

  test("Hyperliquid давно не присылал цен — экран говорит об этом; свежие — молчит", async () => {
    const old = { ...REAL, rows: REAL.rows.slice(0, -5) };
    let o = await open({ reply: old });
    await ready(o.page);
    const note = o.page.locator(".lq-stale");
    await note.waitFor();
    const n = Math.floor((T - old.rows[old.rows.length - 1]![0]) / 86_400);
    assert.equal(sp(await note.innerText()), sp(I18N["dm_old"]!["ru"]!.replace("{n}", String(n))));
    await o.ctx.close();
    o = await open();
    await ready(o.page);
    await o.page.waitForTimeout(300);
    assert.equal(await o.page.locator(".lq-stale").count(), 0);
    await o.ctx.close();
  });

  test("вернулся в приложение через час и больше — экран сам берёт свежий ответ", async () => {
    const { ctx, page, asked } = await open({ premium: true });
    await ready(page);
    for (let i = 0; i < 30 && asked() === 0; i++) await page.waitForTimeout(100);
    const n = asked();
    await page.clock.setFixedTime((T + 600) * 1000);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForTimeout(300);
    assert.equal(asked(), n);
    await page.clock.setFixedTime((T + 2 * 3600) * 1000);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    for (let i = 0; i < 30 && asked() === n; i++) await page.waitForTimeout(100);
    assert.equal(asked(), n + 1);
    await ctx.close();
  });

  test("нет связи: сохранённая копия с пометкой, сколько ей, и «повторить»", async () => {
    const { ctx, page, errors, asked } = await open({ replies: [{ ok: false }, { ok: false }, REAL], store: saved({ ...REAL, at: T - 3 * 3600 }, 3 * 3600_000) });
    await ready(page);
    const stale = page.locator(".lq-stale");
    await stale.waitFor();
    assert.match(sp(await stale.innerText()), /^Не удалось обновить — показаны сохранённые данные \(3 ч.*\)\. Повторить$/);
    await stale.locator("button").click();
    await stale.waitFor({ state: "detached" });
    assert.equal(asked(), 3);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("без сети: сохранённый ответ виден сразу, до ответа сервера", async () => {
    const { ctx, page } = await open({ delay: 5000, store: saved(REAL, 600_000) });
    await page.locator(".dm-ahero").waitFor({ timeout: 1500 });
    assert.equal(await page.locator('[aria-busy="true"]').count(), 0);
    await ctx.close();
  });

  test("загрузка: заглушка помечена занятой, потом данные", async () => {
    const { ctx, page } = await open({ delay: 600 });
    assert.equal(await page.locator('[aria-busy="true"] .skel').count(), 1);
    await ready(page);
    assert.equal(await page.locator('[aria-busy="true"]').count(), 0);
    await ctx.close();
  });

  test("доступность: у кнопок есть имена, фокус виден", async () => {
    const { ctx, page } = await open();
    await ready(page);
    const nameless = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".sheet button, .sheet a, .sheet [tabindex='0']")]
      .filter((el) => !(el.getAttribute("aria-label") || (el.textContent ?? "").trim())).map((el) => el.outerHTML.slice(0, 80)));
    assert.deepEqual(nameless, []);
    await page.keyboard.press("Tab");
    await page.locator(".dm-plot").first().focus();
    assert.equal(await page.locator(".dm-plot").first().evaluate((el) => getComputedStyle(el).outlineStyle), "solid");
    await ctx.close();
  });
});

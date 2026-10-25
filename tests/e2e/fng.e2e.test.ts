/*
 * «Страх и жадность» в настоящем браузере: npm run test:e2e.
 *
 * Тест поднимает собранное приложение (html/) на случайном порту, подменяет
 * ответ сервера образцом (tests/fixtures/fng.json — сборка wt_fng из
 * выдуманных источников), закрывает сеть наружу и проверяет то, что видит
 * человек: индекс и зону, источники рядом с цифрами (условие alternative.me),
 * «≈» у досчитанной цены, график пальцем и с клавиатуры, таблицу, сбои
 * сервера и старый ответ на устройстве, 16 языков, ширины 320–1280, арабский,
 * высокую контрастность.
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

type Day = [number, number, number, number];
const REAL = JSON.parse(await readFile(new URL("../fixtures/fng.json", import.meta.url), "utf8")) as {
  ok: true; days: Day[]; at: number; now: number;
};
const T = REAL.now;
const I18N = JSON.parse(await readFile(new URL("../../tools/i18n.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
const LANGS = ["ar", "de", "en", "es", "fr", "hi", "id", "ja", "ko", "pl", "pt", "ru", "tr", "uk", "vi", "zh"];
const sp = (s: string | null) => (s ?? "").replace(/[⁦-⁩]/g, "").replace(/[\s  ]+/g, " ").trim();
const last = REAL.days[REAL.days.length - 1]!;

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
  /** Ответ /api/fng; replies — по очереди (последний — дальше всегда). */
  reply?: unknown;
  replies?: unknown[];
  store?: Record<string, string>;
  forcedColors?: boolean;
}
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
  let n = 0;
  const replies = o.replies ?? [o.reply ?? REAL];
  await ctx.route(`${base}/api/fng`, async (r) => {
    const body = replies[Math.min(n, replies.length - 1)];
    n++;
    await r.fulfill({ contentType: "application/json", body: typeof body === "string" ? body : JSON.stringify(body) });
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
  await page.locator(".drawer-row", { hasText: I18N["fg_title"]![lang]! }).evaluate((el: HTMLElement) => el.click());
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
      if (!r.width || el.closest(".fg-tbl-w, .chips, .seg")) continue;
      if (r.left < -0.5 || r.right > W + 0.5) out.push(`${el.tagName}.${el.className} «${(el.textContent ?? "").slice(0, 40)}» ${r.left.toFixed(0)}–${r.right.toFixed(0)}`);
    }
    return out.slice(0, 8);
  });
}

const ready = (page: Page) => page.locator(".fg-hero").waitFor();
const zoneKey = (v: number) => (v <= 25 ? "fg_z0" : v <= 46 ? "fg_z1" : v <= 54 ? "fg_z2" : v <= 75 ? "fg_z3" : "fg_z4");
const fmtDay = (ts: number, lang = "ru") =>
  new Intl.DateTimeFormat(lang, { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(new Date(ts * 1000));

describe("Страх и жадность", () => {
  test("индекс, зона, дата, цена и оба источника рядом с цифрами", async () => {
    const { ctx, page, errors } = await open();
    await ready(page);
    assert.equal(sp(await page.locator(".fg-val").innerText()), String(last[1]));
    assert.equal(sp(await page.locator(".fg-zone").innerText()), I18N[zoneKey(last[1])]!["ru"]);
    const date = sp(await page.locator(".fg-date").innerText());
    assert.ok(date.startsWith(sp(fmtDay(last[0]))), date);
    assert.match(date, /BTC \$/);
    assert.doesNotMatch(date, /≈/); // цена сегодня — точная
    // Условие alternative.me — ссылка на них прямо под индексом; цена — mempool.space.
    const by = page.locator(".fg-by");
    assert.ok(sp(await by.innerText()).startsWith(sp(I18N["fg_by"]!["ru"]!)));
    const links = await by.locator("a").evaluateAll((els) => els.map((a) => [a.textContent, a.getAttribute("href")]));
    assert.deepEqual(links, [["alternative.me", "https://alternative.me/crypto/fear-and-greed-index/"], ["mempool.space", "https://mempool.space/"]]);
    assert.equal(sp(await page.locator(".lq-src").innerText()), sp(I18N["fg_src"]!["ru"]!));
    // Никаких следов прежнего источника цены.
    assert.doesNotMatch(await page.locator("body").innerText(), /Binance|Coinbase/);
    // День назад, неделю, месяц — по порядку дней.
    const cmp = (await page.locator(".fg-cmp-c b").allInnerTexts()).map(sp);
    assert.deepEqual(cmp, [1, 7, 30].map((k) => String(REAL.days[REAL.days.length - 1 - k]![1])));
    // Подсказка «?» — у каждого раздела экрана, и каждая открывается своим текстом.
    const sects = page.locator(".screen:has(.fg-hero) .sect");
    const total = await sects.count();
    assert.equal(total, 9);
    assert.equal(await page.locator(".screen:has(.fg-hero) .sect .sect-q").count(), total);
    const helps = ["fg_q_zones", "fg_q_chart", "fg_q_dist", "fg_q_st", "fi_q_what", "fi_q_edge", "fi_q_fwd", "fi_q_dca", "fi_q_sim"];
    for (let i = 0; i < total; i++) {
      const q = sects.nth(i).locator(".sect-q");
      await q.click();
      assert.equal(await q.getAttribute("aria-expanded"), "true");
      const id = await q.getAttribute("aria-controls");
      const text = sp(await page.locator(`[id="${id}"]`).innerText());
      assert.ok(text.includes(sp(I18N[helps[i]!]!["ru"]!)), helps[i]!);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("график пальцем: день, зона, цена; досчитанная цена — со знаком ≈ и пояснением", async () => {
    const { ctx, page, errors } = await open();
    await ready(page);
    const chart = page.locator(".fg-plot .fg-svg");
    await chart.scrollIntoViewIfNeeded();
    const box = (await chart.boundingBox())!;
    // Начало истории (вся история — по умолчанию): цена там по недельным точкам.
    // Середина досчитанной недели: соседние дни тоже досчитаны — промах пальца на день не важен.
    const est = REAL.days.findIndex((_, i) => REAL.days.slice(i - 2, i + 3).length === 5
      && REAL.days.slice(i - 2, i + 3).every((d) => d[3] & 1));
    const x = box.x + (est / (REAL.days.length - 1)) * (box.width - 54) + 1; // график в пикселях: справа 54 px под подписи
    await page.mouse.move(x, box.y + 40);
    const pop = page.locator(".fg-pop");
    await pop.waitFor();
    assert.match(sp(await pop.innerText()), /BTC ≈ \$/);
    // Пояснение под графиком — с датой, до которой цена досчитана.
    const until = REAL.days.filter((d) => d[3] & 1).at(-1)![0] + 86_400;
    assert.equal(sp(await page.locator(".fg-est").innerText()), sp(I18N["fg_est"]!["ru"]!.replace("{d}", fmtDay(until))));
    // Короткое окно без досчитанных дней — без пояснения.
    await page.locator(".seg button", { hasText: I18N["fg_r30"]!["ru"]! }).first().click();
    assert.equal(await page.locator(".fg-est").count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("клавиатура: стрелки — день, Shift — неделя, Home/End — края, Esc — убрать", async () => {
    const { ctx, page, errors } = await open();
    await ready(page);
    const plot = page.locator(".fg-plot.fg-keys");
    assert.equal(await plot.getAttribute("aria-label"), I18N["ef_keys"]!["ru"]);
    await plot.focus();
    await page.keyboard.press("ArrowLeft");
    const pop = page.locator(".fg-pop small").first();
    assert.equal(sp(await pop.innerText()), sp(fmtDay(last[0])));
    await page.keyboard.press("ArrowLeft");
    assert.equal(sp(await pop.innerText()), sp(fmtDay(last[0] - 86_400)));
    await page.keyboard.press("Shift+ArrowLeft");
    assert.equal(sp(await pop.innerText()), sp(fmtDay(last[0] - 8 * 86_400)));
    await page.keyboard.press("Home");
    assert.equal(sp(await pop.innerText()), sp(fmtDay(REAL.days[0]![0])));
    await page.keyboard.press("End");
    assert.equal(sp(await pop.innerText()), sp(fmtDay(last[0])));
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".fg-pop").count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("сервер ещё без цен: индекс есть, пустой панели цены и выводов о цене нет", async () => {
    const bare = { ...REAL, days: REAL.days.map((d) => [d[0], d[1], 0, d[3] & 2]) };
    const { ctx, page, errors } = await open({ reply: bare });
    await ready(page);
    assert.equal(sp(await page.locator(".fg-val").innerText()), String(last[1]));
    assert.doesNotMatch(sp(await page.locator(".fg-date").innerText()), /BTC/);
    const ticks = (await page.locator(".fg-plot .fg-tick").allInnerTexts()).map(sp);
    assert.ok(!ticks.some((x) => x.includes("$")), ticks.join(" "));
    assert.equal(await page.locator(".fg-plot .fg-ptl").count(), 1); // только «Индекс страха и жадности»
    assert.equal(await page.locator(".sect", { hasText: I18N["fi_title"]!["ru"]! }).count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("цена от запасного источника — Hyperliquid назван рядом с mempool.space", async () => {
    const hl = { ...REAL, days: REAL.days.map((d, i) => (i > REAL.days.length - 40 ? [d[0], d[1], d[2], 4] : d)) };
    const { ctx, page, errors } = await open({ reply: hl });
    await ready(page);
    assert.match(sp(await page.locator(".fg-by").innerText()), /mempool\.space, Hyperliquid$/);
    assert.deepEqual(errors, []);
    await ctx.close();
    const o2 = await open();
    await ready(o2.page);
    assert.doesNotMatch(sp(await o2.page.locator(".fg-by").innerText()), /Hyperliquid/);
    await o2.ctx.close();
  });

  test("день без индекса у alternative.me подписан", async () => {
    const { ctx, page } = await open();
    await ready(page);
    const fill = REAL.days.findIndex((d) => d[3] & 2);
    await page.locator(".fg-plot.fg-keys").focus();
    await page.keyboard.press("Home");
    for (let i = 0; i < fill; i++) await page.keyboard.press("ArrowRight");
    assert.equal(sp(await page.locator(".fg-pop .fg-note").innerText()), I18N["fg_fill"]!["ru"]);
    await ctx.close();
  });

  test("таблица: дни окна цифрами, свежие первыми, ≈ у досчитанных", async () => {
    const { ctx, page, errors } = await open();
    await ready(page);
    await page.locator(".fg-tbl summary").click();
    const rows = page.locator(".fg-tbl tbody tr");
    await rows.first().waitFor();
    // Вся история — по неделям, от последнего дня.
    assert.equal(await rows.count(), Math.ceil(REAL.days.length / 7));
    const first = (await rows.first().locator("th, td").allInnerTexts()).map(sp);
    assert.equal(first[1], String(last[1]));
    assert.equal(first[2], I18N[zoneKey(last[1])]!["ru"]);
    // «≈» — ровно у тех дней, где цена досчитана.
    const shown: Day[] = [];
    for (let i = REAL.days.length - 1; i >= 0; i -= 7) shown.push(REAL.days[i]!);
    const marks = await rows.evaluateAll((trs) => trs.map((tr) => (tr.textContent ?? "").includes("≈")));
    assert.deepEqual(marks, shown.map((d) => (d[3] & 1) !== 0));
    // Окно в 30 дней — подневно.
    await page.locator(".seg button", { hasText: I18N["fg_r30"]!["ru"]! }).first().click();
    assert.equal(await rows.count(), 30);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("сбой сервера — понятная ошибка и повтор; мусор — тоже сбой, а не пустой экран", async () => {
    for (const bad of ['{"ok":false,"error":"no_data"}', "<html>502</html>", JSON.stringify({ ...REAL, days: REAL.days.slice(0, 10) })]) {
      const { ctx, page, errors, asked } = await open({ replies: [bad, bad, REAL] });
      await page.locator(".lq-retry").waitFor();
      assert.equal(await page.locator(".empty", { hasText: I18N["fg_err"]!["ru"]! }).count(), 1);
      const before = asked();
      await page.locator(".lq-retry").click();
      await ready(page);
      assert.ok(asked() > before);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  });

  test("ответ на устройстве — экран сразу; старый формат (с ценой Binance) не берётся", async () => {
    const saved = { "wt-fng-v2": JSON.stringify({ all: { at: T * 1000 - 60_000, v: REAL } }) };
    const { ctx, page } = await open({ store: saved, reply: "<html>502</html>" });
    await ready(page);
    assert.equal(sp(await page.locator(".fg-val").innerText()), String(last[1]));
    await ctx.close();
    const old = { ok: true, days: REAL.days.map((d) => d.slice(0, 3)), at: REAL.at };
    const o2 = await open({ store: { "wt-fng-v2": JSON.stringify({ all: { at: T * 1000 - 60_000, v: old } }) }, reply: "<html>502</html>" });
    await o2.page.locator(".lq-retry").waitFor();
    await o2.ctx.close();
  });

  test("16 языков, ширины 320–1280, арабский справа налево, высокая контрастность — без вылезаний и ошибок", async () => {
    for (const lang of LANGS) {
      const { ctx, page, errors } = await open({ lang, width: 320 });
      await ready(page);
      assert.equal(sp(await page.locator(".fg-zone").innerText()), I18N[zoneKey(last[1])]![lang]);
      assert.equal(sp(await page.locator(".lq-src").innerText()), sp(I18N["fg_src"]![lang]!));
      assert.ok(sp(await page.locator(".fg-by").innerText()).includes("mempool.space"), lang);
      assert.deepEqual(await overflow(page), [], lang);
      assert.deepEqual(errors, [], lang);
      await ctx.close();
    }
    for (const width of [360, 414, 768, 1280]) {
      const { ctx, page, errors } = await open({ width, height: width > 800 ? 900 : 780 });
      await ready(page);
      assert.deepEqual(await overflow(page), [], String(width));
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    const { ctx, page, errors } = await open({ forcedColors: true });
    await ready(page);
    // Зоны на шкале видны своими цветами и в высокой контрастности.
    const adj = await page.locator(".fg-gauge").evaluate((el) => getComputedStyle(el).forcedColorAdjust);
    assert.equal(adj, "none");
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

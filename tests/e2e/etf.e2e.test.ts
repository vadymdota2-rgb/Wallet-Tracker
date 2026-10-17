/*
 * «Институциональные потоки» в настоящем браузере: npm run test:e2e.
 *
 * Как у карточки халвинга: тест поднимает собранное приложение (html/) на
 * случайном порту, подменяет ответ сервера настоящим образцом
 * (tests/fixtures/etf.json — общий с тестами сервера и модуля), закрывает
 * сеть наружу и проверяет то, что видит человек: цифры, переключатели,
 * график пальцем и с клавиатуры, таблицу, сбои и мусор от сервера, запас на
 * устройстве, 16 языков, узкий и широкий экран, арабский, крупный шрифт,
 * высокую контрастность и доступность.
 *
 * Время в браузере закреплено на время образца. Шрифт — IBM Plex Sans из
 * fonts/ проекта, как у людей: с запасным строки переносились бы иначе.
 * Нужен Chromium для Playwright: npx playwright install chromium.
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
  ".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".woff2": "font/woff2", ".ttf": "font/ttf", ".ico": "image/x-icon",
};

type Reply = { at: number; now: number; coins: { btc: { days: [number, number, number, number, (number | null)[]][]; funds: { t: string }[] } } } & Record<string, unknown>;
const REAL = JSON.parse(await readFile(new URL("../fixtures/etf.json", import.meta.url), "utf8")) as Reply;
const T = REAL.now;
const I18N = JSON.parse(await readFile(new URL("../../tools/i18n.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
const LANGS = ["ar", "de", "en", "es", "fr", "hi", "id", "ja", "ko", "pl", "pt", "ru", "tr", "uk", "vi", "zh"];
/** Текст как видит человек: неразрывные, узкие пробелы и метки направления — как обычный пробел или ничего. */
const sp = (s: string | null) => (s ?? "").replace(/[⁦-⁩]/g, "").replace(/[\s  ]+/g, " ").trim();

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
  /** Ответы /api/etf по очереди (последний — дальше всегда); не задан — образец. */
  replies?: unknown[];
  delay?: number;
  /** Что лежит на устройстве до запуска (запас ответа). */
  saved?: unknown;
  /** Что ещё положить в localStorage. */
  store?: Record<string, string>;
  forcedColors?: boolean;
}

interface Opened { ctx: BrowserContext; page: Page; errors: string[]; asked: () => number }

async function open(o: Opts = {}): Promise<Opened> {
  const ctx = await browser.newContext({
    viewport: { width: o.width ?? 360, height: o.height ?? 780 }, locale: o.lang === "ar" ? "ar" : "ru-RU",
    timezoneId: "UTC", forcedColors: o.forcedColors ? "active" : "none",
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
  const replies = o.replies ?? [REAL];
  await ctx.route(`${base}/api/etf`, async (r) => {
    const body = replies[Math.min(n, replies.length - 1)];
    n++;
    if (o.delay) await new Promise((ok) => setTimeout(ok, o.delay));
    await r.fulfill({ contentType: "application/json", body: typeof body === "string" ? body : JSON.stringify(body) });
  });
  await page.addInitScript((a: { lang: string; saved: unknown; store: Record<string, string> }) => {
    if (sessionStorage.getItem("e2e")) return;
    sessionStorage.setItem("e2e", "1");
    localStorage.clear();
    localStorage.setItem("wt-miniapp-v7", JSON.stringify({ state: { lang: a.lang, langPinned: true }, version: 9 }));
    if (a.saved) localStorage.setItem("wt-etf-v1", JSON.stringify(a.saved));
    for (const [k, v] of Object.entries(a.store)) localStorage.setItem(k, v);
  }, { lang: o.lang ?? "ru", saved: o.saved ?? null, store: o.store ?? {} });
  await page.goto(base + "/");
  await page.evaluate(() => document.fonts.ready);
  await toEtf(page, o.lang ?? "ru");
  return { ctx, page, errors, asked: () => n };
}

/** Меню → «Институциональные потоки». Пункт может быть под стрелкой «ещё»
 *  внизу меню — нажимаем сам пункт, как это делает человек после прокрутки. */
async function toEtf(page: Page, lang: string): Promise<void> {
  await page.locator(".burger").click();
  await page.locator(".drawer-row", { hasText: I18N["ef_title"]![lang]! }).evaluate((el: HTMLElement) => el.click());
}

/** Экран готов: главная карточка с последним днём. */
const ready = (page: Page) => page.locator(".ef-hero").first().waitFor();

/** Что вылезает за край экрана по горизонтали. */
function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const W = document.documentElement.clientWidth;
    if (document.scrollingElement!.scrollWidth > W + 1) out.push(`страница шире экрана: ${document.scrollingElement!.scrollWidth} > ${W}`);
    for (const el of document.querySelectorAll<HTMLElement>(".sheet *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || el.closest(".ef-tbl-w, .chips, .seg")) continue;
      if (r.left < -0.5 || r.right > W + 0.5) out.push(`${el.tagName}.${el.className} «${(el.textContent ?? "").slice(0, 40)}» ${r.left.toFixed(0)}–${r.right.toFixed(0)}`);
    }
    return out.slice(0, 8);
  });
}

/** Тексты экрана без ключей перевода: «ef_…» на экране — забытая строка. */
function rawKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => (document.querySelector(".sheet")?.textContent ?? "").match(/\b(ef|fg|ui)_[a-z0-9_]+\b/g) ?? []);
}

describe("институциональные потоки", () => {
  test("цифры последнего дня, итоги и подпись источника — как в образце", async () => {
    const { ctx, page, errors } = await open();
    await ready(page);
    assert.equal(await page.evaluate(() => document.fonts.check('700 22px "IBM Plex Sans"')), true);
    assert.equal(sp(await page.locator(".ef-hero > small").innerText()), "Последний торговый день · чт, 15 октября");
    assert.equal(sp(await page.locator(".ef-hero > b").innerText()), "+5,06 млн $");
    assert.equal(sp(await page.locator(".ef-hero > span").innerText()), "приток в фонды · +61,5 BTC");
    assert.deepEqual((await page.locator(".ef-chs").first().locator(".dm-ch b").allInnerTexts()).map(sp), ["−125 млн $", "+2,1 млрд $", "+57 млрд $"]);
    assert.match(sp(await page.locator(".ef-held").innerText()), /^Фонды управляют 105 млрд \$ — это ≈1,2\d млн BTC\. Это 6,\d\d% всех монет в обращении\.$/);
    // Подпись источника и лицензии — ссылками (условие CC BY 4.0).
    const links = page.locator(".fg-by a");
    assert.deepEqual(await links.allInnerTexts(), ["TFTC", "CC BY 4.0"]);
    assert.deepEqual(await links.evaluateAll((as) => as.map((a) => a.getAttribute("href"))),
      ["https://www.tftc.io/bitcoin-etf-flows", "https://creativecommons.org/licenses/by/4.0/"]);
    // Ссылка не уводит приложение со страницы: открывается снаружи.
    const url = page.url();
    await links.first().click();
    assert.equal(page.url(), url);
    assert.deepEqual(await rawKeys(page), []);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("спрос против добычи, рекорды и серии", async () => {
    const { ctx, page, errors } = await open();
    await ready(page);
    assert.equal(sp(await page.locator(".ef-mine-t").innerText()), "Спрос ETF против добычи за 30 дней");
    assert.deepEqual((await page.locator(".ef-mine b").allInnerTexts()).map(sp), ["24 128 BTC", "13 500 BTC"]);
    const rec = (await page.locator(".ef-rec .fg-row").allInnerTexts()).map(sp);
    assert.equal(rec.length, 6);
    assert.match(rec[0]!, /^Самый большой приток за день · 7 нояб\. 2024 г\. \+1,37 млрд \$$/);
    assert.match(rec[1]!, /^Самый большой отток за день · 25 февр\. 2025 г\. −1,11 млрд \$$/);
    // Праздники биржи — не торговые дни и серии не рвут.
    assert.match(rec[4]!, /19 дн\.$/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("фонды за день, неделю, месяц и с запуска", async () => {
    const { ctx, page } = await open();
    await ready(page);
    const funds = () => page.locator(".ef-f .ef-f-id b").allInnerTexts().then((x) => x.map(sp));
    const chip = (i: number) => page.locator(".ef-fsum").locator("xpath=preceding-sibling::*[1]").locator("button").nth(i);
    assert.deepEqual((await funds()).slice(0, 2), ["🇺🇸 MSBT", "🇺🇸 HODL"]); // неделя — по умолчанию
    await chip(0).click();
    assert.deepEqual(await funds(), ["🇺🇸 IBIT", "🇺🇸 BTCO", "🇺🇸 BTC"]);
    await chip(3).click();
    const all = await funds();
    assert.equal(all[0], "🇺🇸 IBIT");
    assert.equal(all.at(-1), "🇺🇸 GBTC");
    assert.match(sp(await page.locator(".ef-fsum").innerText()), /^Приток \+\d/);
    await ctx.close();
  });

  test("график с клавиатуры: стрелки, Home/End, Esc; подсказка слышна", async () => {
    const { ctx, page, errors } = await open();
    await ready(page);
    const plot = page.locator(".ef-flow");
    assert.equal(await plot.getAttribute("tabindex"), "0");
    assert.equal(sp(await plot.getAttribute("aria-label")), "График потоков: стрелки влево и вправо выбирают столбец");
    assert.match(sp(await plot.locator("svg").getAttribute("aria-label")), /^Цена биткоина и потоки ETF за выбранный срок, всего [+−][\d,]+ (млн|млрд) \$\. Цифры — в таблице под графиком\.$/);
    await plot.focus();
    await page.keyboard.press("End");
    const pop = plot.locator(".fg-pop");
    assert.equal(await pop.getAttribute("aria-live"), "polite");
    assert.match(sp(await pop.locator("small").innerText()), /^чт, 15 октября$/);
    await page.keyboard.press("ArrowLeft");
    assert.match(sp(await pop.locator("small").innerText()), /^ср, 14 октября$/);
    await page.keyboard.press("Home");
    assert.match(sp(await pop.locator("small").innerText()), /июля$/);
    await page.keyboard.press("Escape");
    assert.equal(await pop.count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("график пальцем: подсказка с фондами дня, уходит с пальцем", async () => {
    const { ctx, page } = await open();
    await ready(page);
    await page.locator(".ef-flow svg").scrollIntoViewIfNeeded();
    const box = (await page.locator(".ef-flow svg").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.84, box.y + box.height * 0.6);
    const pop = page.locator(".ef-flow .fg-pop");
    await pop.waitFor();
    assert.ok((await pop.locator(".ef-pop-f").count()) >= 1);
    await page.mouse.move(box.x + box.width / 2, box.y - 60);
    assert.equal(await pop.count(), 0);
    await ctx.close();
  });

  test("сроки графика: дни и недели, выбор запоминается; накопленное", async () => {
    const { ctx, page } = await open();
    await ready(page);
    const seg = page.locator(".ef-flow").locator("xpath=preceding-sibling::*[1]").locator("button");
    assert.equal(await seg.count(), 4);
    await seg.nth(2).click(); // год — по неделям
    await page.locator(".ef-flow").focus();
    await page.keyboard.press("End");
    assert.match(sp(await page.locator(".ef-flow .fg-pop small").innerText()), / — /);
    assert.equal(await page.evaluate(() => localStorage.getItem("wt-etf-range")), "365");
    // «Накоплено»: последний столбец — весь поток с запуска.
    const modes = page.locator(".ef-flow").locator("xpath=following-sibling::*[1]").locator("button");
    await modes.nth(1).click();
    await page.locator(".ef-flow").focus();
    await page.keyboard.press("End");
    assert.match(sp(await page.locator(".ef-flow .fg-pop").innerText()), /С запуска \+57 млрд \$/);
    await page.reload();
    await toEtf(page, "ru");
    await ready(page);
    assert.equal(await page.locator(".ef-flow").locator("xpath=preceding-sibling::*[1]").locator("button[aria-pressed=true], button.on, button[aria-selected=true]").innerText(), "1г");
    await ctx.close();
  });

  test("сколько держат фонды: плитки, запас по дням, график с клавиатуры", async () => {
    const { ctx, page, errors } = await open();
    await ready(page);
    const card = page.locator(".ef-plot:not(.ef-flow)").first().locator("xpath=ancestor::*[contains(@class,'card')][1]");
    const tiles = (await card.locator(".dm-ch").allInnerTexts()).map(sp);
    assert.equal(tiles.length, 3);
    assert.match(tiles[0]!, /^Сейчас 1,2\d млн BTC$/);
    assert.match(tiles[1]!, /^За 30 дней [+−][\d,]+ (тыс\. )?BTC$/);
    assert.match(tiles[2]!, /^С 6 мая 2025 г\. [+−][\d,]+ (тыс\. )?BTC$/);
    const plot = card.locator(".ef-plot");
    assert.equal(sp(await plot.getAttribute("aria-label")), "График: стрелки влево и вправо выбирают точку");
    await plot.focus();
    await page.keyboard.press("End");
    assert.match(sp(await plot.locator(".fg-pop small").innerText()), /^15 октября 2026 г\.$/);
    await page.keyboard.press("Home");
    assert.match(sp(await plot.locator(".fg-pop small").innerText()), /^6 мая 2025 г\.$/);
    await page.keyboard.press("Escape");
    assert.equal(await plot.locator(".fg-pop").count(), 0);
    // Активы в заголовке — по свежей сводке, запас — тот же, что «Сейчас».
    assert.match(sp(await page.locator(".ef-held").innerText()), /^Фонды управляют 105 млрд \$ — это ≈1,2\d млн BTC\. Это 6,\d\d% всех монет в обращении\.$/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("таблица под графиком — те же столбцы цифрами, свежие сверху", async () => {
    const { ctx, page } = await open();
    await ready(page);
    const tbl = page.locator(".ef-tbl");
    assert.equal(sp(await tbl.locator("summary").innerText()), "Таблица");
    assert.equal(await tbl.locator("table").count(), 0); // закрытая — не рисуется
    await tbl.locator("summary").click();
    const rows = tbl.locator("tbody tr");
    await rows.first().waitFor();
    const days90 = REAL.coins.btc.days.filter((d) => d[0] > REAL.coins.btc.days.at(-1)![0] - 90 * 86400).length;
    assert.equal(await rows.count(), days90);
    assert.deepEqual((await rows.first().locator("th, td").allInnerTexts()).map(sp), ["15 окт. 2026 г.", "+5,06 млн $", "$82 246"]);
    assert.deepEqual(await tbl.locator("thead th").evaluateAll((ths) => ths.map((th) => th.getAttribute("scope"))), ["col", "col", "col"]);
    await ctx.close();
  });

  test("крупнейшие держатели: группы и «ещё»", async () => {
    const { ctx, page } = await open();
    await ready(page);
    const rows = page.locator(".ef-hr");
    assert.equal(await rows.count(), 20);
    assert.match(sp(await rows.first().innerText()), /^1 🇺🇸 Strategy MSTR · отчёт в SEC на 30 июн\. 2026 г\. 846 000 BTC/);
    await page.locator(".dm-more").click();
    assert.equal(await rows.count(), (REAL["holders"] as unknown[]).length);
    await page.locator(".ef-hl").locator("xpath=preceding-sibling::*[1]").locator("button").nth(2).click(); // компании
    assert.ok((await rows.allInnerTexts()).every((t) => !/ETF ·/.test(t)));
    await ctx.close();
  });

  test("загрузка: заглушка помечена занятой, потом данные", async () => {
    const { ctx, page } = await open({ delay: 600 });
    assert.equal(await page.locator('[aria-busy="true"] .skel').count(), 1);
    await ready(page);
    assert.equal(await page.locator('[aria-busy="true"]').count(), 0);
    await ctx.close();
  });

  test("сбой: «нет данных» и «повторить»; повтор приносит данные", async () => {
    const { ctx, page, errors } = await open({ replies: [{ ok: false, error: "no_data" }, { ok: false }, REAL] });
    const retry = page.locator(".lq-retry");
    await retry.waitFor();
    await retry.click();
    await ready(page);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("мусор от сервера не роняет экран: запас с устройства, а не чепуха", async () => {
    const junk = structuredClone(REAL);
    junk.coins.btc.days[5]![4].pop(); // столбцы фондов разъехались
    const saved = { all: { at: T * 1000 - 3600_000, v: REAL } };
    for (const bad of [junk, "<html>", "{", { ...REAL, at: "x" }, { ok: true, coins: { btc: { funds: "x" } }, at: T }]) {
      const { ctx, page, errors } = await open({ replies: [bad], saved });
      await ready(page);
      assert.equal(sp(await page.locator(".ef-hero > b").innerText()), "+5,06 млн $");
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  });

  test("старый формат дополнений: потоки на месте, без держателей и CME", async () => {
    const old = { ...REAL, holders: { IBIT: 1 }, cme: { btc: [[1, 2]] }, cbp: { btc: { days: "x" } } };
    const { ctx, page, errors } = await open({ replies: [old] });
    await ready(page);
    assert.equal(await page.locator(".ef-hr").count(), 0);
    assert.equal(await page.locator(".ef-cme-oi").count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("без сети: сохранённый ответ виден сразу, до ответа сервера", async () => {
    const { ctx, page } = await open({ delay: 5000, saved: { all: { at: T * 1000 - 600_000, v: REAL } } });
    await page.locator(".ef-hero > b").waitFor({ timeout: 1500 });
    assert.equal(await page.locator('[aria-busy="true"]').count(), 0);
    await ctx.close();
  });

  test("16 языков: без ключей вместо текста, без вылезания за край на 360 px", async () => {
    for (const lang of LANGS) {
      const { ctx, page, errors } = await open({ lang });
      await ready(page);
      assert.deepEqual(await rawKeys(page), [], lang);
      assert.deepEqual(await overflow(page), [], lang);
      assert.equal(sp(await page.locator(".fg-by").innerText()).includes("TFTC"), true, lang);
      assert.deepEqual(errors, [], lang);
      await ctx.close();
    }
  });

  test("ширины 320–1280 px: ничего не вылезает", async () => {
    for (const width of [320, 375, 414, 768, 1280]) {
      const { ctx, page } = await open({ width });
      await ready(page);
      await page.locator(".ef-tbl summary").click();
      assert.deepEqual(await overflow(page), [], String(width));
      await ctx.close();
    }
  });

  test("арабский: справа налево, числа и даты целы", async () => {
    const { ctx, page, errors } = await open({ lang: "ar", width: 320 });
    await ready(page);
    assert.equal(await page.evaluate(() => document.documentElement.dir), "rtl");
    assert.equal(await page.locator(".ef-hero > b bdi").getAttribute("dir"), "ltr");
    assert.deepEqual(await overflow(page), []);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("крупный шрифт (до 200 %): текст переносится, а не вылезает", async () => {
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

  test("высокая контрастность: полосы фондов и столбцы своими цветами", async () => {
    const { ctx, page, errors } = await open({ forcedColors: true });
    await ready(page);
    const adj = await page.locator(".ef-f-fill").first().evaluate((el) => getComputedStyle(el).forcedColorAdjust);
    assert.equal(adj, "none");
    const bg = await page.locator(".ef-f-fill").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.notEqual(bg, "rgba(0, 0, 0, 0)");
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("доступность: у кнопок есть имена, ссылки — текстом, фокус виден", async () => {
    const { ctx, page } = await open();
    await ready(page);
    const nameless = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".sheet button, .sheet a, .sheet [tabindex='0']")]
      .filter((el) => !(el.getAttribute("aria-label") || (el.textContent ?? "").trim())).map((el) => el.outerHTML.slice(0, 80)));
    assert.deepEqual(nameless, []);
    await page.keyboard.press("Tab"); // фокус «с клавиатуры» — как у человека с клавиатурой
    await page.locator(".ef-flow").focus();
    const outline = await page.locator(".ef-flow").evaluate((el) => getComputedStyle(el).outlineStyle);
    assert.equal(outline, "solid");
    assert.equal(await page.locator(".ef-flow svg[role=img]").count(), 1);
    await ctx.close();
  });
});

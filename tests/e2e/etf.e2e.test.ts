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
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";

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
  /** Вошёл с Премиумом (подпись Telegram в адресе, /api/bootstrap — plan: premium). */
  premium?: boolean;
  /** Не открывать экран: остаться на главном (проверка подгрузки при запуске). */
  stay?: boolean;
  /** Часы телефона, unix с (по умолчанию — время образца). */
  clock?: number;
  /** Ответ сервера на /api/etfwatch (итоги дня в Telegram). */
  watch?: (r: Route) => Promise<void>;
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
  await page.clock.setFixedTime((o.clock ?? T) * 1000);
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
  if (o.watch) await ctx.route(`${base}/api/etfwatch`, o.watch);
  if (o.premium) {
    await ctx.route(`${base}/api/bootstrap`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, me: { plan: "premium" } }) }));
  }
  const tg = o.premium ? `#tgWebAppData=${encodeURIComponent(`user=${encodeURIComponent('{"id":1}')}&hash=x`)}` : "";
  await page.goto(`${base}/${tg}`);
  await page.evaluate(() => document.fonts.ready);
  if (!o.stay) await toEtf(page, o.lang ?? "ru");
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
    assert.equal(sp(await page.locator(".ef-hero > span").innerText()), "приток в фонды · +61,6 BTC");
    assert.deepEqual((await page.locator(".ef-chs").first().locator(".dm-ch b").allInnerTexts()).map(sp), ["−125 млн $", "+2,1 млрд $", "+57 млрд $"]);
    assert.match(sp(await page.locator(".ef-held").innerText()), /^Фонды управляют 106 млрд \$ — это ≈1,2\d млн BTC\. Это 6,\d\d% всех монет в обращении\.$/);
    // Подпись источника и лицензии — ссылками (условие CC BY 4.0), с датой
    // «данные по», как просит TFTC; цен бирж (Coinbase) на экране нет.
    assert.equal(sp(await page.locator(".fg-by").innerText()),
      "Потоки и активы фондов, цена дня: TFTC (CC BY 4.0), данные по 15 окт. 2026 г. Монеты, суммы и запасы считаем сами.");
    assert.equal(await page.getByText("Coinbase").count(), 0);
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

  test("спрос против добычи: меньше добычи — доля, продажи — за 30 дней, без «давления майнеров»", async () => {
    const shift = (k: number) => {
      const r = structuredClone(REAL) as typeof REAL;
      const days = r.coins.btc.days;
      const end = days.at(-1)![0];
      for (const d of days) if (d[0] > end - 30 * 86_400) { d[1] *= k; d[2] *= k; }
      return r;
    };
    const less = await open({ replies: [shift(0.25)] });
    await ready(less.page);
    assert.match(sp(await less.page.locator(".ef-mine-say").innerText()), /^ETF забрали 45 ?% новой добычи, остальное уходит на рынок\.$/);
    await less.ctx.close();
    const sell = await open({ replies: [shift(-1)] });
    await ready(sell.page);
    assert.equal(sp(await sell.page.locator(".ef-mine-say").innerText()),
      "За 30 дней ETF больше продали, чем купили: их монеты идут на рынок вместе с новой добычей майнеров.");
    assert.equal(sp(await sell.page.locator(".ef-mine small").first().innerText()), "Продали ETF");
    await sell.ctx.close();
  });

  test("спрос против добычи, рекорды и серии", async () => {
    const { ctx, page, errors } = await open();
    await ready(page);
    // Заголовок раздела с «?»: объяснение добычи — у самой карточки.
    const mineT = page.locator(".ef > .sect", { hasText: "Спрос ETF против добычи за 30 дней" });
    assert.equal(await mineT.count(), 1);
    await mineT.locator(".sect-q").click();
    assert.match(sp(await page.locator(".sect-help").innerText()), /^Спрос ETF против добычи: сейчас майнеры создают около 450 BTC в сутки \(после халвинга 2028 г\. — около 225\)/);
    assert.deepEqual((await page.locator(".ef-mine b").allInnerTexts()).map(sp), ["24 087 BTC", "13 500 BTC"]);
    // Доля, а не «в N раза»: «в 20 раза» было бы неграмотно, а в ноябре 2024 г. так и было бы.
    assert.match(sp(await page.locator(".ef-mine-say").innerText()),
      /^ETF забрали 178 ?% новой добычи — больше, чем намайнено: свободных монет на рынке становится меньше\.$/);
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
    // Про GBTC — только «с запуска»; за неделю его в списке может и не быть.
    const note = () => page.locator(".ef-fsum").locator("xpath=following-sibling::p[last()]").innerText().then(sp);
    assert.match(await note(), /GBTC распродавали после перехода из траста в ETF/);
    await chip(1).click();
    assert.doesNotMatch(await note(), /GBTC/);
    await ctx.close();
  });

  test("карточка фонда: нажатие раскрывает потоки по дням, итог, запас и рекорды; ещё нажатие — сворачивает", async () => {
    const { ctx, page, errors } = await open();
    await ready(page);
    await page.locator(".ef-fsum").locator("xpath=preceding-sibling::*[1]").locator("button").nth(3).click(); // с запуска
    const row = page.locator("button.ef-f", { hasText: "IBIT" });
    assert.equal(await row.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".ef-fd").count(), 0);
    await row.click();
    assert.equal(await row.getAttribute("aria-expanded"), "true");
    const card = page.locator(".ef-fd");
    assert.equal(await card.getAttribute("id"), await row.getAttribute("aria-controls"));
    assert.match(sp(await card.locator(".ef-fd-t").innerText()), /^Торговых дней: 60 · всего [+−]/);
    assert.match(await card.locator("svg").getAttribute("aria-label") ?? "", /^IBIT: потоки по дням, торговых дней: 60, всего /);
    assert.ok(await card.locator("svg rect").count() > 30);
    const lines = (await card.locator("li").allInnerTexts()).map(sp);
    assert.match(lines[0]!, /^С запуска: \+\d.* млрд \$ · \+[\d ]+ BTC$/);
    assert.match(lines[1]!, /^Запас фонда: ≈[\d ]+ BTC$/);
    assert.match(lines[2]!, /^Самый большой приток за день: \+.* · \d+ .* г\.$/);
    assert.match(lines[3]!, /^Самый большой отток за день: −.* · \d+ .* г\.$/);
    // Открыт один фонд: другой закрывает первый.
    await page.locator("button.ef-f", { hasText: "FBTC" }).click();
    assert.equal(await row.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".ef-fd").count(), 1);
    // С клавиатуры: Enter открывает и закрывает.
    await row.focus();
    await page.keyboard.press("Enter");
    assert.equal(await row.getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Enter");
    assert.equal(await row.getAttribute("aria-expanded"), "false");
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("набор давно не обновлялся — экран говорит об этом; свежий — молчит", async () => {
    const fresh = await open();
    await ready(fresh.page);
    assert.equal(await fresh.page.locator(".lq-stale").count(), 0);
    await fresh.ctx.close();
    // Последний день в образце — 15 октября; спустя 9 суток данных так и нет.
    const { ctx, page } = await open({ clock: T + 9 * 86_400 });
    await ready(page);
    assert.match(sp(await page.locator(".lq-stale").innerText()), /^Набор TFTC не обновлялся \d+ дн\.: свежих данных фондов пока нет/);
    assert.equal(await page.locator(".lq-stale").getAttribute("role"), "status");
    await ctx.close();
  });

  test("вернулся в приложение через час и больше — экран сам берёт свежий ответ", async () => {
    // С Премиумом: без него возврат в приложение заново спрашивает план, и экран закрывается замком.
    const { ctx, page, asked } = await open({ premium: true });
    await ready(page);
    const n = asked();
    // Меньше часа — сеть не трогаем.
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

  test("карточки не слипаются, заголовок раздела ближе к своей карточке", async () => {
    const { ctx, page } = await open();
    await ready(page);
    const boxes = await page.locator(".ef > .card").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r): [number, number] => [r.top, r.bottom]));
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i]![0] - boxes[i - 1]![1] >= 10, `карточки ${i - 1} и ${i}: ${boxes[i]![0] - boxes[i - 1]![1]}`);
    const gaps = await page.locator(".ef > .sect").evaluateAll((els) => els.map((h) => {
      const r = h.getBoundingClientRect();
      const prev = h.previousElementSibling!.getBoundingClientRect();
      let next = h.nextElementSibling!;
      while (!next.classList.contains("card")) next = next.nextElementSibling!;
      return [r.top - prev.bottom, next.getBoundingClientRect().top - r.bottom] as [number, number];
    }));
    assert.ok(gaps.length >= 4);
    for (const [above, below] of gaps) assert.ok(above! > below!, `${above} / ${below}`);
    await ctx.close();
  });

  test("CME: в «?» объяснены лонг, шорт и открытый интерес — слова, из которых состоит карточка", async () => {
    const { ctx, page } = await open();
    await ready(page);
    await page.locator(".ef > .sect", { hasText: "Институционалы на CME" }).locator(".sect-q").click();
    const ps = (await page.locator(".sect-help p").allInnerTexts()).map(sp);
    assert.deepEqual(ps, ["ef_how_6", "q_ls_1", "oih_how_1"].map((k) => sp(I18N[k]!["ru"]!)));
    await ctx.close();
  });

  test("подписи осей справа не налезают на графики", async () => {
    const { ctx, page } = await open();
    await ready(page);
    const bad = await page.locator(".ef-svg").evaluateAll((svgs) => svgs.flatMap((svg) => {
      const w = (svg as SVGSVGElement).viewBox.baseVal.width;
      const plot = w - 58;
      return [...svg.querySelectorAll<SVGTextElement>("text.fg-tick[text-anchor='end']")]
        .filter((tx) => tx.getBBox().x < plot - 0.5).map((tx) => `${tx.textContent} ${tx.getBBox().x.toFixed(0)} < ${plot}`);
    }));
    assert.deepEqual(bad, []);
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
    // По центру окна: низ графика не под нижней панелью навигации.
    await page.locator(".ef-flow svg").evaluate((el) => el.scrollIntoView({ block: "center" }));
    const box = (await page.locator(".ef-flow svg").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.84, box.y + box.height * 0.5);
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
    assert.match(sp(await page.locator(".ef-held").innerText()), /^Фонды управляют 106 млрд \$ — это ≈1,2\d млн BTC\. Это 6,\d\d% всех монет в обращении\.$/);
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
    assert.deepEqual((await rows.first().locator("th, td").allInnerTexts()).map(sp), ["15 окт. 2026 г.", "+5,06 млн $", "$82 016"]);
    assert.deepEqual(await tbl.locator("thead th").evaluateAll((ths) => ths.map((th) => th.getAttribute("scope"))), ["col", "col", "col"]);
    await ctx.close();
  });

  test("крупнейшие держатели: группы и «ещё»", async () => {
    const { ctx, page } = await open();
    await ready(page);
    const rows = page.locator(".ef-hr");
    // В образце 21 строка: хвост в одну строку виден сразу, без кнопки «Показать ещё 1».
    assert.equal(await rows.count(), (REAL["holders"] as unknown[]).length);
    assert.equal(await page.locator(".dm-more").count(), 0);
    assert.match(sp(await rows.first().innerText()), /^1 🇺🇸 Strategy MSTR · отчёт в SEC на 30 июн\. 2026 г\. 846 000 BTC/);
    // Дата отчёта — одним куском: «г.» не уезжает на строку одно.
    assert.match(await rows.first().locator(".ef-hr-id small").innerText(), /30\u00a0июн\.\u00a02026\u00a0г\./);
    await page.locator(".ef-hl").locator("xpath=preceding-sibling::*[1]").locator("button").nth(2).click(); // компании
    assert.ok((await rows.allInnerTexts()).every((t) => !/ETF ·/.test(t)));
    await ctx.close();

    // Длинный список — по 20, а последний короткий хвост — целиком: 47 = 20 + 20 + 7.
    const many = (REAL["holders"] as unknown[][]).filter((r) => r[1] === "COMPANY");
    const big = Array.from({ length: 47 }, (_, i) => {
      const r = [...many[i % many.length]!];
      r[3] = `T${i}`;
      r[4] = 100_000 - i;
      return r;
    });
    const o = await open({ replies: [{ ...REAL, holders: big }] });
    await ready(o.page);
    const r2 = o.page.locator(".ef-hr");
    assert.equal(await r2.count(), 20);
    assert.equal(sp(await o.page.locator(".dm-more").innerText()), "Показать ещё 20");
    await o.page.locator(".dm-more").click();
    assert.equal(await r2.count(), 40);
    assert.equal(sp(await o.page.locator(".dm-more").innerText()), "Показать ещё 7");
    await o.page.locator(".dm-more").click();
    assert.equal(await r2.count(), 47);
    assert.equal(await o.page.locator(".dm-more").count(), 0);
    await o.ctx.close();
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

  test("нет связи: сохранённая копия с пометкой, сколько ей, и «повторить»", async () => {
    const saved = { all: { at: T * 1000 - 3 * 3600_000, v: { ...REAL, at: T - 3 * 3600 } } };
    // Сбой дважды: приложение само повторяет запрос один раз (callTwice).
    const { ctx, page, errors, asked } = await open({ replies: [{ ok: false }, { ok: false }, REAL], saved });
    await ready(page);
    const stale = page.locator(".lq-stale");
    await stale.waitFor();
    assert.match(sp(await stale.innerText()), /^Не удалось обновить — показаны сохранённые данные \(3 ч.*\)\. Повторить$/);
    await stale.locator("button").click();
    await stale.waitFor({ state: "detached" });
    // Плашка уходит сразу по нажатию, а запрос доходит до сервера чуть позже:
    // ждём его, а не проверяем в тот же миг (под нагрузкой — гонка).
    for (let i = 0; i < 50 && asked() < 3; i++) await page.waitForTimeout(100);
    assert.equal(asked(), 3);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("нет связи и копия двухнедельной давности: «не удалось обновить», а не «TFTC не обновлялся»", async () => {
    // Копия с телефона — от образца; на часах — две недели спустя, сеть молчит.
    const later = T + 14 * 86_400;
    const saved = { all: { at: later * 1000 - 3600_000, v: REAL } };
    const { ctx, page } = await open({ replies: [{ ok: false }], saved, clock: later, delay: 300 });
    await ready(page);
    // До ответа сервера предупреждения о наборе нет — копия ещё не проверена сетью.
    assert.equal(await page.locator(".lq-stale").count(), 0);
    const stale = page.locator(".lq-stale");
    await stale.waitFor();
    assert.equal(await stale.count(), 1);
    assert.match(sp(await stale.innerText()), /^Не удалось обновить/);
    await ctx.close();
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

  test("подгрузка при запуске: с Премиумом ответ приходит до открытия экрана, экран — сразу и без второго запроса", async () => {
    const { ctx, page, errors, asked } = await open({ premium: true, stay: true });
    for (let i = 0; i < 50 && asked() === 0; i++) await page.waitForTimeout(100);
    assert.equal(asked(), 1); // фоновая подгрузка спросила сервер, экран ещё не открыт
    assert.equal(await page.locator(".ef-hero").count(), 0);
    // Проверенная копия — и на устройстве: следующий запуск покажет её сразу.
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("wt-etf-v1") ?? "{}") as { all?: { v?: { ok?: boolean } } });
    assert.equal(saved.all?.v?.ok, true);
    await toEtf(page, "ru");
    await page.locator(".ef-hero > b").waitFor({ timeout: 1000 });
    assert.equal(await page.locator('[aria-busy="true"]').count(), 0);
    await page.waitForTimeout(300);
    assert.equal(asked(), 1); // ответ из памяти: сеть не тронута
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("без Премиума при запуске ничего не подгружается", async () => {
    const { ctx, page, asked } = await open({ stay: true });
    await page.waitForTimeout(1500);
    assert.equal(asked(), 0);
    await ctx.close();
  });

  test("графики в настоящих пикселях: подписи одного размера на телефоне, планшете и компьютере", async () => {
    const sizes: number[] = [];
    for (const width of [360, 768, 1280]) {
      const { ctx, page } = await open({ width, height: 900 });
      await ready(page);
      const svgs = await page.locator(".ef-svg").evaluateAll((els) => els.map((el) => {
        const s = el as SVGSVGElement;
        return { vb: s.viewBox.baseVal.width, w: s.getBoundingClientRect().width };
      }));
      assert.ok(svgs.length >= 3, String(width));
      for (const s of svgs) assert.ok(Math.abs(s.vb - s.w) <= 2.5, `${width}: viewBox ${s.vb} ≠ ${s.w}`);
      sizes.push(await page.locator(".ef-flow .fg-tick").first().evaluate((el) => el.getBoundingClientRect().height));
      // Колонка не шире 760 px и по центру.
      const col = await page.locator(".ef").evaluate((el) => { const r = el.getBoundingClientRect(); return [r.left, r.right, innerWidth]; });
      assert.ok(col[1]! - col[0]! <= 760.5, String(width));
      assert.ok(Math.abs(col[0]! - (col[2]! - col[1]!)) <= 20, `${width}: колонка не по центру`);
      await ctx.close();
    }
    // Подпись оси — одной высоты на всех ширинах (раньше на 1280 — втрое крупнее).
    assert.ok(Math.max(...sizes) - Math.min(...sizes) < 1.5, sizes.join(", "));
  });

  test("телефон боком: график помещается по высоте окна", async () => {
    const { ctx, page } = await open({ width: 844, height: 390 });
    await ready(page);
    const h = await page.locator(".ef-flow svg").evaluate((el) => el.getBoundingClientRect().height);
    assert.ok(h <= 390 * 0.75, String(h));
    assert.deepEqual(await overflow(page), []);
    await ctx.close();
  });

  test("16 языков: без ключей вместо текста, без вылезания за край на 360 px", async () => {
    for (const lang of LANGS) {
      const { ctx, page, errors } = await open({ lang });
      await ready(page);
      await page.locator("button.ef-f").first().click(); // карточка фонда — тоже на этом языке
      await page.locator(".ef-fd").waitFor();
      assert.deepEqual(await rawKeys(page), [], lang);
      assert.deepEqual(await overflow(page), [], lang);
      assert.equal(sp(await page.locator(".fg-by").innerText()).includes("TFTC"), true, lang);
      assert.deepEqual(errors, [], lang);
      await ctx.close();
    }
  });

  test("ось цены по-английски — тысячи на месте («$80,000», а не «$80»)", async () => {
    const { ctx, page } = await open({ lang: "en" });
    await ready(page);
    const ticks = (await page.locator(".fg-tick").allTextContents()).map(sp).filter((x) => /^\$\d[\d,]*$/.test(x)); // цена, а не потоки («$1B»)
    assert.ok(ticks.length >= 2, ticks.join(" "));
    for (const x of ticks) assert.ok(Number(x.slice(1).split(",").join("")) >= 1000, x);
    await ctx.close();
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

  test("таблица по неделям на телефоне — в карточке, неделя переносится после тире", async () => {
    for (const range of ["365", "all"]) for (const width of [320, 360, 412]) {
      const { ctx, page } = await open({ width, store: { "wt-etf-range": range } });
      await ready(page);
      await page.locator(".ef-tbl summary").click();
      await page.locator(".ef-tbl tbody tr").first().waitFor();
      const m = await page.evaluate(() => {
        const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        const card = document.querySelector(".ef-tbl")!.parentElement!.getBoundingClientRect();
        const th = document.querySelector<HTMLElement>(".ef-tbl tbody th")!;
        return { card: card.right, details: box(".ef-tbl").right, wrap: box(".ef-tbl-w").right, table: box(".ef-tbl table").right,
          head: sp0(document.querySelector(".ef-tbl thead th")!.textContent),
          // Строк у даты — по разным высотам кусков (тире может рисоваться другим шрифтом — это не перенос).
          spans: [...th.querySelectorAll("span")].map((x) => new Set([...x.getClientRects()].map((r) => Math.round(r.top))).size) };
        function sp0(x: string | null) { return (x ?? "").trim(); }
      });
      const tag = `${range} ${width}`;
      assert.equal(m.head, "Неделя", tag);
      assert.ok(m.details <= m.card + 0.5 && m.wrap <= m.card + 0.5, `${tag}: ${JSON.stringify(m)}`);
      // От 360 px таблица целиком в рамке; на 320 — листается внутри неё, страница на месте.
      if (width >= 360) assert.ok(m.table <= m.wrap + 0.5, `${tag}: таблица шире рамки ${JSON.stringify(m)}`);
      // Дата не рвётся посередине: каждая — одной строкой.
      assert.deepEqual(m.spans, [1, 1], tag);
      assert.deepEqual(await overflow(page), [], tag);
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

  test("итоги дня в Telegram: до ответа сервера выключатель неактивен, нажатие шлёт on и язык, без Премиума — подсказка", async () => {
    const posts: unknown[] = [];
    let plan = "premium";
    let gate: () => void = () => {};
    const answered = new Promise<void>((ok) => { gate = ok; });
    const { ctx, page } = await open({
      premium: true,
      watch: async (r) => {
        if (r.request().method() === "GET") {
          await answered;
          await r.fulfill({ contentType: "application/json", body: '{"ok":true,"on":false,"min":500000000}' });
          return;
        }
        const body = r.request().postDataJSON() as { on: boolean };
        posts.push(body);
        const reply = body.on && plan !== "premium" ? { ok: false, error: "premium" } : { ok: true, on: body.on, min: 5e8 };
        await r.fulfill({ contentType: "application/json", body: JSON.stringify(reply) });
      },
    });
    await ready(page);
    const sw = page.locator(".ef-al");
    assert.equal(await sw.getAttribute("role"), "switch");
    assert.ok(await sw.isDisabled());
    assert.match(sp(await sw.innerText()), new RegExp(sp(I18N["ef_al_t"]!["ru"]!)));
    gate();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".ef-al")!.disabled);
    assert.equal(await sw.getAttribute("aria-checked"), "false");
    await sw.click();
    await page.waitForFunction(() => document.querySelector(".ef-al")!.getAttribute("aria-checked") === "true");
    await sw.click();
    await page.waitForFunction(() => document.querySelector(".ef-al")!.getAttribute("aria-checked") === "false");
    assert.deepEqual(posts, [{ on: true, lang: "ru" }, { on: false, lang: "ru" }]);
    plan = "free";
    await sw.click();
    await page.locator(".toast.err").waitFor();
    assert.equal(sp(await page.locator(".toast.err").innerText()), sp(I18N["lk_title"]!["ru"]!));
    assert.equal(await sw.getAttribute("aria-checked"), "false");
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

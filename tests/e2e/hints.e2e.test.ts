/*
 * Подсказки «?» у заголовков и словарь терминов в помощи — в настоящем
 * браузере: npm run test:e2e.
 *
 * Тест поднимает собранное приложение (html/) на случайном порту, закрывает
 * сеть наружу, входит с Премиумом и проверяет то, что видит человек: «?»
 * раскрывает объяснение под заголовком и сворачивает его, кнопка говорит
 * экранному чтецу, что она открыта и что именно открывает, с клавиатуры всё
 * то же самое, на шестнадцати языках текст переведён (нет голых ключей),
 * ничего не вылезает за край узкого экрана, в арабском «?» стоит по ту
 * сторону заголовка, а в помощи есть словарь с теми же абзацами.
 *
 * Шрифт — IBM Plex Sans из сборки, как у людей.
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
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".woff2": "font/woff2", ".ttf": "font/ttf", ".ico": "image/x-icon",
};
const I18N = JSON.parse(await readFile(new URL("../../tools/i18n.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
const LANGS = ["ar", "de", "en", "es", "fr", "hi", "id", "ja", "ko", "pl", "pt", "ru", "tr", "uk", "vi", "zh"];
/** Текст как видит человек: неразрывные, узкие пробелы и метки направления — как обычный пробел или ничего. */
const sp = (s: string | null) => (s ?? "").replace(/[⁦-⁩‎‏]/g, "").replace(/[\s  ]+/g, " ").trim();
/** Вкладки внизу по порядку: кошельки, топ, аналитика, дайджест, ещё. */
const TAB = { top: 1, analytics: 2, more: 4 } as const;
/** Потоки бирж биткоина: без данных карточка не рисуется вовсе, а с ней и
 *  заголовок с «?». Хватает одного окна с нулевыми биржами. */
const BTC_FLOW = {
  ok: true, price: 60_000, since: 0, height: 900_000, at: 0, labels: 0,
  wins: { "24": { net: 1, in: 1, out: 2, nin: 1, nout: 1, ex: [], tr: [] } },
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

interface Opened { ctx: BrowserContext; page: Page; errors: string[] }

/** Приложение с Премиумом на нужной вкладке. Данных нет (сервер отвечает
 *  ok:false) — заголовки разделов от этого не зависят. Заставку снимаем
 *  сразу: она уходит сама за шесть секунд, тесту ждать их незачем. */
async function open(lang: string, tab: number, width = 360): Promise<Opened> {
  const ctx = await browser.newContext({ viewport: { width, height: 780 }, locale: lang === "ar" ? "ar" : "ru-RU", timezoneId: "UTC" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await ctx.route((url) => !url.href.startsWith(base), (r) => r.abort());
  await ctx.route(`${base}/api/**`, (r) => r.fulfill({ contentType: "application/json", body: '{"ok":false}' }));
  await ctx.route(`${base}/api/bootstrap`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, me: { plan: "premium" } }) }));
  await ctx.route(`${base}/api/btc/flow**`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(BTC_FLOW) }));
  await page.addInitScript((l: string) => {
    if (sessionStorage.getItem("e2e")) return;
    sessionStorage.setItem("e2e", "1");
    localStorage.clear();
    localStorage.setItem("wt-miniapp-v7", JSON.stringify({ state: { lang: l, langPinned: true }, version: 9 }));
  }, lang);
  await page.goto(`${base}/#tgWebAppData=${encodeURIComponent(`user=${encodeURIComponent('{"id":1}')}&hash=x`)}`);
  await page.evaluate(() => document.fonts.ready);
  await page.locator("nav.tabs button").nth(tab).waitFor();
  await page.evaluate(() => document.getElementById("sp")?.remove());
  await page.locator("nav.tabs button").nth(tab).click();
  return { ctx, page, errors };
}

/** Что вылезает за край экрана по горизонтали. */
function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const W = document.documentElement.clientWidth;
    if (document.scrollingElement!.scrollWidth > W + 1) out.push(`страница шире экрана: ${document.scrollingElement!.scrollWidth} > ${W}`);
    for (const el of document.querySelectorAll<HTMLElement>(".sect, .sect *, .sect-help, .sect-help *")) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.left < -0.5 || r.right > W + 0.5)) out.push(`${el.tagName}.${el.className} ${r.left.toFixed(0)}–${r.right.toFixed(0)}`);
    }
    return out.slice(0, 8);
  });
}

describe("подсказки «?»", () => {
  test("NetFlow: «?» раскрывает объяснение под заголовком и сворачивает его", async () => {
    const { ctx, page, errors } = await open("ru", TAB.analytics);
    const q = page.locator(".sect-q").first();
    await q.waitFor();
    assert.equal(await q.getAttribute("aria-label"), "Что это значит?");
    assert.equal(await q.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".sect-help").count(), 0);

    await q.click();
    assert.equal(await q.getAttribute("aria-expanded"), "true");
    const help = page.locator(".sect-help");
    assert.equal(await help.getAttribute("id"), await q.getAttribute("aria-controls"));
    assert.deepEqual((await help.locator("p").allInnerTexts()).map(sp), [I18N["q_netflow_1"]!["ru"]!, I18N["q_netflow_2"]!["ru"]!].map(sp));
    // Объяснение — сразу под своим заголовком, а не где-то внизу карточки.
    const [hd, hp] = await Promise.all([page.locator(".sect").nth(1).boundingBox(), help.boundingBox()]);
    assert.ok(hd && hp && hp.y >= hd.y + hd.height && hp.y - (hd.y + hd.height) <= 24, `${hd?.y}+${hd?.height} → ${hp?.y}`);
    // Кружок мелкий, а нажимать есть куда — не меньше 32 пикселей.
    const box = await q.boundingBox();
    assert.ok(box && box.width >= 32 && box.height >= 32, `${box?.width}×${box?.height}`);

    await q.click();
    assert.equal(await q.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".sect-help").count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("с клавиатуры: Tab до «?», Enter открывает, пробел закрывает, рамка фокуса видна", async () => {
    const { ctx, page } = await open("ru", TAB.analytics);
    const q = page.locator(".sect-q").first();
    await q.waitFor();
    // Рамка :focus-visible — только при ходьбе с клавиатуры, поэтому идём Tab'ом.
    let on = false;
    for (let i = 0; i < 40 && !on; i++) {
      await page.keyboard.press("Tab");
      on = await q.evaluate((el) => el === document.activeElement);
    }
    assert.ok(on, "Tab не дошёл до «?»");
    assert.notEqual(await q.evaluate((el) => getComputedStyle(el).outlineStyle), "none");
    await page.keyboard.press("Enter");
    assert.equal(await q.getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Space");
    assert.equal(await q.getAttribute("aria-expanded"), "false");
    await ctx.close();
  });

  test("у каждого раздела аналитики со сложным термином своя подсказка", async () => {
    const { ctx, page } = await open("ru", TAB.analytics);
    // Плитка раздела → первый абзац его подсказки. Крупные ордера понятны
    // без объяснения — подсказки там нет.
    const want: [number, string | null][] = [[0, "q_netflow_1"], [1, null], [2, "q_rot_1"], [3, "q_ls_1"], [4, "q_perp_1"], [5, "q_exflow_1"], [6, "q_exflow_1"]];
    for (const [i, key] of want) {
      await page.locator(".views button").nth(i).click();
      // У биткоина заголовок с подсказкой — карточка потоков, первая.
      const q = page.locator(".sect-q").first();
      if (!key) {
        assert.equal(await page.locator(".sect-q").count(), 0, `плитка ${i}`);
        continue;
      }
      await q.click({ timeout: 5000 }).catch((e: Error) => { throw new Error(`плитка ${i}: нет «?» (${e.message.split("\n")[0]})`); });
      assert.equal(sp(await page.locator(".sect-help p").first().innerText()), sp(I18N[key]!["ru"]!), `плитка ${i}`);
      await q.click();
    }
    await ctx.close();
  });

  test("16 языков: текст переведён, без голых ключей и без вылезания за край на 320 px", async () => {
    for (const lang of LANGS) {
      const { ctx, page, errors } = await open(lang, TAB.top, 320);
      const q = page.locator(".sect-q").first();
      await q.click();
      assert.equal(await q.getAttribute("aria-label"), I18N["q_what"]![lang]);
      const got = (await page.locator(".sect-help p").allInnerTexts()).map(sp);
      assert.deepEqual(got, ["q_top_1", "q_top_2", "q_top_3"].map((k) => sp(I18N[k]![lang]!)), lang);
      assert.ok(!got.some((s) => /\bq_[a-z_0-9]+\b/.test(s)), lang);
      assert.deepEqual(await overflow(page), [], lang);
      assert.deepEqual(errors, [], lang);
      await ctx.close();
    }
  });

  test("арабский: «?» после заголовка по ходу письма — слева от него", async () => {
    const { ctx, page } = await open("ar", TAB.top);
    const q = page.locator(".sect-q").first();
    const [h, b] = await Promise.all([page.locator(".sect h2").first().evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el.firstChild!);
      return r.getBoundingClientRect().left;
    }), q.boundingBox()]);
    assert.ok(b && b.x + b.width <= h + 1, `${b?.x}+${b?.width} > ${h}`);
    await q.click();
    assert.equal(await page.locator(".sect-help").evaluate((el) => getComputedStyle(el).direction), "rtl");
    await ctx.close();
  });
});

describe("словарь терминов в помощи", () => {
  test("есть, свёрнут, раскрывается — с теми же абзацами, что у «?»", async () => {
    const { ctx, page, errors } = await open("ru", TAB.more);
    await page.locator(".row", { hasText: I18N["menu_help"]!["ru"]!.replace(/^\P{L}+/u, "") }).first().click();
    const card = page.locator(".card", { has: page.locator("h2", { hasText: I18N["hp_terms_title"]!["ru"]! }) });
    await card.waitFor();
    assert.equal(sp(await card.locator(".note").innerText()), sp(I18N["hp_terms_note"]!["ru"]!));
    const names = (await card.locator("summary b").allInnerTexts()).map(sp);
    assert.equal(names.length, 11);
    assert.deepEqual(names.slice(0, 2), ["ETF", "NetFlow"]);
    assert.ok(names.includes(I18N["q_t_fund"]!["ru"]!) && names.includes(I18N["ui_rotation"]!["ru"]!), names.join(", "));
    assert.equal(await card.locator("details[open]").count(), 0);
    await card.locator("summary").nth(1).click();
    assert.equal(sp(await card.locator("details[open] .fold-body").innerText()),
      sp(`${I18N["q_netflow_1"]!["ru"]} ${I18N["q_netflow_2"]!["ru"]}`));
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

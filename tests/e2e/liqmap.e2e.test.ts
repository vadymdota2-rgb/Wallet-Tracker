/*
 * Карта ликвидаций в настоящем браузере: npm run test:e2e.
 *
 * Тест поднимает собранное приложение (html/) на случайном порту, подменяет
 * ответ сервера образцом (tests/fixtures/liqmap.json — сборка wt_liqmap из
 * выдуманного рынка, tools/liqmap-fixture.py), закрывает сеть наружу и
 * проверяет то, что видит человек: подписи сумм не налезают друг на друга,
 * легенда — четыре группы плеч, крупнейшие уровни — разные места, а не одно
 * трижды; «собираем» на сервере — экран ждёт сам, без ошибки; сбой — кнопка
 * «Повторить»; 16 языков, ширины 320–1280, экраны ×1/×2/×3, шрифт 200 %.
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
  ".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".ttf": "font/ttf", ".ico": "image/x-icon",
};

interface Map { ok: true; sym: string; px: number; seen: number; ex: string[]; levs: number[]; buckets: { p: number; L: number[]; S: number[] }[] }
const FIX = JSON.parse(await readFile(new URL("../fixtures/liqmap.json", import.meta.url), "utf8")) as Record<"1d" | "7d" | "30d" | "90d" | "180d" | "365d", Map> & { now: number };
const T = FIX.now;
const I18N = JSON.parse(await readFile(new URL("../../tools/i18n.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
const LANGS = ["ar", "de", "en", "es", "fr", "hi", "id", "ja", "ko", "pl", "pt", "ru", "tr", "uk", "vi", "zh"];
const LEV_NAME = ["3–10×", "20–25×", "50×", "75–100×", "125–500×"];
const sp = (s: string | null) => (s ?? "").replace(/[⁦-⁩]/g, "").replace(/[\s  ]+/g, " ").trim();

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

interface Opts {
  lang?: string;
  width?: number;
  height?: number;
  scale?: number;
  /** Ответы /api/liqmap по очереди (последний — дальше всегда); по умолчанию — образец окна. */
  replies?: unknown[];
}
interface Opened { ctx: BrowserContext; page: Page; errors: string[]; asked: string[] }

async function open(o: Opts = {}): Promise<Opened> {
  const lang = o.lang ?? "ru";
  const ctx = await browser.newContext({
    viewport: { width: o.width ?? 360, height: o.height ?? 780 }, deviceScaleFactor: o.scale ?? 1,
    locale: lang === "ar" ? "ar" : "ru-RU", timezoneId: "UTC",
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.clock.setFixedTime(T * 1000 + 30_000);
  await ctx.route((url) => !url.href.startsWith(base), (r) => r.abort());
  await ctx.route(`${base}/api/**`, (r) => r.fulfill({ contentType: "application/json", body: '{"ok":false}' }));
  await ctx.route(`${base}/api/bootstrap`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, me: { plan: "premium" } }) }));
  await ctx.route(`${base}/api/liqcoins**`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, coins: [{ s: "BTC", v: 1e10, ex: [] }, { s: "ETH", v: 5e9, ex: [] }] }) }));
  const asked: string[] = [];
  await ctx.route(`${base}/api/liqmap**`, async (r) => {
    const rng = (new URL(r.request().url()).searchParams.get("range") ?? "1d") as keyof typeof FIX & string;
    const body = o.replies ? o.replies[Math.min(asked.length, o.replies.length - 1)] : FIX[rng];
    asked.push(rng);
    await r.fulfill({ contentType: "application/json", body: typeof body === "string" ? body : JSON.stringify(body) });
  });
  await page.addInitScript((l: string) => {
    if (sessionStorage.getItem("e2e")) return;
    sessionStorage.setItem("e2e", "1");
    localStorage.clear();
    localStorage.setItem("wt-miniapp-v7", JSON.stringify({ state: { lang: l, langPinned: true }, version: 9 }));
  }, lang);
  await page.goto(`${base}/#tgWebAppData=${encodeURIComponent(`user=${encodeURIComponent('{"id":1}')}&hash=x`)}`);
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".burger").click();
  await page.locator(".drawer-row", { hasText: I18N["lq_title"]![lang]! }).evaluate((el: HTMLElement) => el.click());
  return { ctx, page, errors, asked };
}

const ready = (page: Page) => page.locator(".lq-hero").waitFor({ timeout: 15_000 });

/** Ничего не вылезает за край экрана (переключатели и чипы листаются сами). */
function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const W = document.documentElement.clientWidth;
    if (document.scrollingElement!.scrollWidth > W + 1) out.push(`страница шире экрана: ${document.scrollingElement!.scrollWidth} > ${W}`);
    for (const el of document.querySelectorAll<HTMLElement>(".sheet *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || el.closest(".chips, .seg, svg")) continue;
      if (r.left < -0.5 || r.right > W + 0.5) out.push(`${el.tagName}.${el.className} «${(el.textContent ?? "").slice(0, 40)}» ${r.left.toFixed(0)}–${r.right.toFixed(0)}`);
    }
    return out.slice(0, 8);
  });
}

/** Подписи сумм на полосах, что налезают друг на друга. */
function clashes(page: Page): Promise<string[]> {
  return page.locator(".lq-svg text.lq-val").evaluateAll((els) => {
    const boxes = els.map((el) => ({ t: el.textContent, b: el.getBoundingClientRect() }));
    const out: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!.b, b = boxes[j]!.b;
        if (a.left < b.right && b.left < a.right && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) out.push(`${boxes[i]!.t} × ${boxes[j]!.t}`);
      }
    }
    return out;
  });
}

/** «+1,23 %» → 1.23 (минус — и дефисом, и знаком U+2212). */
const pctOf = (s: string) => Number(sp(s).replace(/[−–]/g, "-").replace(",", ".").replace(/[^0-9.+-]/g, ""));

describe("Карта ликвидаций", () => {
  test("монета, легенда из пяти групп плеч, источники и подписи без наложений", async () => {
    const { ctx, page, errors, asked } = await open();
    await ready(page);
    assert.equal(sp(await page.locator(".lq-hero-n b").innerText()), "BTC");
    assert.deepEqual(asked, ["1d"]);
    const legend = (await page.locator(".lq-legend button").allInnerTexts()).map(sp);
    assert.deepEqual(legend, LEV_NAME);
    assert.ok(sp(await page.locator(".lq-src").innerText()).includes("Alpha, Beta, Gamma"));
    assert.ok(await page.locator(".lq-svg .lq-row").count() > 10);
    const vals = await page.locator(".lq-svg text.lq-val").count();
    assert.ok(vals >= 1 && vals <= 4, String(vals));
    assert.deepEqual(await clashes(page), []);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("крупнейшие уровни — разные места: не в одной и не в соседних полосах по 0,5 %, по своей стороне цены", async () => {
    for (const rng of ["1d", "7d", "30d", "90d", "180d", "365d"] as const) {
      const { ctx, page, errors } = await open({ replies: [FIX[rng]] });
      await ready(page);
      for (const [k, sign] of [["up", 1], ["dn", -1]] as const) {
        const ps = (await page.locator(`.lq-top-c.${k} button small`).allInnerTexts()).map(pctOf);
        assert.ok(ps.length >= 1 && ps.length <= 3, `${rng} ${k}: ${ps}`);
        for (const p of ps) assert.ok(p * sign > 0, `${rng} ${k}: ${p}`);
        for (let i = 0; i < ps.length; i++) {
          for (let j = i + 1; j < ps.length; j++) assert.ok(Math.abs(ps[i]! - ps[j]!) >= 0.5, `${rng} ${k}: ${ps}`);
        }
      }
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  });

  test("легенда: группа плеча выключается и включается, последнюю выключить нельзя", async () => {
    const { ctx, page, errors } = await open();
    await ready(page);
    const btn = page.locator(".lq-legend button");
    for (let j = 0; j < 4; j++) await btn.nth(j).click();
    assert.deepEqual(await btn.evaluateAll((els) => els.map((el) => el.getAttribute("aria-pressed"))), ["false", "false", "false", "false", "true"]);
    await btn.nth(4).click();
    assert.equal(await btn.nth(4).getAttribute("aria-pressed"), "true");
    assert.deepEqual(await clashes(page), []);
    await btn.nth(0).click();
    assert.equal(await btn.nth(0).getAttribute("aria-pressed"), "true");
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("шесть окон — от суток до года: свой запрос, своя карта, кнопки в одну строку на 320 px", async () => {
    const wins = [["7d", "big_win_7d"], ["30d", "big_win_30d"], ["90d", "lq_win_90d"], ["180d", "lq_win_180d"],
      ["365d", "lq_win_365d"], ["1d", "big_win_24h"]] as const;
    const { ctx, page, errors, asked } = await open({ width: 320 });
    await ready(page);
    const seg = page.locator(".lq-ctl .seg button");
    assert.equal(await seg.count(), 6);
    const tops = await seg.evaluateAll((els) => [...new Set(els.map((el) => Math.round(el.getBoundingClientRect().top)))]);
    assert.equal(tops.length, 1, String(tops));
    for (const [rng, key] of wins) {
      await page.locator(".lq-ctl .seg button", { hasText: I18N[key]!["ru"]! }).click();
      await page.waitForFunction((n) => document.querySelectorAll(".lq-svg .lq-row").length > 0 && n, asked.length);
      await page.waitForTimeout(250);
      assert.ok(asked.includes(rng), `${rng}: ${asked}`);
      assert.equal(sp(await page.locator(".lq-hero-p b").innerText()).replace(/[^0-9]/g, ""), String(Math.round(FIX[rng].px)));
      assert.deepEqual(await clashes(page), [], rng);
      assert.deepEqual(await overflow(page), [], rng);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("сколько интереса видит модель — подписано", async () => {
    const { ctx, page, errors } = await open();
    await ready(page);
    const seen = sp(await page.locator(".lq-seen").innerText());
    assert.ok(seen.startsWith(sp(I18N["lq_seen"]!["ru"]!.split("{a}")[0]!)), seen);
    assert.match(seen, /\$[0-9]/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("сервер ещё собирает карту — экран ждёт и переспрашивает сам, без ошибки", async () => {
    const building = { ok: false, error: "building" };
    const { ctx, page, errors, asked } = await open({ replies: [building, building, building, FIX["1d"]] });
    await ready(page);
    assert.equal(await page.locator(".lq-retry").count(), 0);
    assert.ok(asked.length >= 4, String(asked.length));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("сбой сервера — «Повторить»; монеты нет на биржах — так и сказано", async () => {
    let o = await open({ replies: ["<html>502</html>"] });
    await o.page.locator(".lq-retry").waitFor({ timeout: 15_000 });
    assert.equal(sp(await o.page.locator(".lq-retry").innerText()), I18N["ui_retry"]!["ru"]);
    assert.deepEqual(o.errors, []);
    await o.ctx.close();
    o = await open({ replies: [{ ok: false, error: "no_data" }] });
    await o.page.getByText(sp(I18N["lq_no_data"]!["ru"]!.replace("{s}", "BTC")).slice(0, 12)).first().waitFor({ timeout: 15_000 });
    assert.equal(await o.page.locator(".lq-retry").count(), 0);
    await o.ctx.close();
  });

  test("16 языков на 320 px, ширины 360–1280 — без вылезаний, наложений и ошибок", async () => {
    for (const lang of LANGS) {
      const { ctx, page, errors } = await open({ lang, width: 320 });
      await ready(page);
      assert.deepEqual(await overflow(page), [], lang);
      assert.deepEqual(await clashes(page), [], lang);
      assert.equal(sp(await page.locator(".lq-legend-t").innerText()), sp(I18N["lq_lev"]![lang]!), lang);
      assert.ok(sp(await page.locator(".lq-src").innerText()).includes("Alpha, Beta, Gamma"), lang);
      assert.deepEqual(errors, [], lang);
      await ctx.close();
    }
    for (const width of [360, 414, 768, 1280]) {
      const { ctx, page, errors } = await open({ width, height: width > 800 ? 900 : 780 });
      await ready(page);
      assert.deepEqual(await overflow(page), [], String(width));
      assert.deepEqual(await clashes(page), [], String(width));
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  });

  test("экраны ×1, ×2, ×3: подписи не налезают, ничего не вылезает", async () => {
    for (const scale of [1, 2, 3]) {
      const { ctx, page, errors } = await open({ width: 360, scale });
      await ready(page);
      assert.equal(await page.evaluate(() => devicePixelRatio), scale);
      assert.deepEqual(await clashes(page), [], `×${scale}`);
      assert.deepEqual(await overflow(page), [], `×${scale}`);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  });

  test("крупный шрифт (200 %): текст вне графика переносится, а не вылезает", async () => {
    const { ctx, page, errors } = await open({ width: 360 });
    await ready(page);
    await page.evaluate(() => {
      const els = [...document.querySelectorAll<HTMLElement>(".sheet *")].filter((el) => !el.closest("svg"));
      const px = els.map((el) => parseFloat(getComputedStyle(el).fontSize) * 2);
      els.forEach((el, i) => { el.style.fontSize = `${px[i]}px`; });
    });
    await page.waitForTimeout(100);
    assert.deepEqual(await overflow(page), []);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

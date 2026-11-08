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

interface Opts {
  lang?: string; width?: number; height?: number; reply?: unknown; scale?: number;
  /** Высокая контрастность Windows (forced-colors). */
  forced?: boolean;
  /** Ответы по очереди (последний — дальше всегда); задержка первого ответа, мс. */
  replies?: unknown[]; delay?: number;
  /** Копия на устройстве (wt-markets-v1): когда записана (мс) и что. */
  saved?: { at: number; v: unknown };
}

async function open(o: Opts = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const lang = o.lang ?? "ru";
  const ctx = await browser.newContext({ viewport: { width: o.width ?? 360, height: o.height ?? 780 }, deviceScaleFactor: o.scale ?? 1, timezoneId: "UTC",
    forcedColors: o.forced ? "active" : "none" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.clock.setFixedTime(T * 1000);
  await ctx.route((url) => !url.href.startsWith(base), (r) => r.abort());
  await ctx.route(`${base}/api/**`, (r) => r.fulfill({ contentType: "application/json", body: '{"ok":false}' }));
  await ctx.route(`${base}/api/bootstrap`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, me: { plan: "premium" } }) }));
  let n = 0;
  await ctx.route(`${base}/api/markets`, async (r) => {
    const body = o.replies ? o.replies[Math.min(n++, o.replies.length - 1)] : (o.reply ?? MARKETS);
    if (o.delay && n <= 1) await new Promise((ok) => setTimeout(ok, o.delay));
    await r.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.addInitScript((a: { lang: string; saved: string }) => {
    if (window !== window.top) return;
    if (sessionStorage.getItem("e2e")) return;
    sessionStorage.setItem("e2e", "1");
    localStorage.clear();
    localStorage.setItem("wt-miniapp-v7", JSON.stringify({ state: { lang: a.lang, langPinned: true }, version: 9 }));
    if (a.saved) localStorage.setItem("wt-markets-v1", a.saved);
  }, { lang, saved: o.saved ? JSON.stringify({ all: o.saved }) : "" });
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
  assert.equal(sp(await page.locator(".mk-src").textContent()), I18N["mk_src"]!["ru"]);
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

const LANGS = ["ru", "en", "uk", "de", "es", "fr", "pt", "pl", "tr", "id", "vi", "hi", "ar", "ja", "ko", "zh"];

/** Что не влезло: цифры и изменения обрезаны, сетка шире меню, текст — за краем экрана. */
function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(".mk-px, .mk-ch")) {
      if (el.scrollWidth > el.clientWidth + 1) out.push(`обрезано «${el.textContent}»`);
    }
    const drawer = document.querySelector(".drawer")!.getBoundingClientRect();
    const grid = document.querySelector(".mk-grid")!.getBoundingClientRect();
    if (grid.left < drawer.left - 1 || grid.right > drawer.right + 1) out.push("сетка шире меню");
    for (const el of document.querySelectorAll<HTMLElement>(".mk *")) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.left < -1 || r.right > innerWidth + 1)) out.push(`за краем: ${el.className}`);
    }
    return out;
  });
}

test("влезает в 320 точек на всех 16 языках", async () => {
  for (const lang of LANGS) {
    const { ctx, page, errors } = await open({ lang, width: 320 });
    await page.locator(".drawer .mk-cell").first().waitFor();
    assert.deepEqual(await overflow(page), [], lang);
    assert.equal(await page.locator(".drawer .mk-cell").count(), 9, lang);
    const xs = await page.locator(".drawer .mk-cell").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().x)));
    assert.equal(new Set(xs).size, 3, `${lang}: обычный шрифт — три столбца, ${xs}`);
    assert.deepEqual(errors, [], lang);
    await ctx.close();
  }
});

test("любое устройство: от 280 точек (Galaxy Fold снаружи) до планшета и компьютера, плотность 1–3 — ничего не обрезано, «ⓘ» — чёткий рисунок", async () => {
  const devices = [
    { name: "Galaxy Fold снаружи", width: 280, height: 653, scale: 3 },
    { name: "iPhone SE", width: 320, height: 568, scale: 2 },
    { name: "Android", width: 360, height: 800, scale: 3 },
    { name: "iPhone Pro Max", width: 430, height: 932, scale: 3 },
    { name: "телефон лёжа", width: 740, height: 360, scale: 3 },
    { name: "планшет", width: 820, height: 1180, scale: 2 },
    { name: "компьютер", width: 1440, height: 900, scale: 1 },
  ];
  for (const d of devices) {
    const { ctx, page, errors } = await open(d);
    await page.locator(".drawer .mk-cell").first().waitFor();
    assert.deepEqual(await overflow(page), [], d.name);
    assert.equal(await page.locator(".drawer .mk-cell").count(), 9, d.name);
    // Значок «ⓘ» — рисунок с размером, а не знак шрифта (его нет в части шрифтов).
    const ico = await page.locator(".mk-i svg").boundingBox();
    assert.ok(ico && ico.width >= 10 && ico.height >= 10, `${d.name}: ${JSON.stringify(ico)}`);
    assert.ok(!(await page.locator(".mk-i").textContent())?.trim(), d.name);
    // Место под палец у «ⓘ» — не меньше 24 точек (WCAG 2.2, 2.5.8).
    const btn = await page.locator(".mk-i").boundingBox();
    assert.ok(btn && btn.width >= 24 && btn.height >= 24, `${d.name}: ${JSON.stringify(btn)}`);
    assert.deepEqual(errors, [], d.name);
    await ctx.close();
  }
});

test("пункта нет в ответе — ячейка на своём месте: «—» и «нет данных» для чтения с экрана, сетка не сдвигается", async () => {
  const at = async (reply: unknown) => {
    const { ctx, page, errors } = await open({ reply, width: 320 });
    await page.locator(".drawer .mk-cell").first().waitFor();
    // От начала сетки: меню ещё может выезжать.
    const pos = await page.locator(".drawer .mk-cell").evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      const g = el.parentElement!.getBoundingClientRect();
      return `${(el as HTMLElement).dataset["k"]}:${Math.round(r.x - g.x)},${Math.round(r.y - g.y)},${Math.round(r.width)}x${Math.round(r.height)}`;
    }));
    return { ctx, page, errors, pos };
  };
  const full = await at(MARKETS);
  await full.ctx.close();
  const part = await at({ ...MARKETS, items: MARKETS.items.filter((x) => x.k !== "DXY" && x.k !== "BVIV") });
  assert.deepEqual(part.pos, full.pos);
  assert.equal(await part.page.locator(".mk-empty").count(), 2);
  const dxy = part.page.locator('.mk-cell[data-k="DXY"]');
  assert.equal(sp(await dxy.locator(".mk-k").textContent()), "DXY");
  assert.equal(await dxy.locator('.mk-px [aria-hidden="true"]').textContent(), "—");
  assert.equal(await dxy.locator(".mk-sr").textContent(), I18N["mk_none"]!["ru"]);
  // «нет данных» не видно глазом, но и не обрезает ячейку.
  const sr = await dxy.locator(".mk-sr").boundingBox();
  assert.ok(sr && sr.width <= 1 && sr.height <= 1, JSON.stringify(sr));
  assert.deepEqual(await overflow(part.page), []);
  assert.equal(await dxy.locator("button, .mk-bar").count(), 0);
  // Пояснения «ⓘ» — только у показанных пунктов.
  await part.page.locator(".mk-i").click();
  const notes = (await part.page.locator(".mk-notes li").allTextContents()).map(sp);
  assert.ok(!notes.includes(sp(I18N["mk_dxy_hint"]!["ru"]!)));
  assert.deepEqual(part.errors, []);
  await part.ctx.close();
});

test("высокая контрастность Windows: полоска и рамки — цветом системы, а не пропадают", async () => {
  const { ctx, page, errors } = await open({ forced: true });
  await page.locator(".drawer .mk-cell").first().waitFor();
  const bar = await page.locator('.mk-cell[data-k="BVIV"] .mk-bar').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, op: cs.opacity, w: el.getBoundingClientRect().width };
  });
  assert.notEqual(bar.bg, "rgba(0, 0, 0, 0)");
  assert.equal(bar.op, "1");
  assert.ok(bar.w > 10, JSON.stringify(bar));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("арабский: сетка справа налево, цифры и знаки — как у всех", async () => {
  const { ctx, page } = await open({ lang: "ar" });
  const cells = page.locator(".drawer .mk-cell");
  await cells.first().waitFor();
  const xs = await cells.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().x)));
  assert.ok(xs[0]! > xs[1]! && xs[1]! > xs[2]!, String(xs)); // S&P 500 — справа
  assert.match(sp(await page.locator('.mk-cell[data-k="SP500"] .mk-ch').textContent()), /^[−+]?\d/);
  assert.deepEqual(await overflow(page), []);
  await ctx.close();
});

test("крупный системный шрифт (до 200 %, как Android на максимуме): цифры не обрезаны", async () => {
  for (const z of [1.3, 1.6, 2]) {
    const { ctx, page } = await open({ width: 360 });
    await page.locator(".drawer .mk-cell").first().waitFor();
    await page.evaluate((k) => {
      const els = [...document.querySelectorAll<HTMLElement>(".mk, .mk *")];
      const px = els.map((el) => parseFloat(getComputedStyle(el).fontSize) * k);
      els.forEach((el, i) => { el.style.fontSize = `${px[i]}px`; });
    }, z);
    await page.waitForTimeout(100);
    assert.deepEqual(await overflow(page), [], String(z));
    await ctx.close();
  }
});

test("текст читается: контраст не ниже 4,5:1 (WCAG AA) с учётом приглушения", async () => {
  const { ctx, page } = await open();
  await page.locator(".drawer .mk-cell").first().waitFor();
  await page.locator('.mk-cell[data-k="BVIV"]').click(); // и пояснение под сеткой
  const low = await page.evaluate(() => {
    const rgba = (s: string) => (s.match(/[\d.]+/g) ?? ["0", "0", "0", "0"]).map(Number) as number[];
    const lum = (c: number[]) => {
      const f = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
    };
    const over = (top: number[], a: number, bottom: number[]) => top.slice(0, 3).map((v, i) => v * a + bottom[i]! * (1 - a));
    // Фон под текстом: верх меню — самый светлый цвет его градиента (--panel),
    // поверх — полупрозрачная заливка ячейки.
    const hex = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim();
    const drawer = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(".mk-k, .mk-px, .mk-ch, .mk-src, .mk-ttl, .mk-age, .mk-note")) {
      let bg = drawer.slice(0, 3);
      // Блик ячейки сверху — самое светлое место её градиента (белый 3,5 %).
      const cell = el.closest(".mk-cell, .mk-note");
      if (cell) {
        if (cell.classList.contains("mk-cell")) bg = over([255, 255, 255], 0.035, bg);
        const c = rgba(getComputedStyle(cell).backgroundColor);
        bg = over(c, c[3] ?? 1, bg);
      }
      let a = 1;
      for (let e: HTMLElement | null = el; e && !e.classList.contains("drawer"); e = e.parentElement) a *= Number(getComputedStyle(e).opacity);
      const fg = rgba(getComputedStyle(el).color);
      const shown = over(fg, a * (fg[3] ?? 1), bg);
      const l1 = lum(shown);
      const l2 = lum(bg);
      const k = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      if (k < 4.5) out.push(`${el.className} «${(el.textContent ?? "").slice(0, 16)}» ${k.toFixed(2)}`);
    }
    return out;
  });
  assert.deepEqual(low, []);
  await ctx.close();
});

test("касание ячейки — её пояснение; ещё раз — свернуть; у DXY своё, у золота и BTC.D нет кнопки", async () => {
  const { ctx, page, errors } = await open();
  await page.locator(".drawer .mk-cell").first().waitFor();
  assert.equal(await page.locator(".mk-note").count(), 0);
  const bviv = page.locator('.mk-cell[data-k="BVIV"]');
  assert.equal(await bviv.evaluate((el) => el.tagName), "BUTTON");
  await bviv.click();
  assert.equal(await bviv.getAttribute("aria-expanded"), "true");
  assert.equal(sp(await page.locator(".mk-note").textContent()), sp(I18N["mk_bviv_hint"]!["ru"]!));
  await page.locator('.mk-cell[data-k="DXY"]').click();
  assert.equal(await bviv.getAttribute("aria-expanded"), "false");
  assert.equal(sp(await page.locator(".mk-note").textContent()), sp(I18N["mk_dxy_hint"]!["ru"]!));
  await page.locator('.mk-cell[data-k="DXY"]').click();
  assert.equal(await page.locator(".mk-note").count(), 0);
  // Без пояснения (золото, BTC.D) — не кнопка: касание ничего не обещает.
  for (const k of ["GOLD", "BTCD"]) assert.equal(await page.locator(`.mk-cell[data-k="${k}"]`).evaluate((el) => el.tagName), "DIV");
  // «ⓘ» — все пояснения; выбранная ячейка тогда не дублирует своё.
  await bviv.click();
  await page.locator(".mk-i").click();
  assert.equal(await page.locator(".mk-note").count(), 0);
  assert.equal(await page.locator(".mk-notes li").count(), 7);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("полоска — величина изменения: больше изменение — длиннее, ноль — без полоски, цвет — направление", async () => {
  const flat = { ...MARKETS, items: MARKETS.items.map((x) => (x.k === "GOLD" ? { ...x, prev: x.px } : x)) };
  const { ctx, page } = await open({ reply: flat });
  await page.locator(".drawer .mk-cell").first().waitFor();
  const w = (k: string) => page.locator(`.mk-cell[data-k="${k}"] .mk-bar`).evaluate((el) => el.getBoundingClientRect().width);
  assert.ok((await w("BVIV")) > (await w("OIL")) && (await w("OIL")) > (await w("SP500")), "BVIV 3,41 % > нефть 0,66 % > S&P 0,27 %");
  assert.equal(await w("GOLD"), 0);
  assert.equal(await page.locator('.mk-cell[data-k="USDTD"] .mk-bar.dn').count(), 1);
  assert.equal(await page.locator('.mk-cell[data-k="BVIV"] .mk-bar.up').count(), 1);
  // Полная полоска — не шире ячейки.
  const cell = await page.locator('.mk-cell[data-k="BVIV"]').evaluate((el) => el.getBoundingClientRect().width);
  assert.ok((await w("BVIV")) <= cell - 14 + 0.5);
  await ctx.close();
});

test("заголовок: «сейчас», через 20 минут — «20 мин назад» жёлтым", async () => {
  for (const [at, txt, old] of [[T - 20, I18N["mk_now"]!["ru"]!, false], [T - 20 * 60, "20 мин назад", true]] as const) {
    const { ctx, page } = await open({ reply: { ...MARKETS, at } });
    await page.locator(".drawer .mk-cell").first().waitFor();
    assert.equal(sp(await page.locator(".mk-ttl").textContent()), I18N["mk_title"]!["ru"]);
    assert.equal(sp(await page.locator(".mk-age").textContent()), txt);
    assert.equal(await page.locator(".mk-age.old").count(), old ? 1 : 0);
    await ctx.close();
  }
});

test("копия на устройстве: меню сразу с ней (без скелета), свежая — поверх; ответ сохраняется", async () => {
  const old = { ...MARKETS, at: T - 40 * 60, items: MARKETS.items.map((x) => (x.k === "SP500" ? { ...x, px: 7000 } : x)) };
  const { ctx, page } = await open({ saved: { at: T * 1000 - 40 * 60_000, v: old }, delay: 1500 });
  await page.locator(".drawer .mk-cell").first().waitFor();
  assert.equal(await page.locator(".mk-skel").count(), 0);
  assert.match(sp(await page.locator('.mk-cell[data-k="SP500"] .mk-px').textContent()), /^7 000$/);
  assert.equal(sp(await page.locator(".mk-age").textContent()), "40 мин назад");
  assert.equal(await page.locator(".mk-age.old").count(), 1);
  await page.locator('.mk-cell[data-k="SP500"] .mk-px', { hasText: "7 373" }).waitFor();
  assert.equal(sp(await page.locator(".mk-age").textContent()), I18N["mk_now"]!["ru"]);
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("wt-markets-v1") ?? "null"));
  assert.equal(kept?.all?.v?.at, MARKETS.at);
  await ctx.close();
});

test("копия старше шести часов не показывается и стирается; битая — тоже", async () => {
  for (const saved of [{ at: T * 1000 - 7 * 3_600_000, v: { ...MARKETS, at: T - 7 * 3_600 } },
    { at: T * 1000 - 60_000, v: { ...MARKETS, at: T - 7 * 3_600 } }, { at: T * 1000, v: "мусор" }]) {
    const { ctx, page } = await open({ saved, delay: 1500 });
    await page.locator(".drawer .mk-skel").waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("wt-markets-v1")), null);
    await ctx.close();
  }
});

test("через два часа — «2 ч назад»", async () => {
  const { ctx, page } = await open({ reply: { ...MARKETS, at: T - 2 * 3_600 - 120 } });
  await page.locator(".drawer .mk-cell").first().waitFor();
  assert.equal(sp(await page.locator(".mk-age").textContent()), "2 ч назад");
  await ctx.close();
});

test("пока ответа нет — скелет сетки, не прыжок заголовка; пришёл — цифры", async () => {
  const { ctx, page, errors } = await open({ delay: 1500 });
  await page.locator(".drawer .mk-skel").waitFor();
  assert.equal(await page.locator(".drawer .mk-skel .mk-cell").count(), 9);
  assert.equal(await page.locator(".drawer .drawer-ttl").count(), 0);
  const skel = await page.locator(".mk-skel .mk-grid").boundingBox();
  await page.locator(".drawer .mk-px").first().waitFor();
  assert.equal(await page.locator(".mk-skel").count(), 0);
  const grid = await page.locator(".mk-grid").boundingBox();
  assert.ok(skel && grid && Math.abs(skel.y - grid.y) <= 1, "сетка на месте скелета");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("обновление: изменившаяся цена коротко вспыхивает своим цветом; вернулись в приложение — свежие, если прошла минута", async () => {
  const next = { ...MARKETS, items: MARKETS.items.map((x) => (x.k === "SP500" ? { ...x, px: 7400 } : x.k === "GOLD" ? { ...x, px: 4000 } : x)) };
  const { ctx, page } = await open({ replies: [MARKETS, next] });
  await page.locator(".drawer .mk-cell").first().waitFor();
  // Вернулись быстрее минуты — ответ из памяти, сеть не трогаем.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(300);
  assert.match(sp(await page.locator('.mk-cell[data-k="SP500"] .mk-px').textContent()), /^7 373$/);
  // Прошла минута — сразу свежий ответ.
  await page.clock.setFixedTime((T + 61) * 1000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.locator('.mk-cell[data-k="SP500"].mk-flash-up').waitFor();
  assert.equal(await page.locator('.mk-cell[data-k="GOLD"].mk-flash-dn').count(), 1);
  assert.equal(await page.locator('.mk-cell[data-k="DXY"][class*="mk-flash"]').count(), 0);
  assert.match(sp(await page.locator('.mk-cell[data-k="SP500"] .mk-px').textContent()), /^7 400$/);
  await ctx.close();
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
  const pick = process.env["MK_PICK"];
  if (pick) await page.locator(`.mk-cell[data-k="${pick}"]`).click();
  await page.waitForTimeout(800); // меню выезжает с анимацией
  await page.screenshot({ path: shot });
  await ctx.close();
});

/*
 * Экран кошелька Hyperliquid «как у терминалов» (WalletDash) — в браузере:
 * счёт с кольцами, направление, результат сделок с кривой (касание —
 * значение дня), подробные позиции; 320 точек, арабский, кошелёк без счёта
 * Hyperliquid — прежний вид. Новых запросов к Hyperliquid экран не делает —
 * всё приходит одним /api/wallet.
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
const T = 1_794_300_000;
const DAY = 86_400;
const sp = (s: string | null | undefined) => (s ?? "").replace(/[\s\u00a0\u202f]+/g, " ").trim();
const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const W = (addr: string, name: string) => ({
  id: name, name, addr, short: addr.slice(0, 6), primary: addr === A, score: 0, bal: 0, trades: 0, win: 0, pf: 0, net: 0,
  dd: 0, spot: "", perp: "", d1: 0, equity: { total: 0, spot: 0, perp: 0, hip3: 0, vaults: 0 }, pos: [], hlActive: addr === A,
});
const curve = (days: number, vals: number[]) => vals.map((v, i) => [T - days * DAY + i * DAY, v]);
const W7 = { pnl: 346523.97, trades: 154, wins: 98, win: 63.6, pf: 1.84, avg_w: 8200, avg_l: -6100, best: 120400, worst: -98000,
  dd: 412000, pts: curve(7, [0, 180000, 260000, -120000, -410000, -380000, -200000, 346523.97]) };
const W30 = { ...W7, pnl: 1250000, trades: 610, pts: curve(30, Array.from({ length: 31 }, (_, i) => i * 41000 - (i % 5) * 30000)) };
export const LIVE = {
  ok: true, addr: A, bal: 20580262.69, d1: 0, holds: [],
  equity: { total: 20580262.69, spot: 0, perp: 20580262.69, hip3: 0, vaults: 0 },
  acct: { equity: 20580262.69, margin: 7427474.45, free: 10924545.9, ntl: 96557167.81, maint: 1203000.5 },
  pos: [
    { sym: "BTC", long: false, lev: 13, size: 96557167.81, entry: 75355.3, now: 74783, margin: 7427474.45, liq: 89623.8,
      pnl: 715638.53, pct: 9.64, funding: 561645.75, isolated: false },
    { sym: "ETH", long: true, lev: 10, size: 6200, entry: 3000, now: 3100, margin: 620, liq: 0, pnl: 200, pct: 32.3,
      funding: -3.5, isolated: true },
  ],
  perf: { "7": W7, "30": W30 },
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

interface Opts { lang?: string; width?: number; live?: unknown; wallet?: string }

async function open(o: Opts = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[]; asked: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: o.width ?? 360, height: 1400 }, timezoneId: "UTC" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const asked: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.clock.setFixedTime(T * 1000);
  await ctx.route((url) => !url.href.startsWith(base), (r) => { asked.push(r.request().url()); return r.abort(); });
  await ctx.route(`${base}/api/**`, (r) => r.fulfill({ contentType: "application/json", body: '{"ok":false}' }));
  await ctx.route(`${base}/api/bootstrap`, (r) => r.fulfill({ contentType: "application/json",
    body: JSON.stringify({ ok: true, live: true, me: { plan: "premium" }, wallets: [W(A, "Кит"), W(B, "BSC")] }) }));
  await ctx.route(`${base}/api/wallet?**`, (r) => r.fulfill({ contentType: "application/json",
    body: JSON.stringify(r.request().url().includes(B) ? { ok: true, addr: B, pos: [], holds: [], bal: 5, d1: 0 } : (o.live ?? LIVE)) }));
  await page.addInitScript((lang: string) => {
    if (window !== window.top || sessionStorage.getItem("e2e")) return;
    sessionStorage.setItem("e2e", "1");
    localStorage.clear();
    localStorage.setItem("wt-miniapp-v7", JSON.stringify({ state: { lang, langPinned: true }, version: 9 }));
  }, o.lang ?? "ru");
  await page.goto(`${base}/#tgWebAppData=${encodeURIComponent(`user=${encodeURIComponent('{"id":1}')}&hash=x`)}`);
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: "#sp{display:none!important}" });
  await page.locator(".tabs button").first().click();
  await page.getByText(o.wallet ?? "Кит", { exact: true }).first().click();
  return { ctx, page, errors, asked };
}

/** Что не влезло: за краем экрана или обрезано. */
function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("[class^='wd-'] *, [class*=' wd-'] *")) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.left < -1 || r.right > innerWidth + 1)) out.push(`за краем: ${el.className || el.tagName} «${(el.textContent ?? "").slice(0, 20)}»`);
    }
    for (const el of document.querySelectorAll<HTMLElement>(".wd-pg b, .wd-meter b, .wd-pnl b")) {
      if (el.scrollWidth > el.clientWidth + 1) out.push(`обрезано «${el.textContent}»`);
    }
    return out;
  });
}

test("счёт: капитал, свободно и маржа кольцами, объём позиций и плечо счёта", async () => {
  const { ctx, page, errors, asked } = await open();
  await page.locator(".wd-meter").first().waitFor();
  assert.equal(sp(await page.locator(".wd-equity").textContent()), "$20 580 262,69");
  const meters = (await page.locator(".wd-meter").evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText))).map(sp);
  assert.match(meters[0]!, /^Свободно \$10,92M 53%$/);
  assert.match(meters[1]!, /^Маржа в работе \$7,43M 36%$/);
  assert.equal(await page.locator(".wd-ring").count(), 2);
  const tiles = (await page.locator(".card").filter({ has: page.locator(".wd-meters") }).locator(".tile").evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText))).map(sp);
  assert.deepEqual(tiles, ["Объём позиций $96,56M", "Плечо счёта 4,69×"]);
  // К Hyperliquid приложение само не ходит — всё приходит одним /api/wallet.
  assert.deepEqual(asked.filter((u) => /hyperliquid/i.test(u)), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("направление: перевес в шорт, лонги и шорты полосами, PnL, ROE и фандинг", async () => {
  const { ctx, page, errors } = await open();
  await page.locator(".wd-exp").waitFor();
  assert.equal(sp(await page.locator(".wd-bias").textContent()), "Перевес в шорт");
  const w = await page.locator(".wd-track > span").evaluateAll((els) => els.map((el) => (el as HTMLElement).style.inlineSize));
  assert.equal(w.length, 2);
  assert.ok(parseFloat(w[1]!) > 99.9 && parseFloat(w[0]!) < 0.1, String(w));
  const tiles = (await page.locator(".card").filter({ has: page.locator(".wd-exp") }).locator(".tile").evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText))).map(sp);
  assert.deepEqual(tiles, ["PnL позиций +$715,8K", "ROE +9,6%", "Фандинг +$561,6K"]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("результат сделок: итог, кривая выше нуля зелёным и ниже красным, касание — значение дня, неделя и месяц", async () => {
  const { ctx, page, errors } = await open();
  const chart = page.locator(".wd-chart");
  await chart.waitFor();
  assert.equal(sp(await page.locator(".wd-head .big").textContent()), "+$346,5K");
  assert.equal(await page.locator(".wd-line.up").count(), 1);
  assert.equal(await page.locator(".wd-line.dn").count(), 1);
  assert.match(await chart.getAttribute("aria-label") ?? "", /Накопленный результат закрытых сделок по дням: \+\$346,5K/);
  // Касание у начала четвёртого дня — провал −$410K красным.
  const box = (await chart.boundingBox())!;
  await page.mouse.click(box.x + box.width * (4 / 7), box.y + 40);
  assert.equal(sp(await page.locator(".wd-tip b").textContent()), "-$410K");
  assert.equal(await page.locator(".wd-tip b.dn").count(), 1);
  assert.equal(await page.locator(".wd-dot.dn").count(), 1);
  // Стрелками — по дням.
  await chart.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(sp(await page.locator(".wd-tip b").textContent()), "-$380K");
  const tiles = (await page.locator(".card").filter({ has: chart }).locator(".tile").evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText))).map(sp);
  assert.deepEqual(tiles, ["Винрейт 63,6%", "Профит-фактор 1,84", "Макс. просадка -$412K", "Лучшая сделка +$120,4K",
    "Худшая сделка -$98K", "Сделки 98/154"]);
  await page.getByRole("tab", { name: "1М" }).click();
  assert.equal(sp(await page.locator(".wd-head .big").textContent()), "+$1,25M");
  assert.equal(await page.locator(".wd-tip").count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("позиции подробно: сторона, плечо, размер, вход, марк, ликвидация, маржа, фандинг, PnL и ROE", async () => {
  const { ctx, page, errors } = await open();
  await page.locator(".wd-pcard").first().waitFor();
  assert.equal(await page.locator(".wd-pcard").count(), 2);
  const btc = page.locator(".wd-pcard.short");
  assert.equal(sp(await btc.locator(".wd-side").textContent()), "Шорт");
  const f = (await btc.locator(".wd-pg > span").evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText))).map(sp);
  assert.deepEqual(f, ["Размер позиции $96,56M", "Вход $75 355", "Марк. цена $74 783", "Ликвидация $89 624", "Маржа $7,43M",
    "Фандинг +$561,6K"]);
  assert.equal(sp(await btc.locator(".wd-pnl").innerText()), "+$715,6K +9,6%");
  const eth = page.locator(".wd-pcard.long");
  assert.equal(sp(await eth.locator(".wd-pg > span").nth(3).innerText()), "Ликвидация —");
  assert.equal(sp(await eth.locator(".wd-pg > span").nth(5).innerText()), "Фандинг -$3,5");
  await btc.click();
  await page.locator(".wd-pcard").first().waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("320 точек, арабский и английский — ничего не обрезано и не за краем", async () => {
  for (const lang of ["ru", "en", "ar", "de"]) {
    const { ctx, page, errors } = await open({ lang, width: 320 });
    await page.locator(".wd-pcard").first().waitFor();
    assert.deepEqual(await overflow(page), [], lang);
    assert.deepEqual(errors, [], lang);
    await ctx.close();
  }
});

test("сделок в базе нет — так и сказано; счёта Hyperliquid нет (BSC) — прежний вид", async () => {
  const { ctx, page, errors } = await open({ live: { ...LIVE, perf: {} } });
  await page.locator(".wd-meter").first().waitFor();
  assert.equal(await page.locator(".wd-chart").count(), 0);
  assert.ok(sp(await page.locator(".card", { hasText: "Результат сделок" }).textContent()).includes(sp(I18N["wd_no_perf"]!["ru"]!)));
  await ctx.close();
  const bsc = await open({ wallet: "BSC" });
  await bsc.page.locator(".big").first().waitFor();
  assert.equal(await bsc.page.locator(".wd-meter, .wd-chart, .wd-pcard").count(), 0);
  assert.deepEqual([...errors, ...bsc.errors], []);
  await bsc.ctx.close();
});

test("битый результат с сервера экран не роняет", async () => {
  const bad = { ...LIVE, perf: { "7": { ...W7, pts: [[1, "x"]] }, "30": { ...W30, pnl: Infinity } } };
  const { ctx, page, errors } = await open({ live: bad });
  await page.locator(".wd-meter").first().waitFor();
  assert.equal(await page.locator(".wd-chart").count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("снимок кошелька", async () => {
  const shot = process.env["WD_SHOT"];
  if (!shot) return;
  const { ctx, page } = await open();
  await page.locator(".wd-chart").waitFor();
  const box = (await page.locator(".wd-chart").boundingBox())!;
  await page.mouse.click(box.x + box.width * (4 / 7), box.y + 40);
  await page.screenshot({ path: shot, fullPage: true });
  const pos = process.env["WD_SHOT_POS"];
  if (pos) {
    await page.locator(".wd-pos").scrollIntoViewIfNeeded();
    await page.locator(".card", { has: page.locator(".wd-pos") }).screenshot({ path: pos });
  }
  await ctx.close();
});

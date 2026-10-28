/*
 * Карточка халвинга в настоящем браузере: npm run test:e2e.
 *
 * Тест поднимает собранное приложение (html/) на случайном порту, подменяет
 * ответы сервера (сеть наружу закрыта — тест не зависит от mempool и от
 * интернета) и проверяет то, что видит человек: отсчёт, дату, полосу,
 * заглушку, сбои, узкий экран, арабский, доступность.
 *
 * Время в браузере закреплено, поэтому отсчёт сверяется до секунды. Шрифт —
 * тот же IBM Plex Sans, что у людей (из сборки, как на сервере):
 * с запасным шрифтом строки переносились бы иначе, чем на телефоне.
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

// Настоящий ответ сервера от 13.10.2026 — общий образец с тестами сервера
// (tests/fixtures/halving.json); T — «сейчас» в браузере.
const REAL = JSON.parse(await readFile(new URL("../fixtures/halving.json", import.meta.url), "utf8")) as
  { now: number } & Record<string, unknown>;
const T = REAL.now;
// До халвинга eta − T = 47 015 123 с = 544 дн 03 ч 45 мин 23 с. Читалка экрана
// слышит его словами, в правильной форме (Intl).
const CLOCK_RU = "544 дня 3 часа 45 минут 23 секунды";
/** Текст как видит человек: неразрывные и узкие пробелы (разряды «1 050 000»,
 *  «9 апреля 2028 г.») — как обычные. */
const sp = (s: string | null) => (s ?? "").replace(/[\s\u00a0\u202f]+/g, " ").trim();

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
  /** Ответ /api/halving; null — «нет данных», не задан — образец. */
  reply?: Record<string, unknown> | null | undefined;
  delay?: number;
  /** Время в браузере (unix, с). */
  at?: number;
  /** Что лежит на устройстве до запуска. */
  saved?: unknown;
  /** Сломать формат даты карточки — проверить предохранитель. */
  breakDate?: boolean;
  /** Высота окна и плотность пикселей (по умолчанию 780 и 1). */
  height?: number;
  dpr?: number;
  /** Вырез и «полоска» iPhone (env(safe-area-inset-*)). */
  insets?: { top: number; bottom: number; left: number; right: number };
  /** Высокая контрастность Windows. */
  forcedColors?: boolean;
}

async function open(o: Opts = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[]; console: string[]; outside: string[]; seen: string[] }> {
  const ctx = await browser.newContext({
    viewport: { width: o.width ?? 360, height: o.height ?? 780 }, deviceScaleFactor: o.dpr ?? 1,
    locale: o.lang === "ar" ? "ar" : "ru-RU", timezoneId: "Europe/Kyiv", forcedColors: o.forcedColors ? "active" : "none",
  });
  const page = await ctx.newPage();
  if (o.insets) await (await ctx.newCDPSession(page)).send("Emulation.setSafeAreaInsetsOverride", { insets: o.insets });
  const errors: string[] = [];
  const logs: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") logs.push(m.text()); });
  await page.clock.setFixedTime((o.at ?? T) * 1000);
  // Наружу — ничего: тест не зависит от сети, шрифт — из сборки. Куда
  // приложение всё же пыталось сходить — в outside.
  const outside: string[] = [];
  const seen: string[] = [];
  page.on("request", (r) => seen.push(r.url()));
  await ctx.route((url) => !url.href.startsWith(base), (r) => { outside.push(r.request().url()); return r.abort(); });
  await ctx.route(`${base}/api/**`, (r) => r.fulfill({ contentType: "application/json", body: '{"ok":false}' }));
  await ctx.route(`${base}/api/halving`, async (r) => {
    if (o.delay) await new Promise((ok) => setTimeout(ok, o.delay));
    const body = o.reply === null ? { ok: false, error: "no_data" } : { ...(o.reply ?? REAL), now: T };
    await r.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.addInitScript((a: { lang: string; saved: unknown; breakDate: boolean }) => {
    if (a.breakDate) {
      const D = Intl.DateTimeFormat;
      const W = function (l?: string, opt?: Intl.DateTimeFormatOptions) {
        const f = new D(l, opt);
        if (opt?.month === "long" && opt.day === "numeric" && opt.year === "numeric" && !opt.hour && !opt.weekday) {
          return { format() { throw new RangeError("boom"); }, resolvedOptions: () => f.resolvedOptions() };
        }
        return f;
      } as unknown as typeof Intl.DateTimeFormat;
      Object.defineProperty(W, "prototype", { value: D.prototype });
      (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = W;
    }
    if (sessionStorage.getItem("e2e")) return;
    sessionStorage.setItem("e2e", "1");
    localStorage.clear();
    localStorage.setItem("wt-miniapp-v7", JSON.stringify({ state: { lang: a.lang, langPinned: true }, version: 9 }));
    if (a.saved) localStorage.setItem("wt-halving-v1", JSON.stringify(a.saved));
  }, { lang: o.lang ?? "ru", saved: o.saved ?? null, breakDate: !!o.breakDate });
  await page.goto(base + "/");
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".burger").click();
  await page.locator(".drawer-row").first().waitFor();
  return { ctx, page, errors, console: logs, outside, seen };
}

/**
 * Крупный системный шрифт (Android: 130–200 %): весь текст карточки
 * крупнее в z раз — как это делает WebView, без накопления у вложенных.
 */
async function bigText(page: Page, z: number): Promise<void> {
  await page.evaluate((k) => {
    const els = [document.querySelector(".hv"), ...document.querySelectorAll(".hv *:not(.hv-cell b):not(.hv-cell small)")] as HTMLElement[];
    const px = els.map((el) => parseFloat(getComputedStyle(el).fontSize) * k);
    els.forEach((el, i) => { el.style.fontSize = `${px[i]}px`; });
    const st = document.createElement("style");
    st.textContent = `.hv-cell b{font-size:calc(22px*${k}*var(--hv-fit,1))!important}`
      + `.hv-clock.hv-wide .hv-days b{font-size:calc(18px*${k}*var(--hv-fit,1))!important}`
      + `.hv-cell small{font-size:calc(10.5px*${k}*var(--hv-fit-l,1))!important}`;
    document.head.append(st);
  }, z);
  await page.waitForTimeout(150); // ResizeObserver подгоняет цифры в следующем кадре
}

/** Что вылезает: за карточку, за свою ячейку отсчёта, за край экрана. */
function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const card = document.querySelector(".hv")!.getBoundingClientRect();
    const out: string[] = [];
    if (card.left < 0 || card.right > innerWidth) out.push(`карточка за экраном ${card.left}–${card.right}`);
    for (const el of document.querySelectorAll<HTMLElement>(".hv *")) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      if (r.left < card.left - 0.5 || r.right > card.right + 0.5) out.push(`за карточкой: ${el.tagName} «${el.textContent}»`);
      const cell = el.closest(".hv-cell");
      if (cell && cell !== el) {
        const c = cell.getBoundingClientRect();
        if (r.left < c.left + 0.5 || r.right > c.right - 0.5) out.push(`за ячейкой: ${el.tagName} «${el.textContent}»`);
      }
    }
    return out;
  });
}

const LANGS = ["ar", "de", "en", "es", "fr", "hi", "id", "ja", "ko", "pl", "pt", "ru", "tr", "uk", "vi", "zh"];

describe("карточка халвинга", () => {
  test("RODO: шрифт — со своего сервера, телефон не ходит к Google", async () => {
    const { ctx, page, outside, seen } = await open();
    await page.locator(".hv:not(.hv-skel)").waitFor();
    await page.evaluate(() => document.fonts.ready);
    const fonts = seen.filter((u) => u.endsWith(".woff2"));
    // Русский экран — латиница и кириллица, обе с нашего адреса.
    assert.ok(fonts.some((u) => /\/IBMPlexSans-Regular-latin-[\w-]+\.woff2$/.test(u)), fonts.join());
    assert.ok(fonts.some((u) => /\/IBMPlexSans-Regular-cyrillic-[\w-]+\.woff2$/.test(u)), fonts.join());
    assert.ok(fonts.every((u) => u.startsWith(base + "/")), fonts.join());
    assert.equal(await page.evaluate(() => document.fonts.check('700 22px "IBM Plex Sans"', "Аб")), true);
    // Наружу — только мост Telegram (без него Mini App не работает), и ничего про шрифты.
    assert.deepEqual(outside.filter((u) => !u.startsWith("https://telegram.org/js/telegram-web-app.js")), []);
    await ctx.close();
  });

  test("отсчёт, дата, эпоха, блок, награда — до секунды", async () => {
    const { ctx, page, errors } = await open();
    const card = page.locator(".hv:not(.hv-skel)");
    await card.waitFor();
    // Тест видит тот же шрифт, что человек, — иначе проверки вёрстки врут.
    assert.equal(await page.evaluate(() => document.fonts.check('700 22px "IBM Plex Sans"')), true);
    assert.equal(sp(await page.locator(".hv-clock").getAttribute("aria-label")), CLOCK_RU);
    assert.deepEqual(await page.locator(".hv-cell b").allInnerTexts(), ["544", "03", "45", "23"]);
    assert.deepEqual(await page.locator(".hv-cell small").allInnerTexts(), ["дн.", "ч", "мин", "с"]);
    assert.equal(sp(await page.locator(".hv-eta").innerText()), "≈ 9 апреля 2028 г.");
    assert.equal(sp(await page.locator(".hv-meta span").first().innerText()), "62,5% эпохи");
    assert.equal(sp(await page.locator(".hv-meta bdi").innerText()), "971 219 / 1 050 000");
    assert.equal(sp(await page.locator(".hv-avg").innerText()), "Среднее за эпоху: 9,95 мин на блок");
    assert.match(sp(await page.locator(".hv-rw").innerText()), /3,125 → 1,5625 BTC/);
    assert.equal(await page.locator(".hv-done").count(), 0);
    assert.equal(await page.locator(".hv-old").count(), 0); // ответ свежий — без пометки
    assert.equal(sp(await page.locator(".hv-src").innerText()), "Данные: mempool.space"); // источник рядом с данными
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("источники молчат часы — та же дата с пометкой «Обновлено», сутки — карточки нет", async () => {
    // Сервер отдаёт последний хороший ответ, пока источники молчат (до суток).
    const ago = (h: number) => ({ ...REAL, at: (REAL["at"] as number) - h * 3600,
      tip: (REAL["tip"] as number) - h * 3600, eta: (REAL["eta"] as number) - h * 3600 });
    let o = await open({ reply: ago(5) });
    await o.page.locator(".hv:not(.hv-skel)").waitFor();
    assert.equal(sp(await o.page.locator(".hv-old").innerText()), "Обновлено 06:47"); // сегодня — только время (Киев)
    assert.equal(sp(await o.page.locator(".hv-eta").innerText()), "≈ 9 апреля 2028 г.");
    assert.deepEqual(o.errors, []);
    await o.ctx.close();
    o = await open({ reply: ago(20) });
    await o.page.locator(".hv:not(.hv-skel)").waitFor();
    assert.match(sp(await o.page.locator(".hv-old").innerText()), /^Обновлено 12 окт.* 15:47$/); // вчера — с датой
    await o.ctx.close();
    o = await open({ reply: ago(25) });
    await o.page.waitForFunction(() => !document.querySelector(".hv"), null, { timeout: 5000 });
    assert.ok((await o.page.locator(".drawer-row").count()) > 5);
    assert.deepEqual(o.errors, []);
    await o.ctx.close();
  });

  test("вид: классы только свои (hv-), подписи ячеек одинаковые", async () => {
    // Общий .big из app.css уже однажды попал в ячейку дней и сделал «дн»
    // жирнее остальных. Свои классы — и общие стили карточку не трогают.
    const { ctx, page } = await open();
    const card = page.locator(".hv:not(.hv-skel)");
    await card.waitFor();
    const foreign = await card.evaluate((root) =>
      [root, ...root.querySelectorAll("*")].flatMap((e) => [...e.classList]).filter((c) => !c.startsWith("hv")));
    assert.deepEqual(foreign, []);
    const labels = await page.locator(".hv-cell small").evaluateAll((els) =>
      els.map((e) => { const c = getComputedStyle(e); return `${c.fontSize} ${c.fontWeight} ${c.letterSpacing} ${c.color}`; }));
    assert.equal(new Set(labels).size, 1, labels.join(" | "));
    await ctx.close();
  });

  test("часы телефона на 3 часа вперёд — отсчёт тот же (по часам сервера)", async () => {
    const { ctx, page } = await open({ at: T + 3 * 3600 });
    await page.locator(".hv:not(.hv-skel)").waitFor();
    assert.equal(sp(await page.locator(".hv-clock").getAttribute("aria-label")), CLOCK_RU);
    await ctx.close();
  });

  test("доступность: заголовок, таймер одной фразой, полоса прогресса", async () => {
    const { ctx, page } = await open();
    const card = page.locator(".hv:not(.hv-skel)");
    await card.waitFor();
    const id = await card.getAttribute("aria-labelledby");
    assert.ok(id);
    assert.equal(await page.locator(`[id="${id}"]`).evaluate((e) => e.tagName), "H2");
    assert.equal(await page.locator(".hv-clock").getAttribute("role"), "timer");
    const bar = page.locator(".hv-bar");
    assert.equal(await bar.getAttribute("role"), "progressbar");
    assert.equal(await bar.getAttribute("aria-valuenow"), "62.5");
    assert.equal(sp(await bar.getAttribute("aria-valuetext")), "62,5% эпохи");
    await ctx.close();
  });

  test("пока ответа нет — заглушка той же высоты, потом карточка", async () => {
    const { ctx, page } = await open({ delay: 1500 });
    const skel = page.locator(".hv.hv-skel[aria-busy=true]");
    assert.equal(await skel.count(), 1);
    const before = await skel.evaluate((e) => e.getBoundingClientRect().height);
    await page.locator(".hv:not(.hv-skel)").waitFor({ timeout: 5000 });
    assert.equal(await page.locator(".hv").count(), 1);
    // Карточка встаёт на место заглушки, не вырастая: разница — меньше 4 px.
    const after = await page.locator(".hv").evaluate((e) => e.getBoundingClientRect().height);
    assert.ok(Math.abs(after - before) < 4, `заглушка ${before} px, карточка ${after} px`);
    await ctx.close();
  });

  test("сервер без данных — карточки нет, меню работает", async () => {
    const { ctx, page, errors } = await open({ reply: null });
    await page.waitForFunction(() => !document.querySelector(".hv"), null, { timeout: 5000 });
    assert.ok((await page.locator(".drawer-row").count()) > 5);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("испорченный запас на устройстве — приложение живо, мусор не показан", async () => {
    const saved = { all: { at: T * 1000, v: { ...REAL, eta: "abc" } } };
    const { ctx, page, errors } = await open({ saved, reply: null });
    await page.waitForFunction(() => !document.querySelector(".hv"), null, { timeout: 5000 });
    assert.ok((await page.locator(".drawer-row").count()) > 5);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("поломка внутри карточки — пропадает только она (предохранитель)", async () => {
    const { ctx, page, console: logs } = await open({ breakDate: true });
    await page.waitForFunction(() => !document.querySelector(".hv:not(.hv-skel)"), null, { timeout: 5000 });
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".hv").count(), 0);
    assert.ok((await page.locator(".drawer-row").count()) > 5);
    assert.ok(logs.some((l) => l.includes("[halving]")), "ошибка записана в консоль с именем блока");
    await ctx.close();
  });

  // Сразу после халвинга до следующего ~1 457 дней — четыре цифры с
  // разделителем; на 320 px раньше они вылезали из ячейки (68 px в 52).
  const AFTER = { ok: true, height: 1050150, next: 1260000, every: 210000, avg: 600, src: "period",
    tip: T - 300, eta: T - 300 + (1260000 - 1050150) * 600, at: T, prev: T - 3 * 86400 };
  for (const [name, lang, reply] of [
    ["544 дня, русский", "ru", undefined], ["1 457 дней, русский", "ru", AFTER], ["1.457 Tage, немецкий", "de", AFTER],
  ] as const) {
    test(`320 px: ничего не вылезает за свои рамки — ${name}`, async () => {
      const { ctx, page } = await open({ width: 320, lang, reply });
      const card = page.locator(".hv:not(.hv-skel)");
      await card.waitFor();
      // Любой элемент, чьё содержимое шире его самого, — вылез (видно или обрезано).
      const over = await card.evaluate((root) =>
        [root, ...root.querySelectorAll<HTMLElement>("*")]
          .filter((e) => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1)
          .map((e) => `${e.tagName}.${e.className}: ${e.scrollWidth}>${e.clientWidth}`));
      assert.deepEqual(over, []);
      // Все замеры — в одном кадре: меню ещё может выезжать, и координаты,
      // снятые по очереди, принадлежали бы разным кадрам анимации.
      const outside = await card.evaluate((root) => {
        const box = root.getBoundingClientRect();
        return [".hv-meta", ".hv-clock", ".hv-eta", ".hv-rw"].filter((sel) => {
          const b = root.querySelector(sel)!.getBoundingClientRect();
          return b.left < box.left - 1 || b.right > box.right + 1;
        });
      });
      assert.deepEqual(outside, []);
      // Награда — одной строкой значения: «BTC» не уезжает отдельно.
      const oneLine = await page.locator(".hv-rw b").evaluate((e) =>
        e.getBoundingClientRect().height < parseFloat(getComputedStyle(e).fontSize) * 1.8);
      assert.ok(oneLine, "значение награды в одну строку");
      await ctx.close();
    });
  }

  test("арабский: страница справа налево, цифры отсчёта слева направо", async () => {
    const { ctx, page, errors } = await open({ lang: "ar" });
    await page.locator(".hv:not(.hv-skel)").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dir), "rtl");
    assert.equal(await page.locator(".hv-clock").getAttribute("dir"), "ltr");
    assert.deepEqual(await page.locator(".hv-cell b").allInnerTexts(), ["544", "03", "45", "23"]);
    // Подписи — в арабской форме для своего числа (раньше «يوم» и «ساعة» на всё).
    assert.deepEqual(await page.locator(".hv-cell small").allInnerTexts(), ["يومًا", "س", "د", "ث"]);
    // Полоса растёт от начала строки — на арабском справа (замер в одном кадре).
    const fromRight = await page.locator(".hv-bar").evaluate((bar) => {
      const b = bar.getBoundingClientRect();
      const f = bar.querySelector("i")!.getBoundingClientRect();
      return Math.abs(f.right - b.right) < 1 && f.left > b.left + 1;
    });
    assert.equal(fromRight, true);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("свёрнутое приложение сеть не трогает, вернулись — свежий ответ сразу", async () => {
    const { ctx, page } = await open();
    await page.locator(".hv:not(.hv-skel)").waitFor();
    let calls = 0;
    page.on("request", (q) => { if (q.url().endsWith("/api/halving")) calls++; });
    const show = (hidden: boolean) => page.evaluate((h) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
    // Свернули на 10 минут: ответ в памяти устарел, но в сеть не идём.
    await show(true);
    await page.clock.setFixedTime((T + 600) * 1000);
    await show(true);
    await page.waitForTimeout(300);
    assert.equal(calls, 0);
    // Вернулись — запрос сразу, а не через пять минут.
    const req = page.waitForRequest((q) => q.url().endsWith("/api/halving"), { timeout: 3000 });
    await show(false);
    await req;
    await ctx.close();
  });

  test("подделанный ответ (eta не сходится с высотой) — карточки нет", async () => {
    const eta = (REAL["eta"] as number) + 10 * 365 * 86400;
    const { ctx, page, errors } = await open({ reply: { ...REAL, eta } });
    await page.waitForFunction(() => !document.querySelector(".hv"), null, { timeout: 5000 });
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("оценка момента прошла, а блока халвинга ещё нет — «наступает», без выдуманного блока", async () => {
    // Блоки шли медленнее среднего: время по оценке настало, сервер нового
    // блока ещё не видел. Не «1 050 000 / 1 050 000» и не «100 %».
    const next = REAL["next"] as number;
    const avg = REAL["avg"] as number;
    const tip = T - 3000; // 3 блока до халвинга по оценке вышли бы к T − 1210 с
    const { ctx, page, errors } = await open({ reply: { ...REAL, height: next - 3, tip, eta: Math.round(tip + 3 * avg) } });
    await page.locator(".hv:not(.hv-skel)").waitFor();
    assert.equal(sp(await page.locator(".hv-now").innerText()), "Халвинг наступает");
    assert.equal(await page.locator(".hv-clock").count(), 0);
    assert.equal(sp(await page.locator(".hv-meta span").first().innerText()), "99,9% эпохи");
    assert.equal(sp(await page.locator(".hv-meta bdi").innerText()), "1 049 999 / 1 050 000");
    assert.equal(await page.locator(".hv-bar").getAttribute("aria-valuenow"), "99.9");
    assert.equal(await page.locator(".hv-done").count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test("две недели после халвинга — «состоялся» и отсчёт до следующего", async () => {
    const prev = T - 3 * 86400;
    const { ctx, page } = await open({ reply: { ...AFTER, prev } });
    await page.locator(".hv:not(.hv-skel)").waitFor();
    assert.match(sp(await page.locator(".hv-done").innerText()), /Халвинг состоялся 10 октября 2026 г\. — блок 1 050 000/);
    assert.match(sp(await page.locator(".hv-rw").innerText()), /1,5625 → 0,78125 BTC/);
    assert.equal(sp(await page.locator(".hv-avg").innerText()), "Оценка по 10 мин на блок");
    await ctx.close();
  });

  test("все 16 языков на 320 px: ничего не вылезает ни за карточку, ни за ячейку", async () => {
    const ctxs = await Promise.all(LANGS.map((lang) => open({ width: 320, lang })));
    try {
      for (const [i, { page, errors }] of ctxs.entries()) {
        await page.locator(".hv:not(.hv-skel)").waitFor();
        assert.deepEqual(await overflow(page), [], LANGS[i] ?? "");
        assert.deepEqual(errors, [], LANGS[i] ?? "");
      }
    } finally {
      await Promise.all(ctxs.map(({ ctx }) => ctx.close()));
    }
  });

  test("от 320 до 1280 px и плотность ×1–×3: ровно, без вылезаний", async () => {
    for (const [width, dpr] of [[320, 2], [360, 3], [390, 3], [430, 3], [768, 2], [1280, 1]] as const) {
      const { ctx, page } = await open({ width, dpr });
      await page.locator(".hv:not(.hv-skel)").waitFor();
      assert.deepEqual(await overflow(page), [], `${width} px ×${dpr}`);
      await ctx.close();
    }
  });

  for (const [z, lang, reply] of [[1.3, "ru", undefined], [2, "de", undefined], [2, "ar", undefined], [1.6, "ru", AFTER]] as const) {
    test(`крупный системный шрифт ${z * 100} % (${lang}${reply ? ", 1 457 дней" : ""}): цифры и подписи в своих ячейках`, async () => {
      const { ctx, page, errors } = await open({ width: 320, lang, reply });
      await page.locator(".hv:not(.hv-skel)").waitFor();
      // Ошибки окна — в том числе «ResizeObserver loop», если подгон правит
      // размер прямо в наблюдателе.
      await page.evaluate(() => {
        const w = window as unknown as { __hvErr: string[] };
        w.__hvErr = [];
        addEventListener("error", (e) => w.__hvErr.push(e.message));
      });
      await bigText(page, z);
      assert.deepEqual(await overflow(page), []);
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => (window as unknown as { __hvErr: string[] }).__hvErr), []);
      assert.deepEqual(errors, []);
      // Цифры уменьшены ровно настолько, чтобы влезть, — а не во много раз.
      const fit = Number(await page.locator(".hv-clock").evaluate((e) => getComputedStyle(e).getPropertyValue("--hv-fit") || "1"));
      assert.ok(fit > 0.5 && fit < 1, `--hv-fit = ${fit}`);
      await ctx.close();
    });
  }

  test("обычный шрифт: цифры не уменьшаются", async () => {
    const { ctx, page } = await open({ width: 320 });
    await page.locator(".hv:not(.hv-skel)").waitFor();
    await page.waitForTimeout(150);
    assert.equal(await page.locator(".hv-clock").evaluate((e) => e.style.getPropertyValue("--hv-fit")), "");
    assert.equal(await page.locator(".hv-cell b").first().evaluate((e) => getComputedStyle(e).fontSize), "22px");
    await ctx.close();
  });

  for (const [name, width, height, insets, lang] of [
    ["iPhone вертикально: над «полоской»", 393, 852, { top: 59, bottom: 34, left: 0, right: 0 }, "ru"],
    ["iPhone горизонтально: мимо выреза камеры", 852, 393, { top: 0, bottom: 21, left: 59, right: 59 }, "ru"],
    ["iPhone горизонтально, арабский: мимо выреза справа", 852, 393, { top: 0, bottom: 21, left: 59, right: 59 }, "ar"],
  ] as const) {
    test(name, async () => {
      const { ctx, page } = await open({ width, height, dpr: 3, insets, lang });
      await page.locator(".hv:not(.hv-skel)").waitFor();
      // Меню выезжает 0,22 с — мерим, когда встало на место, и долистав до конца.
      await page.locator(".drawer").evaluate(async (d) => {
        await Promise.all(d.getAnimations().map((x) => x.finished));
        d.scrollTop = d.scrollHeight;
      });
      await page.waitForTimeout(100);
      const r = await page.locator(".hv").evaluate((e) => e.getBoundingClientRect().toJSON() as DOMRect);
      // Низ карточки — выше полоски; бок — не ближе границы выреза (и не
      // ближе обычных 14 px от края меню).
      assert.ok(r.bottom <= height - insets.bottom - 8, `низ ${r.bottom}`);
      if (lang === "ar") assert.ok(r.right <= width - Math.max(14, insets.right), `правый край ${r.right}`);
      else assert.ok(r.left >= Math.max(14, insets.left), `левый край ${r.left}`);
      // Долистали до конца — стрелка «ещё» не закрывает карточку.
      assert.equal(await page.locator(".drawer-more").count(), 0);
      await ctx.close();
    });
  }

  test("высокая контрастность Windows: полоса эпохи видна", async () => {
    const { ctx, page } = await open({ forcedColors: true });
    await page.locator(".hv:not(.hv-skel)").waitFor();
    const fill = await page.locator(".hv-bar i").evaluate((e) => getComputedStyle(e).backgroundColor);
    assert.notEqual(fill, "rgba(0, 0, 0, 0)");
    assert.ok(!/, 0\)$/.test(fill), fill);
    await ctx.close();
  });
});

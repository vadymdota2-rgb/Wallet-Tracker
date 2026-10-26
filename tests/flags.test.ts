/*
 * Флаги стран (src/lib/flags.ts): npm test.
 *
 * Шрифт с флагами подключается только там, где текст страницы рисует вместо
 * флага буквы: цветная картинка флага не зависит от цвета заливки и в ней
 * есть цветные точки; буквы зависят от заливки, а серые буквы Windows (они
 * от заливки не зависят) — без цвета. Холст подменён.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FLAG_FONT, nativeFlags, polyfillFlags } from "../src/lib/flags.ts";

type Mode = "color" | "gray" | "letters" | "blank" | "nocanvas" | "throws";
const PAGE_FONT = `"${FLAG_FONT}", "IBM Plex Sans", ui-sans-serif, sans-serif`;

/** Документ с холстом, который рисует флаг так, как сказано в mode. */
function fakeDoc(mode: Mode) {
  const styles: { textContent: string }[] = [];
  const fonts: string[] = [];
  let fill = "#000";
  const ctx = {
    textBaseline: "",
    set font(v: string) { fonts.push(v); },
    set fillStyle(v: string) { fill = v; },
    clearRect() {},
    fillText() {},
    getImageData(_x: number, _y: number, w: number, h: number) {
      if (mode === "throws") throw new Error("холст закрыт");
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < 40 * 4; i += 4) {
        if (mode === "color") data.set(i < 80 ? [200, 30, 40, 255] : [40, 50, 160, 255], i);
        if (mode === "gray") data.set([120, 120, 120, 255], i);
        if (mode === "letters") data.set(fill === "#000" ? [0, 0, 0, 255] : [255, 255, 255, 255], i);
      }
      return { data };
    },
  };
  const body = {};
  const doc = {
    body,
    documentElement: body,
    defaultView: { getComputedStyle: () => ({ fontFamily: PAGE_FONT }) },
    createElement(tag: string) {
      if (tag === "canvas") return { width: 0, height: 0, getContext: () => (mode === "nocanvas" ? null : ctx) };
      return { textContent: "" };
    },
    head: { appendChild(el: { textContent: string }) { styles.push(el); } },
  };
  return { doc: doc as unknown as Document, styles, fonts };
}

test("флаг цветной картинкой — шрифт не нужен и не скачивается", () => {
  const { doc, styles, fonts } = fakeDoc("color");
  assert.equal(polyfillFlags("/assets/f.woff2", doc), false);
  assert.deepEqual(styles, []);
  // Проверка — шрифтом самой страницы, без нашего шрифта флагов.
  assert.equal(fonts.length, 1);
  const used = fonts[0]!;
  assert.ok(used.includes('"IBM Plex Sans"') && !used.includes(FLAG_FONT), used);
});

test("флаг буквами (Windows, Chromium) — подключается шрифт только для флагов", () => {
  for (const mode of ["letters", "gray", "blank"] as const) {
    const { doc, styles } = fakeDoc(mode);
    assert.equal(nativeFlags("sans-serif", doc), false, mode);
    assert.equal(polyfillFlags("/assets/f-1a2b.woff2", doc), true, mode);
    assert.equal(styles.length, 1);
    const css = styles[0]!.textContent;
    assert.ok(css.includes(`font-family:"${FLAG_FONT}"`), css);
    assert.ok(css.includes('src:url("/assets/f-1a2b.woff2") format("woff2")'), css);
    // Только буквы-указатели: остальной текст шрифт не трогает.
    assert.ok(css.includes("unicode-range:U+1F1E6-1F1FF;"), css);
  }
});

test("проверить нельзя — шрифт не грузим", () => {
  for (const mode of ["nocanvas", "throws"] as const) {
    const { doc, styles } = fakeDoc(mode);
    assert.equal(polyfillFlags("/x.woff2", doc), false, mode);
    assert.deepEqual(styles, []);
  }
});

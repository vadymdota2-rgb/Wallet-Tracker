/**
 * Флаги стран там, где система их не рисует.
 *
 * Флаг-эмодзи (🇺🇸) — это две буквы-указателя («U» и «S»), которые система
 * склеивает в картинку. Windows этого не умеет, и браузеры на Chromium там
 * показывают вместо флага буквы «US» — так было у фондов ETF, в календаре и
 * в выборе языка. На таком устройстве приложение подключает свой шрифт, в
 * котором есть только флаги (src/assets/TwemojiCountryFlags.woff2, 77 КБ,
 * рисунки Twemoji, CC BY 4.0 — источник назван на экране условий). Где флаги
 * рисует сама система, шрифт не скачивается и всё выглядит как раньше.
 */
/** Имя шрифта — первым в --font-sans (theme.css) и в index.html. */
export const FLAG_FONT = "Twemoji Country Flags";
const SIZE = 24;
/** Сколько точек флага должны быть цветными: у флага США — красный и синий,
 *  у букв «US» (и у серых букв Windows) их нет. */
const COLORED = 8;

/**
 * Рисует ли система флаг цветной картинкой — тем же шрифтом, что текст
 * страницы (font). Отдельно «эмодзи-шрифтом» проверять нельзя: в нём флаг
 * может быть, а текст страницы его не возьмёт и покажет буквы. Картинка не
 * берёт цвет заливки, буквы — берут; и у картинки есть цветные точки.
 * Проверить нельзя (нет холста) — считаем, что рисует: лишний шрифт без
 * нужды не грузим.
 */
export function nativeFlags(font: string, doc: Document = document): boolean {
  try {
    const g = Object.assign(doc.createElement("canvas"), { width: SIZE, height: SIZE })
      .getContext("2d", { willReadFrequently: true });
    if (!g) return true;
    g.textBaseline = "top";
    g.font = `${SIZE - 4}px ${font}`;
    const draw = (fill: string) => {
      g.clearRect(0, 0, SIZE, SIZE);
      g.fillStyle = fill;
      g.fillText("\u{1F1FA}\u{1F1F8}", 0, 0);
      return g.getImageData(0, 0, SIZE, SIZE).data;
    };
    const dark = draw("#000");
    const light = draw("#fff");
    let colored = 0;
    for (let i = 0; i < dark.length; i += 4) {
      for (let k = i; k < i + 4; k++) if (dark[k] !== light[k]) return false;
      const r = dark[i]!;
      const gr = dark[i + 1]!;
      const b = dark[i + 2]!;
      if (dark[i + 3]! > 128 && Math.max(r, gr, b) - Math.min(r, gr, b) > 60) colored += 1;
    }
    return colored >= COLORED;
  } catch {
    return true;
  }
}

/** Подключить шрифт с флагами (адрес url — файл сборки), если система их
 *  не рисует. Только для букв-указателей (unicode-range): остальной текст —
 *  прежним шрифтом. */
export function polyfillFlags(url: string, doc: Document = document): boolean {
  const body = doc.body ?? doc.documentElement;
  const stack = (doc.defaultView?.getComputedStyle(body).fontFamily || "sans-serif")
    .split(",").filter((f) => f.replace(/["']/g, "").trim() !== FLAG_FONT).join(",") || "sans-serif";
  if (nativeFlags(stack, doc)) return false;
  const style = doc.createElement("style");
  style.textContent = `@font-face{font-family:"${FLAG_FONT}";src:url("${url}") format("woff2");`
    + "unicode-range:U+1F1E6-1F1FF;font-display:swap}";
  doc.head.appendChild(style);
  return true;
}

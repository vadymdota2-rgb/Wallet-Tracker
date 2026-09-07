/**
 * Чистит результат прошлой сборки перед новой.
 *
 * `emptyOutDir` в vite.config.ts выключен намеренно: в html/ лежит coins/ —
 * 1547 логотипов на 26 МБ, и стирать их при каждой сборке нельзя. Но без
 * очистки в html/assets/ копятся файлы прошлых сборок: имена содержат хеш,
 * поэтому новая сборка не перезаписывает старую, а ложится рядом.
 *
 * Поэтому убираем ровно то, что делает сборка, и не трогаем остальное.
 */
import { rm, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "html", "assets");

let removed = 0;
try {
  for (const name of await readdir(assets)) {
    await rm(join(assets, name), { force: true });
    removed += 1;
  }
} catch (err) {
  // Папки ещё нет — это первая сборка, чистить нечего.
  if (err?.code !== "ENOENT") throw err;
}
await rm(join(root, "html", "index.html"), { force: true });

console.log(`clean-build: удалено ${removed} файлов из html/assets`);

/*
 * Для тестов, которые зовут код приложения из Node напрямую: относительный
 * импорт без расширения («./data») ищется как «./data.ts» — так, как его
 * находит сборщик приложения (moduleResolution: bundler). Сам код
 * приложения ради тестов не меняется.
 *
 *   node --import ./tests/ts-resolve.mjs …
 */
import { register } from "node:module";

register("data:text/javascript," + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  try {
    return await next(spec, ctx);
  } catch (e) {
    if ((spec.startsWith("./") || spec.startsWith("../")) && !/\\.[a-z]+$/.test(spec)) return next(spec + ".ts", ctx);
    throw e;
  }
}
`));

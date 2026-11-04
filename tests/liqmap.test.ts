/*
 * Карта ликвидаций — тексты экрана (tools/i18n.json, ключи lq_*), 16 языков.
 * Модель и кэш проверяются на сервере (tests/test_liqmap.py), экран — в
 * браузере (tests/e2e/liqmap.e2e.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const i18n = JSON.parse(readFileSync(new URL("../tools/i18n.json", import.meta.url), "utf8")) as
  Record<string, Record<string, string>>;
const CJK = "[\\u3040-\\u30ff\\u4e00-\\u9fff]";

test("тексты карты: число не отрывается от слова, французские «:» и «;» — от слова, у китайского и японского — без пробелов у числа (16 языков)", () => {
  const keys = Object.keys(i18n).filter((k) => k.startsWith("lq_"));
  assert.ok(keys.length > 40, String(keys.length));
  for (const key of keys) {
    assert.equal(Object.keys(i18n[key]!).length, 16, key);
    for (const [lang, text] of Object.entries(i18n[key]!)) {
      // {x} — «в 2,1 раза», {p} — доля, {n} — сколько: за ними неразрывный пробел.
      assert.doesNotMatch(text, /\{[nabpkmxv]\} (?=[\p{L}%])/u, `${key}.${lang}`);
      if (lang === "fr") assert.doesNotMatch(text, / [:;?!»]|« /, `${key}.fr`);
      if (lang === "zh" || lang === "ja") {
        assert.doesNotMatch(text, new RegExp(`${CJK}[ \\u00a0]\\{[nabpkmxv]\\}|\\{[nabpkmxv]\\}[ \\u00a0]${CJK}`, "u"), `${key}.${lang}`);
        assert.doesNotMatch(text, /[。，：；！？] /, `${key}.${lang}`);
      }
    }
  }
  assert.ok(i18n["lq_bias_dn"]!["ru"]!.includes("{x} раза"));
  assert.ok(i18n["lq_at_level"]!["fr"]!.endsWith("niveau :"));
  assert.equal(i18n["lq_bias_dn"]!["zh"], "价格下方的清算是上方的{x}倍");
});

test("плечи в «Как читать» — те же четыре группы, что в легенде экрана (16 языков)", () => {
  for (const [lang, text] of Object.entries(i18n["lq_how_3"]!)) {
    for (const g of ["3–10×", "20–25×", "50×", "75–100×"]) assert.ok(text.includes(g), `${lang}: ${g}`);
  }
});

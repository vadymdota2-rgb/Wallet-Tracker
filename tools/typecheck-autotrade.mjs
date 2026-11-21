/*
 * Автоторговля — в самом строгом режиме TypeScript: npm run typecheck:autotrade.
 * Те же флаги, что у карточки халвинга (tools/typecheck-halving.mjs):
 * exactOptionalPropertyTypes, noImplicitOverride,
 * noPropertyAccessFromIndexSignature, noImplicitReturns — только файлы модуля.
 */
import { spawnSync } from "node:child_process";

const MODULE = [
  "src/lib/autotrade.ts", "src/screens/AutotradeScreen.tsx", "tests/autotrade.test.ts", "tests/e2e/autotrade.e2e.test.ts",
];
const FLAGS = ["--exactOptionalPropertyTypes", "--noImplicitOverride", "--noPropertyAccessFromIndexSignature", "--noImplicitReturns"];

let bad = [];
for (const project of ["tsconfig.json", "tsconfig.tests.json"]) {
  const r = spawnSync("npx", ["tsc", "--noEmit", "-p", project, ...FLAGS], { encoding: "utf8" });
  bad = bad.concat(r.stdout.split("\n").filter((l) => MODULE.some((f) => l.startsWith(f))));
}
if (bad.length) {
  console.error(bad.join("\n"));
  process.exit(1);
}
console.log(`автоторговля: строгий TypeScript — без ошибок (${MODULE.length} файла)`);

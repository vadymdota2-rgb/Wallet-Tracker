/*
 * «Альтсезон» — в самом строгом режиме TypeScript: npm run typecheck:dom.
 *
 * Флаги строже общих (exactOptionalPropertyTypes, noImplicitOverride,
 * noPropertyAccessFromIndexSignature, noImplicitReturns). Остальное
 * приложение под них ещё не переведено, поэтому смотрим только файлы модуля:
 * любая ошибка в них — провал.
 */
import { spawnSync } from "node:child_process";

const MODULE = [
  "src/lib/dom.ts", "src/screens/DominanceScreen.tsx",
  "tests/dom.test.ts", "tests/dom.props.test.ts", "tests/e2e/dom.e2e.test.ts",
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
console.log(`«Альтсезон»: строгий TypeScript — без ошибок (${MODULE.length} файлов)`);

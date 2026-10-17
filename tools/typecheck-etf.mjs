/*
 * «Институциональные потоки» — в самом строгом режиме TypeScript: npm run typecheck:etf.
 *
 * Флаги строже общих (exactOptionalPropertyTypes, noImplicitOverride,
 * noPropertyAccessFromIndexSignature, noImplicitReturns). Остальное
 * приложение под них ещё не переведено, поэтому смотрим только файлы модуля:
 * любая ошибка в них — провал.
 */
import { spawnSync } from "node:child_process";

const MODULE = [
  "src/lib/etf.ts", "src/screens/EtfScreen.tsx", "src/screens/EtfMore.tsx", "src/screens/etfView.ts",
  "tests/etf.test.ts", "tests/etf.props.test.ts", "tests/e2e/etf.e2e.test.ts",
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
console.log(`«Институциональные потоки»: строгий TypeScript — без ошибок (${MODULE.length} файлов)`);

/**
 * Сверяет нашу сборку перевода USDT с эталонной (@ton/core): байт в байт.
 *
 *     node tools/ton-boc-check.mjs
 *
 * @ton/core стоит только для этой проверки и в сборку приложения не входит —
 * иначе мини-апп потяжелел бы на сотни килобайт ради одной ячейки.
 */
import { Address, beginCell, toNano } from "@ton/core";
import { readFileSync } from "fs";
import ts from "typescript";

// Наш модуль написан для браузера: atob и btoa даём ему сами.
globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");

const src = readFileSync(new URL("../src/lib/ton.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const cases = [
  { to: "UQDAiNYvy2KUIwjEcgD1ZxPVw-CPwdk4WbBQwpVsQQ5jsO6o", from: "UQDqcX9qBQQESkmdn7Wt-BGoW3wTpSDzZ8KkqJrKNm642m61", units: 3990000n, comment: "WT-SFVQH" },
  { to: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", from: "Ef_3b03G30h2Q5-GRsr1gabrFd6gme6qdI033Sr3OPfxfuZm", units: 1n, comment: "A" },
  { to: "UQDAiNYvy2KUIwjEcgD1ZxPVw-CPwdk4WbBQwpVsQQ5jsO6o", from: "UQBxRPQdQXfo_7ed27fgDw-AlT9WwFTW_ul8UhuSHdDgi4Qz", units: 123456789012n, comment: "WT-ZZZZZ памятка" },
];

let bad = 0;
for (const c of cases) {
  const ours = mod.jettonTransfer({ units: c.units, to: c.to, from: c.from, comment: c.comment });
  const ref = beginCell()
    .storeUint(0x0f8a7ea5, 32)
    .storeUint(0, 64)
    .storeCoins(c.units)
    .storeAddress(Address.parse(c.to))
    .storeAddress(Address.parse(c.from))
    .storeBit(0)
    .storeCoins(1n)
    .storeBit(0)
    .storeUint(0, 32)
    .storeStringTail(c.comment)
    .endCell()
    .toBoc({ idx: false, crc32: false })
    .toString("base64");
  const same = ours === ref;
  if (!same) bad++;
  console.log(`${same ? "ok " : "BAD"} ${c.comment}`);
  if (!same) console.log("  наше:    " + ours + "\n  эталон:  " + ref);
}
// Разбор адреса тоже сверяем: рабочая цепочка и хеш.
for (const a of ["UQDAiNYvy2KUIwjEcgD1ZxPVw-CPwdk4WbBQwpVsQQ5jsO6o", "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", "Ef_3b03G30h2Q5-GRsr1gabrFd6gme6qdI033Sr3OPfxfuZm"]) {
  const ours = mod.parseAddr(a);
  const ref = Address.parse(a);
  const same = ours.wc === ref.workChain && Buffer.from(ours.hash).equals(ref.hash);
  if (!same) bad++;
  console.log(`${same ? "ok " : "BAD"} адрес ${a.slice(0, 8)}…`);
}
console.log(bad ? `ПРОВАЛОВ: ${bad}` : "сборка перевода совпадает с эталоном");
process.exit(bad ? 1 : 0);

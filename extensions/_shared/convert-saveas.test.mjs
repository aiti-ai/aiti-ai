/**
 * convert-saveas tests — 命名规则纯函数（不覆盖、-from<ext>、(n) 递增）。
 *
 * Run: node --test pi-web-ext/_shared/convert-saveas.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

const { nextSaveAsPath } = await import("./convert-saveas.ts");

test("nextSaveAsPath：无冲突 → <stem>-from<ext>.<toExt>", () => {
  const got = nextSaveAsPath("/w", "demo-sheet.xls", "xls", "xlsx", () => false);
  assert.equal(got, join("/w", "demo-sheet-fromxls.xlsx"));
});

test("nextSaveAsPath：同名存在 → (1) 递增；多冲突继续递增", () => {
  const existing = new Set([join("/w", "demo-sheet-fromxls.xlsx")]);
  const exists = (p) => existing.has(p);
  const first = nextSaveAsPath("/w", "demo-sheet.xls", "xls", "xlsx", exists);
  assert.equal(first, join("/w", "demo-sheet-fromxls(1).xlsx"));
  existing.add(first);
  const second = nextSaveAsPath("/w", "demo-sheet.xls", "xls", "xlsx", exists);
  assert.equal(second, join("/w", "demo-sheet-fromxls(2).xlsx"));
});

test("nextSaveAsPath：.doc → .docx 用 -fromdoc；多点文件名取最后段", () => {
  assert.equal(
    nextSaveAsPath("/w", "报告.v2.doc", "doc", "docx", () => false),
    join("/w", "报告.v2-fromdoc.docx"),
  );
});

test("nextSaveAsPath：源扩展点归一（带点传入等价）", () => {
  assert.equal(
    nextSaveAsPath("/w", "a.ods", ".ods", "xlsx", () => false),
    join("/w", "a-fromods.xlsx"),
  );
});

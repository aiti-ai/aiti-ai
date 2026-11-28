/**
 * convert-saveas tests — naming-rule pure functions (no overwrite, -from<ext>, (n) increments).
 *
 * Run: node --test pi-web-ext/_shared/convert-saveas.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

const { nextSaveAsPath } = await import("./convert-saveas.ts");

test("nextSaveAsPath: no conflict -> <stem>-from<ext>.<toExt>", () => {
  const got = nextSaveAsPath("/w", "demo-sheet.xls", "xls", "xlsx", () => false);
  assert.equal(got, join("/w", "demo-sheet-fromxls.xlsx"));
});

test("nextSaveAsPath: same name exists -> (1) increments; more conflicts keep incrementing", () => {
  const existing = new Set([join("/w", "demo-sheet-fromxls.xlsx")]);
  const exists = (p) => existing.has(p);
  const first = nextSaveAsPath("/w", "demo-sheet.xls", "xls", "xlsx", exists);
  assert.equal(first, join("/w", "demo-sheet-fromxls(1).xlsx"));
  existing.add(first);
  const second = nextSaveAsPath("/w", "demo-sheet.xls", "xls", "xlsx", exists);
  assert.equal(second, join("/w", "demo-sheet-fromxls(2).xlsx"));
});

test("nextSaveAsPath: .doc -> .docx uses -fromdoc; multi-dot names take the last segment", () => {
  assert.equal(
    nextSaveAsPath("/w", "report.v2.doc", "doc", "docx", () => false),
    join("/w", "report.v2-fromdoc.docx"),
  );
});

test("nextSaveAsPath: source extension dot normalization (dotted input is equivalent)", () => {
  assert.equal(
    nextSaveAsPath("/w", "a.ods", ".ods", "xlsx", () => false),
    join("/w", "a-fromods.xlsx"),
  );
});

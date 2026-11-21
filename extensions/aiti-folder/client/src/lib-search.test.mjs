/**
 * lib-search.test.mjs — content search grouping pure functions (borrow plan §2.5).
 * Run: node --experimental-strip-types --test extensions/aiti-folder/client/src/lib-search.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupContentMatches } from "./lib.ts";

test("groupContentMatches: groups by path keeping rg relevance order", () => {
  const groups = groupContentMatches([
    { path: "/w/b.ts", line: 5, col: 0, text: "b1" },
    { path: "/w/a.ts", line: 1, col: 0, text: "a1" },
    { path: "/w/b.ts", line: 9, col: 0, text: "b2" },
    { path: "/w/c.md", line: 2, col: 0, text: "c1" },
  ]);
  assert.deepEqual(groups.map((g) => g.path), ["/w/b.ts", "/w/a.ts", "/w/c.md"]);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[1].count, 1);
});

test("preview cap: previews ≤ previewPerFile, count counts all hits", () => {
  const groups = groupContentMatches(
    Array.from({ length: 10 }, (_, i) => ({ path: "/f.txt", line: i + 1, col: 0, text: "l" + i })),
    3,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 10);
  assert.equal(groups[0].previews.length, 3);
  assert.deepEqual(groups[0].previews.map((p) => p.line), [1, 2, 3]);
});

test("malformed rows dropped; empty/non-array input safe", () => {
  const groups = groupContentMatches([null, 42, { path: "", line: 1 }, { path: "/ok.ts", line: 3, col: 0, text: "x" }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].path, "/ok.ts");
  assert.deepEqual(groupContentMatches([]), []);
  assert.deepEqual(groupContentMatches(undefined), []);
  assert.deepEqual(groupContentMatches("nope"), []);
});

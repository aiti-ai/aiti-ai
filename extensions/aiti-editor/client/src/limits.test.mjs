/**
 * limits.ts / json-outline.ts tests — size policy + the O(n) JSON outline.
 *
 * Background (2026-11-24): opening a 2.1MB session export froze the page. Root cause was
 * registry.ts calling `text.split("\n")` twice per loop iteration (O(n²)); 16,222 lines
 * did not finish in 25s. These tests pin the linear implementation and the size ladder.
 *
 * Run: node --test extensions/aiti-editor/client/src/limits.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
  EDIT_READONLY_BYTES, LARGE_INFO_BYTES, MONACO_MAX_BYTES,
  decideOpenMode, canOpenInEditor, isDeferredMode,
} = await import("../../shared/limits.ts");
const { outlineJson, countTextLines } = await import("./json-outline.ts");

test("open mode ladder boundaries", () => {
  assert.equal(decideOpenMode(0), "edit");
  assert.equal(decideOpenMode(1), "edit");
  assert.equal(decideOpenMode(EDIT_READONLY_BYTES), "edit");
  assert.equal(decideOpenMode(EDIT_READONLY_BYTES + 1), "readonly");
  assert.equal(decideOpenMode(LARGE_INFO_BYTES), "readonly");
  assert.equal(decideOpenMode(LARGE_INFO_BYTES + 1), "info");
  assert.equal(decideOpenMode(MONACO_MAX_BYTES), "info");
  assert.equal(decideOpenMode(MONACO_MAX_BYTES + 1), "viewer");
  assert.equal(decideOpenMode(Number.NaN), "edit");
  assert.equal(decideOpenMode(-5), "edit");
});

test("deferred modes and editor escape hatch", () => {
  assert.equal(isDeferredMode("info"), true);
  assert.equal(isDeferredMode("viewer"), true);
  assert.equal(isDeferredMode("edit"), false);
  assert.equal(isDeferredMode("readonly"), false);
  assert.equal(canOpenInEditor(MONACO_MAX_BYTES), true);
  assert.equal(canOpenInEditor(MONACO_MAX_BYTES + 1), false);
});

test("outlineJson extracts keys with line numbers", () => {
  const text = '{\n  "a": 1,\n  "b": {\n    "c": 2\n  },\n  "d": [1,2]\n}\n';
  const syms = outlineJson(text);
  assert.deepEqual(syms.map((s) => s.name), ["a", "b", "c", "d"]);
  assert.deepEqual(syms.map((s) => s.line), [2, 3, 4, 6]);
});

test("outlineJson caps the symbol list", () => {
  const text = Array.from({ length: 5000 }, (_, i) => `  "k${i}": 1`).join("\n");
  assert.equal(outlineJson(text, 100).length, 100);
  assert.equal(outlineJson(text).length, 2000);
});

test("outlineJson is linear: 20k lines well under a second", () => {
  // The old implementation needed ~2 minutes for this size (quadratic). Keep the bound
  // generous so a slow CI box does not flake, but far below the old behaviour.
  const text = Array.from({ length: 20000 }, (_, i) => `  "key${i}": "${"x".repeat(60)}"`).join("\n");
  const t0 = Date.now();
  const syms = outlineJson(text);
  const ms = Date.now() - t0;
  assert.ok(syms.length > 0);
  assert.ok(ms < 1000, `outlineJson took ${ms}ms for 20k lines`);
});

test("countTextLines counts newlines", () => {
  assert.equal(countTextLines(""), 0);
  assert.equal(countTextLines("a"), 1);
  assert.equal(countTextLines("a\nb\n"), 3);
});

test("normalizeLimits clamps and enforces ordering", async () => {
  const { normalizeLimits, DEFAULT_LIMITS } = await import("../../shared/limits.ts");
  const l = normalizeLimits({
    readonlyMB: 5, infoMB: 1, monacoMB: 2, forceMaxMB: 3,
    cacheKB: 100, cacheDiffKB: 9999, previewKB: -1, providerMB: "abc",
    allowForceOpen: "false",
  });
  assert.equal(l.readonlyMB, 5);
  assert.equal(l.infoMB, 5);       // bumped to readonly
  assert.equal(l.monacoMB, 5);     // bumped to info
  assert.equal(l.forceMaxMB, 5);   // bumped to monaco
  assert.equal(l.cacheDiffKB <= l.cacheKB, true);
  assert.equal(l.previewKB >= 8, true);
  assert.equal(l.providerMB, DEFAULT_LIMITS.providerMB);
  assert.equal(l.allowForceOpen, false);
  assert.equal(normalizeLimits(null).monacoMB, DEFAULT_LIMITS.monacoMB);
});

test("decideOpenModeWith follows configured thresholds", async () => {
  const { decideOpenModeWith, normalizeLimits } = await import("../../shared/limits.ts");
  const l = normalizeLimits({ readonlyMB: 2, infoMB: 4, monacoMB: 32, forceMaxMB: 64 });
  assert.equal(decideOpenModeWith(l, 2 * 1024 * 1024), "edit");
  assert.equal(decideOpenModeWith(l, 2 * 1024 * 1024 + 1), "readonly");
  assert.equal(decideOpenModeWith(l, 4 * 1024 * 1024 + 1), "info");
  assert.equal(decideOpenModeWith(l, 32 * 1024 * 1024 + 1), "viewer");
});

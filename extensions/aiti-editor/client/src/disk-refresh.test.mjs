/**
 * disk-refresh.ts tests — disk-change auto-refresh decision layer (pure functions).
 *
 * Plan: docs/aiti-editor-preview-watch-refresh-plan.md §3.4
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-editor/client/src/disk-refresh.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { sameDiskSig, shouldAutoReload, throttleOk, sigOfFrame } = await import("./disk-refresh.ts");

// ── sameDiskSig（保存回环抑制）──
test("sameDiskSig: identical sigs match", () => {
  assert.equal(sameDiskSig({ mtimeMs: 1000, size: 5 }, { mtimeMs: 1000, size: 5 }), true);
});

test("sameDiskSig: mtime within ±2ms tolerance matches (float save response vs floored frame)", () => {
  assert.equal(sameDiskSig({ mtimeMs: 1000.4, size: 5 }, { mtimeMs: 1000, size: 5 }), true);
  assert.equal(sameDiskSig({ mtimeMs: 1002, size: 5 }, { mtimeMs: 1000, size: 5 }), true);
});

test("sameDiskSig: mtime beyond tolerance does not match", () => {
  assert.equal(sameDiskSig({ mtimeMs: 1003, size: 5 }, { mtimeMs: 1000, size: 5 }), false);
});

test("sameDiskSig: size mismatch does not match even with same mtime", () => {
  assert.equal(sameDiskSig({ mtimeMs: 1000, size: 6 }, { mtimeMs: 1000, size: 5 }), false);
});

test("sameDiskSig: null/undefined/missing-mtime never match", () => {
  assert.equal(sameDiskSig(null, { mtimeMs: 1, size: 1 }), false);
  assert.equal(sameDiskSig({ mtimeMs: 1, size: 1 }, undefined), false);
  assert.equal(sameDiskSig({ mtimeMs: undefined, size: 1 }, { mtimeMs: 1, size: 1 }), false);
});

// ── shouldAutoReload（视图分派）──
test("shouldAutoReload: binary views always reload", () => {
  assert.equal(shouldAutoReload("binary", true), true);
  assert.equal(shouldAutoReload("binary", false), true);
});

test("shouldAutoReload: text view reloads only when clean", () => {
  assert.equal(shouldAutoReload("text", false), true);
  assert.equal(shouldAutoReload("text", true), false);
});

// ── throttleOk（自动重载节流）──
test("throttleOk: first reload (last=0) always allowed", () => {
  assert.equal(throttleOk(0, 5000, 1000), true);
});

test("throttleOk: within interval denied, at/past interval allowed", () => {
  assert.equal(throttleOk(5000, 5999, 1000), false);
  assert.equal(throttleOk(5000, 6000, 1000), true);
});

// ── sigOfFrame（帧解析）──
test("sigOfFrame: valid frame parsed", () => {
  assert.deepEqual(sigOfFrame({ mtimeMs: 123, size: 7 }), { mtimeMs: 123, size: 7 });
});

test("sigOfFrame: malformed frames → null", () => {
  assert.equal(sigOfFrame(null), null);
  assert.equal(sigOfFrame(undefined), null);
  assert.equal(sigOfFrame({}), null);
  assert.equal(sigOfFrame({ mtimeMs: NaN, size: 1 }), null);
  assert.equal(sigOfFrame({ mtimeMs: 1, size: -1 }), null);
  assert.equal(sigOfFrame({ mtimeMs: "123", size: 1 }), null);
});

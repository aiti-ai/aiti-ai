/**
 * disk-refresh.ts tests — disk-change auto-refresh decision layer (pure functions).
 *
 * Plan: docs/aiti-editor-preview-watch-refresh-plan.md §3.4
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-editor/client/src/disk-refresh.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { sameDiskSig, shouldAutoReload, sigOfFrame, mediaUrlWithBust, diffRange, previewBudget } = await import("./disk-refresh.ts");
const editorAppSrc = await readFile(new URL("./editor-app.tsx", import.meta.url), "utf8");

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

// ── mediaUrlWithBust (cache-bust fingerprint for binary previews) ──
test("mediaUrlWithBust: query-less ticketed URL gets ?v= (never &v=)", () => {
  // Ticketed media URLs carry no query of their own; `&v=` would become part of the
  // endpoint path (…/file&v=1 → 404) and spin the viewer's ticket-recovery retry.
  assert.equal(mediaUrlWithBust("/api/extensions/aiti-editor/t/abc/file", 1), "/api/extensions/aiti-editor/t/abc/file?v=1");
  assert.ok(!mediaUrlWithBust("/api/extensions/aiti-editor/t/abc/file", 1).includes("/file&"));
});

test("mediaUrlWithBust: plain URL without query/bust unchanged", () => {
  assert.equal(mediaUrlWithBust("/api/extensions/aiti-editor/t/abc/file", 0), "/api/extensions/aiti-editor/t/abc/file");
  assert.equal(mediaUrlWithBust("", 5), "");
});

test("mediaUrlWithBust: URL that already has a query uses &", () => {
  assert.equal(mediaUrlWithBust("https://x/y?type=read", 7), "https://x/y?type=read&v=7");
});

// ── source contracts: binary preview url + bounded recovery (regression pins) ──
test("editor-app builds the binary media src through mediaUrlWithBust", () => {
  // Regression: a bare `fileUrl + "&v=" + bust` appended onto the query-less
  // ticketed URL (…/file&v=1) → 404 on every disk-change frame.
  assert.ok(editorAppSrc.includes("mediaUrlWithBust(fileUrl, mediaBust)"));
  assert.ok(!editorAppSrc.includes('+ "&v=" +'));
});

test("recoverMedia only resets its retry budget outside the ticket re-issue path", () => {
  // The ticket promise must NOT clear mediaErrRef (a persistently failing URL would
  // then retry forever); the budget resets on a successful load and on Reload.
  const recoverBlock = editorAppSrc.slice(editorAppSrc.indexOf("const recoverMedia = () =>"));
  const body = recoverBlock.slice(0, recoverBlock.indexOf("return true;"));
  assert.ok(body.includes("mediaErrRef.current += 1"));
  assert.ok(!body.includes("mediaErrRef.current = 0"));
  assert.ok(editorAppSrc.includes("onSrcLoaded={() => { mediaErrRef.current = 0; }}"));
  assert.ok(editorAppSrc.includes("if (fileType !== \"text\") { mediaErrRef.current = 0; setMediaBust"));
});

// ── diffRange (minimal edit range for silent buffer updates) ──
test("diffRange: identical text → null (no undo entry, no re-render)", () => {
  assert.equal(diffRange("same", "same"), null);
});

test("diffRange: append / prepend / middle keep the untouched text out of the edit", () => {
  assert.deepEqual(diffRange("abc", "abcdef"), { start: 3, end: 3, text: "def" });
  assert.deepEqual(diffRange("abcdef", "abc"), { start: 3, end: 6, text: "" });
  assert.deepEqual(diffRange("abcXYZdef", "abc123def"), { start: 3, end: 6, text: "123" });
  assert.deepEqual(diffRange("", "hello"), { start: 0, end: 0, text: "hello" });
  assert.deepEqual(diffRange("hello", ""), { start: 0, end: 5, text: "" });
});

test("diffRange: applying the edit reproduces the new text", () => {
  const cases = [["a\nb\nc", "a\nB\nc"], ["x", "x\ny"], ["k1\nk2\nk3", "k0\nk1\nk3"]];
  for (const [oldText, newText] of cases) {
    const e = diffRange(oldText, newText);
    assert.equal(oldText.slice(0, e.start) + e.text + oldText.slice(e.end), newText);
  }
});

test("diffRange: surrogate pairs are never split (emoji edits stay valid)", () => {
  const e = diffRange("a😀b", "a😃b");
  assert.equal(e.start, 1);
  assert.equal(e.end, 3);
  assert.equal(e.text, "😃");
  // No half surrogate may end up at either boundary of the replacement.
  const before = "a😀b".charCodeAt(e.start - 1);
  assert.ok(!(before >= 0xd800 && before <= 0xdbff) || e.start === 0, "start must not split a pair");
});

// ── previewBudget (large documents widen the coalescing windows) ──
test("previewBudget: large documents stretch the windows, small ones stay tight", () => {
  const small = previewBudget(1024);
  assert.deepEqual(small, { quietMs: 250, maxMs: 1200 });
  const large = previewBudget(1024 * 1024);
  assert.ok(large.quietMs > small.quietMs && large.maxMs > small.maxMs);
});

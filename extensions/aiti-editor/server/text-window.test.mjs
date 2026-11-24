/**
 * text-window.ts tests — chunked, line-aligned reads for the large-file viewer.
 *
 * The viewer must never load a whole file: each request returns one window that ends on a
 * newline (or a UTF-8 character boundary for a single huge line), and the next window starts
 * exactly where the previous one ended, so paging is lossless.
 *
 * Run: node --test extensions/aiti-editor/text-window.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readTextWindow, countFileLines } = await import("./text-window.ts");

async function withTempFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "aiti-text-window-"));
  const file = join(dir, "sample.txt");
  try {
    writeFileSync(file, content);
    return await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("windows are line-aligned and consecutive", async () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i}-${"x".repeat(20)}`);
  const text = lines.join("\n") + "\n";
  await withTempFile(text, async (file) => {
    const w1 = await readTextWindow(file, 0, 200, 1000, "utf-8");
    assert.ok(w1.content.endsWith("\n"), "window should end on a newline");
    assert.ok(Buffer.byteLength(w1.content) <= 200);
    const w2 = await readTextWindow(file, w1.nextOffset, 200, 1000, "utf-8");
    assert.equal(w1.nextOffset + Buffer.byteLength(w2.content), Buffer.byteLength(w1.content) + Buffer.byteLength(w2.content));
    // No duplicated / skipped text when paging.
    const joined = w1.content + w2.content;
    assert.equal(joined, text.slice(0, Buffer.byteLength(joined)));
  });
});

test("maxLines caps a window of short lines", async () => {
  const text = Array.from({ length: 100 }, (_, i) => `L${i}`).join("\n") + "\n";
  await withTempFile(text, async (file) => {
    const w = await readTextWindow(file, 0, 1024 * 1024, 10, "utf-8");
    assert.equal(w.lines, 10);
    assert.equal(w.content, Array.from({ length: 10 }, (_, i) => `L${i}`).join("\n") + "\n");
  });
});

test("single huge line is cut at a UTF-8 character boundary", async () => {
  const text = "汉".repeat(500) + "\n";
  await withTempFile(text, async (file) => {
    const w = await readTextWindow(file, 0, 301, 0, "utf-8"); // 301 bytes = 100 chars + 1 byte
    assert.ok(!w.content.includes("\ufffd"), "must not split a multi-byte character");
    assert.equal(w.content, "汉".repeat(100));
    assert.equal(w.nextOffset, 300);
  });
});

test("utf-16le windows decode and align", async () => {
  const text = "alpha\nbeta\ngamma\n";
  const buf = Buffer.from(text, "utf16le");
  await withTempFile(buf, async (file) => {
    const w = await readTextWindow(file, 0, 1024, 2, "utf-16le");
    assert.equal(w.content, "alpha\nbeta\n");
    assert.equal(w.lines, 2);
    assert.equal(w.nextOffset, Buffer.byteLength("alpha\nbeta\n", "utf16le"));
  });
});

test("BOM is stripped from the first window", async () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\nworld\n")]);
  await withTempFile(buf, async (file) => {
    const w = await readTextWindow(file, 0, 4, 0, "utf-8");
    assert.equal(w.content.startsWith("\ufeff"), false);
    assert.equal(w.content, "hell");
  });
});

test("countFileLines counts lines and handles missing trailing newline", async () => {
  await withTempFile("a\nb\nc", async (file) => {
    const r = await countFileLines(file);
    assert.equal(r.lines, 3);
    assert.equal(r.partial, false);
    assert.equal(r.totalSize, 5);
  });
  await withTempFile("a\nb\nc\n", async (file) => {
    const r = await countFileLines(file);
    assert.equal(r.lines, 4); // three lines + the empty one after the trailing newline
  });
});

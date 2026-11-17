/**
 * chunkFileForSpeech + toSpeechSegments trackLines unit tests (docs/aiti-ai-speek-file-read-plan.md §6)
 * Pure-function tests, run directly with node --test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkFileForSpeech, toSpeechSegments } from "../client/src/toSpeechText.js";

function mdLines(n) {
  return Array.from({ length: n }, (_, i) => "line" + (i + 1)).join("\n");
}

test("chunkFileForSpeech: md 按一级标题分块", () => {
  const md = ["# A", "a1", "a2", "# B", "b1", "## C", "c1", "c2"].join("\n");
  const chunks = chunkFileForSpeech(md, "doc.md");
  assert.equal(chunks.length, 2); // ## is not an h1, folded into block B
  assert.equal(chunks[0].id, "fc-1");
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].text, "# A\na1\na2");
  assert.equal(chunks[1].id, "fc-2");
  assert.equal(chunks[1].startLine, 4);
  assert.equal(chunks[1].text, "# B\nb1\n## C\nc1\nc2");
});

test("chunkFileForSpeech: md 无一级标题 → 400 行强制切", () => {
  const chunks = chunkFileForSpeech(mdLines(850), "big.md");
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.startLine), [1, 401, 801]);
  assert.equal(chunks[2].text.split("\n").length, 50);
});

test("chunkFileForSpeech: md 长章节内强制切", () => {
  const md = ["# T"].concat(Array.from({ length: 900 }, (_, i) => "l" + (i + 1))).join("\n");
  const chunks = chunkFileForSpeech(md, "long.md");
  // block1 = #T + 399 lines (400 lines, startLine 1); block2 starts at line 401
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[1].startLine, 401);
  for (let k = 0; k < chunks.length; k++) {
    assert.ok(chunks[k].text.split("\n").length <= 400);
  }
});

test("chunkFileForSpeech: 非 md 每 60 行一块", () => {
  const chunks = chunkFileForSpeech(mdLines(125), "a.ts");
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.startLine), [1, 61, 121]);
  assert.equal(chunks[2].text.split("\n").length, 5);
});

test("chunkFileForSpeech: 纯空白块跳过 + 空文本 null", () => {
  assert.equal(chunkFileForSpeech("   \n  \n", "e.md"), null);
  assert.equal(chunkFileForSpeech("", "e.txt"), null);
  const chunks = chunkFileForSpeech("\n\n\n# H\ncontent\n", "g.md");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startLine, 4);
});

test("toSpeechSegments trackLines: 标题/列表/表格/代码块行号精确", () => {
  const md = [
    "# 标题A",          // 1
    "",                 // 2
    "正文一句。第二句。",  // 3
    "",                 // 4
    "- 列表1",           // 5
    "- 列表2",           // 6
    "",                 // 7
    "| a | b |",        // 8
    "|---|---|",        // 9
    "| 1 | 2 |",        // 10
    "",                 // 11
    "```js",            // 12
    "let x=1",          // 13
    "```",              // 14
  ].join("\n");
  const segs = toSpeechSegments(md, { trackLines: true });
  const byMatch = (m) => segs.find((s) => (s.match || "").includes(m) || s.text.includes(m));
  assert.equal(byMatch("标题A").line, 1);
  assert.equal(byMatch("正文一句").line, 3);
  assert.equal(byMatch("第二句").line, 3);   // paragraph sentences approximate = paragraph start line
  assert.equal(byMatch("列表1").line, 5);
  assert.equal(byMatch("列表2").line, 6);
  assert.equal(byMatch("表格").line, 8);
  assert.equal(byMatch("js代码").line, 12); // code fence line
});

test("toSpeechSegments 默认不 track（AI 消息路径零影响）", () => {
  const segs = toSpeechSegments("# T\n\nhello world。");
  for (const s of segs) assert.equal("line" in s, false);
});

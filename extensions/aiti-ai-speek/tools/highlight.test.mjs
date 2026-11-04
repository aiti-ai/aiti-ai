/**
 * aiti-ai-speek · highlight 定位逻辑单测（node --test）
 * 覆盖：断句偏移 / 行匹配打分（宽松空白、正则特殊字符安全、编号同口径、概要段不误匹配、阈值）/
 *       碎矩形合并。findSegmentRects/ drawLayer / locateInMessages 依赖 DOM（jsdom），只测纯函数。
 * 注：本文件 02585c8c 初版 import 了不存在的 findMatchIndexes/locateInText（出生即挂）；
 *     2026-09-06 重写对准真实导出，打分核心已从 locateInMessages 抽出为 scoreRowMatch 纯函数。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { splitSentencesWithOffset, mergeRowRects, normKey, scoreRowMatch } from "../client/src/highlight.js";

test("splitSentencesWithOffset: 带偏移断句", () => {
  const full = "先给结论。这是说明；还有吗？尾巴";
  const s = splitSentencesWithOffset(full);
  assert.deepEqual(s.map((x) => x.s), ["先给结论。", "这是说明；", "还有吗？", "尾巴"]);
  assert.equal(s[0].start, 0);
  assert.equal(s[0].end, 5);
  assert.equal(s[1].start, 5);
});

test("splitSentencesWithOffset: 换行即断句点，断句内 \n 折算空格", () => {
  const s = splitSentencesWithOffset("总结一下，\n\n就是改用缓存。");
  assert.deepEqual(s.map((x) => x.s), ["总结一下，", "就是改用缓存。"]);
  assert.equal(s[1].start, 7); // 连续换行后第二句起点落在「就」
});

test("normKey: 去全部空白（朗读句带空格 vs DOM 换行 → 同口径）", () => {
  assert.equal(normKey("总结一下， 就是改用缓存。"), normKey("总结一下，\n\n就是改用缓存。"));
  assert.equal(normKey("a b\tc"), "abc");
});

test("scoreRowMatch: 朗读句与 DOM 行精确同文（含空白差异）= 1", () => {
  assert.equal(scoreRowMatch("总结一下， 就是改用缓存。", "总结一下，\n\n就是改用缓存。"), 1);
});

test("scoreRowMatch: 行包含朗读句（朗读句是行片段）= 0.9", () => {
  assert.equal(scoreRowMatch("(a, b)", "函数 (a, b) 返回 a + b * c。"), 0.9);
  assert.equal(scoreRowMatch("a + b * c。", "函数 (a, b) 返回 a + b * c。"), 0.9);
});

test("scoreRowMatch: 正则特殊字符安全（括号/星号不炸）", () => {
  assert.ok(scoreRowMatch("(a, b)", "函数 (a, b)") > 0);
  assert.ok(scoreRowMatch("a + b * c。", "a + b * c。") === 1);
});

test("scoreRowMatch: 行首编号两侧同剥（markdown \"2.\" vs 朗读「二，」同口径）", () => {
  // 朗读侧读编号「二，」，DOM 行无 marker → 剥编号后精确命中
  assert.equal(scoreRowMatch("二，增加 overflowUp 检查", "2. 增加 overflowUp 检查"), 1);
  assert.equal(scoreRowMatch("一、修正 mh 估值", "修正 mh 估值"), 1);
});

test("scoreRowMatch: 概要段不误匹配（表格概要 vs 代码行，LCS 比例低于阈值）", () => {
  const s = scoreRowMatch("这是一张 3 行 2 列的表格", "接下来是一段js代码，约2 行");
  assert.ok(s < 0.6, "LCS 比例应 <0.6（实际 " + s + "）");
});

test("scoreRowMatch: 中文标点变体（。vs .）不硬命中满分", () => {
  const s = scoreRowMatch("v1。2", "版本 v1.2.3 可用。");
  assert.ok(s < 1, "标点不同不应精确命中（实际 " + s + "）");
  assert.notEqual(s, 0.9, "非包含关系不应拿包含分");
});

test("scoreRowMatch: 空输入返回 0", () => {
  assert.equal(scoreRowMatch("", "任意"), 0);
  assert.equal(scoreRowMatch("任意", ""), 0);
});

test("mergeRowRects: 同行的 行内代码+文本 碎矩形合并成整行", () => {
  const codeRect = { left: 600, top: 390, width: 70, height: 17 };
  const textRect = { left: 674, top: 390, width: 120, height: 17 };
  const merged = mergeRowRects([codeRect, textRect]);
  // 同行 → 应合并为一个覆盖完整行的矩形
  assert.equal(merged.length, 1);
  assert.ok(merged[0].width >= 70 + 120 - 4, "宽度覆盖 code+文本（含间隙）");
  assert.equal(merged[0].top, 390);
});

test("mergeRowRects: 不同行的 rect 不合并", () => {
  const a = { left: 600, top: 390, width: 100, height: 17 };
  const b = { left: 600, top: 450, width: 100, height: 17 };
  assert.equal(mergeRowRects([a, b]).length, 2);
});

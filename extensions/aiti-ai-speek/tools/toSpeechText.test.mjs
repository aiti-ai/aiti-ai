/**
 * aiti-ai-speek · toSpeechText 单测（node --test）
 *
 * 覆盖 PLAN §6 核心：总结识别 / 提问识别 / 代码块概要化 / 表格概要化 /
 * 列表口播 / 清理（去 **、链接、公式口播）/ 仅要点过滤。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanMarkdown, splitSentences, classifySentence, toSpeechSegments, filterSegments, SEG,
} from "../client/src/toSpeechText.js";

test("cleanMarkdown: 去粗体/斜体/链接/行内代码/图片，公式口播", () => {
  const out = cleanMarkdown("**重点** 和 *斜* 和 [链接](http://x) 和 `code` 和 ![图](a.png)，√2≥1");
  assert.ok(!out.includes("**"));
  assert.ok(!out.includes("[链接]"));
  assert.ok(!out.includes("`"));
  assert.ok(out.includes("根号2大于等于1"));
});

test("splitSentences: 按中文句末标点拆句", () => {
  const s = splitSentences("先给你结论。这是详细说明；还有吗？没了！");
  assert.deepEqual(s, ["先给你结论。", "这是详细说明；", "还有吗？", "没了！"]);
});

test("classifySentence: 提问/总结/正文", () => {
  assert.equal(classifySentence("你觉得这个方案怎么样？"), SEG.QUESTION);
  assert.equal(classifySentence("需要我帮你改一下吗？"), SEG.QUESTION);
  assert.equal(classifySentence("总结一下，就是改用缓存。"), SEG.SUMMARY);
  assert.equal(classifySentence("这里是一段普通说明。"), SEG.BODY);
});

test("toSpeechSegments: 代码块 → 概要化不逐行读", () => {
  const md = "```js\nfunction hello() { return 1; }\n// 计算\n```\n正文一句。";
  const segs = toSpeechSegments(md);
  const codeSeg = segs.find((s) => s.kind === SEG.NOTE && s.text.includes("代码"));
  assert.ok(codeSeg, "应有代码概要段");
  assert.ok(!codeSeg.text.includes("function hello"), "不逐行读代码");
  assert.ok(codeSeg.text.includes("hello") || codeSeg.text.includes("计算"), "带实现提示");
});

test("toSpeechSegments: 表格 → 概要化（表头/示例/结论）", () => {
  const md = "| 方案 | 耗时 |\n| --- | --- |\n| A | 1h |\n| B | 2h |\n选 B。";
  const segs = toSpeechSegments(md);
  const tableSeg = segs.find((s) => s.kind === SEG.NOTE && s.text.includes("表格"));
  assert.ok(tableSeg, "应有表格概要段");
  assert.ok(tableSeg.text.includes("表头") && tableSeg.text.includes("方案"));
  assert.ok(tableSeg.text.includes("结论"));
});

test("toSpeechSegments: 总结标题 → summary 段（必读）", () => {
  const md = "## 总结\n改用缓存后性能提升。\n\n## 其他\n细节说明。";
  const segs = toSpeechSegments(md);
  const sum = segs.find((s) => s.kind === SEG.SUMMARY);
  assert.ok(sum, "总结标题应标 summary");
  assert.ok(sum.text.includes("总结"));
  // match=原文，不带「第X部分：」前缀——用于高亮定位到 DOM 里的 h2 文本
  assert.ok(sum.match, "标题段应有 match 原文");
  assert.ok(!sum.match.includes("第"), "match 不带序号前缀");
  assert.equal(sum.match, "总结");
});

test("toSpeechSegments: 正文句 match=lean 原文（公式符号留在 match，口播在 text）", () => {
  const md = "复杂度是 O(n²)，√2≥1。";
  const segs = toSpeechSegments(md);
  const body = segs.find((s) => (s.match || "").includes("2≥"));
  assert.ok(body, "原文含 ≥ 符号应作为 match 保留");
  assert.ok(body.text.includes("大于等于"), "text 应口播化");
  assert.ok(body.match.includes("≥"), "match 保留原文 ≥");
});

test("filterSegments: essentials 只留 summary/question/heading", () => {
  const segs = [
    { kind: SEG.SUMMARY, text: "a" },
    { kind: SEG.QUESTION, text: "b" },
    { kind: SEG.BODY, text: "c" },
    { kind: SEG.HEADING, text: "d" },
  ];
  const filtered = filterSegments(segs, "essentials");
  assert.deepEqual(filtered.map((s) => s.text), ["a", "b", "d"]);
});

test("toSpeechSegments: 段落拆句带类型（正文默认 body）", () => {
  const md = "核心是缓存。具体做法如下。";
  const segs = toSpeechSegments(md);
  assert.ok(segs.some((s) => s.kind === SEG.SUMMARY && s.text.includes("缓存")));
  assert.ok(segs.some((s) => s.kind === SEG.BODY && s.text.includes("具体做法")));
});

test("toSpeechSegments: 空/纯 markdown 结构安全", () => {
  assert.deepEqual(toSpeechSegments(""), []);
  assert.deepEqual(toSpeechSegments("   \n---\n\n"), []);
});

test("toSpeechSegments: 有序列表读编号（第一/二…），每项独立 match 可高亮", () => {
  const md = "1. 修正 mh 估值\n2. 增加 overflowUp 检查\n3. 第三项";
  const segs = toSpeechSegments(md);
  const list = segs.filter((s) => s.match);
  assert.ok(list.length >= 3, "每项应独立分段");
  assert.ok(list[0].text.includes("一") && list[0].text.includes("修正"), "第一项读编号 一");
  assert.ok(list[1].text.includes("二") && list[1].text.includes("overflowUp"), "第二项读编号 二");
  // match=leanText 原文：leanText 设计上剥 CJK 邻接空格（朗读更顺）；DOM 高亮侧 normKey 去全部空白后同口径，定位不受影响
  assert.equal(list[1].match, "增加overflowUp检查", "match=该项 lean 原文（与 DOM 侧 normKey 同口径，可高亮）");
});

test("toSpeechSegments: 无序列表不读编号，match 可高亮", () => {
  const md = "- 选项A\n- 选项B";
  const segs = toSpeechSegments(md);
  const list = segs.filter((s) => s.match);
  assert.ok(list.length >= 2);
  assert.ok(!/第|，/.test(list[0].text), "无序项直接读内容");
  assert.equal(list[0].match, "选项A");
});

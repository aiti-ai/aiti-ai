/**
 * viewer-text.ts 纯函数单测（查看器聊天式消息区的分段/折叠/分桶/搜索面规则）。
 * 运行：node --test --experimental-strip-types client/tests/viewer-text.test.mjs
 * 规则依据：docs/session-manager-viewer-chat-plan.md §3.3
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAMP_CHARS, CLAMP_LINES,
  roleOf, isToolCard, bucketOf, dayKey, fmtTime, shortModel, countLines, firstLine,
  isLong, clampText, splitToolLines, toolCardText, searchHaystack,
} from "../src/viewer-text.ts";

test("roleOf / isToolCard / bucketOf：user、assistant、toolResult 三分；结构化 tool 的 assistant 行归工具卡", () => {
  assert.equal(roleOf({ role: "user" }), "user");
  assert.equal(roleOf({ role: "assistant" }), "assistant");
  assert.equal(roleOf({ role: "toolResult" }), "toolResult");
  assert.equal(roleOf({ role: "system" }), "assistant", "未知角色按助手侧展示");

  assert.equal(isToolCard({ role: "toolResult" }), true);
  assert.equal(isToolCard({ role: "assistant" }), false);
  assert.equal(isToolCard({ role: "assistant", tool: { name: "bash", input: null } }), true, "opencode 系结构化 tool");

  assert.equal(bucketOf({ role: "assistant", tool: { name: "read", input: { path: "a" } } }), "toolResult");
  assert.equal(bucketOf({ role: "assistant" }), "assistant");
  assert.equal(bucketOf({ role: "user" }), "user");
});

test("dayKey：本地日期键；缺失/无效 → 空串（不触发分隔线）", () => {
  const d = new Date(2026, 8, 7, 14, 2); // 本地 2026-09-07 14:02
  assert.equal(dayKey(d.toISOString()), "2026-09-07");
  assert.equal(dayKey(null), "");
  assert.equal(dayKey(undefined), "");
  assert.equal(dayKey("not-a-date"), "");
  // 同一天不同时刻同键，跨天不同键
  const d2 = new Date(2026, 8, 7, 23, 59);
  const d3 = new Date(2026, 8, 8, 0, 1);
  assert.equal(dayKey(d2.toISOString()), dayKey(d.toISOString()));
  assert.notEqual(dayKey(d3.toISOString()), dayKey(d.toISOString()));
});

test("fmtTime：有效时间出 HH:mm 形态；缺失/无效 → 空串", () => {
  assert.equal(fmtTime(null), "");
  assert.equal(fmtTime("garbage"), "");
  const s = fmtTime(new Date(2026, 8, 7, 9, 5).toISOString());
  assert.match(s, /\d{1,2}:\d{2}/, "本地化时间串至少含 h:mm");
  assert.ok(!/\d{1,2}:\d{2}:\d{2}/.test(s), "不带秒");
});

test("shortModel：去 provider 前缀；无前缀原样；空 → 空", () => {
  assert.equal(shortModel("bigmodel/GLM-5.3"), "GLM-5.3");
  assert.equal(shortModel("anthropic/claude/opus"), "opus", "取最后一段");
  assert.equal(shortModel("gpt-4o"), "gpt-4o");
  assert.equal(shortModel(undefined), "");
});

test("countLines / firstLine", () => {
  assert.equal(countLines(""), 1);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\nb\nc"), 3);
  assert.equal(firstLine("  hello \nworld"), "hello");
  assert.equal(firstLine("single"), "single");
});

test("isLong / clampText：按行、按字符双阈值；预览末尾加 …", () => {
  const shortText = "x".repeat(CLAMP_CHARS);
  assert.equal(isLong(shortText), false, "恰好等于阈值不算长");
  assert.equal(isLong("x".repeat(CLAMP_CHARS + 1)), true);
  const manyLines = Array.from({ length: CLAMP_LINES + 1 }, (_, i) => `l${i}`).join("\n");
  assert.equal(isLong(manyLines), true);

  const clampedLines = clampText(manyLines);
  assert.equal(countLines(clampedLines), CLAMP_LINES, "按行截到阈值");
  assert.ok(clampedLines.endsWith("…"));

  const longLine = "y".repeat(CLAMP_CHARS * 2);
  const clampedChars = clampText(longLine);
  assert.equal(clampedChars.length, CLAMP_CHARS + 1, "按字符截到阈值 + …");
});

test("splitToolLines：🛠 调用行与普通段落分段，相邻同类合并", () => {
  const text = [
    "好的，我先看一下。",
    "第二段。",
    "🛠 read {\"path\":\"a.ts\"}",
    "🛠 edit {\"path\":\"b.ts\"}",
    "改完了。",
  ].join("\n");
  const segs = splitToolLines(text);
  assert.deepEqual(segs.map((s) => s.tool), [false, true, false]);
  assert.equal(segs[0].text, "好的，我先看一下。\n第二段。");
  assert.equal(segs[1].text, "🛠 read {\"path\":\"a.ts\"}\n🛠 edit {\"path\":\"b.ts\"}");
  assert.equal(segs[2].text, "改完了。");
  // 只有调用行
  assert.deepEqual(splitToolLines("🛠 bash ls"), [{ tool: true, text: "🛠 bash ls" }]);
  // 空串 → 一段空的普通段落（渲染为空行，不崩）
  assert.deepEqual(splitToolLines(""), [{ tool: false, text: "" }]);
});

test("toolCardText：结构化 tool 拆输入/输出并合并全文；toolResult 只有 text", () => {
  const structured = toolCardText({ role: "assistant", tool: { name: "bash", input: { cmd: "ls" }, output: "a\nb" } });
  assert.equal(structured.inText, JSON.stringify({ cmd: "ls" }, null, 2));
  assert.equal(structured.outText, "a\nb");
  assert.equal(structured.full, `${structured.inText}\na\nb`);

  const noOutput = toolCardText({ role: "assistant", tool: { name: "bash", input: { cmd: "ls" } } });
  assert.equal(noOutput.outText, "");
  assert.equal(noOutput.full, noOutput.inText, "无输出时全文只含输入，不留空行");

  const plain = toolCardText({ role: "toolResult", text: "result text" });
  assert.equal(plain.inText, "");
  assert.equal(plain.outText, "result text");
  assert.equal(plain.full, "result text");
});

test("searchHaystack：结构化 tool 的名字/输入/输出都可搜；普通消息只搜 text", () => {
  const hay = searchHaystack({ role: "assistant", tool: { name: "grep", input: { pattern: "needle" }, output: "found" }, text: "🛠 grep" });
  assert.ok(hay.includes("grep") && hay.includes("needle") && hay.includes("found"));
  assert.equal(searchHaystack({ role: "user", text: "hello" }), "hello");
  assert.equal(searchHaystack({ role: "user" }), "");
});

/**
 * session-manager — claude-like adapter 结构化工具行（IndexedMessage.tool）。
 *
 * 钉死行为（2026-09-21：qoder 冷恢复回放丢原生工具卡片，根因在此——tool_use 只折成
 * 🛠 文本行，消费方 seedHistory 无从还原 toolCall）：
 *   1. 仅含一个 tool_use 且无正文的 assistant 行 → 带 tool{callID,name,input}，text 仍是
 *      🛠 兜底行（搜索/预览/to-pi 等消费方零感知）；
 *   2. 其后 user 行的 tool_result 按 tool_use_id 回填 output/isError（该 user 行正文为空
 *      本就被跳过，不回填就永远只有调用没有输出）；
 *   3. 混排（正文+工具）或一行多工具 → 不给 tool，避免消费方命中 tool 后跳正文。
 *   4. Image rows (a user pastes a screenshot): both the URL form (Qoder uploads it
 *      to its own object storage) and the base64 form land in IndexedMessage.images,
 *      and an image-only row still becomes a row (dropping it lost the whole message).
 *
 * Run: node --test pi-web-ext/session-manager/lib/agents/claude-like.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { createClaudeLikeAdapter } = await import("./claude-like.ts");

const ROOT = mkdtempSync(join(tmpdir(), "claude-like-adapter-"));
const adapter = createClaudeLikeAdapter("qoder", "Qoder", ".qoder", "projects");

function parse(lines) {
  const path = join(ROOT, `${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return adapter.parse({ sid: "s1", path });
}

const LINE = (type, role, content, extra = {}) => ({ type, timestamp: "2026-09-21T00:00:00.000Z", cwd: "/w", message: { role, content }, ...extra });
const CALL = (id, name, input) => LINE("assistant", "assistant", [{ type: "tool_use", id, name, input }]);
const RESULT = (id, content, isError = false) => LINE("user", "user", [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }]);
const toolEntry = (parsed, n = 0) => parsed.messages.filter((m) => m.tool).slice(n)[0]?.tool;

test("单工具行带结构化 tool，🛠 文本兜底行保留", () => {
  const parsed = parse([
    LINE("user", "user", "跑个命令"),
    CALL("tu_1", "Bash", { command: "ls -la", description: "list" }),
    RESULT("tu_1", "CHANGELOG.md\ndist\n"),
  ]);
  assert.equal(parsed.messages.length, 2, "纯 tool_result 的 user 行不单独成行");
  const entry = parsed.messages[1];
  assert.equal(entry.role, "assistant");
  assert.equal(entry.toolName, "Bash", "工具名单列（索引 messages.tool_name 列消费）");
  assert.match(entry.text, /^🛠 Bash \{"command":"ls -la"/, "text 仍是兜底展示行");
  assert.deepEqual(entry.tool, {
    callID: "tu_1", name: "Bash", input: { command: "ls -la", description: "list" }, output: "CHANGELOG.md\ndist",
  }, "output 两侧留白收掉（全空则整个字段缺席）");
});

test("tool_result 为 text 块数组/is_error/无 id 匹配三种形态都收口", () => {
  const parsed = parse([
    CALL("tu_a", "Read", { path: "/x" }),
    RESULT("tu_a", [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }, { type: "image", source: {} }], true),
    CALL("tu_b", "Read", { path: "/y" }),
    RESULT("tu_other", "与任何调用都不配对"),
  ]);
  const tools = parsed.messages.filter((m) => m.tool).map((m) => m.tool);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].output, "第一段\n第二段");
  assert.equal(tools[0].isError, true);
  assert.equal(tools[1].output, undefined, "id 不匹配的 result 不落任何工具行");
});

test("混排行与多工具行不给 tool（正文优先，退回 🛠 文本）", () => {
  const mixed = parse([LINE("assistant", "assistant", [
    { type: "text", text: "我来查一下。" },
    { type: "tool_use", id: "tu_m", name: "Grep", input: { pattern: "hook" } },
  ])]);
  assert.equal(mixed.messages.length, 1);
  assert.equal(mixed.messages[0].tool, undefined);
  assert.equal(mixed.messages[0].text, "我来查一下。\n🛠 Grep {\"pattern\":\"hook\"}");

  const two = parse([LINE("assistant", "assistant", [
    { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "a" } },
    { type: "tool_use", id: "tu_2", name: "Bash", input: { command: "b" } },
  ])]);
  assert.equal(two.messages[0].tool, undefined, "一行两调用无法用一个 tool 表达");
  assert.equal((two.messages[0].text.match(/🛠/g) || []).length, 2, "两次调用都在兜底文本里");
});

test("input 为 JSON 字符串时解析；不可解析则空入参（仍带结构化名）", () => {
  const json = parse([LINE("assistant", "assistant", [{ type: "tool_use", id: "t1", name: "Edit", input: '{"path":"/a"}' }])]);
  assert.deepEqual(json.messages[0].tool.input, { path: "/a" });
  const junk = parse([LINE("assistant", "assistant", [{ type: "tool_use", id: "t2", name: "Edit", input: "not json" }])]);
  assert.deepEqual(junk.messages[0].tool.input, {});
  assert.match(junk.messages[0].text, /🛠 Edit not json/);
});

test("未收到结果的调用不带 output（会话中断时前端只渲调用卡）", () => {
  const parsed = parse([CALL("tu_open", "Bash", { command: "sleep 1" })]);
  assert.deepEqual(toolEntry(parsed), { callID: "tu_open", name: "Bash", input: { command: "sleep 1" } });
});

test("巨型输出截断到 4000 字符", () => {
  const parsed = parse([CALL("tu_big", "Bash", { command: "cat huge" }), RESULT("tu_big", "x".repeat(9000))]);
  assert.equal(toolEntry(parsed).output.length, 4000);
});

test("sidechain（子代理）行既不参与配对也不成行", () => {
  const parsed = parse([
    CALL("tu_side", "Bash", { command: "outer" }),
    LINE("assistant", "assistant", [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "inner" } }], { isSidechain: true }),
    RESULT("tu_1", "inner output"),
    RESULT("tu_side", "outer output"),
  ]);
  const tools = parsed.messages.filter((m) => m.tool).map((m) => m.tool);
  assert.equal(tools.length, 1, "子代理调用不进主时间线");
  assert.equal(tools[0].callID, "tu_side");
  assert.equal(tools[0].output, "outer output");
});

test("图片行：URL 形式与 base64 形式都进 images，无文字的纯图行不丢", () => {
  const url = "https://qoder-cn-vl-private.example.test/cloud/x/deadbeef.png?Expires=1792385140&Signature=a%2Fb";
  const parsed = parse([
    LINE("user", "user", [{ type: "image", source: { type: "url", url } }, { type: "text", text: "顶部横幅的图怎么配的" }]),
    LINE("user", "user", [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } }]),
    LINE("assistant", "assistant", [{ type: "text", text: "看这里" }]),
  ]);
  assert.equal(parsed.messages.length, 3, "纯图行也是真实消息");
  assert.deepEqual(parsed.messages[0].images, [{ mime: "image/png", dataUrl: url }], "远程 URL 原样带出（扩展名定 mime）");
  assert.equal(parsed.messages[0].text, "顶部横幅的图怎么配的");
  assert.deepEqual(parsed.messages[1], {
    entryId: "2", role: "user", ts: "2026-09-21T00:00:00.000Z", text: "",
    images: [{ mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,QUJD" }],
  });
  assert.equal(parsed.messages[2].images, undefined, "assistant 行不带图");
  assert.equal(parsed.meta.messageCount, 3);
  assert.equal(parsed.meta.firstMessage, "顶部横幅的图怎么配的");
});

test("首个 user 行只有图时 firstMessage 是占位（会话列表不空白）", () => {
  const parsed = parse([LINE("user", "user", [{ type: "image", source: { type: "url", url: "https://x.test/a.webp" } }])]);
  assert.equal(parsed.meta.firstMessage, "[image]");
  assert.deepEqual(parsed.messages[0].images, [{ mime: "image/webp", dataUrl: "https://x.test/a.webp" }]);
});

test.after(() => { rmSync(ROOT, { recursive: true, force: true }); });

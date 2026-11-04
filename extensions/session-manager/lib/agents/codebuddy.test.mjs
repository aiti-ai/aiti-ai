/**
 * session-manager — CodeBuddy adapter tests（2.148.0 真实样本行钉死线格式）。
 *
 * Run: node --test pi-web-ext/session-manager/lib/agents/codebuddy.test.mjs
 *
 * 样本来源：`npx -y @tencent-ai/codebuddy-code -p "说两个字:你好"` 落盘
 * ~/.codebuddy/projects/tmp-workbuddy-probe/01a08a44-….jsonl（2026-09-10 实测，
 * 未登录 auth-stub 轮 + 合成登录轮）。行形状与 claude 非同构（见 codebuddy.ts 头注）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离真实 ~/.codebuddy（adapter root 走 AITI_CODEBUDDY_HOME，对齐 zcode 先例）
const ROOT = mkdtempSync(join(tmpdir(), "codebuddy-adapter-test-"));
process.env.AITI_CODEBUDDY_HOME = ROOT;

const { createCodebuddyAdapter } = await import("./codebuddy.ts");

/** 真实样本行（auth-stub 轮，逐字节保留字段位）+ 合成登录轮（model/tool_use/毫秒时间戳）。
 *  写入 ROOT/projects/<dir>/（AITI_CODEBUDDY_HOME 语义 = ~/.codebuddy 层级）。 */
function writeSession(dirName, sid, lines) {
  const d = join(ROOT, "projects", dirName);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return join(d, `${sid}.jsonl`);
}

const SID = "01a08a44-f246-7b01-80d0-5af8249e266d";

// 真实样本：目录编码无前导 "-"；timestamp 数字毫秒；行顶层 role/content；id/parentId 替代 uuid
const realUserRow = {
  id: "01a08a44-f3c6-78a6-b40c-df2507a346bd",
  timestamp: 1789026169807,
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "说两个字:你好" }],
  providerData: { agent: "cli", conversationRequestId: "01a08a44f3cf77c9885697cf441c77a9" },
  __codebuddyLocal: { sensitiveUserInputReviewed: true },
  sessionId: SID,
  cwd: "/tmp/workbuddy-probe",
};
const realAssistantRow = {
  id: "01a08a44-f442-7039-a430-ce0072756d54",
  parentId: "01a08a44-f3c6-78a6-b40c-df2507a346bd",
  timestamp: 1789026169939,
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "Authentication required. Please use /login command to sign in to your account" }],
  status: "incomplete",
  providerData: { skipRun: true, error: { message: "Authentication required" }, agent: "cli" },
  sessionId: SID,
  cwd: "/tmp/workbuddy-probe",
};
// 非会话行（必须跳过）：
const snapshotRow = {
  timestamp: 1789026169826, type: "file-history-snapshot", messageId: "01a08a44-f3c6-78a6-b40c-df2507a346bd",
  isSnapshotUpdate: false, snapshot: {}, cwd: "/tmp/workbuddy-probe",
};
// 合成登录轮：assistant 带 model + tool_use + thinking（thinking 不进时间线文本）
const authedAssistantRow = {
  id: "aaa", parentId: "x", timestamp: 1789026170000, type: "message", role: "assistant",
  model: "glm-5.3",
  content: [
    { type: "thinking", thinking: "内部推理不应出现在文本里" },
    { type: "tool_use", name: "Read", input: { path: "/tmp/x" } },
    { type: "output_text", text: "你好" },
  ],
  status: "complete", sessionId: SID, cwd: "/tmp/workbuddy-probe",
};

const path = writeSession("tmp-workbuddy-probe", SID, [realUserRow, snapshotRow, realAssistantRow, authedAssistantRow]);

test("probe 发现 jsonl 且不解析内容", () => {
  const a = createCodebuddyAdapter();
  // 用 HOME 注入隔离真实 ~/.codebuddy（adapter root 基于 homedir）
  const p = a.probe();
  assert.equal(p.ok, true);
  assert.ok(p.count >= 1);
  assert.ok(p.watermarkMs > 0);
});

test("list 抓 uuid sid", () => {
  const a = createCodebuddyAdapter();
  const refs = a.list().filter((r) => r.sid === SID);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].path, path);
});

test("parse：真实样本行形状（顶层 role/content + 毫秒时间戳 + thinking 不进文本 + model 提取）", () => {
  const a = createCodebuddyAdapter();
  const parsed = a.parse({ sid: SID, path });
  assert.ok(parsed);
  const { meta, messages } = parsed;
  // 行内 cwd 权威（路径解码 tmp-workbuddy-probe → /tmp/workbuddy/probe 会失真，行内字段兜底）
  assert.equal(meta.cwd, "/tmp/workbuddy-probe");
  assert.equal(meta.messageCount, 3);
  assert.equal(meta.created, new Date(1789026169807).toISOString());
  assert.equal(meta.modified, new Date(1789026170000).toISOString());
  assert.equal(meta.firstMessage, "说两个字:你好");
  assert.equal(meta.model, "glm-5.3");
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].text, "说两个字:你好");
  assert.equal(messages[1].role, "assistant");
  assert.ok(messages[1].text.includes("Authentication required"));
  assert.equal(messages[2].model, "glm-5.3");
  assert.ok(messages[2].text.includes("🛠 Read"));
  assert.ok(messages[2].text.includes("你好"));
  assert.ok(!messages[2].text.includes("内部推理"));
  // 时间戳归一为 ISO
  assert.equal(messages[0].ts, new Date(1789026169807).toISOString());
});

test("listFresh 报毫秒级 modified", async () => {
  const a = createCodebuddyAdapter();
  const fresh = (await a.listFresh()).find((f) => f.sid === SID);
  assert.ok(fresh);
  assert.ok(Math.abs(fresh.timeUpdatedMs - Date.now()) < 60_000); // statFreshList = 文件 mtime（现在）
});

test("roots 指向隔离目录（AITI_CODEBUDDY_HOME/projects）", () => {
  const a = createCodebuddyAdapter();
  assert.deepEqual(a.roots(), [join(ROOT, "projects")]);
});

test("脏行容错：坏 JSON 行不拖垮整个会话", () => {
  const sid2 = "ffffffff-0000-0000-0000-000000000001";
  const d = join(ROOT, "projects", "dirty");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${sid2}.jsonl`), [
    "{broken json",
    JSON.stringify(realUserRow),
    "",
  ].join("\n"));
  const a = createCodebuddyAdapter();
  const parsed = a.parse({ sid: sid2, path: join(d, `${sid2}.jsonl`) });
  assert.ok(parsed);
  assert.equal(parsed.messages.length, 1);
});

test("真实工具会话行型：function_call/result 折叠 + reasoning 模型提取（2026-09-11 sleep-30 会话钉死）", () => {
  const sid3 = "01a08c20-8c1a-7e6a-8358-8af4464cac0d";
  const p3 = writeSession("tmp", sid3, [
    // 用户消息
    { id: "m0", timestamp: 1789057343200, type: "message", role: "user", content: [{ type: "input_text", text: "请用 Bash 工具执行 sleep 30" }], sessionId: sid3, cwd: "/tmp" },
    // reasoning 行：思维不进时间线，但 providerData.model 是真实模型
    { id: "r1", parentId: "m0", timestamp: 1789057343318, type: "reasoning", content: [], rawContent: [{ type: "reasoning_text", text: "内部推理" }],
      providerData: { model: "hy4-preview", agent: "cli" }, sessionId: sid3, cwd: "/tmp" },
    // function_call：arguments 为 JSON 字符串
    { id: "fc1", parentId: "r1", timestamp: 1789057343342, type: "function_call", callId: "chatcmpl-tool-1", name: "Bash",
      arguments: '{"command": "sleep 30", "timeout": 60000}', sessionId: sid3, cwd: "/tmp" },
    // function_call_result：折叠进 fc1 的 tool.output
    { id: "fcr1", parentId: "fc1", timestamp: 1789057373391, type: "function_call_result", name: "Bash", callId: "chatcmpl-tool-1", status: "completed",
      output: { type: "text", text: "Command: sleep 30\nExit Code: 0" }, sessionId: sid3, cwd: "/tmp" },
    // assistant 文本
    { id: "m1", timestamp: 1789057374000, type: "message", role: "assistant", model: "hy4-preview", content: [{ type: "output_text", text: "done" }], status: "complete", sessionId: sid3, cwd: "/tmp" },
  ]);
  const a = createCodebuddyAdapter();
  const parsed = a.parse({ sid: sid3, path: p3 });
  assert.ok(parsed);
  const { meta, messages } = parsed;
  assert.equal(meta.model, "hy4-preview", "reasoning providerData.model 提取");
  // 时间线：user → assistant🛠(折叠 output) → assistant done
  assert.equal(messages.length, 3, `应为 3 条（reasoning/result 不单独成行），实际 ${messages.length}`);
  assert.equal(messages[1].toolName, "Bash");
  assert.ok(messages[1].text.startsWith("🛠 Bash"));
  assert.deepEqual(messages[1].tool, { callID: "chatcmpl-tool-1", name: "Bash", input: { command: "sleep 30", timeout: 60000 }, output: "Command: sleep 30\nExit Code: 0" });
  assert.ok(!JSON.stringify(messages).includes("内部推理"), "reasoning 文本不进时间线");
  assert.equal(meta.lastMessage, "done");
});

test("孤儿 function_call_result（无匹配 callId）→ 独立 toolResult 行", () => {
  const sid4 = "ffffffff-0000-0000-0000-000000000002";
  const p4 = writeSession("orphan", sid4, [
    { id: "x1", timestamp: 1789057400000, type: "function_call_result", name: "Read", callId: "no-owner", status: "completed",
      output: { type: "text", text: "file content here" }, sessionId: sid4, cwd: "/tmp" },
  ]);
  const a = createCodebuddyAdapter();
  const parsed = a.parse({ sid: sid4, path: p4 });
  assert.ok(parsed);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].role, "toolResult");
  assert.equal(parsed.messages[0].toolName, "Read");
  assert.equal(parsed.messages[0].text, "file content here");
});

test("cleanup", () => { rmSync(ROOT, { recursive: true, force: true }); });

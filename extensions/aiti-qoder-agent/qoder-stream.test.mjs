/**
 * aiti-qoder-agent — ACP 流式组装单测（text / thinking 双气泡线 + 工具卡直出）。
 *
 * 钉死 ACP session/update → pi message_update 映射（2026-11-13 ACP 重写）：
 *   1. 首个 chunk 前有 message_start 空骨架（宿主 reducer 按 contentIndex 建块的前提）；
 *   2. agent_thought_chunk / agent_message_chunk → thinking/text 两条独立气泡线
 *      （thinking_start/delta/end + text_*，contentIndex 各自连续）；
 *   3. tool_call → 原生 assistant toolCall 卡（_meta.qoder.toolName 优先于 title），
 *      tool_call_update(completed/failed) → toolResult（rawOutput / content[].text 回退）；
 *   4. 回合收口（session/prompt 响应）→ 气泡 flush 落 message_end + agent_settled；
 *   5. 容错：孤儿 chunk 就地开块；工具空输出占位文案；失败工具带 isError。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/qoder-stream.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 状态写盘隔离（session/new 换绑会 rename 模型状态文件）：不隔离就刷真实 ~/.pi/agent/ext-agents。
const sandbox = mkdtempSync(join(tmpdir(), "qoder-stream-"));
process.env.EXT_MODEL_STATE_DIR = join(sandbox, "ext-agents");
process.env.PI_MODELS_CONFIG_PATH = join(sandbox, "models.json");

const { QoderHandle } = await import("./index.ts");
const { makeReadyHandle, flush } = await import("./qoder-acp-stub.mjs");

test.after(() => { rmSync(sandbox, { recursive: true, force: true }); });

const ame = (events) => events.filter((e) => e.type === "message_update").map((e) => e.assistantMessageEvent);

test("首个 chunk 前有 message_start 空骨架", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle);
  stub.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好" } });
  await flush();
  const start = events.find((e) => e.type === "message_start");
  assert.equal(start?.role, "assistant");
  assert.deepEqual(start?.message?.content, []);
  assert.equal(start?.message?.role, "assistant");
  await h.dispose();
});

test("thinking + text 双线：各自 contentIndex，互不占位", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle);
  stub.notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "先想" } });
  stub.notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "一想" } });
  stub.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "正文" } });
  stub.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "续写" } });
  await flush();
  const seq = ame(events).map((e) => e.type);
  assert.deepEqual(seq, ["thinking_start", "thinking_delta", "thinking_delta", "text_start", "text_delta", "text_delta"]);
  const thinkingIdx = ame(events).find((e) => e.type === "thinking_delta")?.contentIndex;
  const textIdx = ame(events).find((e) => e.type === "text_delta")?.contentIndex;
  assert.notEqual(thinkingIdx, textIdx, "thinking 与 text 线 contentIndex 必须不同");
  await h.dispose();
});

test("孤儿 chunk（无 thinking_start 先行）就地开块不丢正文", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle);
  stub.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "直接正文" } });
  await flush();
  const deltas = ame(events).filter((e) => e.type === "text_delta");
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delta, "直接正文");
  await h.dispose();
});

test("tool_call → assistant toolCall 卡（_meta.qoder.toolName 优先）；completed 更新 → toolResult", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle);
  stub.notify({
    sessionUpdate: "tool_call",
    toolCallId: "call_1",
    status: "pending",
    title: "Edit file",
    kind: "edit",
    rawInput: { command: "sleep 2" },
    _meta: { qoder: { toolName: "Bash" } },
  });
  await flush();
  const card = events.filter((e) => e.type === "message_end").map((e) => e.message)
    .find((m) => m?.content?.[0]?.type === "toolCall");
  assert.equal(card?.content?.[0]?.toolName, "Bash", "真实工具名来自 _meta.qoder.toolName");
  assert.equal(card?.content?.[0]?.toolCallId, "call_1");
  assert.deepEqual(card?.content?.[0]?.input, { command: "sleep 2" });

  stub.notify({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "done" } }],
    rawOutput: "done-raw",
  });
  await flush();
  const result = events.filter((e) => e.type === "message_end").map((e) => e.message)
    .find((m) => m?.role === "toolResult");
  assert.equal(result?.toolName, "Bash");
  assert.equal(result?.content?.[0]?.text, "done", "content[].text 优先于 rawOutput");
  await h.dispose();
});

test("回放单帧 completed tool_call：卡 + 结果两条都落 liveHistory（不留匿名结果）", async () => {
  const sid = "sid-replay-1";
  const { h, stub } = await makeReadyHandle(QoderHandle, { sessionId: sid, stubOpts: { sessionId: sid } });
  // session/load 已完成（makeReadyHandle 走 load 路径），再注入一条 completed tool_call 模拟回放尾巴
  stub.notify({
    sessionUpdate: "tool_call",
    toolCallId: "call_r",
    status: "completed",
    title: "echo",
    rawInput: {},
    content: [{ type: "content", content: { type: "text", text: "out" } }],
  });
  await flush();
  const history = h.getMessages();
  const card = history.find((m) => m?.content?.[0]?.type === "toolCall" && m.content[0].toolCallId === "call_r");
  const result = history.find((m) => m?.role === "toolResult" && m.toolCallId === "call_r");
  assert.ok(card, "回放单帧也要出调用卡");
  assert.ok(result, "结果行配对");
  await h.dispose();
});

test("回合收口：气泡 flush 落 message_end + agent_settled（stopReason 正常无 error）", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle, { stubOpts: { autoAnswerPrompt: false } });
  // 需要真实 prompt（挂起桩）：sessionReady 已就绪，直接发
  const p = h.prompt("hi");
  await flush();
  stub.notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考段" } });
  stub.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "正文段" } });
  stub.answerPrompt({ stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
  await p;
  await flush();
  const ends = events.filter((e) => e.type === "message_end").map((e) => e.message);
  const think = ends.find((m) => m?.content?.[0]?.type === "thinking");
  const text = ends.find((m) => m?.content?.[0]?.type === "text" && m.role === "assistant");
  assert.equal(think?.content?.[0]?.thinking, "思考段", "thinking 气泡随收口落盘");
  assert.equal(text?.content?.[0]?.text, "正文段", "text 气泡随收口落盘");
  const settled = events.find((e) => e.type === "agent_settled");
  assert.ok(settled);
  assert.equal(settled.stopReason, undefined, "end_turn 不带 stopReason/error");
  assert.equal(h.getUsageTotals().inputTokens, 3, "usage 累加");
  await h.dispose();
});

test("failed 工具更新 → toolResult 带 isError + 空输出占位文案", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle);
  stub.notify({ sessionUpdate: "tool_call", toolCallId: "call_x", status: "pending", title: "Bash", rawInput: {} });
  stub.notify({ sessionUpdate: "tool_call_update", toolCallId: "call_x", status: "failed" });
  await flush();
  const result = events.filter((e) => e.type === "message_end").map((e) => e.message)
    .find((m) => m?.role === "toolResult");
  assert.equal(result?.isError, true);
  assert.ok(result?.content?.[0]?.text, "空输出有占位文案");
  await h.dispose();
});

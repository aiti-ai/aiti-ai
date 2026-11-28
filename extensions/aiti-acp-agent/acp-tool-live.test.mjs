/**
 * aiti-acp-agent — 工具调用直播形态单测（方案 X：pi 原生条目）。
 *
 * 回归重点（2026-09-22 §8 遗留）：ACP 工具帧曾折成 `🛠 工具调用`/`✅❌ 工具完成` custom 卡，
 * 而其余后端（zcode/qoder/codebuddy/claude-code）直播与冷回放都是原生 toolCall/toolResult
 * ——宿主 ToolCallBlock 按 toolCallId 折叠成一张卡。本测试钉死：
 *   1. 首帧一条 assistant.toolCall + 收帧一条 toolResult，同 toolCallId 配对；
 *   2. 多帧进度不重复发卡；回放期（session/load）只入历史不直播；
 *   3. 工具名取 _meta 机器名（授权卡同源 extractToolAskInfo），无机器名时退 title；
 *   4. failed → isError；空白输出 → 共享占位（与冷回放同口径）。
 *
 * Run: node --test pi-web-ext/aiti-acp-agent/acp-tool-live.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { AcpHandle } = await import("./index.ts");

/** 裸 handle（不 spawn；直调 onToolCallUpdate 即协议帧到达的落点）。 */
function makeHandle() {
  const h = new AcpHandle("codebuddy", "/bin/true", [], "codebuddy");
  const events = [];
  h.aliveFlag = true;
  h.id = "codebuddy:test-tool";
  h.subscribe((e) => events.push(e));
  return { h, events };
}

const liveEnds = (events) => events.filter((e) => e.type === "message_end");
const toolCalls = (msgs) => msgs.filter((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "toolCall"));

test("原生条目: tool_call → tool_call_update(completed) 出配对的 toolCall + toolResult", async () => {
  const { h, events } = makeHandle();
  h.onToolCallUpdate({ toolCallId: "tc_1", status: "in_progress", title: "echo hi", rawInput: { command: "echo hi" } });
  h.onToolCallUpdate({ toolCallId: "tc_1", status: "completed", rawOutput: { text: "hi\n" } });

  const msgs = await h.getMessages();
  assert.equal(toolCalls(msgs).length, 1, "调用条目恰好一条");
  assert.deepEqual(toolCalls(msgs)[0].content[0], {
    type: "toolCall", toolCallId: "tc_1", toolName: "echo hi", input: { command: "echo hi" },
  });
  const res = msgs.find((m) => m.role === "toolResult");
  assert.equal(res.toolCallId, "tc_1", "结果与调用同 id → 宿主折叠成一张卡");
  assert.equal(res.toolName, "echo hi");
  assert.deepEqual(res.content, [{ type: "text", text: "hi" }]);
  assert.equal(res.isError, undefined);
  assert.equal(liveEnds(events).length, 2, "直播两条");
  assert.equal(events.some((e) => e.type === "message_end" && e.message?.customType), false, "不再发 🛠/✅❌ custom 工具卡");
});

test("进度多帧不重复发卡；对象型 rawOutput 序列化不留 [object Object]", async () => {
  const { h, events } = makeHandle();
  h.onToolCallUpdate({ toolCallId: "tc_2", status: "in_progress", title: "read" });
  h.onToolCallUpdate({ toolCallId: "tc_2", status: "in_progress", title: "read", rawInput: { path: "/a" } });
  h.onToolCallUpdate({ toolCallId: "tc_2", status: "completed", rawOutput: { exitCode: 0 } });
  h.onToolCallUpdate({ toolCallId: "tc_2", status: "completed", rawOutput: { exitCode: 0 } });
  const msgs = await h.getMessages();
  assert.equal(toolCalls(msgs).length, 1, "同 id 多次进度只一条调用条目");
  assert.equal(msgs.filter((m) => m.role === "toolResult").length, 1, "重复 completed 只一条结果");
  assert.deepEqual(toolCalls(msgs)[0].content[0].input, { path: "/a" }, "后到帧补齐入参");
  assert.equal(msgs.find((m) => m.role === "toolResult").content[0].text, '{"exitCode":0}');
  assert.equal(liveEnds(events).length, 2);
});

test("回放期（session/load）只入 liveHistory，不发直播帧", async () => {
  const { h, events } = makeHandle();
  h.loading = true;
  h.onToolCallUpdate({ toolCallId: "tc_3", status: "completed", title: "ls", rawOutput: "a.txt" });
  assert.equal(liveEnds(events).length, 0, "回放期不直播（旧历史不打字上屏）");
  const msgs = await h.getMessages();
  assert.equal(toolCalls(msgs).length, 1);
  assert.equal(msgs.find((m) => m.role === "toolResult")?.content[0].text, "a.txt");
});

test("机器工具名优先（_meta.codebuddy.ai/toolName），授权卡与直播卡同源命名", async () => {
  const { h } = makeHandle();
  h.onToolCallUpdate({
    toolCallId: "tc_4", status: "in_progress", title: "运行命令 echo hi",
    _meta: { "codebuddy.ai/toolName": "Bash" }, rawInput: { command: "echo hi" },
  });
  const call = toolCalls(await h.getMessages())[0].content[0];
  assert.equal(call.toolName, "Bash", "有机器名用机器名（宿主按名分流渲染）");
});

test("failed → isError + 空白输出给失败占位（与 seed-tool 同口径）", async () => {
  const { h } = makeHandle();
  h.onToolCallUpdate({ toolCallId: "tc_5", status: "in_progress", title: "false" });
  h.onToolCallUpdate({ toolCallId: "tc_5", status: "failed", rawOutput: "   " });
  const res = (await h.getMessages()).find((m) => m.role === "toolResult");
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, "(工具执行失败)");
});

test("completed 无输出 → 完成占位（卡片不裸奔）", async () => {
  const { h } = makeHandle();
  h.onToolCallUpdate({ toolCallId: "tc_6", status: "completed", title: "touch a.txt" });
  const res = (await h.getMessages()).find((m) => m.role === "toolResult");
  assert.equal(res.content[0].text, "(工具执行完成，无文本输出)");
});

test("缺 toolCallId 的帧不入账（宿主无法配对，宁缺勿错配）", async () => {
  const { h, events } = makeHandle();
  h.onToolCallUpdate({ status: "completed", title: "orphan", rawOutput: "x" });
  assert.deepEqual(await h.getMessages(), []);
  assert.equal(liveEnds(events).length, 0);
});

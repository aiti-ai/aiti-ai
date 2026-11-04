/**
 * aiti-qoder-agent — 流式三线组装单测（对齐 zcode 显示：text / thinking 各自成块）。
 *
 * 钉死 CC stream-json → pi message_update 映射：
 *   1. message_start 带空骨架 message（宿主 reducer 按 contentIndex 建块的前提）；
 *   2. content_block_start/delta/stop → thinking_start/delta/end + text_*，contentIndex 本地连续
 *      （tool_use 块不占位——工具卡由 assistant 帧方案 X 出，气泡里不留空洞）；
 *   3. assistant 终帧 → 按**帧内原序**分组落消息（连续同类归一条），liveHistory 同形；
 *   4. tool_result 的 string 形态 content（qoderclicn 1.1.56 实测）→ toolResult 条目；
 *   5. 容错：孤儿 delta 就地开块；工具空输出占位文案。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/qoder-stream.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";

const { QoderHandle } = await import("./index.ts");

function makeHandle(id = "qodercn:new-test") {
  const stdout = new PassThrough();
  const child = {
    stdout,
    stderr: { on() {} },
    once() {},
    stdin: { write: () => true, writable: true, on() {} },
    kill() {},
    exitCode: null,
  };
  const h = new QoderHandle(id, child, null, "/tmp", "cn");
  const events = [];
  h.subscribe((e) => events.push(e));
  const write = (frame) => stdout.write(JSON.stringify(frame) + "\n");
  return { h, events, write };
}

const flush = () => new Promise((r) => setTimeout(r, 2));
const ame = (events) => events.filter((e) => e.type === "message_update").map((e) => e.assistantMessageEvent);

test("message_start 带空骨架（无 message 则宿主整条丢弃 delta）", async () => {
  const { events, write } = makeHandle();
  write({ type: "stream_event", event: { type: "message_start", message: { role: "assistant" } } });
  await flush();
  const start = events.find((e) => e.type === "message_start");
  assert.equal(start?.role, "assistant");
  assert.deepEqual(start?.message?.content, []);
  assert.equal(start?.message?.role, "assistant");
});

test("thinking + text 两线：contentIndex 本地连续，tool_use 不占位", async () => {
  const { events, write } = makeHandle();
  write({ type: "stream_event", event: { type: "message_start" } });
  write({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } });
  write({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先想" } } });
  write({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "一想" } } });
  write({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  write({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Bash", id: "t1" } } });
  write({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command' } } });
  write({ type: "stream_event", event: { type: "content_block_stop", index: 1 } });
  write({ type: "stream_event", event: { type: "content_block_start", index: 2, content_block: { type: "text" } } });
  write({ type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "正文" } } });
  write({ type: "stream_event", event: { type: "content_block_stop", index: 2 } });
  await flush();

  assert.deepEqual(ame(events), [
    { type: "thinking_start", contentIndex: 0 },
    { type: "thinking_delta", contentIndex: 0, delta: "先想" },
    { type: "thinking_delta", contentIndex: 0, delta: "一想" },
    { type: "thinking_end", contentIndex: 0, content: "先想一想" },
    { type: "text_start", contentIndex: 1 },
    { type: "text_delta", contentIndex: 1, delta: "正文" },
    { type: "text_end", contentIndex: 1, content: "正文" },
  ]);
});

test("assistant 终帧：按帧内原序分组落 liveHistory 与 message_end", async () => {
  const { h, events, write } = makeHandle();
  write({ type: "stream_event", event: { type: "message_start" } });
  write({ type: "assistant", message: { model: "qfmodel", content: [
    { type: "thinking", thinking: "推理过程" },
    { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } },
    { type: "text", text: "结论" },
  ] } });
  await flush();

  const ends = events.filter((e) => e.type === "message_end" && e.message?.role === "assistant");
  // 帧内原序 = 显示序：thinking 在工具卡之前，不得被 toolCall 抢先（刷新回放与直播一致）
  assert.deepEqual(ends.map((e) => e.message.content.map((b) => b.type)), [["thinking"], ["toolCall"], ["text"]]);
  assert.equal(ends[1].message.model, "qfmodel");
  assert.equal(ends[1].message.provider, "aiti-qoder-agent");
  assert.deepEqual(
    h.liveHistory.map((m) => m.content?.map((b) => b.type)),
    [["thinking"], ["toolCall"], ["text"]],
  );
});

test("相邻同类块归一条：thinking+text 之间无工具时仍是一条两块的助手消息", async () => {
  const { events, write } = makeHandle();
  write({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "想" },
    { type: "text", text: "答" },
  ] } });
  await flush();
  const ends = events.filter((e) => e.type === "message_end" && e.message?.role === "assistant");
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].message.content.map((b) => b.type), ["thinking", "text"]);
});

test("孤儿 delta：缺 content_block_start 也就地开块（正文不得静默丢弃）", async () => {
  const { events, write } = makeHandle();
  write({ type: "stream_event", event: { type: "message_start" } });
  write({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "丢块头" } } });
  write({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text" } } });
  write({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "正常" } } });
  await flush();

  assert.deepEqual(ame(events), [
    { type: "thinking_start", contentIndex: 0 },
    { type: "thinking_delta", contentIndex: 0, delta: "丢块头" },
    { type: "text_start", contentIndex: 1 },
    { type: "text_delta", contentIndex: 1, delta: "正常" },
  ]);
});

test("空工具输出：占位文案兜底（前端折叠卡不至于一行空白）", async () => {
  const { events, write } = makeHandle();
  write({ type: "assistant", message: { content: [{ type: "tool_use", id: "e1", name: "Bash", input: { command: "true" } }] } });
  write({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "" }] } });
  write({ type: "assistant", message: { content: [{ type: "tool_use", id: "e2", name: "Bash", input: { command: "false" } }] } });
  write({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "e2", content: [], is_error: true }] } });
  await flush();

  const results = events.filter((e) => e.type === "message_end" && e.message?.role === "toolResult");
  assert.equal(results[0].message.content[0].text, "(工具执行完成，无文本输出)");
  assert.equal(results[1].message.content[0].text, "(工具执行失败)");
  assert.equal(results[1].message.isError, true);
});

test("工具名账本：流式块头登记，assistant 终帧丢失时 tool_result 仍报工具名", async () => {
  const { events, write } = makeHandle();
  write({ type: "stream_event", event: { type: "message_start" } });
  write({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "s1", name: "WebFetch" } } });
  // CLI 崩溃/丢帧：没有 assistant 终帧，直接来了工具结果
  write({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "s1", content: "页面正文" }] } });
  await flush();

  const result = events.filter((e) => e.type === "message_end" && e.message?.role === "toolResult").pop();
  assert.equal(result?.message?.toolName, "WebFetch");
  assert.equal(result?.message?.content[0].text, "页面正文");
});

test("tool_result：string 形态 content（qoderclicn 1.1.56 实测）→ 折叠进 toolResult 条目", async () => {
  const { h, events, write } = makeHandle();
  write({ type: "assistant", message: { content: [{ type: "tool_use", id: "t9", name: "Grep", input: { pattern: "x" } }] } });
  write({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t9", content: "命中 3 处" }] } });
  await flush();

  const result = events.filter((e) => e.type === "message_end" && e.message?.role === "toolResult").pop();
  assert.equal(result?.message?.toolCallId, "t9");
  assert.equal(result?.message?.toolName, "Grep");
  assert.equal(result?.message?.content[0].text, "命中 3 处");
  assert.equal(h.liveHistory.at(-1)?.role, "toolResult");
});

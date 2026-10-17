// 验证 pi-agent-core 补丁：message_start 序列化竞态修复
// 模拟 pi-ai 竞态：push(start) 后同步 mutate partial（模拟首 chunk 已到），
// agent-loop 消费 start 时 emit 的 message_start 不应携带首 chunk 内容。
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runAgentLoop } = await jiti.import(
  process.env.PI_AGENT_CORE_PATH || "@earendil-works/pi-agent-core",
);

test("message_start 不携带首 chunk 的内容（序列化竞态修复）", async () => {
  const emitted = [];
  // 模拟 pi-ai 的 live partial：content 数组被生产者同步 mutate
  const output = { role: "assistant", content: [], stopReason: "pending" };
  const streamFn = async () => ({
    async *[Symbol.asyncIterator]() {
      // push(start)（进队列）
      yield { type: "start", partial: output };
      // 消费者处理 start 前，首 chunk 已被生产者同步处理（mutate output）
      const block = { type: "thinking", thinking: "用户" };
      output.content.push(block);
      yield { type: "thinking_start", contentIndex: 0, partial: output };
      yield { type: "thinking_delta", contentIndex: 0, delta: "用户", partial: output };
      yield { type: "thinking_end", contentIndex: 0, content: "用户问了一个问题", partial: output };
      yield { type: "done", reason: "stop", message: { ...output, content: [{ type: "thinking", thinking: "用户问了一个问题" }], stopReason: "stop" } };
    },
    result: async () => ({ ...output, content: [{ type: "thinking", thinking: "用户问了一个问题" }], stopReason: "stop" }),
  });

  await runAgentLoop(
    ["test prompt"],
    { messages: [], tools: [] },
    { model: { provider: "test", id: "test-model", api: "openai-completions" }, apiKey: "test", getApiKey: () => "test", convertToLlm: async (m) => m, tools: [] },
    async (event) => { emitted.push(event); },
    undefined,
    streamFn,
  );

  console.error("EVENTS:", JSON.stringify(emitted.map(e => ({ t: e.type, c: e.message?.content }))).slice(0, 400));
  const start = emitted.find((e) => e.type === "message_start" && e.message?.role === "assistant");
  assert.ok(start, "message_start emitted");
  // 修复后：message_start 的 content 是 emit 时刻的快照（空），不带后续 chunk 内容
  assert.equal(
    start.message.content.length,
    0,
    `message_start.content 应为空数组，实际 ${JSON.stringify(start.message.content)}`,
  );
});

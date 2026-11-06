import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  normalizeRawMessages,
  normalizeStreamingToolCalls,
  normalizeToolCalls,
} = await jiti.import("./normalize.ts");

function assistant(block) {
  return {
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  };
}

test("keeps SDK scratch input only for an in-flight snapshot", () => {
  const message = assistant({
    type: "toolCall",
    id: "call-1",
    name: "write",
    arguments: { path: "/tmp/file" },
    partialJson: '{"path":"/tmp/file","content":"hel',
  });

  assert.deepEqual(normalizeStreamingToolCalls(message).content[0], {
    type: "toolCall",
    toolCallId: "call-1",
    toolName: "write",
    input: { path: "/tmp/file" },
    rawInput: '{"path":"/tmp/file","content":"hel',
  });
  assert.deepEqual(normalizeToolCalls(message).content[0], {
    type: "toolCall",
    toolCallId: "call-1",
    toolName: "write",
    input: { path: "/tmp/file" },
  });
});

test("removes a client raw buffer when normalizing a completed message", () => {
  const message = assistant({
    type: "toolCall",
    toolCallId: "call-2",
    toolName: "write",
    input: { path: "/tmp/file", content: "complete" },
    rawInput: "temporary",
  });

  assert.equal(Object.hasOwn(normalizeToolCalls(message).content[0], "rawInput"), false);
});

test("synthesizes content for plain-text wire frames ({role, text, ts})", () => {
  // External backends (echo agents, minimal providers) deliver id-less frames
  // without content blocks; the render layer (turn-views, input history)
  // assumes user string|blocks and assistant array — missing content crashed
  // the whole chat (found by the mobile enter-send e2e probe on echo-1).
  const [user, bot] = normalizeRawMessages([
    { role: "user", text: "hello probe", ts: 1 },
    { role: "assistant", text: "echo: hello probe", ts: 2 },
  ]);

  assert.equal(user.content, "hello probe");
  assert.deepEqual(bot.content, [{ type: "text", text: "echo: hello probe" }]);
  assert.equal(bot.model, "(external)");
  assert.equal(bot.provider, "(external)");
});

test("content synthesis keeps existing shapes and unknown roles untouched", () => {
  const raw = [
    { role: "user", content: "string form stays" },
    assistant({ type: "text", text: "assistant blocks stay" }),
    { role: "toolResult", toolCallId: "c1", output: "raw passthrough", ts: 3 },
    { role: "custom", customType: "note", text: "no content key", ts: 4 },
  ];
  const out = normalizeRawMessages(raw);

  assert.equal(out[0].content, "string form stays");
  assert.equal(out[1].content[0].text, "assistant blocks stay");
  assert.equal(out[2].output, "raw passthrough");
  assert.equal(out[3].content, undefined); // only user/assistant are synthesized
});

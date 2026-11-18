// pi AgentMessage adapters: context / system / message_end deep redaction.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry } from "../src/mask.ts";
import { collectSpans, redactMessageDeep, redactMessages, redactSystemMessages } from "../src/messages.ts";

const SECRET = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";

test("redactMessages: user text auto-detected, assistant/toolResult redacted", () => {
  const r = new Registry();
  const messages = [
    { role: "user", content: `my token: ${SECRET}` },
    { role: "assistant", content: [{ type: "text", text: `I saw ${SECRET}` }] },
    { role: "toolResult", content: [{ type: "text", text: `out ${SECRET}` }] },
    { role: "bashExecution", command: `export K=${SECRET}`, output: SECRET },
    { role: "compactionSummary", summary: `summary ${SECRET}` },
  ];
  const res = redactMessages(messages, r, "salt");
  assert.equal(res.newEntries, 1);
  assert.equal(res.changed, true);
  const ph = r.entries()[0].placeholder;
  assert.equal(messages[0].content, `my token: ${ph}`);
  assert.equal(messages[1].content[0].text, `I saw ${ph}`);
  assert.equal(messages[2].content[0].text, `out ${ph}`);
  assert.equal(messages[3].command, `export K=${ph}`);
  assert.equal(messages[3].output, ph);
  assert.equal(messages[4].summary, `summary ${ph}`);
  // second pass no-op
  assert.equal(redactMessages(messages, r, "salt").changed, false);
});

test("assistant thinking text is redacted, signatures are untouched", () => {
  const r = new Registry();
  const ph = r.registerManual(SECRET, "k").entry.placeholder;
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: `maybe ${SECRET}`, thinkingSignature: `sig-${SECRET}` },
        { type: "text", text: `ok ${SECRET}`, textSignature: `sig2-${SECRET}` },
        { type: "toolCall", id: "t1", name: "bash", arguments: { command: `echo ${SECRET}` }, thoughtSignature: `sig3-${SECRET}` },
      ],
    },
  ];
  redactMessages(messages, r, "salt");
  const [thinking, text, call] = messages[0].content;
  assert.equal(thinking.thinking, `maybe ${ph}`);
  assert.equal(thinking.thinkingSignature, `sig-${SECRET}`);
  assert.equal(text.text, `ok ${ph}`);
  assert.equal(text.textSignature, `sig2-${SECRET}`);
  // context hook does not touch toolCall arguments (tool_call restores them);
  // raw args stay as-is so the tool executes with real bytes
  assert.equal(call.arguments.command, `echo ${SECRET}`);
  assert.equal(call.thoughtSignature, `sig3-${SECRET}`);
});

test("system prompt sections are redacted by the context_with_system adapter", () => {
  const r = new Registry();
  const ph = r.registerManual(SECRET, "k").entry.placeholder;
  const messages = [
    {
      role: "system",
      content: `project rules: token ${SECRET}`,
      sections: { custom_rules: `use ${SECRET}`, other: "untouched", empty: null },
    },
    { role: "user", content: `again ${SECRET}` },
  ];
  const res = redactSystemMessages(messages, r);
  assert.equal(res.changed, true);
  assert.equal(messages[0].content, `project rules: token ${ph}`);
  assert.equal(messages[0].sections.custom_rules, `use ${ph}`);
  assert.equal(messages[0].sections.other, "untouched");
  assert.equal(messages[0].sections.empty, null);
  // user messages are not touched by the system-only pass
  assert.equal(messages[1].content, `again ${SECRET}`);
});

test("redactMessageDeep: returns a role-preserving replacement, original untouched", () => {
  const r = new Registry();
  const ph = r.registerManual(SECRET, "k").entry.placeholder;
  const message = {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "bash",
    content: [{ type: "text", text: `value ${SECRET}` }],
    details: { stdout: SECRET, code: 0 },
    structuredContent: { token: SECRET },
    nestedCalls: { complete: true, calls: [{ id: "n1", name: "read", arguments: { path: SECRET }, status: "ok" }] },
    isError: false,
    timestamp: 1,
  };
  const res = redactMessageDeep(message, r);
  assert.equal(res.count, 4); // content + details + structuredContent + nested arguments
  assert.equal(res.message.role, "toolResult");
  assert.equal(message.content[0].text, `value ${SECRET}`, "original untouched");
  assert.equal(res.message.content[0].text, `value ${ph}`);
  assert.equal(res.message.details.stdout, ph);
  assert.equal(res.message.details.code, 0);
  assert.equal(res.message.structuredContent.token, ph);
  assert.equal(res.message.nestedCalls.calls[0].arguments.path, ph);
  // no match → same reference
  const clean = { role: "user", content: "nothing", timestamp: 2 };
  assert.equal(redactMessageDeep(clean, r).message, clean);
});

test("redactMessageDeep covers assistant toolCall arguments (persisted replay)", () => {
  const r = new Registry();
  const ph = r.registerManual(SECRET, "k").entry.placeholder;
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: `echo ${SECRET}` } }],
    usage: { totalTokens: 1 },
    timestamp: 1,
  };
  const res = redactMessageDeep(message, r);
  assert.equal(res.message.content[0].arguments.command, `echo ${ph}`);
  assert.equal(res.message.content[0].name, "bash");
});

test("collectSpans: custom messages with block content", () => {
  const r = new Registry();
  const ph = r.registerManual(SECRET, "k").entry.placeholder;
  const message = { role: "custom", customType: "x", display: true, content: [{ type: "image", data: "AAA", mimeType: "image/png" }, { type: "text", text: SECRET }] };
  const spans = collectSpans(message);
  assert.equal(spans.length, 1);
  spans[0].set(`z${ph}`);
  assert.equal(message.content[1].text, `z${ph}`);
});

// pi package adapters: v2 placeholders, span mapping, message_end deep redaction.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry, restoreDeep, redactDeep, MIN_REDACT_LENGTH } from "../src/mask.ts";
import { redactMessages, collectSpans, redactMessageDeep, redactSystemMessages } from "../src/messages.ts";

const SECRET = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";
const PLACEHOLDER = /^rsec_[0-9a-f]{8}$/;

test("manual registration: credential-shaped placeholder + round-trip", () => {
  const r = new Registry();
  r.salt = "salt";
  const res = r.registerManual(SECRET, "github-token");
  assert.ok(res);
  assert.match(res.entry.placeholder, PLACEHOLDER);
  const text = `use key ${SECRET} in the header`;
  const red = r.redact(text);
  assert.equal(red.count, 1);
  assert.ok(!red.text.includes(SECRET));
  const back = r.restore(red.text);
  assert.equal(back.text, text);
});

test("min length guard", () => {
  const r = new Registry();
  assert.equal(r.registerManual("abc"), undefined);
  assert.equal(r.registerManual("x".repeat(MIN_REDACT_LENGTH - 1)), undefined);
  assert.ok(r.registerManual("y".repeat(MIN_REDACT_LENGTH)));
});

test("autoRegister scans text and dedupes", () => {
  const r = new Registry();
  assert.equal(r.autoRegister(`my token: "${SECRET}" ok`, "salt").length, 1);
  assert.equal(r.autoRegister(`my token: "${SECRET}" ok`, "salt").length, 0);
});

test("redact is idempotent", () => {
  const r = new Registry();
  r.registerManual(SECRET, "k");
  const once = r.redact(`a=${SECRET};`);
  assert.equal(r.redact(once.text).count, 0);
});

test("deep restore/redact on nested tool input", () => {
  const r = new Registry();
  const ph = r.registerManual(SECRET, "k").entry.placeholder;
  const input = { cmd: `echo ${SECRET}`, env: { T: ph }, list: ["x", ph], n: 5, b: true };
  const restored = restoreDeep(input, r);
  assert.equal(restored.count, 2);
  assert.equal(restored.value.cmd, `echo ${SECRET}`);
  assert.equal(restored.value.env.T, SECRET);
  const back = redactDeep(restored.value, r);
  assert.equal(back.count, 3);
  assert.equal(back.value.cmd, `echo ${ph}`);
});

test("redactMessages: user auto-detect + full-shape redaction, thinking covered", () => {
  const r = new Registry();
  const messages = [
    { role: "user", content: `please use api_key = "${SECRET}" here`, timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: `sure, using ${SECRET}` }], timestamp: 1 },
    { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: `out ${SECRET}` }], isError: false, timestamp: 2 },
    { role: "bashExecution", command: `API_TOKEN="${SECRET}" curl -s example.com`, output: `resp ${SECRET}`, timestamp: 3 },
    { role: "assistant", content: [{ type: "thinking", thinking: `raw ${SECRET}`, thinkingSignature: `sig ${SECRET}` }, { type: "text", text: SECRET }], timestamp: 4 },
  ];
  const res = redactMessages(messages, r, "salt");
  assert.ok(res.newEntries >= 1, "auto-registered from user text");
  for (const i of [0, 1, 2, 3]) assert.ok(!JSON.stringify(messages[i]).includes(SECRET), `message ${i} scrubbed`);
  assert.ok(!messages[4].content[0].thinking.includes(SECRET), "thinking text redacted");
  assert.ok(messages[4].content[0].thinkingSignature.includes(SECRET), "provider signature untouched");
});

test("redactMessages: second pass is a no-op", () => {
  const r = new Registry();
  const messages = [{ role: "user", content: `token: "${SECRET}"` }];
  redactMessages(messages, r, "salt");
  const snapshot = JSON.stringify(messages);
  const res2 = redactMessages(messages, r, "salt");
  assert.equal(res2.changed, false);
  assert.equal(JSON.stringify(messages), snapshot);
});

test("collectSpans writes back into the message objects", () => {
  const m = { role: "toolResult", content: [{ type: "text", text: "a" }, { type: "image", url: "x" }] };
  const spans = collectSpans(m);
  assert.equal(spans.length, 1);
  spans[0].set("b");
  assert.equal(m.content[0].text, "b");
});

test("message_end deep redaction keeps role and scrubs details", () => {
  const r = new Registry();
  const ph = r.registerManual(SECRET, "k").entry.placeholder;
  const msg = {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "bash",
    content: [{ type: "text", text: SECRET }],
    details: { stdout: SECRET },
    isError: false,
    timestamp: 1,
  };
  const res = redactMessageDeep(msg, r);
  assert.equal(res.message.role, "toolResult");
  assert.equal(res.message.content[0].text, ph);
  assert.equal(res.message.details.stdout, ph);
  assert.equal(msg.content[0].text, SECRET, "original untouched");
});

test("system segments (AGENTS.md values) are redacted", () => {
  const r = new Registry();
  const ph = r.registerManual(SECRET, "k").entry.placeholder;
  const messages = [{ role: "system", content: `rules ${SECRET}`, sections: { project: `x ${SECRET}` } }];
  const res = redactSystemMessages(messages, r);
  assert.equal(res.changed, true);
  assert.equal(messages[0].content, `rules ${ph}`);
  assert.equal(messages[0].sections.project, `x ${ph}`);
});

test("remove and clear", () => {
  const r = new Registry();
  r.registerManual(SECRET, "k1");
  r.registerManual("9pQrStUvWx3y4z5A6b7C8d9E0f1", "k2");
  assert.equal(r.removeByLabel("k1"), true);
  assert.equal(r.size, 1);
  r.clear();
  assert.equal(r.size, 0);
});

test("compaction summary text is redacted", () => {
  const r = new Registry();
  r.registerManual(SECRET, "k");
  const messages = [{ role: "compactionSummary", summary: `earlier the user used ${SECRET}`, tokensBefore: 10 }];
  const res = redactMessages(messages, r, "s");
  assert.ok(res.changed);
  assert.ok(!JSON.stringify(messages).includes(SECRET));
});

// DSH message-block adaptation (engine cases live in @aiti-ai/secret-mask-core).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry, restoreDeep, MIN_REDACT_LENGTH } from "@aiti-ai/secret-mask-core";
import { redactUserMessage, textBlocks } from "../src/spans.ts";

const SECRET = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";
const cfg = { enabled: true, autoDetect: true, restoreToolArgs: true, audit: false, workspaceDir: "/tmp/dsm-test" };

function mkState() {
  return { registry: new Registry(), enabled: true, salt: "s", cwd: "/tmp/dsm-test", persisted: false, audit: false };
}

function userMsg(text, kind = "user") {
  return { id: "m1", role: "user", content: [{ type: "text", text }], source: { kind } };
}

test("redactUserMessage: user-authored text auto-detects; plugin-injected text redact-only", () => {
  const st = mkState();
  const user = userMsg(`please use api_key = "${SECRET}" here`, "user");
  const injected = userMsg(`context mentions ${SECRET}`, "plugin");
  const r1 = redactUserMessage(user, st, true);
  assert.ok(r1.changed, "user message rewritten");
  assert.ok(r1.newEntries >= 1, "auto-registered from user text");
  assert.ok(!JSON.stringify(r1.message).includes(SECRET));
  // same text from a plugin source: redact-only (already registered → still replaced, no new entry)
  const r2 = redactUserMessage(injected, st, true);
  assert.ok(r2.changed);
  assert.equal(r2.newEntries, 0, "plugin-injected text never mined");
  assert.ok(!JSON.stringify(r2.message).includes(SECRET));
});

test("redactUserMessage is immutable: original message object untouched", () => {
  const st = mkState();
  st.registry.registerManual(SECRET, "k");
  const m = userMsg(`token ${SECRET}`);
  const r = redactUserMessage(m, st, true);
  assert.ok(r.changed);
  assert.ok(r.message !== m, "new reference returned");
  assert.ok(JSON.stringify(m).includes(SECRET), "original frozen message keeps its text");
  assert.ok(!JSON.stringify(r.message).includes(SECRET));
});

test("redactUserMessage: non-text blocks untouched", () => {
  const st = mkState();
  st.registry.registerManual(SECRET, "k");
  const m = {
    id: "m2",
    role: "user",
    content: [{ type: "image", url: SECRET }, { type: "text", text: `see ${SECRET}` }],
    source: { kind: "user" },
  };
  const r = redactUserMessage(m, st, true);
  assert.ok(r.changed);
  assert.equal(r.message.content[0].url, SECRET, "image blocks never scanned");
  assert.ok(!r.message.content[1].text.includes(SECRET));
});

test("textBlocks collects only text blocks", () => {
  const m = { content: [{ type: "text", text: "a" }, { type: "image", url: "x" }, { type: "text", text: "b" }] };
  assert.deepEqual(textBlocks(m).map((b) => b.text), ["a", "b"]);
});

test("restoreDeep on frozen input does not mutate the original (DSH args are frozen)", () => {
  const r = new Registry();
  r.registerManual(SECRET, "k");
  const frozen = Object.freeze({ cmd: "run [REDACTED:k]", opts: Object.freeze({ v: "[REDACTED:k]" }) });
  const res = restoreDeep(structuredClone(frozen), r);
  assert.equal(res.count, 2);
  assert.equal(res.value.cmd, `run ${SECRET}`);
  assert.equal(frozen.cmd, "run [REDACTED:k]", "frozen original untouched");
});

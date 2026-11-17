/**
 * aiti-acp-agent — setModel protocol-adaptation unit tests (legacy session/set_model → new
 * session/set_config_option fallback).
 *
 * Background (2026-11-17): claude-agent-acp 0.100.0 removed session/set_model (Method not found);
 * model switching moved to session/set_config_option (configId = the id of the name==="Model" item
 * in session/new's configOptions; the response returns the full configOptions — echo back the
 * server-read currentValue). Pin down:
 *   1. legacy-protocol host: set_model passes through, success echoes the requested value;
 *   2. new-protocol host: set_model fails → set_config_option fallback, echo the server currentValue;
 *   3. neither supported (no Model configOption) → false (fail-loud).
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-acp-agent/set-model.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { AcpHandle } = await import("./index.ts");

/** Build a bare handle that spawns no process (private state injected directly, test-only; same as turn-lifecycle.test.mjs). */
function makeHandle() {
  const h = new AcpHandle("claude-code", "/bin/true", [], "claude-code");
  const events = [];
  h.aliveFlag = true;
  h.id = "claude:test-session";
  h.child = { stdin: { write: () => true } };
  h.subscribe((e) => events.push(e));
  return { h, events };
}

test("旧协议宿主：set_model 直通，回显请求值", async () => {
  const { h } = makeHandle();
  const methods = [];
  h.rpc = async (method) => {
    methods.push(method);
    if (method !== "session/set_model") throw new Error(`unexpected method: ${method}`);
    return {};
  };
  const ok = await h.setModel({ id: "opus", provider: "claude-code" });
  assert.equal(ok, true);
  assert.deepEqual(methods, ["session/set_model"]);
  assert.equal(h.getModel()?.id, "opus");
});

test("新协议宿主：set_model 失败 → set_config_option 兜底（configId 定位 + 服务端 currentValue 回显）", async () => {
  const { h } = makeHandle();
  h.modelConfigId = "model";
  const calls = [];
  h.rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "session/set_model") throw new Error("Method not found: session/set_model");
    return { configOptions: [{ id: "model", currentValue: "sonnet" }] };
  };
  const ok = await h.setModel({ id: "sonnet", provider: "claude-code" });
  assert.equal(ok, true);
  assert.deepEqual(calls.map((c) => c.method), ["session/set_model", "session/set_config_option"]);
  assert.equal(calls[1].params.configId, "model");
  assert.equal(calls[1].params.value, "sonnet");
  assert.equal(calls[1].params.sessionId, "test-session");
  // echo trusts the server-read currentValue
  assert.equal(h.getModel()?.id, "sonnet");
});

test("两者皆不支持（无 Model configOption）→ false（fail-loud）", async () => {
  const { h } = makeHandle();
  h.modelConfigId = undefined;
  h.rpc = async () => { throw new Error("Method not found"); };
  const ok = await h.setModel({ id: "x", provider: "claude-code" });
  assert.equal(ok, false);
  assert.equal(h.getModel(), undefined);
});

test("兜底后服务端 currentValue 为空 → 回退请求值（不产生空 model）", async () => {
  const { h } = makeHandle();
  h.modelConfigId = "model";
  h.rpc = async (method) => {
    if (method === "session/set_model") throw new Error("Method not found");
    return { configOptions: [{ id: "model", currentValue: "" }] };
  };
  const ok = await h.setModel({ id: "opus", provider: "claude-code" });
  assert.equal(ok, true);
  assert.equal(h.getModel()?.id, "opus");
});

test("死句柄 / 无 sessionId → false（不发起 RPC）", async () => {
  const { h } = makeHandle();
  h.aliveFlag = false;
  let called = 0;
  h.rpc = async () => { called++; return {}; };
  assert.equal(await h.setModel({ id: "x", provider: "claude-code" }), false);
  assert.equal(called, 0);
});

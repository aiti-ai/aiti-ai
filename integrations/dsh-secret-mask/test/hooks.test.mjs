// DSH adapter behaviour: mock a minimal Cordis context, drive every hook the
// way the real runtime would (waterfalls with next(), frozen payloads).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../src/index.ts";
import { stateFor } from "../src/state.ts";

const SECRET = "sk-ant-api03-" + "aBc9DeF0GhI1JkL2MnO3PqR4StU5Vw6X";
const CFG = { enabled: true, autoDetect: true, restoreToolArgs: true, audit: false, workspaceDir: "/tmp/dsm-hooks-test" };

function mockCtx(toolDefs = new Map()) {
  const handlers = {};
  const registered = { tools: [], commands: [], sections: [] };
  const errors = [];
  const ctx = {
    errors,
    logger: { info() {}, warn() {}, error: (m) => errors.push(m) },
    on(event, fn) {
      (handlers[event] ??= []).push(fn);
      return () => {};
    },
    effect() {},
    get() {
      return undefined;
    },
    tools: {
      register: (d) => {
        registered.tools.push(d);
        return () => {};
      },
      get: (name) => toolDefs.get(name),
      schemas: () => [...toolDefs.values()],
    },
    commands: {
      register: (d) => {
        registered.commands.push(d);
        return () => {};
      },
    },
    systemPrompt: {
      section: (s) => {
        registered.sections.push(s);
        return () => {};
      },
    },
  };
  const fire = async (event, ...args) => {
    const out = [];
    for (const fn of handlers[event] ?? []) out.push(await fn(...args));
    return out;
  };
  return { ctx, handlers, registered, fire, toolDefs };
}

function userMsg(text, id = "m1", kind = "user") {
  return { id, role: "user", content: [{ type: "text", text }], source: { kind } };
}

const nextDecision = (messages) => async () => ({ kind: "enter", messages });

test("plugin assembly registers all hooks and the /secret command", () => {
  const { ctx, registered } = mockCtx();
  apply(ctx, CFG);
  assert.ok(registered.commands.some((c) => c.name === "secret"));
  assert.equal(registered.commands[0].recordInput, false, "value never lands in command/run");
  assert.equal(registered.sections.length, 1);
  assert.equal(registered.sections[0].name, "secret_masking");
});

test("pre-step: pasted key is redacted with a stable auto placeholder; second pass no-op", async () => {
  const { ctx, fire } = mockCtx();
  apply(ctx, CFG);
  const agent = { id: "agent-ps1" };
  const m1 = userMsg(`please use api_key = "${SECRET}" in the header`, "m1");
  const d1 = (await fire("agent/pre-step", { agent, messages: [m1], turn: 0, step: 0, signal: (new AbortController().signal) }, nextDecision([m1])))[0];
  assert.equal(d1.kind, "enter");
  assert.ok(!JSON.stringify(d1.messages).includes(SECRET), "raw value gone");
  assert.match(JSON.stringify(d1.messages), /rsec_[0-9a-f]{8}/);
  const m2 = userMsg(`again ${SECRET}`, "m2");
  const d2 = (await fire("agent/pre-step", { agent, messages: [m2], turn: 0, step: 1, signal: (new AbortController().signal) }, nextDecision([m2])))[0];
  assert.match(JSON.stringify(d2.messages), /rsec_[0-9a-f]{8}/, "same value → same placeholder within session");
});

test("pre-step: reject decision passes through untouched; disabled session passes through", async () => {
  const { ctx, fire } = mockCtx();
  apply(ctx, { ...CFG, enabled: false });
  const agent = { id: "agent-ps2" };
  const m = userMsg(`key ${SECRET}`);
  const d = (await fire("agent/pre-step", { agent, messages: [m], turn: 0, step: 0, signal: (new AbortController().signal) }, async () => ({ kind: "reject" })))[0];
  assert.equal(d.kind, "reject");
  const d2 = (await fire("agent/pre-step", { agent, messages: [m], turn: 0, step: 0, signal: (new AbortController().signal) }, nextDecision([m])))[0];
  assert.ok(JSON.stringify(d2.messages).includes(SECRET), "master switch off → no rewriting");
});

test("section text provider: empty without registered values, guidance text with them", async () => {
  const { ctx, fire, registered } = mockCtx();
  apply(ctx, CFG);
  const section = registered.sections[0];
  const scope = { id: "agent-sec1" };
  assert.equal(section.text({ scope }), "", "no values → no guidance rendered");
  const m = userMsg(`token: "${SECRET}"`);
  await fire("agent/pre-step", { agent: { id: "agent-sec1" }, messages: [m], turn: 0, step: 0, signal: (new AbortController().signal) }, nextDecision([m]));
  assert.equal(section.text({ scope }).length > 100, true, "guidance rendered once values exist");
});

test("post-execute: canonical value path (object) and content path (render-only text)", async () => {
  const { ctx, fire } = mockCtx();
  apply(ctx, CFG);
  const agent = { id: "agent-pe1" };
  // register the value through the send boundary first
  const m = userMsg(`write this env value API_KEY="${SECRET}" to .env`, "m1");
  await fire("agent/pre-step", { agent, messages: [m], turn: 0, step: 0, signal: (new AbortController().signal) }, nextDecision([m]));

  // value path: cat-like result returning the file contents as a JSON object
  const result = { isError: false, value: { file: `.env`, content: `API_KEY=${SECRET}` }, content: [{ type: "text", text: `API_KEY=${SECRET}` }] };
  const d1 = (
    await fire(
      "tools/post-execute",
      { token: "t", callId: "c1", name: "read", arguments: {}, signal: (new AbortController().signal), agent },
      result,
      async () => ({ kind: "accept", value: result.value, content: result.content }),
    )
  )[0];
  assert.equal(d1.kind, "accept");
  assert.ok(!JSON.stringify(d1.value).includes(SECRET), "canonical value redacted");
  assert.match(JSON.stringify(d1.value), /rsec_/);

  // content path: upstream replaced content only (no value key)
  const d2 = (
    await fire(
      "tools/post-execute",
      { token: "t", callId: "c2", name: "read", arguments: {}, signal: (new AbortController().signal), agent },
      result,
      async () => ({ kind: "accept", content: [{ type: "text", text: `out ${SECRET}` }] }),
    )
  )[0];
  assert.ok(!JSON.stringify(d2.content).includes(SECRET), "rendered content redacted");
});

test("post-execute: upstream block decision untouched; disabled session pass-through", async () => {
  const { ctx, fire } = mockCtx();
  apply(ctx, { ...CFG, enabled: false });
  const agent = { id: "agent-pe2" };
  const result = { isError: false, value: { x: SECRET }, content: [] };
  const d = (
    await fire(
      "tools/post-execute",
      { token: "t", callId: "c", name: "read", arguments: {}, signal: (new AbortController().signal), agent },
      result,
      async () => ({ kind: "block", feedback: [{ type: "text", text: "denied" }] }),
    )
  )[0];
  assert.equal(d.kind, "block");
});

test("shadow tools: whitelisted tools re-registered; placeholders restored into a clone", async () => {
  let executedArgs = null;
  const origExecute = async (args) => {
    executedArgs = args;
    return { ok: true };
  };
  const defs = new Map([
    ["bash", { name: "bash", description: "d", parameters: {}, output: { schema: {}, render: () => [] }, execute: origExecute }],
    ["read", { name: "read", description: "d", parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) }],
  ]);
  const { ctx, fire, registered } = mockCtx(defs);
  apply(ctx, CFG);
  const agent = { id: "agent-sh1", ctx: { tools: { register: ctx.tools.register, get: ctx.tools.get } } };
  await fire("agent/session-start", { agent });
  const shadowNames = registered.tools.map((t) => t.name);
  assert.deepEqual(shadowNames.sort(), ["bash"], "only whitelisted names with a global original are shadowed");

  // register a value, then simulate a model call carrying the placeholder
  const m = userMsg(`save this: ${SECRET}`, "m1");
  await fire("agent/pre-step", { agent, messages: [m], turn: 0, step: 0, signal: (new AbortController().signal) }, nextDecision([m]));
  const placeholder = stateFor(agent.id, CFG).registry.entries()[0]?.placeholder;
  assert.ok(placeholder, "placeholder exists after redaction");

  const shadow = registered.tools[0];
  const frozenArgs = Object.freeze({ command: `echo ${placeholder}`, env: Object.freeze({ K: placeholder }) });
  await shadow.execute(frozenArgs, { token: "t", callId: "c", name: "bash", arguments: frozenArgs, signal: (new AbortController().signal), agent });
  assert.equal(executedArgs.command, `echo ${SECRET}`, "shadow executed the restored clone");
  assert.equal(executedArgs.env.K, SECRET);
  assert.equal(frozenArgs.command, `echo ${placeholder}`, "frozen original untouched");
});

test("shadow tools: unresolved placeholders are guarded (block instead of executing a fake value)", async () => {
  let executed = false;
  const defs = new Map([
    ["bash", { name: "bash", description: "d", parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => { executed = true; return { ok: true }; } }],
  ]);
  const { ctx, fire, registered } = mockCtx(defs);
  apply(ctx, CFG);
  const agent = { id: "agent-guard1", ctx: { tools: { register: ctx.tools.register, get: ctx.tools.get } } };
  await fire("agent/session-start", { agent });
  const shadow = registered.tools[0];
  await assert.rejects(
    () => shadow.execute(Object.freeze({ command: "echo rsec_deadbeef" }), { token: "t", callId: "c", name: "bash", arguments: {}, signal: new AbortController().signal, agent }),
    /unresolved placeholder/,
  );
  assert.equal(executed, false, "the original tool never ran with a literal token");
});

test("shadow tools: restoreToolArgs=false registers nothing", async () => {
  const defs = new Map([["bash", { name: "bash", description: "d", parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) }]]);
  const { ctx, fire, registered } = mockCtx(defs);
  apply(ctx, { ...CFG, restoreToolArgs: false });
  await fire("agent/session-start", { agent: { id: "agent-sh2", ctx: { tools: { register: ctx.tools.register, get: ctx.tools.get } } } });
  assert.equal(registered.tools.length, 0);
});

test("agent/disposed drops the session state", async () => {
  const { ctx, fire } = mockCtx();
  apply(ctx, CFG);
  const agent = { id: "agent-gc1" };
  const m = userMsg(`k=${SECRET}`);
  await fire("agent/pre-step", { agent, messages: [m], turn: 0, step: 0, signal: (new AbortController().signal) }, nextDecision([m]));
  const d1 = (await fire("agent/pre-step", { agent, messages: [userMsg(`again ${SECRET}`, "m2")], turn: 0, step: 1, signal: (new AbortController().signal) }, nextDecision([m])))[0];
  assert.match(JSON.stringify(d1.messages), /rsec_[0-9a-f]{8}/, "same session → same placeholder");
  await fire("agent/disposed", { agent });
  const d2 = (await fire("agent/pre-step", { agent, messages: [userMsg(`again ${SECRET}`, "m3")], turn: 0, step: 0, signal: (new AbortController().signal) }, nextDecision([m])))[0];
  const p1 = /rsec_([0-9a-f]{8})/.exec(JSON.stringify(d1.messages));
  const p2 = /rsec_([0-9a-f]{8})/.exec(JSON.stringify(d2.messages));
  assert.ok(p1 && p2 && p1[1] !== p2[1], "fresh session → fresh salt → different hash");
});

test("audit: /secret audit on then llm/stream appends leak-free evidence and counts placeholders", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsm-audit-"));
  const log = join(dir, "audit.log");
  try {
    const { ctx, fire, registered } = mockCtx();
    apply(ctx, { ...CFG, auditPath: log });
    const agent = { id: "agent-au1" };
    const cmd = registered.commands.find((c) => c.name === "secret");
    const add = await cmd.handler({ agent, rawInput: `add ${SECRET} as audit-key`, attachments: [], signal: (new AbortController().signal), commandId: "c" });
    assert.equal(add.kind, "success");
    const on = await cmd.handler({ agent, rawInput: "audit on", attachments: [], signal: (new AbortController().signal), commandId: "c" });
    assert.match(on.text, /ON/);

    const placeholderMsg = add.text.match(/rsec_[0-9a-f]{8}/)[0];
    const options = { provider: "p", model: "m", sessionId: agent.id, messages: [{ id: "m", role: "user", content: [{ type: "text", text: placeholderMsg }], source: { kind: "user" } }] };
    function* emptyStream() {}
    await fire("llm/stream", options, () => emptyStream());

    const line = JSON.parse(readFileSync(log, "utf8").trimEnd().split("\n").pop());
    assert.equal(line.leaks, 0, "placeholders on the wire → zero leaks");
    assert.equal(line.placeholders, 1);
    assert.equal(line.purpose, "conversation");
    assert.equal(line.sessionId, agent.id);
    assert.ok(!readFileSync(log, "utf8").includes(SECRET), "raw value never in the evidence file");

    // a leak (raw value reaching the wire) raises the alarm log
    const leaky = { ...options, messages: [{ id: "m", role: "user", content: [{ type: "text", text: SECRET }], source: { kind: "user" } }] };
    await fire("llm/stream", leaky, () => emptyStream());
    assert.ok(ctx.errors.some((e) => e.includes("secret-mask LEAK")), "leak alarm logged");
    const line2 = JSON.parse(readFileSync(log, "utf8").trimEnd().split("\n").pop());
    assert.equal(line2.leaks, 1);
    assert.deepEqual(line2.leakedLabels, ["audit-key"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("command add/list/status round-trip via the registered handler", async () => {
  const { ctx, registered } = mockCtx();
  apply(ctx, CFG);
  const agent = { id: "agent-cmd1" };
  const cmd = registered.commands.find((c) => c.name === "secret");
  const add = await cmd.handler({ agent, rawInput: `add ${SECRET} as k1`, attachments: [], signal: (new AbortController().signal), commandId: "c" });
  assert.match(add.text, /rsec_[0-9a-f]{8}/);
  const list = await cmd.handler({ agent, rawInput: "list", attachments: [], signal: (new AbortController().signal), commandId: "c" });
  assert.match(list.text, /1 value\(s\) registered/);
  const status = await cmd.handler({ agent, rawInput: "status", attachments: [], signal: (new AbortController().signal), commandId: "c" });
  assert.match(status.text, /ON; landing ephemeral; 1 value\(s\)/);
  const bad = await cmd.handler({ agent, rawInput: "bogus", attachments: [], signal: (new AbortController().signal), commandId: "c" });
  assert.equal(bad.kind, "error");
});

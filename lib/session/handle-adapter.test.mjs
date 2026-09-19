import assert from "node:assert/strict";
import test from "node:test";
import { HandleSessionAdapter } from "./handle-adapter.ts";

function makeFakeHandle(overrides = {}) {
  const listeners = new Set();
  const handle = {
    id: "test:1",
    source: "test",
    capabilities: { steer: false, followUp: false, getMessages: false, contextUsage: false,
      setModel: false, setThinkingLevel: false, fork: false, renameSession: false,
      compact: false, executeBash: false, listTools: false, setActiveTools: false,
      navigateTree: false, deleteSession: false, getCommands: false },
    prompt: async () => {},
    abort: async () => {},
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    dispose: async () => {},
    alive: () => true,
    isRunning: () => false,
    getModel: () => ({ id: "m1", provider: "p1" }),
    emit: (event) => { for (const l of [...listeners]) l(event); },
    ...overrides,
  };
  return handle;
}

test("message_update is synthesized into assistantMessageEvent{text_delta} — the frontend streaming render contract", async () => {
  const handle = makeFakeHandle();
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(handle);
  const seen = [];
  const unsub = adapter.onEvent((e) => seen.push(e));
  handle.emit({ type: "message_update", delta: "Hel" });
  unsub();
  const ev = seen.find((e) => e.type === "message_update");
  assert.ok(ev, "event forwarded");
  assert.deepEqual(ev.assistantMessageEvent, { type: "text_delta", contentIndex: 0, delta: "Hel" });
});

test("message_end completes the message object — the reducer's append-final-message contract", async () => {
  const handle = makeFakeHandle();
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(handle);
  const seen = [];
  const unsub = adapter.onEvent((e) => seen.push(e));
  handle.emit({ type: "message_update", delta: "He" });
  handle.emit({ type: "message_update", delta: "llo" });
  handle.emit({ type: "message_end", text: "Hello" });
  unsub();
  const ev = seen.find((e) => e.type === "message_end");
  assert.equal(ev.message.role, "assistant");
  assert.equal(ev.message.content[0].text, "Hello");
});

test("methods whose capability is missing throw UnsupportedCapabilityError (fail-loud)", async () => {
  const handle = makeFakeHandle();
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(handle);
  await assert.rejects(
    () => adapter.send({ type: "navigate_tree", targetId: "x" }),
    /Capability "navigate_tree"/,
  );
});

test("prompt mapping: text/streamingBehavior passed through", async () => {
  const seen = [];
  const handle = makeFakeHandle({
    prompt: async (text, opts) => { seen.push({ text, opts }); },
  });
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(handle);
  await adapter.send({ type: "prompt", message: "hi", streamingBehavior: "steer" });
  assert.deepEqual(seen[0], { text: "hi", opts: { streamingBehavior: "steer" } });
});

// ---- queue keeper adaptation: queueManage forwarding (backend session queue CRUD) ----

test("queueManage forwarding: move/remove/recall/clear parameter mapping and the removed wrapper", async () => {
  const calls = [];
  let queue = ["a", "b"];
  const handle = makeFakeHandle({
    queueManage: async (req) => {
      calls.push(req);
      if (req.action === "move") { const [m] = queue.splice(req.from, 1); queue.splice(req.to, 0, m); }
      if (req.action === "remove") { const [t] = queue.splice(req.index, 1); return { steering: [], followUp: queue, entry: { text: t } }; }
      if (req.action === "recall") { const [t] = queue.splice(req.index, 1); return { steering: [], followUp: queue, entry: { text: t } }; }
      return { steering: [], followUp: [...queue] };
    },
  });
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(handle);

  const mv = await adapter.send({ type: "move_queue", kind: "followUp", fromIndex: 1, toIndex: 0 });
  assert.deepEqual(mv.followUp, ["b", "a"]);

  const rm = await adapter.send({ type: "remove_queue_item", kind: "followUp", index: 0 });
  assert.equal(rm.removed.text, "b", "removed is in the QueueTrashItem shape");
  assert.equal(rm.removed.kind, "followUp");
  assert.ok(rm.removed.id && rm.removed.queuedAt, "removed metadata complete");
  assert.deepEqual(rm.followUp, ["a"]);

  const rc = await adapter.send({ type: "recall_queue_item", kind: "followUp", index: 0 });
  assert.equal(rc.entry.text, "a");

  assert.deepEqual(calls[0], { action: "move", kind: "followUp", from: 1, to: 0 });
  assert.deepEqual(calls[2], { action: "recall", kind: "followUp", index: 0 });
});

test("backends without queueManage: queue commands stay no-ops (backward compatible)", async () => {
  const handle = makeFakeHandle({});
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(handle);
  assert.equal(await adapter.send({ type: "move_queue", kind: "followUp", fromIndex: 0, toIndex: 0 }), null);
  assert.equal(await adapter.send({ type: "remove_queue_item", kind: "followUp", index: 0 }), null);
  const st = await adapter.send({ type: "get_state" });
  assert.deepEqual(st.queuedMessages, { steering: [], followUp: [] });
});

test("get_state.queuedMessages made real — queue keeper panel keeps its content across refresh", async () => {
  const handle = makeFakeHandle({
    queueManage: async (req) => {
      assert.equal(req.action, "list");
      return { steering: ["插队A"], followUp: ["排队一"] };
    },
  });
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(handle);
  const st = await adapter.send({ type: "get_state" });
  assert.deepEqual(st.queuedMessages, { steering: ["插队A"], followUp: ["排队一"] });
});

test("message_end user bubble (string content) does not throw — backend steer/continuation visibility contract", async () => {
  const handle = makeFakeHandle();
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(handle);
  const seen = [];
  const unsub = adapter.onEvent((e) => seen.push(e));
  // both legal shapes of a backend user bubble must pass through without throwing (a TypeError from content.find was observed in practice)
  handle.emit({ type: "message_end", message: { role: "user", content: "hi", timestamp: 1 } });
  handle.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 2 } });
  unsub();
  assert.equal(seen.filter((e) => e.type === "message_end").length, 2);
});

test("respond_provider_headers command maps to handle.respondProviderHeaders (capability gated)", async () => {
  const { readFile } = await import("node:fs/promises");
  const adapterSrc = await readFile(new URL("./handle-adapter.ts", import.meta.url), "utf8");
  const typesSrc = await readFile(new URL("./types.ts", import.meta.url), "utf8");
  assert.match(adapterSrc, /case "respond_provider_headers": \{[\s\S]*?h\.respondProviderHeaders[\s\S]*?captchaVerifyParam/);
  assert.match(typesSrc, /respondProviderHeaders: boolean;/);
  assert.match(typesSrc, /respondProviderHeaders\?\(requestId: string, answer: \{[\s\S]*?captchaVerifyParam\?: string;/);
});

// ---- get_entries message-shape normalization (spawn/omp history replay "empty message area" regression) ----

test("get_entries shape adaptation: pi entries unwrapped, non-message entries dropped", async () => {
  const handle = makeFakeHandle({
    capabilities: { ...makeFakeHandle().capabilities, getMessages: true },
    getMessages: async () => [
      { type: "model_change", id: "e1", provider: "p", modelId: "m" },
      { type: "thinking_level_change", id: "e2", thinkingLevel: "off" },
      { type: "message", id: "e3", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } },
      { type: "message", id: "e4", message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 } },
      { type: "session_info", id: "e5", name: "x" },
    ],
  });
  const adapter = new HandleSessionAdapter(handle);
  const r = await adapter.send({ type: "get_entries" });
  assert.equal(r.entries.length, 2, "message entries kept, other entries dropped");
  // regression assertion: a top-level role is required (before the fix the entry was passed through as-is, role undefined → blank frontend)
  assert.equal(r.entries[0].role, "user");
  assert.equal(r.entries[0].content[0].text, "hi");
  assert.equal(r.entries[1].role, "assistant");
  assert.equal(r.entries[1].content[0].text, "hello");
});

test("get_entries direct message shape (cursor/claude/codebuddy etc.) passes through untouched", async () => {
  const handle = makeFakeHandle({
    capabilities: { ...makeFakeHandle().capabilities, getMessages: true },
    getMessages: async () => [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "yo" }], model: "m", provider: "p" },
      { role: "toolResult", content: [{ type: "text", text: "ok" }], toolCallId: "t1" },
    ],
  });
  const adapter = new HandleSessionAdapter(handle);
  const r = await adapter.send({ type: "get_entries" });
  assert.equal(r.entries.length, 3, "non-entry shapes are unaffected by unwrapping");
  assert.equal(r.entries[0].role, "user");
  assert.equal(r.entries[2].role, "toolResult");
});

test("get_state.runStartedAt: agent_start records the start, replay does not reset it, agent_settled clears it", async () => {
  const handle = makeFakeHandle();
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(handle);

  // no agent_start seen: no start point delivered (frontend falls back to deriving from message timestamps)
  const idle = await adapter.send({ type: "get_state" });
  assert.equal(idle.runStartedAt, undefined);

  const before = Date.now();
  handle.emit({ type: "agent_start" });
  const started = await adapter.send({ type: "get_state" });
  assert.ok(typeof started.runStartedAt === "number" && started.runStartedAt >= before, "agent_start records the start point");

  // SSE replay / duplicate agent_start must not reset the elapsed timer to zero
  handle.emit({ type: "agent_start" });
  handle.emit({ type: "turn_start" });
  const replay = await adapter.send({ type: "get_state" });
  assert.equal(replay.runStartedAt, started.runStartedAt);

  // agent_end (turn ends but may continue) does not clear early; settle closes it out, reproducible next turn
  handle.emit({ type: "agent_end" });
  const ended = await adapter.send({ type: "get_state" });
  assert.equal(ended.runStartedAt, started.runStartedAt);
  handle.emit({ type: "agent_settled" });
  const settled = await adapter.send({ type: "get_state" });
  assert.equal(settled.runStartedAt, undefined);
});

test("get_state.runStartedAt: a new adapter on the same handle (page reopened) does not reset the timer start", async () => {
  const handle = makeFakeHandle();
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  // the adapter that accepted the prompt witnessed agent_start (a per-request temporary object, discarded afterwards)
  const first = new HandleSessionAdapter(handle);
  handle.emit({ type: "agent_start" });
  const started = await first.send({ type: "get_state" });
  assert.ok(typeof started.runStartedAt === "number");
  first.dispose?.();

  // page reopened: resolveAnySession news a fresh adapter on the same live handle — it must see the same start point
  const reopened = new HandleSessionAdapter(handle);
  const state = await reopened.send({ type: "get_state" });
  assert.equal(state.runStartedAt, started.runStartedAt, "reopen does not reset to zero");

  handle.emit({ type: "agent_settled" });
  const after = await reopened.send({ type: "get_state" });
  assert.equal(after.runStartedAt, undefined, "after settle the new instance sees no start point either");
});

// ---- task list (read-only mirror of the agent working plan; aiti-zcode-agent task-list plan) ----

test("get_state.tasks made real + empty array when the backend lacks it; task_update events pass through", async () => {
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const todos = [{ content: "A", status: "completed", priority: "high" }, { content: "B", status: "in_progress" }];
  const adapter = new HandleSessionAdapter(makeFakeHandle({ taskList: async () => ({ todos }) }));
  const st = await adapter.send({ type: "get_state" });
  assert.deepEqual(st.tasks, todos, "taskList() present → real snapshot (survives refresh)");

  const adapter2 = new HandleSessionAdapter(makeFakeHandle({}));
  const st2 = await adapter2.send({ type: "get_state" });
  assert.deepEqual(st2.tasks, [], "taskList() absent → always empty (zero impact on other backends)");

  // event pass-through (control events outside the toClientAgentEvent whitelist behave like queue_update)
  const todos3 = [todos[0]];
  const handle3 = makeFakeHandle({ taskList: async () => ({ todos: todos3 }) });
  const adapter3 = new HandleSessionAdapter(handle3);
  const seen = [];
  const unsub = adapter3.onEvent((e) => seen.push(e));
  handle3.emit({ type: "task_update", todos: [todos[0]] });
  unsub();
  const ev = seen.find((e) => e.type === "task_update");
  assert.ok(ev, "task_update passes through to the frontend");
  assert.deepEqual(ev.todos, [todos[0]]);
});

// ---- context usage projection (external agent token stats wiring) ----

test("get_state.contextUsage projects handle.getContextUsage() (presence-based, not relying on the capability boolean)", async () => {
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(makeFakeHandle({
    capabilities: { steer: false, contextUsage: false },
    getContextUsage: () => ({ percent: 37.5, contextWindow: 200000, tokens: 75000 }),
  }));
  const st = await adapter.send({ type: "get_state" });
  assert.deepEqual(st.contextUsage, { percent: 37.5, contextWindow: 200000, tokens: 75000 });
});

test("get_state.contextUsage: no method → null; method returns undefined → null (frontend \"confirms no data\")", async () => {
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const bare = await new HandleSessionAdapter(makeFakeHandle({})).send({ type: "get_state" });
  assert.equal(bare.contextUsage, null, "no getContextUsage → null");

  const empty = await new HandleSessionAdapter(makeFakeHandle({ getContextUsage: () => undefined }))
    .send({ type: "get_state" });
  assert.equal(empty.contextUsage, null, "no data frame obtained → null");
});

test("get_session_stats: getUsageTotals really accumulates + contextUsage folded in (previously hardcoded to all 0)", async () => {
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(makeFakeHandle({
    getUsageTotals: () => ({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 30, cacheWriteTokens: 5, costUsd: 0.12, turns: 3 }),
    getContextUsage: () => ({ percent: 12.5, contextWindow: 200000, tokens: 25000 }),
  }));
  const st = await adapter.send({ type: "get_session_stats" });
  assert.deepEqual(st.tokens, { input: 100, output: 40, cacheRead: 30, cacheWrite: 5, total: 175 });
  assert.equal(st.cost, 0.12);
  assert.equal(st.assistantMessages, 3);
  assert.deepEqual(st.contextUsage, { percent: 12.5, contextWindow: 200000, tokens: 25000 });
});

test("get_session_stats: no getUsageTotals → stays all 0 (old handle behavior unchanged), no contextUsage key", async () => {
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const st = await new HandleSessionAdapter(makeFakeHandle({})).send({ type: "get_session_stats" });
  assert.deepEqual(st.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  assert.equal(st.cost, 0);
  assert.equal(st.contextUsage, undefined);
});

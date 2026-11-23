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
    // The refusal names the capability (navigateTree), not the wire command: the mapping
    // routes through cap() now that handles may implement it (pi spawn rewinds in place).
    /Capability "navigateTree"/,
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

test("a backend that queued the prompt answers { queued: true } — the page drops its bubble", async () => {
  const handle = makeFakeHandle({ prompt: async () => ({ queued: true }) });
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(handle);
  assert.deepEqual(await adapter.send({ type: "prompt", message: "hi" }), { queued: true });

  const started = makeFakeHandle({ prompt: async () => undefined });
  const startedAdapter = new HandleSessionAdapter(started);
  assert.equal(await startedAdapter.send({ type: "prompt", message: "hi" }), null);
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

// ── 会话请求卡「刷新后回不来」：构造期补发的未决应答帧必须活到第一个消费者 ──

/** 后端在 subscribe 的同一 tick 同步补发未决 ask（qoder/claude 等 agent-interaction 账本契约）。 */
function makeReplayingHandle(replays) {
  const listeners = new Set();
  return {
    id: "qodercn:1",
    source: "aiti-qoder-agent",
    capabilities: {},
    prompt: async () => {},
    abort: async () => {},
    subscribe: (l) => {
      listeners.add(l);
      for (const e of replays) l(e);
      return () => listeners.delete(l);
    },
    dispose: async () => {},
    alive: () => true,
    isRunning: () => false,
    getModel: () => undefined,
    respondInteraction: async () => true,
  };
}

test("construction-time replayed interaction_request reaches the first onEvent consumer (refresh/reconnect restores the card)", async () => {
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const handle = makeReplayingHandle([
    { type: "interaction_request", requestId: "r1", kind: "plan_approval", capability: "respondInteraction", toolName: "ExitPlanMode", input: { allowedPrompts: [] } },
  ]);
  const adapter = new HandleSessionAdapter(handle);
  const seen = [];
  adapter.onEvent((e) => seen.push(e));
  const got = seen.find((e) => e.type === "interaction_request" && e.requestId === "r1");
  assert.ok(got, "补发的未决应答帧不得丢：丢了就是 CLI 永久等、前端永久没卡片");
  assert.equal(got.kind, "plan_approval");
});

test("an expiry closes the buffered ask (a turn that already ended must not resurrect its card)", async () => {
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const handle = makeReplayingHandle([
    { type: "interaction_request", requestId: "r1", kind: "tool_auth", capability: "respondInteraction", toolName: "Bash" },
    { type: "interaction_expired", requestId: "r1", reason: "turn_end" },
  ]);
  const adapter = new HandleSessionAdapter(handle);
  const seen = [];
  adapter.onEvent((e) => seen.push(e));
  assert.deepEqual(seen, [], "ask 与其过期帧都不再投递");
});

test("navigate_tree routes to a handle that owns its session file (pi spawn in-place branch)", async () => {
  const seen = [];
  const handle = makeFakeHandle({
    capabilities: { ...makeFakeHandle().capabilities, navigateTree: true },
    navigateTree: async (targetId, options) => { seen.push({ targetId, options }); return { cancelled: false }; },
  });
  const adapter = new HandleSessionAdapter(handle);
  assert.deepEqual(await adapter.send({ type: "navigate_tree", targetId: "as-1" }), { cancelled: false });
  assert.deepEqual(seen[0], { targetId: "as-1", options: { summarize: false } });
});

// ---- forkFileBranch (pi spawn: host-side branch copy, 2026-11-23) --------------
// pi's RPC fork moves the subprocess to a new file while the wrapper registry keeps
// the source id (reopen refused, copy double-writable). The host copies the branch
// itself instead — the backend is never asked.

test("forkFileBranch: fork before a user message copies the branch file and leaves the handle untouched", async () => {
  const { mkdtemp, writeFile, readFile, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "adapter-fork-"));
  const source = join(dir, "2026-11-23T00-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl");
  const entries = [
    { type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111", timestamp: "2026-11-23T00:00:00.000Z", cwd: dir },
    { type: "message", id: "um-1", parentId: null, timestamp: "2026-11-23T00:00:01.000Z", message: { role: "user", content: "first" } },
    { type: "message", id: "as-1", parentId: "um-1", timestamp: "2026-11-23T00:00:02.000Z", message: { role: "assistant", content: [] } },
    { type: "message", id: "um-2", parentId: "as-1", timestamp: "2026-11-23T00:00:03.000Z", message: { role: "user", content: "second" } },
  ];
  await writeFile(source, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const { cacheSessionPath } = await import("../session-reader.ts");
  cacheSessionPath("11111111-1111-4111-8111-111111111111", source);

  let backendForkCalled = false;
  const handle = makeFakeHandle({
    id: "11111111-1111-4111-8111-111111111111",
    capabilities: { ...makeFakeHandle().capabilities, fork: true, forkFileBranch: true },
    fork: async () => { backendForkCalled = true; return { cancelled: false }; },
  });
  const adapter = new HandleSessionAdapter(handle);
  const result = await adapter.send({ type: "fork", entryId: "um-2" });
  assert.equal(result.cancelled, false);
  assert.ok(result.newSessionId && result.newSessionId !== handle.id, "a new session id");
  assert.equal(backendForkCalled, false, "the backend process is never asked");

  const copyName = (await readdir(dir)).find((f) => f.includes(result.newSessionId));
  assert.ok(copyName, "the copy is written next to the source");
  const copied = (await readFile(join(dir, copyName), "utf8")).trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.equal(copied[0].parentSession, source, "header keeps the source reference");
  assert.deepEqual(
    copied.filter((e) => e.type === "message").map((e) => e.id),
    ["um-1", "as-1"],
    "the copy ends at the fork point (um-2 and everything after are dropped)",
  );
  assert.equal((await readFile(source, "utf8")).includes("um-2"), true, "the source file is untouched");
});

test("forkFileBranch: fork_branch without an entry copies the current leaf (composer new session)", async () => {
  const { mkdtemp, writeFile, readFile, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "adapter-fork2-"));
  const source = join(dir, "2026-11-23T00-00-00-000Z_22222222-2222-4222-8222-222222222222.jsonl");
  const entries = [
    { type: "session", version: 3, id: "22222222-2222-4222-8222-222222222222", timestamp: "2026-11-23T00:00:00.000Z", cwd: dir },
    { type: "message", id: "um-1", parentId: null, timestamp: "2026-11-23T00:00:01.000Z", message: { role: "user", content: "first" } },
    { type: "message", id: "as-1", parentId: "um-1", timestamp: "2026-11-23T00:00:02.000Z", message: { role: "assistant", content: [] } },
  ];
  await writeFile(source, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const { cacheSessionPath } = await import("../session-reader.ts");
  cacheSessionPath("22222222-2222-4222-8222-222222222222", source);

  const handle = makeFakeHandle({
    id: "22222222-2222-4222-8222-222222222222",
    capabilities: { ...makeFakeHandle().capabilities, fork: true, forkFileBranch: true },
    fork: async () => { throw new Error("the backend must not be asked"); },
  });
  const adapter = new HandleSessionAdapter(handle);
  const result = await adapter.send({ type: "fork_branch" });
  assert.equal(result.cancelled, false);
  const copyName = (await readdir(dir)).find((f) => f.includes(result.newSessionId));
  const copied = (await readFile(join(dir, copyName), "utf8")).trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(copied.filter((e) => e.type === "message").map((e) => e.id), ["um-1", "as-1"], "full context copied");
});

test("rebind-shaped fork releases the moved wrapper (source stays openable, copy stays detached)", async () => {
  // pi spawn's RPC fork moves the subprocess to the child while the registry key/socket/unit
  // still carry the SOURCE id: the source can never start an agent again and the copy has no
  // entry. The adapter must release the moved wrapper and mark the copy detached-preferred.
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const agentDir = await mkdtemp(join(tmpdir(), "adapter-rebind-agent-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir; // keep the prefs marker out of the real agent dir
  try {
    // A wrapper registry entry for the child id, with a dead pid: describe() finds it, kill()
    // finds no live endpoint and prunes the entry (returns true) — the release path still runs.
    const { mkdirSync } = await import("node:fs");
    const { registryDir } = await import("../agent-starter/registry.ts");
    mkdirSync(registryDir(), { recursive: true });
    await writeFile(join(registryDir(), "pi-child-1.json"), JSON.stringify({
      sessionId: "child-1", agentKey: "pi", key: "pi-child-1",
      socket: join(agentDir, "child-1.sock"), ready: join(agentDir, "child-1.ready"),
      log: join(agentDir, "child-1.log"), runner: "plain", createdAt: Date.now(),
      providerType: "aiti-pi-agent/spawn", cwd: agentDir, unit: "pi-agent-pi-child-1",
    }));
    const handle = makeFakeHandle({
      capabilities: { ...makeFakeHandle().capabilities, fork: true, forkRebindHandoff: true },
      fork: async () => ({ cancelled: false, newSessionFile: "child-1" }),
    });
    const adapter = new HandleSessionAdapter(handle);
    const result = await adapter.send({ type: "fork", entryId: "um-1" });
    assert.equal(result.newSessionId, "child-1");
    const { getDetachedPreference } = await import("../agent-starter/registry.ts");
    assert.equal(getDetachedPreference("child-1")?.mode, "subprocess-detached", "the copy keeps detached hosting");
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(join(registryDir(), "pi-child-1.json")), false, "the moved wrapper's entry is released");
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});

test("forkFileBranch inherits the source's detached hosting for the copy", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const agentDir = await mkdtemp(join(tmpdir(), "adapter-inherit-agent-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const { mkdirSync } = await import("node:fs");
    const { registryDir, getDetachedPreference } = await import("../agent-starter/registry.ts");
    mkdirSync(registryDir(), { recursive: true });
    const parentId = "33333333-3333-4333-8333-333333333333";
    await writeFile(join(registryDir(), `pi-${parentId}.json`), JSON.stringify({
      sessionId: parentId, agentKey: "pi", key: `pi-${parentId}`,
      socket: join(agentDir, "p.sock"), ready: join(agentDir, "p.ready"), log: join(agentDir, "p.log"),
      runner: "plain", createdAt: Date.now(), providerType: "aiti-pi-agent/spawn", cwd: agentDir,
      unit: `pi-agent-pi-${parentId}`,
    }));
    const dir = await mkdtemp(join(tmpdir(), "adapter-inherit-"));
    const source = join(dir, `2026-11-23T00-00-00-000Z_${parentId}.jsonl`);
    await writeFile(source, [
      JSON.stringify({ type: "session", version: 3, id: parentId, timestamp: "2026-11-23T00:00:00.000Z", cwd: dir }),
      JSON.stringify({ type: "message", id: "um-1", parentId: null, timestamp: "2026-11-23T00:00:01.000Z", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "message", id: "as-1", parentId: "um-1", timestamp: "2026-11-23T00:00:02.000Z", message: { role: "assistant", content: [] } }),
      JSON.stringify({ type: "message", id: "um-2", parentId: "as-1", timestamp: "2026-11-23T00:00:03.000Z", message: { role: "user", content: "again" } }),
    ].join("\n") + "\n");
    const { cacheSessionPath } = await import("../session-reader.ts");
    cacheSessionPath(parentId, source);

    const handle = makeFakeHandle({
      id: parentId,
      capabilities: { ...makeFakeHandle().capabilities, fork: true, forkFileBranch: true },
      fork: async () => { throw new Error("the backend must not be asked"); },
    });
    const adapter = new HandleSessionAdapter(handle);
    const result = await adapter.send({ type: "fork", entryId: "um-2" });
    assert.ok(result.newSessionId);
    const pref = getDetachedPreference(result.newSessionId);
    assert.equal(pref?.mode, "subprocess-detached", "the copy inherits detached hosting");
    assert.equal(pref?.agentKey, "pi");
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});

// ---- projection ids (`ext-<i>`) on file-backed handles ------------------------
// GET /api/sessions/[id] serves bridged/spawn sessions through the handle and synthesizes
// `ext-<i>` position ids for the client (lib/external-session-paging.ts). Fork/tree commands
// echo those ids back; the disk fork needs a real pi entry id, so the adapter maps them
// through the same UI list (non-message entries dropped, like the projection itself).

async function makeProjectionFixture(prefix, parentId, dir) {
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const source = join(dir, `2026-11-23T00-00-00-000Z_${parentId}.jsonl`);
  const entries = [
    { type: "session", version: 3, id: parentId, timestamp: "2026-11-23T00:00:00.000Z", cwd: dir },
    { type: "model_change", id: "mc-1", timestamp: "2026-11-23T00:00:00.500Z", provider: "p", modelId: "m" },
    { type: "message", id: "um-1", parentId: null, timestamp: "2026-11-23T00:00:01.000Z", message: { role: "user", content: "first" } },
    { type: "message", id: "as-1", parentId: "um-1", timestamp: "2026-11-23T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "one" }] } },
    { type: "message", id: "um-2", parentId: "as-1", timestamp: "2026-11-23T00:00:03.000Z", message: { role: "user", content: "second" } },
    { type: "message", id: "as-2", parentId: "um-2", timestamp: "2026-11-23T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "two" }] } },
  ];
  await writeFile(source, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const { cacheSessionPath } = await import("../session-reader.ts");
  cacheSessionPath(parentId, source);
  return { source, entries: entries.filter((e) => e.type !== "session" && e.type !== "model_change") };
}

test("forkFileBranch resolves a projection id (ext-<i>) to the real entry before copying", async () => {
  const { mkdtemp, readFile, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "adapter-fork-ext-"));
  const parentId = "44444444-4444-4444-8444-444444444444";
  const { entries } = await makeProjectionFixture("fork-ext", parentId, dir);

  const handle = makeFakeHandle({
    id: parentId,
    capabilities: { ...makeFakeHandle().capabilities, fork: true, forkFileBranch: true, getMessages: true },
    getMessages: async () => entries, // what the projection route served the client
    fork: async () => { throw new Error("the backend must not be asked"); },
  });
  const adapter = new HandleSessionAdapter(handle);
  // ext-2 = the second user message (the model_change entry is not part of the UI list).
  const result = await adapter.send({ type: "fork", entryId: "ext-2" });
  assert.equal(result.cancelled, false);
  assert.ok(result.newSessionId);
  const copyName = (await readdir(dir)).find((f) => f.includes(result.newSessionId));
  const copied = (await readFile(join(dir, copyName), "utf8")).trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(
    copied.filter((e) => e.type === "message").map((e) => e.id),
    ["um-1", "as-1"],
    "fork before um-2 — the projection index maps onto the real entry, not the file offset",
  );
});

test("forkFileBranch maps a projection id from the file when the handle cannot list messages", async () => {
  const { mkdtemp, readFile, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "adapter-fork-extfile-"));
  const parentId = "55555555-5555-4555-8555-555555555555";
  await makeProjectionFixture("fork-extfile", parentId, dir);

  const handle = makeFakeHandle({
    id: parentId,
    capabilities: { ...makeFakeHandle().capabilities, fork: true, forkFileBranch: true },
    fork: async () => { throw new Error("the backend must not be asked"); },
  });
  const adapter = new HandleSessionAdapter(handle);
  const result = await adapter.send({ type: "fork", entryId: "ext-1" });
  assert.equal(result.cancelled, false);
  const copyName = (await readdir(dir)).find((f) => f.includes(result.newSessionId));
  const copied = (await readFile(join(dir, copyName), "utf8")).trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(
    copied.filter((e) => e.type === "message").map((e) => e.id),
    ["um-1", "as-1"],
    "ext-1 = the first assistant entry → copied up to itself",
  );
});

test("navigate_tree resolves a projection id (ext-<i>) before handing it to the backend", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "adapter-nav-ext-"));
  const parentId = "66666666-6666-4666-8666-666666666666";
  const { entries } = await makeProjectionFixture("nav-ext", parentId, dir);

  const seen = [];
  const handle = makeFakeHandle({
    id: parentId,
    capabilities: { ...makeFakeHandle().capabilities, navigateTree: true, getMessages: true },
    getMessages: async () => entries,
    navigateTree: async (targetId, options) => { seen.push({ targetId, options }); return { cancelled: false }; },
  });
  const adapter = new HandleSessionAdapter(handle);
  assert.deepEqual(await adapter.send({ type: "navigate_tree", targetId: "ext-1" }), { cancelled: false });
  assert.equal(seen[0].targetId, "as-1", "the backend only ever sees real pi entry ids");
});

test("waitUntilReady delegates to a handle that bootstraps asynchronously (no half-built history)", async () => {
  // ACP/CLI handles answer get_messages long before their bootstrap (initialize + session/load)
  // finishes. The read routes wait on the adapter's seam, so it must not be a no-op.
  let released = false;
  const handle = makeFakeHandle({
    waitUntilReady: async () => { await new Promise((r) => setTimeout(r, 20)); released = true; },
  });
  const adapter = new HandleSessionAdapter(handle);
  await adapter.waitUntilReady();
  assert.equal(released, true);
});

test("waitUntilReady stays a no-op for handles without the seam", async () => {
  const adapter = new HandleSessionAdapter(makeFakeHandle());
  await adapter.waitUntilReady(); // resolves immediately, never throws
});

test("a send that finds the backend dead evicts the stale handle (next request re-attaches)", async () => {
  // The wrapper reaped/restarted under a handle, or its single-client slot was superseded:
  // the store keeps handing out that dead handle, so every read fails and a prompt silently
  // never runs (2026-11-23: page looked blank while the jsonl held the whole conversation).
  const { putHandle, listAllHandles } = await import("./handle-store.ts");
  let dead = false;
  const handle = makeFakeHandle({
    id: "dead:1",
    alive: () => !dead,
    prompt: async () => { throw new Error("[rpc-child] not running"); },
  });
  putHandle(handle);
  const adapter = new HandleSessionAdapter(handle);
  dead = true;
  await assert.rejects(() => adapter.send({ type: "prompt", message: "hi" }), /not running/);
  assert.equal(listAllHandles().some(([, h]) => h === handle), false, "the dead handle is evicted");
});

test("a failing send on a LIVE handle keeps it (transient backend error)", async () => {
  const { putHandle, listAllHandles } = await import("./handle-store.ts");
  const handle = makeFakeHandle({ id: "live:1", prompt: async () => { throw new Error("boom"); } });
  putHandle(handle);
  const adapter = new HandleSessionAdapter(handle);
  await assert.rejects(() => adapter.send({ type: "prompt", message: "hi" }), /boom/);
  assert.equal(listAllHandles().some(([, h]) => h === handle), true);
  const { removeHandle } = await import("./handle-store.ts");
  removeHandle("live:1");
});

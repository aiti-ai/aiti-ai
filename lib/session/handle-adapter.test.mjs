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

test("message_update 合成为 assistantMessageEvent{text_delta}——前端流式渲染契约", async () => {
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

test("message_end 补全 message 对象——reducer 追加最终消息的契约", async () => {
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

test("capability 缺失的方法抛 UnsupportedCapabilityError（fail-loud）", async () => {
  const handle = makeFakeHandle();
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(handle);
  await assert.rejects(
    () => adapter.send({ type: "navigate_tree", targetId: "x" }),
    /Capability "navigate_tree"/,
  );
});

test("prompt 映射：text/streamingBehavior 透传", async () => {
  const seen = [];
  const handle = makeFakeHandle({
    prompt: async (text, opts) => { seen.push({ text, opts }); },
  });
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(handle);
  await adapter.send({ type: "prompt", message: "hi", streamingBehavior: "steer" });
  assert.deepEqual(seen[0], { text: "hi", opts: { streamingBehavior: "steer" } });
});

// ---- queue keeper 适配：queueManage 转发（后端会话队列 CRUD）----

test("queueManage 转发：move/remove/recall/clear 参数映射与 removed 包装", async () => {
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
  assert.equal(rm.removed.text, "b", "removed 为 QueueTrashItem 形状");
  assert.equal(rm.removed.kind, "followUp");
  assert.ok(rm.removed.id && rm.removed.queuedAt, "removed 元数据齐全");
  assert.deepEqual(rm.followUp, ["a"]);

  const rc = await adapter.send({ type: "recall_queue_item", kind: "followUp", index: 0 });
  assert.equal(rc.entry.text, "a");

  assert.deepEqual(calls[0], { action: "move", kind: "followUp", from: 1, to: 0 });
  assert.deepEqual(calls[2], { action: "recall", kind: "followUp", index: 0 });
});

test("queueManage 缺席的后端：队列命令维持 no-op（向后兼容）", async () => {
  const handle = makeFakeHandle({});
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(handle);
  assert.equal(await adapter.send({ type: "move_queue", kind: "followUp", fromIndex: 0, toIndex: 0 }), null);
  assert.equal(await adapter.send({ type: "remove_queue_item", kind: "followUp", index: 0 }), null);
  const st = await adapter.send({ type: "get_state" });
  assert.deepEqual(st.queuedMessages, { steering: [], followUp: [] });
});

test("get_state.queuedMessages 真实化——queue keeper 面板刷新后不丢", async () => {
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

test("message_end user 气泡（content 为 string）不抛——后端 steer/续轮可见性契约", async () => {
  const handle = makeFakeHandle();
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(handle);
  const seen = [];
  const unsub = adapter.onEvent((e) => seen.push(e));
  // 后端 user 气泡的两种合法形状都必须直通不抛（实测曾因 content.find 报 TypeError）
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

// ---- get_entries 消息形状归一（spawn/omp 历史回放「消息区空白」回归）----

test("get_entries 形状自适应：pi entries 解包、非消息 entry 丢弃", async () => {
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
  assert.equal(r.entries.length, 2, "message entry 保留、其余 entry 丢弃");
  // 回归断言：必须有顶层 role（修复前是 entry 原样透传，role 为 undefined → 前端空白）
  assert.equal(r.entries[0].role, "user");
  assert.equal(r.entries[0].content[0].text, "hi");
  assert.equal(r.entries[1].role, "assistant");
  assert.equal(r.entries[1].content[0].text, "hello");
});

test("get_entries 直传消息形状（cursor/claude/codebuddy 等）原样通过", async () => {
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
  assert.equal(r.entries.length, 3, "非 entry 形状不受解包影响");
  assert.equal(r.entries[0].role, "user");
  assert.equal(r.entries[2].role, "toolResult");
});

test("get_state.runStartedAt：agent_start 记起点、重放不回零、agent_settled 清空", async () => {
  const handle = makeFakeHandle();
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(handle);

  // 未见 agent_start：不下发起点（前端退到消息时间戳推导）
  const idle = await adapter.send({ type: "get_state" });
  assert.equal(idle.runStartedAt, undefined);

  const before = Date.now();
  handle.emit({ type: "agent_start" });
  const started = await adapter.send({ type: "get_state" });
  assert.ok(typeof started.runStartedAt === "number" && started.runStartedAt >= before, "agent_start 记起点");

  // SSE 重放/重复 agent_start 不得把读秒回零
  handle.emit({ type: "agent_start" });
  handle.emit({ type: "turn_start" });
  const replay = await adapter.send({ type: "get_state" });
  assert.equal(replay.runStartedAt, started.runStartedAt);

  // agent_end（轮次收尾但可能续轮）不提前清；settle 才收口，下轮可复现
  handle.emit({ type: "agent_end" });
  const ended = await adapter.send({ type: "get_state" });
  assert.equal(ended.runStartedAt, started.runStartedAt);
  handle.emit({ type: "agent_settled" });
  const settled = await adapter.send({ type: "get_state" });
  assert.equal(settled.runStartedAt, undefined);
});

test("get_state.runStartedAt：同一 handle 上新建 adapter（页面重开）读秒起点不回零", async () => {
  const handle = makeFakeHandle();
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  // 受理 prompt 的 adapter 亲历 agent_start（逐请求临时对象，随后被丢弃）
  const first = new HandleSessionAdapter(handle);
  handle.emit({ type: "agent_start" });
  const started = await first.send({ type: "get_state" });
  assert.ok(typeof started.runStartedAt === "number");
  first.dispose?.();

  // 页面重开：resolveAnySession 对同一存活 handle new 新 adapter——必须看到同一起点
  const reopened = new HandleSessionAdapter(handle);
  const state = await reopened.send({ type: "get_state" });
  assert.equal(state.runStartedAt, started.runStartedAt, "重开不回零");

  handle.emit({ type: "agent_settled" });
  const after = await reopened.send({ type: "get_state" });
  assert.equal(after.runStartedAt, undefined, "settled 后新实例同样看不到起点");
});

// ---- 任务列表（agent working plan 只读镜像；aiti-zcode-agent task-list 方案）----

test("get_state.tasks 真实化 + 缺席后端空数组；task_update 事件直通", async () => {
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const todos = [{ content: "A", status: "completed", priority: "high" }, { content: "B", status: "in_progress" }];
  const adapter = new HandleSessionAdapter(makeFakeHandle({ taskList: async () => ({ todos }) }));
  const st = await adapter.send({ type: "get_state" });
  assert.deepEqual(st.tasks, todos, "taskList() 存在 → 真实快照（刷新不丢）");

  const adapter2 = new HandleSessionAdapter(makeFakeHandle({}));
  const st2 = await adapter2.send({ type: "get_state" });
  assert.deepEqual(st2.tasks, [], "taskList() 缺席 → 恒空（其他后端零影响）");

  // 事件直通（toClientAgentEvent 白名单外控制事件同 queue_update）
  const todos3 = [todos[0]];
  const handle3 = makeFakeHandle({ taskList: async () => ({ todos: todos3 }) });
  const adapter3 = new HandleSessionAdapter(handle3);
  const seen = [];
  const unsub = adapter3.onEvent((e) => seen.push(e));
  handle3.emit({ type: "task_update", todos: [todos[0]] });
  unsub();
  const ev = seen.find((e) => e.type === "task_update");
  assert.ok(ev, "task_update 直通前端");
  assert.deepEqual(ev.todos, [todos[0]]);
});

// ---- 上下文用量投影（外部 agent token 统计打通；docs/pi-web-external-agent-context-usage-plan.md）----

test("get_state.contextUsage 投影 handle.getContextUsage()（presence-based，不依赖 capability 布尔）", async () => {
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const adapter = new HandleSessionAdapter(makeFakeHandle({
    capabilities: { steer: false, contextUsage: false },
    getContextUsage: () => ({ percent: 37.5, contextWindow: 200000, tokens: 75000 }),
  }));
  const st = await adapter.send({ type: "get_state" });
  assert.deepEqual(st.contextUsage, { percent: 37.5, contextWindow: 200000, tokens: 75000 });
});

test("get_state.contextUsage：无方法 → null；方法返回 undefined → null（前端「确认无数据」）", async () => {
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const bare = await new HandleSessionAdapter(makeFakeHandle({})).send({ type: "get_state" });
  assert.equal(bare.contextUsage, null, "无 getContextUsage → null");

  const empty = await new HandleSessionAdapter(makeFakeHandle({ getContextUsage: () => undefined }))
    .send({ type: "get_state" });
  assert.equal(empty.contextUsage, null, "未拿到数据帧 → null");
});

test("get_session_stats：getUsageTotals 真实累计 + contextUsage 并入（此前硬编码全 0）", async () => {
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

test("get_session_stats：无 getUsageTotals → 维持全 0（旧 handle 行为不变），无 contextUsage 键", async () => {
  const { HandleSessionAdapter } = await import("./handle-adapter.ts");
  const st = await new HandleSessionAdapter(makeFakeHandle({})).send({ type: "get_session_stats" });
  assert.deepEqual(st.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  assert.equal(st.cost, 0);
  assert.equal(st.contextUsage, undefined);
});

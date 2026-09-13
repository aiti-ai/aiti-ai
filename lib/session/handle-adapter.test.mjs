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

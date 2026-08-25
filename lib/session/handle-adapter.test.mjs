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

// getEventBus 适配器契约单测（页面事件唯一 SSE 收敛的传输层）：
//   - onmessage 属性式句柄必须真正接进帧分发（曾漏接线：赋值落在普通数据属性上，
//     总线模式下数据帧永远进不了订阅方——named/心跳/onopen 均正常，极难察觉）；
//   - 帧重组契约：{type: topic, evt, ...payload} → onmessage 收 {type: evt, ...payload}；
//   - 总线缺席定案：极简 window 桩（无事件面）→ 同步返回 null，调用方回退原样 EventSource。
// 隔离：busAbsent/全局 ready 监听是模块级状态，jiti moduleCache:false 每用例独立实例。
// Run: node --experimental-strip-types --test lib/event-bus-client.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });

async function freshLib(windowStub) {
  globalThis.window = windowStub;
  return jiti.import("./event-bus-client.ts");
}

/** boot-settle 测试用：settle + 微任务排空。signal 从 event-bus-client 模块图内拿
 *  （re-export 同实例），busAbsent 等模块级状态随 freshLib 的 moduleCache:false 每用例隔离。 */
async function freshSettleLib(windowStub) {
  globalThis.window = windowStub;
  const mod = await jiti.import("./event-bus-client.ts");
  return {
    getEventBus: mod.getEventBus,
    async settleAndDrain() {
      mod.notifyExtBootSettled();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

test("bus adapter delivers reassembled frames to the onmessage property handle", async () => {
  let deliver;
  const slot = {
    subscribeTopics(handler) {
      deliver = handler;
      return { ready: Promise.resolve(), off() {} };
    },
  };
  const { getEventBus } = await freshLib({
    addEventListener() {}, removeEventListener() {}, __piEventBus: slot,
  });
  const bus = getEventBus("/api/terminal/x/events", { topic: "terminal-x" });
  assert.ok(bus, "总线在场时必须返回适配器");
  const seen = [];
  bus.onmessage = (message) => seen.push(JSON.parse(message.data));
  deliver({ type: "terminal-x", evt: "output", data: "hi", offset: 3 });
  deliver({ type: "terminal-x", evt: "output", data: "!", offset: 4 });
  assert.deepEqual(seen, [
    { type: "output", data: "hi", offset: 3 },
    { type: "output", data: "!", offset: 4 },
  ]);
  bus.close();
});

test("adapter reassembles named events for addEventListener subscribers (心跳契约)", async () => {
  let deliver;
  const slot = {
    subscribeTopics(handler) {
      deliver = handler;
      return { ready: Promise.resolve(), off() {} };
    },
  };
  const { getEventBus } = await freshLib({
    addEventListener() {}, removeEventListener() {}, __piEventBus: slot,
  });
  const bus = getEventBus("/api/agent/running/events", { topic: "running" });
  const beats = [];
  bus.addEventListener("heartbeat", (m) => beats.push(m.data));
  deliver({ type: "running", evt: "heartbeat", at: 1 });
  assert.equal(beats.length, 1);
  bus.close();
});

test("absent bus verdict returns null so callers fall back to raw EventSource", async () => {
  // 极简桩（只有 dispatchEvent，无事件面）→ 同步定案缺席；此前该路径漏接线导致
  // 回退分支是死代码（getEventBus 恒真值，无 aiti-event-bus 的部署永远连不上）。
  const { getEventBus } = await freshLib({ dispatchEvent: () => true });
  const bus = getEventBus("/api/agent/running/events", {});
  assert.equal(bus, null);
});

// ---- 统一 SSE 端口方案 §3-C1：缺席定案锚定 boot settle（替代固定 3s 超时）----

test("waiting adapter subscribes when boot settles with the slot present", async () => {
  let deliver;
  const slot = {
    subscribeTopics(handler) {
      deliver = handler;
      return { ready: Promise.resolve(), off() {} };
    },
  };
  const lib = await freshSettleLib({
    addEventListener() {}, removeEventListener() {}, __piEventBus: undefined,
  });
  // 先拿不到槽（loader 懒加载竞态）→ 适配器进入等待态（非 null、未定案）
  const bus = lib.getEventBus("/api/agent/running/events", { topic: "running" });
  assert.ok(bus, "等待态返回适配器（不回退）");
  // 槽挂上（register）→ settle 信号触发 → 上总线收帧
  globalThis.window.__piEventBus = slot;
  await lib.settleAndDrain();
  const seen = [];
  bus.onmessage = (m) => seen.push(JSON.parse(m.data));
  deliver({ type: "running", running: true });
  assert.deepEqual(seen, [{ type: "running", running: true }], "settle 后槽在 → 总线通道生效");
  bus.close();
});

test("boot settled without slot → getEventBus returns null synchronously (absent verdict)", async () => {
  const lib = await freshSettleLib({ addEventListener() {}, removeEventListener() {} });
  await lib.settleAndDrain();
  const bus = lib.getEventBus("/api/agent/running/events", {});
  assert.equal(bus, null, "settle 后槽仍不在 → 立即定案缺席（同步回退，不再等固定超时）");
});

test("waiting adapter goes CLOSED via settle when slot never shows up", async () => {
  const lib = await freshSettleLib({
    addEventListener() {}, removeEventListener() {}, __piEventBus: undefined,
  });
  const bus = lib.getEventBus("/api/agent/running/events", {});
  assert.ok(bus);
  const errors = [];
  bus.onerror = (e) => errors.push(e);
  await lib.settleAndDrain();
  assert.equal(bus.readyState, 2, "settle 时槽不在 → 适配器转 CLOSED（调用方回退原 SSE）");
  assert.equal(errors.length, 1, "一次性 onerror 已触发");
});

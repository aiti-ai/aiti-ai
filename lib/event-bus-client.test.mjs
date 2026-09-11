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

/** 部署定案测试用：驱动 manifest 定案 + 微任务排空。信号从 event-bus-client 模块图内拿
 *  （re-export 同实例），busAbsent 等模块级状态随 freshLib 的 moduleCache:false 每用例隔离。 */
async function freshVerdictLib(windowStub) {
  globalThis.window = windowStub;
  const mod = await jiti.import("./event-bus-client.ts");
  return {
    getEventBus: mod.getEventBus,
    async deployed(value) {
      mod.settleEventBusDeployed(value);
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

// ---- 统一 SSE 端口方案 v2（用户拍板）：部署定案 + 未 ready 排队（不回退不超时）----

test("已部署未 ready：getEventBus 排队挂起（非 null 非 CLOSED），ready 广播后接上收帧", async () => {
  let deliver;
  const slot = {
    subscribeTopics(handler) {
      deliver = handler;
      return { ready: Promise.resolve(), off() {} };
    },
  };
  const lib = await freshVerdictLib({
    listeners: new Map(),
    addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); },
    removeEventListener() {}, __piEventBus: undefined,
  });
  // manifest 定案：已部署（但 client 尚未 register 挂槽）
  await lib.deployed(true);
  const bus = lib.getEventBus("/api/agent/running/events", { topic: "running" });
  assert.ok(bus, "已部署未 ready → 适配器排队（绝不回退 null）");
  assert.equal(bus.readyState, 0, "排队期 CONNECTING（调用方视为连接建立中，不另起原生 ES）");
  // client register 挂槽 + ready 广播 → 队列里的订阅接上总线
  globalThis.window.__piEventBus = slot;
  for (const fn of globalThis.window.listeners.get("piwe-event-bus-ready") ?? []) fn();
  await new Promise((r) => setTimeout(r, 0));
  const seen = [];
  bus.onmessage = (m) => seen.push(JSON.parse(m.data));
  deliver({ type: "running", running: true });
  assert.deepEqual(seen, [{ type: "running", running: true }], "queue 里的订阅在 ready 后统一接上总线");
  bus.close();
});

test("manifest 定案未部署 → getEventBus 同步返回 null（唯一回退条件）", async () => {
  const lib = await freshVerdictLib({ addEventListener() {}, removeEventListener() {} });
  await lib.deployed(false);
  const bus = lib.getEventBus("/api/agent/running/events", {});
  assert.equal(bus, null, "未部署 → 同步回退原生（调用方按各自契约）");
});

test("排队中的 adapter 在翻转为未部署时转 CLOSED + 一次性 onerror（调用方回退）", async () => {
  const lib = await freshVerdictLib({
    addEventListener() {}, removeEventListener() {}, __piEventBus: undefined,
  });
  const bus = lib.getEventBus("/api/agent/running/events", {});
  assert.ok(bus, "未知（manifest 未回）乐观排队");
  const errors = [];
  bus.onerror = (e) => errors.push(e);
  await lib.deployed(false); // manifest 回来：没装总线 → 翻转定案
  assert.equal(bus.readyState, 2, "定案未部署 → 排队适配器转 CLOSED");
  assert.equal(errors.length, 1, "一次性 onerror 已触发（调用方回退原 SSE）");
});

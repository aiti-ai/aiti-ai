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

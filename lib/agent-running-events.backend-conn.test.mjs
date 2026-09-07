// ─────────────────────────────────────────────────────────────────────────────
// running/events broker 的后端断连/恢复广播（pi-web 重启提示横幅的数据源）单测
//
// 契约（lib/agent-running-events.ts）：
//   - EventSource onerror 连续 ≥2 次 → 广播一次 "offline"（过滤单次网络抖动）；
//   - onopen → 失败计数清零；若此前广播过 offline → 广播一次 "online"；
//   - 只广播状态迁移（offline 期间继续失败不重复广播）；
//   - 双通道：模块级订阅回调 + window "piwe-backend-conn" CustomEvent。
//
// 隔离说明：模块内 `lastConnState`/`connStateListeners` 是模块级单例。node:test 每个
// 用例需用独立的模块实例（jiti moduleCache:false + 每次重新 import），否则上一个用例
// 残留的 offline/online 状态会污染下一个（曾导致 recreation 用例误判）。
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

class FakeEventSource {
  readyState = CONNECTING;
  onopen = null;
  onmessage = null;
  onerror = null;
  closeCount = 0;

  constructor() { FakeEventSource.instances.push(this); }
  addEventListener(_type, _handler) { /* heartbeat 等 named event：本测试不触达 */ }
  open() { this.readyState = OPEN; this.onopen?.(new Event("open")); }
  error() { this.readyState = CLOSED; this.onerror?.(new Event("error")); }
  close() { this.readyState = CLOSED; this.closeCount += 1; }
}
FakeEventSource.instances = [];

const windowEvents = [];
globalThis.window = {
  dispatchEvent: (e) => { windowEvents.push(e); return true; },
};
globalThis.EventSource = FakeEventSource;

const jiti = createJiti(import.meta.url, { moduleCache: false });

/** 独立模块实例：每个用例各自 import，隔离模块级 lastConnState/connStateListeners */
function freshLib() {
  return jiti.import("./agent-running-events.ts");
}

/** 干净的 broker + 订阅（上一 broker 随全部退订而销毁，connFails/connOffline 归零重建）
 *  @param libInst 可选：同一用例内需要共享模块级 lastConnState 时传入（如 recreation 用例） */
async function harness(libInst) {
  const lib = libInst ?? await freshLib();
  FakeEventSource.instances = [];
  windowEvents.length = 0;
  // broker 单例挂在共享 window 上，teardown 已销毁；这里兜底清空防止残留串场
  globalThis.window.__runningEventsBroker = null;
  const states = [];
  const unsubConn = lib.onBackendConnChange((s) => states.push(s));
  const unsubBroker = lib.subscribeRunningEvents(() => {});
  return {
    lib,
    states,
    windowStates: () => windowEvents.map((e) => e.detail?.state),
    source: () => FakeEventSource.instances.at(-1),
    teardown() { unsubBroker(); unsubConn(); },
  };
}

test("getBackendConnState starts null before any broadcast", async () => {
  const lib = await freshLib();
  assert.equal(lib.getBackendConnState(), null);
});

test("offline after 2 consecutive failures, online on reopen, transitions only", async () => {
  const h = await harness();
  try {
    // 单次失败（如重启刚掐断在途连接 / 网络抖动）→ 不广播
    h.source().error();
    assert.deepEqual(h.states, []);
    assert.deepEqual(h.windowStates(), []);

    // 第二次失败（重建循环拒连/502）→ 判定断连，广播一次
    h.source().error();
    assert.deepEqual(h.states, ["offline"]);
    assert.deepEqual(h.windowStates(), ["offline"]);
    assert.equal(h.lib.getBackendConnState(), "offline");

    // offline 期间继续失败 → 只广播状态迁移，不重复
    h.source().error();
    h.source().error();
    assert.deepEqual(h.states, ["offline"]);

    // 重连建起 → 广播恢复；再次 open（无前置 offline）→ 不广播
    h.source().open();
    assert.deepEqual(h.states, ["offline", "online"]);
    h.source().open();
    assert.deepEqual(h.states, ["offline", "online"]);

    // 恢复后单次抖动 → 不广播
    h.source().error();
    assert.deepEqual(h.states, ["offline", "online"]);

    // 再次断连 → 再次广播成对迁移
    h.source().error();
    assert.deepEqual(h.states, ["offline", "online", "offline"]);
    h.source().open();
    assert.deepEqual(h.states, ["offline", "online", "offline", "online"]);
    assert.deepEqual(h.windowStates(), ["offline", "online", "offline", "online"]);
  } finally {
    h.teardown();
  }
});

test("unsubscribed listener no longer receives state changes", async () => {
  const h = await harness();
  const states2 = [];
  const unsub2 = h.lib.onBackendConnChange((s) => states2.push(s));
  unsub2();
  try {
    h.source().error();
    h.source().error();
    assert.deepEqual(h.states, ["offline"]); // 在订的照常
    assert.deepEqual(states2, []);           // 已退订的不再收到
  } finally {
    h.teardown();
  }
});

test("broker recreation corrects a stale offline state on reopen", async () => {
  const lib = await freshLib(); // 同一用例内共享模块级 lastConnState
  const h = await harness(lib);
  try {
    h.source().error();
    h.source().error();          // 广播 offline
    assert.deepEqual(h.states, ["offline"]);
  } finally {
    h.teardown();                // broker 全退订销毁（offline 态未恢复）
  }
  const h2 = await harness(lib); // 重建 broker：connOffline 归零，lastConnState 仍是 offline
  try {
    h2.source().open();          // 首个成功连接负责纠正 → 广播 online
    assert.deepEqual(h2.states, ["online"]);
    assert.equal(h2.lib.getBackendConnState(), "online");
  } finally {
    h2.teardown();
  }
});
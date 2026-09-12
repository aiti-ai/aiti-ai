import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentEventConnection } = await jiti.import("./agent-event-connection.ts");

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

class FakeEventSource {
  readyState = CONNECTING;
  onmessage = null;
  onerror = null;
  closeCount = 0;

  open() { this.readyState = OPEN; }
  message(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
  /** 模拟网络层闪断：error 事件时 readyState=CONNECTING（浏览器会自动重连，宿主手动退避重试）。 */
  error() {
    this.readyState = CONNECTING;
    this.onerror?.(new Event("error"));
  }
  /** 模拟 HTTP 层拒绝（如 404）：error 事件时 readyState=CLOSED（浏览器终止，宿主也应停止重连）。 */
  httpError() {
    this.readyState = CLOSED;
    this.onerror?.(new Event("error"));
  }
  close() {
    this.readyState = CLOSED;
    this.closeCount += 1;
  }
}

function createHarness({ readinessTimeoutMs = 100, reconnectDelayMs = 5 } = {}) {
  const sources = [];
  const events = [];
  const activities = [];
  const troubles = [];
  const unexpectedErrors = [];
  let activeSession = "session-a";
  let demand = false;
  const connection = new AgentEventConnection({
    createSource(sessionId) {
      const source = new FakeEventSource();
      source.sessionId = sessionId;
      sources.push(source);
      return source;
    },
    onEvent(event) { events.push(event); },
    shouldMaintain: (sessionId) => demand && sessionId === activeSession,
    readinessTimeoutMs,
    reconnectDelayMs,
    onUnexpectedError(error) { unexpectedErrors.push(error); },
    onActivity() { activities.push(Date.now()); },
    onTrouble() { troubles.push(Date.now()); },
  });
  return {
    connection,
    sources,
    events,
    activities,
    troubles,
    unexpectedErrors,
    setActiveSession(sessionId) { activeSession = sessionId; },
    setDemand(value) { demand = value; },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("shares one source and waits past the former transport deadline", async () => {
  const { connection, sources, events } = createHarness();
  const first = connection.ensureConnected("session-a");
  const second = connection.ensureConnected("session-a");

  assert.equal(sources.length, 1);
  sources[0].open();
  await wait(20);
  sources[0].message({ type: "connected" });
  await Promise.all([first, second]);

  sources[0].message({ type: "agent_start" });
  assert.deepEqual(events.map((event) => event.type), ["connected", "agent_start"]);
});

test("times out all waiters and closes the stalled source", async () => {
  const { connection, sources } = createHarness({ readinessTimeoutMs: 10 });
  const first = connection.ensureConnected("session-a");
  const second = connection.ensureConnected("session-a");

  await assert.rejects(first, (error) => error.status === "ready_timeout");
  await assert.rejects(second, (error) => error.status === "ready_timeout");
  assert.equal(sources[0].closeCount, 1);
});

test("manual close rejects waiters and isolates late events", async () => {
  const { connection, sources, events } = createHarness();
  const abandoned = connection.ensureConnected("session-a");
  const oldSource = sources[0];
  connection.close();
  await assert.rejects(abandoned, (error) => error.status === "closed");

  const replacement = connection.ensureConnected("session-a");
  oldSource.open();
  oldSource.message({ type: "connected" });
  await nextTurn();
  assert.deepEqual(events, []);

  sources[1].open();
  sources[1].message({ type: "connected" });
  await replacement;
});

test("surfaces startup errors without retrying or dispatching them", async () => {
  const { connection, sources, events } = createHarness();
  const ready = connection.ensureConnected("session-a");
  sources[0].open();
  sources[0].message({ type: "startup_error", errorMessage: "broken config" });

  await assert.rejects(ready, (error) => (
    error.status === "startup_error" && error.message === "broken config"
  ));
  await wait(10);
  assert.equal(sources.length, 1);
  assert.deepEqual(events, []);
});

test("replaces a previously connected CONNECTING source only once", async () => {
  const { connection, sources } = createHarness();
  const initial = connection.ensureConnected("session-a");
  sources[0].open();
  sources[0].message({ type: "connected" });
  await initial;

  sources[0].readyState = CONNECTING;
  const first = connection.ensureConnected("session-a");
  const second = connection.ensureConnected("session-a");
  await nextTurn();
  assert.equal(sources.length, 2);

  sources[1].open();
  sources[1].message({ type: "connected" });
  await Promise.all([first, second]);
});

test("heartbeat pings refresh activity without reaching event handlers", async () => {
  const { connection, sources, events, activities, troubles } = createHarness();
  const ready = connection.ensureConnected("session-a");
  sources[0].open();
  sources[0].message({ type: "connected" });
  await ready;

  sources[0].message({ type: "ping", ts: Date.now() });
  sources[0].message({ type: "agent_start" });
  sources[0].message({ type: "ping", ts: Date.now() });

  assert.equal(activities.length, 4); // connected + ping + agent_start + ping 都算活跃
  assert.equal(troubles.length, 0);
  assert.deepEqual(events.map((event) => event.type), ["connected", "agent_start"]); // ping 不入业务事件
});

test("transport errors signal trouble before passive retry", async () => {
  const { connection, sources, troubles, setDemand } = createHarness();
  setDemand(true);
  connection.maintain("session-a");

  sources[0].error();
  assert.equal(troubles.length, 1);
  await wait(10);
  assert.equal(sources.length, 2); // 仍按被动重连调度

  // 完成重连接手并撤销维护，避免悬挂循环拖住事件循环
  sources[1].open();
  sources[1].message({ type: "connected" });
  setDemand(false);
  connection.close();
});

test("manual close does not signal trouble", async () => {
  const { connection, sources, troubles } = createHarness();
  const ready = connection.ensureConnected("session-a");
  sources[0].open();
  sources[0].message({ type: "connected" });

  connection.close();
  assert.equal(troubles.length, 0); // 主动关闭不是通道故障
  await assert.rejects(ready, (error) => error.status === "closed");
});

test("passive maintenance retries a transient failure once", async () => {
  const { connection, sources, setDemand } = createHarness();
  setDemand(true);
  connection.maintain("session-a");
  sources[0].error();
  await wait(10);
  assert.equal(sources.length, 2);

  sources[1].open();
  sources[1].message({ type: "connected" });
  await wait(10);
  assert.equal(sources.length, 2);
});

test("an explicit startup error cancels a pending passive retry", async () => {
  const { connection, sources, setDemand } = createHarness();
  setDemand(true);
  connection.maintain("session-a");
  sources[0].error();

  const explicit = connection.ensureConnected("session-a");
  sources[1].open();
  sources[1].message({ type: "startup_error", errorMessage: "terminal" });
  await assert.rejects(explicit, (error) => error.status === "startup_error");
  await wait(10);
  assert.equal(sources.length, 2);
});

test("dropped demand, session switches, and close cannot revive an old retry", async () => {
  const first = createHarness();
  first.setDemand(true);
  first.connection.maintain("session-a");
  first.sources[0].error();
  first.setDemand(false);
  await wait(10);
  assert.equal(first.sources.length, 1);

  const second = createHarness();
  second.setDemand(true);
  second.connection.maintain("session-a");
  second.sources[0].error();
  second.setActiveSession("session-b");
  const ready = second.connection.ensureConnected("session-b");
  second.sources[1].open();
  second.sources[1].message({ type: "connected" });
  await ready;
  await wait(10);
  assert.equal(second.sources.length, 2);

  const closed = createHarness();
  closed.setDemand(true);
  closed.connection.maintain("session-a");
  closed.sources[0].error();
  closed.connection.close();
  await wait(10);
  assert.equal(closed.sources.length, 1);
});

// ---- 重连风暴治理（2026-09-12）：HTTP 层错误终态 + 指数退避 ----

test("HTTP 层错误（readyState=CLOSED）以 startup_error 终结，不再固定间隔重连", async () => {
  const { connection, sources, troubles, setDemand } = createHarness();
  setDemand(true);
  connection.maintain("session-a");

  sources[0].httpError();
  assert.equal(troubles.length, 1); // 故障信号照常上报
  await wait(30);
  // 修复前：每秒 1 个 events + 1 个探针上报的 404 风暴；修复后：不建新源，等上层 maintain 重建
  assert.equal(sources.length, 1);
  assert.equal(sources[0].closeCount, 1);

  // 会话恢复后由上层 maintain() 触发点重建
  connection.maintain("session-a");
  assert.equal(sources.length, 2);
  sources[1].open();
  sources[1].message({ type: "connected" });
  setDemand(false);
  connection.close();
});

test("瞬断重连指数退避（base ×2 递增，连接成功后清零）", async () => {
  const { connection, sources, setDemand } = createHarness({ reconnectDelayMs: 100 });
  setDemand(true);
  connection.maintain("session-a");

  // 第 1 次瞬断 → 100ms 后重试
  sources[0].error();
  await wait(160);
  assert.equal(sources.length, 2, "首次重试（base 100ms）已发生");

  // 第 2 次瞬断 → 间隔翻倍 200ms：到期前不得重试
  sources[1].error();
  await wait(120);
  assert.equal(sources.length, 2, "第二次重试延迟翻倍（200ms），120ms 内不应发生");
  await wait(140);
  assert.equal(sources.length, 3, "第二次重试（~200ms）已发生");

  // 连接成功 → 退避计数清零：再断按 base（100ms）而非 400ms 重试
  sources[2].open();
  sources[2].message({ type: "connected" });
  sources[2].error();
  await wait(160);
  assert.equal(sources.length, 4, "连接成功后退避计数清零（按 base 重试）");

  sources[3].open();
  sources[3].message({ type: "connected" });
  setDemand(false);
  connection.close();
});

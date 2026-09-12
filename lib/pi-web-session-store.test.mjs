import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getSessionSnapshot,
  publishSessionState,
  subscribeSessionState,
  piWebSessionService,
} = await jiti.import("./pi-web-session-store.ts");

// window 事件通道 stub（publish 内部 typeof window 检查——运行时设置即可）
const dispatched = [];
globalThis.window = {
  dispatchEvent(event) {
    dispatched.push(event);
    return true;
  },
};

test("initial snapshot is none/initial with rev 0", () => {
  const s = getSessionSnapshot();
  assert.equal(s.phase, "none");
  assert.equal(s.requestedId, null);
  assert.equal(s.sessionId, null);
  assert.equal(s.session, null);
  assert.equal(s.source, "initial");
  assert.equal(s.rev, 0);
});

test("subscribe replays the current snapshot immediately, then streams updates", () => {
  const seen = [];
  const unsub = subscribeSessionState((s) => seen.push(s));
  assert.equal(seen.length, 1, "订阅即回调一次当前快照");

  // resolving（URL ?session= 未验证）
  publishSessionState({
    phase: "resolving",
    requestedId: "deadbeef",
    sessionId: null,
    session: null,
    source: "url",
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].phase, "resolving");
  assert.equal(seen[1].requestedId, "deadbeef");
  assert.equal(seen[1].rev, 1, "rev 自增");

  // 相同内容重复 publish 不重发
  publishSessionState({
    phase: "resolving",
    requestedId: "deadbeef",
    sessionId: null,
    session: null,
    source: "url",
  });
  assert.equal(seen.length, 2, "重复状态不通知");

  unsub();
  publishSessionState({
    phase: "none",
    requestedId: "deadbeef",
    sessionId: null,
    session: null,
    source: "url-failed",
  });
  assert.equal(seen.length, 2, "退订后不再收到");
  assert.equal(getSessionSnapshot().source, "url-failed");
});

test("active snapshot carries the canonical session summary", () => {
  const summary = { id: "s1", cwd: "/repo", name: "工作会话", firstMessage: "hi" };
  publishSessionState({
    phase: "active",
    requestedId: "old-id",
    sessionId: "s1",
    session: summary,
    source: "canonicalized",
  });
  const s = getSessionSnapshot();
  assert.equal(s.phase, "active");
  assert.equal(s.sessionId, "s1");
  assert.equal(s.requestedId, "old-id", "requestedId 保留原始 id 供对照");
  assert.deepEqual({ ...s.session }, summary);
});

test("session name changes re-publish; identical summaries do not", () => {
  const before = getSessionSnapshot().rev;
  publishSessionState({
    phase: "active",
    requestedId: "old-id",
    sessionId: "s1",
    session: { id: "s1", cwd: "/repo", name: "改名了", firstMessage: "hi" },
    source: "canonicalized",
  });
  assert.equal(getSessionSnapshot().rev, before + 1, "name 变化触发通知");
  publishSessionState({
    phase: "active",
    requestedId: "old-id",
    sessionId: "s1",
    session: { id: "s1", cwd: "/repo", name: "改名了", firstMessage: "hi" },
    source: "canonicalized",
  });
  assert.equal(getSessionSnapshot().rev, before + 1, "摘要相同不通知");
});

test("window CustomEvent pi-web:session-state is dispatched with the snapshot", () => {
  assert.ok(dispatched.length > 0, "至少派发过一次");
  const last = dispatched[dispatched.length - 1];
  assert.equal(last.type, "pi-web:session-state");
  assert.equal(last.detail.sessionId, "s1");
});

test("pi-web.session service exposes the same get/subscribe contract", () => {
  assert.equal(typeof piWebSessionService.get, "function");
  assert.equal(typeof piWebSessionService.subscribe, "function");
  assert.deepEqual(piWebSessionService.get(), getSessionSnapshot());
  const seen = [];
  const unsub = piWebSessionService.subscribe((s) => seen.push(s));
  assert.equal(seen.length, 1, "服务订阅同样回放当前快照");
  unsub();
});

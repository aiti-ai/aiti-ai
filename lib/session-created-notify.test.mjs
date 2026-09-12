import test from "node:test";
import assert from "node:assert/strict";
import { notifySessionCreated } from "./session-created-notify.ts";
import { addPageEventSink } from "./agent-page-events.ts";

test("notifySessionCreated 宽发布：core sink + 总线槽各一份，origin 透传", () => {
  const got = [];
  const off = addPageEventSink((f) => got.push(f));
  const slotCalls = [];
  const g = globalThis;
  const prev = g.__piPageEvents;
  // accessor wrapper 形态（总线接管后同款）：与 core publish 不同的引用 → 走槽
  g.__piPageEvents = { publish: (type, data) => slotCalls.push({ type, data }) };
  try {
    notifySessionCreated("sid-1", "/tmp/proj", "fork_branch");
  } finally {
    off();
    if (prev === undefined) delete g.__piPageEvents; else g.__piPageEvents = prev;
  }
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { type: "sm:session-created", sessionId: "sid-1", cwd: "/tmp/proj", origin: "fork_branch" });
  assert.equal(slotCalls.length, 1);
  assert.deepEqual(slotCalls[0], { type: "sm:session-created", data: { sessionId: "sid-1", cwd: "/tmp/proj", origin: "fork_branch" } });
});

test("notifySessionCreated：槽为 plain 自身（总线不在场）不双发；origin 缺省不带字段", () => {
  const got = [];
  const off = addPageEventSink((f) => got.push(f));
  const g = globalThis;
  const prev = g.__piPageEvents;
  g.__piPageEvents = { publish: undefined }; // 无槽 publish → 跳过
  try {
    notifySessionCreated("sid-2", "/tmp/p2");
  } finally {
    off();
    if (prev === undefined) delete g.__piPageEvents; else g.__piPageEvents = prev;
  }
  assert.equal(got.length, 1);
  assert.equal("origin" in got[0], false);
});

test("notifySessionCreated：sink 抛错不外泄（广播失败不阻断创建）", () => {
  const off = addPageEventSink(() => { throw new Error("boom"); });
  try {
    assert.doesNotThrow(() => notifySessionCreated("sid-3", "/tmp/p3", "clone"));
  } finally {
    off();
  }
});

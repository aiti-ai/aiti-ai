/**
 * steerSendThenRemove — ordering regression for "send as steer, then drop the
 * original entry" (2026-11-23).
 *
 * Field report: clicking "send as steer" in the queue panel removed the row, but
 * the message never reached the agent. Two independent causes:
 *   1. With the send and the removal running side by side, the pi/omp removal
 *      (clear-all + re-inject) clears the steer the send just enqueued;
 *   2. The removal is index-based, and the queue can be consumed while the send
 *      is awaited (the running agent delivers a follow-up), so the old index
 *      deletes the wrong entry.
 * Contract: remove only after the send's promise resolves; relocate by text
 * before removing; a rejected send keeps the entry.
 *
 * Run: node --test client/tests/steer-send-order.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { steerSendThenRemove } = await import("../src/steer-send.ts");

const live = (followUp) => ({
  steering: [],
  followUp: followUp.map((text, index) => ({ id: `f${index}`, kind: "followUp", text, hasImages: false, queuedAt: 0, index })),
});

function rig(entries) {
  const calls = [];
  let releaseSend;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const actions = {
    steerSend: async (text) => {
      calls.push(`send:${text}`);
      await sendGate;
      calls.push(`sent:${text}`);
    },
    // Not used by the helper; present so the object satisfies the contract shape.
    remove: async () => null,
  };
  const remove = async (kind, index, opts) => {
    calls.push(`remove:${kind}:${index}:${opts?.permanent === true}`);
    return null;
  };
  let liveView = live(entries);
  return {
    actions, remove, calls, releaseSend,
    getLive: () => liveView,
    setLive: (texts) => { liveView = live(texts); },
  };
}

test("顺序：remove 必须等 send 被后端接受之后", async () => {
  const t = rig(["a", "b"]);
  const done = steerSendThenRemove({ actions: t.actions, kind: "followUp", index: 0, text: "a", getLive: t.getLive, remove: t.remove });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(t.calls, ["send:a"], "发送未落地前不得摘除");
  t.releaseSend();
  await done;
  assert.deepEqual(t.calls, ["send:a", "sent:a", "remove:followUp:0:true"]);
});

test("发送期间队列移动：按文本重定位，不按旧索引删错条目", async () => {
  const t = rig(["a", "b", "c"]);
  const done = steerSendThenRemove({ actions: t.actions, kind: "followUp", index: 0, text: "b", getLive: t.getLive, remove: t.remove });
  // The running agent delivered "a" while the steer was in flight: b is now index 0.
  t.setLive(["b", "c"]);
  t.releaseSend();
  await done;
  assert.deepEqual(t.calls, ["send:b", "sent:b", "remove:followUp:0:true"], "删除的是 b（新索引 0）而不是 c");
});

test("条目已在发送期间消失：不再摘除（不会误删别的条目）", async () => {
  const t = rig(["a", "b"]);
  const done = steerSendThenRemove({ actions: t.actions, kind: "followUp", index: 0, text: "a", getLive: t.getLive, remove: t.remove });
  t.setLive(["b"]);
  t.releaseSend();
  await done;
  assert.deepEqual(t.calls, ["send:a", "sent:a"], "已不在队列 → 跳过 remove");
});

test("发送被拒：保留条目（不摘除）", async () => {
  const calls = [];
  const actions = {
    steerSend: async () => { calls.push("send"); throw new Error("rejected"); },
    remove: async () => null,
  };
  const done = steerSendThenRemove({
    actions, kind: "followUp", index: 0, text: "a", getLive: () => live(["a"]),
    remove: async () => { calls.push("remove"); return null; },
  });
  await assert.rejects(done, /rejected/);
  assert.deepEqual(calls, ["send"], "发送失败不得摘除条目");
});

test("core 未下发 steerSend（无插队能力）：完全 no-op", async () => {
  let called = false;
  await steerSendThenRemove({
    actions: { remove: async () => null }, kind: "followUp", index: 0, text: "a", getLive: () => live(["a"]),
    remove: async () => { called = true; return null; },
  });
  assert.equal(called, false);
});

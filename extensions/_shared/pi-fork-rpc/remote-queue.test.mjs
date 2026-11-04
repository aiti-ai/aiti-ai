/**
 * remote-queue 共享层测试（docs/aiti-remote-queue-and-sidecar-plan.md §2）。
 * 镜像维护 / list / clear 返回清空前文本 / move·remove·requeue·convert 的
 * clear+重注入策略 / 索越界人话错误。
 *
 * Run: node --test pi-web-ext/_shared/pi-fork-rpc/remote-queue.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const modPath = new URL("./remote-queue.ts", import.meta.url).pathname;
const { createRemotePiQueueSupport } = await import(modPath);

/** 台架：可编程 clearRemote 返回 + 记录重注入调用。 */
function rig() {
  const clears = [];
  const reinjections = [];
  const support = createRemotePiQueueSupport({
    clearRemote: async () => {
      clears.push(1);
      // 语义：清空返回「清空前」的内容——用当前重注入目标队列模拟不现实，测试只断言调用次数，
      // 文本返回值由用例自定义（见 clearRemoteResult 覆写）。
      return rigClearResult;
    },
    reinject: async (text, kind) => { reinjections.push({ text, kind }); },
  });
  let rigClearResult = { steering: [], followUp: [] };
  return {
    support,
    reinjections,
    clearCount: () => clears.length,
    setClearResult: (r) => { rigClearResult = r; },
    feed(steering, followUp) { support.observeFrame({ type: "queue_update", steering, followUp }); },
  };
}

test("镜像：observeFrame 只认 queue_update，快照返回拷贝", () => {
  const t = rig();
  t.feed(["s1"], ["f1", "f2"]);
  assert.deepEqual(t.support.snapshot(), { steering: ["s1"], followUp: ["f1", "f2"] });
  t.support.observeFrame({ type: "message_update" });
  t.support.observeFrame({ type: "queue_update" });
  assert.deepEqual(t.support.snapshot(), { steering: [], followUp: [] }, "缺数组按空归一");
  const snap = t.support.snapshot();
  snap.followUp.push("mutated");
  assert.deepEqual(t.support.snapshot().followUp, [], "快照须是拷贝");
});

test("clear：远端权威清空 + 返回清空前文本 + 镜像复位", async () => {
  const t = rig();
  t.feed([], ["a", "b"]);
  t.setClearResult({ steering: [], followUp: ["a", "b"] });
  const r = await t.support.queueManage({ action: "clear" });
  assert.equal(t.clearCount(), 1);
  assert.deepEqual(r.followUp, ["a", "b"], "clear 返回清空前文本（recallAll 契约）");
  assert.deepEqual(t.support.snapshot().followUp, []);
  assert.deepEqual(t.reinjections, [], "clear 不重注入");
});

test("move：镜像算新序 → clear + 按新序全量重注入", async () => {
  const t = rig();
  t.feed([], ["a", "b", "c"]);
  const r = await t.support.queueManage({ action: "move", from: 0, to: 2 });
  assert.equal(t.clearCount(), 1);
  assert.deepEqual(r.followUp, ["b", "c", "a"]);
  assert.deepEqual(t.reinjections, [
    { text: "b", kind: "followUp" }, { text: "c", kind: "followUp" }, { text: "a", kind: "followUp" },
  ]);
});

test("remove/recall：返回取回条目；requeue 插入；convert 跨组移动", async () => {
  const t = rig();
  t.feed(["s0"], ["a"]);
  const rm = await t.support.queueManage({ action: "remove", index: 0 });
  assert.equal(rm.removed.text, "a");
  assert.deepEqual(rm.entry.text, "a");

  const rq = await t.support.queueManage({ action: "requeue", index: 0, text: "back" });
  assert.deepEqual(rq.followUp, ["back"]);
  assert.deepEqual(t.reinjections.at(-1), { text: "back", kind: "followUp" });
  assert.deepEqual(t.reinjections.at(-2), { text: "s0", kind: "steer" }, "steer 组须一并重注入");

  t.feed(["s1"], []);
  const cv = await t.support.queueManage({ action: "convert", kind: "steer", targetKind: "followUp", index: 0 });
  assert.equal(cv.entry.text, "s1");
  assert.deepEqual(cv.followUp, ["s1"]);
  assert.deepEqual(t.reinjections.at(-1), { text: "s1", kind: "followUp" });

  const rc = await t.support.queueManage({ action: "recall", kind: "followUp", index: 0 });
  assert.equal(rc.entry.text, "s1");
});

test("越界 / 未知 action / convert 同组 → 人话错误", async () => {
  const t = rig();
  t.feed([], ["a"]);
  await assert.rejects(() => t.support.queueManage({ action: "remove", index: 5 }), /越界/);
  await assert.rejects(() => t.support.queueManage({ action: "requeue", index: 0, text: " " }), /非空/);
  await assert.rejects(() => t.support.queueManage({ action: "convert", kind: "steer", targetKind: "steer", index: 0 }), /targetKind/);
  await assert.rejects(() => t.support.queueManage({ action: "nope" }), /未知 action/);
});

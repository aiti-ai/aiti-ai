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

test("并发入队：clear 抹掉的「快照之后新入队」条目补注入回去（steer-send 与 remove 赛跑不丢消息）", async () => {
  const t = rig();
  t.feed([], ["f1"]);
  // The panel's steer-send: the steer prompt lands first, then the follow-up
  // remove clears. clearRemote reports what it really removed: f1 plus S, which
  // landed after the plan's base and is therefore absent from that base.
  t.setClearResult({ steering: ["S-late"], followUp: ["f1"] });
  const r = await t.support.queueManage({ action: "remove", kind: "followUp", index: 0 });
  assert.deepEqual(t.reinjections, [{ text: "S-late", kind: "steer" }], "快照后新入队的 steer 必须被补注入");
  assert.deepEqual(r.steering, ["S-late"], "返回视图包含补注入的条目");
  assert.deepEqual(r.entry, { text: "f1" }, "被摘除的仍是目标条目");
});

test("变更串行：两个变更不交错 clear/重注入（第二变更以第一变更后的镜像为起点）", async () => {
  const events = [];
  let clears = 0;
  const support = createRemotePiQueueSupport({
    clearRemote: async () => {
      clears += 1;
      events.push(`clear${clears}`);
      return { steering: [], followUp: [] };
    },
    reinject: async (text) => { events.push(`re:${text}`); },
  });
  support.observeFrame({ type: "queue_update", steering: [], followUp: ["a", "b"] });
  const first = support.queueManage({ action: "move", kind: "followUp", from: 0, to: 1 });
  const second = support.queueManage({ action: "remove", kind: "followUp", index: 0 });
  await Promise.all([first, second]);
  assert.deepEqual(events, ["clear1", "re:b", "re:a", "clear2", "re:a"]);
  assert.equal((await second).entry.text, "b", "第二变更看到的是重排后的镜像（串行），不是旧快照");
});

test("重注入期间又入队的条目：以子进程帧为准，镜像与返回不被 plan 覆盖", async () => {
  let childFollow = [];
  let support;
  support = createRemotePiQueueSupport({
    clearRemote: async () => {
      const before = [...childFollow];
      childFollow = [];
      support.observeFrame({ type: "queue_update", steering: [], followUp: [...childFollow] });
      return { steering: [], followUp: before };
    },
    reinject: async (text) => {
      childFollow.push(text);
      // A new message lands mid-loop (the real child's next frame carries it)
      if (text === "a") childFollow.push("late");
      support.observeFrame({ type: "queue_update", steering: [], followUp: [...childFollow] });
    },
  });
  support.observeFrame({ type: "queue_update", steering: [], followUp: ["a", "b"] });
  const r = await support.queueManage({ action: "remove", kind: "followUp", index: 1 });
  assert.deepEqual(r.followUp, ["a", "late"], "帧里存在的 late 不能被 plan 覆盖掉");
  assert.deepEqual(support.snapshot().followUp, ["a", "late"]);
});

// ── hydrate (empty mirror after a reattach must recover the child queue) ─────
// Scenario: after a pi-web restart / wrapper recovery the new handle starts with an
// empty mirror; the wrapper journal is a 4 MB ring, so a long session's last
// queue_update is gone and the panel stays empty until the user queues a new message.

test("hydrate：未观察到帧时 clear+重注入拉回子进程队列（镜像被回填）", async () => {
  const t = rig();
  assert.equal(t.support.needsHydrate(), true, "never synced -> hydrate is needed");
  t.setClearResult({ steering: ["s1"], followUp: ["f1", "f2"] });
  await t.support.hydrate();
  assert.equal(t.clearCount(), 1, "a single clear");
  assert.deepEqual(t.reinjections, [
    { text: "s1", kind: "steer" },
    { text: "f1", kind: "followUp" },
    { text: "f2", kind: "followUp" },
  ], "order and kind preserved");
  assert.deepEqual(t.support.snapshot(), { steering: ["s1"], followUp: ["f1", "f2"] }, "no frames from the backend -> cleared snapshot fills the mirror");
  assert.equal(t.support.needsHydrate(), false, "no repeat after hydrate");
  await t.support.hydrate();
  assert.equal(t.clearCount(), 1, "already hydrated -> no-op");
});

test("hydrate：镜像已由帧同步 → no-op（不打扰子进程队列）", async () => {
  const t = rig();
  t.feed([], ["keep-me"]);
  assert.equal(t.support.needsHydrate(), false);
  await t.support.hydrate();
  assert.equal(t.clearCount(), 0, "never clear when already synced");
  assert.deepEqual(t.support.snapshot(), { steering: [], followUp: ["keep-me"] });
});

test("hydrate：子进程队列为空 → 不重注入，镜像保持空", async () => {
  const t = rig();
  t.setClearResult({ steering: [], followUp: [] });
  await t.support.hydrate();
  assert.equal(t.clearCount(), 1);
  assert.deepEqual(t.reinjections, []);
  assert.deepEqual(t.support.snapshot(), { steering: [], followUp: [] });
  assert.equal(t.support.needsHydrate(), false);
});

test("hydrate：排队的 clear 执行前已有帧到达 → 跳过（帧权威）", async () => {
  const t = rig();
  // Queue a mutation first, then feed a frame (a late journal replay) before it runs.
  const first = t.support.queueManage({ action: "clear" });
  const second = t.support.hydrate();
  t.feed([], ["replayed"]);
  await Promise.all([first, second]);
  assert.equal(t.clearCount(), 1, "only the explicit clear runs; hydrate skips after seeing the frame");
  assert.deepEqual(t.reinjections, [], "hydrate does not re-inject (the frame synced it)");
});

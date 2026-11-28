/**
 * remote-queue shared-layer tests (docs/aiti-remote-queue-and-sidecar-plan.md §2).
 * Mirror maintenance / list / clear returning pre-clear text / the clear+re-inject strategy of
 * move·remove·requeue·convert / human-readable out-of-range errors.
 *
 * Run: node --test pi-web-ext/_shared/pi-fork-rpc/remote-queue.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const modPath = new URL("./remote-queue.ts", import.meta.url).pathname;
const { createRemotePiQueueSupport } = await import(modPath);

/** Rig: programmable clearRemote returns + reinjection call recording. */
function rig() {
  const clears = [];
  const reinjections = [];
  const support = createRemotePiQueueSupport({
    clearRemote: async () => {
      clears.push(1);
      // Semantics: clear returns the "pre-clear" content — simulating it with the current
      // re-injection target queue is unrealistic, so the test only asserts call counts; the text
      // return value is customized per case (see the clearRemoteResult override).
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

test("mirror: observeFrame only accepts queue_update, snapshot returns a copy", () => {
  const t = rig();
  t.feed(["s1"], ["f1", "f2"]);
  assert.deepEqual(t.support.snapshot(), { steering: ["s1"], followUp: ["f1", "f2"] });
  t.support.observeFrame({ type: "message_update" });
  t.support.observeFrame({ type: "queue_update" });
  assert.deepEqual(t.support.snapshot(), { steering: [], followUp: [] }, "missing arrays normalize to empty");
  const snap = t.support.snapshot();
  snap.followUp.push("mutated");
  assert.deepEqual(t.support.snapshot().followUp, [], "the snapshot must be a copy");
});

test("clear: remote-authoritative wipe + returns pre-clear text + mirror reset", async () => {
  const t = rig();
  t.feed([], ["a", "b"]);
  t.setClearResult({ steering: [], followUp: ["a", "b"] });
  const r = await t.support.queueManage({ action: "clear" });
  assert.equal(t.clearCount(), 1);
  assert.deepEqual(r.followUp, ["a", "b"], "clear returns the pre-clear text (recallAll contract)");
  assert.deepEqual(t.support.snapshot().followUp, []);
  assert.deepEqual(t.reinjections, [], "clear does not re-inject");
});

test("move: mirror computes the new order -> clear + full re-inject in that order", async () => {
  const t = rig();
  t.feed([], ["a", "b", "c"]);
  const r = await t.support.queueManage({ action: "move", from: 0, to: 2 });
  assert.equal(t.clearCount(), 1);
  assert.deepEqual(r.followUp, ["b", "c", "a"]);
  assert.deepEqual(t.reinjections, [
    { text: "b", kind: "followUp" }, { text: "c", kind: "followUp" }, { text: "a", kind: "followUp" },
  ]);
});

test("remove/recall: returns the recalled entry; requeue inserts; convert moves across groups", async () => {
  const t = rig();
  t.feed(["s0"], ["a"]);
  const rm = await t.support.queueManage({ action: "remove", index: 0 });
  assert.equal(rm.removed.text, "a");
  assert.deepEqual(rm.entry.text, "a");

  const rq = await t.support.queueManage({ action: "requeue", index: 0, text: "back" });
  assert.deepEqual(rq.followUp, ["back"]);
  assert.deepEqual(t.reinjections.at(-1), { text: "back", kind: "followUp" });
  assert.deepEqual(t.reinjections.at(-2), { text: "s0", kind: "steer" }, "the steer group must be re-injected too");

  t.feed(["s1"], []);
  const cv = await t.support.queueManage({ action: "convert", kind: "steer", targetKind: "followUp", index: 0 });
  assert.equal(cv.entry.text, "s1");
  assert.deepEqual(cv.followUp, ["s1"]);
  assert.deepEqual(t.reinjections.at(-1), { text: "s1", kind: "followUp" });

  const rc = await t.support.queueManage({ action: "recall", kind: "followUp", index: 0 });
  assert.equal(rc.entry.text, "s1");
});

test("out of range / unknown action / convert same group -> human-readable errors", async () => {
  const t = rig();
  t.feed([], ["a"]);
  await assert.rejects(() => t.support.queueManage({ action: "remove", index: 5 }), /out of range/);
  await assert.rejects(() => t.support.queueManage({ action: "requeue", index: 0, text: " " }), /non-empty/);
  await assert.rejects(() => t.support.queueManage({ action: "convert", kind: "steer", targetKind: "steer", index: 0 }), /targetKind/);
  await assert.rejects(() => t.support.queueManage({ action: "nope" }), /unknown action/);
});

test("concurrent enqueue: entries enqueued after the snapshot and wiped by the clear are re-injected (steer-send racing remove loses no message)", async () => {
  const t = rig();
  t.feed([], ["f1"]);
  // The panel's steer-send: the steer prompt lands first, then the follow-up
  // remove clears. clearRemote reports what it really removed: f1 plus S, which
  // landed after the plan's base and is therefore absent from that base.
  t.setClearResult({ steering: ["S-late"], followUp: ["f1"] });
  const r = await t.support.queueManage({ action: "remove", kind: "followUp", index: 0 });
  assert.deepEqual(t.reinjections, [{ text: "S-late", kind: "steer" }], "a steer enqueued after the snapshot must be re-injected");
  assert.deepEqual(r.steering, ["S-late"], "the returned view includes the re-injected entry");
  assert.deepEqual(r.entry, { text: "f1" }, "the removed entry is still the targeted one");
});

test("mutation serialization: two mutations do not interleave clear/re-inject (the second starts from the mirror after the first)", async () => {
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
  assert.equal((await second).entry.text, "b", "the second mutation sees the reordered mirror (serialized), not the old snapshot");
});

test("entries enqueued mid-re-inject: child frames are authoritative; the mirror and return are not clobbered by the plan", async () => {
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
  assert.deepEqual(r.followUp, ["a", "late"], "the late entry present in frames must not be clobbered by the plan");
  assert.deepEqual(support.snapshot().followUp, ["a", "late"]);
});

// ── hydrate (empty mirror after a reattach must recover the child queue) ─────
// Scenario: after a pi-web restart / wrapper recovery the new handle starts with an
// empty mirror; the wrapper journal is a 4 MB ring, so a long session's last
// queue_update is gone and the panel stays empty until the user queues a new message.

test("hydrate: with no frames observed, clear+re-inject pulls back the child queue (mirror backfilled)", async () => {
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

test("hydrate: mirror already synced by frames -> no-op (does not disturb the child queue)", async () => {
  const t = rig();
  t.feed([], ["keep-me"]);
  assert.equal(t.support.needsHydrate(), false);
  await t.support.hydrate();
  assert.equal(t.clearCount(), 0, "never clear when already synced");
  assert.deepEqual(t.support.snapshot(), { steering: [], followUp: ["keep-me"] });
});

test("hydrate: empty child queue -> no re-inject, mirror stays empty", async () => {
  const t = rig();
  t.setClearResult({ steering: [], followUp: [] });
  await t.support.hydrate();
  assert.equal(t.clearCount(), 1);
  assert.deepEqual(t.reinjections, []);
  assert.deepEqual(t.support.snapshot(), { steering: [], followUp: [] });
  assert.equal(t.support.needsHydrate(), false);
});

test("hydrate: a frame arrived before the queued clear runs -> skip (frames authoritative)", async () => {
  const t = rig();
  // Queue a mutation first, then feed a frame (a late journal replay) before it runs.
  const first = t.support.queueManage({ action: "clear" });
  const second = t.support.hydrate();
  t.feed([], ["replayed"]);
  await Promise.all([first, second]);
  assert.equal(t.clearCount(), 1, "only the explicit clear runs; hydrate skips after seeing the frame");
  assert.deepEqual(t.reinjections, [], "hydrate does not re-inject (the frame synced it)");
});

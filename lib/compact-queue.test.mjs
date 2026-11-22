import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  parkCompactIfBusy,
  cancelCompactQueue,
  isCompactQueued,
  applyQueuedFlag,
} = await jiti.import("./compact-queue.ts");

/** Wait out a parked entry's debounced flush check (checkDelayMs 20 + margin). */
const settle = async () => await new Promise((resolve) => setTimeout(resolve, 90));

/**
 * Fake WrappedSessionLike: records send() calls, replays a mutable get_state
 * payload, fans events out to subscribers.
 */
function fakeWrapper({ state = { isRunning: true }, alive = true } = {}) {
  const listeners = new Set();
  const sent = [];
  let stateImpl = state;
  let aliveImpl = alive;
  const wrapper = {
    listeners,
    sent,
    isAlive: () => (typeof aliveImpl === "function" ? aliveImpl() : aliveImpl),
    send: async (command) => {
      sent.push(command);
      if (command.type === "get_state") return typeof stateImpl === "function" ? stateImpl() : stateImpl;
      return { tokensBefore: 10 };
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    setState(next) { stateImpl = next; },
  };
  return wrapper;
}

test("an idle session answers null — the caller executes the compaction itself", async () => {
  const wrapper = fakeWrapper({ state: { isRunning: false, isStreaming: false, isCompacting: false } });
  const parked = await parkCompactIfBusy("s1", wrapper, {}, { checkDelayMs: 20 });
  assert.equal(parked, null);
  assert.equal(isCompactQueued("s1"), false);
  assert.deepEqual(wrapper.sent, [{ type: "get_state" }]);
});

test("a busy session parks and flushes the compaction at settle", async () => {
  const wrapper = fakeWrapper();
  const parked = await parkCompactIfBusy("s2", wrapper, { customInstructions: "keep tests" }, { checkDelayMs: 20 });
  assert.equal(isCompactQueued("s2"), true);
  assert.equal(parked.customInstructions, "keep tests");
  assert.equal(typeof parked.queuedAt, "number");

  wrapper.setState({ isRunning: false, isStreaming: false, isCompacting: false });
  wrapper.emit({ type: "agent_settled" });
  await settle();
  assert.equal(isCompactQueued("s2"), false);
  const compact = wrapper.sent.find((c) => c.type === "compact");
  assert.ok(compact, "flush must send the compact command");
  assert.equal(compact.customInstructions, "keep tests");
});

test("a still-busy check waits for the next settle event", async () => {
  const wrapper = fakeWrapper();
  await parkCompactIfBusy("s3", wrapper, {}, { checkDelayMs: 20 });
  // Settle event fires while the session is (still) busy → no flush yet.
  wrapper.emit({ type: "prompt_done" });
  await settle();
  assert.equal(isCompactQueued("s3"), true);
  assert.equal(wrapper.sent.some((c) => c.type === "compact"), false);
  // Now the run really ends → the next settle event flushes.
  wrapper.setState({ isRunning: false, isStreaming: false, isCompacting: false });
  wrapper.emit({ type: "agent_settled" });
  await settle();
  assert.equal(isCompactQueued("s3"), false);
  assert.equal(wrapper.sent.some((c) => c.type === "compact"), true);
});

test("queued steer/follow-up messages postpone the flush", async () => {
  const wrapper = fakeWrapper();
  await parkCompactIfBusy("s4", wrapper, {}, { checkDelayMs: 20 });
  wrapper.setState({
    isRunning: false,
    isStreaming: false,
    isCompacting: false,
    queuedMessages: { steering: ["one"], followUp: [] },
  });
  wrapper.emit({ type: "agent_settled" });
  await settle();
  assert.equal(isCompactQueued("s4"), true);
  wrapper.setState({
    isRunning: false,
    isStreaming: false,
    isCompacting: false,
    queuedMessages: { steering: [], followUp: [] },
  });
  wrapper.emit({ type: "queue_update" });
  await settle();
  assert.equal(isCompactQueued("s4"), false);
  assert.equal(wrapper.sent.some((c) => c.type === "compact"), true);
});

test("cancel removes the park and stops the flush", async () => {
  const wrapper = fakeWrapper();
  await parkCompactIfBusy("s5", wrapper, {}, { checkDelayMs: 20 });
  assert.equal(cancelCompactQueue("s5"), true);
  assert.equal(cancelCompactQueue("s5"), false);
  wrapper.setState({ isRunning: false, isStreaming: false, isCompacting: false });
  wrapper.emit({ type: "agent_settled" });
  await settle();
  assert.equal(isCompactQueued("s5"), false);
  assert.equal(wrapper.sent.some((c) => c.type === "compact"), false);
});

test("a dead wrapper drops the park instead of flushing", async () => {
  const wrapper = fakeWrapper({ alive: () => false });
  await parkCompactIfBusy("s6", wrapper, {}, { checkDelayMs: 20 });
  wrapper.emit({ type: "agent_settled" });
  await settle();
  assert.equal(isCompactQueued("s6"), false);
  assert.equal(wrapper.sent.some((c) => c.type === "compact"), false);
});

test("session_backend_dead drops the park immediately", async () => {
  const wrapper = fakeWrapper();
  await parkCompactIfBusy("s7", wrapper, {}, { checkDelayMs: 20 });
  wrapper.emit({ type: "session_backend_dead", reason: "exit" });
  await settle();
  assert.equal(isCompactQueued("s7"), false);
});

test("a fork rebind (sessionId mismatch) drops the park", async () => {
  const wrapper = fakeWrapper();
  await parkCompactIfBusy("s8", wrapper, {}, { checkDelayMs: 20 });
  wrapper.setState({ isRunning: false, isStreaming: false, isCompacting: false, sessionId: "child-session" });
  wrapper.emit({ type: "agent_settled" });
  await settle();
  assert.equal(isCompactQueued("s8"), false);
  assert.equal(wrapper.sent.some((c) => c.type === "compact"), false);
});

test("a failed flushed compaction is contained (no throw, entry dropped)", async () => {
  const wrapper = fakeWrapper();
  const originalSend = wrapper.send;
  wrapper.send = async (command) => {
    if (command.type === "compact") throw new Error("502 all keys failed");
    return originalSend(command);
  };
  await parkCompactIfBusy("s9", wrapper, {}, { checkDelayMs: 20 });
  wrapper.setState({ isRunning: false, isStreaming: false, isCompacting: false });
  wrapper.emit({ type: "agent_settled" });
  await settle();
  assert.equal(isCompactQueued("s9"), false);
});

test("an unreadable get_state keeps the park (next settle event retries)", async () => {
  const wrapper = fakeWrapper();
  wrapper.send = async () => { throw new Error("wrapper busy"); };
  const parked = await parkCompactIfBusy("s10", wrapper, {}, { checkDelayMs: 20 });
  // Unreadable state is treated as busy → parked.
  assert.ok(parked);
  wrapper.emit({ type: "agent_settled" });
  await settle();
  assert.equal(isCompactQueued("s10"), true);
});

test("a park armed at creation flushes even when the settle event was missed", async () => {
  // Park on a busy session that settles right after (the busy probe raced the
  // agent_settled event): the initial arm must still flush it.
  const wrapper = fakeWrapper();
  await parkCompactIfBusy("s11", wrapper, {}, { checkDelayMs: 20 });
  wrapper.setState({ isRunning: false, isStreaming: false, isCompacting: false });
  await settle();
  assert.equal(isCompactQueued("s11"), false);
  assert.equal(wrapper.sent.some((c) => c.type === "compact"), true);
});

test("re-parking replaces the entry (newest instructions win)", async () => {
  const wrapper = fakeWrapper();
  const first = await parkCompactIfBusy("s12", wrapper, { customInstructions: "a" }, { checkDelayMs: 20 });
  const second = await parkCompactIfBusy("s12", wrapper, { customInstructions: "b" }, { checkDelayMs: 20 });
  assert.ok(first.queuedAt <= second.queuedAt);
  wrapper.setState({ isRunning: false, isStreaming: false, isCompacting: false });
  wrapper.emit({ type: "agent_settled" });
  await settle();
  const compact = wrapper.sent.find((c) => c.type === "compact");
  assert.equal(compact?.customInstructions, "b");
  assert.equal(isCompactQueued("s12"), false);
});

test("applyQueuedFlag ORs the parked flag into a state payload", async () => {
  const wrapper = fakeWrapper();
  await parkCompactIfBusy("s13", wrapper, {}, { checkDelayMs: 20 });
  const state = { isRunning: true };
  applyQueuedFlag("s13", state);
  assert.equal(state.compactQueued, true);
  applyQueuedFlag("s14-not-parked", state);
  assert.equal(state.compactQueued, true, "existing flag untouched for other sessions");
  const clean = { isRunning: false };
  applyQueuedFlag("s14-not-parked", clean);
  assert.equal("compactQueued" in clean, false);
  applyQueuedFlag("s13", null);
  applyQueuedFlag("s13", undefined);
});

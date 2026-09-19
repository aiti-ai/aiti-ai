import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createAgentEventStream, createPendingAgentSessionHandle } = await jiti.import("./agent-event-stream.ts");
const { hasActiveSessionLivenessProvider } = await jiti.import("./session-liveness.ts");
const decoder = new TextDecoder();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function readWithin(reader, timeoutMs = 1_000) {
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out reading SSE chunk")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function decodeData(chunk) {
  const text = decoder.decode(chunk.value);
  assert.match(text, /^data: /);
  return JSON.parse(text.slice("data: ".length));
}

test("opens the transport before a slow session is ready and snapshots after subscribing", async () => {
  const startup = deferred();
  const abortController = new AbortController();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "session-id",
    startup.promise,
  );
  const reader = stream.getReader();

  const transport = await readWithin(reader);
  assert.equal(decoder.decode(transport.value), ":\n\n");

  const snapshot = { role: "assistant", content: [{ type: "text", text: "Hello" }] };
  let listener;
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  startup.resolve({
    isStreaming: true,
    streamingMessage: snapshot,
    onEvent(nextListener) {
      subscribeCount += 1;
      listener = nextListener;
      nextListener({
        type: "message_update",
        message: snapshot,
        assistantMessageEvent: { type: "text_delta", delta: "ignored" },
      });
      nextListener({ type: "agent_start" });
      return () => { unsubscribeCount += 1; };
    },
  });

  const connected = decodeData(await readWithin(reader));
  const messageStart = decodeData(await readWithin(reader));
  const replayedEvent = decodeData(await readWithin(reader));
  assert.equal(subscribeCount, 1);
  assert.deepEqual(connected, {
    type: "connected",
    sessionId: "session-id",
    isStreaming: true,
    // Authoritative busy flag: mock has no isRunning() -> falls back to isStreaming
    isRunning: true,
  });
  assert.deepEqual(messageStart, { type: "agent_start" });
  assert.deepEqual(replayedEvent, { type: "message_start", message: snapshot });
  assert.equal(hasActiveSessionLivenessProvider({ sessionId: "session-id" }), true);

  listener({
    type: "message_update",
    message: { ...snapshot },
    assistantMessageEvent: {
      type: "text_delta",
      delta: "!",
      partial: { ...snapshot },
    },
  });
  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "!" },
  });

  abortController.abort();
  assert.equal(unsubscribeCount, 1);
  assert.equal(hasActiveSessionLivenessProvider({ sessionId: "session-id" }), false);
  assert.equal((await readWithin(reader)).done, true);
});

test("does not replay buffered content events when a snapshot exists (no duplicate deltas client-side)", async () => {
  // [Duplicate-first-chunk regression] mid-stream attach: the session has already streamed
  // part of its content (the snapshot contains the streamed content) while equivalent events
  // (message_start / message_update delta, non-identical references) also arrive during the
  // subscribe window. Before the fix: the buffer was replayed first and then the snapshot
  // sent, so the client concatenated the replayed deltas on top of the snapshot again,
  // duplicating the opening content during streaming (e.g. "PacificPacific") until
  // thinking_end overwrote it in full. After the fix: content events in the buffer are not
  // replayed -- the snapshot is authoritative; non-content events (agent_start) still replay.
  const startup = deferred();
  const abortController = new AbortController();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "session-id",
    startup.promise,
  );
  const reader = stream.getReader();

  await readWithin(reader); // transport preamble

  const snapshot = { role: "assistant", content: [{ type: "thinking", thinking: "Pacific" }] };
  startup.resolve({
    isStreaming: true,
    streamingMessage: snapshot,
    onEvent(listener) {
      listener({
        type: "message_start",
        message: { ...snapshot },
      });
      listener({
        type: "message_update",
        message: { ...snapshot },
        assistantMessageEvent: { type: "thinking_delta", delta: "Pacific" },
      });
      listener({ type: "agent_start" });
      return () => {};
    },
  });

  const connected = decodeData(await readWithin(reader));
  assert.equal(connected.type, "connected");
  // Non-content events still replay
  assert.deepEqual(decodeData(await readWithin(reader)), { type: "agent_start" });
  // Immediately followed by the snapshot's message_start: content events in the buffer are
  // not replayed, so the client never concatenates "Pacific" on top of the snapshot again
  const messageStart = decodeData(await readWithin(reader));
  assert.equal(messageStart.type, "message_start");
  assert.equal(messageStart.message.content[0].thinking, "Pacific");

  abortController.abort();
  await readWithin(reader);
});

test("replays buffered content events when no snapshot exists yet", async () => {
  // streamingMessage not yet established (stream just started): there is no snapshot to send,
  // so buffer replay is the only way to rebuild -- behavior unchanged.
  const startup = deferred();
  const abortController = new AbortController();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "session-id",
    startup.promise,
  );
  const reader = stream.getReader();

  await readWithin(reader); // transport preamble

  startup.resolve({
    isStreaming: true,
    streamingMessage: undefined,
    onEvent(listener) {
      listener({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "Hi" },
      });
      return () => {};
    },
  });

  const connected = decodeData(await readWithin(reader));
  assert.equal(connected.type, "connected");
  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "Hi" },
  });

  abortController.abort();
  await readWithin(reader);
});

test("connected frame separates the busy flag from streaming (manual compaction)", async () => {
  // Manual compaction aborts the current run first (isStreaming=false) while the session is
  // still busy -- the connected frame must carry isRunning independently, otherwise a
  // reconnect/newly opened page would show idle forever (regression guard for the 2026-09-14 fix).
  const abortController = new AbortController();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "session-id",
    Promise.resolve({
      isStreaming: false,
      streamingMessage: undefined,
      isRunning: () => true,
      onEvent() { return () => {}; },
    }),
  );
  const reader = stream.getReader();

  await readWithin(reader); // transport preamble
  const connected = decodeData(await readWithin(reader));
  assert.deepEqual(connected, {
    type: "connected",
    sessionId: "session-id",
    isStreaming: false,
    isRunning: true,
  });

  abortController.abort();
  await readWithin(reader);
});

test("reports a startup failure in-band after opening the transport", async () => {
  const stream = createAgentEventStream(
    new Request("http://localhost/events"),
    "session-id",
    Promise.reject(new Error("broken config")),
  );
  const reader = stream.getReader();

  assert.equal(decoder.decode((await readWithin(reader)).value), ":\n\n");
  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "startup_error",
    errorMessage: "Failed to start agent: broken config",
  });
  assert.equal((await readWithin(reader)).done, true);
});

test("does not subscribe when the client cancels during startup", async () => {
  const startup = deferred();
  let subscribeCount = 0;
  const stream = createAgentEventStream(
    new Request("http://localhost/events"),
    "session-id",
    startup.promise,
  );
  const reader = stream.getReader();

  await readWithin(reader);
  await reader.cancel();
  startup.resolve({
    isStreaming: false,
    streamingMessage: undefined,
    onEvent() {
      subscribeCount += 1;
      return () => {};
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subscribeCount, 0);
  assert.equal(hasActiveSessionLivenessProvider({ sessionId: "session-id" }), false);
});

test("session_shutdown from a live wrapper closes the SSE stream", async () => {
  const abortController = new AbortController();
  let listener;
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "session-id",
    Promise.resolve({
      isStreaming: false,
      streamingMessage: undefined,
      isAlive: () => true,
      onEvent(nextListener) {
        listener = nextListener;
        return () => {};
      },
    }),
  );
  const reader = stream.getReader();
  await readWithin(reader);
  decodeData(await readWithin(reader));
  listener({ type: "session_shutdown" });
  assert.equal((await readWithin(reader)).done, true);
});

test("does not subscribe when the wrapper died before the snapshot", async () => {
  let subscribeCount = 0;
  const stream = createAgentEventStream(
    new Request("http://localhost/events"),
    "session-id",
    Promise.resolve({
      isStreaming: false,
      streamingMessage: undefined,
      isAlive: () => false,
      onEvent() {
        subscribeCount += 1;
        return () => {};
      },
    }),
  );
  const reader = stream.getReader();
  await readWithin(reader);
  assert.equal((await readWithin(reader)).done, true);
  assert.equal(subscribeCount, 0);
});

test("closes an already-aborted request and handles a later startup rejection", async () => {
  const abortController = new AbortController();
  abortController.abort();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "session-id",
    Promise.reject(new Error("startup failed after disconnect")),
  );

  assert.equal((await readWithin(stream.getReader())).done, true);
  await new Promise((resolve) => setImmediate(resolve));
});

test("lazy pending handle: ready in idle form immediately, attaches and forwards once the wrapper appears, and cleans up fully on unsubscribe", async () => {
  const abortController = new AbortController();
  let onReady = null;
  let stopWaitingCalls = 0;
  const handle = createPendingAgentSessionHandle((ready) => {
    onReady = ready;
    return () => { stopWaitingCalls += 1; };
  });
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "lazy-session",
    Promise.resolve(handle),
  );
  const reader = stream.getReader();

  assert.equal(decoder.decode((await readWithin(reader)).value), ":\n\n");
  // Opening a session just to view it: connected becomes ready in idle form first (otherwise the client hits its 60s ready timeout).
  const connected = decodeData(await readWithin(reader));
  assert.equal(connected.type, "connected");
  assert.equal(connected.isRunning, false);
  assert.equal(connected.isStreaming, false);
  assert.equal(typeof onReady, "function");

  // Real interaction brings the wrapper up: once attached, its events are forwarded through this handle.
  let wrapperListener = null;
  let wrapperUnsubscribes = 0;
  onReady({
    isStreaming: false,
    streamingMessage: undefined,
    onEvent(listener) {
      wrapperListener = listener;
      return () => { wrapperUnsubscribes += 1; };
    },
  });
  wrapperListener({ type: "agent_start" });
  const forwarded = decodeData(await readWithin(reader));
  assert.equal(forwarded.type, "agent_start");

  // Stream cancelled: both the wait stop and the wrapper unsubscribe happen.
  await reader.cancel();
  assert.equal(stopWaitingCalls, 1);
  assert.equal(wrapperUnsubscribes, 1);
});

test("lazy pending handle: stream stays usable when the wrapper never appears (heartbeat channel); cancelling stops the wait", async () => {
  const abortController = new AbortController();
  let stopWaitingCalls = 0;
  const handle = createPendingAgentSessionHandle(() => () => { stopWaitingCalls += 1; });
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "lazy-idle-session",
    Promise.resolve(handle),
  );
  const reader = stream.getReader();
  assert.equal(decoder.decode((await readWithin(reader)).value), ":\n\n");
  const connected = decodeData(await readWithin(reader));
  assert.equal(connected.type, "connected");
  assert.equal(connected.isRunning, false);
  await reader.cancel();
  assert.equal(stopWaitingCalls, 1);
});

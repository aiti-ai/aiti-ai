import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createAgentEventStream, createPendingAgentSessionHandle, TOOL_UPDATE_COALESCE_MS } = await jiti.import("./agent-event-stream.ts");
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
    pendingExtensionUiIds: [],
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
    // 合并：上游新增（重连客户端据此丢弃已关闭的扩展 UI 请求）
    pendingExtensionUiIds: [],
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

test("a backend replaying its pending ask at subscribe time still delivers it over SSE (card restored after refresh)", async () => {
  const { HandleSessionAdapter } = await jiti.import("./session/handle-adapter.ts");
  const handle = {
    id: "qodercn:1",
    source: "aiti-qoder-agent",
    capabilities: {},
    prompt: async () => {},
    abort: async () => {},
    subscribe: (listener) => {
      // qoder/claude 族 agent-interaction 账本契约：subscribe 同 tick 补发未决应答
      listener({ type: "interaction_request", requestId: "r1", kind: "plan_approval", capability: "respondInteraction", toolName: "ExitPlanMode", input: { allowedPrompts: [] } });
      return () => {};
    },
    dispose: async () => {},
    alive: () => true,
    isRunning: () => false,
    getModel: () => undefined,
  };
  // SSE 路由就是这样两步：先解析出（新构造的）适配器，再把事件消费者挂上去
  const adapter = new HandleSessionAdapter(handle);
  const stream = createAgentEventStream(
    new Request("http://localhost/events"),
    "qodercn:1",
    Promise.resolve(adapter),
  );
  const reader = stream.getReader();
  const frames = [];
  try {
    for (let i = 0; i < 6; i += 1) {
      const chunk = await readWithin(reader, 500).catch(() => null);
      if (!chunk?.value) break;
      frames.push(chunk.value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let offset = 0;
  for (const f of frames) { bytes.set(f, offset); offset += f.length; }
  assert.match(decoder.decode(bytes), /"type":"interaction_request"[^}]*"requestId":"r1"/);
});

async function connectedStream(sessionId) {
  const abortController = new AbortController();
  let listener;
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    sessionId,
    Promise.resolve({
      isStreaming: true,
      streamingMessage: undefined,
      onEvent(nextListener) {
        listener = nextListener;
        return () => {};
      },
    }),
  );
  const reader = stream.getReader();
  assert.equal(decoder.decode((await readWithin(reader)).value), ":\n\n");
  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "connected",
    sessionId,
    isStreaming: true,
    // 合并：本地 added isRunning（compaction busy 态恢复）——stub 无 isRunning()，回落 isStreaming
    isRunning: true,
    pendingExtensionUiIds: [],
  });
  return { reader, listener, abortController };
}

test("connected names the extension UI requests the session replays, so a client can drop the rest", async () => {
  const abortController = new AbortController();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "ui-session",
    Promise.resolve({
      isStreaming: true,
      streamingMessage: undefined,
      onEvent(nextListener) {
        // What AgentSessionWrapper.onEvent() replays: pending UI requests, then running tools.
        nextListener({ type: "extension_ui_request", id: "dialog-b", method: "confirm", title: "Run?" });
        nextListener({ type: "extension_ui_request", id: "panel-c", method: "custom", lines: [] });
        nextListener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" });
        return () => {};
      },
    }),
  );
  const reader = stream.getReader();
  assert.equal(decoder.decode((await readWithin(reader)).value), ":\n\n");

  const connected = decodeData(await readWithin(reader));
  assert.deepEqual(connected.pendingExtensionUiIds, ["dialog-b", "panel-c"]);
  // The replayed requests follow it, so the client re-queues what it had dropped.
  assert.equal(decodeData(await readWithin(reader)).id, "dialog-b");
  assert.equal(decodeData(await readWithin(reader)).id, "panel-c");
  abortController.abort();
});

const BIG_PAYLOAD = "x".repeat(30_000);

function toolUpdate(toolCallId = "call-1", partialResult = BIG_PAYLOAD) {
  return {
    type: "tool_execution_update",
    toolCallId,
    toolName: "bash",
    partialResult,
  };
}

/** Non-droppable, so it always survives and marks the end of the queued batch. */
function sentinelEvent() {
  return { type: "agent_end" };
}

/** Wait until the stream has flushed the tool updates it was coalescing. */
function afterCoalesceWindow() {
  return new Promise((resolve) => setTimeout(resolve, TOOL_UPDATE_COALESCE_MS * 2));
}

test("terminates the stream when an unread, non-rebuildable backlog exceeds the limit", async () => {
  const previousLimit = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(64 * 1024);
  try {
    const { reader, listener } = await connectedStream("backlog-session");

    // Stop reading here: message snapshots cannot be rebuilt client-side, so
    // they must hit the hard limit instead of being dropped.
    const message = { role: "assistant", content: [{ type: "text", text: BIG_PAYLOAD }] };
    for (let index = 0; index < 8; index += 1) {
      listener({ type: "message_start", message });
    }

    let queuedChunks = 0;
    await assert.rejects(async () => {
      for (;;) {
        const next = await readWithin(reader);
        if (next.done) return;
        queuedChunks += 1;
        assert.ok(queuedChunks < 8, "stream kept queueing past the backlog limit");
      }
    }, /client backlog exceeded/);
    assert.equal(hasActiveSessionLivenessProvider({ sessionId: "backlog-session" }), false);
  } finally {
    if (previousLimit === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previousLimit;
  }
});

test("drops rebuildable deltas while the client is behind instead of disconnecting it", async () => {
  const previousLimit = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(8 * 1024 * 1024);
  try {
    const { reader, listener, abortController } = await connectedStream("behind-session");

    // Updates of different tool calls survive coalescing and are written in one flush.
    const emitted = 60;
    for (let index = 0; index < emitted; index += 1) listener(toolUpdate(`call-${index}`));
    await afterCoalesceWindow();
    listener(sentinelEvent());

    // Whatever was queued before the water mark is still delivered…
    let delivered = 0;
    let sawSentinel = false;
    while (!sawSentinel) {
      const next = await readWithin(reader);
      assert.equal(next.done, false);
      const event = decodeData(next);
      if (event.type === "agent_end") sawSentinel = true;
      else delivered += 1;
    }
    assert.ok(delivered > 0 && delivered < emitted, `expected drops, delivered ${delivered} of ${emitted}`);
    assert.equal(hasActiveSessionLivenessProvider({ sessionId: "behind-session" }), true);

    // …and the stream stays usable once the client catches up.
    listener(toolUpdate());
    const afterCatchUp = await readWithin(reader);
    assert.equal(afterCatchUp.done, false);
    assert.equal(decodeData(afterCatchUp).type, "tool_execution_update");
    abortController.abort();
  } finally {
    if (previousLimit === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previousLimit;
  }
});

test("keeps the start and end of a streamed block while dropping its deltas", async (t) => {
  const previousLimit = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(8 * 1024 * 1024);
  try {
    const { reader, listener, abortController } = await connectedStream("block-session");
    t.after(() => abortController.abort());
    const update = (assistantMessageEvent) => ({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent,
    });

    listener(update({ type: "text_start", contentIndex: 0 }));
    for (let index = 0; index < 60; index += 1) {
      listener(update({ type: "text_delta", contentIndex: 0, delta: BIG_PAYLOAD }));
    }
    // The client's reducer replaces the block with this content, repairing any dropped delta.
    listener(update({ type: "text_end", contentIndex: 0, content: "final text" }));
    listener(sentinelEvent());

    const kinds = [];
    for (;;) {
      const event = decodeData(await readWithin(reader));
      if (event.type === "agent_end") break;
      kinds.push(event.assistantMessageEvent.type);
    }
    assert.equal(kinds[0], "text_start");
    assert.equal(kinds.at(-1), "text_end");
    assert.ok(kinds.length < 62, `expected dropped deltas, got ${kinds.length} events`);
  } finally {
    if (previousLimit === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previousLimit;
  }
});

test("delivers every update to a client that reads promptly", async () => {
  const { reader, listener, abortController } = await connectedStream("prompt-session");
  for (let index = 0; index < 5; index += 1) {
    listener(toolUpdate("call-1", `${index}:${BIG_PAYLOAD}`));
    const next = await readWithin(reader);
    assert.equal(next.done, false);
    const event = decodeData(next);
    assert.equal(event.type, "tool_execution_update");
    assert.equal(event.partialResult, `${index}:${BIG_PAYLOAD}`);
  }
  abortController.abort();
});

test("coalesces a burst of tool updates into the latest one per tool call", async (t) => {
  const { reader, listener, abortController } = await connectedStream("coalesce-session");
  t.after(() => abortController.abort());

  // A codemode script publishes a snapshot each time a nested call starts.
  for (let index = 0; index < 50; index += 1) {
    if (index % 10 === 0) {
      listener({
        type: "tool_execution_start",
        toolCallId: `call-codemode/${index + 1}`,
        toolName: "read",
        args: { path: `file-${index}` },
        parentToolCallId: "call-codemode",
      });
      // The nested call's own progress never reaches the client.
      listener({
        ...toolUpdate(`call-codemode/${index + 1}`, `nested ${index}`),
        toolName: "read",
        parentToolCallId: "call-codemode",
      });
    }
    listener({ ...toolUpdate("call-codemode", `snapshot ${index}`), toolName: "codemode" });
  }
  listener(toolUpdate("call-bash", "bash tail"));

  // Starts are never held back for the updates around them.
  const starts = [];
  for (let index = 0; index < 5; index += 1) starts.push(decodeData(await readWithin(reader)));
  assert.deepEqual(starts.map((event) => event.toolCallId), [
    "call-codemode/1",
    "call-codemode/11",
    "call-codemode/21",
    "call-codemode/31",
    "call-codemode/41",
  ]);
  assert.deepEqual(starts[0], {
    type: "tool_execution_start",
    toolCallId: "call-codemode/1",
    toolName: "read",
    parentToolCallId: "call-codemode",
  });

  const updates = [decodeData(await readWithin(reader)), decodeData(await readWithin(reader))];
  assert.deepEqual(
    updates.map((event) => [event.type, event.toolCallId, event.partialResult]),
    [
      ["tool_execution_update", "call-codemode", "snapshot 49"],
      ["tool_execution_update", "call-bash", "bash tail"],
    ],
  );

  await afterCoalesceWindow();
  listener(sentinelEvent());
  assert.deepEqual(decodeData(await readWithin(reader)), { type: "agent_end" });
});

test("never delivers a tool update after that tool call's end", async (t) => {
  const { reader, listener, abortController } = await connectedStream("end-session");
  t.after(() => abortController.abort());

  listener(toolUpdate("call-1", "partial"));
  listener(toolUpdate("call-2", "still running"));
  listener({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: BIG_PAYLOAD }] },
    isError: false,
  });

  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    isError: false,
  });
  // Only the ended call's pending update is discarded.
  const other = decodeData(await readWithin(reader));
  assert.equal(other.toolCallId, "call-2");
  assert.equal(other.partialResult, "still running");

  await afterCoalesceWindow();
  listener(sentinelEvent());
  assert.deepEqual(decodeData(await readWithin(reader)), { type: "agent_end" });
});

test("discards pending tool updates when the run ends", async (t) => {
  const { reader, listener, abortController } = await connectedStream("run-end-session");
  t.after(() => abortController.abort());

  listener(toolUpdate("call-1", "no end ever came"));
  listener(sentinelEvent());
  assert.deepEqual(decodeData(await readWithin(reader)), { type: "agent_end" });

  await afterCoalesceWindow();
  listener({ type: "agent_settled" });
  assert.deepEqual(decodeData(await readWithin(reader)), { type: "agent_settled" });
});

test("replays a running tool's start and latest update after the snapshot", async () => {
  const abortController = new AbortController();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "replay-session",
    Promise.resolve({
      isStreaming: true,
      streamingMessage: undefined,
      onEvent(listener) {
        // AgentSessionWrapper.onEvent() replays active tool calls synchronously.
        listener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "make" } });
        listener(toolUpdate("call-1", "latest output"));
        return () => {};
      },
    }),
  );
  const reader = stream.getReader();
  await readWithin(reader);

  assert.equal(decodeData(await readWithin(reader)).type, "connected");
  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "make" },
  });
  assert.deepEqual(decodeData(await readWithin(reader)), toolUpdate("call-1", "latest output"));
  abortController.abort();
});

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
    // 忙态权威字段：mock 无 isRunning() → 回退 isStreaming
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
  // 【重复首字回归测试】mid-stream attach：session 已流出部分内容（snapshot 含已流入内容），
  // 订阅窗口期又到达同效果的事件（message_start / message_update delta，非同一引用）。
  // 修复前：先重放 buffer 再发 snapshot → 前端把重放 delta 在 snapshot 之上再拼一遍
  // → 流式期间开头内容重复（如 “PacificPacific”），直到 thinking_end 全量覆盖才修正。
  // 修复后：buffer 里的内容类事件不重放，以 snapshot 为准；非内容类（agent_start）照旧重放。
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
  // 非内容类事件仍重放
  assert.deepEqual(decodeData(await readWithin(reader)), { type: "agent_start" });
  // 紧接着就是 snapshot 的 message_start：buffer 里的内容类事件不重放，
  // 前端不会把 “Pacific” 在 snapshot 基础上再拼一遍
  const messageStart = decodeData(await readWithin(reader));
  assert.equal(messageStart.type, "message_start");
  assert.equal(messageStart.message.content[0].thinking, "Pacific");

  abortController.abort();
  await readWithin(reader);
});

test("replays buffered content events when no snapshot exists yet", async () => {
  // streamingMessage 未建立（流刚开始）：无 snapshot 可发，buffer 重放是唯一重建途径，行为不变。
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
  // manual compact 会先 abort 当前 run（isStreaming=false）而会话仍忙——connected 帧必须独立
  // 携带 isRunning，否则重连/新开页面会一直显示空闲（2026-09-14 修复回归保护）。
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

test("lazy pending handle: 空闲形态就绪即可用，wrapper 出现后附着转发并在退订时全清理", async () => {
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
  // 打开会话只为查看：connected 先以空闲形态就绪（否则客户端 60s 就绪超时）。
  const connected = decodeData(await readWithin(reader));
  assert.equal(connected.type, "connected");
  assert.equal(connected.isRunning, false);
  assert.equal(connected.isStreaming, false);
  assert.equal(typeof onReady, "function");

  // 真实交互把 wrapper 带起：附着后其事件经本句柄转发。
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

  // 流取消：等待停止 + wrapper 退订都发生。
  await reader.cancel();
  assert.equal(stopWaitingCalls, 1);
  assert.equal(wrapperUnsubscribes, 1);
});

test("lazy pending handle: wrapper 一直不出现时流保持可用（心跳通道），取消即停止等待", async () => {
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

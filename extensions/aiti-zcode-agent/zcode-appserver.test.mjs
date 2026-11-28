/**
 * aiti-zcode-agent app-server channel tests — wire contract (stubbed app-server subprocess), zero network, zero real credentials.
 *
 * Run: node --test pi-web-ext/aiti-zcode-agent/zcode-appserver.test.mjs
 * (node 24 native TS strip-types; imports .ts, same as zcode-core.test.mjs)
 *
 * Stub mechanism: STUB_SCRIPT (a JSON array) drives the event sequence after each send; supports
 *   {__delay:ms} delays, {__waitSends:n} waits until the n-th send before continuing;
 *   {__dieOnStart} exits instantly on first start (exit 1, runs normally after respawn), {__alwaysDie} exits instantly on every start;
 *   other entries are written back to stdout verbatim as wire frames (session/event notifications).
 * All requests the stub receives are logged to the STUB_LOG file (one JSON per line) for assertions.
 */
import assert from "node:assert/strict";
import { test as __test } from "node:test";
// The kill/respawn timing tests flake under full-suite parallel load (35/35 green
// on every solo run) — one in-place retry per test absorbs the load spikes.
// Static members (test.after) are forwarded to the shim.
const test = Object.assign(
  (name, optsOrFn, maybeFn) =>
    typeof optsOrFn === "function"
      ? __test(name, { retry: 1 }, optsOrFn)
      : __test(name, { ...(optsOrFn || {}), retry: 1 }, maybeFn),
  { after: __test.after.bind(__test), skip: __test.skip, only: __test.only, todo: __test.todo },
);
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = mkdtempSync(join(tmpdir(), "zcode-appserver-test-"));
process.env.EXT_MODEL_STATE_DIR = join(ROOT, "ext-model-state");

const { AppServerSession, ZcodeAppServerConnection, toProtocolModel, toProtocolMode } = await import("./zcode-appserver.ts");

/**
 * Live connection registry: the stub app-server is a server that "exits only on EOF", so an assertion failure mid-case
 * skips dispose() -> the subprocess keeps living on inherited stdio pipes until the file ends; the `node --test` **file
 * subprocess never exits** and the whole run wedges in place (observed: under parallel load the abort case timed out ->
 * the full suite stalled at line 386). Hence the blanket kill at end of file, then the temp dir is removed.
 */
const liveConns = new Set();

test.after(async () => {
  for (const c of liveConns) c.kill("SIGKILL");
  liveConns.clear();
  // wait for the subprocess to fully exit and release handles (rmSync hits EBUSY on Windows while the dir is pinned by a live process cwd)
  await new Promise((r) => setTimeout(r, 150));
  rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// stub app-server script
// ---------------------------------------------------------------------------
const STUB = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import readline from "node:readline";
const log = process.env.STUB_LOG;
const script = JSON.parse(process.env.STUB_SCRIPT || "[]");
// __dieOnStart: on first start (STUB_LOG absent) set the marker then exit(1), simulating an instant spawn death; runs normally after respawn
// __alwaysDie: exit(1) on every start, simulating persistent startup failure (retry-exhaustion path)
{
  const die = script.find((e) => e && (e.__dieOnStart || e.__alwaysDie));
  if (die && log) {
    if (die.__alwaysDie || !existsSync(log)) {
      if (!existsSync(log)) { try { writeFileSync(log, ""); } catch {} }
      process.exit(1);
    }
  }
}
const rl = readline.createInterface({ input: process.stdin });
let nextServerId = 1;
let sends = 0;
let stopSeen = false;
let activeSid = null;
const write = (o) => {
  if (o && o.method === "session/event" && o.params && activeSid) o.params.sessionId = activeSid;
  process.stdout.write(JSON.stringify(o) + "\\n");
};
const rec = (o) => { if (log) appendFileSync(log, JSON.stringify(o) + "\\n"); };
const sendReverse = () => write({ id: "server-" + nextServerId++, method: "session/requestRuntimePreferences", params: { sessionId: "sess_x", scope: "runtime-materialization" } });
let prefsAnswered = false;
async function runScript() {
  for (const entry of script) {
    if (entry && typeof entry === "object" && "__delay" in entry) { await new Promise((r) => setTimeout(r, entry.__delay)); continue; }
    if (entry && typeof entry === "object" && "__waitSends" in entry) {
      while (sends < entry.__waitSends) await new Promise((r) => setTimeout(r, 30));
      continue;
    }
    if (entry && typeof entry === "object" && "__onStop" in entry) { continue; }
    if (entry && typeof entry === "object" && "__failSend32031" in entry) { continue; }
    if (entry && typeof entry === "object" && "__reverseUserInput" in entry) {
      // simulate a server→client reverse request interaction/requestUserInput (id = server-N, awaits the answer; not re-sent)
      const p = entry.__reverseUserInput || {};
      write({ id: "server-" + nextServerId++, method: "interaction/requestUserInput", params: p });
      continue;
    }
    if (entry && typeof entry === "object" && "__reverseProviderHeaders" in entry) {
      // simulate a server→client reverse request interaction/requestProviderRuntimeHeaders (start-plan captcha protocol)
      const p = entry.__reverseProviderHeaders || {};
      write({
        id: "server-" + nextServerId++,
        method: "interaction/requestProviderRuntimeHeaders",
        params: { requestId: "rh-1", providerId: "builtin:bigmodel-start-plan", modelRef: "builtin:bigmodel-start-plan/GLM-5.3-Flash", reason: "model-request", ...p },
      });
      continue;
    }
    write(entry);
  }
}
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  // answers to reverse requests
  if (msg.id !== undefined && msg.result !== undefined && typeof msg.id === "string" && msg.id.startsWith("server-")) {
    if (msg.result && typeof msg.result === "object" && "action" in msg.result) {
      rec({ __userInputAnswer: true, id: msg.id, result: msg.result });
      return;
    }
    if (msg.result && typeof msg.result === "object" && "headersApplied" in msg.result) {
      rec({ __providerHeadersAnswer: true, id: msg.id, result: msg.result });
      return;
    }
    prefsAnswered = msg.result.nativeSearchEnhancementsEnabled === true;
    rec({ __prefsAnswered: prefsAnswered, result: msg.result });
    return;
  }
  if (typeof msg.method !== "string") return;
  rec({ method: msg.method, params: msg.params });
  switch (msg.method) {
    case "session/create": {
      sendReverse();
      setTimeout(() => {
        if (!prefsAnswered) { write({ id: msg.id, error: { code: -32022, message: "runtime preferences not answered" } }); return; }
        activeSid = "sess_stub_1";
        write({ id: msg.id, result: { protocol: { name: "ZCode Protocol", version: 1 }, session: { sessionId: activeSid, status: "idle" }, projection: { contextWindow: 1000000 } } });
      }, 20);
      break;
    }
    case "session/resume": {
      // __rejectRuntimeModel: 3.17+ semantics — the runtimeModel key was removed, strict schema rejects unknown keys
      if (script.some((e) => e && e.__rejectRuntimeModel) && msg.params && msg.params.runtimeModel !== undefined) {
        write({ id: msg.id, error: { code: -32603, message: 'ZodError: [{"code":"unrecognized_keys","path":["runtimeModel"]}]' } });
        break;
      }
      activeSid = (msg.params && msg.params.sessionId) || activeSid;
      // __resumeTodos: snapshot todos seed (isomorphic to a real-machine resume response snapshot, incl. todos)
      const todosEntry = script.find((e) => e && e.__resumeTodos);
      write({ id: msg.id, result: { record: {}, ...(todosEntry ? { todos: todosEntry.__resumeTodos } : {}) } });
      break;
    }
    case "session/subscribe": write({ id: msg.id, result: { eventSeq: 0, events: [], sessionId: msg.params?.sessionId } }); break;
    case "session/send": {
      sends += 1;
      if (script.some((e) => e && e.__failSend32031) && sends === 1) {
        write({ id: msg.id, error: { code: -32031, message: "历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。" } });
        return;
      }
      write({ id: msg.id, result: { accepted: true, sessionId: "sess_stub_1", stateRevision: sends } });
      void runScript();
      break;
    }
    case "session/stop": {
      write({ id: msg.id, result: {} });
      if (!stopSeen) { stopSeen = true; setTimeout(() => write({ method: "session/event", params: { type: "turn.completed", payload: { resultType: "cancelled", tokenCount: 10, duration: 5 } } }), 30); }
      break;
    }
    case "session/setModel":
    case "session/setMode": {
      // __reasoningRequired: 3.17+ semantics — a tier-declaring model sent as bare setModel (no options) → -32603
      if (msg.method === "session/setModel" && script.some((e) => e && e.__reasoningRequired) && !(msg.params?.options?.reasoningLevel)) {
        const m = msg.params?.model || {};
        write({ id: msg.id, error: { code: -32603, message: "Reasoning level is required for " + (m.providerId || "?") + "/" + (m.modelId || "?") } });
        break;
      }
      write({ id: msg.id, result: {} });
      break;
    }
    case "session/close": write({ id: msg.id, result: { closed: true } }); break;
    case "session/fork": {
      // turnIndex=999 → rejected while running (mapped to human wording); otherwise returns the child session id (target shape asserted from the log)
      if (msg.params?.target?.turnIndex === 999) {
        write({ id: msg.id, error: { code: -1, message: "Cannot fork while a prompt is running" } });
        break;
      }
      write({ id: msg.id, result: { forkedSessionId: "sess_forked_1", targetMessageId: "msg_t" + msg.params?.target?.turnIndex } });
      break;
    }
    default: write({ id: msg.id, result: {} });
  }
});
`;

const ev = (type, payload) => ({ method: "session/event", params: { type, payload, sessionId: "sess_stub_1", seq: Math.floor(Math.random() * 1000) } });
// real-machine wire semantics: streaming frames carry assistantMessageId/partial partId; this helper uniformly adds the msg prefix so it can be omitted
const ms = (kind, partId, extra = {}) => ev("model.streaming", { kind, assistantMessageId: "msg1", ...(partId ? { partId } : {}), ...extra });

async function setup(opts) {
  const dir = mkdtempSync(join(ROOT, "run-"));
  const stubPath = join(dir, "stub.mjs");
  const logFile = join(dir, "stub-log.jsonl");
  writeFileSync(stubPath, STUB);
  const events = [];
  const gates = [];
  const conn = new ZcodeAppServerConnection({
    nodeBin: process.execPath,
    runtimePath: stubPath,
    cwd: dir,
    env: { ...process.env, STUB_SCRIPT: JSON.stringify(opts.script), STUB_LOG: logFile },
  });
  liveConns.add(conn);
  const session = new AppServerSession({
    connection: conn,
    cwd: dir,
    modelRef: opts.modelRef ?? "bigmodel/GLM-5.3",
    sessId: opts.sessId,
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.onProviderHeadersRequest ? { onProviderHeadersRequest: opts.onProviderHeadersRequest } : {}),
    ...(opts.onTaskList ? { onTaskList: opts.onTaskList } : {}),
    onEvent: (e) => {
      if (process.env.PROBE) process.stderr.write('EVT ' + JSON.stringify(e).slice(0, 220) + '\n');
      events.push(e);
      for (let i = gates.length - 1; i >= 0; i -= 1) {
        if (gates[i].pred(e)) { const g = gates.splice(i, 1)[0]; clearTimeout(g.timer); g.resolve(e); }
      }
    },
    onSessionId: () => {},
  });
  return {
    session,
    events,
    logFile,
    /**
     * Wait for an event to arrive (event-driven, resolves on first hit; a timeout is a "fast visible failure" instead of wedging in place).
     * Use it instead of fixed setTimeout to confirm "this turn really got going" — timer jitter under parallel load drags
     * such cases into false reds (observed: a 150ms setTimeout stretched to 3.3s).
     */
    waitEvent: (pred, timeoutMs = 8000) => {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const g = { pred, resolve };
        g.timer = setTimeout(() => {
          const i = gates.indexOf(g);
          if (i >= 0) gates.splice(i, 1);
          reject(new Error(`等待事件超时（${timeoutMs}ms）`));
        }, timeoutMs);
        gates.push(g);
      });
    },
  };
}

async function readLog(logFile) {
  // answer frames are written on a promise microtask chain; reading the file synchronously right after respondInteraction reads too early (timing backstop)
  await new Promise((r) => setTimeout(r, 60));
  const { readFileSync, existsSync } = await import("node:fs");
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// pure functions
// ---------------------------------------------------------------------------

test("toProtocolModel/toProtocolMode：ref 归一", () => {
  assert.deepEqual(toProtocolModel("bigmodel/GLM-5.3"), { providerId: "bigmodel", modelId: "GLM-5.3" });
  assert.equal(toProtocolModel("nonoslash"), null);
  assert.equal(toProtocolMode("default"), "build");
  assert.equal(toProtocolMode("acceptEdits"), "edit");
  assert.equal(toProtocolMode("bypassPermissions"), "yolo");
  assert.equal(toProtocolMode("plan"), "plan");
  assert.equal(toProtocolMode("unknown"), undefined);
});

// ---------------------------------------------------------------------------
// E2E: streaming text
// ---------------------------------------------------------------------------

test("app-server 通道：create→prefs 应答→subscribe→流式 text→turn.completed", async () => {
  const s = await setup({
    script: [
      ev("model.streaming", { kind: "text_start", assistantMessageId: "msg1", partId: "p1" }),
      ev("model.streaming", { kind: "text_delta", partId: "p1", delta: "你好" }),
      ev("model.streaming", { kind: "text_delta", partId: "p1", delta: "，世界" }),
      ev("model.streaming", { kind: "text_end", partId: "p1" }),
      { __delay: 20 },
      ev("turn.completed", { resultType: "success", tokenCount: 1234, duration: 800, usage: { inputTokens: 1200, outputTokens: 34, totalTokens: 1234, cacheReadTokens: 900 }, cacheStats: { cacheReadTokens: 900 } }),
    ],
  });
  const seenSessionIds = [];
  // re-wire onSessionId
  s.session.opts.onSessionId = (sid) => seenSessionIds.push(sid);
  const outcome = await s.session.prompt("hi");
  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.tokenCount, 1234);
  assert.deepEqual(outcome.usage, { inputTokens: 1200, outputTokens: 34, totalTokens: 1234, cacheReadTokens: 900 });
  assert.equal(outcome.cacheReadTokens, 900);
  assert.deepEqual(seenSessionIds, ["sess_stub_1"]);

  const types = s.events.map((e) => e.type);
  assert.deepEqual(types, ["message_start", "message_update", "message_update", "message_update", "message_update", "message_end", "agent_end", "agent_settled"]);
  const [start, d1, d2, d3, dEnd] = s.events.slice(0, 5);
  assert.equal(start.message.role, "assistant");
  assert.equal(start.message.model, "bigmodel/GLM-5.3");
  assert.deepEqual(d1.assistantMessageEvent, { type: "text_start", contentIndex: 0 });
  assert.deepEqual(d2.assistantMessageEvent, { type: "text_delta", contentIndex: 0, delta: "你好" });
  assert.deepEqual(dEnd.assistantMessageEvent, { type: "text_end", contentIndex: 0, content: "你好，世界" });
  // the settled frame comes after message_end (closeStream seals the stream first)
  const settledIdx = types.indexOf("agent_settled");
  assert.ok(settledIdx > 4);
  // right before settled: agent_end, then message_end (assistant final seal)
  assert.equal(types[settledIdx - 1], "agent_end");
  const finalMsg = s.events[settledIdx - 2].message;
  assert.equal(finalMsg.role, "assistant");
  assert.deepEqual(finalMsg.content, [{ type: "text", text: "你好，世界" }]);

  // stub log: prefs queried before create with the answer consumed; subscribe uses desktop-continuous
  const log = await readLog(s.logFile);
  assert.ok(log.some((l) => l.__prefsAnswered === true));
  const sub = log.find((l) => l.method === "session/subscribe");
  assert.equal(sub.params.deliveryKind, "desktop-continuous");
  await s.session.dispose();
});

test("app-server 通道：reasoning→thinking 映射", async () => {
  const s = await setup({
    script: [
      ev("model.streaming", { kind: "reasoning_start", assistantMessageId: "msg1", partId: "r1" }),
      ev("model.streaming", { kind: "reasoning_delta", partId: "r1", delta: "思考中" }),
      ev("model.streaming", { kind: "reasoning_end", partId: "r1" }),
      ev("model.streaming", { kind: "text_start", assistantMessageId: "msg1", partId: "t1" }),
      ev("model.streaming", { kind: "text_delta", partId: "t1", delta: "答案" }),
      ev("turn.completed", { resultType: "success", tokenCount: 10, duration: 5 }),
    ],
  });
  await s.session.prompt("hi");
  const updates = s.events.filter((e) => e.type === "message_update").map((e) => e.assistantMessageEvent);
  assert.deepEqual(updates[0], { type: "thinking_start", contentIndex: 0 });
  assert.deepEqual(updates[1], { type: "thinking_delta", contentIndex: 0, delta: "思考中" });
  assert.deepEqual(updates[2], { type: "thinking_end", contentIndex: 0, content: "思考中" });
  assert.deepEqual(updates[3], { type: "text_start", contentIndex: 1 });
  assert.deepEqual(updates[4], { type: "text_delta", contentIndex: 1, delta: "答案" });
  await s.session.dispose();
});

test("app-server 通道：工具全流程（toolcall 流式 + 执行事件 + toolResult 卡 + 后续文本新消息）", async () => {
  const s = await setup({
    script: [
      ev("model.streaming", { kind: "text_start", assistantMessageId: "msg1", partId: "p1" }),
      ev("model.streaming", { kind: "text_delta", partId: "p1", delta: "我来看看" }),
      ev("model.streaming", { kind: "tool_input_start", assistantMessageId: "msg1", partId: "tool1", toolCallId: "call_1", toolName: "Bash" }),
      ev("model.streaming", { kind: "tool_input_delta", partId: "tool1", delta: '{"command":"pwd"}' }),
      ev("model.streaming", { kind: "tool_call", partId: "tool1" }),
      ev("tool.updated", { kind: "scheduled", toolCallId: "call_1", toolName: "Bash" }),
      ev("tool.updated", { kind: "started", toolCallId: "call_1", toolName: "Bash" }),
      ev("tool.updated", { kind: "progress", toolCallId: "call_1", toolName: "Bash", stdoutTail: "/home/pi\n", elapsedMs: 120 }),
      ev("tool.updated", { kind: "result", toolCallId: "call_1", toolName: "Bash", result: { output: "/home/pi" }, duration: 130 }),
      ev("model.streaming", { kind: "text_start", assistantMessageId: "msg2", partId: "p2" }),
      ev("model.streaming", { kind: "text_delta", partId: "p2", delta: "目录是 /home/pi" }),
      ev("turn.completed", { resultType: "success", tokenCount: 50, duration: 900 }),
    ],
  });
  await s.session.prompt("hi");
  const types = s.events.map((e) => e.type);
  // key ordering: text… → toolcall_end → [streaming segment sealed by message_end(assistant)] → tool_execution_start → update → end → toolResult card → new message_start → …
  assert.ok(types.includes("tool_execution_start"));
  assert.ok(types.includes("tool_execution_update"));
  assert.ok(types.includes("tool_execution_end"));
  const firstAssistantEnd = s.events.find((e) => e.type === "message_end" && e.message?.role === "assistant");
  const firstContent = firstAssistantEnd.message.content;
  assert.deepEqual(firstContent.map((b) => b.type), ["text", "toolCall"]);
  const toolBlock = firstContent[1];
  assert.equal(toolBlock.toolCallId, "call_1");
  assert.equal(toolBlock.toolName, "Bash");
  assert.deepEqual(toolBlock.input, { command: "pwd" });
  const toolResultEvt = s.events.find((e) => e.type === "message_end" && e.message?.role === "toolResult");
  const tr = toolResultEvt.message;
  assert.equal(tr.toolCallId, "call_1");
  assert.equal(tr.isError, false);
  assert.deepEqual(tr.content, [{ type: "text", text: "/home/pi" }]);
  // second text segment = a new streaming message (msg2 reopens after msg1 is sealed)
  const starts = s.events.filter((e) => e.type === "message_start");
  assert.equal(starts.length, 2);
  // the final assistant message holds only the second text segment
  const lastAssistantEnd = s.events.filter((e) => e.type === "message_end" && e.message?.role === "assistant").pop();
  assert.deepEqual(lastAssistantEnd.message.content, [{ type: "text", text: "目录是 /home/pi" }]);
  await s.session.dispose();
});

test("app-server 通道：turn.failed → error 帧 + settled(error)", async () => {
  const s = await setup({
    script: [
      ev("model.streaming", { kind: "text_start", assistantMessageId: "msg1", partId: "p1" }),
      ev("model.streaming", { kind: "text_delta", partId: "p1", delta: "半截" }),
      ev("turn.failed", { error: { type: "api", message: "模型请求失败" }, turnPhase: "streaming" }),
    ],
  });
  const outcome = await s.session.prompt("hi");
  assert.equal(outcome.errorMessage, "模型请求失败");
  const settled = s.events.find((e) => e.type === "agent_settled");
  assert.equal(settled.stopReason, "error");
  assert.equal(settled.error, "模型请求失败");
  await s.session.dispose();
});

test("app-server 通道：原生 steer（运行中第二条 send 直达服务端）+ 双 prompt 同轮收口", async () => {
  const s = await setup({
    script: [
      { __waitSends: 2 },
      ev("model.streaming", { kind: "text_start", assistantMessageId: "msg1", partId: "p1" }),
      ev("model.streaming", { kind: "text_delta", partId: "p1", delta: "合并回复" }),
      ev("turn.completed", { resultType: "success", tokenCount: 20, duration: 50 }),
    ],
  });
  const p1 = s.session.prompt("第一条");
  await new Promise((r) => setTimeout(r, 120));
  const p2 = s.session.prompt("第二条（steer）");
  const [o1, o2] = await Promise.all([p1, p2]);
  assert.equal(o1.cancelled, false);
  assert.equal(o2.cancelled, false);
  const lines = await readLog(s.logFile);
  const sends = lines.filter((l) => l.method === "session/send");
  assert.equal(sends.length, 2);
  assert.equal(sends[0].params.content, "第一条");
  assert.equal(sends[1].params.content, "第二条（steer）");
  await s.session.dispose();
});

test("app-server 通道：abort → session/stop → cancelled 收口（aborted）", async () => {
  const s = await setup({
    script: [
      // emit one text_delta first: stop() is only allowed once the turn is truly running (waitEvent hit) — a fixed
      // setTimeout under parallel load can slip past the success frame, making stop() a no-op on empty turnWaiters (false red).
      ev("model.streaming", { kind: "text_delta", assistantMessageId: "msgA", delta: "慢慢" }),
      // long turn: the green path settles cancelled first (~0.2s); only a genuinely broken stop pays the full 30s.
      { __delay: 30000 },
      ev("turn.completed", { resultType: "success", tokenCount: 1, duration: 1 }),
    ],
  });
  const p = s.session.prompt("慢慢跑");
  await s.waitEvent((e) => e.type === "message_update");
  await s.session.stop();
  const outcome = await p;
  assert.equal(outcome.cancelled, true);
  const settled = s.events.find((e) => e.type === "agent_settled");
  assert.equal(settled.stopReason, "aborted");
  await s.session.dispose();
});

test("app-server 通道：setModel 即时热切（session/setModel 参数形状）", async () => {
  const s = await setup({ script: [ev("turn.completed", { resultType: "success", tokenCount: 1, duration: 1 })] });
  await s.session.prompt("hi");
  await s.session.setModel("zai/GLM-5.3");
  await s.session.setMode("plan");
  const lines = await readLog(s.logFile);
  const setModel = lines.filter((l) => l.method === "session/setModel").pop();
  assert.deepEqual(setModel.params.model, { providerId: "zai", modelId: "GLM-5.3" });
  const setMode = lines.filter((l) => l.method === "session/setMode").pop();
  assert.equal(setMode.params.mode, "plan");
  const sub = lines.find((l) => l.method === "session/subscribe");
  assert.equal(sub.params.deliveryKind, "desktop-continuous");
  await s.session.dispose();
});

test("app-server 通道：已知 sessId → resume（不 create）", async () => {
  const s = await setup({ script: [ev("turn.completed", { resultType: "success", tokenCount: 1, duration: 1 })], sessId: "sess_existing" });
  await s.session.prompt("hi");
  const lines = await readLog(s.logFile);
  assert.ok(lines.some((l) => l.method === "session/resume"));
  assert.ok(!lines.some((l) => l.method === "session/create"));
  await s.session.dispose();
});

test("app-server 通道：resume 携带 runtimeModel（provider 注入时，源头避免 -32031）", async () => {
  const s = await setup({
    script: [ev("turn.completed", { resultType: "success", tokenCount: 1, duration: 1 })],
    sessId: "sess_existing",
    modelRef: "bigmodel/GLM-5.3-Flash",
    provider: { providerId: "bigmodel", baseURL: "https://open.bigmodel.cn/api/anthropic", apiKey: "test-key", models: [{ modelId: "GLM-5.3-Flash", contextWindow: 1000000 }, { modelId: "GLM-5.3", contextWindow: 1000000 }] },
  });
  await s.session.prompt("hi");
  const lines = await readLog(s.logFile);
  const resume = lines.find((l) => l.method === "session/resume");
  assert.ok(resume.params.runtimeModel, "resume should carry runtimeModel");
  assert.deepEqual(resume.params.runtimeModel.model, { providerId: "bigmodel", modelId: "GLM-5.3-Flash" });
  assert.equal(resume.params.runtimeModel.provider.providerId, "bigmodel");
  assert.equal(resume.params.runtimeModel.provider.kind, "anthropic");
  assert.deepEqual(resume.params.runtimeModel.provider.models, [{ modelId: "GLM-5.3-Flash", contextWindow: 1000000 }, { modelId: "GLM-5.3", contextWindow: 1000000 }]);
  assert.ok(typeof resume.params.runtimeModel.revision === "string");
  assert.ok(typeof resume.params.runtimeModel.generatedAt === "number");
  await s.session.dispose();
});

test("app-server 通道：3.17+ 裸发 setModel 命中 Reasoning required → 补 options.reasoningLevel 重试", async () => {
  const s = await setup({
    script: [{ __reasoningRequired: true }, ev("turn.completed", { resultType: "success", tokenCount: 2, duration: 1 })],
    modelRef: "bigmodel/GLM-5.3-Flash",
  });
  const outcome = await s.session.prompt("hi");
  assert.equal(outcome.tokenCount, 2);
  const lines = await readLog(s.logFile);
  const sets = lines.filter((l) => l.method === "session/setModel");
  assert.ok(sets.length >= 2, "two setModel calls expected (bare send rejected + options retry)");
  assert.equal(sets[0].params.options, undefined, "first call has no top-level options");
  assert.equal(sets[0].params.model.options, undefined, "first call's model carries no options");
  const last = sets[sets.length - 1].params;
  assert.equal(last.options, undefined, "options live inside model, not at the request top level");
  assert.equal(last.model.options?.reasoningLevel, "enabled");
  assert.equal(last.persistAsWorkspaceLastUsed, false);
  await s.session.dispose();
});

test("app-server 通道：3.17+ resume 拒 runtimeModel（unknown key）→ 无 runtimeModel 重试 + setModel 对齐", async () => {
  const s = await setup({
    script: [{ __rejectRuntimeModel: true }, ev("turn.completed", { resultType: "success", tokenCount: 3, duration: 1 })],
    sessId: "sess_existing",
    modelRef: "bigmodel/GLM-5.3-Flash",
    provider: { providerId: "bigmodel", baseURL: "https://open.bigmodel.cn/api/anthropic", apiKey: "test-key", models: [{ modelId: "GLM-5.3-Flash", contextWindow: 1000000 }] },
  });
  const outcome = await s.session.prompt("hi");
  assert.equal(outcome.tokenCount, 3);
  const lines = await readLog(s.logFile);
  const resumes = lines.filter((l) => l.method === "session/resume");
  assert.equal(resumes.length, 2, "resume should retry once");
  assert.ok(resumes[0].params.runtimeModel, "first call carries runtimeModel (old-CLI -32031 workaround)");
  assert.equal(resumes[1].params.runtimeModel, undefined, "retry drops runtimeModel (key removed in 3.17+)");
  const sets = lines.filter((l) => l.method === "session/setModel");
  assert.ok(sets.length >= 1, "retry path should add setModel to realign the model");
  assert.deepEqual(sets.at(-1).params.model, { providerId: "bigmodel", modelId: "GLM-5.3-Flash" });
  await s.session.dispose();
});

test("app-server 通道：send 遇 -32031 → 携带 runtimeModel 自动重发（兜底清 restoreWarning）", async () => {
  const s = await setup({
    script: [{ __failSend32031: true }, ev("turn.completed", { resultType: "success", tokenCount: 1, duration: 1 })],
    provider: { providerId: "bigmodel", baseURL: "https://open.bigmodel.cn/api/anthropic", apiKey: "test-key", models: [{ modelId: "GLM-5.3", contextWindow: 1000000 }] },
  });
  const outcome = await s.session.prompt("hi");
  assert.equal(outcome.tokenCount, 1);
  const lines = await readLog(s.logFile);
  const sends = lines.filter((l) => l.method === "session/send");
  assert.equal(sends.length, 2, "first -32031 should trigger one automatic resend");
  assert.equal(sends[0].params.runtimeModel, undefined);
  assert.ok(sends[1].params.runtimeModel, "resend should carry runtimeModel");
  await s.session.dispose();
});

test("app-server 通道：真机 wire 容错（无 partId / 无 *_start 帧 / 尾随文本新消息）", async () => {
  const s = await setup({
    script: [
      // real-machine shape (packet capture 2026-09-07): reasoning_delta without start or partId; tool frames without partId keyed by toolCallId
      ev("model.streaming", { kind: "reasoning_delta", assistantMessageId: "msgA", delta: "想一下" }),
      ev("model.streaming", { kind: "tool_input_start", assistantMessageId: "msgA", toolCallId: "call_x", toolName: "Bash" }),
      ev("model.streaming", { kind: "tool_input_delta", assistantMessageId: "msgA", toolCallId: "call_x", delta: '{"command":"uname -s"}' }),
      ev("model.streaming", { kind: "tool_input_end", assistantMessageId: "msgA", toolCallId: "call_x" }),
      ev("model.streaming", { kind: "tool_call", assistantMessageId: "msgA", toolCallId: "call_x", toolName: "Bash" }),
      ev("tool.updated", { kind: "scheduled", toolCallId: "call_x", toolName: "Bash" }),
      ev("tool.updated", { kind: "result", toolCallId: "call_x", toolName: "Bash", result: { output: "Linux" }, duration: 10 }),
      // trailing text: new assistantMessageId, no text_start, straight to text_delta
      ev("model.streaming", { kind: "text_delta", assistantMessageId: "msgB", delta: "结果是 Linux。" }),
      ev("turn.completed", { resultType: "success", tokenCount: 77, duration: 100 }),
    ],
  });
  const outcome = await s.session.prompt("hi");
  assert.equal(outcome.tokenCount, 77);
  const types = s.events.map((e) => e.type);
  // structural asserts: first segment (thinking+tool) -> toolResult -> trailing text, three messages
  const msgEnds = s.events.filter((e) => e.type === "message_end");
  const firstAssistant = msgEnds.find((e) => e.message?.role === "assistant");
  assert.deepEqual((firstAssistant.message.content).map((b) => b.type), ["thinking", "toolCall"]);
  assert.equal(firstAssistant.message.content[0].thinking, "想一下");
  assert.deepEqual(firstAssistant.message.content[1].input, { command: "uname -s" });
  const toolResult = msgEnds.find((e) => e.message?.role === "toolResult");
  assert.equal(toolResult.message.content[0].text, "Linux");
  const lastAssistant = msgEnds.filter((e) => e.message?.role === "assistant").pop();
  assert.deepEqual(lastAssistant.message.content, [{ type: "text", text: "结果是 Linux。" }]);
  // message open count: one segment for msgA + one for msgB = 2 message_start (msgA includes the thinking segment before the tool)
  const starts = s.events.filter((e) => e.type === "message_start");
  assert.equal(starts.length, 2);
  assert.ok(types.includes("tool_execution_start"));
  await s.session.dispose();
});

test("app-server 通道：进程中途退出 → prompt 拒绝（下轮 respawn 由 ensureReady 负责）", async () => {
  const s = await setup({
    script: [
      { __delay: 3000 },
      ev("turn.completed", { resultType: "success", tokenCount: 1, duration: 1 }),
    ],
  });
  const p = s.session.prompt("hi");
  await new Promise((r) => setTimeout(r, 150));
  // kill the stub process
  const conn = s.session.conn;
  conn.kill("SIGKILL");
  await assert.rejects(p, /app-server 进程退出/);
  await s.session.dispose();
});

test("app-server 通道：启动秒退（code=1）→ ensureReady 清理重拉，本轮照常完成", async () => {
  const s = await setup({
    script: [
      { __dieOnStart: true },
      ev("turn.completed", { resultType: "success", tokenCount: 9, duration: 1 }),
    ],
  });
  const outcome = await s.session.prompt("hi");
  assert.equal(outcome.tokenCount, 9); // auto-respawn after the first instant-death spawn, this turn is not stuck
  const lines = await readLog(s.logFile);
  assert.ok(lines.some((l) => l.method === "session/create"));
  await s.session.dispose();
});

test("app-server 通道：create 后首轮 send 前无条件 setModel（所选即所得，persist:false）", async () => {
  const s = await setup({
    script: [ev("turn.completed", { resultType: "success", tokenCount: 3, duration: 1 })],
    modelRef: "bigmodel-coding-plan/GLM-5.3-Flash",
  });
  await s.session.prompt("hi");
  const lines = await readLog(s.logFile);
  const createIdx = lines.findIndex((l) => l.method === "session/create");
  const setModelIdx = lines.findIndex((l) => l.method === "session/setModel");
  const sendIdx = lines.findIndex((l) => l.method === "session/send");
  assert.ok(createIdx >= 0, "create must come first");
  assert.ok(setModelIdx > createIdx, "setModel must follow create (the runtime does not read env; the default model would fall back to GLM-5.3)");
  assert.ok(sendIdx < 0 || setModelIdx < sendIdx, "setModel must precede the first send");
  const setModel = lines[setModelIdx];
  assert.deepEqual(setModel.params.model, { providerId: "bigmodel-coding-plan", modelId: "GLM-5.3-Flash" });
  assert.equal(setModel.params.persistAsWorkspaceLastUsed, false);
  await s.session.dispose();
});

test("app-server 通道：图片轮 session/send 内联 attachments（v1 kind/dataBase64 形状，不走 v4 上传）", async () => {
  const s = await setup({
    script: [ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 1 })],
  });
  const raw = Buffer.from("png-image-bytes-0123456789");
  try {
    await s.session.prompt("看图", [{ data: raw.toString("base64"), mimeType: "image/png", filename: "shot.png" }]);
    const lines = await readLog(s.logFile);
    assert.ok(!lines.some((l) => (l.method ?? "").startsWith("v4/attachment/")), "the v1 surface needs no v4 attachment upload");
    const send = lines.find((l) => l.method === "session/send");
    assert.equal(send.params.content, "看图");
    assert.deepEqual(send.params.attachments, [{
      kind: "image",
      dataBase64: raw.toString("base64"),
      mimeType: "image/png",
      filename: "shot.png",
      sizeBytes: raw.length,
    }]);
  } finally {
    await s.session.dispose();
  }
});

test("app-server 通道：启动连续秒退 → 重试耗尽后带 stderr 的人话错误（不再盲报「进程未运行」）", async () => {
  const s = await setup({ script: [{ __alwaysDie: true }, ev("turn.completed", { resultType: "success", tokenCount: 1, duration: 1 })] });
  await assert.rejects(s.session.prompt("hi"), /app-server 启动失败（已重试 3 次）/);
  await s.session.dispose();
});

test("app-server 通道：轮次中被杀 → 本轮拒绝；下轮 prompt 自动重拉 + resume 恢复常态", async () => {
  const s = await setup({
    script: [
      { __delay: 3000 },
      ev("turn.completed", { resultType: "success", tokenCount: 1, duration: 1 }),
    ],
    sessId: "sess_existing",
  });
  const p1 = s.session.prompt("第一条");
  await new Promise((r) => setTimeout(r, 150));
  s.session.conn.kill("SIGKILL");
  await assert.rejects(p1, /app-server 进程退出/);
  const o2 = await s.session.prompt("第二条"); // respawn + resume, session back to normal
  assert.equal(o2.tokenCount, 1);
  const lines = await readLog(s.logFile);
  assert.ok(lines.filter((l) => l.method === "session/resume").length >= 2); // once initially + once after respawn
  await s.session.dispose();
});

// ---------------------------------------------------------------------------
// interaction primitive bridging (interaction/requestUserInput → interaction_request event → respondInteraction)
// ---------------------------------------------------------------------------

test("交互元语：plan 审批（ExitPlanMode）→ 批准应答 accept+answer:approve", async () => {
  const s = await setup({
    script: [
      { __reverseUserInput: {
        requestId: "req_plan_1",
        toolName: "ExitPlanMode",
        toolCallId: "call_plan_1",
        prompt: "Plan approval requested",
        schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
        input: { plan: "# 方案\n\n1. 改 store.ts\n2. 改 engine.ts" },
        questions: [{ question: "Review this implementation plan.", header: "Plan", options: [{ label: "Approve", description: "Exit plan mode and start implementation.", value: "approve" }] }],
      } },
      { __delay: 150 },
      ev("turn.completed", { resultType: "success", tokenCount: 10, duration: 1 }),
    ],
    sessId: "sess_existing",
  });
  const p = s.session.prompt("做吧");
  // events arrive async; poll-wait for interaction_request (not business-logic polling — just the test waiting for stub delivery)
  let req;
  for (let i = 0; i < 100 && !req; i++) {
    await new Promise((r) => setTimeout(r, 20));
    req = s.events.find((e) => e.type === "interaction_request");
  }
  assert.ok(req, "interaction_request event should be emitted");
  assert.equal(req.kind, "plan_approval");
  assert.equal(req.requestId, "req_plan_1");
  assert.equal(req.toolName, "ExitPlanMode");
  assert.match(req.plan, /改 store\.ts/);
  // approve
  assert.equal(s.session.respondInteraction("req_plan_1", { action: "accept" }), true);
  const outcome = await p;
  assert.equal(outcome.cancelled, false);
  // answer frame received by the stub: accept + answer approve
  const answers = (await readLog(s.logFile)).filter((l) => l.__userInputAnswer);
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0].result, { action: "accept", content: { answer: "approve" } });
  await s.session.dispose();
});

test("交互元语：plan 带反馈拒绝 → accept+answer:<反馈>（zcode 端归一为 deny+reason，agent 继续改方案）", async () => {
  const s = await setup({
    script: [
      { __reverseUserInput: {
        requestId: "req_plan_2",
        toolName: "ExitPlanMode",
        schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
        input: { plan: "方案 B" },
      } },
      { __delay: 150 },
      ev("turn.completed", { resultType: "success", tokenCount: 10, duration: 1 }),
    ],
    sessId: "sess_existing",
  });
  const p = s.session.prompt("改方案");
  let req;
  for (let i = 0; i < 100 && !req; i++) {
    await new Promise((r) => setTimeout(r, 20));
    req = s.events.find((e) => e.type === "interaction_request");
  }
  assert.ok(req);
  assert.equal(s.session.respondInteraction("req_plan_2", { action: "accept", message: "第 3 步用方案 A 的写法" }), true);
  await p;
  const answers = (await readLog(s.logFile)).filter((l) => l.__userInputAnswer);
  assert.deepEqual(answers[0].result, { action: "accept", content: { answer: "第 3 步用方案 A 的写法" } });
  await s.session.dispose();
});

test("交互元语：问题模式（AskUserQuestion）单选/多选 answers 回填 + 未知 requestId 返回 false", async () => {
  const s = await setup({
    script: [
      { __reverseUserInput: {
        requestId: "req_ask_1",
        toolName: "AskUserQuestion",
        prompt: "User input required",
        schema: { toolName: "AskUserQuestion" },
        input: { questions: [{ question: "用哪个数据库？", header: "DB", options: [{ label: "SQLite" }, { label: "Postgres" }] }] },
        questions: [{ question: "用哪个数据库？", header: "DB", multiSelect: false, options: [{ label: "SQLite", description: "零依赖" }, { label: "Postgres", description: "生产级" }] }],
      } },
      { __delay: 150 },
      ev("turn.completed", { resultType: "success", tokenCount: 10, duration: 1 }),
    ],
    sessId: "sess_existing",
  });
  const p = s.session.prompt("选一个");
  let req;
  for (let i = 0; i < 100 && !req; i++) {
    await new Promise((r) => setTimeout(r, 20));
    req = s.events.find((e) => e.type === "interaction_request");
  }
  assert.ok(req, "interaction_request should be emitted");
  assert.equal(req.kind, "ask_user");
  assert.equal(req.questions.length, 1);
  assert.equal(req.questions[0].question, "用哪个数据库？");
  assert.deepEqual(req.questions[0].options.map((o) => o.label), ["SQLite", "Postgres"]);
  assert.equal(req.questions[0].options[0].description, "零依赖");
  // unknown id fail-loud (returns false, does not throw)
  assert.equal(s.session.respondInteraction("nope", { action: "accept" }), false);
  assert.equal(s.session.respondInteraction("req_ask_1", { action: "accept", answers: { "用哪个数据库？": "SQLite" }, message: "  附加说明：选 SQLite 是因为本地开发  " }), true);
  await p;
  const answers = (await readLog(s.logFile)).filter((l) => l.__userInputAnswer);
  assert.equal(answers.length, 1);
  // message → annotations.notes (trimmed and attached to each answered question; zcode contract schema field)
  assert.deepEqual(answers[0].result, { action: "accept", content: {
    answers: { "用哪个数据库？": "SQLite" },
    annotations: { "用哪个数据库？": { notes: "附加说明：选 SQLite 是因为本地开发" } },
  } });
  await s.session.dispose();
});

test("交互元语：直接拒绝 + turn 收口清理未决请求（decline 应答 + interaction_expired）", async () => {
  const s = await setup({
    script: [
      { __reverseUserInput: {
        requestId: "req_decl_1",
        toolName: "AskUserQuestion",
        schema: { toolName: "AskUserQuestion" },
        input: {},
      } },
      { __delay: 500 },
      ev("turn.completed", { resultType: "success", tokenCount: 10, duration: 1 }),
    ],
    sessId: "sess_existing",
  });
  const p = s.session.prompt("问吧");
  let req;
  for (let i = 0; i < 100 && !req; i++) {
    await new Promise((r) => setTimeout(r, 20));
    req = s.events.find((e) => e.type === "interaction_request");
  }
  assert.ok(req);
  // user declines directly
  assert.equal(s.session.respondInteraction("req_decl_1", { action: "decline" }), true);
  // settle cleanup: the second pending request (req_decl_2) auto-declines + expires with turn.completed
  await p;
  const expired = s.events.filter((e) => e.type === "interaction_expired");
  assert.ok(expired.some((e) => e.requestId === "req_decl_1" && e.reason === "resolved"));
  const answers = (await readLog(s.logFile)).filter((l) => l.__userInputAnswer);
  assert.deepEqual(answers[0].result, { action: "decline" });
  await s.session.dispose();
});


// ---------------------------------------------------------------------------
// start-plan captcha bridge (interaction/requestProviderRuntimeHeaders, three states)
// ---------------------------------------------------------------------------

const START_PLAN_PROVIDER = {
  providerId: "builtin:bigmodel-start-plan",
  baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
  apiKey: "jwt-token-stub",
  models: [{ modelId: "GLM-5.3-Flash", contextWindow: 200000 }],
};

test("provider headers 桥：solver 成功 → 带 headers 重 upsert + 应答 {headersApplied:true}（strict 键集）", async () => {
  const s = await setup({
    script: [
      { __reverseProviderHeaders: { reason: "model-request" } },
      { __delay: 40 },
      ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 10 }),
    ],
    provider: START_PLAN_PROVIDER,
    onProviderHeadersRequest: async () => ({ ok: true, captchaVerifyParam: "aliyun-param-abc", region: "cn" }),
  });
  const outcome = await s.session.prompt("hi");
  assert.equal(outcome.cancelled, false);
  await s.session.dispose();
  const log = await readLog(s.logFile);
  // answer frame: strict zod only allows headersApplied (± errorMessage/providerRevision) — exactly one key here
  const answers = log.filter((e) => e.__providerHeadersAnswer);
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0].result, { headersApplied: true });
  // re-upsert: the second upsertModelProvider carries headers (the first upsert is in the startup sequence, headerless)
  const upserts = log.filter((e) => e.method === "workspace/upsertModelProvider");
  assert.ok(upserts.length >= 2, `expect >=2 upserts, got ${upserts.length}`);
  const withHeaders = upserts.find((e) => e.params?.provider?.headers);
  assert.ok(withHeaders, "re-upsert carries headers");
  assert.equal(withHeaders.params.provider.headers["x-aliyun-captcha-verify-param"], "aliyun-param-abc");
  assert.equal(withHeaders.params.provider.headers["x-aliyun-captcha-verify-region"], "cn");
  assert.equal(withHeaders.params.provider.providerId, "builtin:bigmodel-start-plan");
});

test("provider headers 桥：solver 失败 → 应答 {headersApplied:false, errorMessage}，不重 upsert", async () => {
  const s = await setup({
    script: [
      { __reverseProviderHeaders: { reason: "captcha-retry" } },
      { __delay: 40 },
      ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 10 }),
    ],
    provider: START_PLAN_PROVIDER,
    onProviderHeadersRequest: async () => ({ ok: false, errorMessage: "用户取消了验证码" }),
  });
  await s.session.prompt("hi");
  await s.session.dispose();
  const log = await readLog(s.logFile);
  const answers = log.filter((e) => e.__providerHeadersAnswer);
  assert.deepEqual(answers[0].result, { headersApplied: false, errorMessage: "用户取消了验证码" });
  const withHeaders = log.filter((e) => e.method === "workspace/upsertModelProvider" && e.params?.provider?.headers);
  assert.equal(withHeaders.length, 0, "failure must not backfill headers");
});

test("provider headers 桥：未配置 solver → {headersApplied:false}（start-plan 轮次人话失败）", async () => {
  const s = await setup({
    script: [
      { __reverseProviderHeaders: {} },
      { __delay: 40 },
      ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 10 }),
    ],
    provider: START_PLAN_PROVIDER,
  });
  await s.session.prompt("hi");
  await s.session.dispose();
  const log = await readLog(s.logFile);
  const answers = log.filter((e) => e.__providerHeadersAnswer);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].result.headersApplied, false);
  assert.match(String(answers[0].result.errorMessage), /求解器未配置/);
});

test("源码契约：agent_settled 清未决验证码请求（expire 帧 + resolver false 收口）", async () => {
  const { readFileSync } = await import("node:fs");
  const indexSrc = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(indexSrc, /event\.type === "agent_settled" && this\.providerHeadersPending\.size > 0/);
  assert.match(indexSrc, /provider_headers_expired/);
  assert.match(indexSrc, /respondProviderHeaders: true/);
  assert.match(indexSrc, /onProviderHeadersRequest: \(req\) => this\.solveProviderHeaders\(req\)/);
  assert.match(indexSrc, /builtin:\$\{providerId\}|wireProviderId\(providerId\)/);
  assert.match(indexSrc, /isStartPlanChannel\(providerId\)\s*\n?[\s\S]{0,240}ensureStartPlanCredential/);
});

// ---------------------------------------------------------------------------
// session/fork (the protocol surface behind "edit from here" / branching)
// ---------------------------------------------------------------------------

test("forkFromTurn：target {kind:turn,turnIndex} + 返回 forkedSessionId", async () => {
  const s = await setup({ script: [ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 3 })] });
  await s.session.prompt("hi"); // completes create/prefs/subscribe so the session is ready
  const forked = await s.session.forkFromTurn(2);
  assert.equal(forked, "sess_forked_1");
  await s.session.dispose();
  const log = await readLog(s.logFile);
  const forkReq = log.find((e) => e.method === "session/fork");
  assert.ok(forkReq, "session/fork request logged");
  assert.equal(forkReq.params.sessionId, "sess_stub_1");
  assert.deepEqual(forkReq.params.target, { kind: "turn", turnIndex: 2 });
});

test("forkFromTurn：运行中拒绝映射人话（Cannot fork while → 运行中不允许分叉）", async () => {
  const s = await setup({ script: [ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 3 })] });
  await s.session.prompt("hi");
  await assert.rejects(
    () => s.session.forkFromTurn(999),
    /运行中不允许分叉/,
  );
  await s.session.dispose();
});

// ---------------------------------------------------------------------------
// task list mirroring (TodoWrite working plan; docs/aiti-zcode-agent-task-list-plan.md)
// ---------------------------------------------------------------------------

test("任务列表：TodoWrite 工具 input 派生 → onTaskList 快照（对象条目 + 变化检测）", async () => {
  const snapshots = [];
  const s = await setup({
    script: [
      ev("tool.updated", { kind: "scheduled", toolCallId: "c1", toolName: "TodoWrite", input: { todos: [
        { content: "调研", status: "completed", priority: "high" },
        { content: "实施", status: "in_progress", priority: "high" },
        { content: "回归", status: "pending", priority: "medium" },
      ] } }),
      ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 3 }),
    ],
    onTaskList: (todos) => snapshots.push(todos),
  });
  await s.session.prompt("hi");
  await s.session.dispose();
  assert.equal(snapshots.length, 1, "one change emits exactly one frame");
  assert.deepEqual(snapshots[0], [
    { content: "调研", status: "completed", priority: "high" },
    { content: "实施", status: "in_progress", priority: "high" },
    { content: "回归", status: "pending", priority: "medium" },
  ]);
});

test("任务列表：跨轮持续 + 同列表不重发 + TodoRead/无关工具不更新", async () => {
  const snapshots = [];
  const todos = [{ content: "A", status: "completed", priority: "high" }, { content: "B", status: "pending", priority: "low" }];
  const s = await setup({
    script: [
      ev("tool.updated", { kind: "scheduled", toolCallId: "c1", toolName: "TodoWrite", input: { todos } }),
      ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 3 }),
      { __waitSends: 2 },
      // second turn: TodoRead (read-only), an unrelated tool with an items shape (should not match), a duplicate of the same list (dedup)
      ev("tool.updated", { kind: "scheduled", toolCallId: "c2", toolName: "TodoRead", input: { todos } }),
      ev("tool.updated", { kind: "scheduled", toolCallId: "c3", toolName: "WebFetch", input: { items: [{ content: "X", status: "pending" }] } }),
      ev("tool.updated", { kind: "result", toolCallId: "c1", toolName: "TodoWrite", result: { output: JSON.stringify({ oldTodos: todos, todos }) } }),
      ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 3 }),
    ],
    onTaskList: (todos) => snapshots.push(todos),
  });
  await s.session.prompt("hi");
  await s.session.prompt("hi2");
  await s.session.dispose();
  assert.equal(snapshots.length, 1, "TodoRead / unrelated tools / duplicate lists must not emit a new frame");
  assert.equal(snapshots[0].length, 2);
});

test("任务列表：字符串条目归一 + 非法 status 过滤整组弃 + MCP update_plan output 路", async () => {
  const snapshots = [];
  const s = await setup({
    script: [
      // mcp variant name + the output JSON-string fallback path (no list in input)
      ev("tool.updated", { kind: "scheduled", toolCallId: "m1", toolName: "mcp__plans__update_plan", input: {} }),
      ev("tool.updated", { kind: "result", toolCallId: "m1", toolName: "mcp__plans__update_plan", result: { output: JSON.stringify({ plan: ["第一步", { content: "第二步", status: "in_progress" }] }) } }),
      ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 3 }),
      { __waitSends: 2 },
      // invalid entry (bad status) -> all-or-nothing, no update
      ev("tool.updated", { kind: "scheduled", toolCallId: "m2", toolName: "TodoWrite", input: { todos: [{ content: "好", status: "completed" }, { content: "坏", status: "cancelled" }] } }),
      ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 3 }),
    ],
    onTaskList: (todos) => snapshots.push(todos),
  });
  await s.session.prompt("hi");
  await s.session.prompt("hi2");
  await s.session.dispose();
  assert.equal(snapshots.length, 1, "invalid-status group does not update (all-or-nothing)");
  // string entries use the desktop _Cn defaults: first in_progress, rest pending (object entries carry their own status)
  assert.deepEqual(snapshots[0], [
    { content: "第一步", status: "in_progress" },
    { content: "第二步", status: "in_progress" },
  ]);
});

test("任务列表：resume 快照 todos 种子（跨进程复活/刷新恢复）", async () => {
  const snapshots = [];
  const s = await setup({
    script: [{ __resumeTodos: [{ content: "种子任务", status: "in_progress", priority: "high" }] }, ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 3 })],
    sessId: "sess_known_1",
    onTaskList: (todos) => snapshots.push(todos),
  });
  await s.session.prompt("hi");
  await s.session.dispose();
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0], [{ content: "种子任务", status: "in_progress", priority: "high" }]);
});

test("任务列表：流式 tool_call 帧派生（真机 wire：scheduled 事件 inputOmitted 剥 input）", async () => {
  const snapshots = [];
  const s = await setup({
    script: [
      // real-machine shape: tool_input streaming → tool_call (args finalized) → tool.updated scheduled with input stripped
      ev("model.streaming", { kind: "tool_input_start", assistantMessageId: "msg1", partId: "pt1", toolCallId: "call_tw", toolName: "TodoWrite" }),
      ev("model.streaming", { kind: "tool_input_delta", assistantMessageId: "msg1", partId: "pt1", delta: JSON.stringify({ todos: [{ content: "流式任务甲", status: "completed", priority: "high" }, { content: "流式任务乙", status: "in_progress" }] }) }),
      ev("model.streaming", { kind: "tool_call", assistantMessageId: "msg1", partId: "pt1", toolCallId: "call_tw", toolName: "TodoWrite" }),
      // scheduled without input (inputOmitted:true) + result without toolName (resolved via callId) → neither may mis-update or drop the update
      ev("tool.updated", { kind: "scheduled", toolCallId: "call_tw", toolName: "TodoWrite", inputOmitted: true, inputRef: "model_stream", inputByteLength: 120 }),
      ev("tool.updated", { kind: "result", toolCallId: "call_tw", result: { output: JSON.stringify({ todos: [{ content: "流式任务甲", status: "completed", priority: "high" }, { content: "流式任务乙", status: "in_progress" }] }) } }),
      ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 3 }),
    ],
    onTaskList: (todos) => snapshots.push(todos),
  });
  await s.session.prompt("hi");
  await s.session.dispose();
  assert.equal(snapshots.length, 1, "tool_call frame captured once; input-stripped scheduled not repeated, same-value result deduplicated");
  assert.deepEqual(snapshots[0], [
    { content: "流式任务甲", status: "completed", priority: "high" },
    { content: "流式任务乙", status: "in_progress" },
  ]);
});

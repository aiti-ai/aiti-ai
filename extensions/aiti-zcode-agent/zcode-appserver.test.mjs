/**
 * aiti-zcode-agent app-server 通道测试 —— wire 契约（桩 app-server 子进程），零网络零真凭据。
 *
 * Run: node --test pi-web-ext/aiti-zcode-agent/zcode-appserver.test.mjs
 * （node 24 原生 TS strip-types，import .ts 同 zcode-core.test.mjs）
 *
 * 桩机制：STUB_SCRIPT（JSON 数组）驱动 send 后的事件序列；支持
 *   {__delay:ms} 延时、{__waitSends:n} 等到第 n 次 send 后继续；
 *   {__dieOnStart} 首次启动秒退（exit 1，重拉后正常运行）、{__alwaysDie} 每次启动都秒退；
 *   其余条目原样作为 wire 帧写回 stdout（session/event 通知）。
 * stub 收到的全部请求记录到 STUB_LOG 文件（每行一个 JSON）供断言。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = mkdtempSync(join(tmpdir(), "zcode-appserver-test-"));
process.env.EXT_MODEL_STATE_DIR = join(ROOT, "ext-model-state");

const { AppServerSession, ZcodeAppServerConnection, toProtocolModel, toProtocolMode } = await import("./zcode-appserver.ts");

/**
 * 存活连接登记：桩 app-server 是「读到 EOF 才退」的服务端，用例中间的断言失败会跳过
 * dispose() → 子进程带着继承的 stdio 管道活到文件结束，`node --test` 的**文件子进程
 * 永不退出**，整轮测试原地卡死（实测：并行负载下 abort 用例超时 → 全量套件停在 386 行）。
 * 故文件尾统一补杀，再删临时目录。
 */
const liveConns = new Set();

test.after(async () => {
  for (const c of liveConns) c.kill("SIGKILL");
  liveConns.clear();
  // 等子进程真正退出释放句柄（Windows 目录被活进程 cwd 钉住时 rmSync 会 EBUSY）
  await new Promise((r) => setTimeout(r, 150));
  rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 桩 app-server 脚本
// ---------------------------------------------------------------------------
const STUB = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import readline from "node:readline";
const log = process.env.STUB_LOG;
const script = JSON.parse(process.env.STUB_SCRIPT || "[]");
// __dieOnStart：首次启动（STUB_LOG 不存在）置标记后 exit(1)，模拟 spawn 秒退；重拉后正常运行
// __alwaysDie：每次启动都 exit(1)，模拟持续性启动失败（重试耗尽路径）
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
      // 模拟 server→client 反向请求 interaction/requestUserInput（id = server-N，等应答；不重发）
      const p = entry.__reverseUserInput || {};
      write({ id: "server-" + nextServerId++, method: "interaction/requestUserInput", params: p });
      continue;
    }
    if (entry && typeof entry === "object" && "__reverseProviderHeaders" in entry) {
      // 模拟 server→client 反向请求 interaction/requestProviderRuntimeHeaders（start-plan 验证码协议）
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
  // 反向请求的应答
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
      activeSid = (msg.params && msg.params.sessionId) || activeSid;
      // __resumeTodos：快照 todos 种子（真机 resume 响应快照同构，含 todos）
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
    case "session/setMode": write({ id: msg.id, result: {} }); break;
    case "session/close": write({ id: msg.id, result: { closed: true } }); break;
    case "session/fork": {
      // turnIndex=999 → 运行中拒绝（映射人话）；否则返回子会话 id（log 里断言 target 形状）
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
// 真机 wire 语义：流式帧带 assistantMessageId/partial partId；此 helper 统一补 msg 前缀可省
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
     * 等某个事件到达（事件驱动，命中即了结；超时是「快速可见失败」而非原地挂死）。
     * 用它替代定长 setTimeout 确认「本轮真的跑起来了」——并行负载下定时器抖动会把
     * 这类用例拖成假红（实测：150ms 的 setTimeout 拖到 3.3s）。
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
  // 应答帧的写出在 promise 微任务链上，同步紧跟 respondInteraction 读文件会早读（时序兑底）
  await new Promise((r) => setTimeout(r, 60));
  const { readFileSync, existsSync } = await import("node:fs");
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// 纯函数
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
// E2E：流式文本
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
  // 重挂 onSessionId
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
  // settled 帧在 message_end 之后（closeStream 先封口）
  const settledIdx = types.indexOf("agent_settled");
  assert.ok(settledIdx > 4);
  // settled 前依次是 agent_end、message_end(assistant 最终封口)
  assert.equal(types[settledIdx - 1], "agent_end");
  const finalMsg = s.events[settledIdx - 2].message;
  assert.equal(finalMsg.role, "assistant");
  assert.deepEqual(finalMsg.content, [{ type: "text", text: "你好，世界" }]);

  // stub 日志：create 前反查 prefs 且应答被消费；subscribe 带 desktop-continuous
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
  // 关键顺序：text… → toolcall_end → [流式段封口 message_end(assistant)] → tool_execution_start → update → end → toolResult 卡 → 新 message_start → …
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
  // 第二段文本 = 新的流式消息（msg1 封口后 msg2 重开）
  const starts = s.events.filter((e) => e.type === "message_start");
  assert.equal(starts.length, 2);
  // 最终 assistant 消息只有第二段文本
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
      // 先发一个 text_delta：本轮真的跑起来了（waitEvent 命中）才允许 stop——定长
      // setTimeout 在并行负载下会拖到成功帧之后，stop() 因 turnWaiters 尚空而 no-op（假红）。
      ev("model.streaming", { kind: "text_delta", assistantMessageId: "msgA", delta: "慢慢" }),
      // 长轮次：绿路由 cancelled 收口先行（~0.2s），只有 stop 真失效才付满 30s。
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
  assert.ok(resume.params.runtimeModel, "resume 应携带 runtimeModel");
  assert.deepEqual(resume.params.runtimeModel.model, { providerId: "bigmodel", modelId: "GLM-5.3-Flash" });
  assert.equal(resume.params.runtimeModel.provider.providerId, "bigmodel");
  assert.equal(resume.params.runtimeModel.provider.kind, "anthropic");
  assert.deepEqual(resume.params.runtimeModel.provider.models, [{ modelId: "GLM-5.3-Flash", contextWindow: 1000000 }, { modelId: "GLM-5.3", contextWindow: 1000000 }]);
  assert.ok(typeof resume.params.runtimeModel.revision === "string");
  assert.ok(typeof resume.params.runtimeModel.generatedAt === "number");
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
  assert.equal(sends.length, 2, "首次 -32031 应自动重发一次");
  assert.equal(sends[0].params.runtimeModel, undefined);
  assert.ok(sends[1].params.runtimeModel, "重发应携带 runtimeModel");
  await s.session.dispose();
});

test("app-server 通道：真机 wire 容错（无 partId / 无 *_start 帧 / 尾随文本新消息）", async () => {
  const s = await setup({
    script: [
      // 真机形态（2026-09-07 抓包）：reasoning_delta 无 start、无 partId；tool 帧无 partId 靠 toolCallId
      ev("model.streaming", { kind: "reasoning_delta", assistantMessageId: "msgA", delta: "想一下" }),
      ev("model.streaming", { kind: "tool_input_start", assistantMessageId: "msgA", toolCallId: "call_x", toolName: "Bash" }),
      ev("model.streaming", { kind: "tool_input_delta", assistantMessageId: "msgA", toolCallId: "call_x", delta: '{"command":"uname -s"}' }),
      ev("model.streaming", { kind: "tool_input_end", assistantMessageId: "msgA", toolCallId: "call_x" }),
      ev("model.streaming", { kind: "tool_call", assistantMessageId: "msgA", toolCallId: "call_x", toolName: "Bash" }),
      ev("tool.updated", { kind: "scheduled", toolCallId: "call_x", toolName: "Bash" }),
      ev("tool.updated", { kind: "result", toolCallId: "call_x", toolName: "Bash", result: { output: "Linux" }, duration: 10 }),
      // 尾随文本：新 assistantMessageId，无 text_start，直接 text_delta
      ev("model.streaming", { kind: "text_delta", assistantMessageId: "msgB", delta: "结果是 Linux。" }),
      ev("turn.completed", { resultType: "success", tokenCount: 77, duration: 100 }),
    ],
  });
  const outcome = await s.session.prompt("hi");
  assert.equal(outcome.tokenCount, 77);
  const types = s.events.map((e) => e.type);
  // 结构断言：首段（thinking+tool）→ toolResult → 尾段 text，三段消息
  const msgEnds = s.events.filter((e) => e.type === "message_end");
  const firstAssistant = msgEnds.find((e) => e.message?.role === "assistant");
  assert.deepEqual((firstAssistant.message.content).map((b) => b.type), ["thinking", "toolCall"]);
  assert.equal(firstAssistant.message.content[0].thinking, "想一下");
  assert.deepEqual(firstAssistant.message.content[1].input, { command: "uname -s" });
  const toolResult = msgEnds.find((e) => e.message?.role === "toolResult");
  assert.equal(toolResult.message.content[0].text, "Linux");
  const lastAssistant = msgEnds.filter((e) => e.message?.role === "assistant").pop();
  assert.deepEqual(lastAssistant.message.content, [{ type: "text", text: "结果是 Linux。" }]);
  // 消息开合次数：msgA 一段 + msgB 一段 = 2 次 message_start（msgA 含 tool 前的 thinking 段）
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
  // 杀掉 stub 进程
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
  assert.equal(outcome.tokenCount, 9); // 首次 spawn 秒退后自动重拉，本轮不被卡死
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
  assert.ok(createIdx >= 0, "应先 create");
  assert.ok(setModelIdx > createIdx, "create 后必须补 setModel（runtime 不读 env，默认模型会落到 GLM-5.3）");
  assert.ok(sendIdx < 0 || setModelIdx < sendIdx, "setModel 必须在首轮 send 之前");
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
    assert.ok(!lines.some((l) => (l.method ?? "").startsWith("v4/attachment/")), "v1 面不需要 v4 附件上传");
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
  const o2 = await s.session.prompt("第二条"); // 重拉 + resume，会话恢复常态
  assert.equal(o2.tokenCount, 1);
  const lines = await readLog(s.logFile);
  assert.ok(lines.filter((l) => l.method === "session/resume").length >= 2); // 初次 + 重拉后各一次
  await s.session.dispose();
});

// ---------------------------------------------------------------------------
// 交互元语桥接（interaction/requestUserInput → interaction_request 事件 → respondInteraction）
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
  // 事件异步到达，轮询等 interaction_request（非轮询业务逻辑，仅测试等待桩投递）
  let req;
  for (let i = 0; i < 100 && !req; i++) {
    await new Promise((r) => setTimeout(r, 20));
    req = s.events.find((e) => e.type === "interaction_request");
  }
  assert.ok(req, "应发出 interaction_request 事件");
  assert.equal(req.kind, "plan_approval");
  assert.equal(req.requestId, "req_plan_1");
  assert.equal(req.toolName, "ExitPlanMode");
  assert.match(req.plan, /改 store\.ts/);
  // 批准
  assert.equal(s.session.respondInteraction("req_plan_1", { action: "accept" }), true);
  const outcome = await p;
  assert.equal(outcome.cancelled, false);
  // stub 收到的应答帧：accept + answer approve
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
  assert.ok(req, "应发出 interaction_request");
  assert.equal(req.kind, "ask_user");
  assert.equal(req.questions.length, 1);
  assert.equal(req.questions[0].question, "用哪个数据库？");
  assert.deepEqual(req.questions[0].options.map((o) => o.label), ["SQLite", "Postgres"]);
  assert.equal(req.questions[0].options[0].description, "零依赖");
  // 未知 id fail-loud（返回 false，不抛）
  assert.equal(s.session.respondInteraction("nope", { action: "accept" }), false);
  assert.equal(s.session.respondInteraction("req_ask_1", { action: "accept", answers: { "用哪个数据库？": "SQLite" }, message: "  附加说明：选 SQLite 是因为本地开发  " }), true);
  await p;
  const answers = (await readLog(s.logFile)).filter((l) => l.__userInputAnswer);
  assert.equal(answers.length, 1);
  // message → annotations.notes（trim 后挂到每道已答题；zcode 契约 schema 字段）
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
  // 用户直接拒绝
  assert.equal(s.session.respondInteraction("req_decl_1", { action: "decline" }), true);
  // 收口清理：第二个未决请求（req_decl_2）随 turn.completed 自动 decline + expired
  await p;
  const expired = s.events.filter((e) => e.type === "interaction_expired");
  assert.ok(expired.some((e) => e.requestId === "req_decl_1" && e.reason === "resolved"));
  const answers = (await readLog(s.logFile)).filter((l) => l.__userInputAnswer);
  assert.deepEqual(answers[0].result, { action: "decline" });
  await s.session.dispose();
});


// ---------------------------------------------------------------------------
// start-plan 验证码桥（interaction/requestProviderRuntimeHeaders 三态）
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
  // 应答帧：strict zod 只允许 headersApplied（±errorMessage/providerRevision）——这里恰一键
  const answers = log.filter((e) => e.__providerHeadersAnswer);
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0].result, { headersApplied: true });
  // 重 upsert：第二次 upsertModelProvider 带 headers（首 upsert 在启动序列、无 headers）
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
  assert.equal(withHeaders.length, 0, "失败不得回填 headers");
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
  assert.match(indexSrc, /isStartPlanChannel\(providerId\)\s*\n?[\s\S]{0,120}ensureStartPlanCredential/);
});

// ---------------------------------------------------------------------------
// session/fork（编辑从此处 / 分支 的协议面）
// ---------------------------------------------------------------------------

test("forkFromTurn：target {kind:turn,turnIndex} + 返回 forkedSessionId", async () => {
  const s = await setup({ script: [ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 3 })] });
  await s.session.prompt("hi"); // 走完 create/prefs/subscribe，会话就绪
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
// 任务列表镜像（TodoWrite working plan；docs/aiti-zcode-agent-task-list-plan.md）
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
  assert.equal(snapshots.length, 1, "变化一次只发一帧");
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
      // 第二轮：TodoRead（只读）、无关工具带 items 形状（不应命中）、重复同列表（去重）
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
  assert.equal(snapshots.length, 1, "TodoRead/无关工具/重复列表均不触发新帧");
  assert.equal(snapshots[0].length, 2);
});

test("任务列表：字符串条目归一 + 非法 status 过滤整组弃 + MCP update_plan output 路", async () => {
  const snapshots = [];
  const s = await setup({
    script: [
      // mcp 变体名 + output JSON 字符串兜底路（input 无列表）
      ev("tool.updated", { kind: "scheduled", toolCallId: "m1", toolName: "mcp__plans__update_plan", input: {} }),
      ev("tool.updated", { kind: "result", toolCallId: "m1", toolName: "mcp__plans__update_plan", result: { output: JSON.stringify({ plan: ["第一步", { content: "第二步", status: "in_progress" }] }) } }),
      ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 3 }),
      { __waitSends: 2 },
      // 非法条目（status 非法）→ all-or-nothing 不更新
      ev("tool.updated", { kind: "scheduled", toolCallId: "m2", toolName: "TodoWrite", input: { todos: [{ content: "好", status: "completed" }, { content: "坏", status: "cancelled" }] } }),
      ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 3 }),
    ],
    onTaskList: (todos) => snapshots.push(todos),
  });
  await s.session.prompt("hi");
  await s.session.prompt("hi2");
  await s.session.dispose();
  assert.equal(snapshots.length, 1, "非法 status 组不更新（all-or-nothing）");
  // 字符串条目走桌面 _Cn 缺省：首项 in_progress 其余 pending（对象条目自带 status）
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
      // 真机形态：tool_input 流式 → tool_call（参数定型）→ tool.updated scheduled 被剥 input
      ev("model.streaming", { kind: "tool_input_start", assistantMessageId: "msg1", partId: "pt1", toolCallId: "call_tw", toolName: "TodoWrite" }),
      ev("model.streaming", { kind: "tool_input_delta", assistantMessageId: "msg1", partId: "pt1", delta: JSON.stringify({ todos: [{ content: "流式任务甲", status: "completed", priority: "high" }, { content: "流式任务乙", status: "in_progress" }] }) }),
      ev("model.streaming", { kind: "tool_call", assistantMessageId: "msg1", partId: "pt1", toolCallId: "call_tw", toolName: "TodoWrite" }),
      // scheduled 无 input（inputOmitted:true）+ result 无 toolName（callId 反查）→ 均不得误更新/丢更新
      ev("tool.updated", { kind: "scheduled", toolCallId: "call_tw", toolName: "TodoWrite", inputOmitted: true, inputRef: "model_stream", inputByteLength: 120 }),
      ev("tool.updated", { kind: "result", toolCallId: "call_tw", result: { output: JSON.stringify({ todos: [{ content: "流式任务甲", status: "completed", priority: "high" }, { content: "流式任务乙", status: "in_progress" }] }) } }),
      ev("turn.completed", { resultType: "success", tokenCount: 5, duration: 3 }),
    ],
    onTaskList: (todos) => snapshots.push(todos),
  });
  await s.session.prompt("hi");
  await s.session.dispose();
  assert.equal(snapshots.length, 1, "tool_call 帧捕获一次；剥 input 的 scheduled 不重复、同值 result 去重");
  assert.deepEqual(snapshots[0], [
    { content: "流式任务甲", status: "completed", priority: "high" },
    { content: "流式任务乙", status: "in_progress" },
  ]);
});

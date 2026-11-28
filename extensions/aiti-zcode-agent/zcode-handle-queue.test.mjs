/**
 * aiti-zcode-agent handle-level queue behavior tests (queue keeper adaptation, plan §6 acceptance 1)
 * —— Real ZcodeHandle + stub app-server child process; verifies streamingBehavior routing /
 *    steer mirroring / queueManage / automatic follow-up turns. Zero network, zero real credentials.
 *
 * Run: node --test pi-web-ext/aiti-zcode-agent/zcode-handle-queue.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = mkdtempSync(join(tmpdir(), "zcode-handle-queue-"));
process.env.EXT_MODEL_STATE_DIR = join(ROOT, "ext-model-state");

/**
 * Live-handle registry (prevents suite hang): the stub app-server only exits after reading EOF,
 * so a mid-test assertion failure skips the trailing `dispose()` → leftover children keep their
 * inherited stdio pipes, this file's `node --test` child never exits, and **the whole full test
 * run wedges in place** (observed: stuck on the zcode-handle-queue line under parallel load).
 * Hence a catch-all dispose at end of file (it kills the connection processes).
 */
const liveHandles = new Set();

// ---- stub app-server (same mechanism as zcode-appserver.test.mjs; behavior branches on send count) ----
// Stub log path: must be an os.tmpdir() absolute path — on Windows "/tmp/..." resolves against the
// process cwd's drive; stub (cwd=session cwd) and test process may land on different drives (2026-09-08).
const LOG = join(tmpdir(), "zcode-hq-stub-log.jsonl");
const STUB = `
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const log = ${JSON.stringify(LOG)}; // 绝对路径：治理 env 白名单不带 STUB_LOG，测试前由用例清空
const rl = readline.createInterface({ input: process.stdin });
let nextServerId = 1;
let sends = 0;
let v4s = 0;
const v4Pending = [];
const write = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rec = (o) => { if (log) appendFileSync(log, JSON.stringify(o) + "\\n"); };
let prefsAnswered = false;
const seq = () => "s" + sends;
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && msg.result !== undefined && typeof msg.id === "string" && msg.id.startsWith("server-")) {
    prefsAnswered = msg.result.nativeSearchEnhancementsEnabled === true;
    return;
  }
  if (typeof msg.method !== "string") return;
  rec({ method: msg.method, params: msg.params });
  switch (msg.method) {
    case "session/create": {
      write({ id: "server-" + nextServerId++, method: "session/requestRuntimePreferences", params: { sessionId: "sess_x", scope: "runtime-materialization" } });
      setTimeout(() => {
        if (!prefsAnswered) { write({ id: msg.id, error: { code: -32022, message: "no prefs" } }); return; }
        write({ id: msg.id, result: { protocol: { name: "ZCode Protocol", version: 1 }, session: { sessionId: "sess_hq_1", status: "idle" }, projection: { contextWindow: 1000000 } } });
      }, 15);
      break;
    }
    case "session/resume": write({ id: msg.id, result: { record: {} } }); break;
    case "session/subscribe": write({ id: msg.id, result: { eventSeq: 0, events: [] } }); break;
    case "session/setModel":
    case "session/setMode": write({ id: msg.id, result: {} }); break;
    case "session/close": write({ id: msg.id, result: { closed: true } }); break;
    case "session/stop":
      write({ id: msg.id, result: {} });
      setTimeout(() => write({ method: "session/event", params: { type: "turn.completed", payload: { resultType: "cancelled", tokenCount: 5, duration: 5 } } }), 30);
      break;
    case "v4/command": {
      // desktop-style steer: sendText{requestedDelivery:"guide"} → accepted + steerQueued,
      // then a simulated inter-turn drain emits steerDrained 250ms later (mirror/bubble dequeue chain)
      v4s += 1;
      const n = v4s;
      const text = String(msg.params?.payload?.text ?? "");
      const pid = "pi_v4_" + n;
      v4Pending.push(pid);
      write({ id: msg.id, result: { commandId: msg.params?.commandId, status: "accepted", revisionAtDecision: 1, result: { type: "inputAccepted", delivery: "guide", inputId: msg.params?.commandId } } });
      setTimeout(() => write({ method: "session/event", params: { type: "turn.steerQueued", payload: { pendingInputId: pid, input: text, queueLength: n } } }), 40);
      setTimeout(() => {
        write({ method: "session/event", params: { type: "turn.steerDrained", payload: { pendingInputIds: [...v4Pending] } } });
        v4Pending.length = 0;
      }, 250);
      break;
    }
    case "session/send": {
      sends += 1;
      const n = sends;
      write({ id: msg.id, result: { accepted: true, sessionId: "sess_hq_1", stateRevision: n } });
      // Task-list case (gated by content so other cases' send-count assertions are unaffected): full TodoWrite scheduled list
      if (String(msg.params?.content ?? "") === "带任务的一轮") {
        setTimeout(() => write({ method: "session/event", params: { type: "tool.updated", payload: { kind: "scheduled", toolCallId: "tw1", toolName: "TodoWrite", input: { todos: [
          { content: "任务甲", status: "completed", priority: "high" },
          { content: "任务乙", status: "in_progress", priority: "medium" },
        ] } } } }), 60);
      }
      // Every send gets a streaming reply + settle (n===1 stretches the settle delay to open an assertion window mid-run)
      setTimeout(() => write({ method: "session/event", params: { type: "model.streaming", payload: { kind: "text_delta", assistantMessageId: "m" + n, partId: "p" + n, delta: "回复" + n } } }), n === 1 ? 200 : 60);
      // Regression (2026-09-20: a large real session wrongly displayed 100%): tokenCount is
      // deliberately 1.5M-scale (the chars/4 estimate explodes when the engine lacks a baseline)
      // while usage carries the real numbers — context usage MUST come from usage.
      setTimeout(() => write({ method: "session/event", params: { type: "turn.completed", payload: { resultType: "success", tokenCount: 1500000 + n, usage: { inputTokens: 90 + n, outputTokens: 10, totalTokens: 100 + n }, duration: 10, cacheStats: { cacheReadTokens: 50 } } } }), n === 1 ? 2000 : 160);
      break;
    }
    default: write({ id: msg.id, result: {} });
  }
});
`;

// ---- environment ----
const stubDir = join(ROOT, "stub");
const stubPath = join(stubDir, "appserver-stub.mjs");
const logFile = join(stubDir, "stub-log.jsonl");

test.before(() => {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(stubPath, STUB);
  try { rmSync(LOG); } catch { /* not exist */ }
  // feature stub: force the app-server transport + use the protocol stub as runtime
  const prevById = globalThis.__piWebExt?.byId;
  globalThis.__piWebExt = {
    featureValue: (_extId, fid) =>
      fid === "zcode.transport" ? "app-server"
      : fid === "zcode.runtimePath" ? stubPath
      : fid === "zcode.apiKeyOverride" ? "stub.key"
      : fid === "zcode.mode" ? "build"
      : fid === "zcode.model" ? "bigmodel/GLM-5.3"
      : fid === "zcode.autoDownload" ? false
      : "",
    ...(prevById ? { byId: prevById } : {}),
  };
});

function mkdirSyncDeep(p) { mkdirSync(p, { recursive: true }); }

test.after(async () => {
  for (const h of liveHandles) {
    try { await h.dispose(); } catch { /* already dead */ }
  }
  liveHandles.clear();
  // Windows: stub processes may briefly hold file handles under ROOT → retry the delete; on persistent failure warn without failing (Linux deletes directly)
  for (let i = 0; i < 5; i++) {
    try { rmSync(ROOT, { recursive: true, force: true }); return; } catch { /* retry */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch (e) { console.warn("[cleanup] ROOT 残留：", e?.message); }
});

async function readLog() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const { mod, registered, capturedServices } = await setupExt();

// Every handle registers here; a catch-all dispose runs at end of file (see the liveHandles note)
const createSessionOrig = registered.createSession.bind(registered);
registered.createSession = async (opts) => {
  const h = await createSessionOrig(opts);
  liveHandles.add(h);
  return h;
};

async function setupExt() {
  const m = await import("./index.ts");
  let registered = null;
  const capturedServices = {};
  await m.default.server.startup({
    configDir: join(ROOT, "ext-data"),
    sessionProviders: { register: (p) => { registered = p; return "k"; } },
    // Service stub: capture services provided during startup (sessionDormantState dormant fallback etc.)
    services: { provide: (key, impl) => { capturedServices[key] = impl; return () => {}; } },
  });
  return { mod: m, registered, capturedServices };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("handle 队列行为：v4 steer 注入 + followUp 分流 + queueManage + steerDrained 出队 + 自动续轮", async () => {
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));

  // Turn 1: hold running (stub settle delay 450ms leaves a window for mid-run assertions)
  const p1 = handle.prompt("第一轮");
  await sleep(300);
  assert.equal(handle.isRunning(), true);

  // prompt while running (steer semantic entry) → v4/command sendText injection (desktop-style; no session/send)
  await handle.prompt("插队A");
  await sleep(120); // let the steerQueued event arrive
  let qus = events.filter((e) => e.type === "queue_update");
  assert.ok(qus.length >= 1, "queue_update broadcast present");
  assert.deepEqual(qus[qus.length - 1].steering, ["插队A"], "steer enters the v4 mirror");
  await sleep(250); // stub simulates the gap drain → steerDrained → dequeue
  assert.deepEqual(events.filter((e) => e.type === "queue_update").pop().steering, [], "mirror dequeued after drain");

  // rev version axis (cross-repo contract; data source for pi-web late-snapshot guards): exactly
  // one mirror-in and one mirror-out frame so far, all positive strictly monotonic rev
  const revsSoFar = events.filter((e) => e.type === "queue_update").map((e) => e.rev);
  assert.equal(revsSoFar.length, 2, "exactly two frames: mirror-in/mirror-out");
  assert.ok(revsSoFar.every((r) => typeof r === "number" && r > 0), "queue_update carries a positive rev");
  assert.ok(revsSoFar[1] > revsSoFar[0], "rev strictly increases");

  // followUp enqueues (held locally; nothing sent to the server)
  await handle.prompt("排队一", { streamingBehavior: "followUp" });
  await handle.followUp("排队二");
  const qu2 = events.filter((e) => e.type === "queue_update").pop();
  assert.deepEqual(qu2.followUp, ["排队一", "排队二"]);

  // queueManage: list / move / remove
  const l1 = await handle.queueManage({ action: "list" });
  assert.deepEqual(l1.followUp, ["排队一", "排队二"]);
  assert.equal(l1.rev, qu2.rev, "list snapshot matches the latest event rev (no change in between)");
  await handle.queueManage({ action: "move", kind: "followUp", from: 1, to: 0 });
  const rm = await handle.queueManage({ action: "remove", kind: "followUp", index: 0 });
  assert.equal(rm.entry.text, "排队二"); // after the move, index 0 holds the moved entry // cjk-ok (quotes a fixture string)
  assert.ok(rm.rev > l1.rev, "mutating RPC results carry an increased rev");
  const l2 = await handle.queueManage({ action: "list" });
  assert.deepEqual(l2.followUp, ["排队一"]);
  assert.equal(l2.rev, rm.rev, "post-remove snapshot matches the RPC result rev (same axis as the event stream)");

  // steering group ops → human-readable error (already handed to the v4 queue; the protocol has no per-entry recall)
  await assert.rejects(
    () => handle.queueManage({ action: "remove", kind: "steer", index: 0 }),
    /协议不支持撤回/,
  );

  // exactly 1 session/send (turn 1 itself): steer went via v4, followUp did not leak a send
  let log = await readLog();
  assert.equal(log.filter((l) => l.method === "session/send").length, 1, "a send during a running turn must not go through session/send");
  const v4Calls = log.filter((l) => l.method === "v4/command");
  assert.equal(v4Calls.length, 1, "the steer prompt should produce exactly one v4 command");
  assert.equal(v4Calls[0].params.type, "sendText");
  assert.equal(v4Calls[0].params.payload.requestedDelivery, "guide");
  assert.equal(v4Calls[0].params.payload.text, "插队A");

  // convert followUp→steer: dequeue the queued entry and inject via v4 immediately (send#2 semantics); remaining followUp empty
  const cv = await handle.queueManage({ action: "convert", kind: "followUp", index: 0, targetKind: "steer" });
  assert.deepEqual(cv.followUp, [], "converted entry should leave the queue");
  await sleep(120);
  assert.deepEqual(events.filter((e) => e.type === "queue_update").pop().steering, ["排队一"], "converted entry enters the mirror");
  await sleep(250);
  log = await readLog();
  const v4Calls2 = log.filter((l) => l.method === "v4/command");
  assert.equal(v4Calls2.length, 2, "convert should immediately produce the second v4 injection");
  assert.equal(v4Calls2[1].params.payload.text, "排队一");
  assert.deepEqual(events.filter((e) => e.type === "queue_update").pop().steering, [], "converted entry dequeued after drain");

  // queue one more entry, wait for turn 1 to settle → verify automatic follow-up
  await handle.followUp("放行");
  await p1; // turn 1 settles (stub completes after 2000ms)
  await sleep(500); // automatic follow-up send#2 (the parked follow-up) plus its completion

  log = await readLog();
  const sendTexts = log.filter((l) => l.method === "session/send").map((l) => l.params.content);
  assert.deepEqual(sendTexts, ["第一轮", "放行"], "after settling, the follow-up turn sends the locally queued entry");

  // final state: both queues empty
  const quFinal = events.filter((e) => e.type === "queue_update").pop();
  assert.deepEqual(quFinal.steering, []);
  assert.deepEqual(quFinal.followUp, []);
  // rev monotonic throughout + RPC snapshots settle on the same axis as events (six changes after
  // l2: convert dequeue / steerQueued mirror-in / steerDrained mirror-out / follow-up enqueue /
  // scheduleDrain follow-up dequeue / the post-settle re-drain's empty-queue broadcast-only frame)
  const allRevs = events.filter((e) => e.type === "queue_update").map((e) => e.rev);
  assert.ok(allRevs.every((r, i) => i === 0 || r > allRevs[i - 1]), "rev strictly increases throughout");
  assert.equal(quFinal.rev, l2.rev + 6, "final rev is continuous with the mid-run snapshot");

  // user bubbles settle (visibility contract): turn 1 (runTurn) / inserted + queued items (v4 steer's steerQueued) / follow-up (runTurn) // cjk-ok-next
  const userTexts = events
    .filter((e) => e.type === "message_end" && e.message?.role === "user")
    .map((e) => (Array.isArray(e.message.content) ? e.message.content.find((b) => b.type === "text")?.text ?? "" : String(e.message.content ?? "")));
  assert.ok(userTexts.includes("第一轮"), "runTurn user bubble");
  assert.ok(userTexts.includes("插队A"), "v4 steer enqueue user bubble");
  assert.ok(userTexts.includes("排队一"), "convert v4 injection user bubble");
  assert.ok(userTexts.includes("放行"), "automatic follow-up user bubble");
  assert.equal(userTexts.filter((t) => t === "第一轮").length, 1, "no duplicate bubbles");

  // usage passthrough: real usage (totalTokens=100+n) takes priority over the estimated tokenCount
  // (1.5M+n) — the estimate must never max out 100% (large-session false-100% regression)
  const cu = handle.getContextUsage();
  assert.ok(cu && cu.tokens !== null);
  assert.ok(cu.tokens <= 1000, `context tokens must come from real usage (got ${cu.tokens})`);
  assert.ok(cu.percent !== null && cu.percent < 50, `context percent must not be maxed out by the estimated tokenCount (got ${cu.percent})`);

  // getUsageTotals: real token totals for the stats panel (previously unimplemented → panel stuck at 0/0/0)
  const totals = handle.getUsageTotals();
  assert.ok(totals && totals.turns >= 1, "turns accumulate on every settle");
  assert.ok(totals.inputTokens > 0, "inputTokens should have a real total");
  assert.ok(totals.outputTokens > 0, "outputTokens should have a real total");

  // last activity: should have a recent value after the turn settles (data source for /api/sessions fixing the sidebar placeholder row's modified)
  const act = handle.getLastActivity();
  assert.ok(typeof act === "number" && act > 0, "getLastActivity should report an activity time after a turn");
  assert.ok(Date.now() - act < 30_000, "activity time should be recent (this turn's settle moment)");

  await handle.dispose();
});

test("handle 失步兜底：空闲时 abort 补发 aborted 收口帧（停止按钮悬挂防御）", async () => {
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));
  await handle.abort(); // never prompted — handle idle, exercising the desync fallback path (observed: frontend stuck on "stop" when a turn's settled frame loses a race)
  const settled = events.filter((e) => e.type === "agent_settled");
  assert.equal(settled.length, 1, "exactly one settled frame");
  assert.equal(settled[0].stopReason, "aborted", "fallback frame classified as aborted");
  const endIdx = events.findIndex((e) => e.type === "agent_end");
  assert.ok(endIdx >= 0 && endIdx < events.indexOf(settled[0]), "agent_end precedes settled");
  assert.equal(handle.isRunning(), false);
  await handle.dispose();
});

test("session/recycle API：dispose 存量 handle + 自 fetch 走 core 复活重建", async () => {
  const { mod } = { mod: await import("./index.ts") };
  const api = mod.default.server.api;

  // park an idle session (real ZcodeHandle) in the global handle store — simulates core's existing handle
  const handle = await registered.createSession({ cwd: ROOT });
  const store = new Map([[handle.id, handle]]);
  const prevStore = globalThis.__sessionHandles;
  globalThis.__sessionHandles = store;

  // GET listing
  const listRes = await api(new Request("http://127.0.0.1:3001/api/extensions/aiti-zcode-agent/session/recycle"), { path: ["session", "recycle"], method: "GET", searchParams: new URLSearchParams() });
  const list = await listRes.json();
  assert.ok(list.sessions.some((s) => s.id === handle.id), "listing contains the target session");

  // POST recycle: new- placeholder (no real sid) → dispose only, no recreation fetch
  let fetchCalls = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { fetchCalls.push({ url, init }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
  try {
    const res = await api(new Request("http://127.0.0.1:3001/api/extensions/aiti-zcode-agent/session/recycle", { method: "POST", body: JSON.stringify({ id: handle.id }) }), { path: ["session", "recycle"], method: "POST", searchParams: new URLSearchParams() });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.recycled, true);
    assert.equal(data.recreated, false, "placeholder session is disposed without recreation");
    assert.equal(handle.alive(), false, "old handle disposed");
    assert.equal(fetchCalls.length, 0, "placeholder session sends no recreation request");

    // sess_ real sid: after dispose the session is recreated via its own fetch (payload carries sessionId/cwd)
    const sidHandle = await registered.createSession({ cwd: ROOT, sessionId: "sess_recycle_1" });
    store.set(sidHandle.id, sidHandle);
    const res2 = await api(new Request("http://127.0.0.1:3001/api/extensions/aiti-zcode-agent/session/recycle", { method: "POST", body: JSON.stringify({ id: sidHandle.id }) }), { path: ["session", "recycle"], method: "POST", searchParams: new URLSearchParams() });
    const data2 = await res2.json();
    assert.equal(data2.recycled, true);
    assert.equal(data2.recreated, true, "real-sid session recreated via fetch");
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].url.endsWith("/api/session-backends"), "recreation goes through the core create endpoint");
    const sent = JSON.parse(fetchCalls[0].init.body);
    assert.equal(sent.providerType, "aiti-zcode-agent/zcode");
    assert.equal(sent.sessionId, "sess_recycle_1");
    assert.equal(sent.cwd, ROOT);
    assert.equal(sidHandle.alive(), false, "old handle disposed (new handle created by core)");
    await sidHandle.dispose().catch(() => {});
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.__sessionHandles = prevStore;
  }
  await handle.dispose().catch(() => {});
});

test("handle 队列行为：abort 后 followUp 自动续轮（决策点 R11 行为记录）", async () => {
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));
  const p1 = handle.prompt("长轮");
  await sleep(250);
  await handle.followUp("排队X");
  await handle.abort();
  await p1;
  await sleep(400);
  // abort settle: settled carries aborted
  assert.ok(events.some((e) => e.type === "agent_settled" && e.stopReason === "aborted"), "abort should settle with aborted");
  // record current behavior: does scheduleDrainPending auto-send the queued entry after the abort settle
  const log = await readLog();
  const sends = log.filter((l) => l.method === "session/send").map((l) => l.params.content);
  const settled = events.filter((e) => e.type === "agent_settled").map((e) => e.stopReason);
  console.log("[R11 决策点] abort 后 sends =", JSON.stringify(sends), "| settled =", JSON.stringify(settled));
  // current-behavior assertion (if the final decision differs, change here + scheduleDrainPending)
  assert.ok(sends.includes("排队X"), "current behavior: the queued entry auto-continues after the abort settle (pending product decision)");
  await handle.dispose();
});

test("handle 任务列表：TodoWrite 事件 → task_update 广播 + taskList() 契约出口", async () => {
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));
  await handle.prompt("带任务的一轮");
  await sleep(600); // TodoWrite(60ms) + streaming + completed
  const tus = events.filter((e) => e.type === "task_update");
  assert.equal(tus.length, 1, "exactly one task_update frame (appserver-layer change-detection dedup)");
  assert.deepEqual(tus[0].todos, [
    { content: "任务甲", status: "completed", priority: "high" },
    { content: "任务乙", status: "in_progress", priority: "medium" },
  ]);
  // contract outlet (data source that materializes get_state): mirror holds the same value
  const tl = await handle.taskList();
  assert.deepEqual(tl.todos, [
    { content: "任务甲", status: "completed", priority: "high" },
    { content: "任务乙", status: "in_progress", priority: "medium" },
  ]);
  await handle.dispose();
});

test("handle 任务快照：task_update 落盘 <stateDir>/task-lists + sessionDormantState 休眠服务三态", async () => {
  // the previous test (task_update broadcast) already wrote sess_hq_1's snapshot to <stateDir>/task-lists/
  const dormant = capturedServices["aiti-zcode-agent.sessionDormantState"];
  assert.equal(typeof dormant, "function", "startup provided the dormant fallback service");

  const snap = await dormant("zcode:sess_hq_1");
  assert.ok(snap, "snapshot exists");
  assert.deepEqual(snap.tasks, [
    { content: "任务甲", status: "completed", priority: "high" },
    { content: "任务乙", status: "in_progress", priority: "medium" },
  ]);

  assert.equal(await dormant("zcode:new-1-123"), null, "new-* never persisted → null");
  assert.equal(await dormant("pi:sess_hq_1"), null, "session from another extension → null");
  assert.equal(await dormant("zcode:sess_missing_1"), null, "no snapshot file → null");
});

test("handle 任务快照：冷 handle（复活未 prompt）taskList() 回落持久化快照", async () => {
  const cold = await registered.createSession({ cwd: ROOT, sessionId: "sess_hq_1" });
  assert.equal(cold.isRunning(), false, "never prompted");
  const tl = await cold.taskList();
  assert.deepEqual(tl.todos, [
    { content: "任务甲", status: "completed", priority: "high" },
    { content: "任务乙", status: "in_progress", priority: "medium" },
  ]);
  await cold.dispose();
});

/**
 * aiti-zcode-agent handle 级队列行为测试（queue keeper 适配，方案 §6 验收①）
 * —— 真实 ZcodeHandle + 桩 app-server 子进程，验证 streamingBehavior 分流 /
 *    steer 镜像 / queueManage / 自动续轮。零网络零真凭据。
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
 * 存活句柄登记（防套件卡死）：桩 app-server 是「读到 EOF 才退」的服务端，用例中途断言
 * 失败就跳过尾部 `dispose()` → 残留子进程带着继承的 stdio 管道，本文件的 `node --test`
 * 子进程永不退出，**整轮全量测试原地卡死**（实测：并行负载下卡在 zcode-handle-queue 行）。
 * 故文件尾统一补 dispose（内部会 kill 连接进程）。
 */
const liveHandles = new Set();

// ---- 桩 app-server（同 zcode-appserver.test.mjs 机制；按 sends 计数分化行为）----
// 桩日志路径：必须用 os.tmpdir() 绝对路径——Windows 上 "/tmp/..." 按进程 cwd 盘符解析，
// 桩进程（cwd=会话 cwd）与测试进程可能落在不同盘 → 双方看不同文件（2026-09-08 实测）。
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
      // desktop 同款 steer：sendText{requestedDelivery:"guide"} → accepted + steerQueued，
      // 250ms 后模拟「间隙 drain」发 steerDrained（镜像/气泡出队链路）
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
      // 任务列表用例（按内容门控，不影响其他用例的 sends 计数断言）：TodoWrite scheduled 全量列表
      if (String(msg.params?.content ?? "") === "带任务的一轮") {
        setTimeout(() => write({ method: "session/event", params: { type: "tool.updated", payload: { kind: "scheduled", toolCallId: "tw1", toolName: "TodoWrite", input: { todos: [
          { content: "任务甲", status: "completed", priority: "high" },
          { content: "任务乙", status: "in_progress", priority: "medium" },
        ] } } } }), 60);
      }
      // 每条 send 都流式回复 + 收口（n===1 拉长收口延迟，供运行中断言窗口）
      setTimeout(() => write({ method: "session/event", params: { type: "model.streaming", payload: { kind: "text_delta", assistantMessageId: "m" + n, partId: "p" + n, delta: "回复" + n } } }), n === 1 ? 200 : 60);
      // 回归（2026-09-20 用户实测大会话误显示 100%）：tokenCount 故意给 150 万级（引擎缺
      // baseline 时 chars/4 估算爆炸形态），usage 给真实口径——context 占用必须取 usage。
      setTimeout(() => write({ method: "session/event", params: { type: "turn.completed", payload: { resultType: "success", tokenCount: 1500000 + n, usage: { inputTokens: 90 + n, outputTokens: 10, totalTokens: 100 + n }, duration: 10, cacheStats: { cacheReadTokens: 50 } } } }), n === 1 ? 2000 : 160);
      break;
    }
    default: write({ id: msg.id, result: {} });
  }
});
`;

// ---- 环境 ----
const stubDir = join(ROOT, "stub");
const stubPath = join(stubDir, "appserver-stub.mjs");
const logFile = join(stubDir, "stub-log.jsonl");

test.before(() => {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(stubPath, STUB);
  try { rmSync(LOG); } catch { /* not exist */ }
  // feature 桩：强制 app-server 通道 + 协议桩当 runtime
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
    try { await h.dispose(); } catch { /* 已死 */ }
  }
  liveHandles.clear();
  // Windows：桩进程可能短暂持有 ROOT 下文件句柄 → 重试删除；仍失败警告不红（Linux 直接删）
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

// 所有句柄经此登记，文件尾统一补 dispose（见 liveHandles 注释）
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
    // 服务桩：捕获 startup 期 provide 的服务（sessionDormantState 休眠兜底等）
    services: { provide: (key, impl) => { capturedServices[key] = impl; return () => {}; } },
  });
  return { mod: m, registered, capturedServices };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("handle 队列行为：v4 steer 注入 + followUp 分流 + queueManage + steerDrained 出队 + 自动续轮", async () => {
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));

  // 轮 1：占住 running（stub 收口延迟 450ms，留出运行中断言窗口）
  const p1 = handle.prompt("第一轮");
  await sleep(300);
  assert.equal(handle.isRunning(), true);

  // 运行中 prompt（steer 语义入口）→ v4/command sendText 注入（desktop 同款，不发 session/send）
  await handle.prompt("插队A");
  await sleep(120); // steerQueued 事件到达
  let qus = events.filter((e) => e.type === "queue_update");
  assert.ok(qus.length >= 1, "有 queue_update 广播");
  assert.deepEqual(qus[qus.length - 1].steering, ["插队A"], "steer 入 v4 镜像");
  await sleep(250); // stub 模拟间隙 drain → steerDrained → 出队
  assert.deepEqual(events.filter((e) => e.type === "queue_update").pop().steering, [], "drained 后镜像出队");

  // rev 版本轴（跨仓契约，pi-web 迟到快照守卫的数据源）：至此入镜像/出镜像各一帧，全部
  // 携带正数 rev 且严格单调（steer 路径 routePrompt 本身不广播——emitUpdate 只在镜像变化）
  const revsSoFar = events.filter((e) => e.type === "queue_update").map((e) => e.rev);
  assert.equal(revsSoFar.length, 2, "入镜像/出镜像恰好两帧");
  assert.ok(revsSoFar.every((r) => typeof r === "number" && r > 0), "queue_update 携带正数 rev");
  assert.ok(revsSoFar[1] > revsSoFar[0], "rev 严格单调递增");

  // followUp 入队（本地持有，不发服务端）
  await handle.prompt("排队一", { streamingBehavior: "followUp" });
  await handle.followUp("排队二");
  const qu2 = events.filter((e) => e.type === "queue_update").pop();
  assert.deepEqual(qu2.followUp, ["排队一", "排队二"]);

  // queueManage：list / move / remove
  const l1 = await handle.queueManage({ action: "list" });
  assert.deepEqual(l1.followUp, ["排队一", "排队二"]);
  assert.equal(l1.rev, qu2.rev, "list 快照与最近事件同 rev（间隔无变更）");
  await handle.queueManage({ action: "move", kind: "followUp", from: 1, to: 0 });
  const rm = await handle.queueManage({ action: "remove", kind: "followUp", index: 0 });
  assert.equal(rm.entry.text, "排队二"); // move 后 0 位是"排队二"
  assert.ok(rm.rev > l1.rev, "变更类 RPC 结果 rev 递增");
  const l2 = await handle.queueManage({ action: "list" });
  assert.deepEqual(l2.followUp, ["排队一"]);
  assert.equal(l2.rev, rm.rev, "remove 后快照与 RPC 结果同 rev（事件流同数轴）");

  // steering 组操作 → 人话错误（已交 v4 队列，协议暂无单条撤回）
  await assert.rejects(
    () => handle.queueManage({ action: "remove", kind: "steer", index: 0 }),
    /协议不支持撤回/,
  );

  // session/send 仅 1 条（轮 1 本身）：steer 走 v4，followUp 未漏发
  let log = await readLog();
  assert.equal(log.filter((l) => l.method === "session/send").length, 1, "运行中发送不应走 session/send");
  const v4Calls = log.filter((l) => l.method === "v4/command");
  assert.equal(v4Calls.length, 1, "插队A 应恰好一次 v4 command");
  assert.equal(v4Calls[0].params.type, "sendText");
  assert.equal(v4Calls[0].params.payload.requestedDelivery, "guide");
  assert.equal(v4Calls[0].params.payload.text, "插队A");

  // convert followUp→steer：取出"排队一"立即 v4 注入（send#2 语义），剩余 followUp 为空
  const cv = await handle.queueManage({ action: "convert", kind: "followUp", index: 0, targetKind: "steer" });
  assert.deepEqual(cv.followUp, [], "被转换条目应出队");
  await sleep(120);
  assert.deepEqual(events.filter((e) => e.type === "queue_update").pop().steering, ["排队一"], "convert 条目入镜像");
  await sleep(250);
  log = await readLog();
  const v4Calls2 = log.filter((l) => l.method === "v4/command");
  assert.equal(v4Calls2.length, 2, "convert 应立即产生第二次 v4 注入");
  assert.equal(v4Calls2[1].params.payload.text, "排队一");
  assert.deepEqual(events.filter((e) => e.type === "queue_update").pop().steering, [], "convert 条目 drained 出队");

  // 再排一条，等轮 1 settle → 验证自动续轮
  await handle.followUp("放行");
  await p1; // 轮 1 收口（stub 2000ms completed）
  await sleep(500); // 自动续轮 send#2（"放行"）+ 其 completed

  log = await readLog();
  const sendTexts = log.filter((l) => l.method === "session/send").map((l) => l.params.content);
  assert.deepEqual(sendTexts, ["第一轮", "放行"], "settle 后自动续轮发出本地队列条目");

  // 终态：两组队列全空
  const quFinal = events.filter((e) => e.type === "queue_update").pop();
  assert.deepEqual(quFinal.steering, []);
  assert.deepEqual(quFinal.followUp, []);
  // rev 全程单调 + RPC 快照与事件同轴收口（l2 之后六次变化：convert 出队 / steerQueued
  // 入镜像 / steerDrained 出镜像 / 放行入队 / scheduleDrain 续轮出队 / 续轮 settle 后
  // 再 drain 的「队列空只广播」）
  const allRevs = events.filter((e) => e.type === "queue_update").map((e) => e.rev);
  assert.ok(allRevs.every((r, i) => i === 0 || r > allRevs[i - 1]), "rev 全程严格单调递增");
  assert.equal(quFinal.rev, l2.rev + 6, "终态 rev 与中途快照连续");

  // user 气泡落定（可见性契约）：第一轮（runTurn）/ 插队A、排队一（v4 steer 的 steerQueued）/ 放行（自动续轮 runTurn）
  const userTexts = events
    .filter((e) => e.type === "message_end" && e.message?.role === "user")
    .map((e) => (Array.isArray(e.message.content) ? e.message.content.find((b) => b.type === "text")?.text ?? "" : String(e.message.content ?? "")));
  assert.ok(userTexts.includes("第一轮"), "runTurn user 气泡");
  assert.ok(userTexts.includes("插队A"), "v4 steer 入队 user 气泡");
  assert.ok(userTexts.includes("排队一"), "convert v4 注入 user 气泡");
  assert.ok(userTexts.includes("放行"), "自动续轮 user 气泡");
  assert.equal(userTexts.filter((t) => t === "第一轮").length, 1, "无重复气泡");

  // usage 透传：真实 usage（totalTokens=100+n）优先于估算 tokenCount（150 万+n）——
  // 不得拿估算顶满 100%（大会话误显示 100% 回归）
  const cu = handle.getContextUsage();
  assert.ok(cu && cu.tokens !== null);
  assert.ok(cu.tokens <= 1000, `context tokens 应取真实 usage（实际 ${cu.tokens}）`);
  assert.ok(cu.percent !== null && cu.percent < 50, `context percent 不应被估算 tokenCount 顶满（实际 ${cu.percent}）`);

  // getUsageTotals：Token 统计区真实累计（此前未实现 → 面板恒 0/0/0）
  const totals = handle.getUsageTotals();
  assert.ok(totals && totals.turns >= 1, "每轮收口都累计 turns");
  assert.ok(totals.inputTokens > 0, "inputTokens 应有真实累计");
  assert.ok(totals.outputTokens > 0, "outputTokens 应有真实累计");

  // 最后活动时间：turn 收口后应有近期值（/api/sessions 修正侧栏占位行 modified 的数据源）
  const act = handle.getLastActivity();
  assert.ok(typeof act === "number" && act > 0, "getLastActivity 在 turn 后应有活动时间");
  assert.ok(Date.now() - act < 30_000, "活动时间应为近期（本轮收口时刻）");

  await handle.dispose();
});

test("handle 失步兜底：空闲时 abort 补发 aborted 收口帧（停止按钮悬挂防御）", async () => {
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));
  await handle.abort(); // 从未 prompt——handle 空闲，走失步兜底路径（实测：错误轮 settled 帧竞态丢失时前端卡「停止」）
  const settled = events.filter((e) => e.type === "agent_settled");
  assert.equal(settled.length, 1, "恰好一帧 settled 收口");
  assert.equal(settled[0].stopReason, "aborted", "兜底帧归为 aborted");
  const endIdx = events.findIndex((e) => e.type === "agent_end");
  assert.ok(endIdx >= 0 && endIdx < events.indexOf(settled[0]), "agent_end 先于 settled");
  assert.equal(handle.isRunning(), false);
  await handle.dispose();
});

test("session/recycle API：dispose 存量 handle + 自 fetch 走 core 复活重建", async () => {
  const { mod } = { mod: await import("./index.ts") };
  const api = mod.default.server.api;

  // 空闲会话（真实 ZcodeHandle）挂进全局 handle store——模拟 core 存量 handle
  const handle = await registered.createSession({ cwd: ROOT });
  const store = new Map([[handle.id, handle]]);
  const prevStore = globalThis.__sessionHandles;
  globalThis.__sessionHandles = store;

  // GET 清单
  const listRes = await api(new Request("http://127.0.0.1:3001/api/extensions/aiti-zcode-agent/session/recycle"), { path: ["session", "recycle"], method: "GET", searchParams: new URLSearchParams() });
  const list = await listRes.json();
  assert.ok(list.sessions.some((s) => s.id === handle.id), "清单含目标会话");

  // POST recycle：new- 占位（无真实 sid）→ 仅 dispose，不发起重建 fetch
  let fetchCalls = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { fetchCalls.push({ url, init }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
  try {
    const res = await api(new Request("http://127.0.0.1:3001/api/extensions/aiti-zcode-agent/session/recycle", { method: "POST", body: JSON.stringify({ id: handle.id }) }), { path: ["session", "recycle"], method: "POST", searchParams: new URLSearchParams() });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.recycled, true);
    assert.equal(data.recreated, false, "占位会话仅 dispose 不重建");
    assert.equal(handle.alive(), false, "旧 handle 已 dispose");
    assert.equal(fetchCalls.length, 0, "占位会话不发重建请求");

    // sess_ 真实 sid：dispose 后自 fetch 复活重建（payload 带 sessionId/cwd）
    const sidHandle = await registered.createSession({ cwd: ROOT, sessionId: "sess_recycle_1" });
    store.set(sidHandle.id, sidHandle);
    const res2 = await api(new Request("http://127.0.0.1:3001/api/extensions/aiti-zcode-agent/session/recycle", { method: "POST", body: JSON.stringify({ id: sidHandle.id }) }), { path: ["session", "recycle"], method: "POST", searchParams: new URLSearchParams() });
    const data2 = await res2.json();
    assert.equal(data2.recycled, true);
    assert.equal(data2.recreated, true, "真实 sid 会话自 fetch 重建");
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].url.endsWith("/api/session-backends"), "重建走 core 创建端点");
    const sent = JSON.parse(fetchCalls[0].init.body);
    assert.equal(sent.providerType, "aiti-zcode-agent/zcode");
    assert.equal(sent.sessionId, "sess_recycle_1");
    assert.equal(sent.cwd, ROOT);
    assert.equal(sidHandle.alive(), false, "旧 handle 已 dispose（新 handle 由 core 创建）");
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
  // abort 收口：settled 带 aborted
  assert.ok(events.some((e) => e.type === "agent_settled" && e.stopReason === "aborted"), "abort 应以 aborted 收口");
  // 记录现状：abort 收口后 scheduleDrainPending 是否自动发出排队条目
  const log = await readLog();
  const sends = log.filter((l) => l.method === "session/send").map((l) => l.params.content);
  const settled = events.filter((e) => e.type === "agent_settled").map((e) => e.stopReason);
  console.log("[R11 决策点] abort 后 sends =", JSON.stringify(sends), "| settled =", JSON.stringify(settled));
  // 现状断言（如与最终决策不符，改此处 + scheduleDrainPending）
  assert.ok(sends.includes("排队X"), "现状：abort 收口后排队条目自动续轮（待产品决策）");
  await handle.dispose();
});

test("handle 任务列表：TodoWrite 事件 → task_update 广播 + taskList() 契约出口", async () => {
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));
  await handle.prompt("带任务的一轮");
  await sleep(600); // TodoWrite(60ms) + 流式 + completed
  const tus = events.filter((e) => e.type === "task_update");
  assert.equal(tus.length, 1, "恰好一帧 task_update（appserver 层变化检测去重）");
  assert.deepEqual(tus[0].todos, [
    { content: "任务甲", status: "completed", priority: "high" },
    { content: "任务乙", status: "in_progress", priority: "medium" },
  ]);
  // 契约出口（get_state 真实化数据源）：镜像同值
  const tl = await handle.taskList();
  assert.deepEqual(tl.todos, [
    { content: "任务甲", status: "completed", priority: "high" },
    { content: "任务乙", status: "in_progress", priority: "medium" },
  ]);
  await handle.dispose();
});

test("handle 任务快照：task_update 落盘 <stateDir>/task-lists + sessionDormantState 休眠服务三态", async () => {
  // 前一用例（task_update 广播）已把 sess_hq_1 的快照写入 <stateDir>/task-lists/
  const dormant = capturedServices["aiti-zcode-agent.sessionDormantState"];
  assert.equal(typeof dormant, "function", "startup 已 provide 休眠兜底服务");

  const snap = await dormant("zcode:sess_hq_1");
  assert.ok(snap, "有快照");
  assert.deepEqual(snap.tasks, [
    { content: "任务甲", status: "completed", priority: "high" },
    { content: "任务乙", status: "in_progress", priority: "medium" },
  ]);

  assert.equal(await dormant("zcode:new-1-123"), null, "new-* 未落库 → null");
  assert.equal(await dormant("pi:sess_hq_1"), null, "非本扩展会话 → null");
  assert.equal(await dormant("zcode:sess_missing_1"), null, "无快照文件 → null");
});

test("handle 任务快照：冷 handle（复活未 prompt）taskList() 回落持久化快照", async () => {
  const cold = await registered.createSession({ cwd: ROOT, sessionId: "sess_hq_1" });
  assert.equal(cold.isRunning(), false, "未 prompt");
  const tl = await cold.taskList();
  assert.deepEqual(tl.todos, [
    { content: "任务甲", status: "completed", priority: "high" },
    { content: "任务乙", status: "in_progress", priority: "medium" },
  ]);
  await cold.dispose();
});

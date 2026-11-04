/**
 * aiti-zcode-agent handle 级 fork 行为测试（编辑从此处 / 分支 按钮，2026-09-18）
 * —— 真实 ZcodeHandle + 桩 app-server 子进程：entryId 位置 id → turnIndex 映射、
 *    reset 换绑 / 非 reset 纯 fork / 根重建 / 运行中拒绝。零网络零真凭据。
 *
 * Run: node --test pi-web-ext/aiti-zcode-agent/zcode-handle-fork.test.mjs
 * （桩子进程必须随用例结束回收——dispose 挂 finally，否则 node --test 等子进程 stdio 不退出）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = mkdtempSync(join(tmpdir(), "zcode-handle-fork-"));
process.env.EXT_MODEL_STATE_DIR = join(ROOT, "ext-model-state");

const LOG = join(tmpdir(), "zcode-hf-stub-log.jsonl");
const STUB = `
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const log = ${JSON.stringify(LOG)};
const rl = readline.createInterface({ input: process.stdin });
let nextServerId = 1;
let createCount = 0;
const write = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rec = (o) => { if (log) appendFileSync(log, JSON.stringify(o) + "\\n"); };
let prefsAnswered = false;
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
        createCount += 1;
        write({ id: msg.id, result: { protocol: { name: "ZCode Protocol", version: 1 }, session: { sessionId: "sess_hf_" + createCount, status: "idle" }, projection: { contextWindow: 1000000 } } });
      }, 15);
      break;
    }
    case "session/resume": write({ id: msg.id, result: { record: {} } }); break;
    case "session/subscribe": write({ id: msg.id, result: { eventSeq: 0, events: [], sessionId: msg.params?.sessionId } }); break;
    case "session/stop":
      write({ id: msg.id, result: {} });
      setTimeout(() => write({ method: "session/event", params: { type: "turn.completed", payload: { resultType: "cancelled", tokenCount: 5, duration: 5 } } }), 30);
      break;
    case "session/fork": {
      if (msg.params?.target?.turnIndex === 999) {
        write({ id: msg.id, error: { code: -1, message: "Cannot fork while a prompt is running" } });
        break;
      }
      write({ id: msg.id, result: { forkedSessionId: "sess_forked_9", targetMessageId: "msg_t" + msg.params?.target?.turnIndex } });
      break;
    }
    case "session/send": {
      write({ id: msg.id, result: { accepted: true, sessionId: "sess_hf_1", stateRevision: 1 } });
      setTimeout(() => write({ method: "session/event", params: { type: "turn.completed", payload: { resultType: "success", tokenCount: 10, duration: 5 } } }), 80);
      break;
    }
    default: write({ id: msg.id, result: {} });
  }
});
`;

const stubDir = join(ROOT, "stub");
const stubPath = join(stubDir, "appserver-stub.mjs");
let registered;
const liveHandles = new Set();

test.before(async () => {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(stubPath, STUB);
  try { rmSync(LOG); } catch { /* not exist */ }
  globalThis.__piWebExt = {
    featureValue: (_extId, fid) =>
      fid === "zcode.transport" ? "app-server"
      : fid === "zcode.runtimePath" ? stubPath
      : fid === "zcode.apiKeyOverride" ? "stub.key"
      : fid === "zcode.mode" ? "build"
      : fid === "zcode.model" ? "bigmodel/GLM-5.3"
      : fid === "zcode.autoDownload" ? false
      : "",
  };
  const m = await import("./index.ts");
  await m.default.server.startup({
    configDir: join(ROOT, "ext-data"),
    sessionProviders: { register: (p) => { registered = p; return "k"; } },
  });
  // 句柄登记：桩 app-server 只在 stdin EOF 时退出，用例中途失败会跳过 dispose() →
  // 残留子进程带着继承 stdio 让本文件永不退出，整轮全量套件原地卡死。
  const createSessionOrig = registered.createSession.bind(registered);
  registered.createSession = async (opts) => {
    const h = await createSessionOrig(opts);
    liveHandles.add(h);
    return h;
  };
});

test.after(async () => {
  for (const h of liveHandles) {
    try { await h.dispose(); } catch { /* 已死 */ }
  }
  liveHandles.clear();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* retry 无关紧要 */ }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readLog() {
  await sleep(80);
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** 种子历史：q1 a1 q2 a2 q3（5 条）——编辑 q3 时分支点 = a2（ext-3）→ turnIndex 1 */
function seedTurnHistory(handle) {
  handle.seedHistory([
    { role: "user", text: "q1" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "q2" },
    { role: "assistant", text: "a2" },
    { role: "user", text: "q3" },
  ]);
}

test("capabilities：app-server 通道 fork=true（编辑从此处/分支 按钮数据源）", async () => {
  const handle = await registered.createSession({ cwd: ROOT });
  try {
    assert.equal(handle.capabilities.fork, true);
    assert.equal(handle.capabilities.navigateTree, false);
    assert.equal(registered.maxCapabilities.fork, true);
  } finally {
    await handle.dispose();
  }
});

test("fork reset（编辑从此处）：分支点 ext-3 → turnIndex 1 + handle 换绑子会话", async () => {
  const handle = await registered.createSession({ cwd: ROOT });
  try {
    handle.setKnownSessionId("sess_seed_1"); // All Sessions 复活语义：真实 sid 先于首轮已知
    seedTurnHistory(handle);
    const r = await handle.fork("ext-3", { reset: true });
    assert.equal(r.cancelled, false);
    assert.equal(r.newSessionFile, "zcode:sess_forked_9");
    assert.equal(handle.id, "zcode:sess_forked_9", "handle 换绑到子会话");
    const log = await readLog();
    const forkReq = log.filter((e) => e.method === "session/fork").pop();
    assert.deepEqual(forkReq.params.target, { kind: "turn", turnIndex: 1 }, "user 计数 -1 = 分支轮号");
    assert.equal(forkReq.params.sessionId, "sess_seed_1");
  } finally {
    await handle.dispose();
  }
});

test("fork 非 reset（分支按钮）：handle 不换绑，返回子会话复合 id", async () => {
  const handle = await registered.createSession({ cwd: ROOT });
  try {
    const beforeId = handle.id;
    handle.setKnownSessionId("sess_seed_1"); // 只填 sessId（复活语义），id 不变
    seedTurnHistory(handle);
    const r = await handle.fork("ext-1", { reset: false });
    assert.equal(r.newSessionFile, "zcode:sess_forked_9");
    assert.equal(handle.id, beforeId, "纯 fork 不动当前会话（无 session_backend_ready）");
  } finally {
    await handle.dispose();
  }
});

test("fork 根重建（编辑首条消息）：entryId 空 → 丢通道清历史，下轮全新 create", async () => {
  const handle = await registered.createSession({ cwd: ROOT });
  try {
    await handle.prompt("第一轮");
    assert.ok(handle.id.startsWith("zcode:sess_"), "首轮后已有真实 sid");
    const r = await handle.fork("", { reset: true });
    assert.equal(r.cancelled, false);
    assert.deepEqual(await handle.getMessages(), [], "历史清空");
    await handle.prompt("编辑后的首条消息");
    const log = await readLog();
    assert.equal(log.filter((e) => e.method === "session/create").length, 2, "根重建后走全新 create（非 resume）");
  } finally {
    await handle.dispose();
  }
});

test("fork 分支点解析失败：越界/非位置 id → 显式报错（不静默根重建、不动现状）", async () => {
  const handle = await registered.createSession({ cwd: ROOT });
  try {
    const beforeId = handle.id;
    handle.setKnownSessionId("sess_seed_1");
    seedTurnHistory(handle);
    await assert.rejects(() => handle.fork("ext-99", { reset: true }), /无法解析分支点位置/);
    await assert.rejects(() => handle.fork("pi-entry-xyz", { reset: true }), /无法解析分支点位置/);
    assert.equal(handle.id, beforeId, "失败不换绑");
    assert.equal((await handle.getMessages()).length, 5, "失败不动历史");
  } finally {
    await handle.dispose();
  }
});

test("fork 运行中拒绝：prompt 未收口时 fork 报人话错误", async () => {
  const handle = await registered.createSession({ cwd: ROOT });
  try {
    const p1 = handle.prompt("长轮");
    await sleep(30); // send 已受理，turn.completed 80ms 后才到
    await assert.rejects(() => handle.fork("ext-1", { reset: true }), /运行中不允许分叉/);
    await p1;
  } finally {
    await handle.dispose();
  }
});

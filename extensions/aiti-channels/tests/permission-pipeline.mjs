#!/usr/bin/env node
/**
 * aiti-channels · request_permission 人闸管道测试（进程内全链路，2026-09-09）
 *
 * 链路：fake ACP 客户端（socket）→ 真 AcpConnection/AcpServer（本进程）→ 真 bridge
 *       → fake __piLocalSessionFactory / fake wrapper（模拟 pi 会话）→ 事件回流。
 * 覆盖：反向请求发送/响应路由（selected+optionId / cancelled / 垃圾响应）、
 *       连接断开 pending 全拒、轮末 permissionAsk 清理、respondPermission 回灌
 *       （allow/deny）、无连接跳过、cancel 打断、未知会话报错。
 *
 * 实现方式：tsc 把 lib/*.ts 编译到临时目录（类型错误容忍——lib 里 config/manager
 * 存在既有类型噪音，编译照样出 JS），node 直跑编译产物。
 *
 * 用法：node tests/permission-pipeline.mjs
 * 退出码：0=全绿；非 0=失败。不触碰真实 ~/.pi/web 数据目录（dataDir 重定向 tmp）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(TESTS_DIR, "..", "lib");
const DIST = fs.mkdtempSync(path.join(os.tmpdir(), "aiti-pipeline-dist-"));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aiti-pipeline-data-"));
const CWD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aiti-pipeline-cwd-"));

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

// ---------------------------------------------------------------------------
// ① 编译 lib → DIST
// ---------------------------------------------------------------------------
const TSC = path.join(os.homedir(), "workspace", "pi-web", "node_modules", ".bin", "tsc");
try {
  execFileSync(TSC, [
    "--target", "es2022", "--module", "nodenext", "--moduleResolution", "nodenext",
    // lib 内部互 import 用 .ts 后缀（strip-types/jiti 直解；emit 靠 5.7+ 的 rewrite
    // 相对导入扩展名 → .js，nodenext 运行时才能解析）——tsc 需 ≥5.7（pi-web 锁 6.x）
    "--rewriteRelativeImportExtensions",
    "--outDir", DIST, "--rootDir", LIB_DIR, "--skipLibCheck",
    path.join(LIB_DIR, "acp-server.ts"),
  ], { stdio: ["ignore", "ignore", "pipe"] });
} catch (e) {
  // 既有类型噪音不阻断（noEmitOnError 默认 false，产物已生成）；只看产物在不在
  console.error("[pipeline] tsc 失败：", e.message);
}
for (const f of ["acp-server.js", "acp-bridge.js", "manager.js"]) {
  if (!fs.existsSync(path.join(DIST, f))) {
    console.error(`[pipeline] 编译产物缺失：${f}；DIST 现有：`, fs.existsSync(DIST) ? fs.readdirSync(DIST) : "(目录不存在)", "TSC exists:", fs.existsSync(TSC));
    process.exit(1);
  }
}
fs.writeFileSync(path.join(DIST, "package.json"), JSON.stringify({ type: "module" }));

// 超时可注入（D1 用）；须在 server 模块加载前生效（常量在模块顶层求值）。
// B 组的 IM 回复都在毫秒级，3s 上限安全。
process.env.AITI_ACP_CALL_TIMEOUT_MS = "3000";

const manager = await import(pathToFileURL(path.join(DIST, "manager.js")));
const bridge = await import(pathToFileURL(path.join(DIST, "acp-bridge.js")));
const server = await import(pathToFileURL(path.join(DIST, "acp-server.js")));

manager.setDataDir(DATA_DIR);
const started = await server.startAcpServer("t");
const sockPath = started.socket;

// ---------------------------------------------------------------------------
// ② fake pi 宿主：工厂 + wrapper
// ---------------------------------------------------------------------------
const listeners = new Set();
const wrapperCalls = [];            // { kind, ... }
const factoryCalls = [];            // 每次 start(sessionId, sessionFile, cwd) 记录
const SESSION_FILE = path.join(DATA_DIR, "fake-pi-session.json");
fs.writeFileSync(SESSION_FILE, "{}");
let respondImpl = null;             // 测试随时注入/撤掉 respondPermission 行为
const wrapper = {
  sessionId: "pi-fake-1",
  onEvent(l) { listeners.add(l); return () => listeners.delete(l); },
  async send(command) { wrapperCalls.push({ kind: "send", command }); return {}; },
  isAlive: () => true,
  isRunning: () => false,
  inner: { sessionManager: { getSessionFile: () => SESSION_FILE } },
  respondPermission: async (...args) => {
    wrapperCalls.push({ kind: "respondPermission", args });
    return respondImpl ? respondImpl(...args) : true;
  },
};
let startSeq = 0;
const extraWrappers = []; // 后续会话的独立 wrapper（模拟 pi 每会话独立）
globalThis.__piLocalSessionFactory = {
  start: async (sessionId, sessionFile, cwd) => {
    factoryCalls.push({ sessionId, sessionFile, cwd });
    startSeq++;
    if (startSeq === 1) return { session: wrapper, realSessionId: wrapper.sessionId };
    const wListeners = new Set();
    const wCalls = [];
    const w = {
      sessionId: "pi-fake-" + startSeq,
      onEvent(l) { wListeners.add(l); return () => wListeners.delete(l); },
      async send(command) { wCalls.push({ kind: "send", command }); return {}; },
      isAlive: () => true,
      isRunning: () => false,
      inner: { sessionManager: { getSessionFile: () => SESSION_FILE } },
      respondPermission: async (...args) => { wCalls.push({ kind: "respondPermission", args }); return true; },
    };
    extraWrappers.push({ w, listeners: wListeners, calls: wCalls });
    return { session: w, realSessionId: w.sessionId };
  },
};
const emitToExtra = (idx, ev) => { const e = extraWrappers[idx]; for (const l of [...e.listeners]) l(ev); };
// runtime 感知路由：事件与 send 记录都跟随 ACP_SID 当前持有的 wrapper
// （D3 重挂/后续独立 wrapper 之后，全局 records 不再是唯一事实源）
const runtimeCalls = () => {
  const rt = bridge.getRuntime(ACP_SID);
  const extra = extraWrappers.find((x) => x.w === rt?.wrapper);
  return extra ? extra.calls : wrapperCalls;
};
const emitToWrapper = (ev) => {
  if (typeof ACP_SID !== "undefined" && ACP_SID) {
    const rt = bridge.getRuntime(ACP_SID);
    const extra = extraWrappers.find((x) => x.w === rt?.wrapper);
    if (extra) { for (const l of [...extra.listeners]) l(ev); return; }
  }
  for (const l of [...listeners]) l(ev);
};
/** 对 runtime 当前持有的 wrapper 定向 emit（共享/独立 wrapper 皆可） */
const emitToRuntime = (rt, ev) => {
  const extra = extraWrappers.find((x) => x.w === rt?.wrapper);
  if (extra) { for (const l of [...extra.listeners]) l(ev); return; }
  emitToWrapper(ev);
};
/** 等待某 wrapper 记录到一条 prompt send */
const waitForPromptSendOn = (calls, from, tag, ms = 3000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const t = setInterval(() => {
    const n = calls.filter((c) => c.kind === "send" && c.command?.type === "prompt").length;
    if (n >= from + 1) { clearInterval(t); resolve(); }
    else if (Date.now() - t0 > ms) { clearInterval(t); reject(new Error("timeout: " + tag)); }
  }, 10);
});
const sendsOf = (type) => (typeof ACP_SID !== "undefined" && ACP_SID ? runtimeCalls() : wrapperCalls).filter((c) => c.kind === "send" && c.command?.type === type);

// ---------------------------------------------------------------------------
// ③ fake ACP 客户端
// ---------------------------------------------------------------------------
function connectClient() {
  const waiters = [];        // { try(m): boolean } —— true=该消息归它、已 resolve
  const seen = [];           // 服务端发来的每一条消息（含通知）
  let buf = "", nextId = 1;
  const sock = net.connect(sockPath);
  const settle = (m) => {
    seen.push(m);
    for (let k = waiters.length - 1; k >= 0; k--) {
      if (waiters[k].try(m)) waiters.splice(k, 1);
    }
  };
  sock.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      settle(m);
    }
  });
  const api = {
    sock,
    seen,
    /** 事件驱动等待某条消息（已在 seen 里则立即返回） */
    waitFor(match, tag, ms = 5000) {
      const hit = seen.find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout: " + tag)), ms);
        waiters.push({ try: (m) => { if (match(m)) { clearTimeout(timer); resolve(m); return true; } return false; } });
      });
    },
    rpc(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        sock.once("error", reject);
        waiters.push({ try: (m) => { if (m.method === undefined && String(m.id) === String(id)) { resolve(m); return true; } return false; } });
        sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    /** 等服务端反向请求（session/request_permission），回写响应 result */
    onRequest(match, replyResult) {
      return api.waitFor((m) => m.method && match(m), "server request").then((m) => {
        if (replyResult !== undefined) {
          sock.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: replyResult }) + "\n");
        }
        return m;
      });
    },
    close: () => new Promise((r) => sock.end(() => r())),
  };
  return api;
}

const timeout = (ms, tag) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout: " + tag)), ms));

/** 等待 wrapper 侧出现某次 respondPermission 记录（服务端异步续体，需让一让） */
function waitRespond(requestId, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      const pool = (typeof ACP_SID !== "undefined" && ACP_SID ? runtimeCalls() : wrapperCalls);
      const hit = pool.find((x) => x.kind === "respondPermission" && x.args?.[0] === requestId);
      if (hit) { clearInterval(t); resolve(hit); }
      else if (Date.now() - t0 > ms) { clearInterval(t); reject(new Error("timeout: respondPermission " + requestId)); }
    }, 10);
  });
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
console.log("\n▶ B1 initialize 能力声明");
{
  const c = connectClient();
  const res = await Promise.race([c.rpc("initialize", { protocolVersion: 1 }), timeout(3000, "initialize")]);
  check("protocolVersion=1", res.result?.protocolVersion === 1);
  check("loadSession=true", res.result?.agentCapabilities?.loadSession === true);
  check("未声明 sessionCapabilities.list（ListSessions 走 nil 的依据）",
    !res.result?.agentCapabilities?.sessionCapabilities?.list);
  await c.close();
}

console.log("\n▶ B2 未知会话 prompt → JSON-RPC 错误");
{
  const c = connectClient();
  const res = await Promise.race([
    c.rpc("session/prompt", { sessionId: "no-such", prompt: [{ type: "text", text: "x" }] }),
    timeout(3000, "unknown prompt"),
  ]);
  check("返回 error", !!res.error, JSON.stringify(res));
  await c.close();
}

// 主会话：贯穿 B3–B8
const c = connectClient();
await Promise.race([c.rpc("initialize", {}), timeout(3000, "initialize2")]);
const newRes = await Promise.race([c.rpc("session/new", { cwd: CWD_DIR }), timeout(3000, "session/new")]);
const ACP_SID = newRes.result?.sessionId;
console.log("\n▶ B3 session/new 建桥接会话（fake 工厂）");
check("返回非空 acpSessionId", typeof ACP_SID === "string" && ACP_SID.length > 10, ACP_SID);
check("registry 落盘（重定向 tmp dataDir）", fs.existsSync(path.join(DATA_DIR, "acp", "sessions.json")));
check("wrapper.send 尚无 prompt", sendsOf("prompt").length === 0);

console.log("\n▶ B4 人闸全链路：permission_request → ACP request_permission → IM allow → 回灌 allow");
{
  const promptP = Promise.race([
    c.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: "hi" }] }),
    timeout(8000, "prompt1"),
  ]);
  await Promise.race([new Promise((r) => {
    const t = setInterval(() => { if (sendsOf("prompt").length === 1) { clearInterval(t); r(); } }, 10);
  }), timeout(3000, "wait send")]);
  const reqP = c.onRequest(
    (m) => m.method === "session/request_permission" && m.params?.toolCall?.toolCallId === "perm-1",
    { outcome: { outcome: "selected", optionId: "allow" } },
  );
  emitToWrapper({ type: "permission_request", requestId: "perm-1", toolName: "bash", input: { command: "ls" } });
  const req = await reqP;
  check("toolCall.toolCallId=requestId", req.params?.toolCall?.toolCallId === "perm-1");
  check("toolCall.title=工具名", req.params?.toolCall?.title === "bash");
  check("options 含 allow_once/reject_once（optionId allow/reject）", (() => {
    const o = req.params?.options || [];
    return o.length === 2 && o.some((x) => x.optionId === "allow" && x.kind === "allow_once") && o.some((x) => x.optionId === "reject" && x.kind === "reject_once");
  })(), JSON.stringify(req.params?.options));
  const rp = (await Promise.race([waitRespond("perm-1"), timeout(5000, "respond perm-1")]));
  check("回灌 requestId 正确", rp.args?.[0] === "perm-1");
  check("回灌 behavior=allow", rp.args?.[1]?.behavior === "allow", JSON.stringify(rp.args));
  emitToWrapper({ type: "agent_settled" });
  const done = await promptP;
  check("轮末 stopReason=end_turn", done.result?.stopReason === "end_turn", JSON.stringify(done.result));
}

console.log("\n▶ B5 IM 拒绝（reject 选项）→ 回灌 deny+message");
{
  const promptP = Promise.race([
    c.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: "hi" }] }),
    timeout(8000, "prompt2"),
  ]);
  await Promise.race([new Promise((r) => {
    const t = setInterval(() => { if (sendsOf("prompt").length === 2) { clearInterval(t); r(); } }, 10);
  }), timeout(3000, "wait send2")]);
  const reqP = c.onRequest(
    (m) => m.method === "session/request_permission" && m.params?.toolCall?.toolCallId === "perm-2",
    { outcome: { outcome: "selected", optionId: "reject" } },
  );
  emitToWrapper({ type: "permission_request", requestId: "perm-2", toolName: "write", input: {} });
  await reqP;
  const last = await Promise.race([waitRespond("perm-2"), timeout(5000, "respond perm-2")]);
  check("回灌 behavior=deny", last?.args?.[0] === "perm-2" && last?.args?.[1]?.behavior === "deny", JSON.stringify(last));
  check("deny 带 message", typeof last?.args?.[1]?.message === "string" && last.args[1].message.includes("IM"));
  emitToWrapper({ type: "agent_settled" });
  await promptP;
}

console.log("\n▶ B6 IM 取消（cancelled outcome）→ 按 deny 处理");
{
  const promptP = Promise.race([
    c.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: "hi" }] }),
    timeout(8000, "prompt3"),
  ]);
  await Promise.race([new Promise((r) => {
    const t = setInterval(() => { if (sendsOf("prompt").length === 3) { clearInterval(t); r(); } }, 10);
  }), timeout(3000, "wait send3")]);
  const reqP = c.onRequest(
    (m) => m.method === "session/request_permission" && m.params?.toolCall?.toolCallId === "perm-3",
    { outcome: { outcome: "cancelled" } },
  );
  emitToWrapper({ type: "permission_request", requestId: "perm-3", toolName: "bash", input: {} });
  await reqP;
  const last = await Promise.race([waitRespond("perm-3"), timeout(5000, "respond perm-3")]);
  check("cancelled → behavior=deny", last?.args?.[0] === "perm-3" && last?.args?.[1]?.behavior === "deny", JSON.stringify(last));
  emitToWrapper({ type: "agent_settled" });
  await promptP;
}

console.log("\n▶ B7 连接断开 → pending 反向请求全拒 → 无人批准按 deny 回灌");
{
  const promptP = Promise.race([
    c.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: "hi" }] }),
    timeout(8000, "prompt4"),
  ]);
  await Promise.race([new Promise((r) => {
    const t = setInterval(() => { if (sendsOf("prompt").length === 4) { clearInterval(t); r(); } }, 10);
  }), timeout(3000, "wait send4")]);
  emitToWrapper({ type: "permission_request", requestId: "perm-4", toolName: "bash", input: {} });
  await c.close(); // 不回结果，直接断
  const last = await Promise.race([waitRespond("perm-4"), timeout(5000, "respond perm-4")]);
  check("断连 → deny 回灌（fail-closed）", last?.args?.[1]?.behavior === "deny", JSON.stringify(last));
  // 断连后 emit/权限事件不再有出口，仍要能收轮：直发 settled，观察服务端 runtime.settle 清理
  promptP.catch(() => {}); // client 侧 promise 因断连 reject，属预期
  emitToWrapper({ type: "agent_settled" });
  const settleCleared = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      if (bridge.getRuntime(ACP_SID)?.settle === null) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return bridge.getRuntime(ACP_SID)?.settle === null;
  })();
  check("轮正常收束（emit 断连不影响 settle）", settleCleared);
}

console.log("\n▶ B8 轮末清通道：无 prompt 进行中收到 permission_request → 跳过（不回灌）");
{
  const before = wrapperCalls.filter((x) => x.kind === "respondPermission").length;
  emitToWrapper({ type: "permission_request", requestId: "perm-idle", toolName: "bash", input: {} });
  await new Promise((r) => setTimeout(r, 50));
  const after = wrapperCalls.filter((x) => x.kind === "respondPermission").length;
  check("无 ACP 在看 → 不产生回灌", before === after, `${before} -> ${after}`);
}

console.log("\n▶ B9 导出 bridge.requestPermission：无会话 → null");
{
  const r = await bridge.requestPermission("nonexistent", { toolCallId: "t", title: "x" });
  check("返回 null", r === null);
}

console.log("\n▶ B10 新连接续用同一会话 + session/cancel 通知 → wrapper abort + stopReason=cancelled");
const c2 = connectClient();
{
  await Promise.race([c2.rpc("initialize", {}), timeout(3000, "initialize-c2")]);
  const promptP = Promise.race([
    c2.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: "long" }] }),
    timeout(8000, "prompt5"),
  ]);
  await Promise.race([new Promise((r) => {
    const t = setInterval(() => { if (sendsOf("prompt").length === 5) { clearInterval(t); r(); } }, 10);
  }), timeout(3000, "wait send5")]);
  c2.sock.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: ACP_SID } }) + "\n");
  await Promise.race([new Promise((r) => {
    const t = setInterval(() => { if (sendsOf("abort").length >= 1) { clearInterval(t); r(); } }, 10);
  }), timeout(3000, "wait abort")]);
  check("wrapper 收到 abort", sendsOf("abort").length >= 1);
  emitToWrapper({ type: "agent_settled" });
  const done = await promptP;
  check("stopReason=cancelled", done.result?.stopReason === "cancelled", JSON.stringify(done.result));
}

console.log("\n▶ B11 文本流翻译：delta → agent_message_chunk，message_end 不重发；user 角色过滤");
{
  const promptP = Promise.race([
    c2.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: "talk" }] }),
    timeout(8000, "prompt6"),
  ]);
  await Promise.race([new Promise((r) => {
    const t = setInterval(() => { if (sendsOf("prompt").length === 6) { clearInterval(t); r(); } }, 10);
  }), timeout(3000, "wait send6")]);
  emitToWrapper({ type: "message_update", message: { role: "user" }, delta: "USER-LEAK" });       // 应被过滤
  emitToWrapper({ type: "message_update", message: { role: "assistant" }, delta: "你好" });
  emitToWrapper({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "你好世界" }] } }); // 已流式→不重发
  emitToWrapper({ type: "agent_settled" });
  const done = await promptP;
  check("轮收束", done.result?.stopReason === "end_turn");
  const chunks = c2.seen.filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "agent_message_chunk");
  const texts = chunks.map((m) => m.params?.update?.content?.text || "");
  check("delta 流出 1 条", texts.filter((t) => t === "你好").length === 1, JSON.stringify(texts));
  check("user delta 未泄漏", !texts.includes("USER-LEAK"), JSON.stringify(texts));
  check("message_end 已流式过则不重发整段", !texts.includes("你好世界"), JSON.stringify(texts));
}
c2.sock.destroy();

// ---------------------------------------------------------------------------
// D 组：超时 / 并发 / 进程重启恢复 / 协议容错
// ---------------------------------------------------------------------------
console.log("\n▶ D1 人闸超时（env 注入 3s）→ fail-closed 按 deny 回灌");
{
  const c3 = connectClient();
  await Promise.race([c3.rpc("initialize", {}), timeout(3000, "init-c3")]);
  const before = sendsOf("prompt").length;
  const promptP = Promise.race([c3.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: "t" }] }), timeout(15000, "prompt-d1")]);
  await Promise.race([new Promise((r) => {
    const t = setInterval(() => { if (sendsOf("prompt").length === before + 1) { clearInterval(t); r(); } }, 10);
  }), timeout(3000, "wait send-d1")]);
  emitToWrapper({ type: "permission_request", requestId: "perm-timeout", toolName: "bash", input: {} });
  const t0 = Date.now();
  const last = await Promise.race([waitRespond("perm-timeout", 8000), timeout(9000, "respond perm-timeout")]);
  const waited = Date.now() - t0;
  check("超时（≈3s）后回灌 deny", last?.args?.[1]?.behavior === "deny", JSON.stringify(last));
  check("确实等了超时时长（>2.5s，未提前放弃）", waited > 2500, `${waited}ms`);
  emitToWrapper({ type: "agent_settled" });
  const done = await promptP;
  check("超时拒绝后轮次照常收束", done.result?.stopReason === "end_turn", JSON.stringify(done.result));
  c3.sock.destroy();
}

console.log("\n▶ D2 会话忙并发：进行中再 prompt → session busy 错误");
{
  const c4 = connectClient();
  await Promise.race([c4.rpc("initialize", {}), timeout(3000, "init-c4")]);
  const before = sendsOf("prompt").length;
  const firstP = Promise.race([c4.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: "first" }] }), timeout(15000, "prompt-d2a")]);
  firstP.catch(() => {});
  await Promise.race([new Promise((r) => {
    const t = setInterval(() => { if (sendsOf("prompt").length === before + 1) { clearInterval(t); r(); } }, 10);
  }), timeout(3000, "wait send-d2")]);
  const second = await Promise.race([c4.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: "second" }] }), timeout(3000, "prompt-d2b")]);
  check("第二发被拒（busy）", !!second.error && /busy/.test(second.error.message || ""), JSON.stringify(second));
  emitToWrapper({ type: "agent_settled" });
  await Promise.race([firstP, timeout(5000, "first-done")]);
  c4.sock.destroy();
}

console.log("\n▶ D3 模拟进程重启恢复：清运行时 + 重启 server → session/load 走 registry 重建");
{
  // 模拟进程重启：运行时映射清空（等价新进程内存为空）+ socket server 重建
  globalThis.__aitiChannelsAcpBridge.sessions.clear();
  server.stopAcpServer("t");
  const restarted = await server.startAcpServer("t");
  check("server 重建于同一路径", restarted.socket === sockPath, restarted.socket);
  const factoryCallsBefore = factoryCalls.length;

  const c5 = connectClient();
  await Promise.race([c5.rpc("initialize", {}), timeout(3000, "init-c5")]);
  const loadRes = await Promise.race([c5.rpc("session/load", { sessionId: ACP_SID, cwd: CWD_DIR }), timeout(5000, "session/load-d3")]);
  check("session/load 返回原 acpSessionId", loadRes.result?.sessionId === ACP_SID, JSON.stringify(loadRes));
  const fc = factoryCalls[factoryCalls.length - 1];
  check("工厂按 registry 重建（piSessionId）", factoryCalls.length === factoryCallsBefore + 1 && fc?.sessionId === wrapper.sessionId, JSON.stringify(fc));
  check("工厂按 registry 重建（sessionFile 回写路径）", fc?.sessionFile === SESSION_FILE, JSON.stringify(fc));
  // 重建后轮次照常（sendsOf/emitToWrapper 已 runtime 感知，自动跟随新 wrapper）
  const before = sendsOf("prompt").length;
  const promptP = Promise.race([c5.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: "after-restart" }] }), timeout(15000, "prompt-d3")]);
  await Promise.race([waitForPromptSendOn(runtimeCalls(), before, "wait send-d3"), timeout(4000, "wait send-d3 outer")]);
  emitToWrapper({ type: "agent_settled" });
  const done = await promptP;
  check("重启后轮次正常收束", done.result?.stopReason === "end_turn", JSON.stringify(done.result));
  c5.sock.destroy();
}

console.log("\n▶ D4/D5 协议容错面：set_mode 容错成功；authenticate 不支持（-32601）");
{
  const c6 = connectClient();
  await Promise.race([c6.rpc("initialize", {}), timeout(3000, "init-c6")]);
  const sm = await Promise.race([c6.rpc("session/set_mode", { sessionId: ACP_SID, modeId: "whatever" }), timeout(3000, "set_mode")]);
  check("set_mode 容错回成功", sm.result !== undefined && sm.error === undefined, JSON.stringify(sm));
  const au = await Promise.race([c6.rpc("authenticate", { methodId: "x" }), timeout(3000, "authenticate")]);
  check("authenticate → -32601（声明不支持）", au.error?.code === -32601, JSON.stringify(au));
  c6.sock.destroy();
}

// ---------------------------------------------------------------------------
// G 组：边角补全（双实例 / 未知事件忽略 / 空 prompt / acpStatus / 无回灌能力分支）
// ---------------------------------------------------------------------------
console.log("\n▶ G1 双实例 ACP server 并存（同进程多 socket）");
{
  const s2 = await server.startAcpServer("u2");
  check("第二实例 socket 路径独立", s2.socket !== sockPath && s2.socket.includes("u2.sock"), s2.socket);
  const c7 = connectClient();
  await Promise.race([c7.rpc("initialize", {}), timeout(3000, "init-u2")]);
  const sn7 = await Promise.race([c7.rpc("session/new", { cwd: CWD_DIR }), timeout(3000, "new-u2")]);
  check("第二实例照常建会话", typeof sn7.result?.sessionId === "string" && sn7.result.sessionId.length > 10, JSON.stringify(sn7));
  const st = server.acpStatus("t");
  check("acpStatus 形状（listening/socket/sessions 数组）", st.listening === true && typeof st.socket === "string" && Array.isArray(st.sessions), JSON.stringify({ listening: st.listening, n: st.sessions?.length }));
  const st2 = server.acpStatus("u2");
  check("双实例状态各自可见", st2.listening === true && st2.socket.includes("u2.sock"));
  server.stopAcpServer("u2");
  check("stopAcpServer 收掉第二实例", server.acpStatus("u2").listening === false);
  c7.sock.destroy();
}

console.log("\n▶ G2 未知事件类型（interaction_request）→ 不产生任何 update");
{
  const c8 = connectClient();
  await Promise.race([c8.rpc("initialize", {}), timeout(3000, "init-g2")]);
  const before = sendsOf("prompt").length;
  const promptP = Promise.race([c8.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: "g2" }] }), timeout(15000, "prompt-g2")]);
  await Promise.race([new Promise((r) => {
    const t = setInterval(() => { if (sendsOf("prompt").length === before + 1) { clearInterval(t); r(); } }, 10);
  }), timeout(3000, "wait send-g2")]);
  const seenBefore = c8.seen.length;
  emitToWrapper({ type: "interaction_request", requestId: "ix-1", kind: "ask_user", questions: [] });
  emitToWrapper({ type: "totally_unknown_event", foo: 1 });
  await new Promise((r) => setTimeout(r, 100));
  check("未知事件零外发", c8.seen.length === seenBefore, `${seenBefore} -> ${c8.seen.length}`);
  emitToWrapper({ type: "agent_settled" });
  await promptP;
  c8.sock.destroy();
}

console.log("\n▶ G3 空 prompt → -32602");
{
  const c9 = connectClient();
  await Promise.race([c9.rpc("initialize", {}), timeout(3000, "init-g3")]);
  const r = await Promise.race([c9.rpc("session/prompt", { sessionId: ACP_SID, prompt: [] }), timeout(3000, "empty prompt")]);
  check("空 prompt 被拒", r.error?.code === -32602, JSON.stringify(r));
  c9.sock.destroy();
}

console.log("\n▶ G4 wrapper 无 respondPermission 能力 → 人闸不 crash、决定放弃（log-only）");
{
  const c10 = connectClient();
  await Promise.race([c10.rpc("initialize", {}), timeout(3000, "init-g4")]);
  const before = sendsOf("prompt").length;
  const promptP = Promise.race([c10.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: "g4" }] }), timeout(15000, "prompt-g4")]);
  await Promise.race([new Promise((r) => {
    const t = setInterval(() => { if (sendsOf("prompt").length === before + 1) { clearInterval(t); r(); } }, 10);
  }), timeout(3000, "wait send-g4")]);
  const rpBefore = wrapperCalls.filter((x) => x.kind === "respondPermission").length;
  const saved = wrapper.respondPermission;
  delete wrapper.respondPermission; // 模拟 pi 侧从未长出回灌能力
  const reqP = c10.onRequest(
    (m) => m.method === "session/request_permission" && m.params?.toolCall?.toolCallId === "perm-nocap",
    { outcome: { outcome: "selected", optionId: "allow" } },
  );
  emitToWrapper({ type: "permission_request", requestId: "perm-nocap", toolName: "bash", input: {} });
  await reqP; // 反向请求照发（IM 侧仍会弹卡）
  await new Promise((r) => setTimeout(r, 200));
  const rpAfter = wrapperCalls.filter((x) => x.kind === "respondPermission").length;
  check("IM 决定照常返回", true);
  check("无能力 → 不回灌、不 crash", rpAfter === rpBefore, `${rpBefore} -> ${rpAfter}`);
  wrapper.respondPermission = saved;
  emitToWrapper({ type: "agent_settled" });
  const done = await promptP;
  check("轮次照常收束", done.result?.stopReason === "end_turn", JSON.stringify(done.result));
  c10.sock.destroy();
}

console.log("\n▶ G5 残留死 socket 文件 → startAcpServer 自愈（探测失败即清重来）");
{
  const deadPath = path.join(DATA_DIR, "acp", "dead.sock");
  fs.writeFileSync(deadPath, "not-a-socket"); // 模拟 kill -9 后残留的死 socket 文件
  const rec = await server.startAcpServer("dead");
  check("死文件被清、server 正常监听", rec.ok === true && rec.socket === deadPath, JSON.stringify(rec));
  const c11 = connectClient();
  // connectClient 固定连主 socket——这里直接对 dead socket 裸连验证
  const ok = await new Promise((resolve) => {
    const sk = net.connect(deadPath, () => { sk.destroy(); resolve(true); });
    sk.on("error", () => resolve(false));
    setTimeout(() => { sk.destroy(); resolve(false); }, 2000);
  });
  check("新 socket 可连通", ok);
  server.stopAcpServer("dead");
}

// ---------------------------------------------------------------------------
// H 组：五轮扩充（server 幂等 / stopAll / ensureAll / cwd 负路径 / 死 wrapper 重挂 / cancel 无操作 / 跨轮复位）
// ---------------------------------------------------------------------------
console.log("\n▶ H1 startAcpServer 幂等：运行中再启 → already；stopAll 全收");
{
  const again = await server.startAcpServer("t");
  check("运行中重启 → ok+already", again.ok === true && again.already === true, JSON.stringify(again));
  server.stopAllAcpServers();
  check("stopAll 后主实例停", server.acpStatus("t").listening === false);
  const rec = await server.startAcpServer("t");
  check("可重建（后续用例依赖）", rec.ok === true && !rec.already, JSON.stringify(rec));
}

console.log("\n▶ H2 ensureAll 容错：含不存在实例 id 也不 throw");
{
  let threw = false;
  try { await server.ensureAll(["t", "ghost-instance"]); } catch { threw = true; }
  check("ensureAll 不抛（失败仅记日志）", threw === false);
  check("存在的实例照常在监听", server.acpStatus("t").listening === true);
}

console.log("\n▶ H3 createSession cwd 不存在 → 明确报错");
{
  let msg = "";
  try { await bridge.createSession("/nonexistent/cwd/xyz"); } catch (e) { msg = e.message || ""; }
  check("throw 且含 cwd 信息", msg.includes("/nonexistent/cwd/xyz"), msg);
}

console.log("\n▶ H4 runtime 在但 wrapper 已死 → prompt 自动重挂（工厂再被调）");
{
  // 会话还在 map 里，但 wrapper 假死（等价 pi-web 侧会话被回收）
  const rt = bridge.getRuntime(ACP_SID);
  const savedAlive = rt.wrapper.isAlive;
  rt.wrapper.isAlive = () => false;
  const factoryCallsBefore = factoryCalls.length;
  const c12 = connectClient();
  await Promise.race([c12.rpc("initialize", {}), timeout(3000, "init-h4")]);
  const promptP = Promise.race([c12.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: "h4" }] }), timeout(15000, "prompt-h4")]);
  // 重挂会换新 wrapper（calls 从 0 计），等「任意一次 prompt send」即可
  await Promise.race([waitForPromptSendOn(runtimeCalls(), 0, "wait send-h4"), timeout(4000, "wait send-h4 outer")]);
  check("工厂被重调（reattach）", factoryCalls.length === factoryCallsBefore + 1);
  check("原 acpSessionId 仍解析到活会话", bridge.getRuntime(ACP_SID)?.info?.acpSessionId === ACP_SID);
  rt.wrapper.isAlive = savedAlive;
  emitToWrapper({ type: "agent_settled" });
  await promptP;
  c12.sock.destroy();
}

console.log("\n▶ H5 无进行中轮次 cancel → 无操作不炸；prompt 纯字符串形状兼容");
{
  await bridge.cancel(ACP_SID); // settle 为 null → 直接 return
  check("空闲 cancel 无操作", true);
  const c13 = connectClient();
  await Promise.race([c13.rpc("initialize", {}), timeout(3000, "init-h5")]);
  const before = sendsOf("prompt").length;
  const promptP = Promise.race([c13.rpc("session/prompt", { sessionId: ACP_SID, prompt: "plain string prompt" }), timeout(15000, "prompt-h5")]);
  await Promise.race([new Promise((r) => {
    const t = setInterval(() => { if (sendsOf("prompt").length === before + 1) { clearInterval(t); r(); } }, 10);
  }), timeout(3000, "wait send-h5")]);
  const sent = runtimeCalls().filter((x) => x.kind === "send" && x.command?.type === "prompt").pop();
  check("纯字符串 prompt 被接受", typeof sent?.command?.message === "string" && sent.command.message === "plain string prompt", JSON.stringify(sent?.command));
  emitToWrapper({ type: "agent_settled" });
  const done = await promptP;
  check("轮次收束", done.result?.stopReason === "end_turn");
  c13.sock.destroy();
}

console.log("\n▶ H6 跨轮 emittedText 复位：上轮流式过，下轮无 delta 仅 message_end → fallback 必须生效");
{
  const c14 = connectClient();
  await Promise.race([c14.rpc("initialize", {}), timeout(3000, "init-h6")]);
  // 第一轮：流式（emittedText=true）
  const p1 = Promise.race([c14.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: "t1" }] }), timeout(15000, "p1")]);
  let before = sendsOf("prompt").length;
  await Promise.race([new Promise((r) => {
    const t = setInterval(() => { if (sendsOf("prompt").length === before + 1) { clearInterval(t); r(); } }, 10);
  }), timeout(3000, "w1")]);
  emitToWrapper({ type: "message_update", message: { role: "assistant" }, delta: "R1" });
  emitToWrapper({ type: "agent_settled" });
  await p1;
  // 第二轮：不流式，仅 message_end（若复位失效则本轮回不来文本）
  const p2 = Promise.race([c14.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: "t2" }] }), timeout(15000, "p2")]);
  before = sendsOf("prompt").length;
  await Promise.race([new Promise((r) => {
    const t = setInterval(() => { if (sendsOf("prompt").length === before + 1) { clearInterval(t); r(); } }, 10);
  }), timeout(3000, "w2")]);
  emitToWrapper({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "R2-full" }] } });
  emitToWrapper({ type: "agent_settled" });
  await p2;
  const chunks = c14.seen.filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "agent_message_chunk").map((m) => m.params?.update?.content?.text);
  check("第一轮 delta 流出", chunks.includes("R1"), JSON.stringify(chunks));
  check("第二轮 fallback 生效（复位正确）", chunks.includes("R2-full"), JSON.stringify(chunks));
  c14.sock.destroy();
}

console.log("\n▶ K2 并发双会话隔离：双客户端各自会话并行 prompt，文本互不串流");
{
  const ca = connectClient(), cb = connectClient();
  await Promise.race([ca.rpc("initialize", {}), timeout(3000, "init-ka")]);
  await Promise.race([cb.rpc("initialize", {}), timeout(3000, "init-kb")]);
  const sa = (await Promise.race([ca.rpc("session/new", { cwd: CWD_DIR }), timeout(3000, "new-ka")])).result.sessionId;
  const sb = (await Promise.race([cb.rpc("session/new", { cwd: CWD_DIR }), timeout(3000, "new-kb")])).result.sessionId;
  check("两个会话 id 独立", sa !== sb && sa.length > 10 && sb.length > 10);
  const idxA = extraWrappers.length - 2, idxB = extraWrappers.length - 1;
  const pa = Promise.race([ca.rpc("session/prompt", { sessionId: sa, prompt: [{ type: "text", text: "a" }] }), timeout(15000, "pa")]);
  const pb = Promise.race([cb.rpc("session/prompt", { sessionId: sb, prompt: [{ type: "text", text: "b" }] }), timeout(15000, "pb")]);
  await Promise.race([new Promise((r) => {
    const t = setInterval(() => {
      const n = extraWrappers.reduce((acc, w) => acc + w.calls.filter((c) => c.kind === "send" && c.command?.type === "prompt").length, 0);
      if (n >= 2) { clearInterval(t); r(); }
    }, 10);
  }), timeout(3000, "wait both sends")]);
  emitToExtra(idxA, { type: "message_update", message: { role: "assistant" }, delta: "AAA" });
  emitToExtra(idxB, { type: "message_update", message: { role: "assistant" }, delta: "BBB" });
  emitToExtra(idxA, { type: "agent_settled" });
  emitToExtra(idxB, { type: "agent_settled" });
  const [da, db] = await Promise.all([pa, pb]);
  check("会话 A 轮收束", da.result?.stopReason === "end_turn", JSON.stringify(da.result));
  check("会话 B 轮收束", db.result?.stopReason === "end_turn", JSON.stringify(db.result));
  const textsOf = (c) => c.seen.filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "agent_message_chunk").map((m) => m.params?.update?.content?.text);
  const ta = textsOf(ca), tb = textsOf(cb);
  check("A 只收到 AAA", ta.includes("AAA") && !ta.includes("BBB"), JSON.stringify(ta));
  check("B 只收到 BBB", tb.includes("BBB") && !tb.includes("AAA"), JSON.stringify(tb));
  ca.sock.destroy(); cb.sock.destroy();
}

// ---------------------------------------------------------------------------
// L 组：协议健壮性（垃圾输入 / 大载荷分块重组 / unicode 换行 / id 类型容错）
// ---------------------------------------------------------------------------
console.log("\n▶ L1 垃圾输入不致命：非 JSON 行被忽略，连接继续可用");
{
  const cg = connectClient();
  await Promise.race([cg.rpc("initialize", {}), timeout(3000, "init-lg")]);
  cg.sock.write("this is not json at all\n");
  cg.sock.write("{}\n");
  cg.sock.write("[][]\n");
  await new Promise((r) => setTimeout(r, 200));
  const r = await Promise.race([cg.rpc("session/set_mode", { sessionId: ACP_SID, modeId: "x" }), timeout(3000, "set_mode after garbage")]);
  check("垃圾行后被忽略，后续 RPC 正常", r.result !== undefined && r.error === undefined, JSON.stringify(r));
  cg.sock.destroy();
}

console.log("\n▶ L2 大载荷（200KB 单行跨 TCP 分块）→ 桥完整送达 wrapper");
{
  const c15 = connectClient();
  await Promise.race([c15.rpc("initialize", {}), timeout(3000, "init-l2")]);
  const big = "X".repeat(200 * 1024);
  const before = sendsOf("prompt").length;
  const promptP = Promise.race([c15.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: big }] }), timeout(20000, "prompt-l2")]);
  await Promise.race([waitForPromptSendOn(runtimeCalls(), before, "wait send-l2"), timeout(8000, "wait send-l2 outer")]);
  const sent = runtimeCalls().filter((x) => x.kind === "send" && x.command?.type === "prompt").pop();
  check("200KB 文本完整送达（无截断）", sent?.command?.message === big, `len=${sent?.command?.message?.length}`);
  // 反向：大 delta 分块流出
  const bigBack = "Y".repeat(150 * 1024);
  emitToWrapper({ type: "message_update", message: { role: "assistant" }, delta: bigBack });
  emitToWrapper({ type: "agent_settled" });
  await promptP;
  const chunks = c15.seen.filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "agent_message_chunk");
  const got = chunks.map((m) => m.params?.update?.content?.text || "").join("");
  check("150KB delta 完整回流（分块重组正确）", got === bigBack, `len=${got.length}`);
  c15.sock.destroy();
}

console.log("\n▶ L3 unicode 与换行：prompt 原文无损送达");
{
  const c16 = connectClient();
  await Promise.race([c16.rpc("initialize", {}), timeout(3000, "init-l3")]);
  const tricky = "中文🎉emoji\n第二行\ttab\\反斜杠";
  const before = sendsOf("prompt").length;
  const promptP = Promise.race([c16.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: tricky }] }), timeout(15000, "prompt-l3")]);
  await Promise.race([waitForPromptSendOn(runtimeCalls(), before, "wait send-l3"), timeout(4000, "wait send-l3 outer")]);
  const sent = runtimeCalls().filter((x) => x.kind === "send" && x.command?.type === "prompt").pop();
  check("unicode/换行/tab/反斜杠 原文无损", sent?.command?.message === tricky, JSON.stringify(sent?.command?.message));
  emitToWrapper({ type: "agent_settled" });
  await promptP;
  c16.sock.destroy();
}

console.log("\n▶ L4 字符串 id 容错：客户端以字符串 id 回复反向请求 → 路由正常");
{
  const c17 = connectClient();
  await Promise.race([c17.rpc("initialize", {}), timeout(3000, "init-l4")]);
  const before = sendsOf("prompt").length;
  const promptP = Promise.race([c17.rpc("session/prompt", { sessionId: ACP_SID, prompt: [{ type: "text", text: "l4" }] }), timeout(15000, "prompt-l4")]);
  await Promise.race([new Promise((r) => {
    const t = setInterval(() => { if (sendsOf("prompt").length === before + 1) { clearInterval(t); r(); } }, 10);
  }), timeout(3000, "wait send-l4")]);
  // 触发人闸，再以「字符串」形式回 id（服务端 resolvePending 的 Number() 归一化路径）
  emitToWrapper({ type: "permission_request", requestId: "perm-strid", toolName: "bash", input: {} });
  const req = await c17.waitFor((m) => m.method === "session/request_permission" && m.params?.toolCall?.toolCallId === "perm-strid", "strid request");
  c17.sock.write(JSON.stringify({ jsonrpc: "2.0", id: String(req.id), result: { outcome: { outcome: "selected", optionId: "allow" } } }) + "\n");
  const rp = await Promise.race([waitRespond("perm-strid", 5000), timeout(6000, "respond perm-strid")]);
  check("字符串 id 响应正确路由并回灌 allow", rp.args?.[1]?.behavior === "allow", JSON.stringify(rp.args));
  emitToWrapper({ type: "agent_settled" });
  const done = await promptP;
  check("轮次收束", done.result?.stopReason === "end_turn");
  c17.sock.destroy();
}

console.log(`\n══ 结果：${passed} 通过 / ${failed} 失败`);
console.log(`[pipeline] 临时目录：DIST=${DIST} DATA=${DATA_DIR}`);
process.exit(failed ? 1 : 0);

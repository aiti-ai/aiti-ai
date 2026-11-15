/**
 * aiti-devtools-opencode · 桥/插件全链路 E2E（环境依赖设计，同 packages/aiti-bridge tests/shim-e2e 约定）
 *
 * 环境依赖（缺任一 → 全部 skip，视为环境未就绪而非代码问题）：
 *   1. 独立桥        http://127.0.0.1:8777/aiti（systemctl start aiti-bridge）
 *   2. opencode serve http://127.0.0.1:19870（systemctl start opencode，插件已部署加载）
 *
 * 覆盖（2026-11-13 手动 E2E 的自动化固化）：
 *   T1 桥 tools/list 暴露全部 aiti_* 工具（插件动态注册的数据源）
 *   T2 建会话 → 首条消息 → 桥 agent 注册（opencode/<sid>，cwd 正确）
 *   T3 桥推送 → SSE → session.prompt 注入 → 模型回显 nonce → agent_answer 落桥消息流
 *   T4 占位符改写：POST picked → [元素N] → LLM 输入展开完整 describe → aiti_consumed → 桥 picked 清空
 *   T5 交互卡：user_confirm → AI 窗 SSE interaction → POST /bridge/result → 模型收到作答
 *
 * 默认用 opencode 免费模型跑（零成本零账号）；AITI_OC_E2E_MODEL 覆盖。
 * 运行：node --test opencode-ext/aiti-devtools-opencode/test/e2e-bridge.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

const BRIDGE = (process.env.AITI_BRIDGE_URL || "http://127.0.0.1:8777").replace(/\/+$/, "") + "/aiti";
const OC = (process.env.AITI_OC_SERVE_URL || "http://127.0.0.1:19870").replace(/\/+$/, "");
const [E_PROVIDER, E_MODEL] = (process.env.AITI_OC_E2E_MODEL || "opencode/glm-5.3-flash-free").split("/");
const MODEL = { providerID: E_PROVIDER, modelID: E_MODEL };
const TURN_TIMEOUT = Number(process.env.AITI_OC_E2E_TURN_MS || 90_000); // 单轮模型超时

async function jfetch(url, opts = {}, timeoutMs = 10_000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

async function bridgeAlive() {
  try {
    const r = await jfetch(BRIDGE + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    return r.ok && !!r.body?.result?.tools;
  } catch { return false; }
}
async function ocAlive() {
  try {
    const r = await fetch(OC + "/global/health", { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}

const bridgeUp = await bridgeAlive();
const ocUp = bridgeUp ? await ocAlive() : false;
const skipNote = bridgeUp ? (ocUp ? null : "opencode serve 不可达: " + OC) : "独立桥不可达: " + BRIDGE;

// Cold-start warm-up: the first POST /session makes opencode fetch its models.dev
// catalog, which on a slow network exceeds the 10s jfetch budget and kills the
// first three tests at exactly 10s (T5/T6 run later and ride the warm cache).
// Warm it with a long-timeout throwaway call; result is irrelevant.
if (ocUp) {
  try {
    await fetch(OC + "/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(60_000) });
  } catch { /* catalog prefetch failed → tests will report the real error */ }
}

// ---- 共享助手 ----
async function createSession() {
  const r = await jfetch(OC + "/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.ok(r.ok, "建会话失败: " + r.status);
  const sid = r.body?.id;
  assert.match(String(sid), /^ses_/);
  return sid;
}

/** 发消息并等本轮结束（POST /message 同步返回最终 assistant 消息） */
async function ask(sid, text) {
  const res = await fetch(OC + `/session/${sid}/message`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, parts: [{ type: "text", text }] }),
    signal: AbortSignal.timeout(TURN_TIMEOUT),
  });
  if (!res.ok) throw new Error("message POST " + res.status + ": " + (await res.text()).slice(0, 200));
  const d = await res.json();
  return { info: d.info || {}, text: (d.parts || []).filter((p) => p.type === "text").map((p) => p.text || "").join("\n") };
}

async function listMessages(sid) {
  const r = await jfetch(OC + `/session/${sid}/message`);
  return Array.isArray(r.body) ? r.body : [];
}

async function lastAssistantText(sid) {
  const msgs = await listMessages(sid);
  const last = [...msgs].reverse().find((m) => m.info?.role === "assistant");
  return (last?.parts || []).filter((p) => p.type === "text").map((p) => p.text || "").join("\n");
}

/** 轮询等待（桥推送注入等异步落点） */
async function waitFor(fn, ms = 60_000, stepMs = 2000) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error("waitFor 超时(" + ms + "ms)" + (lastErr ? ": " + lastErr.message : ""));
}

/** 模拟 AI 窗：claim + SSE（role=ai），收集下行事件 */
async function openAiWindow() {
  const claim = await jfetch(BRIDGE + "/bridge/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageKey: "e2e-" + Date.now(), hostUrl: "http://localhost/e2e-test" }) });
  assert.ok(claim.ok && claim.body?.instanceId, "claim 失败: " + JSON.stringify(claim.body));
  const qs = `instanceId=${encodeURIComponent(claim.body.instanceId)}&secret=${encodeURIComponent(claim.body.secret || "")}&role=ai&url=${encodeURIComponent("http://localhost/e2e-test")}`;
  const ctrl = new AbortController();
  const events = [];
  const ready = (async () => {
    try {
      const res = await fetch(BRIDGE + "/bridge/sse?" + qs, { signal: ctrl.signal, headers: { accept: "text/event-stream" } });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (line) { try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* 忽略坏帧 */ } }
        }
      }
    } catch { /* abort/断连：正常收尾 */ }
  })();
  await new Promise((r) => setTimeout(r, 800)); // 等 SSE 注册（ready 帧或连接建立）
  return { claim: claim.body, events, close: () => ctrl.abort(), done: ready };
}

// ---- T1 桥工具清单 ----
test("T1 桥 tools/list 暴露全部 aiti_* 工具", (skipNote ? { skip: skipNote } : {}), async () => {
  const r = await jfetch(BRIDGE + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.ok(r.ok, "tools/list HTTP " + r.status);
  const tools = r.body?.result?.tools || [];
  assert.ok(tools.length >= 16, "工具数 " + tools.length + " < 16（桥端工具缩水？）");
  for (const name of ["bridge_status", "page_exec", "user_confirm", "aiti_inbox", "aiti_pair_send"]) {
    assert.ok(tools.some((t) => t.name === name), "缺少核心工具: " + name);
  }
});

// ---- T2/T3/T4/T5 共用一个会话（串行执行，node --test 单文件默认串行；后三个按需惰性建会话）----
let SID = null;
async function registerSession() {
  SID = await createSession();
  const a = await ask(SID, "你是桥 E2E 测试 agent。请只回复两个词：READY E2E");
  assert.ok(/READY/i.test(a.text), "首轮回复异常: " + a.text.slice(0, 100));
  // 桥 agents 列表出现 opencode/<SID>（chat.message 钩子注册）
  const reg = await waitFor(async () => {
    const r = await jfetch(BRIDGE + "/bridge/agents");
    const rows = Array.isArray(r.body) ? r.body : r.body?.agents || r.body?.sessions || [];
    return rows.find((x) => x.agentKey === "opencode/" + SID) || null;
  }, 30_000);
  assert.equal(reg.agentId, "opencode");
  assert.ok(typeof reg.cwd === "string" && reg.cwd.length > 0, "cwd 缺失");
  return SID;
}
async function ensureSession() {
  if (SID) return SID;
  return registerSession();
}

test("T2 建会话 → 首条消息 → 桥 agent 注册", (skipNote ? { skip: skipNote } : {}), async () => {
  await registerSession();
});

test("T3 桥推送 → 注入 → 模型回显 nonce → agent_answer 落桥", (skipNote ? { skip: skipNote } : {}), async () => {
  const sid = await ensureSession();
  const nonce = "E2E-PUSH-" + Math.random().toString(36).slice(2, 10);
  const before = (await listMessages(sid)).length;
  const push = await jfetch(BRIDGE + "/bridge/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "opencode/" + sid, text: `推送测试：请原样回复这个口令：${nonce}` }) });
  assert.ok(push.ok, "push 失败: " + JSON.stringify(push.body));
  const delivered = push.body?.delivered || [];
  assert.ok(delivered.some((d) => d.agentKey === "opencode/" + sid && /delivered/.test(String(d.status))), "未投递到目标会话: " + JSON.stringify(delivered));
  // 注入产生新一轮 user + assistant（模型回显 nonce）
  await waitFor(async () => {
    const msgs = await listMessages(sid);
    if (msgs.length <= before) return false;
    const text = await lastAssistantText(sid);
    return text.includes(nonce) ? text : false;
  }, TURN_TIMEOUT);
  // agent_answer 落桥消息流
  await waitFor(async () => {
    const r = await jfetch(BRIDGE + "/bridge/messages?agentId=" + encodeURIComponent("opencode/" + sid) + "&limit=50");
    const rows = r.body?.messages || [];
    return rows.some((m) => m.kind === "agent_answer" && String(m.text || "").includes(nonce)) || false;
  }, 30_000);
});

test("T4 占位符改写：[元素N] → 完整 describe → aiti_consumed 清候选", (skipNote ? { skip: skipNote } : {}), async () => {
  const sid = await ensureSession();
  const marker = "E2E-DESC-" + Math.random().toString(36).slice(2, 10);
  const describe = `<button id="e2e-btn">${marker}</button> — E2E 测试按钮`;
  // 塞候选（同款 payload：{tag,describe,pageId}）
  const set = await jfetch(BRIDGE + "/bridge/picked", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidates: [{ tag: "元素1", describe, pageId: "e2e-page/1" }] }) });
  assert.ok(set.ok, "POST picked 失败");
  const a = await ask(sid, "请原样复述你在这条消息里看到的元素描述全文（尖括号内的 HTML 原样保留），不要解释：[元素1]");
  assert.ok(a.text.includes(marker), "模型未看到展开后的 describe（占位符未改写？）回复: " + a.text.slice(0, 200));
  // aiti_consumed → 桥侧同步清 picked
  await waitFor(async () => {
    const r = await jfetch(BRIDGE + "/bridge/picked");
    return (r.body?.candidates || []).length === 0;
  }, 15_000);
});

test("T5 交互卡：user_confirm → SSE interaction → postResult → 模型收到作答", (skipNote ? { skip: skipNote } : {}), async () => {  const sid = await ensureSession();
  const win = await openAiWindow();
  try {
    const question = "E2E确认-" + Math.random().toString(36).slice(2, 8);
    // 发起不 await（本轮阻塞在用户作答上）
    const turn = ask(sid, `请调用 aiti_user_confirm 工具问我："${question} 是否继续？"。工具返回后，必须在回复里原样报告返回值中的 approved 是 true 还是 false，以及 comment 字段的原文内容。`).catch((e) => ({ error: e }));
    // AI 窗 SSE 收到 interaction 卡
    const ev = await waitFor(() => {
      const hit = win.events.find((e) => e.type === "interaction" && String(e.interaction?.prompt || "").includes(question));
      return hit || false;
    }, 60_000);
    assert.equal(ev.interaction.kind, "confirm");
    assert.ok(ev.requestId, "interaction 缺 requestId");
    // 模拟用户点击 ✅（同 web UI postResult 端点）
    const rs = await jfetch(BRIDGE + "/bridge/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: win.claim.instanceId, secret: win.claim.secret, requestId: ev.requestId, ok: true, result: { status: "answered", approved: true, comment: "E2E模拟点击" } }) });
    assert.ok(rs.ok, "POST result 失败: " + JSON.stringify(rs.body));
    // 本轮结束：模型复述用户作答
    const done = await waitFor(async () => {
      const r = await turn;
      return r && !r.error && r.text ? r : false;
    }, TURN_TIMEOUT);
    assert.ok(/approved[\"'：:\s]*true|同意.*E2E模拟点击|E2E模拟点击/i.test(done.text), "模型未收到作答: " + done.text.slice(0, 200));
  } finally {
    win.close();
    await win.done.catch(() => {});
  }
});

test("T6 中止回桥：session.error(MessageAbortedError) → ⏹ 落桥消息流", (skipNote ? { skip: skipNote } : {}), async () => {
  const sid = await ensureSession();
  // 发起长任务（不 await）→ 中途 abort
  const long = fetch(OC + `/session/${sid}/message`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, parts: [{ type: "text", text: "Use bash to run exactly: sleep 45 — then report done. Do not skip the sleep." }] }),
    signal: AbortSignal.timeout(120_000),
  }).catch(() => null);
  await new Promise((r) => setTimeout(r, 6000)); // 等模型开跑 sleep
  const ab = await jfetch(OC + `/session/${sid}/abort`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.ok(ab.ok, "abort 失败: " + ab.status);
  await long; // 等 abort 后的收尾
  // session.error(MessageAbortedError) → 插件应回 ⏹ 文本落桥
  await waitFor(async () => {
    const r = await jfetch(BRIDGE + "/bridge/messages?agentId=" + encodeURIComponent("opencode/" + sid) + "&limit=20");
    const rows = r.body?.messages || [];
    return rows.some((m) => m.kind === "agent_answer" && /中止|abort/i.test(String(m.text || ""))) || false;
  }, 30_000);
});

// ---- 清理（best-effort）----
test("Z 清理测试会话", (skipNote ? { skip: skipNote } : {}), async () => {
  if (!SID) return;
  await fetch(OC + "/session/" + SID, { method: "DELETE", signal: AbortSignal.timeout(5000) }).catch(() => {});
  // 桥 agent 记录由 60s sweep 离线回收，无需显式清理
});

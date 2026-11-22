#!/usr/bin/env node
/**
 * test-outbound.mjs —— 结果送达桩测试（零依赖：node --test tools/test-outbound.mjs）
 *
 * 覆盖（集成方案 docs/aiti-ai-schedule-integration-plan.md §4.2-4.5）：
 *   - sendOnMatch：缺省/ all / ok / error 过滤（skipped/missed 由 engine 拦截，不经此函数）
 *   - buildMessage：成功/失败文案、正文 3000 字符截断
 *   - parseTomlManagement + resolveCcConfig：cc.json > toml 探测 > 默认 三级优先
 *   - makeOutbound：stub fetch（不真连 cc/mail）——cc/mail 调用形态、错误降级为备注、onNote 回调
 *   - store.patchRun：RunRecord 就地补记送达备注（不新增记录行）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sendOnMatch, buildMessage, parseTomlManagement, resolveCcConfig, makeOutbound } from "../sched/outbound.ts";
import { Store } from "../sched/store.ts";
import { Engine } from "../sched/engine.ts";

// ───────────────────────── sendOnMatch ─────────────────────────

test("sendOnMatch：缺省与 all 都发；ok 仅成功；error 仅失败", () => {
  assert.equal(sendOnMatch(undefined, "ok"), true);
  assert.equal(sendOnMatch(undefined, "error"), true);
  assert.equal(sendOnMatch("all", "ok"), true);
  assert.equal(sendOnMatch("all", "error"), true);
  assert.equal(sendOnMatch("ok", "ok"), true);
  assert.equal(sendOnMatch("ok", "error"), false);
  assert.equal(sendOnMatch("error", "ok"), false);
  assert.equal(sendOnMatch("error", "error"), true);
});

// ───────────────────────── buildMessage ─────────────────────────

test("buildMessage：成功文案（标题/状态行/摘要/落款）", () => {
  const { title, body } = buildMessage({ name: "每日日报" }, { status: "ok", text: "日报已写入 daily.md", at: "2026-09-08T01:00:00.000Z", ms: 1234 });
  assert.equal(title, "[✅ 成功] 定时任务 · 每日日报");
  assert.ok(body.includes("状态 ok · 耗时 1234ms · 2026-09-08T01:00:00.000Z"));
  assert.ok(body.includes("日报已写入 daily.md"));
  assert.ok(body.endsWith("—— pi-web ⏰调度"));
});

test("buildMessage：失败文案用 error 做摘要", () => {
  const { title, body } = buildMessage({ name: "备份" }, { status: "error", error: "agent/new 失败 HTTP 500", at: "2026-09-08T01:00:00.000Z", ms: 50 });
  assert.equal(title, "[❌ 失败] 定时任务 · 备份");
  assert.ok(body.includes("状态 error"));
  assert.ok(body.includes("agent/new 失败 HTTP 500"));
});

test("buildMessage：正文超 3000 字符截断", () => {
  const { body } = buildMessage({ name: "x" }, { status: "ok", text: "啊".repeat(5000), at: "2026-09-08T01:00:00.000Z", ms: 1 });
  const summary = body.split("\n")[1];
  assert.equal(summary.length, 3000);
});

// ───────────────────────── cc-connect 配置解析 ─────────────────────────

test("parseTomlManagement：只取 [management] 的 port/token，忽略其他节与注释", () => {
  const toml = [
    "# 注释",
    "[bridge]",
    "port = 1111",
    'token = "wrong"',
    "",
    "[management]",
    "enabled = true",
    "port = 9820",
    'token = "abc" # 行内注释不剥（值带 # 会被整取，可容忍）',
    "[other]",
    "port = 2222",
  ].join("\n");
  assert.deepEqual(parseTomlManagement(toml), { port: 9820, token: "abc" });
});

test("parseTomlManagement：缺 token / 缺节 → 空对象", () => {
  assert.deepEqual(parseTomlManagement("[management]\nport = 1234\n"), { port: 1234 });
  assert.deepEqual(parseTomlManagement("port = 1234\n"), {});
  assert.deepEqual(parseTomlManagement(""), {});
});

test("resolveCcConfig：cc.json 优先 > toml 探测 > 默认 9820", () => {
  const dir = mkdtempSync(join(tmpdir(), "sched-outbound-"));
  const oldHome = process.env.HOME;
  try {
    // 3) 默认（无 cc.json、HOME 指 toml 不存在的临时目录）
    process.env.HOME = dir;
    assert.deepEqual(resolveCcConfig(dir), { baseUrl: "http://127.0.0.1:9820" });
    // 2) 自动探测 ~/.config/cc-connect.toml
    mkdirSync(join(dir, ".config"), { recursive: true });
    writeFileSync(join(dir, ".config", "cc-connect.toml"), "[management]\nport = 9820\ntoken = \"toml-token\"\n");
    assert.deepEqual(resolveCcConfig(dir), { baseUrl: "http://127.0.0.1:9820", token: "toml-token" });
    // 1) configDir/cc.json 手工覆盖
    writeFileSync(join(dir, "cc.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:19999/", token: "cc-token" }));
    const cfg = resolveCcConfig(dir);
    assert.equal(cfg.baseUrl, "http://127.0.0.1:19999"); // 尾斜杠剥掉
    assert.equal(cfg.token, "cc-token");
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────── makeOutbound（stub fetch，不真连） ─────────────────────────

/** 安装 fetch 桩：记录调用，按 URL 前缀返回可编程应答。返回 {calls, restore}。 */
function stubFetch(handlers) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (u.startsWith(prefix)) return handler(u, init);
    }
    return new Response(JSON.stringify({ ok: false, error: "unexpected " + u }), { status: 404 });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function waitTick(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

/** mail 同源自调基址（与 sched/outbound.ts apiBase() 同一套 env 语义，供桩匹配 URL）。 */
function mailBase() {
  return (process.env.AITI_AI_SCHEDULE_API_ORIGIN || "http://127.0.0.1:" + (process.env.PORT || "3000")) + (process.env.PI_WEB_BASE_PATH || "");
}

test("makeOutbound：cc+mail 都发，URL/body/source 形态正确，onNote 记 ok", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sched-outbound-"));
  writeFileSync(join(dir, "cc.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:19999", token: "tok" }));
  const notes = [];
  const outbound = makeOutbound(dir, { onNote: (runId, note) => notes.push({ runId, note }) });
  const plan = {
    id: "p_test1", name: "送达计划", cc: { project: "myproj", sessionKey: "dingtalk:cid:usr" }, mailTo: "a@x.com, b@y.com",
  };
  const stub = stubFetch({
    "http://127.0.0.1:19999": () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    [mailBase() + "/api/extensions/aiti-mail/send"]: () => new Response(JSON.stringify({ ok: true, results: [{ to: "a@x.com", status: "ok" }, { to: "b@y.com", status: "ok" }] }), { status: 200 }),
  });
  try {
    outbound(plan, { status: "ok", text: "任务结果正文", at: "2026-09-08T01:00:00.000Z", ms: 42, runId: "r_x1" });
    await waitTick();
    // cc 调用形态
    const ccCall = stub.calls.find((c) => c.url.includes("/api/v1/projects/myproj/send"));
    assert.ok(ccCall, "未调用 cc-connect send");
    const ccBody = JSON.parse(ccCall.init.body);
    assert.equal(ccBody.session_key, "dingtalk:cid:usr");
    assert.match(ccBody.message, /^\[✅ 成功\] 定时任务 · 送达计划\n/);
    assert.ok(ccCall.init.headers.authorization === "Bearer tok");
    // mail 调用形态（多邮箱原样传，aiti-mail 侧拆分）
    const mailCall = stub.calls.find((c) => c.url.includes("/api/extensions/aiti-mail/send"));
    assert.ok(mailCall, "未调用 aiti-mail send");
    const mailBody = JSON.parse(mailCall.init.body);
    assert.equal(mailBody.to, "a@x.com, b@y.com");
    assert.equal(mailBody.subject, "[✅ 成功] 定时任务 · 送达计划");
    assert.equal(mailBody.source, "aiti-ai-schedule:p_test1");
    assert.ok(mailCall.init.body.length < 40 * 1024, "邮件 30s 超时约束下不应有异常大 body");
    // 备注
    assert.deepEqual(notes, [{ runId: "r_x1", note: { ccSent: "ok", mailSent: "ok" } }]);
  } finally { stub.restore(); rmSync(dir, { recursive: true, force: true }); }
});

test("makeOutbound：cc 失败降级为 ccSent=error:… 备注，不影响 mail；不 throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sched-outbound-"));
  const notes = [];
  const outbound = makeOutbound(dir, { onNote: (runId, note) => notes.push({ runId, note }) });
  const plan = { id: "p_test2", name: "失败降级", cc: { project: "p", sessionKey: "k" }, mailTo: "a@x.com" };
  const stub = stubFetch({
    "http://127.0.0.1:9820": () => new Response(JSON.stringify({ error: "denied" }), { status: 403 }),
    [mailBase() + "/api/extensions/aiti-mail/send"]: () => new Response(JSON.stringify({ ok: true, results: [{ to: "a@x.com", status: "ok" }] }), { status: 200 }),
  });
  try {
    outbound(plan, { status: "error", error: "任务失败原因", at: "2026-09-08T01:00:00.000Z", ms: 5, runId: "r_x2" });
    await waitTick();
    assert.equal(notes.length, 1);
    assert.match(notes[0].runId, /r_x2/);
    assert.match(notes[0].note.ccSent, /^error: cc-connect HTTP 403/);
    assert.equal(notes[0].note.mailSent, "ok");
  } finally { stub.restore(); rmSync(dir, { recursive: true, force: true }); }
});

test("makeOutbound：sendOn=ok 时 error 结果不出站（回调内部不发）", async () => {
  // 过滤本体在 engine.notifyOutbound（sendOnMatch 已单测）——这里验证组合语义：
  // 若回调被调（说明 engine 判定该发），makeOutbound 一定执行发送，不做二次过滤。
  const dir = mkdtempSync(join(tmpdir(), "sched-outbound-"));
  const stub = stubFetch({});
  try {
    let fired = 0;
    const outbound = makeOutbound(dir, { onNote: () => {} });
    const plan = { id: "p_test3", name: "no channels" }; // 无 cc/mailTo → 空转零出站
    outbound(plan, { status: "error", error: "x", at: "2026-09-08T01:00:00.000Z", ms: 0, runId: "r_x3" });
    await waitTick();
    fired += 1;
    assert.equal(stub.calls.length, 0, "无送达配置不应有任何出站请求");
    assert.equal(fired, 1);
  } finally { stub.restore(); rmSync(dir, { recursive: true, force: true }); }
});

test("makeOutbound：mail 多收件人部分失败 → mailSent=error 且带首错", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sched-outbound-"));
  const notes = [];
  const outbound = makeOutbound(dir, { onNote: (runId, note) => notes.push(note) });
  const plan = { id: "p_test4", name: "部分失败", mailTo: "a@x.com, b@x.com" };
  const stub = stubFetch({
    [mailBase() + "/api/extensions/aiti-mail/send"]: () => new Response(JSON.stringify({
      ok: false, error: "1/2 个收件人发送失败",
      results: [{ to: "a@x.com", status: "ok" }, { to: "b@x.com", status: "error", error: "AUTH 失败" }],
    }), { status: 200 }),
  });
  try {
    outbound(plan, { status: "ok", text: "t", at: "2026-09-08T01:00:00.000Z", ms: 1, runId: "r_x4" });
    await waitTick();
    assert.equal(notes.length, 1);
    assert.match(notes[0].mailSent, /^error: aiti-mail 1\/2 个收件人发送失败 · b@x\.com: AUTH 失败/);
  } finally { stub.restore(); rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────── engine → outbound 接线（invokeAI 桩，零网络） ─────────────────────────

test("engine.execute：invokeAI 计划完成后触发 outbound；sendOn=error 的成功不触发；RunRecord 落盘", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sched-engine-ob-"));
  const g = globalThis;
  const origInvoke = g.__aitiAiScheduleInvokeAI;
  g.__aitiAiScheduleInvokeAI = async () => ({ text: "invoked-ok", model: null });
  const seen = [];
  try {
    const engine = new Engine(dir, { emit() { } }, (plan, r) => seen.push({ planId: plan.id, r }));
    const mk = (id, sendOn) => ({
      id, name: "E2E-" + id, schedule: "+1h", prompt: "x", mode: "invokeAI",
      enabled: true, autoApprove: true, notify: false, sendOn,
    });
    const p1 = mk("p_e1", "all");
    const p2 = mk("p_e2", "error"); // sendOn=error：本次成功不应发
    engine.store.plans.push(p1, p2);
    engine.upsertPlanEntry(p1, false);
    engine.upsertPlanEntry(p2, false);
    engine.runNow("plan:p_e1");
    engine.runNow("plan:p_e2");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(seen.length, 1, "sendOn=error 的成功结果不应触发 outbound");
    assert.equal(seen[0].planId, "p_e1");
    assert.equal(seen[0].r.status, "ok");
    assert.equal(seen[0].r.text, "invoked-ok");
    assert.ok(seen[0].r.runId, "runId 必传（RunRecord 补记依据）");
    // RunRecord 落盘 + 补记链路闭环
    const run = engine.store.recentRuns(10).find((x) => x.id === seen[0].r.runId);
    assert.ok(run, "outbound runId 对应的 RunRecord 存在");
    assert.equal(engine.store.patchRun(run.id, { ccSent: "ok" }), true);
    assert.equal(engine.store.recentRuns(10).find((x) => x.id === run.id).ccSent, "ok");
    engine.stop();
  } finally {
    if (origInvoke === undefined) delete g.__aitiAiScheduleInvokeAI; else g.__aitiAiScheduleInvokeAI = origInvoke;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────── store.patchRun ─────────────────────────

test("store.patchRun：就地补记 ccSent/mailSent，不新增记录行", () => {
  const dir = mkdtempSync(join(tmpdir(), "sched-patchrun-"));
  try {
    const store = new Store(dir);
    store.appendRun({ id: "r_a", targetId: "plan:p1", kind: "ai", name: "n", at: "2026-09-08T01:00:00.000Z", status: "ok", ms: 10 });
    store.appendRun({ id: "r_b", targetId: "plan:p1", kind: "ai", name: "n", at: "2026-09-08T01:01:00.000Z", status: "error", ms: 20, error: "e" });
    assert.equal(store.patchRun("r_a", { ccSent: "ok", mailSent: "ok" }), true);
    assert.equal(store.patchRun("r_missing", { ccSent: "ok" }), false);
    const runs = store.recentRuns(10); // 倒序
    assert.equal(runs.length, 2, "补记不得新增记录行");
    const a = runs.find((r) => r.id === "r_a");
    assert.equal(a.ccSent, "ok");
    assert.equal(a.mailSent, "ok");
    assert.equal(a.status, "ok");
    const b = runs.find((r) => r.id === "r_b");
    assert.equal(b.ccSent, undefined, "未补记的行不受影响");
    // 落盘校验（新实例重读）
    const store2 = new Store(dir);
    assert.equal(store2.recentRuns(10).find((r) => r.id === "r_a").mailSent, "ok");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

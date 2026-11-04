/**
 * omp-handle.test — aiti-omp-agent 专一后端测试。
 * 拆分自旧 pi-rpc-spawn.test.mjs 的 omp 侧用例（ready 握手 / branch / get_messages /
 * contextUsage·dumpTools / extension_ui / login / host tools / CLI 解析）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { OmpSpawnHandle, createHandleForTest, OMP_SPEC, normalizeOmpMessages } from "./omp-handle.ts";
import { capabilitiesFor } from "./fork-rpc/spec.ts";
import { resolveForkCli } from "./fork-rpc/cli-resolve.ts";

function fakeChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes = [];
  const stdin = new PassThrough();
  stdin.on("data", (c) => writes.push(Buffer.from(c).toString("utf8")));
  const listeners = new Map();
  return {
    stdout,
    stderr,
    stdin,
    writes,
    frames: () => writes.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    exitCode: null,
    kill: () => true,
    once: (ev, fn) => {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
      return this;
    },
    emit: (ev, ...args) => {
      for (const fn of listeners.get(ev) ?? []) fn(...args);
    },
    _listeners: listeners,
  };
}

function feed(handle, obj) {
  handle.child.stdout.write(JSON.stringify(obj) + "\n");
}

function feedResponse(handle, id, data) {
  feed(handle, { id, type: "response", command: "?", success: true, data });
}

async function later(ms = 20) {
  await new Promise((r) => setTimeout(r, ms));
}

// ---- ready 握手 --------------------------------------------------------------------

test("omp spec：ready 帧放行 whenReady，且握手帧不外发为事件", async () => {
  const child = fakeChild();
  const h = createHandleForTest(OMP_SPEC, "t2", child);
  const events = [];
  h.subscribe((e) => events.push(e));
  let ready = false;
  h.whenReady.then(() => (ready = true));
  feed(h, { type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 });
  await later();
  assert.ok(ready, "ready 帧应放行 whenReady");
  assert.equal(events.filter((e) => e.type === "ready").length, 0, "ready 帧不应外发");
});

// ---- 命令差异映射 ------------------------------------------------------------------

test("fork 命令映射：omp 发 branch", async () => {
  const child = fakeChild();
  const h = createHandleForTest(OMP_SPEC, "t4", child);
  const p = h.fork("entry-1");
  await later();
  assert.equal(child.frames()[0].type, "branch");
  feedResponse(h, "r1", { text: "sel", cancelled: false });
  assert.deepEqual(await p, { cancelled: false });
});

test("getMessages：omp 走 get_messages 并包装为 pi entry", async () => {
  const com = fakeChild();
  const hom = createHandleForTest(OMP_SPEC, "t6", com);
  const pom = hom.getMessages();
  await later();
  assert.equal(com.frames()[0].type, "get_messages");
  feedResponse(hom, "r1", { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "yo" }] }] });
  const msgs = await pom;
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0], { id: "omp-m0", type: "message", message: { role: "user", content: "hi" } });
  assert.equal(msgs[1].id, "omp-m1");
});

test("getCommands：omp 发 get_available_commands 并归一化 aliases/细节", async () => {
  const child = fakeChild();
  const h = createHandleForTest(OMP_SPEC, "t7", child);
  const p = h.getCommands();
  await later();
  assert.equal(child.frames()[0].type, "get_available_commands");
  feedResponse(h, "r1", {
    commands: [
      { name: "compact", description: "压缩", aliases: ["c"], source: "builtin", subcommands: [] },
      { name: "review" },
    ],
  });
  const cmds = await p;
  assert.deepEqual(cmds[0], { name: "compact", description: "压缩", source: "builtin" });
  assert.deepEqual(cmds[1], { name: "review", source: "unknown" });
});

// ---- 能力面（omp 补齐 contextUsage / listTools）-----------------------------------

test("capabilitiesFor（omp）：contextUsage/listTools true；respondInteraction 已声明", () => {
  const omp = capabilitiesFor(OMP_SPEC);
  assert.equal(omp.contextUsage, true);
  assert.equal(omp.listTools, true);
  assert.equal(omp.setActiveTools, false);
  assert.equal(omp.navigateTree, false);
  assert.equal(omp.deleteSession, false);
  assert.equal(omp.respondInteraction, true);
});

test("omp getAllTools/getContextUsage：get_state 预热后同步可读", async () => {
  const child = fakeChild();
  const h = createHandleForTest(OMP_SPEC, "t9", child);
  assert.equal(h.getContextUsage(), undefined, "未预热返回 undefined");
  const p = h.getAllTools();
  await later();
  assert.equal(child.frames()[0].type, "get_state");
  feedResponse(h, "r1", {
    sessionId: "omp-sid-1",
    dumpTools: [{ name: "read", description: "读文件", parameters: {} }, { name: "bash" }],
    contextUsage: { tokens: 1000, contextWindow: 100000, percent: 1 },
  });
  assert.deepEqual(await p, [{ name: "read", description: "读文件" }, { name: "bash", description: "" }]);
  // 事件预热路径：agent_end 触发 refreshStateUsage（第二次 get_state）
  feed(h, { type: "agent_end" });
  await later();
  feedResponse(h, "r2", { sessionId: "omp-sid-1", contextUsage: { tokens: 2000, contextWindow: 100000, percent: 2 } });
  await later();
  assert.deepEqual(h.getContextUsage(), { percent: 2, contextWindow: 100000, tokens: 2000 });
  assert.equal(h.rpcSessionId, "omp-sid-1");
});

// ---- 消息归一化（纯函数） ----------------------------------------------------------

test("normalizeOmpMessages：索引合成 entry id，透传 message 原样", () => {
  const out = normalizeOmpMessages([{ role: "user", content: "a" }]);
  assert.deepEqual(out, [{ id: "omp-m0", type: "message", message: { role: "user", content: "a" } }]);
  assert.deepEqual(normalizeOmpMessages(undefined), []);
});

// ---- extension_ui ⇄ interaction_request --------------------------------------------

test("select 请求 → ask_user 事件（含 optionDetails description）→ respond 回 value 帧", async () => {
  const child = fakeChild();
  const h = createHandleForTest(OMP_SPEC, "t11", child);
  const events = [];
  h.subscribe((e) => events.push(e));
  feed(h, {
    type: "extension_ui_request",
    id: "ui-1",
    method: "select",
    title: "选择模型",
    options: ["glm-4", "deepseek"],
    optionDetails: [{}, { description: "便宜" }],
  });
  await later();
  const ev = events.find((e) => e.type === "interaction_request");
  assert.equal(ev.kind, "ask_user");
  assert.equal(ev.questions[0].options[1].description, "便宜");
  const ok = await h.respondInteraction("ui-1", { action: "accept", answers: { "选择模型": "deepseek" } });
  assert.ok(ok);
  assert.deepEqual(child.frames().pop(), { type: "extension_ui_response", id: "ui-1", value: "deepseek" });
  const expired = events.find((e) => e.type === "interaction_expired");
  assert.ok(expired);
  assert.equal(expired.requestId, "ui-1");
  assert.equal(expired.reason, "resolved");
  // 二次响应同一 requestId → false（已消费）
  assert.equal(await h.respondInteraction("ui-1", { action: "accept", answers: {} }), false);
});

test("confirm：accept→confirmed true，选取消→confirmed false，decline→cancelled", async () => {
  const child = fakeChild();
  const h = createHandleForTest(OMP_SPEC, "t12", child);
  feed(h, { type: "extension_ui_request", id: "ui-2", method: "confirm", title: "删除?", message: "不可撤销" });
  await later();
  await h.respondInteraction("ui-2", { action: "accept" });
  assert.deepEqual(child.frames().pop(), { type: "extension_ui_response", id: "ui-2", confirmed: true });

  feed(h, { type: "extension_ui_request", id: "ui-3", method: "confirm", title: "删除?", message: "不可撤销" });
  await later();
  await h.respondInteraction("ui-3", { action: "accept", answers: { "删除?\n不可撤销": "取消" } });
  assert.deepEqual(child.frames().pop(), { type: "extension_ui_response", id: "ui-3", confirmed: false });

  feed(h, { type: "extension_ui_request", id: "ui-4", method: "confirm", title: "t", message: "m" });
  await later();
  await h.respondInteraction("ui-4", { action: "decline", message: "不要" });
  assert.deepEqual(child.frames().pop(), { type: "extension_ui_response", id: "ui-4", cancelled: true });
});

test("input：accept 带 answers 文本 → value 帧", async () => {
  const child = fakeChild();
  const h = createHandleForTest(OMP_SPEC, "t13", child);
  feed(h, { type: "extension_ui_request", id: "ui-5", method: "input", title: "会话名", placeholder: "x" });
  await later();
  await h.respondInteraction("ui-5", { action: "accept", answers: { "会话名": "my session" } });
  assert.deepEqual(child.frames().pop(), { type: "extension_ui_response", id: "ui-5", value: "my session" });
});

test("open_url（omp login）→ open_url 专用事件，单向 respond 返回 false", async () => {
  const child = fakeChild();
  const h = createHandleForTest(OMP_SPEC, "t14", child);
  const events = [];
  h.subscribe((e) => events.push(e));
  feed(h, { type: "extension_ui_request", id: "ui-6", method: "open_url", url: "https://x", launchUrl: "http://127.0.0.1:1/l" });
  await later();
  const ev = events.find((e) => e.type === "interaction_request");
  assert.equal(ev.kind, "open_url");
  assert.equal(ev.toolName, "extension_ui.open_url");
  assert.equal(ev.url, "https://x");
  assert.equal(ev.launchUrl, "http://127.0.0.1:1/l");
  assert.equal(ev.input.url, "https://x");
  assert.equal(await h.respondInteraction("ui-6", { action: "accept" }), false);
  assert.ok(!events.some((e) => e.type === "interaction_expired"));
});

test("notify/setWidget 等其余单向方法 → 不透传交互卡（无需用户作答）", async () => {
  const child = fakeChild();
  const h = createHandleForTest(OMP_SPEC, "t15", child);
  const events = [];
  h.subscribe((e) => events.push(e));
  feed(h, { type: "extension_ui_request", id: "ui-7", method: "notify", message: "hello" });
  await later();
  feed(h, { type: "extension_ui_request", id: "ui-9", method: "setWidget", widgetKey: "autoresearch" });
  await later();
  assert.ok(!events.some((e) => e.type === "interaction_request"));
  assert.equal(await h.respondInteraction("ui-7", { action: "accept" }), false);
  assert.ok(!events.some((e) => e.type === "interaction_expired"));
});

// ---- omp login 触发面（/login 斜杠命令） ------------------------------------------

test("/login 单候选 → 直发 login RPC + 合成通知 turn", async () => {
  const child = fakeChild();
  const h = createHandleForTest(OMP_SPEC, "t16", child);
  const events = [];
  h.subscribe((e) => events.push(e));
  const p = h.prompt("/login");
  await later();
  const req = child.frames().find((f) => f.type === "get_login_providers");
  assert.ok(req);
  feedResponse(h, req.id, {
    providers: [{ id: "zai-coding-plan", name: "Z.ai Coding Plan", available: true, authenticated: false }],
  });
  await later();
  await p;
  const login = child.frames().filter((f) => f.type === "login").pop();
  assert.equal(login.providerId, "zai-coding-plan");
  assert.ok(events.some((e) => e.type === "agent_start"));
  assert.ok(events.some((e) => e.type === "message_end" && e.message?.content?.[0]?.text?.includes("已发起")));
  assert.ok(events.some((e) => e.type === "agent_settled" && e.stopReason === "end_turn"));
});

test("/login 多候选 → 合成 select 卡 → 作答映射回 providerId 发 login", async () => {
  const child = fakeChild();
  const h = createHandleForTest(OMP_SPEC, "t17", child);
  const events = [];
  h.subscribe((e) => events.push(e));
  const p = h.prompt("/login");
  await later();
  const req = child.frames().find((f) => f.type === "get_login_providers");
  feedResponse(h, req.id, {
    providers: [
      { id: "anthropic", name: "Anthropic", authenticated: false },
      { id: "openrouter", name: "OpenRouter", authenticated: false },
      { id: "zai-coding-plan", name: "Z.ai", authenticated: true },
    ],
  });
  await later();
  await p;
  const sel = events.find((e) => e.type === "interaction_request");
  assert.equal(sel.kind, "ask_user");
  assert.equal(sel.questions[0].options.length, 2); // 已认证的 Z.ai 不在候选
  const q = sel.questions[0].question;
  const ok = await h.respondInteraction(sel.requestId, { action: "accept", answers: { [q]: "OpenRouter（openrouter）" } });
  assert.ok(ok);
  await later();
  const login = child.frames().filter((f) => f.type === "login").pop();
  assert.equal(login.providerId, "openrouter");
  assert.ok(events.some((e) => e.type === "interaction_expired" && e.requestId === sel.requestId));
});

test("/login 多候选 decline → 不发 login；全部已认证 → 仅通知", async () => {
  const child = fakeChild();
  const h = createHandleForTest(OMP_SPEC, "t18", child);
  const events = [];
  h.subscribe((e) => events.push(e));
  const p = h.prompt("/login");
  await later();
  feedResponse(h, child.frames().find((f) => f.type === "get_login_providers").id, {
    providers: [
      { id: "anthropic", name: "Anthropic", authenticated: false },
      { id: "openrouter", name: "OpenRouter", authenticated: false },
    ],
  });
  await later();
  await p;
  const sel = events.find((e) => e.type === "interaction_request");
  await h.respondInteraction(sel.requestId, { action: "decline" });
  await later();
  assert.ok(!child.frames().some((f) => f.type === "login"));

  const child2 = fakeChild();
  const h2 = createHandleForTest(OMP_SPEC, "t19", child2);
  const events2 = [];
  h2.subscribe((e) => events2.push(e));
  const p2 = h2.prompt("/login");
  await later();
  feedResponse(h2, child2.frames().find((f) => f.type === "get_login_providers").id, {
    providers: [{ id: "anthropic", name: "Anthropic", authenticated: true }],
  });
  await later();
  await p2;
  assert.ok(!child2.frames().some((f) => f.type === "login"));
  assert.ok(events2.some((e) => e.type === "message_end" && e.message?.content?.[0]?.text?.includes("均已登录")));
  assert.ok(!events2.some((e) => e.type === "interaction_request"));
});

test("/login 候选超过 8 → 通知引导直发（不出 select 卡）", async () => {
  const child = fakeChild();
  const h = createHandleForTest(OMP_SPEC, "t22", child);
  const events = [];
  h.subscribe((e) => events.push(e));
  const p = h.prompt("/login");
  await later();
  feedResponse(h, child.frames().find((f) => f.type === "get_login_providers").id, {
    providers: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, authenticated: false })),
  });
  await later();
  await p;
  assert.ok(!events.some((e) => e.type === "interaction_request"));
  assert.ok(!child.frames().some((f) => f.type === "login"));
  const notice = events.find((e) => e.type === "message_end");
  assert.ok(notice.message.content[0].text.includes("12 个 OAuth provider"));
  assert.ok(notice.message.content[0].text.includes("/login <providerId>"));
});

test("/login <未知 provider> → 通知带可用清单", async () => {
  const child = fakeChild();
  const h = createHandleForTest(OMP_SPEC, "t20", child);
  const events = [];
  h.subscribe((e) => events.push(e));
  const p = h.prompt("/login nosuch");
  await later();
  feedResponse(h, child.frames().find((f) => f.type === "get_login_providers").id, {
    providers: [{ id: "anthropic", name: "Anthropic", authenticated: false }],
  });
  await later();
  await p;
  assert.ok(!child.frames().some((f) => f.type === "login"));
  assert.ok(events.some((e) => e.type === "message_end" && e.message?.content?.[0]?.text?.includes("Anthropic（anthropic）")));
});

// ---- CLI 解析 ----------------------------------------------------------------------

test("resolveForkCli：OMP_CLI 显式优先；PATH 命中；双缺 → null", () => {
  const saved = process.env.OMP_CLI;
  try {
    process.env.OMP_CLI = "/tmp/definitely-not-here";
    const r0 = resolveForkCli(OMP_SPEC);
    if (r0) assert.notEqual(r0.origin, "env OMP_CLI", "不存在的显式路径不得以 env 为解析来源");
    // 显式路径用 process.execPath：恒存在（/bin/sh 在 Windows 不存在，existsSync 拦下整条分支）
    process.env.OMP_CLI = process.execPath;
    const r = resolveForkCli(OMP_SPEC);
    assert.equal(r.runner, "bun");
    assert.deepEqual(r.args, [process.execPath]);
    assert.equal(r.origin, "env OMP_CLI");
    delete process.env.OMP_CLI;
    const onPath = resolveForkCli(OMP_SPEC);
    if (onPath === null) {
      assert.equal(onPath, null);
    } else {
      assert.ok(onPath.args[0].includes("omp"), "PATH/bun-global 解析应指向 omp");
    }
  } finally {
    if (saved === undefined) delete process.env.OMP_CLI;
    else process.env.OMP_CLI = saved;
  }
});

// ---- P2 host tools（omp set_host_tools / host_tool_call｜result｜cancel）------

test("omp spec 声明 host tools 能力", () => {
  assert.equal(OMP_SPEC.commands.hasHostTools, true);
});

test("setHostTools 下发 set_host_tools 帧并回读 toolNames", async () => {
  const child = fakeChild();
  const handle = createHandleForTest(OMP_SPEC, "ht1", child);
  const p = handle.setHostTools([
    { name: "aiti_inbox", description: "拉取收件箱", parameters: { type: "object", properties: {} }, execute: async () => "ok" },
  ]);
  const sent = child.frames().find((f) => f.type === "set_host_tools");
  assert.ok(sent, "应写出 set_host_tools 帧");
  assert.equal(sent.tools[0].name, "aiti_inbox");
  assert.equal(sent.tools[0].execute, undefined, "execute 不上线");
  feedResponse(handle, sent.id, { toolNames: ["aiti_inbox"] });
  assert.deepEqual(await p, ["aiti_inbox"]);
});

test("host_tool_call → 执行体 → host_tool_result 回显请求 id", async () => {
  const child = fakeChild();
  const handle = createHandleForTest(OMP_SPEC, "ht2", child);
  void handle.setHostTools([
    { name: "aiti_echo", description: "回声", parameters: { type: "object", properties: {} }, execute: async (args) => `echo:${args.text}` },
  ]);
  feed(handle, { type: "host_tool_call", id: "hc-1", toolCallId: "tc-1", toolName: "aiti_echo", arguments: { text: "hi" } });
  await new Promise((r) => setTimeout(r, 30));
  const result = child.frames().find((f) => f.type === "host_tool_result");
  assert.ok(result, "应写出 host_tool_result");
  assert.equal(result.id, "hc-1", "须回显请求帧 id");
  assert.equal(result.result.content[0].text, "echo:hi");
  assert.notEqual(result.result.isError, true);
});

test("host_tool_call 执行体抛错 → isError 结果帧", async () => {
  const child = fakeChild();
  const handle = createHandleForTest(OMP_SPEC, "ht3", child);
  void handle.setHostTools([
    { name: "aiti_boom", description: "炸", parameters: { type: "object", properties: {} }, execute: async () => { throw new Error("bridge down"); } },
  ]);
  feed(handle, { type: "host_tool_call", id: "hc-2", toolCallId: "tc-2", toolName: "aiti_boom", arguments: {} });
  await new Promise((r) => setTimeout(r, 30));
  const result = child.frames().find((f) => f.type === "host_tool_result" && f.id === "hc-2");
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /bridge down/);
});

test("未知工具名 → isError 结果帧（不崩管道）", async () => {
  const child = fakeChild();
  const handle = createHandleForTest(OMP_SPEC, "ht4", child);
  feed(handle, { type: "host_tool_call", id: "hc-3", toolCallId: "tc-3", toolName: "nope", arguments: {} });
  await new Promise((r) => setTimeout(r, 30));
  const result = child.frames().find((f) => f.type === "host_tool_result");
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /Unknown host tool/);
});

test("host_tool_cancel 帧中止执行中的调用", async () => {
  const child = fakeChild();
  const handle = createHandleForTest(OMP_SPEC, "ht5", child);
  let aborted = false;
  void handle.setHostTools([
    { name: "aiti_slow", description: "慢", parameters: { type: "object", properties: {} }, execute: (args, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
    }) },
  ]);
  feed(handle, { type: "host_tool_call", id: "hc-4", toolCallId: "tc-4", toolName: "aiti_slow", arguments: {} });
  await new Promise((r) => setTimeout(r, 20));
  feed(handle, { type: "host_tool_cancel", id: "x", targetId: "hc-4" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(aborted, true, "cancel 应触发 AbortSignal");
  const result = child.frames().find((f) => f.type === "host_tool_result" && f.id === "hc-4");
  assert.equal(result.result.isError, true);
});
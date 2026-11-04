/**
 * wire.test — pi-fork-rpc 共享层线协议宿主 / extension_ui 桥接纯函数测试。
 * 拆分自旧 aiti-pi-agent/pi-rpc-spawn.test.mjs 的公共部分（不依赖任何 fork 语义）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { RpcChildHost, lineReader, shutdownChild, toInteractionRequest, toExtensionUIResponse } from "./wire.ts";

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

function feed(host, obj) {
  host.child.stdout.write(JSON.stringify(obj) + "\n");
}

async function later(ms = 20) {
  await new Promise((r) => setTimeout(r, ms));
}

test("wire：request/response id 关联 + 错误帧 reject", async () => {
  const child = fakeChild();
  const h = new RpcChildHost(child);
  const p = h.request({ type: "get_state" });
  await later();
  assert.equal(child.frames()[0].type, "get_state");
  feed(h, { id: "r1", type: "response", command: "?", success: true, data: { ok: 1 } });
  assert.deepEqual(await p, { ok: 1 });

  const p2 = h.request({ type: "get_state" });
  await later();
  feed(h, { id: "r2", type: "response", command: "get_state", success: false, error: "boom" });
  await assert.rejects(p2, /boom/);
});

test("wire：非 response 帧默认原样透传 emit", async () => {
  const child = fakeChild();
  const h = new RpcChildHost(child);
  const events = [];
  h.subscribe((e) => events.push(e));
  feed(h, { type: "agent_start" });
  feed(h, { type: "message_end", message: { role: "assistant", content: [] } });
  await later();
  assert.equal(events[0].type, "agent_start");
  assert.equal(events[1].type, "message_end");
});

test("wire：进程 exit → pending reject + session_backend_dead 事件", async () => {
  const child = fakeChild();
  const h = new RpcChildHost(child);
  const events = [];
  h.subscribe((e) => events.push(e));
  const p = h.request({ type: "abort" });
  await later();
  child.emit("exit", 137);
  await assert.rejects(p, /dead/);
  assert.equal(events.find((e) => e.type === "session_backend_dead")?.reason, "process exited (137)");
});

// ---- 加固回归（审查 docs/pi-fork-rpc-review-findings.md 实证项）---------------------

test("wire：跨 chunk 的多字节字符整行解码不损坏（审查 P0-1 回归）", async () => {
  const pt = new PassThrough();
  const lines = [];
  lineReader(pt, (l) => lines.push(l));
  // 「标」= E6 A0 87、「题」= E9 A2 98：在「标」的 3 字节中间切开
  pt.write('{"title":"');
  pt.write(Buffer.from([0xe6, 0xa0]));
  pt.write(Buffer.from([0x87, 0xe9, 0xa2, 0x98]));
  pt.write('"}\n');
  await later();
  assert.ok(lines[0]?.includes("标题"), `跨块解码应完整，got=${JSON.stringify(lines[0])}`);
});

test("lineReader：超长行触发 onOverflow 并停止处理（审查 P1-6 回归）", async () => {
  const pt = new PassThrough();
  const lines = [];
  let overflowSize = 0;
  lineReader(pt, (l) => lines.push(l), { maxLineBytes: 64, onOverflow: (n) => (overflowSize = n) });
  pt.write(Buffer.from("a".repeat(100))); // 无换行超限
  await later();
  pt.write('{"x":1}\n'); // 超限后不再处理
  await later();
  assert.ok(overflowSize >= 64, "应触发 onOverflow");
  assert.equal(lines.length, 0, "超限后不再分发");
});

test("wire：行超限 → markDead（RpcChildHost 接线）", async () => {
  const child = fakeChild();
  const h = new RpcChildHost(child, { maxLineBytes: 64 });
  const events = [];
  h.subscribe((e) => events.push(e));
  child.stdout.write(Buffer.from("a".repeat(100)));
  await later();
  assert.equal(events.find((e) => e.type === "session_backend_dead")?.reason.includes("overflow"), true);
  assert.equal(h.aliveFlag, false);
});

test("wire：单个 listener 抛错不漏帧、不裸抛（审查 P0-3 回归）", async () => {
  const child = fakeChild();
  const h = new RpcChildHost(child);
  const got = [];
  let boom = null;
  h.subscribe(() => { throw new Error("listener boom"); });
  h.subscribe((e) => got.push(e));
  child.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
  await later();
  assert.equal(got.length, 1, "第二个 listener 应照常收到帧");
  assert.equal(got[0].type, "agent_start");
});

test("wire：stdout 流 error → markDead（审查 P0-2 回归）", async () => {
  const child = fakeChild();
  const h = new RpcChildHost(child);
  const events = [];
  h.subscribe((e) => events.push(e));
  child.stdout.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
  await later();
  assert.equal(events.find((e) => e.type === "session_backend_dead")?.reason.includes("stdout error"), true);
  assert.equal(h.aliveFlag, false);
});

test("wire：request 超时 reject + 响应/死亡清定时器（审查 P1-4 回归）", async () => {
  const child = fakeChild();
  const h = new RpcChildHost(child);
  await assert.rejects(
    h.request({ type: "get_state" }, { timeoutMs: 20 }),
    /\[rpc-child\] timeout: get_state after 20ms/,
  );
  // 正常响应路径不受超时影响
  const p = h.request({ type: "get_state" }, { timeoutMs: 5_000 });
  await later();
  feed(h, { id: "r2", type: "response", command: "get_state", success: true, data: { ok: 1 } });
  assert.deepEqual(await p, { ok: 1 });
});

test("wire：死亡时挂起超时定时器一并清理（无泄漏）", async () => {
  const child = fakeChild();
  const h = new RpcChildHost(child);
  const p = h.request({ type: "get_state" }, { timeoutMs: 60_000 });
  await later();
  child.emit("exit", 0);
  await assert.rejects(p, /dead/);
  // 若定时器未清，60s 后会多一次 reject（pending 已清，无副作用）——此处仅回归 reject 路径
});

test("shutdownChild：SIGTERM → destroy 三流（真实子进程冒烟）", async () => {
  const child = spawn("node", ["-e", "setInterval(()=>{},1000)"]);
  await later(80);
  const t0 = Date.now();
  await shutdownChild(child, 120);
  assert.ok(child.signalCode !== null || child.exitCode !== null, "子进程应已退出");
  assert.ok(Date.now() - t0 < 900, "grace 后应快速收尾");
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stdin.destroyed, true);
});

// ---- extension_ui ⇄ interaction_request 桥接纯函数 --------------------------------

test("toInteractionRequest：open_url 真实帧形状（instructions 字段）→ prompt 投影", () => {
  const ir = toInteractionRequest({
    type: "extension_ui_request", id: "ui-8", method: "open_url",
    url: "https://auth.x/oa2/authorize", launchUrl: "http://127.0.0.1:1/l", instructions: "在浏览器完成授权",
  });
  assert.equal(ir.kind, "open_url");
  assert.equal(ir.toolName, "extension_ui.open_url");
  assert.equal(ir.prompt, "在浏览器完成授权");
  assert.equal(ir.url, "https://auth.x/oa2/authorize");
  assert.equal(ir.launchUrl, "http://127.0.0.1:1/l");
});

test("toInteractionRequest：select（含 optionDetails description）→ ask_user 事件", () => {
  const ir = toInteractionRequest({
    type: "extension_ui_request", id: "b", method: "select", title: "t", options: ["x", "y"],
    optionDetails: [{}, { description: "便宜" }],
  });
  assert.equal(ir.kind, "ask_user");
  assert.equal(ir.questions[0].options[1].description, "便宜");
});

test("toExtensionUIResponse：select 无答案（decline）→ cancelled；纯函数直测", () => {
  assert.deepEqual(
    toExtensionUIResponse({ type: "extension_ui_request", id: "a", method: "select", title: "t", options: ["x"] }, { action: "decline" }),
    { type: "extension_ui_response", id: "a", cancelled: true },
  );
  const ir = toInteractionRequest({ type: "extension_ui_request", id: "b", method: "select", title: "t", options: ["x"] });
  assert.equal(ir.kind, "ask_user");
});

test("toExtensionUIResponse：select accept 带答案 → value 帧；confirm 三态；input/editor", () => {
  const sel = toExtensionUIResponse(
    { type: "extension_ui_request", id: "s", method: "select", title: "t", options: ["x"] },
    { action: "accept", answers: { t: "x" } },
  );
  assert.deepEqual(sel, { type: "extension_ui_response", id: "s", value: "x" });
  // confirm：accept（无答案=批准按钮路径）→ confirmed true；answers 选「取消」→ false；decline → cancelled
  assert.deepEqual(
    toExtensionUIResponse({ type: "extension_ui_request", id: "c1", method: "confirm", title: "删除?", message: "不可撤销" }, { action: "accept" }),
    { type: "extension_ui_response", id: "c1", confirmed: true },
  );
  assert.deepEqual(
    toExtensionUIResponse({ type: "extension_ui_request", id: "c2", method: "confirm", title: "删除?", message: "不可撤销" }, { action: "accept", answers: { "删除?\n不可撤销": "取消" } }),
    { type: "extension_ui_response", id: "c2", confirmed: false },
  );
  assert.deepEqual(
    toExtensionUIResponse({ type: "extension_ui_request", id: "c3", method: "confirm", title: "t", message: "m" }, { action: "decline", message: "不要" }),
    { type: "extension_ui_response", id: "c3", cancelled: true },
  );
  // confirm 防御（fail-closed）：answers 非空但未命中问题 key → 不再默认 confirmed true
  assert.deepEqual(
    toExtensionUIResponse({ type: "extension_ui_request", id: "c4", method: "confirm", title: "删除?", message: "不可撤销" }, { action: "accept", answers: { "别的问题": "确认" } }),
    { type: "extension_ui_response", id: "c4", confirmed: false },
  );
  // input/editor：answers 文本 → value；decline → cancelled
  assert.deepEqual(
    toExtensionUIResponse({ type: "extension_ui_request", id: "i1", method: "input", title: "会话名" }, { action: "accept", answers: { "会话名": "my session" } }),
    { type: "extension_ui_response", id: "i1", value: "my session" },
  );
  assert.deepEqual(
    toExtensionUIResponse({ type: "extension_ui_request", id: "e1", method: "editor", title: "" }, { action: "decline" }),
    { type: "extension_ui_response", id: "e1", cancelled: true },
  );
});

test("toExtensionUIResponse：notify/setWidget 等单向方法 → null（无需响应）", () => {
  assert.equal(
    toExtensionUIResponse({ type: "extension_ui_request", id: "n", method: "notify", message: "hello" }, { action: "accept" }),
    null,
  );
  assert.equal(
    toExtensionUIResponse({ type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "autoresearch" }, { action: "accept" }),
    null,
  );
});
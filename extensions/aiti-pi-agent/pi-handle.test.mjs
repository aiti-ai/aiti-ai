/**
 * pi-handle.test — aiti-pi-agent 专一后端测试。
 * 拆分自旧 pi-rpc-spawn.test.mjs 的 pi 侧用例；公共线协议见 _shared/pi-fork-rpc/wire.test.mjs。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { PiSpawnHandle, createHandleForTest, PI_SPEC } from "./pi-handle.ts";
import { capabilitiesFor } from "./fork-rpc/spec.ts";

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

test("pi spec：request/response id 相关 + 错误帧 reject", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t1", child);
  const p = h.request({ type: "get_state" });
  await later();
  assert.equal(child.frames()[0].type, "get_state");
  feedResponse(h, "r1", { ok: 1 });
  assert.deepEqual(await p, { ok: 1 });

  const p2 = h.request({ type: "get_state" });
  await later();
  feed(h, { id: "r2", type: "response", command: "get_state", success: false, error: "boom" });
  await assert.rejects(p2, /boom/);
});

test("pi spec：无 ready 帧 → 300ms sleep 兜底放行", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t3", child);
  let ready = false;
  h.whenReady.then(() => (ready = true));
  await later(50);
  assert.equal(ready, false, "300ms 内不应放行");
  await later(320);
  assert.ok(ready);
});

test("running 状态：agent_start/turn_start 置位、agent_settled/agent_end 收口", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t2", child);
  assert.equal(h.isRunning(), false);
  feed(h, { type: "agent_start" });
  await later();
  assert.equal(h.isRunning(), true);
  feed(h, { type: "agent_end" });
  await later();
  assert.equal(h.isRunning(), false);
  feed(h, { type: "turn_start" });
  await later();
  assert.equal(h.isRunning(), true);
  feed(h, { type: "agent_settled", stopReason: "end_turn" });
  await later();
  assert.equal(h.isRunning(), false);
});

test("model_select 事件回填 getModel（执行中模型体现的数据源）", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "tm", child);
  assert.equal(h.getModel(), undefined);
  feed(h, { type: "model_select", model: { id: "deepseek-v4-flash", provider: "free" } });
  await later();
  assert.deepEqual(h.getModel(), { id: "deepseek-v4-flash", provider: "free" });
});

test("fork 命令映射：pi 发 fork", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t4", child);
  const p = h.fork("entry-1");
  await later();
  assert.equal(child.frames()[0].type, "fork");
  feedResponse(h, "r1", { cancelled: false });
  assert.deepEqual(await p, { cancelled: false });
});

test("getMessages：pi 走 get_entries 原样", async () => {
  const cpi = fakeChild();
  const hpi = createHandleForTest(PI_SPEC, "t5", cpi);
  const ppi = hpi.getMessages();
  await later();
  assert.equal(cpi.frames()[0].type, "get_entries");
  feedResponse(hpi, "r1", { entries: [{ id: "e1", type: "message", message: { role: "user", content: "hi" } }] });
  assert.equal((await ppi)[0].id, "e1");
});

test("pi getCommands 仍发 get_commands", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t8", child);
  const p = h.getCommands();
  await later();
  assert.equal(child.frames()[0].type, "get_commands");
  feedResponse(h, "r1", { commands: [{ name: "foo", source: "project" }] });
  assert.equal((await p)[0].name, "foo");
});

test("capabilitiesFor（pi）：contextUsage/listTools 无、fail-loud 不变、respondInteraction 已声明", () => {
  const pi = capabilitiesFor(PI_SPEC);
  assert.equal(pi.contextUsage, false);
  assert.equal(pi.listTools, false);
  assert.equal(pi.setActiveTools, false);
  assert.equal(pi.navigateTree, false);
  assert.equal(pi.deleteSession, false);
  // 拆分时补全（B5）：respondInteraction 已实现 → 能力位声明 true
  assert.equal(pi.respondInteraction, true);
  // 待实测面（B5）：保守 false
  assert.equal(pi.respondPermission, false);
  assert.equal(pi.getUsage, false);
  assert.equal(pi.fileAttachments, false);
});

test("pi handle getAllTools fail-loud", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t10", child);
  await assert.rejects(h.getAllTools(), /listTools/);
});

test("pi 无 hasLogin：/login 照常透传 prompt", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t21", child);
  const p = h.prompt("/login");
  await later();
  assert.equal(child.frames()[0].type, "prompt");
  assert.equal(child.frames()[0].message, "/login");
  feedResponse(h, child.frames()[0].id, {});
  await p;
});

test("进程 exit → pending reject + session_backend_dead 事件", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t15", child);
  const events = [];
  h.subscribe((e) => events.push(e));
  const p = h.request({ type: "abort" });
  await later();
  child.emit("exit", 137);
  await assert.rejects(p, /dead/);
  assert.equal(events.find((e) => e.type === "session_backend_dead")?.reason, "process exited (137)");
  assert.equal(h.alive(), false);
});
// ---- 上下文用量（pi RPC 无协议字段 → 会话文件换算；docs/pi-web-external-agent-context-usage-plan.md §九）----

test("pickContextUsageFromLines：最近有效 assistant；aborted/error 跳过；压缩边界 → null；无命中 → undefined", async () => {
  const { pickContextUsageFromLines } = await import("./pi-handle.ts");
  const mk = (over) => JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10 }, ...over } });
  const lines = [
    mk({}),
    mk({ stopReason: "aborted", usage: { input: 999, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    mk({ stopReason: "error" }),
    mk({ usage: { input: 200, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 222 } }),
  ];
  const cu = pickContextUsageFromLines(lines, 200_000);
  assert.equal(cu.tokens, 222, "totalTokens 优先（pi 同式）");
  assert.equal(cu.contextWindow, 200_000);
  assert.ok(Math.abs(cu.percent - (222 / 200_000) * 100) < 1e-9);

  // 倒序：先 compaction → null（压缩后无新 usage）
  const lines2 = [mk({}), JSON.stringify({ type: "compaction", id: "c1" })];
  assert.deepEqual(pickContextUsageFromLines(lines2, 200_000), { tokens: null, percent: null, contextWindow: 200_000 });

  // 无 assistant/无 compaction → undefined；窗口非法 → undefined
  assert.equal(pickContextUsageFromLines([JSON.stringify({ type: "message", message: { role: "user" } })], 200_000), undefined);
  assert.equal(pickContextUsageFromLines(lines, 0), undefined);
  assert.equal(pickContextUsageFromLines(["{broken"], 200_000), undefined, "坏行跳过");
});

test("readSessionTailLines：尾部读取 + 首行残缺对齐", async () => {
  const { readSessionTailLines } = await import("./pi-handle.ts");
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const p = join(tmpdir(), `pi-ctx-test-${Date.now()}.jsonl`);
  await writeFile(p, "line1\nline2\nline3\n");
  const lines = await readSessionTailLines(p, 10); // 10B 窗口 → 首行必残缺
  assert.ok(lines.includes("line3"), `尾部行保留: ${JSON.stringify(lines)}`);
  assert.equal(await readSessionTailLines(join(tmpdir(), `nope-${Date.now()}.jsonl`)).then((l) => l.length), 0, "文件不存在 → 空数组");
});

test("handle 级：get_state 预热（sessionFile+contextWindow）→ getContextUsage 同步命中；轮末事件再刷新", async () => {
  const { createHandleForTest, PI_SPEC } = await import("./pi-handle.ts");
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "pi-ctx-"));
  const sf = join(dir, "sess.jsonl");
  await writeFile(sf, [
    JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", usage: { input: 500, output: 100, cacheRead: 200, cacheWrite: 0 } } }),
  ].join("\n") + "\n");

  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "tctx", child);
  assert.equal(h.getContextUsage(), undefined, "未预热 → undefined");
  assert.ok(h.capabilities.contextUsage === true, "capability 如实声明");

  // 构造 300ms whenReady 预热发出 get_state → 回填 sessionFile + 窗口
  await later(340);
  const gs = child.frames().find((f) => f.type === "get_state");
  assert.ok(gs, "whenReady 后应发 get_state 预热");
  feed(h, { id: gs.id, type: "response", command: "get_state", success: true,
    data: { sessionFile: sf, model: { id: "m", provider: "p", contextWindow: 100_000 } } });
  await later(40);
  const cu = h.getContextUsage();
  assert.ok(cu, "文件尾读后命中");
  assert.equal(cu.tokens, 800, "input 500 + output 100 + cacheRead 200（无 totalTokens → 四项和）");
  assert.equal(cu.contextWindow, 100_000);

  // 轮末事件驱动刷新：文件追加新 assistant → agent_settled → 刷新请求回填 → 新值
  const { appendFile } = await import("node:fs/promises");
  await appendFile(sf, JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", usage: { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 5100 } } }) + "\n");
  h.emit({ type: "agent_settled" });
  await later(30);
  const gs2 = child.frames().at(-1);
  assert.equal(gs2?.type, "get_state", "settle 应触发刷新请求");
  feed(h, { id: gs2.id, type: "response", command: "get_state", success: true,
    data: { sessionFile: sf, model: { id: "m", provider: "p", contextWindow: 100_000 } } });
  await later(60);
  assert.equal(h.getContextUsage()?.tokens, 5100, "轮末事件后刷新为新 assistant usage");
});

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

/** Id of the Nth request frame the child received (0-based, write order) — tests must
 *  not assume the wire's id format (ids carry a per-instance salt since 2026-11-22). */
function requestId(handle, n) {
  return handle.child.frames()[n].id;
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
  feedResponse(h, requestId(h, 0), { ok: 1 });
  assert.deepEqual(await p, { ok: 1 });

  const p2 = h.request({ type: "get_state" });
  await later();
  feed(h, { id: requestId(h, 1), type: "response", command: "get_state", success: false, error: "boom" });
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

test("fork 命令映射：先反查 entries 再发 fork + 换绑广播（分支按钮形态）", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t4", child);
  const events = [];
  h.subscribe((e) => events.push(e));
  const p = h.fork("um-1");
  await later();
  // resolveForkTarget 先 get_entries 反查真实 entry id
  assert.equal(child.frames()[0].type, "get_entries");
  feedResponse(h, requestId(h, 0), { entries: [
    { id: "um-1", type: "message", message: { role: "user", content: "hi" } },
    { id: "as-1", type: "message", message: { role: "assistant", content: [] } },
  ] });
  await later();
  assert.equal(child.frames()[1].type, "fork");
  assert.equal(child.frames()[1].entryId, "um-1");
  feedResponse(h, requestId(h, 1), { cancelled: false });
  await later();
  // fork 成功后读 get_state 发现换绑到了子会话（新 id）→ announce session_backend_ready
  assert.equal(child.frames()[2].type, "get_state");
  feedResponse(h, requestId(h, 2), { sessionId: "branched-child" });
  assert.deepEqual(await p, { cancelled: false, newSessionFile: "branched-child" });
  assert.equal(h.id, "branched-child", "handle id 换绑到子会话");
  const ready = events.find((e) => e.type === "session_backend_ready");
  assert.ok(ready, "广播 session_backend_ready");
  assert.equal(ready.oldId, "t4");
  assert.equal(ready.id, "branched-child");
});

test("fork reset（编辑从此处）：fork 目标 = editEntryId（被编辑的 user 消息）", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t4b", child);
  const p = h.fork("assistant-branch-point", { reset: true, editEntryId: "user-msg-being-edited" });
  await later();
  assert.equal(child.frames()[0].type, "get_entries");
  feedResponse(h, requestId(h, 0), { entries: [
    { id: "user-msg-being-edited", type: "message", message: { role: "user", content: "hi" } },
    { id: "assistant-branch-point", type: "message", message: { role: "assistant", content: [] } },
  ] });
  await later();
  assert.equal(child.frames()[1].type, "fork");
  assert.equal(child.frames()[1].entryId, "user-msg-being-edited", "pi fork(before) 只认 user 消息，用 editEntryId");
  feedResponse(h, requestId(h, 1), { cancelled: false });
  await later();
  feedResponse(h, requestId(h, 2), { sessionId: "child-1" });
  assert.deepEqual(await p, { cancelled: false, newSessionFile: "child-1" });
});

test("fork 目标 ext-N：按 UI 消息序反查真实 user entry", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t4c", child);
  const p = h.fork("", { reset: true, editEntryId: "ext-1" });
  await later();
  assert.equal(child.frames()[0].type, "get_entries");
  feedResponse(h, requestId(h, 0), { entries: [
    { id: "info-1", type: "model_change", message: { role: "assistant", content: [] } },
    { id: "um-0", type: "message", message: { role: "user", content: "first" } },
    { id: "um-1", type: "message", message: { role: "user", content: "second" } },
  ] });
  await later();
  // model_change 不进 UI 消息列表：ext-1 = 第二条 user 消息
  assert.equal(child.frames()[1].type, "fork");
  assert.equal(child.frames()[1].entryId, "um-1");
  feedResponse(h, requestId(h, 1), { cancelled: false });
  await later();
  feedResponse(h, requestId(h, 2), { sessionId: "t4c" }); // same id → no rebind announce
  assert.deepEqual(await p, { cancelled: false });
});

test("fork 目标解析失败：显式报错，绝不瞎猜 entry", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t4d", child);
  const p = h.fork("", { reset: true, editEntryId: "ext-9" });
  await later();
  feedResponse(h, requestId(h, 0), { entries: [] });
  await assert.rejects(p, /cannot resolve entry/, "解析失败必须显式抛错");
  assert.equal(child.frames().some((f) => f.type === "fork"), false, "解析失败绝不发 fork");
});

test("fork 后子会话 id 与记录一致（或 get_state 失败）→ 不广播、不回传 newSessionFile", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "same-id", child);
  const events = [];
  h.subscribe((e) => events.push(e));
  const p = h.fork("entry-1");
  await later();
  feedResponse(h, requestId(h, 0), { entries: [{ id: "entry-1", type: "message", message: { role: "user", content: "hi" } }] });
  await later();
  feedResponse(h, requestId(h, 1), { cancelled: false });
  await later();
  feedResponse(h, requestId(h, 2), { sessionId: "same-id" });
  assert.deepEqual(await p, { cancelled: false });
  assert.equal(events.find((e) => e.type === "session_backend_ready"), undefined);
});

test("getMessages：pi 走 get_entries 原样", async () => {
  const cpi = fakeChild();
  const hpi = createHandleForTest(PI_SPEC, "t5", cpi);
  const ppi = hpi.getMessages();
  await later();
  assert.equal(cpi.frames()[0].type, "get_entries");
  feedResponse(hpi, requestId(hpi, 0), { entries: [{ id: "e1", type: "message", message: { role: "user", content: "hi" } }] });
  assert.equal((await ppi)[0].id, "e1");
});

test("pi getCommands 仍发 get_commands", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t8", child);
  const p = h.getCommands();
  await later();
  assert.equal(child.frames()[0].type, "get_commands");
  feedResponse(h, requestId(h, 0), { commands: [{ name: "foo", source: "project" }] });
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

test("plain prompt 撞运行中子进程 → 以 followUp 重试一次（race 降级）", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t22", child);
  const p = h.prompt("hello");
  await later();
  assert.equal(child.frames()[0].type, "prompt");
  assert.equal(child.frames()[0].streamingBehavior, undefined);
  // Child busy: the error frame rejects (SDK throws on isStreaming without streamingBehavior)
  feed(h, { id: child.frames()[0].id, type: "response", command: "prompt", success: false,
    error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." });
  await later();
  // Retry frame carries followUp (message/images preserved)
  assert.equal(child.frames()[1].type, "prompt");
  assert.equal(child.frames()[1].streamingBehavior, "followUp");
  assert.equal(child.frames()[1].message, "hello");
  feedResponse(h, child.frames()[1].id, { disposition: "queued" });
  // A queued message starts no turn: the caller must be told, or it keeps the
  // optimistic bubble and the same text shows up twice (bubble + queue row).
  assert.deepEqual(await p, { queued: true });
});

test("race retry that lands on an idle child reports started, not queued", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t26", child);
  const p = h.prompt("hello");
  await later();
  feed(h, { id: child.frames()[0].id, type: "response", command: "prompt", success: false,
    error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." });
  await later();
  // The run settled before the retry landed: pi starts a turn, so the bubble is real.
  feedResponse(h, child.frames()[1].id, { disposition: "started" });
  assert.equal(await p, undefined);
});

test("plain prompt 撞运行中 + 带图片：重试帧保留 images；显式 behavior 报错不吞", async () => {
  // Images race: images ride along on the retry frame
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t23", child);
  const img = [{ type: "image", data: "aGk=", mimeType: "image/png" }];
  const p = h.prompt("look", { images: img });
  await later();
  feed(h, { id: child.frames()[0].id, type: "response", command: "prompt", success: false,
    error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." });
  await later();
  assert.deepEqual(child.frames()[1].images, img);
  feedResponse(h, child.frames()[1].id, {});
  await p;
  // When the caller chose a behavior explicitly, the same error must propagate
  // verbatim — that is a different failure, and downgrading would mask intent
  const child2 = fakeChild();
  const h2 = createHandleForTest(PI_SPEC, "t24", child2);
  const p2 = h2.prompt("x", { streamingBehavior: "steer" });
  await later();
  feed(h2, { id: child2.frames()[0].id, type: "response", command: "prompt", success: false,
    error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." });
  await assert.rejects(p2, /already processing/);
  assert.equal(child2.frames().length, 1, "显式 behavior 不重试");

  // Unrelated errors (timeout/death) miss the narrow match and propagate as-is
  const child3 = fakeChild();
  const h3 = createHandleForTest(PI_SPEC, "t25", child3);
  const p3 = h3.prompt("y");
  await later();
  feed(h3, { id: child3.frames()[0].id, type: "response", command: "prompt", success: false, error: "boom" });
  await assert.rejects(p3, /boom/);
  assert.equal(child3.frames().length, 1);
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

// ── navigateTree (in-place branch, 2026-11-23) ─────────────────────────────────
// pi 1.6 RPC has no navigate_tree, and fork writes a new session file — "edit from here"
// used to create a duplicate sidebar row. The handle restores pi's in-place tree move
// with a branch-point custom anchor + switch_session reopening the same file (same id /
// same file / old tail stays as a diverged branch).

async function navFixture() {
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "pi-nav-"));
  const file = join(dir, "sess.jsonl");
  const header = { type: "session", version: 3, id: "sess-1", timestamp: "2026-11-23T00:00:00.000Z", cwd: dir };
  const entries = [
    { type: "model_change", id: "mc-1", parentId: null, timestamp: "2026-11-23T00:00:01.000Z", provider: "p", modelId: "m" },
    { type: "message", id: "um-1", parentId: "mc-1", timestamp: "2026-11-23T00:00:02.000Z", message: { role: "user", content: "first" } },
    { type: "message", id: "as-1", parentId: "um-1", timestamp: "2026-11-23T00:00:03.000Z", message: { role: "assistant", content: [] } },
    { type: "message", id: "um-2", parentId: "as-1", timestamp: "2026-11-23T00:00:04.000Z", message: { role: "user", content: "second" } },
  ];
  await writeFile(file, [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { file, header, entries };
}

test("navigateTree：user 消息目标 → 分支点 custom 锚点 + switch_session 同一文件", async () => {
  const { file, entries } = await navFixture();
  const { readFile } = await import("node:fs/promises");
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "sess-1", child);
  const p = h.navigateTree("um-2");
  await later();
  assert.equal(child.frames()[0].type, "get_entries");
  feedResponse(h, requestId(h, 0), { entries, leafId: "um-2" });
  await later();
  assert.equal(child.frames()[1].type, "get_state", "需要文件路径才能落锚点");
  feedResponse(h, requestId(h, 1), { sessionFile: file });
  await later();
  assert.equal(child.frames()[2].type, "switch_session");
  assert.equal(child.frames()[2].sessionPath, file, "重开的是同一个会话文件（不是新文件）");
  feedResponse(h, requestId(h, 2), { cancelled: false });
  assert.deepEqual(await p, { cancelled: false });

  const lines = (await readFile(file, "utf8")).trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, entries.length + 2, "只追加一个锚点，原有条目不动");
  const marker = lines.at(-1);
  assert.equal(marker.type, "custom", "custom 条目不进 LLM 上下文、也不渲染");
  assert.equal(marker.customType, "pi-web:branch-point");
  assert.equal(marker.parentId, "as-1", "user 消息目标 = 回退到它的 parent（pi navigateTree 语义）");
  assert.match(String(marker.id), /^[0-9a-f]{8}$/, "pi 的 entry id 形态");
  assert.notEqual(marker.id, "um-1");
  assert.ok(!entries.some((e) => e.id === marker.id), "id 不与已有条目冲突");
  assert.equal(h.capabilities.navigateTree, true, "实例能力位声明 navigateTree");

  // Teardown: the async get_state after switch (usage/model refresh) must not block the test.
  feedResponse(h, requestId(h, 3), { sessionFile: file, model: { id: "m", provider: "p" } });
  feedResponse(h, requestId(h, 4), { model: { id: "m2", provider: "p2" } });
  await later(20);
  assert.deepEqual(h.getModel(), { id: "m2", provider: "p2" }, "重开后模型按新分支回填");
});

test("navigateTree：非 user 目标 = 直接以该 entry 为叶子（分支导航）", async () => {
  const { file, entries } = await navFixture();
  const { readFile } = await import("node:fs/promises");
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "sess-1", child);
  const p = h.navigateTree("as-1");
  await later();
  feedResponse(h, requestId(h, 0), { entries, leafId: "um-2" });
  await later();
  feedResponse(h, requestId(h, 1), { sessionFile: file });
  await later();
  feedResponse(h, requestId(h, 2), { cancelled: false });
  await p;
  const marker = JSON.parse((await readFile(file, "utf8")).trimEnd().split("\n").at(-1));
  assert.equal(marker.parentId, "as-1");
  assert.equal(marker.data.targetId, "as-1");
  feedResponse(h, requestId(h, 3), { sessionFile: file });
  feedResponse(h, requestId(h, 4), { model: { id: "m", provider: "p" } });
});

test("navigateTree：目标已在叶子上 → 不落锚点、不发 switch_session（pi 的 no-op）", async () => {
  const { file, entries } = await navFixture();
  const { readFile } = await import("node:fs/promises");
  const before = await readFile(file, "utf8");
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "sess-1", child);
  const p = h.navigateTree("as-1");
  await later();
  feedResponse(h, requestId(h, 0), { entries, leafId: "as-1" });
  assert.deepEqual(await p, { cancelled: false });
  assert.equal(child.frames().length, 1, "只有 get_entries");
  assert.equal(await readFile(file, "utf8"), before, "文件未动");
});

test("navigateTree：session_before_switch 取消 → 锚点回滚（不留隐式叶子）", async () => {
  const { file, entries } = await navFixture();
  const { readFile, stat } = await import("node:fs/promises");
  const sizeBefore = (await stat(file)).size;
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "sess-1", child);
  const p = h.navigateTree("um-2");
  await later();
  feedResponse(h, requestId(h, 0), { entries, leafId: "um-2" });
  await later();
  feedResponse(h, requestId(h, 1), { sessionFile: file });
  await later();
  assert.equal(child.frames()[2].type, "switch_session");
  feedResponse(h, requestId(h, 2), { cancelled: true });
  assert.deepEqual(await p, { cancelled: true });
  assert.equal((await stat(file)).size, sizeBefore, "文件长度复原：锚点不能留给下次加载当叶子");
  assert.ok(!(await readFile(file, "utf8")).includes("pi-web:branch-point"));
});

test("navigateTree：运行中拒绝（pi 同样不让树移动与在跑的轮次交叠）", async () => {
  const { file, entries } = await navFixture();
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "sess-1", child);
  h.running = true;
  await assert.rejects(() => h.navigateTree("um-2"), /Wait for the current response/);
  assert.equal(child.frames().length, 0, "拒绝发生在任何 RPC 之前");
  h.running = false;
  assert.ok(Array.isArray(entries));
  assert.ok(file);
});

test("navigateTree：分支摘要请求显式拒绝（RPC 线不跑模型回合）", async () => {
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "sess-1", child);
  await assert.rejects(() => h.navigateTree("um-2", { summarize: true }), /branch summaries are not supported/);
  assert.equal(child.frames().length, 0);
});

test("navigateTree 与 prompt 的先后：分支移动未完成前发出的 prompt 等它落地", async () => {
  const { file, entries } = await navFixture();
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "sess-1", child);
  const nav = h.navigateTree("um-2");
  await later();
  feedResponse(h, requestId(h, 0), { entries, leafId: "um-2" });
  await later();
  feedResponse(h, requestId(h, 1), { sessionFile: file });
  await later();
  // Branch navigation is fire-and-forget and the user sends immediately: prompt must be ordered after switch_session.
  const send = h.prompt("edited");
  await later(30);
  const types = child.frames().map((f) => f.type);
  assert.ok(!types.includes("prompt"), "移动未完成 → prompt 不得先写入子进程 stdin");
  assert.equal(types[2], "switch_session");
  feedResponse(h, requestId(h, 2), { cancelled: false });
  await nav;
  await later(20);
  assert.ok(child.frames().some((f) => f.type === "prompt"), "移动落地后 prompt 才发出");
  const promptFrame = child.frames().find((f) => f.type === "prompt");
  feedResponse(h, promptFrame.id, { disposition: "prompt" });
  await later(20);
  feedResponse(h, requestId(h, 3), { sessionFile: file });
  feedResponse(h, requestId(h, 4), { model: { id: "m", provider: "p" } });
  await send;
});

test("alive(): a wrapper facade with a closed stdin is not alive (undrivable)", () => {
  // The socket can close without an "exit" event: exitCode stays null while stdin is no longer
  // writable. request() rejects such a handle as "not running", so alive() must agree — a dead
  // handle left in the store served empty transcripts and swallowed prompts (2026-11-23).
  const child = fakeChild();
  const h = createHandleForTest(PI_SPEC, "t-alive", child);
  assert.equal(h.alive(), true);
  Object.defineProperty(child.stdin, "writable", { value: false, configurable: true });
  assert.equal(h.alive(), false);
});

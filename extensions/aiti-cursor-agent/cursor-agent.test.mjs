/**
 * aiti-cursor-agent — 单测（D6）：帧状态机 + 登录 driver 契约。
 *
 * cursor 协议核心（cursor-cli-store wire 解码）由 _shared/cursor-cli-store.test.mjs
 * 钉死；本文件补扩展自身两块：
 *   1. handle 帧状态机（经 mock startup → createSession 拿真 handle，私有 onLine 直驱）：
 *      assistant 文本累积、result 收口（settled + running 复位）、thinking 忽略、
 *      is_error → settled error、turnEnded 后晚到帧忽略（防重复 settled）；
 *   2. 受控登录 driver（extractUrl/interpret/bin 名）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-cursor-agent/cursor-agent.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const mod = await import("./index.ts");
const { extractCursorLoginUrl, interpretCursorLogin, cursorLoginDriver } = mod;

/** mock startup → 捕获 createSession → 造 handle（不 spawn：spawn 在 prompt 里）。 */
async function makeHandle() {
  let created = null;
  const providers = { register(p) { created = p; return "aiti-cursor-agent/cursor"; } };
  const ctx = { sessionProviders: providers, configDir: "/tmp" };
  await mod.default.server.startup(ctx);
  assert.ok(created, "startup 应注册 provider");
  const h = await created.createSession({ cwd: "/tmp" });
  const events = [];
  h.subscribe((e) => events.push(e));
  const write = (frame) => h.consumeLine(JSON.stringify(frame));
  return { h, events, write };
}

test("帧状态机：assistant 累积 → result 收口（settled + running 复位 + 历史入库）", async () => {
  const { h, events, write } = await makeHandle();
  h.running = true; // 模拟 prompt 后在途
  write({ type: "assistant", message: { model: "composer-1", content: [{ type: "text", text: "你好" }] } });
  write({ type: "assistant", message: { content: [{ type: "text", text: "！" }] } });
  write({ type: "result", result: "你好！", is_error: false });
  const settled = events.find((e) => e.type === "agent_settled");
  assert.ok(settled, "result 应发 settled");
  assert.equal(settled.result, "你好！");
  assert.equal(h.isRunning(), false, "result 即收口（不等进程 exit）");
  const last = h.history.at(-1);
  assert.equal(last?.role, "assistant");
  assert.equal(last?.content?.[0]?.text, "你好！");
});

test("帧状态机：thinking 忽略；is_error → settled error", async () => {
  const { h, events, write } = await makeHandle();
  h.running = true;
  write({ type: "thinking", text: "内部推理" });
  assert.ok(!events.some((e) => e.type === "message_update"), "thinking 不进正文流");
  write({ type: "result", result: "", is_error: true });
  const settled = events.find((e) => e.type === "agent_settled");
  assert.ok(settled?.error, "is_error 应带 error");
});

test("帧状态机：turnEnded 后晚到帧忽略（防重复 settled）", async () => {
  const { h, events, write } = await makeHandle();
  h.running = true;
  write({ type: "result", result: "一" });
  const settledCount = () => events.filter((e) => e.type === "agent_settled").length;
  assert.equal(settledCount(), 1);
  write({ type: "assistant", message: { content: [{ type: "text", text: "晚到" }] } });
  write({ type: "result", result: "晚到的二" });
  assert.equal(settledCount(), 1, "重复 result/晚到帧不得二次收口");
  assert.equal(h.history.at(-1)?.content?.[0]?.text, "一");
});

test("登录 driver：URL 提取 / 结果判定 / bin 名", () => {
  assert.equal(
    extractCursorLoginUrl("navigate to this link: https://cursor.com/login-device?code=XYZ to finish"),
    "https://cursor.com/login-device?code=XYZ",
  );
  assert.equal(extractCursorLoginUrl("no url here"), null);
  assert.deepEqual(interpretCursorLogin(0, "", ""), { state: "success" });
  const failed = interpretCursorLogin(1, "out", "err line");
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "err line");
  assert.equal(cursorLoginDriver.agentId, "cursor");
});

// ---- 队列接线（共享层 backend-queue，docs/aiti-agent-queue-clear-recall-audit-plan.md §2）----
// 不真 spawn：settle 时队列已清空 → scheduleDrain no-op，dispatch 不会被触发。

test("队列接线：运行中 followUp 入队 + queue_update；list/move/remove 转发共享层", async () => {
  const { h, events } = await makeHandle();
  h.running = true;
  await h.followUp("a");
  await h.followUp("b");
  const updates = events.filter((e) => e.type === "queue_update");
  assert.ok(updates.length >= 2, "每次入队应广播 queue_update");
  assert.deepEqual(updates.at(-1).followUp, ["a", "b"]);
  const list = await h.queueManage({ action: "list" });
  assert.deepEqual(list.followUp, ["a", "b"]);
  assert.deepEqual(list.steering, []);
  await h.queueManage({ action: "move", from: 0, to: 1 });
  assert.deepEqual((await h.queueManage({ action: "list" })).followUp, ["b", "a"]);
  const rm = await h.queueManage({ action: "remove", index: 0 });
  assert.equal(rm.entry.text, "b");
  assert.equal(rm.removed.text, "b");
});

test("队列接线：clear 返回清空前文本（pi clearQueue 契约——前端「全部编辑」回填输入框）", async () => {
  const { h, events, write } = await makeHandle();
  h.running = true;
  await h.followUp("msg-1");
  await h.followUp("msg-2");
  const cleared = await h.queueManage({ action: "clear" });
  assert.deepEqual(cleared.followUp, ["msg-1", "msg-2"], "clear 须带回清空前的文本");
  assert.deepEqual((await h.queueManage({ action: "list" })).followUp, []);
  assert.ok(events.some((e) => e.type === "queue_update" && e.followUp.length === 0), "清空应广播空 queue_update");
  // settle（队列已空 → scheduleDrain no-op，不会真 spawn）
  write({ type: "result", result: "ok" });
  assert.ok(events.some((e) => e.type === "agent_settled"));
  assert.deepEqual((await h.queueManage({ action: "list" })).followUp, [], "settle 后队列不得复活");
});

test("队列接线：recall 单条取回；steer 组操作给人话错误", async () => {
  const { h } = await makeHandle();
  h.running = true;
  await h.followUp("x");
  const rec = await h.queueManage({ action: "recall", index: 0 });
  assert.equal(rec.entry.text, "x");
  await assert.rejects(() => h.queueManage({ action: "clear", kind: "steer" }), /does not support recall\/move/);
});

// ---- 上下文用量（机会式；docs/pi-web-external-agent-context-usage-plan.md）----

test("contextUsage 机会式：result.usage（claude 形态）→ getContextUsage；composer 模型窗口未知 → undefined", async () => {
  const { h, write } = await makeHandle();
  h.running = true;
  write({ type: "assistant", message: { model: "claude-sonnet-4-5", content: [{ type: "text", text: "hi" }] } });
  write({ type: "result", result: "hi", is_error: false,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 10 } });
  const cu = h.getContextUsage();
  assert.ok(cu, "usage 齐全 + 模型可判 → 有数据");
  assert.equal(cu.tokens, 610);
  assert.equal(cu.contextWindow, 200_000);
  const totals = h.getUsageTotals();
  assert.equal(totals.inputTokens, 100);
  assert.equal(totals.turns, 1);
});

test("contextUsage 机会式：无 usage 帧 → getContextUsage undefined（不编数据），totals 全 0", async () => {
  const { h, write } = await makeHandle();
  h.running = true;
  write({ type: "assistant", message: { model: "composer-1", content: [{ type: "text", text: "hi" }] } });
  write({ type: "result", result: "hi", is_error: false });
  assert.equal(h.getContextUsage(), undefined, "composer 窗口未知 + 无 usage → 空轨");
  const totals = h.getUsageTotals();
  assert.equal(totals.turns, 0);
  assert.equal(totals.inputTokens, 0);
});

// ---- agent-starter adoption (detachable host): injected spawn / attached adopt / release-on-dispose ----

const { PassThrough, EventEmitter } = await import("node:stream").then(async (streams) => ({
  PassThrough: streams.PassThrough,
  EventEmitter: (await import("node:events")).EventEmitter,
}));

/** Fake CLI child: pipe-like stdio + EventEmitter surface (no real process). */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.emit("exit", 0, signal ?? null);
  };
  return child;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function providerWithStarter() {
  let created = null;
  const providers = { register(p) { created = p; return "aiti-cursor-agent/cursor-agent"; } };
  await mod.default.server.startup({ sessionProviders: providers, configDir: "/tmp" });
  assert.ok(created, "startup 应注册 provider");
  return created;
}

test("detached host: the turn CLI is spawned through the injected starter with the native key", async () => {
  const provider = await providerWithStarter();
  const calls = [];
  const starter = {
    kind: "wrapper",
    async spawn(command, args, options) {
      calls.push({ command, args, options });
      return fakeChild();
    },
  };
  const h = await provider.createSession({ cwd: "/tmp", agentStarter: starter });
  assert.equal(h.starter, starter);
  assert.match(h.nativeKey, /^new-/, "fresh session uses one placeholder uuid as the registry key");
  await h.prompt("hello there");
  await tick();
  assert.equal(calls.length, 1, "exactly one CLI process per turn");
  assert.match(calls[0].args.join(" "), /agent -p hello there/);
  assert.equal(calls[0].options.agentKey, "cursor");
  assert.equal(calls[0].options.sessionId, h.nativeKey, "spawn key == handle placeholder key (rekey can find it)");
});

test("attached: adopting a facade rebuilds the turn from its replayed frames", async () => {
  const provider = await providerWithStarter();
  const child = fakeChild();
  child.detachable = true;
  child.release = () => { child.released = true; };
  const h = await provider.createSession({
    cwd: "/tmp",
    sessionId: "chat-1",
    attached: { child, sessionId: "chat-1", agentKey: "cursor" },
  });
  assert.equal(h.id, "cursor:chat-1");
  assert.equal(h.isRunning(), true, "an adopted mid-turn process counts as running until the result frame");
  child.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "replayed" }] } }) + "\n");
  child.stdout.write(JSON.stringify({ type: "result", result: "replayed", is_error: false }) + "\n");
  await tick();
  assert.equal(h.isRunning(), false, "result frame settles the adopted turn");
  assert.equal(h.history.at(-1)?.content?.[0]?.text, "replayed");
});

test("dispose releases a wrapper-hosted child instead of killing it", async () => {
  const provider = await providerWithStarter();
  const child = fakeChild();
  child.detachable = true;
  child.release = () => { child.released = true; };
  const h = await provider.createSession({
    cwd: "/tmp",
    sessionId: "chat-2",
    attached: { child, sessionId: "chat-2", agentKey: "cursor" },
  });
  await h.dispose();
  assert.equal(child.released, true, "facade child must be released (agent keeps running)");
  assert.equal(child.killed, false, "a wrapper-hosted child must never be SIGTERM'd by dispose");
});

// ============================================================================
// Image channel: hidden `--image <path>` (probed 2026-11-26: repeatable, the CLI reads the
// file and validates the image type) + the host mirror shape (userMessageKey hashes image
// blocks — a text-only copy replaces the bubble and the picture disappears).
// ============================================================================

/** Starter that captures argv and hands back a fake child that never really runs. */
function captureStarter(calls) {
  return {
    kind: "direct",
    async spawn(command, args) {
      calls.push({ command, args });
      const { PassThrough } = await import("node:stream");
      return {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: { write: () => true, writable: true, on() {} },
        once() {},
        kill() {},
        exitCode: null,
      };
    },
  };
}

test("图片：prompt(images) → --image 临时文件已写入，镜像落宿主同形 base64 块，收尾删目录", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { h } = await makeHandle();
  const calls = [];
  h.starter = captureStarter(calls);
  h.aliveFlag = true;

  await h.prompt("这张图怎么回事", { images: [{ data: "QUJD", mimeType: "image/png" }] });
  await tick();

  assert.equal(calls.length, 1, "一轮一次 spawn");
  const args = calls[0].args;
  const i = args.indexOf("--image");
  assert.ok(i > 0, "argv 带 --image（隐藏参数）");
  const file = args[i + 1];
  assert.match(file, /cursor-att-[0-9a-f-]+\/att-1\.png$/, "落临时目录、按 mime 取扩展名");
  assert.equal(readFileSync(file, "utf8"), "ABC", "base64 解码后写入的是原始字节");

  assert.deepEqual(h.history.at(-1).content, [
    { type: "text", text: "这张图怎么回事" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
  ], "镜像与宿主乐观气泡同形（否则纯文本版顶替，图消失）");

  // A result frame ends the turn → the attachment directory goes away
  h.consumeLine(JSON.stringify({ type: "result", result: "看到了", is_error: false }));
  assert.equal(existsSync(file), false, "收尾删临时文件（不留 /tmp 泄漏）");
});

test("图片：只有图没有文字 → 只带图块；无图保持字符串 content", async () => {
  const { h } = await makeHandle();
  const calls = [];
  h.starter = captureStarter(calls);
  h.aliveFlag = true;
  await h.prompt("", { images: [{ data: "QUJD", mimeType: "image/jpeg" }] });
  await tick();
  assert.match(calls[0].args[calls[0].args.indexOf("--image") + 1], /att-1\.jpeg$/);
  assert.deepEqual(h.history.at(-1).content, [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
  ]);

  const { h: h2 } = await makeHandle();
  const calls2 = [];
  h2.starter = captureStarter(calls2);
  h2.aliveFlag = true;
  await h2.prompt("纯文字");
  await tick();
  assert.equal(calls2[0].args.includes("--image"), false, "无图不传 --image");
  assert.equal(h2.history.at(-1).content, "纯文字", "老形状不变");
});

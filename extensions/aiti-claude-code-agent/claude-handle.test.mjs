/**
 * aiti-claude-code-agent — handle 单测（D4 权限记录 / D5 工具直播卡 / followUp 队列）。
 *
 * 用假 child（stdout = PassThrough，stdin.write 捕获）直驱 handle，钉死：
 *   1. can_use_tool → permission_request 事件 + 🔐 pending 记录进 liveHistory（D4）；
 *   2. respondPermission → control_response 写回 + 决策记录（D4）；
 *   3. result 帧收口未决授权 → cancelled 记录 + agent_settled + 队列续轮（D4/D11）；
 *   4. assistant tool_use → liveHistory 原生 toolCall 块 + 原生直播条目（方案 X）；
 *   5. user tool_result → 原生 toolResult 条目（liveHistory + 直播，折叠配对，方案 X）；
 *   6. 运行中 prompt → 本地队列（queue_update），result 后自动续轮（D3/D11 探针定论）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-claude-code-agent/claude-handle.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ClaudeCodeHandle } = await import("./index.ts");

/** 假 child + 订阅事件捕获。 */
function makeHandle(id = "claude:new-test") {
  const stdout = new PassThrough();
  const stdinWrites = [];
  const child = {
    stdout,
    stderr: { on() {} },
    once() {},
    stdin: { write: (s) => { stdinWrites.push(s); return true; }, writable: true },
    kill() {},
    exitCode: null,
  };
  const h = new ClaudeCodeHandle(id, child, "/tmp", undefined, "claude");
  const events = [];
  h.subscribe((e) => events.push(e));
  const write = (frame) => stdout.write(JSON.stringify(frame) + "\n");
  return { h, events, stdinWrites, write };
}

const flush = () => new Promise((r) => setTimeout(r, 2));
const customs = (events, type) => events.filter((e) => e.type === "message_end" && e.message?.customType === type);
const historyCustoms = (h, type) => h.liveHistory.filter((m) => m?.role === "custom" && m.customType === type);
const messageEnds = (events, role) => events.filter((e) => e.type === "message_end" && e.message?.role === role);
const historyRoles = (h, role) => h.liveHistory.filter((m) => m?.role === role);

test("D4: can_use_tool → permission_request + 🔐 pending 记录", () => {
  const { h, events, write } = makeHandle();
  write({ type: "control_request", request_id: "toolu_1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls -la" } } });
  const req = events.find((e) => e.type === "permission_request");
  assert.equal(req?.toolName, "Bash");
  const pending = historyCustoms(h, "🔐 工具授权");
  assert.equal(pending.length, 1);
  assert.match(pending[0].content, /Bash/);
  assert.match(pending[0].content, /ls -la/);
  assert.match(pending[0].content, /⏳ 等待授权/);
  assert.equal(pending[0].details.requestId, "toolu_1");
});

test("D4: respondPermission → control_response 写回 + 决策记录", () => {
  const { h, events, stdinWrites, write } = makeHandle();
  write({ type: "control_request", request_id: "toolu_2", request: { subtype: "can_use_tool", tool_name: "Write", input: { path: "a.txt" } } });
  return h.respondPermission("toolu_2", { behavior: "deny", message: "too risky" }).then((ok) => {
    assert.equal(ok, true);
    const resp = stdinWrites.find((s) => s.includes("control_response"));
    assert.ok(resp, "应写回 control_response");
    assert.ok(resp.includes('"behavior":"deny"') || resp.includes('"behavior": "deny"'), "deny 应答");
    const decided = historyCustoms(h, "🔐 工具授权");
    assert.equal(decided.length, 2, "pending + decision 两条");
    assert.match(decided[1].content, /⛔ 已拒绝/);
    assert.match(decided[1].content, /too risky/);
  });
});

test("D4: result 帧收口未决授权 → cancelled 记录 + settled + 队列续轮", async () => {
  const { h, events, stdinWrites, write } = makeHandle();
  write({ type: "control_request", request_id: "toolu_3", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } });
  // 运行中排入一条 followUp（result 后应自动续轮）
  await h.prompt("first");
  const p2 = h.prompt("second", { streamingBehavior: "followUp" });
  await p2;
  await flush();
  assert.deepEqual(events.filter((e) => e.type === "queue_update").at(-1)?.followUp, ["second"]);

  write({ type: "result", subtype: "success", is_error: false, result: "done" });
  await flush();
  const cancelled = historyCustoms(h, "🔐 工具授权").filter((m) => m.content.includes("已取消"));
  assert.equal(cancelled.length, 1, "未决授权应记取消");
  assert.ok(events.some((e) => e.type === "agent_settled"), "result 应发 settled");
  await flush();
  const userTurn2 = stdinWrites.filter((s) => s.includes("Reply") || s.includes("second"));
  assert.ok(userTurn2.some((s) => JSON.parse(s).message.content[0].text === "second"), "result 后应自动续轮发出 second");
});

test("方案 X: assistant tool_use → liveHistory 原生块 + 原生 toolCall 直播条目（无双卡）", () => {
  const { h, events, write } = makeHandle();
  write({ type: "assistant", message: { model: "claude-sonnet-4-5", content: [
    { type: "tool_use", id: "tc_1", name: "Bash", input: { command: "pwd" } },
  ] } });
  const toolCallMsg = h.liveHistory.find((m) => m?.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "toolCall"));
  assert.ok(toolCallMsg, "liveHistory 应有原生 toolCall 块");
  const live = messageEnds(events, "assistant").filter((e) => (e.message.content ?? []).some((b) => b.type === "toolCall"));
  assert.equal(live.length, 1, "原生 toolCall 直播条目恰好一条");
  assert.equal(live[0].message.content[0].toolCallId, "tc_1");
  assert.equal(live[0].message.content[0].toolName, "Bash");
  assert.equal(live[0].message.model, "claude-sonnet-4-5");
  assert.equal(events.some((e) => e.type === "message_end" && e.message?.customType === "🛠 工具调用"), false, "不再发 🛠 custom 卡");
});

test("方案 X: user tool_result → 原生 toolResult 条目（liveHistory + 直播，错误标记保真）", () => {
  const { h, events, write } = makeHandle();
  write({ type: "assistant", message: { content: [{ type: "tool_use", id: "tc_2", name: "Bash", input: { command: "false" } }] } });
  write({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tc_2", is_error: true, content: [{ type: "text", text: "exit 1" }] }] } });
  const live = messageEnds(events, "toolResult");
  assert.equal(live.length, 1, "原生 toolResult 直播条目");
  assert.equal(live[0].message.toolCallId, "tc_2");
  assert.equal(live[0].message.toolName, "Bash", "toolName 由 toolCallOpen 回填");
  assert.equal(live[0].message.isError, true);
  assert.match(live[0].message.content[0].text, /exit 1/);
  const hist = historyRoles(h, "toolResult");
  assert.equal(hist.length, 1, "toolResult 进 liveHistory（refetch 可折叠配对）");
  assert.equal(hist[0].toolCallId, "tc_2");
  assert.equal(events.some((e) => e.type === "message_end" && e.message?.customType === "❌ 工具失败"), false, "不再发 ❌ custom 卡");
});

test("followUp 能力方法 + queueManage（D2/D3 契约）", async () => {
  const { h, events } = makeHandle();
  await h.prompt("first");
  await h.followUp("queued-a");
  await h.followUp("queued-b");
  await flush();
  assert.deepEqual(events.filter((e) => e.type === "queue_update").at(-1)?.followUp, ["queued-a", "queued-b"]);
  const list = await h.queueManage({ action: "list" });
  assert.deepEqual(list.followUp, ["queued-a", "queued-b"]);
  const recalled = await h.queueManage({ action: "recall", index: 0 });
  assert.equal(recalled.entry.text, "queued-a");
  assert.equal(h.capabilities.followUp, true);
  assert.equal(h.capabilities.queueManage, true);
  assert.throws(() => h.steer(), /not supported/);
});

// ---- 加固回归（docs/pi-web-ext-agent-family-hardening-plan.md 阶段 1/2）-----------

test("加固 A4: stdin.write 返回 false（背压）≠ 失败——大帧 prompt 不再误报 stdin closed", async () => {
  const stdout = new PassThrough();
  const child = {
    stdout,
    stderr: { on() {} },
    once() {},
    stdin: { write: () => false, writable: true }, // 恒背压（>16KB 帧的常态）
    kill() {},
    exitCode: null,
  };
  const h = new ClaudeCodeHandle("claude:new-bp", child, "/tmp", undefined, "claude");
  await h.prompt("a".repeat(64 * 1024)); // 旧实现此处 throw "stdin closed" 且 running 卡死
  assert.equal(h.isRunning(), true, "写成功（入缓冲）后 running 应置位");
  assert.equal(h.alive(), true);
});

test("加固 A4: stdin 不可写 → prompt 抛错且 running 不置位（队列不被卡死）", async () => {
  const child = {
    stdout: new PassThrough(),
    stderr: { on() {} },
    once() {},
    stdin: { writable: false, write: () => { throw new Error("EPIPE"); } },
    kill() {},
    exitCode: null,
  };
  const h = new ClaudeCodeHandle("claude:new-closed", child, "/tmp", undefined, "claude");
  await assert.rejects(h.prompt("hi"), /stdin closed/);
  assert.equal(h.isRunning(), false, "写失败 running 必须保持 false");
});

test("加固 A2: stdout 流 error → session_backend_dead（不再崩宿主进程）", async () => {
  const { h, events } = makeHandle();
  h.child.stdout.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
  await flush();
  assert.equal(h.alive(), false);
  assert.match(events.find((e) => e.type === "session_backend_dead")?.reason ?? "", /stdout error/);
});

test("加固 A3: 单个订阅者抛错不漏帧、不裸抛（后续订阅者照常收帧）", async () => {
  const { h, write } = makeHandle();
  const got = [];
  h.subscribe(() => { throw new Error("listener boom"); });
  h.subscribe((e) => got.push(e));
  write({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
  await flush();
  assert.equal(got.length >= 1, true, "第二个订阅者应照常收到帧");
});

// ---- 上下文用量（docs/pi-web-external-agent-context-usage-plan.md）----

test("contextUsage: result 帧 usage → getContextUsage（input 侧三项相加 / 模型窗口）+ getUsageTotals 累计", async () => {
  const { h, write } = makeHandle();
  assert.equal(h.getContextUsage(), undefined, "首轮 result 未到 → undefined（空轨态）");

  write({ type: "result", subtype: "success", is_error: false,
    usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 500, cache_creation_input_tokens: 60 },
    total_cost_usd: 0.05, num_turns: 2 });
  await flush();

  const cu = h.getContextUsage();
  assert.ok(cu, "result 后有数据");
  assert.equal(cu.tokens, 660, "input + cacheRead + cacheWrite");
  assert.equal(cu.contextWindow, 200_000, "默认 claude 窗口");
  assert.ok(Math.abs(cu.percent - (660 / 200_000) * 100) < 1e-9);

  const totals = h.getUsageTotals();
  assert.equal(totals.inputTokens, 100);
  assert.equal(totals.outputTokens, 40);
  assert.equal(totals.cacheReadTokens, 500);
  assert.equal(totals.cacheWriteTokens, 60);
  assert.equal(totals.costUsd, 0.05);
  assert.equal(totals.turns, 1);

  // 第二轮：累计叠加
  write({ type: "result", subtype: "success", is_error: false,
    usage: { input_tokens: 30, output_tokens: 10 }, total_cost_usd: 0.02, num_turns: 1 });
  await flush();
  const t2 = h.getUsageTotals();
  assert.equal(t2.inputTokens, 130);
  assert.equal(t2.turns, 2);
  const cu2 = h.getContextUsage();
  assert.equal(cu2.tokens, 30, "contextUsage 只看最近一轮（当前上下文占用）");
});

test("contextUsage: [1m] 模型 → 1M 窗口；全零 usage → undefined（不报 0%）", async () => {
  const { h, write } = makeHandle();
  h.model = { id: "claude-sonnet-4-5[1m]", provider: "claude" };
  write({ type: "result", subtype: "success", is_error: false,
    usage: { input_tokens: 1_500_000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    total_cost_usd: 1 });
  await flush();
  const cu = h.getContextUsage();
  assert.equal(cu.contextWindow, 1_000_000);
  assert.equal(cu.percent, 100, "封顶 100%");
});

const IMG = { type: "image", data: "QUJD", mimeType: "image/png" };
const MIRRORED = { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } };

test("prompt 带图：出站帧不变，liveHistory 镜像落宿主同形 base64 块", async () => {
  const { h, stdinWrites } = makeHandle();
  await h.prompt("这个按钮错位了", { images: [IMG] });
  const sent = JSON.parse(stdinWrites.at(-1));
  assert.deepEqual(sent.message.content, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
    { type: "text", text: "这个按钮错位了" },
  ], "CC 出站形状不变");
  const user = historyRoles(h, "user").at(-1);
  assert.deepEqual(user.content, [{ type: "text", text: "这个按钮错位了" }, MIRRORED],
    "镜像与宿主乐观气泡同形（否则 userMessageKey 对不上，图被纯文本顶替）");
});

test("prompt 只有图没有文字：镜像只带图块（无图时保持字符串 content）", async () => {
  const { h } = makeHandle();
  await h.prompt("", { images: [IMG] });
  assert.deepEqual(historyRoles(h, "user").at(-1).content, [MIRRORED]);
  // Separate handle: the first one is now running, so a second prompt there queues.
  const { h: h2 } = makeHandle();
  await h2.prompt("纯文字");
  assert.equal(historyRoles(h2, "user").at(-1).content, "纯文字", "老形状不变");
});

test("prelude：jsonl 里的图片块进历史，纯图行不丢", async () => {
  const home = mkdtempSync(join(tmpdir(), "cc-prelude-"));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  // Sandboxed home: set HOME and USERPROFILE together (red line — Windows resolves the latter).
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const dir = join(home, ".claude", "projects", "-tmp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sid-img.jsonl"), [
      JSON.stringify({ type: "user", timestamp: "2026-11-26T00:00:00.000Z", message: { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        { type: "text", text: "这个按钮错位了" },
      ] } }),
      JSON.stringify({ type: "user", timestamp: "2026-11-26T00:00:01.000Z", message: { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "RUVF" } },
      ] } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-11-26T00:00:02.000Z", message: { role: "assistant", model: "glm-5.2", content: [{ type: "text", text: "看到了" }] } }),
    ].join("\n") + "\n");

    const { h } = makeHandle("claude:sid-img");
    const history = await h.getMessages();
    const users = history.filter((m) => m?.role === "user");
    assert.equal(users.length, 2, "纯图行也是真实消息");
    assert.deepEqual(users[0].content, [{ type: "text", text: "这个按钮错位了" }, MIRRORED]);
    assert.deepEqual(users[1].content, [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "RUVF" } }]);
    assert.equal(history.filter((m) => m?.role === "assistant").length, 1);
  } finally {
    if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
    if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.USERPROFILE;
    rmSync(home, { recursive: true, force: true });
  }
});

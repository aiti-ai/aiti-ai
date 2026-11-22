/**
 * aiti-codex-agent tests — handle wire 契约（假 CLI 桩），零网络零真凭据。
 *
 * Run: node --test pi-web-ext/aiti-codex-agent/codex-wire.test.mjs
 * （node 24 原生 TS strip-types，import .ts 与 zcode-core.test.mjs 同款）
 *
 * 桩机制：CODEX_CLI_PATH 指向 stub 脚本（绝对路径 → resolveCodexBin 短路 which 探测），
 * 按需延迟打印 codex exec --json 事件流；EXT_MODEL_STATE_DIR 隔离状态文件。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---- 环境隔离（先于 import 被测模块设置）------------------------------------
const ROOT = mkdtempSync(join(tmpdir(), "codex-agent-test-"));
process.env.EXT_MODEL_STATE_DIR = join(ROOT, "ext-model-state");

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.CODEX_CLI_PATH;
});

/** 写一个 codex CLI 桩：打印 thread.started → 延迟 → agent_message + turn.completed。 */
function writeStub(dir, name, delayMs) {
  const stub = join(dir, name);
  writeFileSync(stub, `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.length - 1];
const isResume = args.includes("resume");
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread-1" }) + "\\n");
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "echo:" + prompt + (isResume ? "(r)" : "") } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 2 } }) + "\\n");
  process.exit(0);
}, ${delayMs});
`);
  chmodSync(stub, 0o755);
  return stub;
}

/** 桩 CLI：原样打印给定事件行（直播工具帧形态取证用；行体来自真机 codex exec 捕获）。 */
function writeEventStub(dir, name, lines) {
  const stub = join(dir, name);
  writeFileSync(stub, `#!/usr/bin/env node
const lines = ${JSON.stringify(lines)};
for (const l of lines) process.stdout.write(l + "\\n");
process.exit(0);
`);
  chmodSync(stub, 0o755);
  return stub;
}

/** 注册扩展（截获 sessionProviders.register）并建 handle。 */
async function setup(cliPath) {
  process.env.CODEX_CLI_PATH = cliPath;
  const mod = await import("./index.ts");
  let registered;
  mod.default.server.startup({
    sessionProviders: { register: (p) => { registered = p; return "test"; } },
  });
  return registered;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// wire：运行中排队 + agent_start/agent_end 事件对
// ============================================================================

test("handle wire: 运行中排队（queue_update + settle 后自动续轮）+ 事件对配平", async () => {
  const stubDir = join(ROOT, "queue-stubs");
  mkdirSync(stubDir, { recursive: true });
  const registered = await setup(writeStub(stubDir, "slow.cjs", 600));
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));

  const p1 = handle.prompt("第一轮");
  await wait(200);
  assert.equal(handle.isRunning(), true);
  // 运行中再发两条 → 排队不报错（改前 throw「turn already running」）
  await handle.prompt("第二轮(排队)");
  await handle.prompt("第三轮(排队)");
  assert.equal((await handle.getMessages()).filter((m) => m.role === "user").length, 1, "排队消息暂不进 liveHistory");
  assert.ok(events.some((e) => e.type === "queue_update" && e.followUp?.length === 2), "queue_update 同步排队区");

  await p1;
  // settle 后自动续轮：等待排队轮全部完成（user 入账在轮开始，事件配平须等轮收敛）
  for (let i = 0; i < 50 && (await handle.getMessages()).filter((m) => m.role === "user").length < 3; i++) await wait(100);
  for (let i = 0; i < 50 && handle.isRunning(); i++) await wait(100);
  const msgs = await handle.getMessages();
  assert.equal(msgs.filter((m) => m.role === "user").length, 3, "排队消息全部落 liveHistory");
  assert.ok(JSON.stringify(msgs).includes("(r)"), "续轮走 resume（thread 已知）");

  // 事件对配平：3 轮 = 3×start / 3×end / 3×settled，且 start 在 end 前
  const starts = events.filter((e) => e.type === "agent_start");
  const ends = events.filter((e) => e.type === "agent_end");
  const settleds = events.filter((e) => e.type === "agent_settled" && e.stopReason === "end_turn");
  assert.equal(starts.length, 3, "每轮一个 agent_start");
  assert.equal(ends.length, 3, "每轮一个 agent_end");
  assert.equal(settleds.length, 3, "每轮一个 settled(end_turn)");
  assert.ok(events.findIndex((e) => e.type === "agent_start") < events.findIndex((e) => e.type === "agent_end"), "start 先于 end");

  // usage（turn.completed → getUsage）
  assert.equal(handle.getUsage()?.inputTokens, 10);
  await handle.dispose();
});

test("handle wire: queueManage CRUD（T3 共享层接入）", async () => {
  const stubDir = join(ROOT, "qm-stubs");
  mkdirSync(stubDir, { recursive: true });
  const registered = await setup(writeStub(stubDir, "slow.cjs", 800));
  const handle = await registered.createSession({ cwd: ROOT });
  const p1 = handle.prompt("长轮");
  await wait(200);
  assert.equal(handle.isRunning(), true);

  // 排队 3 条（带图一条——R4 同款闭环：codex pending 原先丢图片）
  const imgs = [{ data: "QQ==", mimeType: "image/png" }];
  await handle.prompt("a", { images: imgs });
  await handle.followUp?.("b");
  await handle.prompt("c");
  const l1 = await handle.queueManage({ action: "list" });
  assert.deepEqual(l1.steering, [], "codex 无 steer 组");
  assert.deepEqual(l1.followUp, ["a", "b", "c"]);

  // move + remove（removed QueueTrashItem 形状）
  await handle.queueManage({ action: "move", from: 0, to: 2 });
  const rm = await handle.queueManage({ action: "remove", index: 1 });
  assert.equal(rm.entry.text, "c", "move 后 [b,c,a]，index1=c");
  assert.equal(rm.removed.kind, "followUp");
  assert.equal(rm.removed.hasImages, false, "c 无图 → hasImages false");
  const l2 = await handle.queueManage({ action: "list" });
  assert.deepEqual(l2.followUp, ["b", "a"]);
  // R4 闭环：带图条目 remove → entry.images 保留 + removed.hasImages=true
  const rm2 = await handle.queueManage({ action: "remove", index: 1 });
  assert.equal(rm2.entry.text, "a");
  assert.deepEqual(rm2.entry.images, imgs, "图片随条目保留");
  assert.equal(rm2.removed.hasImages, true);
  assert.deepEqual(rm2.entry.images[0], { data: "QQ==", mimeType: "image/png" });

  // capabilities 声明
  assert.equal(handle.capabilities.queueManage, true);

  await p1;
  for (let i = 0; i < 50 && handle.isRunning(); i++) await wait(100);
  await handle.dispose();
});

// ============================================================================
// wire：abort 真 kill（改前只 console.warn 不杀）
// ============================================================================

test("handle wire: abort SIGTERM 杀当前轮进程（settled 归为 aborted）", async () => {
  const stubDir = join(ROOT, "abort-stubs");
  mkdirSync(stubDir, { recursive: true });
  const registered = await setup(writeStub(stubDir, "slow.cjs", 5000));
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));

  const p = handle.prompt("慢慢跑");
  await wait(300);
  assert.equal(handle.isRunning(), true);
  const t0 = Date.now();
  await handle.abort();
  await p;
  assert.ok(Date.now() - t0 < 2000, "abort 后本轮很快 settle（SIGTERM 生效，非等 5s 桩跑完）");
  const settled = events.filter((e) => e.type === "agent_settled").at(-1);
  assert.equal(settled?.stopReason, "aborted", "settled 归为 aborted");
  assert.ok(events.some((e) => e.type === "agent_end"), "abort 路径也发 agent_end");
  assert.equal(handle.isRunning(), false);
  await handle.dispose();
});

test("handle wire: 空闲时 abort 补发 aborted 收口帧（失步兜底——停止按钮悬挂防御）", async () => {
  const stubDir = join(ROOT, "idle-abort-stubs");
  mkdirSync(stubDir, { recursive: true });
  const registered = await setup(writeStub(stubDir, "slow.cjs", 30));
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));

  await handle.abort(); // 从未 prompt——handle 空闲，走失步兜底路径
  const settled = events.filter((e) => e.type === "agent_settled");
  assert.equal(settled.length, 1, "恰好一帧 settled 收口");
  assert.equal(settled[0].stopReason, "aborted", "兜底帧归为 aborted");
  const endIdx = events.findIndex((e) => e.type === "agent_end");
  assert.ok(endIdx >= 0 && endIdx < events.indexOf(settled[0]), "agent_end 先于 settled（同正常收口序）");
  assert.equal(handle.isRunning(), false);
  await handle.dispose();
});

// ============================================================================
// wire：历史回放 + 会话真实模型恢复（services.sessions 桩；缺席 fail-silent）
// ============================================================================

test("handle wire: createSession 接管回放 seedHistory + meta.model 恢复（services.sessions 桩；缺席 fail-silent）", async () => {
  const stubDir = join(ROOT, "replay-stubs");
  mkdirSync(stubDir, { recursive: true });
  const registered = await setup(writeStub(stubDir, "slow.cjs", 30));

  // 桩 session-manager 服务出口：rollout 解析形态（messages + meta.model）
  globalThis.__piWebExt = {
    byId: (id) => id === "session-manager"
      ? {
          ext: {
            services: {
              sessions: {
                parseSession: async () => ({
                  meta: { model: "gpt-5.1-codex" },
                  messages: [
                    { role: "user", text: "历史问题" },
                    {
                      role: "assistant",
                      text: '🛠 exec_command {"cmd":"ls"}',
                      toolName: "exec_command",
                      tool: { callID: "call-1", name: "exec_command", input: { cmd: "ls" }, output: "a.txt" },
                    },
                    { role: "assistant", text: "历史回答", model: "gpt-5.1-codex", provider: "codex" },
                  ],
                }),
              },
            },
          },
        }
      : undefined,
  };
  const h3 = await registered.createSession({ cwd: ROOT, sessionId: "thread-abc" });
  const msgs = await h3.getMessages();
  assert.equal(msgs.length, 4, "历史回填四条（工具行展开成调用+结果两条）");
  assert.deepEqual(msgs[0], { role: "user", content: "历史问题" });
  assert.deepEqual(msgs[1], {
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "call-1", toolName: "exec_command", input: { cmd: "ls" } }],
  }, "结构化工具行 → pi 原生 toolCall（宿主渲成工具卡片，不是 🛠 文本）");
  assert.equal(msgs[2].role, "toolResult");
  assert.equal(msgs[2].toolCallId, "call-1", "结果按 callID 与调用配对");
  assert.deepEqual(msgs[2].content, [{ type: "text", text: "a.txt" }]);
  assert.equal(msgs[3].content[0].text, "历史回答");
  assert.equal(msgs[3].model, "gpt-5.1-codex", "assistant 带 model（消息模型标签）");
  assert.equal(h3.getModel()?.id, "gpt-5.1-codex", "meta.model 恢复（无 init 帧后端的选择器真实模型源）");
  await h3.dispose();

  // 显式 model 优先于 meta.model
  const h3b = await registered.createSession({ cwd: ROOT, sessionId: "thread-abc", model: { provider: "codex", id: "gpt-5.1" } });
  assert.equal(h3b.getModel()?.id, "gpt-5.1");
  await h3b.dispose();

  // 缺席 fail-silent：byId 无 session-manager → 不回放不报错（无默认种子是既有行为：无 -m 时
  // 用用户 config.toml 的默认模型，handle.model 允许为 undefined）
  globalThis.__piWebExt.byId = () => undefined;
  const h4 = await registered.createSession({ cwd: ROOT, sessionId: "thread-xyz" });
  assert.deepEqual(await h4.getMessages(), []);
  await h4.dispose();
  delete globalThis.__piWebExt;
});

// ============================================================================
// 方案 X（2026-09-22）：直播工具条目原生化——帧体取自真机 codex exec 0.149.1 捕获
// （隔离 CODEX_HOME 跑 `echo LIVE-PROBE-OK`；/tmp/codex-live-probe/stdout.jsonl）。
// 冷回放（seedHistory）已是原生卡，直播再出 🛠/✅❌ custom 卡 = 同一会话两种形态。
// ============================================================================

const THREAD_START = JSON.stringify({ type: "thread.started", thread_id: "stub-thread-tool" });
const TURN_DONE = JSON.stringify({ type: "turn.completed", usage: {} });
const CMD_STARTED = JSON.stringify({
  type: "item.started",
  item: { id: "item_1", type: "command_execution", command: "/bin/bash -lc 'echo LIVE-PROBE-OK'", aggregated_output: "", exit_code: null, status: "in_progress" },
});
const cmdDone = (over = {}) => JSON.stringify({
  type: "item.completed",
  item: { id: "item_1", type: "command_execution", command: "/bin/bash -lc 'echo LIVE-PROBE-OK'", aggregated_output: "LIVE-PROBE-OK\n", exit_code: 0, status: "completed", ...over },
});

/** 建 handle → 打印给定事件行 → 返回（handle, 事件流, liveHistory）。 */
async function runEvents(dirName, lines) {
  const stubDir = join(ROOT, dirName);
  mkdirSync(stubDir, { recursive: true });
  const registered = await setup(writeEventStub(stubDir, "ev.cjs", [THREAD_START, ...lines, TURN_DONE]));
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));
  await handle.prompt("跑个命令");
  return { handle, events, msgs: await handle.getMessages() };
}

const toolCalls = (msgs) => msgs.filter((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "toolCall"));

test("方案 X 直播: item.started/completed → 原生 toolCall+toolResult 同 id 配对（无 custom 卡）", async () => {
  const { handle, events, msgs } = await runEvents("tool-stub-pair", [CMD_STARTED, cmdDone()]);
  const calls = toolCalls(msgs);
  assert.equal(calls.length, 1, "调用条目恰好一条");
  assert.deepEqual(calls[0].content[0], {
    type: "toolCall", toolCallId: "item_1", toolName: "exec_command", input: { cmd: "/bin/bash -lc 'echo LIVE-PROBE-OK'" },
  }, "命名/入参键形对齐 rollout function_call（冷回放同款），宿主按 cmd 出预览");
  const res = msgs.find((m) => m.role === "toolResult");
  assert.equal(res?.toolCallId, "item_1", "结果与调用同 id → ToolCallBlock 折叠成一张卡");
  assert.equal(res?.toolName, "exec_command");
  assert.equal(res?.content[0].text, "LIVE-PROBE-OK", "输出收掉尾换行");
  assert.equal(res?.isError, undefined, "exit 0 不标错误");
  const liveEnds = events.filter((e) => e.type === "message_end");
  assert.equal(liveEnds.length, 2, "直播恰好两条（调用 + 结果）");
  assert.equal(events.some((e) => e.type === "message_end" && e.message?.customType), false, "不再发 🛠/✅❌ custom 工具卡");
  assert.ok(events.some((e) => e.type === "tool_execution_end" && e.toolName === "bash"), "tool_execution_end 保留（宿主统计面口径不变）");
  await handle.dispose();
});

test("方案 X 直播: exit_code 非 0 → isError；空白输出 → 共享占位（与回放同口径）", async () => {
  const { handle, msgs } = await runEvents("tool-stub-fail", [CMD_STARTED, cmdDone({ aggregated_output: "", exit_code: 1, status: "failed" })]);
  const res = msgs.find((m) => m.role === "toolResult");
  assert.equal(res?.isError, true, "退出码非 0 标错误（卡片红框）");
  assert.equal(res?.content[0].text, "(工具执行失败)", "空白失败输出给失败占位，不渲空卡");
  await handle.dispose();
});

test("方案 X 直播: started 帧缺席 → completed 补发调用条，结果不孤立", async () => {
  const { handle, events, msgs } = await runEvents("tool-stub-noop", [cmdDone()]);
  assert.equal(toolCalls(msgs).length, 1, "补发一条调用条目");
  assert.equal(toolCalls(msgs)[0].content[0].toolCallId, "item_1");
  assert.equal(msgs.find((m) => m.role === "toolResult")?.toolCallId, "item_1", "补发的调用与结果同 id");
  assert.equal(events.filter((e) => e.type === "message_end").length, 2);
  await handle.dispose();
});

test("方案 X 直播: file_change → apply_patch 命名 + 路径入参（宿主 patch 分流依赖此名）", async () => {
  const fileChange = JSON.stringify({
    type: "item.completed",
    item: { id: "item_2", type: "file_change", changes: [{ path: "a.ts", kind: "update" }, { path: "b.ts", kind: "add" }], status: "completed" },
  });
  const { handle, msgs } = await runEvents("tool-stub-patch", [fileChange]);
  const call = toolCalls(msgs)[0];
  assert.equal(call.content[0].toolName, "apply_patch", "isApplyPatchToolName 要吃到这个名字才出 split diff 位");
  assert.deepEqual(call.content[0].input, { changes: "a.ts, b.ts" });
  assert.equal(msgs.find((m) => m.role === "toolResult")?.content[0].text, "(工具执行完成，无文本输出)", "file_change 无聚合输出 → 完成占位");
  await handle.dispose();
});

// ============================================================================
// 加固回归：prompt 走 stdin `-` 契约（真 CLI 行为镜像——argv 不带 prompt 文本）
// ============================================================================

test("handle wire: prompt 经 stdin 投递（argv 尾参为 '-'；ps 不可见 / '- ' 开头不误解析）", async () => {
  const stubDir = join(ROOT, "stdin-stubs");
  mkdirSync(stubDir, { recursive: true });
  // 桩按真 codex `-` 契约：从 stdin 读 prompt；回显 stdin 内容 + argv 尾参
  const stub = join(stubDir, "stdin-echo.cjs");
  writeFileSync(stub, `#!/usr/bin/env node
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread-stdin" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "stdin:" + stdin + "|lastArg:" + args[args.length - 1] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: {} }) + "\\n");
  process.exit(0);
});
`);
  chmodSync(stub, 0o755);
  const registered = await setup(stub);
  const handle = await registered.createSession({ cwd: ROOT });
  await handle.prompt("--dash-leading 中文内容"); // 旧 argv 投递下会被 CLI 当 flag 误解析
  for (let i = 0; i < 50 && handle.isRunning(); i++) await wait(100);
  const assistant = (await handle.getMessages()).find((m) => m.role === "assistant");
  const text = assistant?.content?.map((b) => b.text ?? "").join("") ?? "";
  assert.ok(text.includes("stdin:--dash-leading 中文内容"), "prompt 应经 stdin 完整到达");
  assert.ok(text.includes("lastArg:-"), "argv 尾参应为 '-'（文本不进 argv）");
  await handle.dispose();
});

// ============================================================================
// 上下文用量（docs/pi-web-external-agent-context-usage-plan.md）
// ============================================================================

test("handle wire: turn.completed usage → getContextUsage（input+output，cached 不重复加）+ getUsageTotals 累计", async () => {
  const stubDir = join(ROOT, "ctx-stubs");
  mkdirSync(stubDir, { recursive: true });
  const registered = await setup(writeStub(stubDir, "ctx.cjs", 10));
  const handle = await registered.createSession({ cwd: ROOT });
  assert.equal(handle.getContextUsage(), undefined, "首轮未完成 → undefined（空轨态）");

  await handle.prompt("ctx 一轮");
  const cu = handle.getContextUsage();
  assert.ok(cu, "turn.completed 后有数据");
  assert.equal(cu.tokens, 15, "input 10 + output 5（cached 2 ⊆ input，不重复相加）");
  assert.equal(cu.contextWindow, 272_000, "gpt-5 族缺省窗口");
  assert.ok(cu.percent > 0 && cu.percent <= 100);

  const totals = handle.getUsageTotals();
  assert.equal(totals.inputTokens, 10);
  assert.equal(totals.outputTokens, 5);
  assert.equal(totals.cacheReadTokens, 2);
  assert.equal(totals.turns, 1);
  await handle.dispose();
});

test("codexContextWindow: gpt-4 族 128K / gpt-5 族与未知 272K", async () => {
  const { codexContextWindow } = await import("./index.ts");
  assert.equal(codexContextWindow("gpt-5.1-codex"), 272_000);
  assert.equal(codexContextWindow("gpt-4.1"), 128_000);
  assert.equal(codexContextWindow(undefined), 272_000);
});

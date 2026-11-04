/**
 * aiti-qoder-agent — 会话应答链单测（CC 族 control_request/can_use_tool → 统一 interaction_* 契约）。
 *
 * 钉死行为（2026-09-19 挂 5 小时事故的三条根因）：
 *   1. can_use_tool 按工具语义出 kind（授权/提问/方案审批），提问必须带 questions、
 *      答案必须回填 updatedInput（否则 AskUserQuestion 是「能点不能答」的假支持）；
 *   2. 未决请求跨订阅存活：前端刷新后卡片不在而 CLI 还在等 → subscribe 幂等重发同 requestId；
 *   3. result 收口 / 进程死亡 → interaction_expired 解锁前端（已应答的不重复作废）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/qoder-interaction.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

// 状态写盘隔离：init 帧换绑（占位 id → s-plan/s-mode）会 rename 模型状态文件并持久化
// selected，不隔离就写进真实 ~/.pi/agent/ext-agents（把线上 qoder 的 last-used 模型刷成夹具值）。
const sandbox = mkdtempSync(join(tmpdir(), "qoder-interaction-"));
process.env.EXT_MODEL_STATE_DIR = join(sandbox, "ext-agents");
process.env.PI_MODELS_CONFIG_PATH = join(sandbox, "models.json");

const { QoderHandle } = await import("./index.ts");

test.after(() => { rmSync(sandbox, { recursive: true, force: true }); });

function makeHandle(id = "qodercn:new-interaction", { autoSubscribe = true } = {}) {
  const stdout = new PassThrough();
  const written = [];
  const child = {
    stdout,
    stderr: { on() {} },
    once() {},
    stdin: { write: (s) => { written.push(s); return true; }, writable: true, on() {} },
    kill() {},
    exitCode: null,
  };
  const h = new QoderHandle(id, child, null, "/tmp", "cn");
  const events = [];
  const subscribe = () => h.subscribe((e) => events.push(e));
  if (autoSubscribe) subscribe();
  const write = (frame) => stdout.write(JSON.stringify(frame) + "\n");
  const frames = () => written.map((s) => JSON.parse(s));
  return { h, events, write, frames, subscribe };
}

const flush = () => new Promise((r) => setTimeout(r, 5));
const asks = (events, kind) => events
  .filter((e) => e.type === "interaction_request" && (!kind || e.kind === kind));
const cards = (events) => events
  .filter((e) => e.type === "message_end" && e.message?.customType === "🔐 会话请求")
  .map((e) => e.message);
const sentResponse = (frames, requestId) => frames
  .filter((f) => f.type === "control_response" && f.response?.request_id === requestId)
  .map((f) => f.response.response);

const REQ = (requestId, toolName, input) => ({
  type: "control_request",
  request_id: requestId,
  request: { subtype: "can_use_tool", tool_name: toolName, input },
});
const BASH = REQ("r1", "Bash", { command: "rm -rf /tmp/x", description: "清理" });

test("can_use_tool（普通工具）→ interaction_request kind=tool_auth + 消息流 pending 卡", async () => {
  const { h, events, write } = makeHandle();
  write(BASH);
  await flush();

  const req = asks(events, "tool_auth")[0];
  assert.equal(req?.requestId, "r1");
  assert.equal(req?.capability, "respondInteraction");
  assert.equal(req?.toolName, "Bash");
  assert.equal(req?.input?.command, "rm -rf /tmp/x");

  const traced = cards(events);
  assert.equal(traced.length, 1);
  assert.equal(traced[0].details.decision, "pending");
  assert.equal(traced[0].details.kind, "tool_auth");
  assert.match(traced[0].content, /Bash — command=rm -rf \/tmp\/x/);
  assert.equal(h.liveHistory.at(-1)?.customType, "🔐 会话请求");
});

test("respondInteraction：allow/deny 写 control_response；对不上的 id 一律不应答", async () => {
  const { h, events, write, frames } = makeHandle();
  write(BASH);
  write(REQ("r2", "Write", { file_path: "/tmp/x" }));
  await flush();

  assert.equal(await h.respondInteraction("r1", { action: "accept" }), true);
  assert.deepEqual(sentResponse(frames(), "r1"), [{ behavior: "allow" }]);
  assert.equal(cards(events).at(-1).details.decision, "allow");

  assert.equal(await h.respondInteraction("r2", { action: "decline", message: "不许删" }), true);
  assert.deepEqual(sentResponse(frames(), "r2"), [{ behavior: "deny", message: "不许删" }]);
  assert.equal(cards(events).at(-1).details.decision, "deny");

  assert.equal(await h.respondInteraction("r1", { action: "accept" }), false, "重复应答幂等 false");
  assert.equal(await h.respondInteraction("ghost", { action: "accept" }), false, "未知 id 不应答");
  assert.equal(sentResponse(frames(), "ghost").length, 0, "更不往线上写一帧");
});

test("AskUserQuestion：kind=ask_user + questions 上卡；答案回填 updatedInput.answers", async () => {
  const questions = [{ question: "选哪个", header: "方案", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }];
  const { h, events, write, frames } = makeHandle();
  write(REQ("q1", "AskUserQuestion", { questions }));
  await flush();

  const req = asks(events, "ask_user")[0];
  assert.deepEqual(req?.questions, questions, "问题组必须透传，否则前端只能渲染授权卡");
  assert.deepEqual(req?.input?.questions, questions, "原始入参一并带上（前端拒绝时仍可看全文）");

  assert.equal(await h.respondInteraction("q1", { action: "accept", answers: { 选哪个: "B" } }), true);
  assert.deepEqual(sentResponse(frames(), "q1"), [{ behavior: "allow", updatedInput: { questions, answers: { 选哪个: "B" } } }]);
});

test("ExitPlanMode：kind=plan_approval；批准 approved=true，拒绝走 feedback 而不是 deny", async () => {
  const { h, events, write, frames } = makeHandle();
  write(REQ("p1", "ExitPlanMode", {}));
  write(REQ("p2", "ExitPlanMode", {}));
  await flush();
  assert.equal(asks(events, "plan_approval").length, 2);

  assert.equal(await h.respondInteraction("p1", { action: "accept" }), true);
  assert.deepEqual(sentResponse(frames(), "p1"), [{ behavior: "allow", updatedInput: { approved: true } }]);

  assert.equal(await h.respondInteraction("p2", { action: "decline", message: "第二段太粗" }), true);
  assert.deepEqual(sentResponse(frames(), "p2"), [{ behavior: "allow", updatedInput: { approved: false, feedback: "第二段太粗" } }]);
});

test("EnterPlanMode 是授权不是审批卡（实测 allow 即进 plan）", async () => {
  const { events, write } = makeHandle();
  write(REQ("e1", "EnterPlanMode", { reason: "先出方案" }));
  await flush();
  assert.equal(asks(events, "tool_auth").length, 1);
  assert.equal(asks(events, "plan_approval").length, 0);
});

test("消息流留痕可读：reason 上卡、allowedPrompts 摊平（不把 JSON 丢给用户）", async () => {
  const { events, write } = makeHandle();
  write(REQ("t1", "EnterPlanMode", { reason: "用户要求进入 plan 模式" }));
  write(REQ("t2", "ExitPlanMode", { allowedPrompts: [{ prompt: "run tests", tool: "Bash" }] }));
  await flush();

  const traced = cards(events);
  assert.equal(traced.length, 2);
  assert.match(traced[0].content, /EnterPlanMode — reason=用户要求进入 plan 模式/);
  assert.match(traced[1].content, /方案审批 — allowedPrompts=run tests\(Bash\)/);
  assert.doesNotMatch(traced[1].content, /\{"allowedPrompts"/, "原始 JSON 不得出现在留痕里");
});

test("刷新/重连后卡片必须回来：subscribe 幂等重发未决（同 requestId，不新造）", async () => {
  const { events, write, subscribe } = makeHandle("qodercn:new-replay", { autoSubscribe: false });
  write(BASH);
  await flush();
  assert.equal(asks(events).length, 0, "没订阅时事件不外泄（账本已记账，不会丢）");

  subscribe();
  await flush();
  const replayed = asks(events, "tool_auth");
  assert.equal(replayed.length, 1, "订阅时补发未决——CLI 还在等，不补发就是永久挂起");
  assert.equal(replayed[0].requestId, "r1", "必须复用 CLI 原 request_id，自造即失配");

  subscribe();
  await flush();
  assert.equal(asks(events, "tool_auth").length, 2, "第二条订阅同样收到（多端一致），仍是同 id");
  assert.equal(new Set(asks(events).map((e) => e.requestId)).size, 1);
});

test("已应答的请求不得在 result 收口时再冒 expired；未决的逐个作废", async () => {
  const { h, events, write } = makeHandle();
  write(BASH);
  write(REQ("r2", "Write", { file_path: "/tmp/x" }));
  await flush();
  await h.respondInteraction("r1", { action: "accept" });
  events.length = 0;

  write({ type: "result", result: "done" });
  await flush();
  const expired = events.filter((e) => e.type === "interaction_expired").map((e) => e.requestId);
  assert.deepEqual(expired, ["r2"], "已应答的 r1 不得重复作废");
  assert.equal(events.find((e) => e.type === "interaction_expired")?.reason, "turn_end");
  assert.equal(cards(events).filter((m) => m.details.decision === "cancelled").length, 1);
});

test("进程死亡：未决应答以 reason=dead 作废解锁前端", async () => {
  const { h, events, write } = makeHandle();
  write(BASH);
  await flush();
  h.markDead("process exited (0)");
  await flush();
  const dead = events.find((e) => e.type === "interaction_expired");
  assert.equal(dead?.requestId, "r1");
  assert.equal(dead?.reason, "dead");
  assert.equal(events.at(-1)?.type, "session_backend_dead");
});

test("plan_mode_changed 帧 → permission_mode_changed 徽标（进 plan 显示 plan，出 plan 回原档）", async () => {
  const { h, events, write } = makeHandle();
  write({ type: "system", subtype: "init", session_id: "s-plan", model: "m", permissionMode: "bypassPermissions" });
  await flush();
  write({ type: "system", subtype: "plan_mode_changed", plan_mode: { active: true } });
  await flush();
  assert.equal(events.filter((e) => e.type === "permission_mode_changed").at(-1)?.mode, "plan");
  assert.equal(h.getPermissionMode(), "plan");

  write({ type: "system", subtype: "plan_mode_changed", plan_mode: { active: false } });
  await flush();
  assert.equal(events.filter((e) => e.type === "permission_mode_changed").at(-1)?.mode, "bypassPermissions");
  assert.equal(h.getPermissionMode(), "bypassPermissions");
});

test("setPermissionMode 接受 plan（独立状态机），未知档仍然 fail-loud", async () => {
  const { h, write, frames } = makeHandle();
  write({ type: "system", subtype: "init", session_id: "s-mode", permissionMode: "bypassPermissions" });
  await flush();
  const pending = h.setPermissionMode("plan");
  const reqFrame = frames().at(-1);
  assert.equal(reqFrame.request.subtype, "set_permission_mode");
  assert.equal(reqFrame.request.mode, "plan");
  write({ type: "control_response", response: { subtype: "success", request_id: reqFrame.request_id } });
  assert.equal(await pending, true);
  await assert.rejects(() => h.setPermissionMode("nope"), /非法权限模式/);
});

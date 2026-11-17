/**
 * aiti-qoder-agent — 权限请求链单测（ACP session/request_permission 形态）。
 *
 * 钉死行为（2026-11-13 ACP 重写）：
 *   1. request_permission → interaction_request（kind 派生）+ 消息流 pending 卡；
 *   2. respondInteraction(accept/decline) → 按 JSON-RPC id 精确应答（allow/deny 选项）；
 *      对不上的 id 一律不应答、不重复应答；
 *   3. 刷新/重连后未决卡片 subscribe 补发（同 requestId）；
 *   4. 回合收口/进程死亡：未决逐个作废（turn_end / dead），已应答的不重复作废；
 *   5. current_mode_update → permission_mode_changed 徽标；plan 档 ACP 不可用返 false。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/qoder-interaction.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 状态写盘隔离（session/new 换绑会 rename 模型状态文件）：不隔离就写进真实 ~/.pi/agent/ext-agents。
const sandbox = mkdtempSync(join(tmpdir(), "qoder-interaction-"));
process.env.EXT_MODEL_STATE_DIR = join(sandbox, "ext-agents");
process.env.PI_MODELS_CONFIG_PATH = join(sandbox, "models.json");

const { QoderHandle } = await import("./index.ts");
const { makeReadyHandle, flush } = await import("./qoder-acp-stub.mjs");

test.after(() => { rmSync(sandbox, { recursive: true, force: true }); });

const asks = (events, kind) => events
  .filter((e) => e.type === "interaction_request" && (!kind || e.kind === kind));
const cards = (events) => events
  .filter((e) => e.type === "message_end" && e.message?.customType === "🔐 会话请求")
  .map((e) => e.message);

/** 权限请求桩（Bash 工具形态）。 */
const PERM = (stub, rawId, toolName, input) => stub.request("session/request_permission", {
  options: [
    { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
    { optionId: "opt-deny", name: "Deny", kind: "deny_once" },
  ],
  toolCall: { toolCallId: `tc-${rawId}`, title: toolName, rawInput: input, _meta: { qoder: { toolName } } },
});

test("request_permission（普通工具）→ interaction_request kind=tool_auth + 消息流 pending 卡", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle);
  PERM(stub, 1, "Bash", { command: "rm -rf /tmp/x", description: "清理" });
  await flush();

  const req = asks(events, "tool_auth")[0];
  assert.equal(req?.capability, "respondInteraction");
  assert.equal(req?.toolName, "Bash");
  assert.equal(req?.input?.command, "rm -rf /tmp/x");

  const traced = cards(events);
  assert.equal(traced.length, 1);
  assert.equal(traced[0].details.decision, "pending");
  assert.equal(traced[0].details.kind, "tool_auth");
  assert.match(traced[0].content, /Bash — command=rm -rf \/tmp\/x/);
  assert.equal(h.liveHistory.at(-1)?.customType, "🔐 会话请求");
  await h.dispose();
});

test("respondInteraction：accept/deny 按 JSON-RPC id 精确应答；对不上的 id 一律不应答", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle);
  const id1 = PERM(stub, 1, "Bash", { command: "ls" });
  const id2 = PERM(stub, 2, "Write", { file_path: "/tmp/x" });
  await flush();

  assert.equal(await h.respondInteraction(`perm-${id1}`, { action: "accept" }), true);
  assert.equal(cards(events).at(-1).details.decision, "allow");

  assert.equal(await h.respondInteraction(`perm-${id2}`, { action: "decline", message: "不许删" }), true);
  assert.equal(cards(events).at(-1).details.decision, "deny");

  assert.equal(await h.respondInteraction(`perm-${id1}`, { action: "accept" }), false, "重复应答幂等 false");
  assert.equal(await h.respondInteraction("ghost", { action: "accept" }), false, "未知 id 不应答");
  await flush();
  // 桩收到且仅收到两条 response（id 精确对应）
  const responses = stub.sent.filter((f) => f.id === id1 || f.id === id2).filter((f) => f.method === undefined);
  assert.deepEqual(responses.map((f) => f.id), [id1, id2]);
  assert.equal(responses[0].result.outcome.optionId, "opt-allow");
  assert.equal(responses[1].result.outcome.optionId, "opt-deny");
  await h.dispose();
});

test("refresh/重连：未决卡片 subscribe 幂等重发（同 requestId，不新造）", async () => {
  const stub = (await import("./qoder-acp-stub.mjs")).createAcpChild({ autoAnswerPrompt: false });
  const h = new QoderHandle("qodercn:new-replay", stub.child, null, "/tmp", "cn", "/tmp/cli");
  const events = [];
  // 未订阅时先开卡
  await h.startSession({});
  PERM(stub, 1, "Bash", { command: "rm -rf /tmp/x" });
  await flush();
  assert.equal(asks(events).length, 0, "没订阅时事件不外泄（账本已记账，不会丢）");

  const subscribe = () => h.subscribe((e) => events.push(e));
  subscribe();
  await flush();
  const replayed = asks(events, "tool_auth");
  assert.equal(replayed.length, 1, "订阅时补发未决——CLI 还在等，不补发就是永久挂起");
  assert.equal(replayed[0].requestId, "perm-10000", "必须复用原 requestId（perm-<jsonrpcId>），自造即失配");

  subscribe();
  await flush();
  assert.equal(asks(events, "tool_auth").length, 2, "第二条订阅同样收到（多端一致），仍是同 id");
  assert.equal(new Set(asks(events).map((e) => e.requestId)).size, 1);
  await h.dispose();
});

test("已应答的请求不得在回合收口时再冒 expired；未决的逐个作废（turn_end）", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle);
  PERM(stub, 1, "Bash", { command: "ls" });
  PERM(stub, 2, "Write", { file_path: "/tmp/x" });
  await flush();
  await h.respondInteraction("perm-10000", { action: "accept" });
  events.length = 0;

  // 回合收口（跑完一轮 prompt，桩自动应答 end_turn）→ finishTurn failPending("turn_end")
  await h.prompt("done?");
  await flush();
  const expired = events.filter((e) => e.type === "interaction_expired").map((e) => e.requestId);
  assert.deepEqual(expired, ["perm-10001"], "已应答的 perm-10000 不得重复作废");
  assert.equal(events.find((e) => e.type === "interaction_expired")?.reason, "turn_end");
  assert.equal(cards(events).filter((m) => m.details.decision === "cancelled").length, 1);
  await h.dispose();
});

test("进程死亡：未决应答以 reason=dead 作废解锁前端", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle);
  PERM(stub, 1, "Bash", { command: "ls" });
  await flush();
  h.markDead("process exited (0)");
  await flush();
  const dead = events.find((e) => e.type === "interaction_expired");
  assert.equal(dead?.requestId, "perm-10000");
  assert.equal(dead?.reason, "dead");
  assert.equal(events.at(-1)?.type, "session_backend_dead");
  await h.dispose();
});

test("current_mode_update → permission_mode_changed 徽标；setPermissionMode ACP 面", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle);
  // bootstrap 已 set_mode(yolo)：徽标应回 bypassPermissions
  const modeEvents = events.filter((e) => e.type === "permission_mode_changed");
  assert.ok(modeEvents.length >= 1);
  assert.equal(h.getPermissionMode(), "bypassPermissions");

  // CLI 侧模式变更回显（session/current_mode_update 通知）
  stub.writeFrame({ jsonrpc: "2.0", method: "session/current_mode_update", params: { currentModeId: "acceptEdits" } });
  await flush();
  assert.equal(events.filter((e) => e.type === "permission_mode_changed").at(-1)?.mode, "acceptEdits");
  assert.equal(h.getPermissionMode(), "acceptEdits");

  // 运行时切换：setPermissionMode("default") → session/set_mode 帧；未知档 fail-loud；plan 返 false
  assert.equal(await h.setPermissionMode("default"), true);
  const setMode = stub.sent.filter((f) => f.method === "session/set_mode").at(-1);
  assert.equal(setMode.params.modeId, "default");
  assert.equal(await h.setPermissionMode("plan"), false, "plan 档在 ACP 面不可用");
  await assert.rejects(() => h.setPermissionMode("nope"), /非法权限模式/);
  await h.dispose();
});

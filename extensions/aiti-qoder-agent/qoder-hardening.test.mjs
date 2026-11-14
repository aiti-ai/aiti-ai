/**
 * aiti-qoder-agent — 加固行为单测。
 *
 * ACP 驱动（2026-11-13 重写）钉死的行为：
 *   1. lineReader 溢出闸门可达（工具函数层，不受驱动切换影响）；
 *   2. recycle 占位 id 判据（不变）；
 *   3. abort() 空闲态补 aborted 收口帧（停止按钮不得永挂）；
 *   4. abort() cancel 未收口 → 硬杀（SIGTERM→SIGKILL），前端绝不挂在「停止中」；
 *   5. session/new 换绑：占位 id → 真实 sid（session_backend_ready + 模型状态迁移）；
 *   6. 权限请求按 JSON-RPC id 精确应答，respondInteraction 对不上的 id 一律不应答；
 *   7. available_commands_update → getCommands 出口；
 *   8. sidecar 文件名去冒号（NTFS ADS 分隔符）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/qoder-hardening.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

// 状态写盘隔离：session/new 换绑会 rename 模型状态文件并持久化 selected（不隔离就写进真实
// ~/.pi/agent/ext-agents）。必须在 import 扩展前设好（读点在函数调用时，越早越稳）。
const sandbox = mkdtempSync(join(tmpdir(), "qoder-hardening-"));
process.env.EXT_MODEL_STATE_DIR = join(sandbox, "ext-agents");
process.env.PI_MODELS_CONFIG_PATH = join(sandbox, "models.json");

const { QoderHandle, lineReader, parseRecycleId, sidecarBase } = await import("./index.ts");
const { makeReadyHandle, createAcpChild, flush } = await import("./qoder-acp-stub.mjs");

test.after(() => { rmSync(sandbox, { recursive: true, force: true }); });

test("lineReader：单行超阈值 → onOverflow 触发且停止累积（闸门可达，非死代码）", async () => {
  const s = new PassThrough();
  const lines = [];
  let overflow = 0;
  lineReader(s, (line) => lines.push(line), { maxLineBytes: 64, onOverflow: (n) => { overflow = n; } });
  s.write(Buffer.from("A".repeat(200)));
  s.write(Buffer.from("B".repeat(200)));
  await flush();
  assert.equal(lines.length, 0);
  assert.ok(overflow >= 200, `应报出溢出字节数，实得 ${overflow}`);
  // 溢出后彻底哑火（由调用方 markDead 收口）：不得再无限累积
  const before = overflow;
  s.write(Buffer.from("C".repeat(500)));
  await flush();
  assert.equal(overflow, before);
});

test("lineReader：完整行照常切分，跨 chunk 的中文不碎成 U+FFFD", async () => {
  const s = new PassThrough();
  const lines = [];
  lineReader(s, (line) => lines.push(line));
  const buf = Buffer.from('{"t":"中文正文"}\n{"t":"第二行"}\n', "utf8");
  const cut = buf.indexOf(0xe4) + 1; // 落在一个多字节字符中间
  s.write(buf.subarray(0, cut));
  s.write(buf.subarray(cut));
  await flush();
  assert.deepEqual(lines, ['{"t":"中文正文"}', '{"t":"第二行"}']);
});

test("parseRecycleId：占位 id → 空 sessionId（只释放不重建）；真实 sid 直通", () => {
  assert.deepEqual(parseRecycleId("qoder:new-3f2a1b"), { sessionId: "", providerType: "aiti-qoder-agent/qoder" });
  assert.deepEqual(parseRecycleId("qodercn:new-9d3f2a"), { sessionId: "", providerType: "aiti-qoder-agent/qoder-cn" });
  assert.deepEqual(parseRecycleId("qoder:0f3d2c1b-aaaa"), { sessionId: "0f3d2c1b-aaaa", providerType: "aiti-qoder-agent/qoder" });
  assert.deepEqual(parseRecycleId("qodercn:0f3d2c1b-bbbb"), { sessionId: "0f3d2c1b-bbbb", providerType: "aiti-qoder-agent/qoder-cn" });
  assert.equal(parseRecycleId("claude:0f3d2c1b"), null);
});

test("abort()：空闲态也发 aborted 收口帧（前端停止按钮不得永挂）", async () => {
  const { h, events } = await makeReadyHandle(QoderHandle);
  // 先跑完一轮（桩 autoAnswerPrompt 默认开）→ running=false 空闲态
  await h.prompt("hi");
  await flush();
  const before = events.length;
  await h.abort();
  const newEvents = events.slice(before);
  assert.deepEqual(newEvents.map((e) => e.type), ["agent_end", "agent_settled"]);
  assert.equal(newEvents[1].stopReason, "aborted");
  await h.dispose();
});

test("abort()：cancel 后不收口 → 硬杀（SIGTERM→SIGKILL），前端绝不挂在「停止中」", async () => {
  const prevSettle = QoderHandle.CANCEL_SETTLE_TIMEOUT_MS;
  const prevGrace = QoderHandle.HARD_KILL_GRACE_MS;
  QoderHandle.CANCEL_SETTLE_TIMEOUT_MS = 40;
  QoderHandle.HARD_KILL_GRACE_MS = 30;
  try {
    const { h, stub } = await makeReadyHandle(QoderHandle, { stubOpts: { autoAnswerPrompt: false, cancelSilent: true } });
    h.prompt("busy task").catch(() => {});
    await flush();
    assert.equal(stub.pendingPrompts.length, 1, "prompt 应挂起（桩不应答）");
    const kills = [];
    (h).child.kill = (sig) => { kills.push(sig); };
    await h.abort(); // cancel 已写，但桩不回 cancelled → 超时 → 硬杀
    await new Promise((r) => setTimeout(r, 120)); // settle timeout + grace elapsed
    assert.ok(kills.includes("SIGTERM"), "应先 SIGTERM");
    assert.ok(kills.includes("SIGKILL"), "宽限后应 SIGKILL");
    assert.equal(kills.indexOf("SIGTERM"), 0, "SIGTERM 必须先于 SIGKILL");
    const cancelFrame = stub.sent.find((f) => f.method === "session/cancel");
    assert.ok(cancelFrame, "abort 应发出 session/cancel");
  } finally {
    QoderHandle.CANCEL_SETTLE_TIMEOUT_MS = prevSettle;
    QoderHandle.HARD_KILL_GRACE_MS = prevGrace;
  }
});

test("abort()：cancel 正常收口（cancelled 响应）→ agent_settled(aborted)，不硬杀", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle, { stubOpts: { autoAnswerPrompt: false } });
  h.prompt("busy").catch(() => {});
  await flush();
  await h.abort(); // 桩在 session/cancel 时回 stopReason:cancelled
  await flush();
  const settled = events.find((e) => e.type === "agent_settled");
  assert.ok(settled, "收口帧必须到达");
  assert.equal(settled.stopReason, "aborted");
  assert.equal(h.isRunning(), false);
  await h.dispose();
});

test("session/new 换绑：占位 id → 真实 sid（session_backend_ready + agent_start）", async () => {
  const { h, events } = await makeReadyHandle(QoderHandle, { id: "qodercn:new-bind" });
  assert.equal(h.id, "qodercn:sid-stub-1");
  const ready = events.find((e) => e.type === "session_backend_ready");
  assert.equal(ready?.oldId, "qodercn:new-bind");
  assert.equal(ready?.id, "qodercn:sid-stub-1");
  assert.ok(events.some((e) => e.type === "agent_start"), "bootstrap 完成后发 agent_start");
  await h.dispose();
});

test("available_commands_update → getCommands 出口；未知档 fail-loud", async () => {
  const { h, stub } = await makeReadyHandle(QoderHandle);
  stub.notify({
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "goal", description: "Set a goal" }, { name: "compact" }],
  });
  await flush();
  const cmds = await h.getCommands();
  assert.deepEqual(cmds, [
    { name: "goal", description: "Set a goal", source: "skill" },
    { name: "compact", source: "skill" },
  ]);
  await assert.rejects(() => h.setPermissionMode("nonsense"), /非法权限模式/);
  assert.equal(await h.setPermissionMode("plan"), false, "plan 档在 ACP 面不可用（fail 返 false）");
  await h.dispose();
});

test("权限请求：interaction_request 开卡 + respondInteraction 按 JSON-RPC id 应答", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle);
  const rawId = stub.request("session/request_permission", {
    options: [
      { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
      { optionId: "opt-deny", name: "Deny", kind: "deny_once" },
    ],
    toolCall: { toolCallId: "tc1", title: "Run rm -rf", rawInput: { command: "rm -rf /" }, _meta: { qoder: { toolName: "Bash" } } },
  });
  await flush();
  const ask = events.find((e) => e.type === "interaction_request");
  assert.ok(ask, "权限请求应上卡");
  assert.equal(ask.kind, "tool_auth");
  // respondInteraction(allow) → 桩应收到对该 rawId 的 JSON-RPC response（allow_selected + allow optionId）
  const ok = await h.respondInteraction(ask.requestId, { action: "accept" });
  assert.equal(ok, true);
  await flush();
  const resp = stub.sent.find((f) => f.id === rawId && f.result);
  assert.ok(resp, "CLI 的 request 必须收到 response");
  assert.equal(resp.result.outcome.outcome, "allow_selected");
  assert.equal(resp.result.outcome.optionId, "opt-allow");
  // 对不上的 requestId 不应答
  assert.equal(await h.respondInteraction("perm-404", { action: "decline" }), false);
  await h.dispose();
});

test("权限请求 deny：选 deny 选项回 CLI；前端卡片收到拒绝记录", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle);
  const rawId = stub.request("session/request_permission", {
    options: [
      { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
      { optionId: "opt-deny", name: "Deny", kind: "deny_once" },
    ],
    toolCall: { toolCallId: "tc2", title: "Write file", rawInput: { path: "/etc/passwd" } },
  });
  await flush();
  const ask = events.find((e) => e.type === "interaction_request");
  await h.respondInteraction(ask.requestId, { action: "decline" });
  await flush();
  const resp = stub.sent.find((f) => f.id === rawId && f.result);
  assert.equal(resp.result.outcome.optionId, "opt-deny");
  const card = events.filter((e) => e.type === "message_end" && e.message?.customType === "🔐 会话请求");
  assert.ok(card.length >= 1, "决策要留痕（消息流 custom 卡）");
  await h.dispose();
});

test("sidecar 文件名：win32 去冒号（NTFS ADS 分隔符），非 win 保持原样", () => {
  const plain = "qodercn:0f3d2c1b";
  if (process.platform === "win32") {
    assert.equal(sidecarBase(plain), "qodercn_0f3d2c1b.json");
  } else {
    assert.equal(sidecarBase(plain), "qodercn:0f3d2c1b.json");
  }
  assert.equal(sidecarBase("qodercn:new-abc"), (process.platform === "win32" ? "qodercn_new-abc" : "qodercn:new-abc") + ".json");
});

test("AcpRpc：孤儿响应/坏 JSON 不崩；stdin 关闭后 request reject", async () => {
  const stub = createAcpChild();
  const h = new QoderHandle("qodercn:new-rpc", stub.child, null, "/tmp", "cn", "/tmp/cli");
  stub.writeFrame({ jsonrpc: "2.0", result: { stray: true }, id: 999 }); // 无人认领的响应
  stub.writeFrame("not-json\n");
  stub.child.kill(); // no-op
  h["acp"]?.close();
  const err = await h["acp"].request("session/prompt", {}).catch((e) => e);
  assert.ok(/closed/.test(err.message), "关闭后 request 应 reject");
  await h.dispose();
});

/**
 * _shared/agent-interaction — 会话「需用户应答的请求」统一语义单测。
 *
 * 钉死 docs/pi-web-ext-agent-interaction-unify-plan.md §2/§3：kind 裁决、CC 族答案→线协议
 * 换算（answers/approved 回填 = 现状 permission 卡假支持的根因）、ACP fail-closed、
 * ledger 的 pending 生命周期（**补发必须复用原 requestId**——qoder 事故就是重建后卡片丢失
 * 导致 CLI 永久等一个没人回答的授权）、sidecar 落盘/读回。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/_shared/agent-interaction.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const M = await import("@aiti-ai/ext-shared/agent-interaction");
const { deriveAskKind, toControlResponse, toAcpOptionId, createInteractionLedger } = M;

// ── kind 裁决 ──────────────────────────────────────────────────────────────
test("deriveAskKind：ExitPlanMode 族 → plan_approval（含 mcp 前缀/下划线变体）", () => {
  for (const n of ["ExitPlanMode", "exit_plan_mode", "mcp__x__ExitPlanMode", "mcp__my_server__ExitPlanMode", "Exit-Plan-Mode"]) {
    assert.equal(deriveAskKind(n, {}), "plan_approval", n);
  }
});

test("deriveAskKind：AskUserQuestion 有 questions 才 ask_user，无 questions 退化 tool_auth", () => {
  const qs = [{ question: "选哪个", options: [{ label: "A" }] }];
  assert.equal(deriveAskKind("AskUserQuestion", { questions: qs }), "ask_user");
  assert.equal(deriveAskKind("mcp__x__ask_user_question", { questions: qs }), "ask_user");
  assert.equal(deriveAskKind("AskUserQuestion", {}), "tool_auth");
});

test("deriveAskKind：EnterPlanMode 是授权不是审批卡（实测 allow 即成，无方案可审）", () => {
  assert.equal(deriveAskKind("EnterPlanMode", { reason: "probe" }), "tool_auth");
});

test("deriveAskKind：zcode schema.interaction=plan_approval 后端显式标注优先于工具名", () => {
  assert.equal(deriveAskKind("whatever_tool", { interaction: "plan_approval", plan: "x" }), "plan_approval");
  assert.equal(deriveAskKind("AskUserQuestion", { interaction: "plan_approval" }), "plan_approval");
});

test("deriveAskKind：普通工具/无名 → tool_auth", () => {
  assert.equal(deriveAskKind("Bash", { command: "ls" }), "tool_auth");
  assert.equal(deriveAskKind(undefined, undefined), "tool_auth");
  assert.equal(deriveAskKind("", null), "tool_auth");
});

// ── CC 族答案 → control_response ────────────────────────────────────────────
test("toControlResponse：ask_user 接受 → allow + updatedInput 合并原入参与 answers（键=问题文本）", () => {
  const input = { questions: [{ question: "选哪个", options: [{ label: "A" }, { label: "B" }] }] };
  assert.deepEqual(toControlResponse({ kind: "ask_user", input }, { action: "accept", answers: { 选哪个: "B" } }), {
    behavior: "allow",
    updatedInput: { ...input, answers: { 选哪个: "B" } },
  });
  assert.deepEqual(toControlResponse({ kind: "ask_user", input }, { action: "accept" }), {
    behavior: "allow", updatedInput: { ...input, answers: {} },
  }, "没答也照发（CLI 侧回「user did not answer」，不能僵在等待）");
  assert.deepEqual(toControlResponse({ kind: "ask_user", input }, { action: "decline", message: "不问" }), {
    behavior: "deny", message: "不问",
  }, "用户拒答 = 权限拒绝语义，别伪造答案");
});

test("toControlResponse：plan_approval 批准 → approved=true；拒绝 → approved=false + feedback（不是 deny）", () => {
  assert.deepEqual(toControlResponse({ kind: "plan_approval", input: { plan: "p" } }, { action: "accept" }), {
    behavior: "allow", updatedInput: { plan: "p", approved: true },
  });
  assert.deepEqual(toControlResponse({ kind: "plan_approval", input: {} }, { action: "decline", message: "换方案" }), {
    behavior: "allow", updatedInput: { approved: false, feedback: "换方案" },
  });
  assert.deepEqual(toControlResponse({ kind: "plan_approval", input: {} }, { action: "decline" }), {
    behavior: "allow", updatedInput: { approved: false },
  }, "没写反馈就别发明 feedback（CLI 会提示模型去问用户要反馈）");
});

test("toControlResponse：tool_auth 只带 behavior/message，不发明 updatedInput", () => {
  assert.deepEqual(toControlResponse({ kind: "tool_auth", toolName: "Bash", input: { command: "ls" } }, { action: "accept" }), {
    behavior: "allow",
  });
  assert.deepEqual(toControlResponse({ kind: "tool_auth" }, { action: "decline" }), { behavior: "deny", message: "denied by user" });
});

test("toControlResponse：optionId 按选项 kind 解析；未知 optionId fail-closed 拒绝而非乱选", () => {
  const ask = { kind: "tool_auth", options: [{ optionId: "always", kind: "allow_always" }, { optionId: "no", kind: "reject_once" }] };
  assert.deepEqual(toControlResponse(ask, { action: "accept", optionId: "always" }), { behavior: "allow" });
  assert.deepEqual(toControlResponse(ask, { action: "accept", optionId: "ghost" }), { behavior: "deny", message: "unknown optionId: ghost" });
});

// ── ACP optionId 选择（各家选项 id 不同，必须查表而非猜）─────────────────────
test("toAcpOptionId：显式 optionId 须在 options 内；否则按 accept/decline 查 kind/name", () => {
  const opts = [{ optionId: "o1", kind: "allow_once" }, { optionId: "o2", kind: "reject_once" }];
  assert.equal(toAcpOptionId(opts, { action: "accept" }), "o1");
  assert.equal(toAcpOptionId(opts, { action: "decline", message: "no" }), "o2");
  assert.equal(toAcpOptionId(opts, { action: "accept", optionId: "o2" }), "o2");
  assert.equal(toAcpOptionId(opts, { action: "accept", optionId: "nope" }), undefined);
  assert.equal(toAcpOptionId(undefined, { action: "accept" }), undefined);
});

// ── ledger：pending 生命周期 ────────────────────────────────────────────────
function mkLedger(extra = {}) {
  const events = [];
  const notes = [];
  const ledger = createInteractionLedger({
    emit: (e) => events.push(e), record: (n) => notes.push(n), ...extra,
  });
  return { ledger, events, notes };
}

test("ledger.open：分配 requestId、广播 interaction_request、留痕 pending；requestId 由调用方给则复用", () => {
  const { ledger, events, notes } = mkLedger();
  const id = ledger.open({ kind: "tool_auth", toolName: "Bash", input: { command: "ls" } });
  assert.ok(id);
  assert.deepEqual({ type: events[0].type, requestId: events[0].requestId, kind: events[0].kind, capability: events[0].capability },
    { type: "interaction_request", requestId: id, kind: "tool_auth", capability: "respondInteraction" });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].decision, "pending");
  assert.equal(ledger.open({ requestId: "wire-9", kind: "ask_user" }), "wire-9");
  assert.equal(events[1].requestId, "wire-9", "应答必须用 CLI 原 request_id，自造即失配");
});

test("ledger.settle：命中返回账项并清账 + 留痕 allow/deny；未命中返回 null（重复应答幂等）", () => {
  const { ledger, notes } = mkLedger();
  const id = ledger.open({ kind: "plan_approval", toolName: "ExitPlanMode", input: { plan: "p" } });
  assert.equal(ledger.pending().length, 1);
  const ask = ledger.settle(id, { action: "accept" });
  assert.equal(ask.kind, "plan_approval");
  assert.equal(ledger.pending().length, 0);
  assert.equal(ledger.settle(id, { action: "accept" }), null);
  assert.deepEqual(notes.map((n) => n.decision), ["pending", "allow"]);
  const id2 = ledger.open({ kind: "tool_auth" });
  ledger.settle(id2, { action: "decline", message: "不" });
  assert.deepEqual(notes.map((n) => [n.decision, n.note]), [["pending", undefined], ["allow", undefined], ["pending", undefined], ["deny", "不"]]);
});

test("ledger.replay：只给帧不广播（补发未决；同 requestId 幂等，不新造）", () => {
  const { ledger, events } = mkLedger();
  const a = ledger.open({ kind: "tool_auth", toolName: "Write" });
  const b = ledger.open({ kind: "ask_user", toolName: "AskUserQuestion", questions: [{ question: "q", options: [{ label: "A" }] }] });
  events.length = 0;
  const frames = ledger.replay();
  assert.equal(events.length, 0, "replay 不 emit（发给谁由调用方定：新订阅者单独补发）");
  assert.deepEqual(frames.map((e) => [e.type, e.requestId]), [["interaction_request", a], ["interaction_request", b]]);
  assert.deepEqual(frames[1].questions, [{ question: "q", options: [{ label: "A" }] }], "补发的帧就是当初那帧");
  assert.deepEqual(ledger.replay().map((e) => e.requestId), [a, b], "再次取仍同 id（幂等）");
  ledger.settle(a, { action: "accept" });
  assert.deepEqual(ledger.replay().map((e) => e.requestId), [b], "已应答即不再补发");
});

test("ledger.failPending：turn 收口/进程死亡 → 逐个 interaction_expired + cancelled 留痕 + 清空", () => {
  const { ledger, events, notes } = mkLedger();
  const id = ledger.open({ kind: "tool_auth", toolName: "Bash" });
  events.length = 0;
  assert.equal(ledger.failPending("turn_end"), 1);
  assert.deepEqual(events[0], { type: "interaction_expired", requestId: id, reason: "turn_end" });
  assert.equal(ledger.pending().length, 0);
  assert.equal(notes.at(-1).decision, "cancelled");
  assert.equal(ledger.failPending("dead"), 0, "已空即幂等无副作用");
  assert.equal(events.length, 1);
});

test("ledger sidecar：sidecarFile 给则落盘可跨实例读回；不给静默降级", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiti-ia-"));
  const file = join(dir, "interactions", "qodercn_s1.json");
  const a = mkLedger({ sidecarFile: () => file });
  const id = a.ledger.open({ kind: "tool_auth", toolName: "Bash", input: { command: "ls" } });
  const qid = a.ledger.open({ kind: "ask_user", toolName: "AskUserQuestion", questions: [{ question: "选哪个", options: [{ label: "A" }] }] });
  assert.deepEqual(readdirSync(join(dir, "interactions")), ["qodercn_s1.json"], "路径由调用方定（各家 sidecar 命名规则不同：冒号在 NTFS 是 ADS 分隔符）");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved[0].requestId, id);

  const restored = [];
  const b = createInteractionLedger({ sidecarFile: () => file, emit: (e) => restored.push(e) });
  assert.equal(b.load(), 2, "重启后从 sidecar 恢复未决");
  assert.equal(b.pending()[0].toolName, "Bash");
  assert.equal(restored.length, 0, "load 只读盘不广播（发给谁由调用方的订阅时机定）");
  const revived = b.replay();
  assert.equal(revived.length, 2, "读回后即可补发（handle 重建不用等 CLI 再问一次）");
  assert.deepEqual(
    revived.find((e) => e.requestId === qid)?.questions,
    [{ question: "选哪个", options: [{ label: "A" }] }],
    "sidecar 存的是完整广播帧——恢复出来的 ask_user 卡不能丢问题",
  );
  assert.equal(b.settle(id, { action: "accept" }).kind, "tool_auth");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 1, "收口只清对应项");
  assert.equal(mkLedger().ledger.load(), 0, "无 sidecarFile 时 load 返回 0 不抛");
});

test("ledger 不信任输入：questions/options 形状不合即不写进广播事件（宁缺卡不崩卡）", () => {
  const { ledger, events } = mkLedger();
  ledger.open({ kind: "ask_user", questions: "nope" });
  ledger.open({ kind: "ask_user", questions: [{ question: "q", options: [{ label: "A" }] }, { bogus: 1 }] });
  assert.equal(events[0].questions, undefined);
  assert.deepEqual(events[1].questions, [{ question: "q", options: [{ label: "A" }] }], "逐条过滤，保留合法项");
});

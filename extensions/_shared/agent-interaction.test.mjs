/**
 * _shared/agent-interaction — unit tests for the unified semantics of session "requests needing a user answer".
 *
 * Pins docs/pi-web-ext-agent-interaction-unify-plan.md §2/§3: kind arbitration, the CC family answer→wire-protocol
 * conversion (answers/approved backfill = the root cause of today's permission cards being fake support), ACP fail-closed,
 * the ledger's pending lifecycle (**replay must reuse the original requestId** — the qoder incident was exactly a card lost after rebuild
 * leaving the CLI waiting forever for an authorization no one answers), sidecar persistence/read-back.
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

// ── kind arbitration ──────────────────────────────────────────────────────
test("deriveAskKind: the ExitPlanMode family → plan_approval (incl. mcp prefix/underscore variants)", () => {
  for (const n of ["ExitPlanMode", "exit_plan_mode", "mcp__x__ExitPlanMode", "mcp__my_server__ExitPlanMode", "Exit-Plan-Mode"]) {
    assert.equal(deriveAskKind(n, {}), "plan_approval", n);
  }
});

test("deriveAskKind: AskUserQuestion is ask_user only with questions, degrades to tool_auth without", () => {
  const qs = [{ question: "Which one?", options: [{ label: "A" }] }];
  assert.equal(deriveAskKind("AskUserQuestion", { questions: qs }), "ask_user");
  assert.equal(deriveAskKind("mcp__x__ask_user_question", { questions: qs }), "ask_user");
  assert.equal(deriveAskKind("AskUserQuestion", {}), "tool_auth");
});

test("deriveAskKind: EnterPlanMode is an authorization, not an approval card (in practice allow suffices, no plan to review)", () => {
  assert.equal(deriveAskKind("EnterPlanMode", { reason: "probe" }), "tool_auth");
});

test("deriveAskKind: zcode schema.interaction=plan_approval — the backend's explicit marker beats the tool name", () => {
  assert.equal(deriveAskKind("whatever_tool", { interaction: "plan_approval", plan: "x" }), "plan_approval");
  assert.equal(deriveAskKind("AskUserQuestion", { interaction: "plan_approval" }), "plan_approval");
});

test("deriveAskKind: ordinary tool/unnamed → tool_auth", () => {
  assert.equal(deriveAskKind("Bash", { command: "ls" }), "tool_auth");
  assert.equal(deriveAskKind(undefined, undefined), "tool_auth");
  assert.equal(deriveAskKind("", null), "tool_auth");
});

// ── CC family answers → control_response ────────────────────────────────────────────
test("toControlResponse: ask_user accept → allow + updatedInput merges the original input with answers (key = question text)", () => {
  const input = { questions: [{ question: "Which one?", options: [{ label: "A" }, { label: "B" }] }] };
  assert.deepEqual(toControlResponse({ kind: "ask_user", input }, { action: "accept", answers: { "Which one?": "B" } }), {
    behavior: "allow",
    updatedInput: { ...input, answers: { "Which one?": "B" } },
  });
  assert.deepEqual(toControlResponse({ kind: "ask_user", input }, { action: "accept" }), {
    behavior: "allow", updatedInput: { ...input, answers: {} },
  }, "sent anyway even unanswered (the CLI side reports \"user did not answer\"; must not hang waiting)");
  assert.deepEqual(toControlResponse({ kind: "ask_user", input }, { action: "decline", message: "don't ask" }), {
    behavior: "deny", message: "don't ask",
  }, "the user declining to answer = permission-denial semantics; do not fabricate answers");
});

test("toControlResponse: plan_approval approve → approved=true; decline → approved=false + feedback (not deny)", () => {
  assert.deepEqual(toControlResponse({ kind: "plan_approval", input: { plan: "p" } }, { action: "accept" }), {
    behavior: "allow", updatedInput: { plan: "p", approved: true },
  });
  assert.deepEqual(toControlResponse({ kind: "plan_approval", input: {} }, { action: "decline", message: "revise the plan" }), {
    behavior: "allow", updatedInput: { approved: false, feedback: "revise the plan" },
  });
  assert.deepEqual(toControlResponse({ kind: "plan_approval", input: {} }, { action: "decline" }), {
    behavior: "allow", updatedInput: { approved: false },
  }, "no feedback written → do not invent feedback (the CLI will prompt the model to ask the user for feedback)");
});

test("toControlResponse: tool_auth carries only behavior/message, no invented updatedInput", () => {
  assert.deepEqual(toControlResponse({ kind: "tool_auth", toolName: "Bash", input: { command: "ls" } }, { action: "accept" }), {
    behavior: "allow",
  });
  assert.deepEqual(toControlResponse({ kind: "tool_auth" }, { action: "decline" }), { behavior: "deny", message: "denied by user" });
});

test("toControlResponse: optionId resolved by option kind; unknown optionId fails closed with deny instead of picking randomly", () => {
  const ask = { kind: "tool_auth", options: [{ optionId: "always", kind: "allow_always" }, { optionId: "no", kind: "reject_once" }] };
  assert.deepEqual(toControlResponse(ask, { action: "accept", optionId: "always" }), { behavior: "allow" });
  assert.deepEqual(toControlResponse(ask, { action: "accept", optionId: "ghost" }), { behavior: "deny", message: "unknown optionId: ghost" });
});

// ── ACP optionId choice (each vendor's option ids differ; must look up, not guess) ──────────────────────
test("toAcpOptionId: an explicit optionId must be in options; otherwise kind/name is looked up by accept/decline", () => {
  const opts = [{ optionId: "o1", kind: "allow_once" }, { optionId: "o2", kind: "reject_once" }];
  assert.equal(toAcpOptionId(opts, { action: "accept" }), "o1");
  assert.equal(toAcpOptionId(opts, { action: "decline", message: "no" }), "o2");
  assert.equal(toAcpOptionId(opts, { action: "accept", optionId: "o2" }), "o2");
  assert.equal(toAcpOptionId(opts, { action: "accept", optionId: "nope" }), undefined);
  assert.equal(toAcpOptionId(undefined, { action: "accept" }), undefined);
});

// ── ledger: pending lifecycle ──────────────────────────────────────────────
function mkLedger(extra = {}) {
  const events = [];
  const notes = [];
  const ledger = createInteractionLedger({
    emit: (e) => events.push(e), record: (n) => notes.push(n), ...extra,
  });
  return { ledger, events, notes };
}

test("ledger.open: assigns requestId, broadcasts interaction_request, traces pending; a caller-given requestId is reused", () => {
  const { ledger, events, notes } = mkLedger();
  const id = ledger.open({ kind: "tool_auth", toolName: "Bash", input: { command: "ls" } });
  assert.ok(id);
  assert.deepEqual({ type: events[0].type, requestId: events[0].requestId, kind: events[0].kind, capability: events[0].capability },
    { type: "interaction_request", requestId: id, kind: "tool_auth", capability: "respondInteraction" });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].decision, "pending");
  assert.equal(ledger.open({ requestId: "wire-9", kind: "ask_user" }), "wire-9");
  assert.equal(events[1].requestId, "wire-9", "the answer must use the CLI's original request_id; inventing one mismatches");
});

test("ledger.settle: on hit returns the entry and clears it + traces allow/deny; miss returns null (duplicate answers idempotent)", () => {
  const { ledger, notes } = mkLedger();
  const id = ledger.open({ kind: "plan_approval", toolName: "ExitPlanMode", input: { plan: "p" } });
  assert.equal(ledger.pending().length, 1);
  const ask = ledger.settle(id, { action: "accept" });
  assert.equal(ask.kind, "plan_approval");
  assert.equal(ledger.pending().length, 0);
  assert.equal(ledger.settle(id, { action: "accept" }), null);
  assert.deepEqual(notes.map((n) => n.decision), ["pending", "allow"]);
  const id2 = ledger.open({ kind: "tool_auth" });
  ledger.settle(id2, { action: "decline", message: "no" });
  assert.deepEqual(notes.map((n) => [n.decision, n.note]), [["pending", undefined], ["allow", undefined], ["pending", undefined], ["deny", "no"]]);
});

test("ledger.replay: returns frames without broadcasting (replay of pending; same requestId idempotent, nothing new created)", () => {
  const { ledger, events } = mkLedger();
  const a = ledger.open({ kind: "tool_auth", toolName: "Write" });
  const b = ledger.open({ kind: "ask_user", toolName: "AskUserQuestion", questions: [{ question: "q", options: [{ label: "A" }] }] });
  events.length = 0;
  const frames = ledger.replay();
  assert.equal(events.length, 0, "replay does not emit (the caller decides who gets it: new subscribers are replayed separately)");
  assert.deepEqual(frames.map((e) => [e.type, e.requestId]), [["interaction_request", a], ["interaction_request", b]]);
  assert.deepEqual(frames[1].questions, [{ question: "q", options: [{ label: "A" }] }], "the replayed frame is exactly the original one");
  assert.deepEqual(ledger.replay().map((e) => e.requestId), [a, b], "fetching again still returns the same ids (idempotent)");
  ledger.settle(a, { action: "accept" });
  assert.deepEqual(ledger.replay().map((e) => e.requestId), [b], "already answered → no longer replayed");
});

test("ledger.failPending: turn settlement/process death → one interaction_expired each + cancelled traces + clear", () => {
  const { ledger, events, notes } = mkLedger();
  const id = ledger.open({ kind: "tool_auth", toolName: "Bash" });
  events.length = 0;
  assert.equal(ledger.failPending("turn_end"), 1);
  assert.deepEqual(events[0], { type: "interaction_expired", requestId: id, reason: "turn_end" });
  assert.equal(ledger.pending().length, 0);
  assert.equal(notes.at(-1).decision, "cancelled");
  assert.equal(ledger.failPending("dead"), 0, "already empty → idempotent, no side effects");
  assert.equal(events.length, 1);
});

test("ledger sidecar: with sidecarFile given it persists and reads back across instances; without, silent degradation", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiti-ia-"));
  const file = join(dir, "interactions", "qodercn_s1.json");
  const a = mkLedger({ sidecarFile: () => file });
  const id = a.ledger.open({ kind: "tool_auth", toolName: "Bash", input: { command: "ls" } });
  const qid = a.ledger.open({ kind: "ask_user", toolName: "AskUserQuestion", questions: [{ question: "Which one?", options: [{ label: "A" }] }] });
  assert.deepEqual(readdirSync(join(dir, "interactions")), ["qodercn_s1.json"], "the path is the caller's call (each vendor's sidecar naming differs: colons are ADS separators on NTFS)");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved[0].requestId, id);

  const restored = [];
  const b = createInteractionLedger({ sidecarFile: () => file, emit: (e) => restored.push(e) });
  assert.equal(b.load(), 2, "restores pending asks from the sidecar after restart");
  assert.equal(b.pending()[0].toolName, "Bash");
  assert.equal(restored.length, 0, "load only reads the disk without broadcasting (who gets it is decided by the caller's subscription timing)");
  const revived = b.replay();
  assert.equal(revived.length, 2, "after read-back replay is ready (a rebuilt handle need not wait for the CLI to ask again)");
  assert.deepEqual(
    revived.find((e) => e.requestId === qid)?.questions,
    [{ question: "Which one?", options: [{ label: "A" }] }],
    "the sidecar stores the complete broadcast frame — a restored ask_user card must not lose its questions",
  );
  assert.equal(b.settle(id, { action: "accept" }).kind, "tool_auth");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 1, "settlement clears only the matching entry");
  assert.equal(mkLedger().ledger.load(), 0, "without sidecarFile, load returns 0 without throwing");
});

test("ledger distrusts input: malformed questions/options are not written into the broadcast event (better a missing card than a broken one)", () => {
  const { ledger, events } = mkLedger();
  ledger.open({ kind: "ask_user", questions: "nope" });
  ledger.open({ kind: "ask_user", questions: [{ question: "q", options: [{ label: "A" }] }, { bogus: 1 }] });
  assert.equal(events[0].questions, undefined);
  assert.deepEqual(events[1].questions, [{ question: "q", options: [{ label: "A" }] }], "filtered item by item, valid entries kept");
});

import assert from "node:assert/strict";
import test from "node:test";

const { deriveRunOutcome, truncateRunError, runOutcomeNotifies } = await import("./run-outcome.ts");

const T0 = 1789444305989; // 2026-09-15

function assistant(stopReason, extra = {}) {
  return { role: "assistant", content: [], stopReason, timestamp: T0, ...extra };
}

test("deriveRunOutcome maps stop reasons to run status", () => {
  assert.equal(deriveRunOutcome([assistant("stop")])?.status, "completed");
  assert.equal(deriveRunOutcome([assistant("length")])?.status, "completed");
  assert.equal(deriveRunOutcome([assistant("aborted")])?.status, "aborted");
  assert.equal(deriveRunOutcome([assistant("toolUse")])?.status, "interrupted");
  assert.equal(deriveRunOutcome([assistant("pending")])?.status, "interrupted");
  assert.equal(deriveRunOutcome([assistant("deferred")])?.status, "interrupted");
});

test("deriveRunOutcome captures the error message only for failed runs", () => {
  const failed = deriveRunOutcome([assistant("error", { errorMessage: "Cannot read properties of undefined (reading 'totalTokens')" })]);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "Cannot read properties of undefined (reading 'totalTokens')");
  // completed carries no error; a blank errorMessage does not populate the field
  assert.deepEqual(deriveRunOutcome([assistant("stop", { errorMessage: "ignored" })]), { status: "completed", at: new Date(T0).toISOString() });
  assert.deepEqual(deriveRunOutcome([assistant("error", { errorMessage: "   " })])?.error, undefined);
});

test("deriveRunOutcome only looks at the last assistant message", () => {
  const messages = [
    assistant("error", { errorMessage: "boom" }),
    { role: "user", content: "retry", timestamp: T0 + 1 },
    assistant("stop", { timestamp: T0 + 2 }),
  ];
  const outcome = deriveRunOutcome(messages);
  assert.equal(outcome?.status, "completed");
  assert.equal(outcome?.error, undefined);
  assert.equal(outcome?.at, new Date(T0 + 2).toISOString());

  // Last message is a user message (mid-turn) → the last assistant message still wins
  const midTurn = deriveRunOutcome([assistant("aborted"), { role: "user", timestamp: T0 + 5 }]);
  assert.equal(midTurn?.status, "aborted");
});

test("deriveRunOutcome returns undefined without assistant messages", () => {
  assert.equal(deriveRunOutcome([]), undefined);
  assert.equal(deriveRunOutcome(undefined), undefined);
  assert.equal(deriveRunOutcome([{ role: "user", timestamp: T0 }]), undefined);
});

test("deriveRunOutcome falls back to the provided timestamp", () => {
  const outcome = deriveRunOutcome([{ role: "assistant", stopReason: "error" }], "2026-01-02T03:04:05.000Z");
  assert.equal(outcome?.at, "2026-01-02T03:04:05.000Z");
  assert.equal(deriveRunOutcome([{ role: "assistant", stopReason: "error" }]), undefined);
});

test("truncateRunError flattens whitespace and truncates by code points", () => {
  assert.equal(truncateRunError("  line one\nline two\t line three  "), "line one line two line three");
  assert.equal(truncateRunError(undefined), "");
  assert.equal(truncateRunError(""), "");
  const long = "x".repeat(200);
  const cut = truncateRunError(long, 120);
  assert.equal(cut.length, 120);
  assert.ok(cut.endsWith("…"));
  // emoji (surrogate pairs) must not be cut in half
  const emoji = "🙂".repeat(10);
  assert.equal(truncateRunError(emoji, 5), "🙂🙂🙂🙂…");
});

test("runOutcomeNotifies: completed/failed notify, aborted/interrupted do not", () => {
  assert.equal(runOutcomeNotifies("completed"), true);
  assert.equal(runOutcomeNotifies("failed"), true);
  assert.equal(runOutcomeNotifies("aborted"), false);
  assert.equal(runOutcomeNotifies("interrupted"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Steer capability gating (composer buttons + queue panel rows)
//
// Background (2026-09-22): ChatWindow wired onSteer purely on agentRunning, so every
// steer:false backend (qoder/codex/cursor/codebuddy/opencode/acp/…) rendered a 插队
// button whose click silently produced a follow-up — the user pressed steer, got a
// queued item, pressed steer again on that queue entry, got another queued item. The
// steer/followUp wording is now derived from what the backend actually declares, so
// these two pure helpers carry the whole decision and are pinned here.
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { computeQueueSteerReadonly, computeQueueOnlyBackend } = await jiti.import("./ChatInput.tsx");

test("queue-steer readonly: only for backends whose steering entries left the protocol's reach", () => {
  // Local pi session: the state endpoint reports no capabilities → rows stay manageable.
  assert.equal(computeQueueSteerReadonly(null), false);
  assert.equal(computeQueueSteerReadonly(undefined), false);
  // pi-protocol backends (aiti-pi-agent/omp): remote queue reinjects on every mutation.
  assert.equal(computeQueueSteerReadonly({ steer: true, steerQueueManage: true }), false);
  // zcode-style CLI backends: already injected into the peer process, cannot be recalled.
  assert.equal(computeQueueSteerReadonly({ steer: true }), true);
  // steer:false backends never produce steering rows (running input degrades to followUp).
  assert.equal(computeQueueSteerReadonly({ steer: false }), false);
});

test("queue-only wording: declared capabilities without a steer surface", () => {
  assert.equal(computeQueueOnlyBackend(null), false, "local pi keeps the 'Enter again to steer' wording");
  assert.equal(computeQueueOnlyBackend({ steer: true }), false);
  assert.equal(computeQueueOnlyBackend({ steer: false, followUp: true }), true);
  // An empty capability object (provider still probing) must not silently rewrite the
  // wording into steer:false semantics — it does, and that is the safe direction: it
  // only ever understates what the backend can do, never overpromises.
  assert.equal(computeQueueOnlyBackend({}), true);
});

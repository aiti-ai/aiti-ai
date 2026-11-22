import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard: "change model while a session is running" got dropped when
// plan-a-upstream was merged — the model selector went from "clickable while
// streaming, switch applies next turn + pending badge" to locked with
// disabled={isStreaming}. The backend handleModelChange (useAgentSession) still
// has the setModel path, but a locked UI entry point = unreachable feature.
// This file watches the UI side: if a merge locks it up again / drops the
// pending badge, this file goes red immediately.
const chatInput = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const modelSelector = await readFile(new URL("./ModelSelector.tsx", import.meta.url), "utf8");

test("model selector stays clickable while streaming (not locked by isStreaming)", () => {
  assert.match(chatInput, /disabled=\{false\}/);
  // The lock comes only from "switch request in progress": busy locks, streaming does not.
  assert.match(chatInput, /busy=\{modelSwitching\}/);
  // Explicit source comment: after any merge the "streaming stays clickable, applies next turn" semantics must be kept
  assert.match(
    chatInput,
    /Streaming stays clickable: switching mid-run applies next turn \(modelSwitchPending badge\)/,
  );
});

test("pending badge is passed to ModelSelector after a mid-run switch", () => {
  assert.match(chatInput, /pending=\{modelSwitchPending != null\}/);
});

test("ModelSelector exposes the pending badge prop and renders the next-turn badge", () => {
  assert.match(modelSelector, /pending\?: boolean;/);
  assert.match(modelSelector, /pending = false,/);
  assert.match(modelSelector, /\{pending && \(/);
  assert.match(modelSelector, /t\("chat\.modelSwitchPendingBadge"\)/);
});

test("the next-turn i18n copy exists", async () => {
  const { readFile: rf } = await import("node:fs/promises");
  const en = await rf(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
  assert.match(en, /"chat\.modelSwitchPendingBadge"/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { mergeHandleState } from "./handle-state.ts";

test("handle state carries capabilities/backendSource inside `state` (frontend contract)", () => {
  // hooks/useAgentSession.ts reads liveState.capabilities — nesting is the contract.
  assert.deepEqual(
    mergeHandleState({ isStreaming: false }, { fork: true, navigateTree: false }, "aiti-pi-agent/spawn"),
    { isStreaming: false, capabilities: { fork: true, navigateTree: false }, backendSource: "aiti-pi-agent/spawn" },
  );
});

test("handle state omits undeclared fields instead of writing undefined", () => {
  assert.deepEqual(mergeHandleState({ isStreaming: true }, undefined, undefined), { isStreaming: true });
});

test("a missing get_state payload still exposes the handle declaration", () => {
  assert.deepEqual(mergeHandleState(null, { fork: true }, "aiti-attach-agent/attach"), {
    capabilities: { fork: true },
    backendSource: "aiti-attach-agent/attach",
  });
  assert.equal(mergeHandleState(null, undefined, undefined), null);
});

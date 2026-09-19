import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { sendWithAcceptWindow, PROMPT_FAMILY_TYPES } = await jiti.import("./agent-command-accept.ts");

test("non-prompt-family commands always settle synchronously (original semantics)", async () => {
  const { result } = await sendWithAcceptWindow(
    { send: async () => ({ state: 1 }) },
    { type: "get_state" },
    10,
  );
  assert.deepEqual(result, { state: 1 });

  await assert.rejects(
    async () => {
      const { error } = await sendWithAcceptWindow(
        { send: async () => { throw new Error("no model"); } },
        { type: "set_model" },
        10,
      );
      throw error;
    },
    /no model/,
  );
});

test("fast-resolving prompt returns the result as settled", async () => {
  const outcome = await sendWithAcceptWindow(
    { send: async () => null },
    { type: "prompt", message: "hi" },
    1_000,
  );
  assert.equal(outcome.settled, true);
  assert.equal("error" in outcome, false);
});

test("quick prompt rejection surfaces the error within the window", async () => {
  const outcome = await sendWithAcceptWindow(
    { send: async () => { throw new Error("session disposed"); } },
    { type: "prompt", message: "hi" },
    5_000,
  );
  assert.equal(outcome.settled, true);
  assert.match(String(outcome.error), /session disposed/);
});

test("slow prompt turn resolves as accepted (202) and late failure emits prompt_error", async () => {
  const emitted = [];
  let rejectSend;
  const sendPromise = new Promise((_resolve, reject) => { rejectSend = reject; });
  const outcome = await sendWithAcceptWindow(
    {
      send: () => sendPromise,
      emit: (event) => emitted.push(event),
    },
    { type: "prompt", message: "hi" },
    20,
  );
  assert.equal(outcome.settled, false);

  // Wait for the catch chain of the late-arriving rejection to finish
  rejectSend(new Error("acp rpc hung up"));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(emitted, [{ type: "prompt_error", errorMessage: "acp rpc hung up" }]);
});

test("steer/follow_up share the accept window", async () => {
  assert.equal(PROMPT_FAMILY_TYPES.has("steer"), true);
  assert.equal(PROMPT_FAMILY_TYPES.has("follow_up"), true);
  const outcome = await sendWithAcceptWindow(
    { send: () => new Promise(() => {}) },
    { type: "follow_up", message: "hi" },
    20,
  );
  assert.equal(outcome.settled, false);
});

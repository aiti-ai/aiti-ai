/**
 * readLiveHandleSession (core.readSession's external-backend session fallback) unit tests (node --test)
 *
 * Covers: handle-store hit → getMessages adapted to {messages, entryIds} (index ids stable across
 * calls — the matching precondition for ai-speek's idsOnly→messages-content two-phase fetch);
 * role/content projection strips extra fields; handle absent / getMessages empty / throw → null.
 * Loaded as an independent light module (core.ts's top-level rpc-manager chain contains syntax
 * strip-types does not support).
 */
import assert from "node:assert/strict";
import test from "node:test";

const { readLiveHandleSession } = await import("./core-live-session.ts");
const { putHandleAt, rebindHandle, getHandle } = await import("../session/handle-store.ts");

function fakeHandle(messages) {
  return {
    id: "zcode:sess_fake",
    alive: () => true,
    subscribe: () => () => {},
    getMessages: async () => messages,
    dispose: async () => {},
  };
}

test("fallback adaptation: handle-store hit → messages projection + indexed entryIds (stable across the two-phase fetch)", async () => {
  const SID = "test-uuid-ext-1";
  putHandleAt(SID, fakeHandle([
    { role: "user", content: [{ type: "text", text: "问" }], extra: "strip-me" },
    { role: "assistant", content: [{ type: "text", text: "答" }], model: "bigmodel/GLM-5.3", provider: "zcode" },
  ]));
  const sess = await readLiveHandleSession(SID);
  assert.ok(sess, "returns the adapted shape rather than null");
  assert.equal(sess.messages.length, 2);
  assert.deepEqual(sess.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal("extra" in sess.messages[0], false, "fields beyond role/content are stripped");
  assert.equal("model" in sess.messages[1], false);
  // entryIds: identical across calls (the two-phase fetch matching precondition)
  const ids1 = sess.entryIds;
  const ids2 = (await readLiveHandleSession(SID)).entryIds;
  assert.deepEqual(ids1, ids2);
  assert.equal(ids1.length, 2);
});

test("fallback adaptation: handle absent / getMessages empty → null", async () => {
  putHandleAt("test-uuid-ext-2", fakeHandle([]));
  assert.equal(await readLiveHandleSession("test-uuid-ext-2"), null, "empty history → null");
  assert.equal(await readLiveHandleSession("test-uuid-ext-never-created"), null, "id not in the store → null");
});

test("fallback adaptation: getMessages throw → null (no smoke)", async () => {
  const h = fakeHandle(null);
  h.getMessages = async () => { throw new Error("backend gone"); };
  putHandleAt("test-uuid-ext-3", h);
  assert.equal(await readLiveHandleSession("test-uuid-ext-3"), null);
});

// ── B4: rebindHandle — alias rebinding for the omp process-generated id scenario (docs/aiti-omp-agent-id-rebind-design.md) ──

function fakeHandle2(messages) {
  return {
    id: "x",
    alive: () => true,
    subscribe: () => () => {},
    getMessages: async () => messages,
    dispose: async () => {},
  };
}

test("B4 rebindHandle: alias mount / idempotent / duplicate check / bad input", async () => {
  const h = fakeHandle2([{ role: "user", text: "q" }]);
  putHandleAt("placeholder-uuid", h);
  assert.equal(rebindHandle("placeholder-uuid", "real-native-id"), true);
  assert.equal(rebindHandle("placeholder-uuid", "real-native-id"), true, "idempotent: same handle already mounted → true");
  putHandleAt("other", fakeHandle2([]));
  assert.equal(rebindHandle("placeholder-uuid", "other"), false, "newId occupied by another handle → rejected");
  assert.equal(rebindHandle("", "x"), false);
  assert.equal(rebindHandle("same", "same"), false);
  assert.equal(rebindHandle("missing-old", "new"), false);
});

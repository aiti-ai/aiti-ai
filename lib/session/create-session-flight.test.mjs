import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// Hermetic starter: never probe the host's systemd inside a unit test.
process.env.PI_AGENT_STARTER_DIR = mkdtempSync(join(tmpdir(), "pi-session-flight-"));
process.env.PI_AGENT_STARTER_RUNNER = "plain";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const sessionIndex = await jiti.import("./index.ts");
const { registerProvider, removeProvider } = await jiti.import("./providers.ts");

const { createSessionHandle, removeHandle } = sessionIndex;
const FAKE_TYPE = "gate-flight-fake";

/** Minimal SessionHandle: createSessionHandle only stores it and wires rebind/rebind listeners. */
function fakeHandle(id) {
  return {
    id,
    source: FAKE_TYPE,
    alive: () => true,
    isAlive: () => true,
    isRunning: () => false,
    getModel: () => undefined,
    subscribe: () => () => {},
    dispose: async () => {},
    capabilities: {},
  };
}

test("createSessionHandle shares one creation between concurrent opens (no double spawn)", async () => {
  let createCalls = 0;
  const sessionId = `flight-${process.pid}-${Date.now()}`;
  registerProvider({
    type: FAKE_TYPE,
    label: "gate flight fake",
    async createSession() {
      createCalls += 1;
      // Hold the first creation open so the second caller must join the flight
      // instead of racing into its own provider.createSession (two wrappers).
      await new Promise((resolve) => setTimeout(resolve, 30));
      return fakeHandle(sessionId);
    },
  });
  try {
    const [first, second] = await Promise.all([
      createSessionHandle({ providerType: FAKE_TYPE, sessionId }),
      createSessionHandle({ providerType: FAKE_TYPE, sessionId }),
    ]);
    assert.equal(createCalls, 1, "one provider.createSession for two concurrent opens");
    assert.equal(first, second, "both callers receive the same handle");
  } finally {
    removeProvider(FAKE_TYPE);
    removeHandle(sessionId);
  }
});

test("a failed creation is not cached (the next open retries)", async () => {
  let calls = 0;
  const sessionId = `flight-fail-${process.pid}-${Date.now()}`;
  registerProvider({
    type: FAKE_TYPE,
    label: "gate flight fake",
    async createSession() {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return fakeHandle(sessionId);
    },
  });
  try {
    await assert.rejects(createSessionHandle({ providerType: FAKE_TYPE, sessionId }), /boom/);
    const handle = await createSessionHandle({ providerType: FAKE_TYPE, sessionId });
    assert.equal(calls, 2, "the failed flight was dropped");
    assert.equal(handle.id, sessionId);
  } finally {
    removeProvider(FAKE_TYPE);
    removeHandle(sessionId);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { startRpcSession } = await jiti.import("../rpc-manager.ts");
const sessionIndex = await jiti.import("./index.ts");
const { registerProvider, removeProvider } = await jiti.import("./providers.ts");
const { BridgeOccupiedError } = await jiti.import("./types.ts");

const { resolveProviderOwnedSession, removeHandle } = sessionIndex;

const FAKE_TYPE = "gate-fake-owned";
const FAKE_FILE = "/tmp/fake-owned-session.jsonl";

/** Minimal SessionHandle: just enough for putHandle/watchBackendRebind/HandleSessionAdapter. */
function fakeHandle(id) {
  return {
    id,
    source: `${FAKE_TYPE}`,
    alive: () => true,
    isAlive: () => true,
    isRunning: () => false,
    getModel: () => undefined,
    subscribe: () => () => {},
    dispose: async () => {},
    capabilities: {},
  };
}

function registerClaimingFake(claim) {
  registerProvider({
    type: FAKE_TYPE,
    label: "gate fake",
    async createSession() {
      throw new Error("createSession must not be reached by the gate test");
    },
    ownsFile: () => claim,
  });
  return `${FAKE_TYPE}`;
}

test("startRpcSession refuses a provider-claimed session file (no local twin)", async () => {
  const key = registerClaimingFake(true);
  try {
    await assert.rejects(
      startRpcSession("gate-fake-sess-1", FAKE_FILE, undefined, {}),
      (err) => {
        assert.ok(err instanceof BridgeOccupiedError, `expected BridgeOccupiedError, got ${err}`);
        assert.match(err.message, /claimed by backend/);
        return true;
      },
    );
  } finally {
    removeProvider(key);
  }
});

test("startRpcSession ignores files no provider claims (local runtime still works)", async () => {
  const key = registerClaimingFake(false);
  try {
    // The gate passes; the local runtime then fails on the missing file — the
    // assertion pins the failure to the runtime, not the single-writer gate.
    await assert.rejects(
      startRpcSession("gate-fake-sess-2", FAKE_FILE, undefined, {}),
      (err) => !(err instanceof BridgeOccupiedError),
    );
  } finally {
    removeProvider(key);
  }
});

test("resolveProviderOwnedSession: claimed file → handle from the claiming provider", async () => {
  let createCalls = 0;
  registerProvider({
    type: FAKE_TYPE,
    label: "gate fake",
    ownsFile: () => true,
    async createSession(options) {
      createCalls++;
      assert.equal(options.sessionId, "owned-sess-1");
      assert.equal(options.sessionFile, FAKE_FILE);
      return fakeHandle("owned-sess-1");
    },
  });
  try {
    const adapter = await resolveProviderOwnedSession("owned-sess-1", FAKE_FILE);
    assert.ok(adapter, "claimed file must resolve through the provider");
    assert.equal(adapter.isAlive(), true);
    assert.equal(createCalls, 1);
    removeHandle("owned-sess-1");
  } finally {
    removeProvider(`${FAKE_TYPE}`);
  }
});

test("resolveProviderOwnedSession: unclaimed file → undefined (no provider contact)", async () => {
  registerProvider({
    type: FAKE_TYPE,
    label: "gate fake",
    ownsFile: () => false,
    async createSession() {
      throw new Error("createSession must not run for unclaimed files");
    },
  });
  try {
    const adapter = await resolveProviderOwnedSession("owned-sess-2", FAKE_FILE);
    assert.equal(adapter, undefined);
  } finally {
    removeProvider(`${FAKE_TYPE}`);
  }
});

test("resolveProviderOwnedSession: probing provider that throws does not block the rest", async () => {
  registerProvider({
    type: "gate-fake-throws",
    label: "throwing probe",
    ownsFile: () => {
      throw new Error("probe exploded");
    },
    createSession: async () => fakeHandle("never"),
  });
  registerProvider({
    type: FAKE_TYPE,
    label: "gate fake",
    ownsFile: () => true,
    async createSession() {
      return fakeHandle("owned-sess-3");
    },
  });
  try {
    const adapter = await resolveProviderOwnedSession("owned-sess-3", FAKE_FILE);
    assert.ok(adapter, "the healthy claiming provider must still resolve");
    removeHandle("owned-sess-3");
  } finally {
    removeProvider("gate-fake-throws");
    removeProvider(`${FAKE_TYPE}`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";

// openExternalSession depends on globalThis globals (handle store / provider registry) —
// tests clear the field first and clean up at the end to avoid polluting other test files.
const g = globalThis;
function reset() {
  g.__sessionHandles = undefined;
  g.__sessionProviders = undefined;
  g.__extSessionProviders = undefined;
}

function liveHandle(id) {
  return {
    id,
    source: "test-ext/zcode",
    capabilities: {},
    cwd: "",
    alive: () => true,
    isRunning: () => false,
    subscribe: () => () => {},
    dispose: async () => {},
  };
}

async function load() {
  reset();
  const providers = await import("./providers.ts");
  const store = await import("./handle-store.ts");
  const index = await import("./index.ts");
  return { providers, store, index };
}

test("openExternalSession: reuses an existing live handle for the same composite id instead of rebuilding (prevents double-handle mutual kill)", async () => {
  const { providers, store, index } = await load();
  try {
    let created = 0;
    providers.registerExtensionProvider("test-ext", {
      type: "zcode",
      label: "zcode",
      agentKey: "zcode",
      maxCapabilities: {},
      createSession: async () => { created++; return liveHandle(`zcode:sess_${created}`); },
    });

    const existing = liveHandle("zcode:sess_x");
    store.putHandle(existing);

    const got = await index.openExternalSession("zcode:sess_x");
    assert.equal(got, existing, "must return the existing live handle");
    assert.equal(created, 0, "must not rebuild via the provider (a rebuild would dispose the previous one, killing the in-flight turn)");
  } finally {
    reset();
  }
});

test("openExternalSession: opening via a placeholder-uuid alias reuses the handle and back-fills the composite id key", async () => {
  const { providers, store, index } = await load();
  try {
    let created = 0;
    providers.registerExtensionProvider("test-ext", {
      type: "zcode",
      label: "zcode",
      agentKey: "zcode",
      maxCapabilities: {},
      createSession: async () => { created++; return liveHandle(`zcode:sess_${created}`); },
    });

    const existing = liveHandle("zcode:sess_x");
    store.putHandleAt("placeholder-uuid", existing); // reachable only under the placeholder uuid key

    const got = await index.openExternalSession("zcode:sess_x");
    assert.equal(got, existing);
    assert.equal(created, 0);
    assert.equal(store.getHandle("zcode:sess_x"), existing, "composite id key back-registered");
  } finally {
    reset();
  }
});

test("openExternalSession: with no live handle, creates via the provider as usual", async () => {
  const { providers, store, index } = await load();
  try {
    let created = 0;
    providers.registerExtensionProvider("test-ext", {
      type: "zcode",
      label: "zcode",
      agentKey: "zcode",
      maxCapabilities: {},
      createSession: async () => { created++; return liveHandle("zcode:sess_new"); },
    });

    const got = await index.openExternalSession("zcode:sess_new");
    assert.equal(created, 1);
    assert.equal(got?.id, "zcode:sess_new");
    assert.equal(store.getHandle("zcode:sess_new"), got);
  } finally {
    reset();
  }
});

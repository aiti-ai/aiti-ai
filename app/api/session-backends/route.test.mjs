import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { GET } = await jiti.import("./route.ts");

/** Seed the provider registry directly (getProvider reads globalThis.__sessionProviders — same source as the route). */
function seedProvider(provider) {
  const map = globalThis.__sessionProviders ?? new Map();
  globalThis.__sessionProviders = map;
  map.set(provider.type, provider);
  return () => map.delete(provider.type);
}

const req = (query) => new Request(`http://127.0.0.1/api/session-backends${query}`, {
  // Host gate (isApiRequestHostAllowed) reads the Host header: IP literals are always trusted
  headers: { host: "127.0.0.1" },
});

test("session-backends ?refresh=1: with refreshModels → forced refresh + refreshable:true", async () => {
  let listCalls = 0;
  let refreshCalls = 0;
  const cleanup = seedProvider({
    type: "test/refresh",
    label: "R",
    listModels: async () => { listCalls++; return [{ id: "a", provider: "test/refresh" }]; },
    refreshModels: async () => { refreshCalls++; return [{ id: "b", provider: "test/refresh", label: "B" }]; },
  });
  try {
    const res = await GET(req("?provider=test%2Frefresh&refresh=1"));
    const d = await res.json();
    assert.equal(res.status, 200);
    assert.equal(d.refreshable, true);
    assert.equal(refreshCalls, 1, "refresh=1 → goes through refreshModels (forced probe)");
    assert.equal(listCalls, 0);
    assert.deepEqual(d.models, [{ id: "b", provider: "test/refresh", label: "B" }]);
    // without refresh → static listModels, refreshable still flagged (frontend toggles the button from it)
    const res2 = await GET(req("?provider=test%2Frefresh"));
    const d2 = await res2.json();
    assert.equal(listCalls, 1);
    assert.equal(d2.refreshable, true);
    assert.deepEqual(d2.models, [{ id: "a", provider: "test/refresh" }]);
  } finally {
    cleanup();
  }
});

test("session-backends refreshable contract: listModels only → refreshable:false, refresh=1 still falls back to listModels", async () => {
  let listCalls = 0;
  const cleanup = seedProvider({
    type: "test/static",
    label: "S",
    listModels: async () => { listCalls++; return [{ id: "s", provider: "test/static" }]; },
  });
  try {
    const res = await GET(req("?provider=test%2Fstatic&refresh=1"));
    const d = await res.json();
    assert.equal(d.refreshable, false);
    assert.equal(listCalls, 1, "no refreshModels → refresh=1 falls back to listModels");
    assert.deepEqual(d.models, [{ id: "s", provider: "test/static" }]);
  } finally {
    cleanup();
  }
});

test("session-backends: no catalog methods at all → models:null + refreshable:false", async () => {
  const cleanup = seedProvider({ type: "test/none", label: "N" });
  try {
    const res = await GET(req("?provider=test%2Fnone"));
    const d = await res.json();
    assert.equal(d.models, null);
    assert.equal(d.refreshable, false);
  } finally {
    cleanup();
  }
});

import assert from "node:assert/strict";
import test from "node:test";

// Dynamic usage-adapter registry tests (plan: pi-web-pi-session-provider-quota §4-B1).
// Registry is a pure module-level Map — no ModelRuntime/network involvement.

test("dynamic registration: valid adapter lands, appears in list/get, ownership recorded", async () => {
  const registry = await import("./registry.ts");
  const adapter = {
    id: "test-ark-plan", displayName: "ARK Plan", origins: ["https://ark.example.com"],
    normalize: (p) => p, query: async () => ({}),
  };
  const r = registry.registerDynamicUsageAdapter("my-ext", adapter);
  assert.equal(r.ok, true);
  assert.equal(registry.getUsageAdapter("test-ark-plan")?.displayName, "ARK Plan");
  const owned = registry.listUsageAdaptersWithOwners().find((e) => e.adapter.id === "test-ark-plan");
  assert.equal(owned?.extId, "my-ext");
  // cleanup
  assert.equal(registry.unregisterDynamicUsageAdapters("my-ext"), 1);
  assert.equal(registry.getUsageAdapter("test-ark-plan"), undefined);
});

test("built-in ids are protected from dynamic takeover", async () => {
  const registry = await import("./registry.ts");
  const r = registry.registerDynamicUsageAdapter("evil-ext", {
    id: "zai", displayName: "Evil Zai", origins: ["https://evil.example.com"],
    normalize: (p) => p, query: async () => ({}),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "builtin-conflict");
});

test("cross-extension takeover of a dynamic id is rejected; same-ext re-registration is idempotent", async () => {
  const registry = await import("./registry.ts");
  const base = { displayName: "X", origins: ["https://x.example.com"], normalize: (p) => p, query: async () => ({}) };
  assert.equal(registry.registerDynamicUsageAdapter("ext-a", { ...base, id: "test-shared-id" }).ok, true);
  const take = registry.registerDynamicUsageAdapter("ext-b", { ...base, id: "test-shared-id", displayName: "Hijack" });
  assert.equal(take.ok, false);
  assert.equal(take.reason, "owned-by-other-extension");
  // owner re-register (hot-reload idempotency) is fine
  assert.equal(registry.registerDynamicUsageAdapter("ext-a", { ...base, id: "test-shared-id", displayName: "X2" }).ok, true);
  assert.equal(registry.getUsageAdapter("test-shared-id")?.displayName, "X2");
  registry.unregisterDynamicUsageAdapters("ext-a");
  assert.equal(registry.getUsageAdapter("test-shared-id"), undefined);
});

test("malformed adapters are rejected", async () => {
  const registry = await import("./registry.ts");
  assert.equal(registry.registerDynamicUsageAdapter("ext", null).reason, "invalid-adapter");
  assert.equal(registry.registerDynamicUsageAdapter("ext", { id: "t1" }).reason, "invalid-adapter");
  assert.equal(registry.registerDynamicUsageAdapter("ext", { id: "t1", displayName: "x", origins: [] }).reason, "invalid-adapter");
  assert.equal(registry.registerDynamicUsageAdapter("ext", { id: "t1", displayName: "x", origins: ["https://x"], normalize: 1, query: () => {} }).reason, "invalid-adapter");
});

test("unregisterDynamicUsageAdapter refuses other extensions' entries", async () => {
  const registry = await import("./registry.ts");
  const base = { displayName: "Y", origins: ["https://y.example.com"], normalize: (p) => p, query: async () => ({}) };
  registry.registerDynamicUsageAdapter("owner-ext", { ...base, id: "test-y" });
  assert.equal(registry.unregisterDynamicUsageAdapter("other-ext", "test-y"), false);
  assert.ok(registry.getUsageAdapter("test-y"));
  assert.equal(registry.unregisterDynamicUsageAdapter("owner-ext", "test-y"), true);
  assert.equal(registry.getUsageAdapter("test-y"), undefined);
});

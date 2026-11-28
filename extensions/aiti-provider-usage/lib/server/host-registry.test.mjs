import assert from "node:assert/strict";
import test from "node:test";
import { setHostUsageAdapterSource, listThirdPartyUsageAdapters, resolveUsageAdapter } from "./host-registry.ts";
import { registerUsageAdapter } from "./registry.ts";

// Third-party dynamic adapter resolution (plan: pi-web-pi-session-provider-quota §4-B3b).
// Pure module-level slot — no ModelRuntime/network involvement.

const mk = (id) => ({ id, displayName: id, origins: [`https://${id}.example.com`], normalize: (p) => p, query: async () => ({}) });

test("third-party listing filters own-extension and built-in entries", () => {
  setHostUsageAdapterSource({
    list: () => [
      { adapter: mk("built-in-id"), extId: null },
      { adapter: mk("own-1"), extId: "aiti-provider-usage" },
      { adapter: mk("other-ext-1"), extId: "some-other-ext" },
      { adapter: mk("other-ext-2"), extId: "another-ext" },
    ],
  });
  const ids = listThirdPartyUsageAdapters().map((a) => a.id);
  assert.deepEqual(ids, ["other-ext-1", "other-ext-2"]);
});

test("resolveUsageAdapter prefers the local registry, falls back to a third-party host entry by exact id", async () => {
  registerUsageAdapter(mk("local-first"));
  setHostUsageAdapterSource({ list: () => [{ adapter: mk("local-first"), extId: "x" }, { adapter: mk("third-party"), extId: "y" }] });
  assert.equal(resolveUsageAdapter("local-first")?.id, "local-first");
  assert.equal(resolveUsageAdapter("third-party")?.id, "third-party");
  assert.equal(resolveUsageAdapter("unknown-id"), undefined);
});

test("null/absent host slot degrades to local-only resolution", () => {
  setHostUsageAdapterSource(null);
  assert.deepEqual(listThirdPartyUsageAdapters(), []);
  registerUsageAdapter(mk("local-still-works"));
  assert.equal(resolveUsageAdapter("local-still-works")?.id, "local-still-works");
  assert.equal(resolveUsageAdapter("third-party"), undefined);
  setHostUsageAdapterSource(null);
});

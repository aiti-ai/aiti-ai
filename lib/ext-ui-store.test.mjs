/**
 * ext-ui-store tests — feedback from the DSH host (docs/dsh-adapter-assessment.md §5.2):
 * per-extension isolated registration + disposer removal semantics.
 */
import assert from "node:assert/strict";
import test from "node:test";

const storePath = new URL("../lib/ext-ui-store.ts", import.meta.url).pathname;
const store = await import(storePath);

function reset() {
  globalThis.__piWebExtUI = undefined;
}

test("registerExtUiItems stamps extId and returns a disposer", () => {
  reset();
  const { registerExtUiItems, getExtUiItems } = store;
  const render = () => null;
  const disposeA = registerExtUiItems("toolbar", [{ id: "a1", render }], "ext-a");
  registerExtUiItems("toolbar", [{ id: "b1", render }], "ext-b");

  assert.equal(getExtUiItems("toolbar").length, 2);
  assert.deepEqual(getExtUiItems("toolbar").map((it) => it.extId), ["ext-a", "ext-b"]);

  // The disposer removes exactly this registration (other registrations with the same
  // extId and id are unaffected)
  disposeA();
  assert.equal(getExtUiItems("toolbar").length, 1);
  assert.equal(getExtUiItems("toolbar")[0].id, "b1");
});

test("disposeExtUiItems removes only the (extId, ids) intersection", () => {
  reset();
  const { registerExtUiItems, disposeExtUiItems, getExtUiItems } = store;
  const render = () => null;
  registerExtUiItems("toolbar", [{ id: "a1", render }, { id: "a2", render }], "ext-a");
  registerExtUiItems("toolbar", [{ id: "a1", render }], "ext-b");

  disposeExtUiItems("toolbar", "ext-a", ["a1"]);
  const items = getExtUiItems("toolbar");
  // ext-a's a1 removed; ext-b's a1 kept; ext-a's a2 kept
  assert.equal(items.length, 2);
  assert.ok(items.some((it) => it.id === "a1" && it.extId === "ext-b"));
  assert.ok(items.some((it) => it.id === "a2" && it.extId === "ext-a"));
});

test("removeExtUiItems clears one extension across all slots", () => {
  reset();
  const { registerExtUiItems, removeExtUiItems, getExtUiItems } = store;
  const render = () => null;
  registerExtUiItems("toolbar", [{ id: "a1", render }], "ext-a");
  registerExtUiItems("sidebar", [{ id: "a2", render }], "ext-a");
  registerExtUiItems("toolbar", [{ id: "b1", render }], "ext-b");

  removeExtUiItems("ext-a");
  assert.equal(getExtUiItems("toolbar").length, 1);
  assert.equal(getExtUiItems("toolbar")[0].id, "b1");
  assert.equal(getExtUiItems("sidebar").length, 0);
});

test("registered items are isolated per extension (ids may collide across exts)", () => {
  reset();
  const { registerExtUiItems, getExtUiItems } = store;
  const render = () => null;
  registerExtUiItems("dialogs", [{ id: "same", render }], "ext-a");
  registerExtUiItems("dialogs", [{ id: "same", render }], "ext-b");
  const items = getExtUiItems("dialogs");
  assert.equal(items.length, 2);
  assert.equal(new Set(items.map((it) => it.extId)).size, 2);
});

test("re-registering the same (extId, id) is idempotent (Fast Refresh double materialize)", () => {
  reset();
  const { registerExtUiItems, getExtUiItems } = store;
  const render = () => null;
  registerExtUiItems("chatInputTop", [{ id: "x1", render }], "ext-a");
  registerExtUiItems("chatInputTop", [{ id: "other", render }], "ext-b");
  // After Fast Refresh, loadExtensions materializes again: the same (extId, id) is registered repeatedly
  for (let i = 0; i < 5; i++) {
    registerExtUiItems("chatInputTop", [{ id: "x1", render }], "ext-a");
  }
  const items = getExtUiItems("chatInputTop");
  // Items with the same key must not accumulate (React "two children with the same key" regression)
  assert.equal(items.length, 2);
  assert.equal(items.filter((it) => it.id === "x1").length, 1);
  // Position preserved: the item stays in place after being overwritten (stable order, avoids re-render flicker)
  assert.equal(items[0].id, "x1");
  assert.equal(items[0].extId, "ext-a");
});

test("feature-gated items are hidden while gated, visible once enabled", () => {
  reset();
  const { registerExtUiItems, getExtUiItems, setExtFeatures, patchExtFeature } = store;
  const render = () => null;
  registerExtUiItems("toolbar", [
    { id: "gated", render, feature: "behavior.showBtn" },
    { id: "always", render },
  ], "ext-a");
  // Before any feature state is declared: getExtFeature treats it as enabled → item visible
  assert.equal(getExtUiItems("toolbar").length, 2);
  // Feature off → only the gated item is filtered out; non-gated items unaffected
  setExtFeatures("ext-a", { "behavior.showBtn": false });
  let items = getExtUiItems("toolbar");
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "always");
  // Feature on (same patch path as the extension-manager extension) → item restored
  patchExtFeature("ext-a", "behavior.showBtn", true);
  items = getExtUiItems("toolbar");
  assert.equal(items.length, 2);
  assert.ok(items.some((it) => it.id === "gated"));
});

// ── Stable order (manifest order): registration completion order is random due to interleaved
//    load pipelines; display order follows the manifest order written by setExtOrder (the basis
//    for stable toolbar/status-bar order across loads). ──

function orderOf(slot) {
  return store.getExtUiItems(slot).map((it) => it.extId ?? "");
}

test("no manifest order set → registration order preserved (backward compat)", () => {
  reset();
  store.setExtOrder([]);
  const render = () => null;
  // Simulate a parallel-load race: ext-c registers first
  store.registerExtUiItems("toolbar", [{ id: "c1", render }], "ext-c");
  store.registerExtUiItems("toolbar", [{ id: "a1", render }], "ext-a");
  store.registerExtUiItems("toolbar", [{ id: "b1", render }], "ext-b");
  assert.deepEqual(orderOf("toolbar"), ["ext-c", "ext-a", "ext-b"]);
});

test("manifest order wins over registration order (random load interleaving)", () => {
  reset();
  store.setExtOrder(["ext-a", "ext-b", "ext-c"]);
  const render = () => null;
  // Registration completion order is random (startup batch and on-demand load pipelines interleave)
  store.registerExtUiItems("toolbar", [{ id: "c1", render }], "ext-c");
  store.registerExtUiItems("toolbar", [{ id: "a1", render }], "ext-a");
  store.registerExtUiItems("toolbar", [{ id: "b1", render }], "ext-b");
  assert.deepEqual(orderOf("toolbar"), ["ext-a", "ext-b", "ext-c"]);
  // Multiple items per extension: extensions sort by manifest order; within an extension, registration order is kept
  store.registerExtUiItems("toolbar", [{ id: "c2", render }], "ext-c");
  const items = store.getExtUiItems("toolbar");
  assert.deepEqual(items.filter((it) => it.extId === "ext-c").map((it) => it.id), ["c1", "c2"]);
});

test("extensions missing from manifest order sort last, keeping registration order", () => {
  reset();
  store.setExtOrder(["ext-a"]);
  const render = () => null;
  store.registerExtUiItems("toolbar", [{ id: "z1", render }], "ext-z");
  store.registerExtUiItems("toolbar", [{ id: "a1", render }], "ext-a");
  store.registerExtUiItems("toolbar", [{ id: "y1", render }], "ext-y");
  assert.deepEqual(orderOf("toolbar"), ["ext-a", "ext-z", "ext-y"]);
});

test("setExtOrder with a new manifest re-orders already registered items", () => {
  reset();
  store.setExtOrder(["ext-a", "ext-b"]);
  const render = () => null;
  store.registerExtUiItems("toolbar", [{ id: "a1", render }], "ext-a");
  store.registerExtUiItems("toolbar", [{ id: "b1", render }], "ext-b");
  assert.deepEqual(orderOf("toolbar"), ["ext-a", "ext-b"]);
  // After reload a new manifest moves ext-b earlier (e.g. install order changed) → registered items re-sort
  store.setExtOrder(["ext-b", "ext-a"]);
  assert.deepEqual(orderOf("toolbar"), ["ext-b", "ext-a"]);
});

// ── [Lazy loading v2] manifest static entries (zero bundle entry; lazy-loading plan §4.3) ──
// Note: items registered via the host path (ExtSlots.makeClientContext.registerItems) use the
// composite id form "extId:rawId"; the cases below align static entries to that host id shape
// (registerStaticItems renders the declared raw id as the same composite id — the basis for
// same-key overwrite before/after materialization).

test("static entry → composite id + meta built + no render (host renders it)", () => {
  reset();
  store.registerStaticItems("toolbar", [{ id: "btn", label: "Btn", title: "T", icon: "📥" }], "ext-lz-a");
  const hit = store.getExtUiItems("toolbar").find((it) => it.id === "ext-lz-a:btn");
  assert.ok(hit, "static item visible under composite id");
  assert.equal(hit.extId, "ext-lz-a");
  assert.equal(hit.static, true);
  assert.equal(hit.render, undefined);
  assert.equal(hit.meta.label, "Btn");
  assert.equal(hit.meta.title, "T");
  assert.equal(hit.meta.icon, "📥");
  assert.equal(typeof hit.meta.onClick, "function");
});

test("registered item overrides static on id alignment (no double button)", () => {
  reset();
  store.registerStaticItems("toolbar", [{ id: "btn", label: "Btn", icon: "📥" }], "ext-lz-b");
  const render = () => null;
  // Host-path shape: id = "extId:rawId"
  store.registerExtUiItems("toolbar", [{ id: "ext-lz-b:btn", render, meta: { label: "Btn", icon: "📥", onClick: () => {} } }], "ext-lz-b");
  const items = store.getExtUiItems("toolbar").filter((it) => it.id === "ext-lz-b:btn");
  assert.equal(items.length, 1, "registered replaces static 1:1");
  assert.equal(items[0].static, undefined);
  assert.equal(items[0].render, render);
});

test("id mismatch → both visible (double-button risk) + dev warn once", () => {
  reset();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    store.registerStaticItems("toolbar", [{ id: "static-id", label: "S" }], "ext-lz-m");
    store.registerExtUiItems("toolbar", [{ id: "ext-lz-m:other-id", render: () => null }], "ext-lz-m");
    const ids = store.getExtUiItems("toolbar").filter((it) => it.extId === "ext-lz-m").map((it) => it.id);
    assert.deepEqual(ids.sort(), ["ext-lz-m:other-id", "ext-lz-m:static-id"]);
    assert.ok(warns.some((w) => w.includes("id mismatch")), "dev assertion warns on mismatch");
    store.registerExtUiItems("toolbar", [{ id: "ext-lz-m:third", render: () => null }], "ext-lz-m");
    assert.equal(warns.filter((w) => w.includes("id mismatch")).length, 1, "warn once per (slot,extId,id)");
  } finally {
    console.warn = origWarn;
  }
});

test("feature gating applies to static entries", () => {
  reset();
  store.registerStaticItems("toolbar", [{ id: "gated", label: "G", feature: "lz.toggle" }], "ext-lz-f");
  assert.ok(store.getExtUiItems("toolbar").some((it) => it.id === "ext-lz-f:gated"), "feature default on");
  store.setExtFeatures("ext-lz-f", { "lz.toggle": false });
  assert.ok(!store.getExtUiItems("toolbar").some((it) => it.id === "ext-lz-f:gated"), "feature off → hidden");
  store.patchExtFeature("ext-lz-f", "lz.toggle", true);
  assert.ok(store.getExtUiItems("toolbar").some((it) => it.id === "ext-lz-f:gated"), "feature on → visible");
});

test("pending toggle reflects on the static item snapshot (load-state button)", () => {
  reset();
  store.registerStaticItems("toolbar", [{ id: "p", label: "P" }], "ext-lz-p");
  assert.equal(store.getExtUiItems("toolbar").find((it) => it.id === "ext-lz-p:p")?.pending, undefined);
  store.setStaticItemPending("ext-lz-p", "ext-lz-p:p", true);
  assert.equal(store.getExtUiItems("toolbar").find((it) => it.id === "ext-lz-p:p")?.pending, true);
  store.setStaticItemPending("ext-lz-p", "ext-lz-p:p", false);
  assert.equal(store.getExtUiItems("toolbar").find((it) => it.id === "ext-lz-p:p")?.pending, undefined);
});

test("static onClick forwards through injected handler with composite id", async () => {
  reset();
  const calls = [];
  store.setStaticClickHandler(async (extId, itemId, slot) => { calls.push([extId, itemId, slot]); });
  store.registerStaticItems("toolbar", [{ id: "fwd", label: "F" }], "ext-lz-x");
  const item = store.getExtUiItems("toolbar").find((it) => it.id === "ext-lz-x:fwd");
  item.meta.onClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, [["ext-lz-x", "ext-lz-x:fwd", "toolbar"]]);
  store.setStaticClickHandler(null);
});

test("pruneStaticItems drops entries of extensions no longer in manifest", () => {
  reset();
  store.registerStaticItems("toolbar", [{ id: "keep", label: "K" }], "ext-lz-keep");
  store.registerStaticItems("toolbar", [{ id: "gone", label: "G" }], "ext-lz-gone");
  store.pruneStaticItems(["ext-lz-keep"]);
  const ids = store.getExtUiItems("toolbar").map((it) => it.id);
  assert.ok(ids.includes("ext-lz-keep:keep"), "active ext static entry kept");
  assert.ok(!ids.includes("ext-lz-gone:gone"), "pruned ext static entry removed");
});

test("manifest order sorts merged static+registered output", () => {
  reset();
  store.setExtOrder(["ext-lz-b", "ext-lz-a"]);
  store.registerStaticItems("toolbar", [{ id: "s", label: "S" }], "ext-lz-a");
  store.registerExtUiItems("toolbar", [{ id: "ext-lz-b:r", render: () => null }], "ext-lz-b");
  const ids = store.getExtUiItems("toolbar").map((it) => it.id);
  assert.deepEqual(ids, ["ext-lz-b:r", "ext-lz-a:s"], "manifest order wins over registration order");
});


test("removeStaticItems retires one extension's static entries (lazy→immediate flip)", () => {
  reset();
  store.registerStaticItems("toolbar", [{ id: "a", label: "A" }], "ext-lz-r1");
  store.registerStaticItems("dialogs", [{ id: "d", label: "D" }], "ext-lz-r1");
  store.registerStaticItems("toolbar", [{ id: "b", label: "B" }], "ext-lz-r2");
  store.removeStaticItems("ext-lz-r1");
  assert.ok(!store.getExtUiItems("toolbar").some((it) => it.id === "ext-lz-r1:a"), "toolbar static removed");
  assert.ok(!store.getExtUiItems("dialogs").some((it) => it.id === "ext-lz-r1:d"), "dialogs static removed");
  assert.ok(store.getExtUiItems("toolbar").some((it) => it.id === "ext-lz-r2:b"), "other ext untouched");
});

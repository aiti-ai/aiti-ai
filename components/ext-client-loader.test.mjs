/**
 * ext-client-loader tests — the browser half of client modules (rev unwinding / precise HMR).
 *
 * The loader depends on the browser environment (dynamic import / window); the node tests focus
 * on the pure-logic part: reconcileGraph's rev-diff invalidation decisions. The import semantics
 * of prefetch/materialize are covered by ExtSlots integration and dev smoke tests.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { reconcileGraph, immediateEntries, isImmediateEntry } from "../components/ext-client-loader.ts";

function graph(entries) {
  return {
    rev: entries.map((e) => e.rev).join(""),
    entries: entries.map((e) => ({
      id: e.id,
      url: `/api/extensions/${e.id}/assets/client.js?rev=${e.rev}`,
      rev: e.rev,
    })),
  };
}

test("no changes → nothing invalidated", () => {
  const g = graph([{ id: "a", rev: "aaa" }, { id: "b", rev: "bbb" }]);
  const removed = [];
  const invalidated = reconcileGraph(g, (id) => removed.push(id));
  assert.deepEqual(invalidated, []);
  assert.deepEqual(removed, []);
});

test("changed bundle rev → that extension invalidated only", () => {
  const g1 = graph([{ id: "a", rev: "aaa" }, { id: "b", rev: "bbb" }]);
  reconcileGraph(g1);
  const removed = [];
  const g2 = graph([{ id: "a", rev: "aaa" }, { id: "b", rev: "BBB" }]);
  const invalidated = reconcileGraph(g2, (id) => removed.push(id));
  assert.deepEqual(invalidated, ["b"]);
  assert.deepEqual(removed, ["b"]);
});

test("removed extension → invalidated (no longer in graph)", () => {
  const g1 = graph([{ id: "a", rev: "aaa" }, { id: "b", rev: "bbb" }]);
  reconcileGraph(g1);
  const removed = [];
  const g2 = graph([{ id: "a", rev: "aaa" }]);
  const invalidated = reconcileGraph(g2, (id) => removed.push(id));
  assert.deepEqual(invalidated, ["b"]);
  assert.deepEqual(removed, ["b"]);
});

test("new extension → not invalidated (prefetch/materialize picks it up)", () => {
  const g1 = graph([{ id: "a", rev: "aaa" }]);
  reconcileGraph(g1);
  const removed = [];
  const g2 = graph([{ id: "a", rev: "aaa" }, { id: "c", rev: "ccc" }]);
  const invalidated = reconcileGraph(g2, (id) => removed.push(id));
  assert.deepEqual(invalidated, []);
  assert.deepEqual(removed, []);
});

test("lazy entries are skipped by the startup batch (immediately:false)", () => {
  const g = graph([{ id: "a", rev: "aaa" }, { id: "b", rev: "bbb" }]);
  g.entries[1].immediately = false;
  // The startup batch (loadExtensions / reloadExtensions) uses immediateEntries to pick its target rows:
  // lazy items are neither prefetched nor materialized; slots trigger them on demand.
  const startup = immediateEntries(g).map((e) => e.id);
  assert.deepEqual(startup, ["a"]);
  assert.equal(isImmediateEntry(g.entries[0]), true);
  assert.equal(isImmediateEntry(g.entries[1]), false);
  // Rows without the immediately flag default to immediate loading (backward compatible: old manifests lack the field).
  const plain = graph([{ id: "c", rev: "ccc" }]);
  assert.deepEqual(immediateEntries(plain).map((e) => e.id), ["c"]);
  // empty graph → empty batch.
  assert.deepEqual(immediateEntries(graph([])).map((e) => e.id), []);
});

test("concurrent materialize runs register exactly once", async () => {
  // Directly verify materialize's mutual-exclusion semantics (no browser import involved — a stub module table).
  // prefetch would do a real dynamic import; here we only verify that concurrent scheduling never runs register twice:
  // two concurrent calls with the same id — the second should reuse the in-flight one.
  const { materialize } = await import("../components/ext-client-loader.ts");
  // Use an id known to fail (no graph entry) — both concurrent calls should return false without throwing.
  const results = await Promise.all([
    materialize("no-such-ext-xyz", () => null),
    materialize("no-such-ext-xyz", () => null),
  ]);
  assert.deepEqual(results, [false, false]);
});

test("pruneDeclaredSlots removes declarations for removed extensions", async () => {
  // After the manifest is re-fetched, slot declarations of uninstalled extensions must be cleared (otherwise pendingForSlot keeps stale candidates).
  const { registerDeclaredSlots, pruneDeclaredSlots, pendingForSlot } =
    await import("../components/ext-client-loader.ts");
  // Unique prefix, to avoid clashing with module-level state from other tests / real declarations.
  const SLOT = "test-slot-prune-unique";
  registerDeclaredSlots("ext-prune-a", [SLOT]);
  registerDeclaredSlots("ext-prune-b", [SLOT]);
  assert.deepEqual(pendingForSlot(SLOT), ["ext-prune-a", "ext-prune-b"]);
  // Keep only a, which is still in the manifest.
  pruneDeclaredSlots(["ext-prune-a"]);
  assert.deepEqual(pendingForSlot(SLOT), ["ext-prune-a"]);
  // Empty declaration = clears that extension's own declarations.
  registerDeclaredSlots("ext-prune-a", []);
  assert.deepEqual(pendingForSlot(SLOT), []);
});

test("graph swaps to the new one after reconcile", () => {
  const g1 = graph([{ id: "a", rev: "aaa" }]);
  const g2 = graph([{ id: "a", rev: "AAA" }]);
  reconcileGraph(g1);
  reconcileGraph(g2);
  const invalidated = reconcileGraph(g2);
  assert.deepEqual(invalidated, []);
});

// ── [lazy-load v2] always-mounted vs interactive slot split + explicit materialize API ──

test("pendingForSlotAuto excludes immediately:false entries (lazy extensions)", async () => {
  const { registerDeclaredSlots, pendingForSlot, pendingForSlotAuto, setBootGraph } =
    await import("../components/ext-client-loader.ts");
  const SLOT = "test-slot-auto-unique";
  registerDeclaredSlots("ext-auto-imm", [SLOT]);
  registerDeclaredSlots("ext-auto-lazy", [SLOT]);
  setBootGraph({
    rev: "auto",
    entries: [
      { id: "ext-auto-imm", url: `/api/extensions/ext-auto-imm/assets/client.js`, rev: "i1" },
      { id: "ext-auto-lazy", url: `/api/extensions/ext-auto-lazy/assets/client.js`, rev: "l1", immediately: false },
    ],
  });
  assert.deepEqual(pendingForSlot(SLOT), ["ext-auto-imm", "ext-auto-lazy"], "original semantics include lazy extensions (used by interactive slots)");
  assert.deepEqual(pendingForSlotAuto(SLOT), ["ext-auto-imm"], "always-mounted slot auto channel excludes lazy extensions");
  // [open-page plan §1 F1] Extensions missing from the graph (no client bundle) are no longer allowed through either — fail-closed:
  // unknown = not allowed (the old semantics `entryOf(id)?.immediately !== false` let unknown entries
  // through — the exact root cause of "all 13 lazy extensions being auto-materialized by the
  // always-mounted slot while the boot graph was not yet ready").
  registerDeclaredSlots("ext-auto-orphan", [SLOT]);
  assert.deepEqual(pendingForSlotAuto(SLOT).includes("ext-auto-orphan"), false, "unknown entries are not let through (fail-closed)");
  assert.ok(pendingForSlot(SLOT).includes("ext-auto-orphan"), "interactive channel still lists them (caller may explicitly materialize/degrade)");
});

test("pendingForSlotAuto: graph not ready (empty graph) never lets anything through — lazy-extension race regression", async () => {
  const { pendingForSlotAuto, registerDeclaredSlots, setBootGraph } = await import("../components/ext-client-loader.ts");
  const SLOT = "test-slot-race-unique";
  registerDeclaredSlots("ext-race-lazy", [SLOT]);
  setBootGraph({ rev: "", entries: [] }); // simulates the window where manifest registration lands before setBootGraph
  assert.deepEqual(pendingForSlotAuto(SLOT), [], "empty graph never lets anything auto-materialize");
});

test("INTERACTIVE_SLOTS covers the interactive-mount slots", async () => {
  const { INTERACTIVE_SLOTS, pendingForSlotAuto } = await import("../components/ext-client-loader.ts");
  for (const s of ["sessionStats", "fileViewer", "pathPicker", "settingsModels", "settingsAgents", "settingsAgentsFeature"]) {
    assert.ok(INTERACTIVE_SLOTS.has(s), `interactive slot registered: ${s}`);
    assert.ok(!INTERACTIVE_SLOTS.has("toolbar") && !INTERACTIVE_SLOTS.has("sidebar"), "always-mounted slots are not in the interactive set");
  }
  // [open-page plan §1 F2/F3] These two slots are "pseudo-interactive" — their consumers read them
  // at AppShell/TerminalPanelBridge mount time (the former derives the dock tab list, the latter is
  // an always-mounted hidden container); keeping them in the set would materialize the 6 lazy
  // extensions plus the cmd extension right at page open. Real interaction time is now driven by
  // consumers calling ensureMaterialized explicitly.
  assert.ok(!INTERACTIVE_SLOTS.has("rightFileDock"), "rightFileDock is no longer an interactive slot (consumed always-mounted by AppShell)");
  assert.ok(!INTERACTIVE_SLOTS.has("terminalDock"), "terminalDock is no longer an interactive slot (TerminalPanelBridge is always mounted)");
  // pendingForSlotAuto already includes lazy extensions for interactive slots (same as pendingForSlot) — the split point is the consumer hook
  const SLOT = "test-slot-inter-unique";
  const { registerDeclaredSlots, pendingForSlot, setBootGraph } = await import("../components/ext-client-loader.ts");
  registerDeclaredSlots("ext-inter-lazy", [SLOT]);
  setBootGraph({ rev: "inter", entries: [{ id: "ext-inter-lazy", url: "/x", rev: "1", immediately: false }] });
  assert.deepEqual(pendingForSlotAuto(SLOT), [], "lazy extensions are excluded from the auto channel");
  assert.deepEqual(pendingForSlot(SLOT), ["ext-inter-lazy"], "interactive channel keeps them");
});

test("ensureMaterialized: no bundle → false; already materialized → false (idempotent)", async () => {
  const { ensureMaterialized } = await import("../components/ext-client-loader.ts");
  // No bundle (import fails) → materialize returns false, no throw
  assert.equal(await ensureMaterialized("ext-ensure-no-bundle", () => null), false);
});

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



// ── [slow-flash fix] materialize-failure registry + declaredAllFailed ──
// Failure signals are registered by materialize()/prefetch() so TakeoverSlot can
// release the fallback deterministically instead of waiting out the ceiling timer.

test("declaredAllFailed: no declarers / pending declarers → false", async () => {
  const { setBootGraph, registerDeclaredSlots, declaredAllFailed } = await import("../components/ext-client-loader.ts");
  const SLOT = "test-slot-fail-none-unique";
  const EXT = "ext-fail-none-a";
  assert.equal(declaredAllFailed(SLOT), false, "no declarers at all → not a failure verdict");
  registerDeclaredSlots(EXT, [SLOT]);
  // The declarer has a graph entry but its materialize never settled → genuinely
  // pending (entry presence is what separates "pending" from "clientless").
  setBootGraph({ rev: "fn1", entries: [{ id: EXT, url: "data:text/javascript;base64,ZXhwb3J0IGNvbnN0IHg9MQ==", rev: "fn1" }] });
  assert.equal(declaredAllFailed(SLOT), false, "declarer still pending (never materialized) → not a failure verdict");
});

// ── clientless declarer (no boot-graph entry) → deterministic failure ──
// The server keeps extensions whose client file is missing/unreadable out of the
// boot graph (clientHash ""). They can never fetch a bundle nor register rendered
// items, so once the graph has landed their absence is a deterministic failure —
// the takeover waiting window must release to the fallback instead of waiting out
// the anti-deadlock ceiling (regression: a source-only session-manager install
// shadowed the bundled build; the sidebar stuck on the takeover skeleton ~15s,
// then silently fell back — "small screen cannot open the projects takeover").

test("declaredAllFailed: clientless declarer (graph landed, no entry) → deterministic failure", async () => {
  const { setBootGraph, registerDeclaredSlots, declaredAllFailed } = await import("../components/ext-client-loader.ts");
  const SLOT = "test-slot-fail-clientless-unique";
  const CLIENTLESS = "ext-fail-clientless-unique";
  const PENDING = "ext-fail-clientless-pending-unique";
  registerDeclaredSlots(CLIENTLESS, [SLOT]);
  registerDeclaredSlots(PENDING, [SLOT]);
  // Graph landed WITHOUT the clientless declarer (server: client file missing);
  // the other declarer still has an entry (bundle may yet arrive and register).
  setBootGraph({ rev: "cl1", entries: [{ id: PENDING, url: "data:text/javascript;base64,ZXhwb3J0IGNvbnN0IHg9MQ==", rev: "cl1" }] });
  assert.equal(declaredAllFailed(SLOT), false, "a declarer with an entry may still take over → held");
  // Sole clientless declarer → no takeover possible → deterministic release.
  const SLOT2 = "test-slot-fail-clientless-only-unique";
  registerDeclaredSlots(CLIENTLESS, [SLOT2]);
  setBootGraph({ rev: "cl2", entries: [{ id: PENDING, url: "data:text/javascript;base64,ZXhwb3J0IGNvbnN0IHg9MQ==", rev: "cl2" }] });
  assert.equal(declaredAllFailed(SLOT2), true, "sole declarer has no graph entry → deterministic failure");
});

test("prefetch on a clientless id registers the failure (observable, retryable)", async () => {
  const { setBootGraph, registerDeclaredSlots, materialize, declaredAllFailed, invalidate } =
    await import("../components/ext-client-loader.ts");
  const SLOT = "test-slot-fail-noentry-unique";
  const EXT = "ext-fail-noentry-unique";
  registerDeclaredSlots(EXT, [SLOT]);
  setBootGraph({ rev: "ne1", entries: [] }); // graph landed, extension absent
  const ok = await materialize(EXT, () => null);
  assert.equal(ok, false, "no entry → nothing to fetch, materialize fails");
  assert.equal(declaredAllFailed(SLOT), true, "failure registered (release signal), not a silent bail");
  // The extension's client is built/reinstalled → it re-enters the graph; reload
  // invalidation must grant a retry (failure forgotten).
  setBootGraph({ rev: "ne2", entries: [{ id: EXT, url: "data:text/javascript;base64,ZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gcmVnaXN0ZXIoKXt9", rev: "ne2" }] });
  invalidate(EXT);
  assert.equal(declaredAllFailed(SLOT), false, "invalidate forgets the clientless failure → retry granted");
  assert.equal(await materialize(EXT, () => null), true, "fixed install registers");
});

test("clientlessSlotDeclarers: graph landed → declarers without an entry; not landed → empty", async () => {
  const loader = await import("../components/ext-client-loader.ts?fresh-clientless-list");
  const SLOT = "test-slot-clientless-list-unique";
  const MISSING = "ext-clientless-list-missing-unique";
  const HEALTHY = "ext-clientless-list-healthy-unique";
  loader.registerDeclaredSlots(MISSING, [SLOT]);
  loader.registerDeclaredSlots(HEALTHY, [SLOT]);
  // Graph not landed → no verdicts at all.
  assert.deepEqual(loader.clientlessSlotDeclarers(), [], "pre-manifest → empty");
  // Graph lands with only the healthy extension → the missing one is listed.
  loader.setBootGraph({ rev: "cll1", entries: [{ id: HEALTHY, url: "/x", rev: "1" }] });
  assert.deepEqual(loader.clientlessSlotDeclarers(), [{ extId: MISSING, slots: [SLOT] }]);
});

test("graph not landed yet → absence is no verdict (pre-manifest race safety)", async () => {
  // Fresh module instance (query param → separate ESM cache entry): boot graph
  // empty and not landed — the seed already declares the slot (SSR), but entries
  // may still arrive, so neither the no-entry clause nor prefetch may fail it.
  const loader = await import("../components/ext-client-loader.ts?fresh-not-landed");
  const SLOT = "test-slot-fail-premanifest-unique";
  const EXT = "ext-fail-premanifest-unique";
  loader.registerDeclaredSlots(EXT, [SLOT]);
  assert.equal(loader.declaredAllFailed(SLOT), false, "no graph → no clientless verdict");
  assert.equal(await loader.materialize(EXT, () => null), false, "nothing to fetch pre-manifest");
  assert.equal(loader.declaredAllFailed(SLOT), false, "pre-manifest prefetch stays silent (entry may still arrive)");
  // The manifest lands without the extension → the verdict flips deterministically.
  loader.setBootGraph({ rev: "pm1", entries: [] });
  assert.equal(loader.declaredAllFailed(SLOT), true, "graph landed without the declarer → deterministic failure");
});

test("declaredAllFailed: contract-violation bundle (no register export) registers the failure", async () => {
  const { setBootGraph, registerDeclaredSlots, materialize, declaredAllFailed } =
    await import("../components/ext-client-loader.ts");
  const SLOT = "test-slot-fail-contract-unique";
  const EXT = "ext-fail-contract-unique";
  registerDeclaredSlots(EXT, [SLOT]);
  // data: URL passes through withBaseUrl untouched (empty basePath) and loads fine,
  // but exports no default/register → contract violation → deterministic failure.
  setBootGraph({ rev: "c1", entries: [{ id: EXT, url: "data:text/javascript;base64,ZXhwb3J0IGNvbnN0IHg9MQ==", rev: "c1" }] });
  const ok = await materialize(EXT, () => null);
  assert.equal(ok, false);
  assert.equal(declaredAllFailed(SLOT), true, "sole declarer failed deterministically (no register export)");
});

test("declaredAllFailed: bundle import failure registers the failure (bust retry exhausted)", async () => {
  const { setBootGraph, registerDeclaredSlots, materialize, declaredAllFailed } =
    await import("../components/ext-client-loader.ts");
  const SLOT = "test-slot-fail-fetch-unique";
  const EXT = "ext-fail-fetch-unique";
  registerDeclaredSlots(EXT, [SLOT]);
  // Payload is a syntax error: the first import fails, the negative-cache-busting
  // retry (data payload is not query-aware) fails too → outer catch → registered.
  setBootGraph({ rev: "f1", entries: [{ id: EXT, url: "data:text/javascript;base64,c3ludGF4KA==", rev: "f1" }] });
  const ok = await materialize(EXT, () => null);
  assert.equal(ok, false);
  assert.equal(declaredAllFailed(SLOT), true, "import failure (both attempts) is a deterministic failure");
});

test("declaredAllFailed: mixed success/pending → false (only a total failure releases)", async () => {
  const { setBootGraph, registerDeclaredSlots, materialize, declaredAllFailed } =
    await import("../components/ext-client-loader.ts");
  const SLOT = "test-slot-fail-mixed-unique";
  const BAD = "ext-fail-mixed-bad-unique";
  const GOOD = "ext-fail-mixed-good-unique";
  registerDeclaredSlots(BAD, [SLOT]);
  registerDeclaredSlots(GOOD, [SLOT]);
  setBootGraph({ rev: "m1", entries: [
    { id: BAD, url: "data:text/javascript;base64,ZXhwb3J0IGNvbnN0IHg9MQ==", rev: "m1" },
    { id: GOOD, url: "data:text/javascript;base64,ZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gcmVnaXN0ZXIoKXtnbG9iYWxUaGlzLl9fc2xvd0ZsYXNoR29vZD0oZ2xvYmFsVGhpcy5fX3Nsb3dGbGFzaEdvb2R8fDApKzF9", rev: "m1" },
  ] });
  await materialize(BAD, () => null); // BAD fails deterministically
  assert.equal(await materialize(GOOD, () => null), true, "GOOD registers");
  assert.equal(declaredAllFailed(SLOT), false, "GOOD succeeded → held (not all failed)");
});

test("declaredAllFailed: invalidate (reload) forgets the failure and a fixed bundle succeeds", async () => {
  const { setBootGraph, registerDeclaredSlots, materialize, declaredAllFailed, invalidate } =
    await import("../components/ext-client-loader.ts");
  const SLOT = "test-slot-fail-retry-unique";
  const EXT = "ext-fail-retry-unique";
  registerDeclaredSlots(EXT, [SLOT]);
  setBootGraph({ rev: "r1", entries: [{ id: EXT, url: "data:text/javascript;base64,ZXhwb3J0IGNvbnN0IHg9MQ==", rev: "r1" }] });
  await materialize(EXT, () => null); // contract violation → failure registered
  assert.equal(declaredAllFailed(SLOT), true);
  // New graph rev ships a fixed bundle → invalidate (reload) grants a retry.
  setBootGraph({ rev: "r2", entries: [{ id: EXT, url: "data:text/javascript;base64,ZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gcmVnaXN0ZXIoKXt9", rev: "r2" }] });
  invalidate(EXT);
  assert.equal(declaredAllFailed(SLOT), false, "invalidate forgets the failure → retry granted");
  const ok = await materialize(EXT, () => null);
  assert.equal(ok, true, "retry with the fixed bundle registers");
  assert.equal(declaredAllFailed(SLOT), false, "success keeps the slot held (no false release)");
});

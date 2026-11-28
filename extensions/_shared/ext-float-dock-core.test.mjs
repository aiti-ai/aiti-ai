/**
 * ext-float-dock-core tests — the sidebar dock block stack's pure state layer
 * (order/collapse/legacy key migration).
 *
 * Run: node --experimental-strip-types --test pi-web-ext/_shared/ext-float-dock-core.test.mjs
 *
 * Coverage (logic that produced tie-break bugs during implementation of the sidebar
 * unified dock plan §3.1/§3.6/§3.8):
 * effectiveBlockOrder (user order ∩ present keys + stable priority tail) / moveBlockKey
 * (neighbor swap and boundary no-ops) / moveBlockTo (drag landing before/after
 * insertion) / collapse and order persistence events / the four legacy collapse key
 * migrations (incl. file-explorer semantic inversion, legacy keys kept, no overwrite of
 * existing new keys).
 *
 * Stubs: window (records dispatchEvent/addEventListener) + localStorage (in-memory Map) —
 * core's top level has zero side effects and only touches globals inside function
 * bodies, so stubs just need to be in place before import.
 */
import assert from "node:assert/strict";
import test from "node:test";

const store = new Map();
const dispatched = [];
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = {
  dispatchEvent: (e) => { dispatched.push(e); return true; },
  addEventListener: () => {},
  removeEventListener: () => {},
};

const {
  SIDEBAR_COLLAPSE_EVENT,
  SIDEBAR_ORDER_EVENT,
  effectiveBlockOrder,
  isSidebarDockState,
  migrateLegacyCollapseKeys,
  moveBlockKey,
  moveBlockTo,
  readBlockCollapsed,
  readDockOrder,
  seedBlockCollapsedDefault,
  sidebarZoneOf,
  writeBlockCollapsed,
  writeDockOrder,
} = await import("./ext-float-dock-core.ts");

test("effectiveBlockOrder: stable priority sort with an empty user order (projects0 → tasks1 → files2 → docks3+)", () => {
  const entries = [
    { key: "asr", priority: 3 },
    { key: "fleet", priority: 1 },
    { key: "folder:b", priority: 2 },
    { key: "projects", priority: 0 },
    { key: "prompts", priority: 3 },
    { key: "folder:a", priority: 2 },
  ];
  assert.deepEqual(
    effectiveBlockOrder(entries, []).map((e) => e.key),
    ["projects", "fleet", "folder:b", "folder:a", "asr", "prompts"],
  );
});

test("effectiveBlockOrder: user order first (∩ present keys), the rest appended by priority", () => {
  const entries = [
    { key: "projects", priority: 0 },
    { key: "fleet", priority: 1 },
    { key: "folder:a", priority: 2 },
    { key: "prompts", priority: 3 },
  ];
  assert.deepEqual(
    effectiveBlockOrder(entries, ["prompts", "projects", "missing-key"]).map((e) => e.key),
    ["prompts", "projects", "fleet", "folder:a"],
  );
});

test("isSidebarDockState: canonical sidebar:* and legacy sidebar-explorer both hit; right-panel/float don't", () => {
  assert.equal(isSidebarDockState("docked:sidebar:aiti-prompts:panel"), true);
  assert.equal(isSidebarDockState("docked:sidebar-explorer"), true);
  assert.equal(isSidebarDockState("docked:right-panel"), false);
  assert.equal(isSidebarDockState("floating"), false);
  assert.equal(isSidebarDockState("closed"), false);
});

test("sidebarZoneOf: blockKey is the itemKey", () => {
  assert.equal(sidebarZoneOf("aiti-prompts:panel"), "sidebar:aiti-prompts:panel");
});

test("writeBlockCollapsed/readBlockCollapsed round-trip + event broadcast", () => {
  dispatched.length = 0;
  assert.equal(readBlockCollapsed("x"), false);
  writeBlockCollapsed("x", true);
  assert.equal(readBlockCollapsed("x"), true);
  assert.equal(dispatched.filter((e) => e.type === SIDEBAR_COLLAPSE_EVENT).length, 1);
});

test("seedBlockCollapsedDefault: seeds only without a record, never overwrites after user action", () => {
  // no record → write the default collapsed state
  seedBlockCollapsedDefault("seed-proj", false);
  assert.equal(readBlockCollapsed("seed-proj"), false);
  seedBlockCollapsedDefault("seed-folder", true);
  assert.equal(readBlockCollapsed("seed-folder"), true);
  // existing record (user manual) → no overwrite
  writeBlockCollapsed("seed-folder", false);
  seedBlockCollapsedDefault("seed-folder", true);
  assert.equal(readBlockCollapsed("seed-folder"), false);
});

test("writeDockOrder/readDockOrder round-trip + event broadcast", () => {
  dispatched.length = 0;
  writeDockOrder(["b", "a"]);
  assert.deepEqual(readDockOrder(), ["b", "a"]);
  assert.equal(dispatched.filter((e) => e.type === SIDEBAR_ORDER_EVENT).length, 1);
});

test("moveBlockKey: neighbor swap + boundary no-ops + unknown-key no-op", () => {
  const keys = ["a", "b", "c"];
  store.delete("pi:sidebar-dock:order");
  moveBlockKey("b", -1, keys);
  assert.deepEqual(readDockOrder(), ["b", "a", "c"]);
  moveBlockKey("b", -1, keys); // already first → no-op
  assert.deepEqual(readDockOrder(), ["b", "a", "c"]);
  moveBlockKey("c", 1, keys); // already last → no-op
  assert.deepEqual(readDockOrder(), ["b", "a", "c"]);
  moveBlockKey("missing", 1, keys);
  assert.deepEqual(readDockOrder(), ["b", "a", "c"]);
});

test("moveBlockTo: respects the existing user order (real effective-order input)", () => {
  store.set("pi:sidebar-dock:order", JSON.stringify(["b", "a", "c"]));
  moveBlockTo("a", "b", ["b", "a", "c"], true); // move a before b
  assert.deepEqual(readDockOrder(), ["a", "b", "c"]);
});

test("moveBlockTo: key===target no-op", () => {
  store.set("pi:sidebar-dock:order", JSON.stringify(["a", "b"]));
  moveBlockTo("a", "a", ["a", "b"], true);
  assert.deepEqual(readDockOrder(), ["a", "b"]);
});

test("migrateLegacyCollapseKeys: migrates the four legacy keys (incl. file-explorer inversion) and keeps the legacy keys", () => {
  store.set("pi-web:sidebar-projects-collapsed", "1");            // sm encoding: collapsed
  store.set("pi-sidebar-tasks-collapsed", "false");               // host encoding: expanded
  store.set("pi-web:sidebar-explorer-dock-collapsed", "true");    // collapsed
  store.set("pi-web:file-explorer:open", "false");                // expanded → inverted to collapsed
  migrateLegacyCollapseKeys();
  assert.equal(readBlockCollapsed("projects"), true);
  assert.equal(readBlockCollapsed("tasks"), false);
  assert.equal(readBlockCollapsed("docks"), true);
  assert.equal(readBlockCollapsed("files"), true);
  // legacy keys kept (a rolled-back old host can still read them)
  assert.equal(store.get("pi-web:sidebar-projects-collapsed"), "1");
  assert.equal(store.get("pi-web:file-explorer:open"), "false");
});

test("migrateLegacyCollapseKeys: no overwrite when the new key already exists", () => {
  writeBlockCollapsed("projects", false);
  migrateLegacyCollapseKeys(); // once guard in place — just assert no overwrite
  assert.equal(readBlockCollapsed("projects"), false);
});

/* ── v4 alignment grouping: splitBlockAlign (top/bottom aligned) ── */

const { splitBlockAlign } = await import("./ext-float-dock-core.ts");

test("splitBlockAlign: without a declared align everything joins the default group (top)", () => {
  const entries = [{ key: "a" }, { key: "b" }];
  const { top, bottom } = splitBlockAlign(entries);
  assert.deepEqual(top.map((e) => e.key), ["a", "b"]);
  assert.deepEqual(bottom, []);
});

test("splitBlockAlign: mixed grouping keeps the effective order's within-group relative order (projects/scheduled tasks pinned top, folders/docks pinned bottom)", () => {
  // simulate DockStack construction output: blocks default top, dockable items default bottom
  const entries = [
    { key: "projects", align: "top" },
    { key: "aiti-ai-schedule:panel", align: "top" },
    { key: "folder:/a", align: "bottom" },
    { key: "aiti-prompts:panel", align: "bottom" },
    { key: "aiti-ai-input:asr", align: "bottom" },
  ];
  const { top, bottom } = splitBlockAlign(entries, "top");
  assert.deepEqual(top.map((e) => e.key), ["projects", "aiti-ai-schedule:panel"]);
  assert.deepEqual(bottom.map((e) => e.key), ["folder:/a", "aiti-prompts:panel", "aiti-ai-input:asr"]);
});

test("splitBlockAlign: defaultAlign=bottom (dockable default bottom-align semantics)", () => {
  const entries = [{ key: "x" }, { key: "y", align: "top" }];
  const { top, bottom } = splitBlockAlign(entries, "bottom");
  assert.deepEqual(top.map((e) => e.key), ["y"]);
  assert.deepEqual(bottom.map((e) => e.key), ["x"]);
});

test("splitBlockAlign: within-group order follows a user reorder (cross-group moves are clamped by the container; only the grouping pure function is verified here)", () => {
  // user moves scheduled tasks before projects (legal within the same group): effective order [sched, projects] → top group same order
  const entries = [
    { key: "aiti-ai-schedule:panel", align: "top" },
    { key: "projects", align: "top" },
    { key: "folder:/a", align: "bottom" },
  ];
  const { top, bottom } = splitBlockAlign(entries, "top");
  assert.deepEqual(top.map((e) => e.key), ["aiti-ai-schedule:panel", "projects"]);
  assert.deepEqual(bottom.map((e) => e.key), ["folder:/a"]);
});

/* ── v3 dock header toolbar store: actions/commands/state/menuItems/pending ── */

const { createDockHeaderStore, DOCK_HEADER_PENDING_TTL } = await import("./ext-float-dock-core.ts");

function freshStore() {
  const s = createDockHeaderStore();
  const notes = new Map(); // key -> count
  let sub = null;
  return {
    s,
    notes,
    watch(key) { notes.set(key, 0); sub = s.subscribe(key, () => notes.set(key, (notes.get(key) || 0) + 1)); },
    unwatch() { sub && sub(); sub = null; },
  };
}

test("headerStore: register partial-field merge + reads", () => {
  const { s } = freshStore();
  const un = s.register("k", { actions: [{ id: "a", title: "A", onClick: () => {} }], state: { open: true } });
  assert.equal(s.actionsOf("k")?.length, 1);
  assert.deepEqual(s.stateOf("k"), { open: true });
  assert.equal(s.commandsOf("k"), null);
  assert.equal(s.menuItemsOf("k"), null);
  // register commands/menuItems again (merge)
  s.register("k", { commands: { go: () => {} }, menuItems: [{ kind: "item", label: "X", run: () => {} }] });
  assert.equal(typeof s.commandsOf("k")?.go, "function");
  assert.equal(s.menuItemsOf("k")?.length, 1);
  assert.equal(s.actionsOf("k")?.length, 1); // not overwritten
  un(); // disposer clears this round's actions/state
  assert.equal(s.actionsOf("k"), null);
  assert.deepEqual(s.stateOf("k"), {});
  assert.equal(s.menuItemsOf("k")?.length, 1); // fields not registered this time are kept
});

test("headerStore: state signature dedupe (same value no notify, change notifies)", () => {
  const { s, notes, watch } = freshStore();
  watch("k");
  s.register("k", { state: { a: 1 } });
  assert.equal(notes.get("k"), 1);
  s.register("k", { state: { a: 1 } }); // same value (new reference) → no notify
  assert.equal(notes.get("k"), 1);
  s.register("k", { state: { a: 2 } });
  assert.equal(notes.get("k"), 2);
});

test("headerStore: actions signature change notifies (onClick change doesn't, visual field change does)", () => {
  const { s, notes, watch } = freshStore();
  watch("k");
  const mk = (active) => [{ id: "a", title: "A", active, onClick: () => {} }];
  s.register("k", { actions: mk(false) });
  assert.equal(notes.get("k"), 1);
  s.register("k", { actions: mk(false) }); // only a new onClick reference → no notify
  assert.equal(notes.get("k"), 1);
  s.register("k", { actions: mk(true) });
  assert.equal(notes.get("k"), 2);
});

test("headerStore: request hits a command (payload passed through)", () => {
  const { s } = freshStore();
  const seen = [];
  s.register("k", { commands: { go: (p) => seen.push(p) } });
  assert.equal(s.request("k", "go", { x: 1 }), true);
  assert.deepEqual(seen, [{ x: 1 }]);
});

test("headerStore: request miss → expand + pending; runs once when the command registers (payload kept)", () => {
  const { s } = freshStore();
  const key = "aiti-demo:panel";
  writeBlockCollapsed(key, true);
  const seen = [];
  assert.equal(s.request(key, "search", { anchor: { top: 10 } }), false);
  assert.equal(readBlockCollapsed(key), false); // auto-expanded
  s.register(key, { commands: { search: (p) => seen.push(p) } });
  assert.deepEqual(seen, [{ anchor: { top: 10 } }]); // back-run
  s.register(key, { commands: { search: (p) => seen.push(p) } }); // pending already cleared, no repeat
  assert.equal(seen.length, 1);
});

test("headerStore: pending TTL expiry does not run", () => {
  const { s } = freshStore();
  const key = "aiti-demo:ttl";
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    s.request(key, "x");
    now += DOCK_HEADER_PENDING_TTL + 1;
    const seen = [];
    s.register(key, { commands: { x: () => seen.push(1) } });
    assert.equal(seen.length, 0);
  } finally {
    Date.now = realNow;
  }
});

test("headerStore: multi-key isolation", () => {
  const { s } = freshStore();
  s.register("k1", { state: { v: 1 } });
  s.register("k2", { state: { v: 2 } });
  assert.deepEqual(s.stateOf("k1"), { v: 1 });
  assert.deepEqual(s.stateOf("k2"), { v: 2 });
  s.request("k2", "only2");
  const seen = [];
  s.register("k1", { commands: { only2: () => seen.push("k1") } });
  assert.equal(seen.length, 0); // k1 doesn't consume k2's pending
  s.register("k2", { commands: { only2: () => seen.push("k2") } });
  assert.deepEqual(seen, ["k2"]);
});

test("positionMenuItems/positionMenuModel (v5 icon row): icon/isDefault/active and the float item", async () => {
  const { positionMenuItems, positionMenuModel } = await import("./ext-float-dock-core.ts");
  // two zones (sidebar family + right panel), sidebar default; current state = docked right
  const items = positionMenuItems("x:p", ["sidebar:x:p", "right-panel"], "sidebar:x:p", "docked:right-panel");
  assert.deepEqual(items.map((i) => i.key), ["sidebar-explorer", "right-panel"], "sidebar family collapses into one item");
  assert.deepEqual(items.map((i) => i.icon), ["panel-left", "panel-right"], "zone icon names");
  assert.deepEqual(items.map((i) => i.isDefault), [true, false], "default-position verdict");
  assert.deepEqual(items.map((i) => i.active), [false, true], "active-state verdict (family compat)");
  // the model has the float item first; active while floating
  const model = positionMenuModel("x:p", ["sidebar:x:p", "right-panel"], "right-panel", "floating");
  assert.deepEqual(model.map((i) => i.key), ["float", "sidebar-explorer", "right-panel"], "float → each dock position");
  assert.equal(model[0].icon, "float");
  assert.equal(model[0].active, true, "floating state highlighted");
  assert.equal(model[2].isDefault, true, "right panel is the default");
  // The newWindow item (its zh-CN word-table label; 2026-09-15 ruling): sorts first when onNewWindow is
  // provided (glyph B); absent + unregistered = not shown ("some unsupported for now"
  // decided by capability registration)
  const withWin = positionMenuModel("x:p", ["sidebar:x:p", "right-panel"], "right-panel", "floating", { onNewWindow: () => {} });
  assert.deepEqual(withWin.map((i) => i.key), ["new-window", "float", "sidebar-explorer", "right-panel"], "new window → float → each dock position");
  assert.equal(withWin[0].icon, "new-window");
  assert.equal(withWin[0].active, undefined, "new-window item is not a position state (role=menuitem)");
});

test("resolveDropZone/SIDEBAR_DROP_ZONE (drag-drop-unify §3.1): wildcard sidebar drop resolution", async () => {
  const { resolveDropZone, SIDEBAR_DROP_ZONE } = await import("./ext-float-dock-core.ts");
  assert.equal(SIDEBAR_DROP_ZONE, "sidebar");
  // exact hit: a marker inside the panel's declared zones returns as-is (existing right-panel behavior unchanged)
  assert.equal(resolveDropZone("right-panel", ["sidebar:x:p", "right-panel"]), "right-panel");
  // wildcard: the public marker "sidebar" → the panel's first declared sidebar:* zone
  assert.equal(resolveDropZone("sidebar", ["right-panel", "sidebar:x:p"]), "sidebar:x:p");
  // legacy sidebar-explorer accepted too
  assert.equal(resolveDropZone("sidebar", ["sidebar-explorer"]), "sidebar-explorer");
  // panel declares no sidebar family → no landing
  assert.equal(resolveDropZone("sidebar", ["right-panel"]), null);
  // marker outside the declared set and not the wildcard → no landing
  assert.equal(resolveDropZone("right-panel", ["sidebar:x:p"]), null);
  assert.equal(resolveDropZone("", ["right-panel"]), null);
});

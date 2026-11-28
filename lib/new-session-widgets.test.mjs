import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  NSW_PREF_KEY,
  normalizeWidgetItem,
  readNewSessionWidgetPref,
  resolveWidgetLayout,
} = await jiti.import("./new-session-widgets.ts");

// ── normalizeWidgetItem ──

test("normalize: defaults (w4 h1, both areas, default=top)", () => {
  const it = normalizeWidgetItem({ id: "x", title: "X" });
  assert.deepEqual(it.areas, ["top", "bottom"]);
  assert.equal(it.defaultArea, "top");
  assert.equal(it.w, 4);
  assert.equal(it.h, 1);
  assert.equal(it.priority, 0);
});

test("normalize: clamps w/h and falls back on invalid areas", () => {
  const it = normalizeWidgetItem({ id: "x", title: "X", areas: [], defaultArea: "bottom", w: 99, h: -3 });
  assert.deepEqual(it.areas, ["top", "bottom"]);
  assert.equal(it.defaultArea, "bottom");
  assert.equal(it.w, 8);
  assert.equal(it.h, 1);
});

test("normalize: defaultArea outside allowed set falls back to areas[0]", () => {
  const it = normalizeWidgetItem({ id: "x", title: "X", areas: ["top"], defaultArea: "bottom" });
  assert.equal(it.defaultArea, "top");
});

// ── resolveWidgetLayout ──

const items = (defs) => defs.map((d) => normalizeWidgetItem(d));

test("no pref: items land in defaultArea sorted by priority", () => {
  const list = items([
    { id: "a", title: "A", defaultArea: "bottom", priority: 2 },
    { id: "b", title: "B", priority: 1 },
    { id: "c", title: "C", defaultArea: "bottom", priority: 1 },
  ]);
  const layout = resolveWidgetLayout(list, null);
  assert.deepEqual(layout.top, ["b"]);
  assert.deepEqual(layout.bottom, ["c", "a"]);
  assert.deepEqual(layout.hidden, []);
  assert.equal(layout.isDefault, true);
});

test("user order wins within area; stale ids dropped", () => {
  const list = items([
    { id: "a", title: "A" },
    { id: "b", title: "B" },
    { id: "c", title: "C" },
  ]);
  const layout = resolveWidgetLayout(list, { top: ["c", "ghost:x", "a"], bottom: [], hidden: [] });
  assert.deepEqual(layout.top, ["c", "a", "b"]);
  assert.deepEqual(layout.bottom, []);
  assert.equal(layout.isDefault, false);
});

test("hidden items excluded from both areas; stale hidden ids dropped", () => {
  const list = items([{ id: "a", title: "A" }, { id: "b", title: "B" }]);
  const layout = resolveWidgetLayout(list, { top: [], bottom: [], hidden: ["b", "gone:x"] });
  assert.deepEqual(layout.top, ["a"]);
  assert.deepEqual(layout.bottom, []);
  assert.deepEqual(layout.hidden, ["b"]);
});

test("item moved to disallowed area falls back to defaultArea", () => {
  const list = items([
    { id: "fix", title: "Fixed", areas: ["bottom"], defaultArea: "bottom" },
    { id: "free", title: "Free", areas: ["top", "bottom"], defaultArea: "top" },
  ]);
  // pref places fix in top (not allowed) — skipped at resolve time, falls back to bottom; free is fine.
  const layout = resolveWidgetLayout(list, { top: ["fix"], bottom: [], hidden: [] });
  assert.deepEqual(layout.top, ["free"]);
  assert.deepEqual(layout.bottom, ["fix"]);
});

test("duplicate id across area lists places once (first list wins)", () => {
  const list = items([{ id: "a", title: "A" }]);
  const layout = resolveWidgetLayout(list, { top: ["a"], bottom: ["a"], hidden: [] });
  assert.deepEqual(layout.top, ["a"]);
  assert.deepEqual(layout.bottom, []);
});

test("empty items: layout is empty regardless of pref", () => {
  const layout = resolveWidgetLayout([], { top: ["a"], bottom: [], hidden: ["a"] });
  assert.deepEqual(layout.top, []);
  assert.deepEqual(layout.bottom, []);
  assert.deepEqual(layout.hidden, []);
});

// ── readNewSessionWidgetPref (SSR guard + fault tolerance) ──

test("read pref is SSR-safe and tolerates corrupt JSON", () => {
  // No window (SSR / plain node) → null, no throw.
  assert.equal(readNewSessionWidgetPref(), null);
  // Build a fake window to exercise the fault-tolerance path.
  const errors = [];
  const fakeWindow = {
    localStorage: {
      getItem: (key) => {
        assert.equal(key, NSW_PREF_KEY);
        return "{broken json";
      },
    },
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const g = globalThis;
  const prevWindow = g.window;
  g.window = fakeWindow;
  try {
    assert.equal(readNewSessionWidgetPref(), null);
  } catch (e) {
    errors.push(e);
  } finally {
    if (prevWindow === undefined) delete g.window; else g.window = prevWindow;
  }
  assert.deepEqual(errors, []);
});

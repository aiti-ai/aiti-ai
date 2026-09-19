import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  SEPARATOR,
  DEFAULT_TOPBAR_ORDER,
  readTopbarOrder,
  readTopbarHidden,
  writeTopbarOrder,
  writeTopbarHidden,
  normalizeTopbarOrder,
  resolveTopbarLayout,
} = await jiti.import("./topbar-order.ts");

const AVAILABLE = [
  "theme", "language", "services",
  "aiti-devtools:aiti-inspect", "aiti-devtools:aiti-open",
  "history", "export", "title", "branch", "system",
];
const DEFAULT = [
  "theme", "language", "services",
  "aiti-devtools:aiti-inspect", "aiti-devtools:aiti-open",
  "history", "export", "title", "branch", "system",
];

test("no customization falls back to the default order", () => {
  const layout = resolveTopbarLayout(null, null, AVAILABLE, DEFAULT);
  assert.deepEqual(layout.visible, DEFAULT);
  assert.deepEqual(layout.order, DEFAULT);
  assert.deepEqual(layout.hidden, []);
  assert.equal(layout.isDefault, true);
});

test("user order wins, missing ids are dropped, unknown ids filtered", () => {
  const layout = resolveTopbarLayout(
    ["services", "theme", "ghost-ext:button", "language"],
    null,
    AVAILABLE,
    DEFAULT,
  );
  assert.deepEqual(layout.visible, ["services", "theme", "language", ...AVAILABLE.slice(3)]);
  assert.deepEqual(layout.order, layout.visible);
});

test("hidden buttons keep their position in the panel list and drop from visible", () => {
  const layout = resolveTopbarLayout(
    ["services", "theme", "language", "history"],
    ["theme"],
    AVAILABLE,
    DEFAULT,
  );
  // panel keeps theme at its stored position (dimmed there)
  assert.deepEqual(layout.order, ["services", "theme", "language", "history", "aiti-devtools:aiti-inspect", "aiti-devtools:aiti-open", "export", "title", "branch", "system"]);
  // visible strips it
  assert.deepEqual(layout.visible, ["services", "language", "history", "aiti-devtools:aiti-inspect", "aiti-devtools:aiti-open", "export", "title", "branch", "system"]);
  assert.deepEqual(layout.hidden, ["theme"]);
  assert.equal(layout.isDefault, false);
});

test("stale hidden ids are dropped", () => {
  const layout = resolveTopbarLayout(null, ["ghost-ext:button", "theme"], AVAILABLE, DEFAULT);
  assert.deepEqual(layout.hidden, ["theme"]);
  assert.equal(layout.visible.includes("ghost-ext:button"), false);
});

test("separators are preserved in order and normalized (lead/trail/consecutive)", () => {
  // leading and consecutive separators collapse; the separator between
  // buttons (after the default tail was appended) stays.
  const layout = resolveTopbarLayout(
    [SEPARATOR, SEPARATOR, "theme", SEPARATOR, SEPARATOR, "language", SEPARATOR],
    null,
    AVAILABLE,
    DEFAULT,
  );
  assert.deepEqual(layout.order, ["theme", SEPARATOR, "language", SEPARATOR, "services", ...AVAILABLE.slice(3)]);
  assert.deepEqual(layout.visible, layout.order);
});

test("consecutive separators always collapse to one", () => {
  const layout = resolveTopbarLayout(
    ["theme", SEPARATOR, SEPARATOR, "language", SEPARATOR, SEPARATOR, "services"],
    null,
    AVAILABLE,
    DEFAULT,
  );
  assert.deepEqual(
    layout.visible.slice(0, 5),
    ["theme", SEPARATOR, "language", SEPARATOR, "services"],
  );
});

test("hidden button anchoring a separator collapses in visible, keeps both in panel", () => {
  const layout = resolveTopbarLayout(
    ["theme", SEPARATOR, "language", SEPARATOR, "services"],
    ["language"],
    AVAILABLE,
    DEFAULT,
  );
  // panel keeps both separators around the hidden button (it anchors them)
  assert.deepEqual(layout.order, ["theme", SEPARATOR, "language", SEPARATOR, "services", ...AVAILABLE.slice(3)]);
  // visible collapses the two separators into one
  assert.deepEqual(layout.visible, ["theme", SEPARATOR, "services", ...AVAILABLE.slice(3)]);
});

test("restoring the hidden button brings the two separators back", () => {
  const layout = resolveTopbarLayout(
    ["theme", SEPARATOR, "language", SEPARATOR, "services"],
    [], // unhidden
    AVAILABLE,
    DEFAULT,
  );
  assert.deepEqual(
    layout.visible.slice(0, 5),
    ["theme", SEPARATOR, "language", SEPARATOR, "services"],
  );
});

test("normalizeTopbarOrder drops leading/trailing and collapses consecutive", () => {
  assert.deepEqual(normalizeTopbarOrder([SEPARATOR, SEPARATOR, "a", SEPARATOR, SEPARATOR, "b", SEPARATOR]), ["a", SEPARATOR, "b"]);
  assert.deepEqual(normalizeTopbarOrder(["a"]), ["a"]);
  assert.deepEqual(normalizeTopbarOrder([]), []);
  assert.deepEqual(normalizeTopbarOrder([SEPARATOR]), []);
});

test("isDefault only when nothing was customized", () => {
  assert.equal(resolveTopbarLayout(null, null, AVAILABLE, DEFAULT).isDefault, true);
  // reordered → not default
  assert.equal(resolveTopbarLayout(["services", "theme"], null, AVAILABLE, DEFAULT).isDefault, false);
  assert.equal(resolveTopbarLayout(null, ["theme"], AVAILABLE, DEFAULT).isDefault, false);
  assert.equal(
    resolveTopbarLayout(["theme", SEPARATOR, "language"], null, AVAILABLE, DEFAULT).isDefault,
    false,
  );
  // same order as default but explicitly stored → still default (nothing to reset)
  assert.equal(resolveTopbarLayout(DEFAULT.slice(), null, AVAILABLE, DEFAULT).isDefault, true);
});

test("default-order tail: hidden buttons drop from visible but stay in the panel list (restorable)", () => {
  const layout = resolveTopbarLayout(null, ["history", "ghost:1"], AVAILABLE, DEFAULT);
  // not in the rendered row
  assert.equal(layout.visible.includes("history"), false);
  assert.equal(layout.visible.includes("ghost:1"), false);
  // still in the panel list at its default position, greyed → restorable
  assert.equal(layout.order.includes("history"), true);
  assert.equal(layout.order.indexOf("history"), DEFAULT.indexOf("history"));
  assert.deepEqual(layout.hidden, ["history"]);
  // stale ids are dropped everywhere
  assert.equal(layout.order.includes("ghost:1"), false);
});

test("extension items participate in ordering", () => {
  const layout = resolveTopbarLayout(
    ["aiti-devtools:aiti-open", "theme"],
    null,
    AVAILABLE,
    DEFAULT,
  );
  assert.equal(layout.visible[0], "aiti-devtools:aiti-open");
  assert.equal(layout.visible[1], "theme");
});

test("localStorage read/write round-trip and corruption fallback", () => {
  const original = globalThis.window;
  const store = new Map();
  // minimal localStorage stub
  globalThis.window = {
    localStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => { store.set(k, v); },
    },
  };
  try {
    assert.equal(readTopbarOrder(), null);
    assert.equal(readTopbarHidden(), null);
    writeTopbarOrder(["theme", SEPARATOR, "language"]);
    writeTopbarHidden(["system"]);
    assert.deepEqual(readTopbarOrder(), ["theme", SEPARATOR, "language"]);
    assert.deepEqual(readTopbarHidden(), ["system"]);
    store.set("pi-topbar-order", "{bad json");
    assert.equal(readTopbarOrder(), null);
    store.set("pi-topbar-order", JSON.stringify({ not: "array" }));
    assert.equal(readTopbarOrder(), null);
    store.set("pi-topbar-hidden", JSON.stringify(["system", SEPARATOR]));
    assert.deepEqual(readTopbarHidden(), ["system"]);
  } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
});

test("DEFAULT_TOPBAR_ORDER has no separators and no duplicates", () => {
  assert.equal(DEFAULT_TOPBAR_ORDER.includes(SEPARATOR), false);
  assert.equal(new Set(DEFAULT_TOPBAR_ORDER).size, DEFAULT_TOPBAR_ORDER.length);
});

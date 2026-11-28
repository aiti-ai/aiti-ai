/**
 * action-icons tests — icon table integrity + provider icon resolution contract.
 *
 * resolveActionIcon priority: item.icon ({svg} inline | semantic name | short text)
 * → item.type → fallbackType → null. Every unknown value must degrade to "no icon",
 * never throw or return a broken glyph.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_ICON_NODES, ACTION_ICON_SVG_MAX,
  resolveActionIcon, actionIconDecl, actionIconReactAttrs, validateActionIconTable,
} from "../client/src/action-icons.js";

test("icon table is complete and well-formed", () => {
  assert.deepEqual(validateActionIconTable(), []);
  // The semantics the popover actually renders must all exist.
  for (const name of ["copy", "quote", "quote-line", "new-session", "share", "file", "folder-open", "reveal", "command", "url", "bookmark", "code"]) {
    assert.ok(ACTION_ICON_NODES[name], `missing built-in icon: ${name}`);
  }
});

test("actionIconDecl returns host-contract { svg } markup without an <svg> wrapper", () => {
  const decl = actionIconDecl("copy");
  assert.match(decl.svg, /^<rect /);
  assert.match(decl.svg, /<path d="/);
  assert.ok(!decl.svg.includes("<svg"));
  assert.equal(actionIconDecl("no-such-icon"), null);
});

test("resolveActionIcon: {svg} inline markup wins (msg-share shape)", () => {
  const res = resolveActionIcon({ icon: { svg: '<circle cx="18" cy="5" r="3"/>' }, type: "share" });
  assert.deepEqual(res, { kind: "svg", value: '<circle cx="18" cy="5" r="3"/>' });
});

test("resolveActionIcon: oversized {svg} degrades to type fallback", () => {
  const big = { svg: "x".repeat(ACTION_ICON_SVG_MAX + 1) };
  assert.deepEqual(resolveActionIcon({ icon: big, type: "command" }), { kind: "name", value: "command" });
  assert.equal(resolveActionIcon({ icon: big }), null);
});

test("resolveActionIcon: semantic name → name; unknown path-like → type fallback", () => {
  assert.deepEqual(resolveActionIcon({ icon: "bookmark" }), { kind: "name", value: "bookmark" });
  assert.deepEqual(resolveActionIcon({ icon: "icons/share-2.svg", type: "share" }), { kind: "name", value: "share" });
  assert.equal(resolveActionIcon({ icon: "icons/mystery.svg" }), null);
});

test("resolveActionIcon: short text/emoji stays text; longer strings degrade", () => {
  assert.deepEqual(resolveActionIcon({ icon: "📌" }), { kind: "text", value: "📌" });
  assert.equal(resolveActionIcon({ icon: "a-very-long-label" }), null);
});

test("resolveActionIcon: type fallback (aiti-cmd shape) and fallbackType (inline-code shape)", () => {
  assert.deepEqual(resolveActionIcon({ type: "command" }), { kind: "name", value: "command" });
  assert.deepEqual(resolveActionIcon({}), null);
  assert.deepEqual(resolveActionIcon({}, "command"), { kind: "name", value: "command" });
  // explicit type beats fallbackType; unknown type + unknown fallbackType → none
  assert.deepEqual(resolveActionIcon({ type: "share" }, "command"), { kind: "name", value: "share" });
  assert.equal(resolveActionIcon({ type: "mystery" }, "mystery"), null);
});

test("resolveActionIcon: icon beats type; null/empty item safe", () => {
  assert.deepEqual(resolveActionIcon({ icon: { svg: "<path/>" }, type: "command" }), { kind: "svg", value: "<path/>" });
  assert.equal(resolveActionIcon(null), null);
  assert.equal(resolveActionIcon(undefined), null);
  assert.equal(resolveActionIcon({ icon: "" }), null);
  assert.equal(resolveActionIcon({ icon: { svg: "   " } }), null);
});

test("actionIconReactAttrs: kebab-case SVG attrs → camelCase; aria-/data- pass through", () => {
  const out = actionIconReactAttrs({ "stroke-width": 2, "stroke-linecap": "round", cx: 3, "aria-hidden": "true", "data-x": 1 });
  assert.deepEqual(out, { strokeWidth: 2, strokeLinecap: "round", cx: 3, "aria-hidden": "true", "data-x": 1 });
});

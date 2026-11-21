/**
 * float-yield.pure unit tests (node --test): geometry thresholds of the float yield decision.
 *
 * Covers the field-reported scenarios:
 *   1. All Sessions maximized/full-screen (isFull) → must yield (session opens behind it)
 *   2. Docked / default float (680×700) → must not yield (consecutive picks keep working)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { coversMainArea, COVER_RATIO } from "./float-yield.pure.ts";

const VIEW = { width: 1600, height: 900 };

/** Build a rect from top-left + size */
function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

test("coversMainArea: maximized / small-screen full always yields", () => {
  // isFull wins even for a small rect (during small-screen full the rect may be stale)
  assert.equal(coversMainArea(rect(100, 100, 200, 200), VIEW, true), true);
  assert.equal(coversMainArea(null, VIEW, true), true);
});

test("coversMainArea: default float (680×700 centered) does not yield", () => {
  const r = rect((1600 - 680) / 2, (900 - 700) / 2, 680, 700);
  assert.ok((680 * 700) / (1600 * 900) < COVER_RATIO, "sample must stay under the threshold");
  assert.equal(coversMainArea(r, VIEW), false);
});

test("coversMainArea: filling the viewport yields", () => {
  assert.equal(coversMainArea(rect(0, 0, 1600, 900), VIEW), true);
});

test("coversMainArea: both sides of the threshold", () => {
  // 0.62 × viewport → yields
  assert.equal(coversMainArea(rect(0, 0, 1600, 558), VIEW), true);
  // 0.58 × viewport → does not yield
  assert.equal(coversMainArea(rect(0, 0, 1600, 522), VIEW), false);
});

test("coversMainArea: area-only judgement regardless of position", () => {
  assert.equal(coversMainArea(rect(820, 470, 780, 430), VIEW), false);   // 23%
  assert.equal(coversMainArea(rect(500, 300, 1100, 600), VIEW), false);  // 46%, main area still visible
  assert.equal(coversMainArea(rect(400, 150, 1200, 750), VIEW), true);   // 63%, main area covered
});

test("coversMainArea: unlaid-out / hidden panel (zero size) never counts", () => {
  assert.equal(coversMainArea(rect(0, 0, 0, 0), VIEW), false);
  assert.equal(coversMainArea(rect(0, 0, 39, 29), VIEW), false);
  assert.equal(coversMainArea(null, VIEW), false);
});

test("coversMainArea: degenerate viewport (0×0) does not divide by zero", () => {
  const tiny = { width: 0, height: 0 };
  assert.equal(typeof coversMainArea(rect(0, 0, 40, 30), tiny), "boolean");
});

test("coversMainArea: narrow viewport (phone) ratio conversion", () => {
  // 640×480 viewport (inside the small-screen breakpoint): 680×700 float exceeds it → 100% → yields
  assert.equal(coversMainArea(rect(-20, -110, 680, 700), { width: 640, height: 480 }), true);
});

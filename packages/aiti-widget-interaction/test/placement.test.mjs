import test from "node:test";
import assert from "node:assert/strict";
import { clampRect, monitorRect, placeOnMonitor, placeOutside } from "../dist/index.js";

const monitor = { x: 0, y: 0, width: 1920, height: 1080 };
const capture = { x: 200, y: 100, width: 1200, height: 800 };
const card = { width: 560, height: 260 };

test("placeOutside prefers the slot below the avoided rectangle", () => {
  const spot = placeOutside(capture, card, { gap: 16 });
  assert.deepEqual(spot, { x: 520, y: 916 });
});

test("placeOutside falls back above when there is no room below", () => {
  const low = { x: 200, y: 700, width: 1200, height: 360 };
  const spot = placeOutside(low, card, { gap: 20, monitors: [monitor] });
  assert.deepEqual(spot, { x: 520, y: 420 });
});

test("placeOutside respects monitor bounds and the preferred order", () => {
  const left = placeOutside(capture, card, { gap: 10, monitors: [monitor], prefer: ["left"] });
  assert.deepEqual(left, { x: 0, y: 370 }); // 200 - 10 - 560 = -370 -> clamped to 0
  const right = placeOutside({ x: 0, y: 0, width: 600, height: 400 }, { width: 300, height: 200 }, { gap: 12, monitors: [monitor] });
  assert.deepEqual(right, { x: 150, y: 412 });
});

test("monitor helpers map local rects to absolute coordinates", () => {
  const second = { x: 1920, y: 0, width: 2560, height: 1440 };
  assert.deepEqual(monitorRect(second, { x: 100, y: 50, width: 800, height: 600 }), { x: 2020, y: 50, width: 800, height: 600 });
  assert.deepEqual(placeOnMonitor(second, card), { x: 2920, y: 590 });
  assert.deepEqual(placeOnMonitor(second, card, { x: 24, y: 840 }), { x: 1944, y: 840 });
  assert.deepEqual(clampRect({ x: 2400, y: -20, width: 400, height: 100 }, second), { x: 2400, y: 0, width: 400, height: 100 });
  assert.deepEqual(clampRect({ x: 4300, y: 1400, width: 400, height: 200 }, second), { x: 4300, y: 1400, width: 180, height: 40 });
});

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { insertionSlot, moveTargetIndex, slotLineY, moveWithin } = await jiti.import("./reorder-drag.ts");

// Three 30px rows stacked from the content top.
const ROWS = [
  { top: 0, height: 30 },
  { top: 30, height: 30 },
  { top: 60, height: 30 },
];

test("insertionSlot answers by row midpoints", () => {
  assert.equal(insertionSlot(ROWS, -20), 0); // above the list
  assert.equal(insertionSlot(ROWS, 0), 0);
  assert.equal(insertionSlot(ROWS, 14), 0); // still in row 0's upper half
  assert.equal(insertionSlot(ROWS, 16), 1); // past row 0's midpoint
  assert.equal(insertionSlot(ROWS, 40), 1);
  assert.equal(insertionSlot(ROWS, 46), 2);
  assert.equal(insertionSlot(ROWS, 200), 3); // below the list: append slot
  assert.equal(insertionSlot([], 42), 0);
});

test("moveTargetIndex compensates for the removed row and clamps", () => {
  // Dragging down: dropping into slot 3 (past the end) ends at the last index.
  assert.equal(moveTargetIndex(0, 3, 3), 2);
  assert.equal(moveTargetIndex(0, 2, 3), 1);
  // Dragging up: the slot needs no shift.
  assert.equal(moveTargetIndex(2, 0, 3), 0);
  assert.equal(moveTargetIndex(2, 1, 3), 1);
  // No-ops and out-of-range slots stay in range.
  assert.equal(moveTargetIndex(1, 1, 3), 1);
  assert.equal(moveTargetIndex(1, 2, 3), 1);
  assert.equal(moveTargetIndex(0, 0, 3), 0);
  assert.equal(moveTargetIndex(0, 0, 0), 0);
});

test("slotLineY puts the drop line on the row edges", () => {
  assert.equal(slotLineY(ROWS, 0), 0);
  assert.equal(slotLineY(ROWS, 1), 30);
  assert.equal(slotLineY(ROWS, 2), 60);
  assert.equal(slotLineY(ROWS, 3), 90); // past the end: below the last row
  assert.equal(slotLineY([], 0), null);
});

test("moveWithin moves in both directions and never mutates the input", () => {
  const list = ["a", "b", "c", "d", "sep", "e"];
  const snapshot = list.slice();
  assert.deepEqual(moveWithin(list, 0, 3), ["b", "c", "d", "a", "sep", "e"]);
  assert.deepEqual(moveWithin(list, 3, 1), ["a", "d", "b", "c", "sep", "e"]);
  assert.deepEqual(moveWithin(list, 1, 1), list);
  assert.deepEqual(moveWithin(list, -1, 2), list);
  assert.deepEqual(moveWithin(list, 2, 99), list);
  assert.deepEqual(list, snapshot);
});

test("a drop computed from a pointer round-trips through the commit math", () => {
  const list = ["theme", "language", "session-tags", "system", "schedule"];
  // Pointer at the top edge of row 0 while dragging the last entry: slot 0 → index 0.
  const slot = insertionSlot(ROWS, -5);
  const to = moveTargetIndex(list.length - 1, slot, list.length);
  assert.equal(to, 0);
  assert.deepEqual(moveWithin(list, list.length - 1, to), ["schedule", "theme", "language", "session-tags", "system"]);
});

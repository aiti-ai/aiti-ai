/**
 * Drag-to-reorder math for flat vertical lists — pure, DOM-free, SSR-safe.
 *
 * A list panel that supports drag reordering measures its rows once when the
 * drag picks up (top + height in the scroll box's content coordinates) and then
 * only needs three questions answered on every pointer move / drop:
 *   - which insertion slot (0..rows.length) is the pointer over (`insertionSlot`),
 *   - which index does the dragged row land on (`moveTargetIndex`),
 *   - where goes the drop line (`slotLineY`).
 *
 * Keeping the math here means the panel itself holds no geometry arithmetic;
 * `hooks/useListReorder.ts` owns the gesture (pointer capture, long press for
 * touch, auto-scroll) and these functions own the numbers.
 */

/** One measured row: top in the scroll box's CONTENT coordinates (scrollTop added). */
export interface RowBox {
  top: number;
  height: number;
}

/**
 * The insertion slot a pointer at `contentY` points at: the first row whose
 * vertical midpoint the pointer has not passed yet (0..rows.length).
 */
export function insertionSlot(rows: RowBox[], contentY: number): number {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (contentY < row.top + row.height / 2) return i;
  }
  return rows.length;
}

/**
 * The index a row dragged from `from` lands on when dropped into insertion slot
 * `slot`: removing the row first shifts every slot after it down by one. The
 * result is clamped into `0..length-1`, so a drop outside the list is harmless.
 */
export function moveTargetIndex(from: number, slot: number, length: number): number {
  if (length <= 0) return 0;
  const index = slot > from ? slot - 1 : slot;
  return Math.max(0, Math.min(length - 1, index));
}

/**
 * Where the drop line sits, in content coordinates: the top edge of the row the
 * dragged entry would go before, or the bottom edge of the last row when the
 * slot is past the end (null without rows).
 */
export function slotLineY(rows: RowBox[], slot: number): number | null {
  if (rows.length === 0) return null;
  if (slot <= 0) return rows[0].top;
  if (slot >= rows.length) {
    const last = rows[rows.length - 1];
    return last.top + last.height;
  }
  return rows[slot].top;
}

/** The list with `from` moved to index `to`; out-of-range input returns a copy. */
export function moveWithin<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
    return list.slice();
  }
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

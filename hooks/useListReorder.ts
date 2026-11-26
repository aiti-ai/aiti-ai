"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { autoScrollDelta } from "@/lib/session-tree";
import { insertionSlot, moveTargetIndex, slotLineY, type RowBox } from "@/lib/reorder-drag";

/**
 * Drag-to-reorder for a flat, non-virtualized list panel (the top-bar customize
 * panel is the first user). Pointer events, not HTML5 drag and drop: the latter
 * never starts from a touch on iOS and gives no say over scrolling the panel.
 *
 *   - mouse / pen: the row is picked up once the pointer has moved
 *     DRAG_START_PX, so a plain click still reaches the row's own buttons;
 *   - touch: a press held LONG_PRESS_MS picks the row up, and a finger that
 *     moves farther before that is scrolling, not dragging;
 *   - while dragging, moving near the panel's top/bottom edge auto-scrolls it
 *     (requestAnimationFrame, event-driven — no polling);
 *   - Escape, a second pointer, blur or a hidden document puts the row back;
 *   - the caller only hears about a completed drop (onCommit(from, to)); the
 *     view carries what the panel needs to draw (dimmed source + drop line).
 *
 * Rows report themselves through `rowRef(index)`; geometry is measured once at
 * pickup and kept in the panel's content coordinates, so auto-scrolling does not
 * invalidate it and the drop target never depends on mounted DOM mid-drag.
 */

/** A mouse or pen drag starts once the pointer has moved this far. */
export const REORDER_DRAG_START_PX = 4;
/** Touch: a press held this long picks the row up. */
export const REORDER_LONG_PRESS_MS = 350;
/** A finger that moves farther before that is scrolling: the press is let go. */
export const REORDER_LONG_PRESS_SLOP_PX = 8;
/** How near the panel's top or bottom edge a drag scrolls it. */
const AUTO_SCROLL_EDGE_PX = 32;
/** Most pixels auto-scroll moves the panel in one frame. */
const AUTO_SCROLL_MAX_STEP = 14;
/** The click a release produces follows it at once; one later than this is the user's own. */
const CLICK_SUPPRESS_MS = 600;

type DragPhase = "pending" | "dragging" | "cancelled";

interface DragState {
  pointerId: number;
  pointerType: string;
  from: number;
  /** The pressed row: it holds the pointer capture and gets dimmed. */
  element: HTMLElement;
  startX: number;
  startY: number;
  clientY: number;
  phase: DragPhase;
  timer: number | null;
  frame: number | null;
  /** Rows measured at pickup, in the panel's content coordinates. */
  rows: RowBox[];
  slot: number;
}

/** What the panel draws while a row is dragged. */
export interface ListReorderView {
  /** Index of the row being dragged (dim it). */
  from: number;
  /** Insertion slot it would land in (0..count). */
  slot: number;
  /** The drop line's y, in the panel's content coordinates. */
  lineY: number;
}

export interface ListReorderApi {
  view: ListReorderView | null;
  /** On every row: `ref={api.rowRef(index)}`. */
  rowRef(index: number): (element: HTMLElement | null) => void;
  /** On every row: starts a press (`event` from the row's onPointerDown). */
  onPointerDown(index: number, event: ReactPointerEvent<HTMLElement>): void;
  /** On the scroll box: a new press means the next click is the user's. */
  onPointerDownCapture(): void;
  /** On the scroll box: eats the click a drag's release produces. */
  onClickCapture(event: ReactMouseEvent): void;
}

export interface ListReorderOptions {
  /** Number of rows currently rendered (all of them: the list is not virtualized). */
  count: number;
  /** The scrolling panel; rows live inside it in flow order. */
  scrollRef: RefObject<HTMLElement | null>;
  /** A completed drop: move the entry at `from` to `to`. */
  onCommit(from: number, to: number): void;
  /** False while unavailable (panel closed, no rows): a drag under way is cancelled. */
  enabled?: boolean;
}

function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

/** Mouse selection and the native cursor would fight the drag. */
function lockDocument(lock: boolean, cursor: string): void {
  if (typeof document === "undefined") return;
  const style = document.body.style;
  if (lock) {
    style.userSelect = "none";
    style.cursor = cursor;
  } else {
    style.userSelect = "";
    style.cursor = "";
  }
}

export function useListReorder(options: ListReorderOptions): ListReorderApi {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Rows report themselves by index; stale indices drop out when a row unmounts
  // (index shift after a reorder) and are re-registered by the next render.
  const rowElements = useRef(new Map<number, HTMLElement>());
  const rowRefCallbacks = useRef(new Map<number, (element: HTMLElement | null) => void>());
  const dragRef = useRef<DragState | null>(null);
  // Event time (timeStamp) until which a click is the release's own; 0 = none.
  const suppressClickUntilRef = useRef(0);
  // Set only when the dragged row or the slot changes, never per pointermove.
  const [view, setView] = useState<ListReorderView | null>(null);

  const rowRef = useCallback((index: number) => {
    let callback = rowRefCallbacks.current.get(index);
    if (!callback) {
      callback = (element: HTMLElement | null) => {
        if (element) rowElements.current.set(index, element);
        else rowElements.current.delete(index);
      };
      rowRefCallbacks.current.set(index, callback);
    }
    return callback;
  }, []);

  const machine = useMemo(() => {
    const scrollElement = () => optionsRef.current.scrollRef.current;

    const publish = (drag: DragState) => {
      const lineY = slotLineY(drag.rows, drag.slot);
      setView(lineY === null ? null : { from: drag.from, slot: drag.slot, lineY });
    };

    /** All rows' geometry in the panel's content coordinates, or null if one is not rendered. */
    const measure = (): RowBox[] | null => {
      const scroll = scrollElement();
      const count = optionsRef.current.count;
      if (!scroll || count <= 0) return null;
      const box = scroll.getBoundingClientRect();
      const rows: RowBox[] = [];
      for (let i = 0; i < count; i++) {
        const element = rowElements.current.get(i);
        if (!element || !element.isConnected) return null;
        if (element.getClientRects().length === 0) return null; // display: none
        const rect = element.getBoundingClientRect();
        rows.push({ top: rect.top - box.top + scroll.scrollTop, height: rect.height });
      }
      return rows;
    };

    const slotAt = (drag: DragState): number => {
      const scroll = scrollElement();
      if (!scroll) return drag.slot;
      const box = scroll.getBoundingClientRect();
      return insertionSlot(drag.rows, drag.clientY - box.top + scroll.scrollTop);
    };

    const updateSlot = (force = false) => {
      const drag = dragRef.current;
      if (!drag || drag.phase !== "dragging") return;
      const slot = slotAt(drag);
      if (!force && slot === drag.slot) return;
      drag.slot = slot;
      publish(drag);
    };

    function onScroll() {
      updateSlot();
    }

    // Each frame of a drag near an edge scrolls the panel; the rows themselves
    // stay put in content coordinates, only the visible window moves.
    const autoScroll = () => {
      const drag = dragRef.current;
      if (!drag || drag.phase !== "dragging") return;
      drag.frame = null;
      const scroll = scrollElement();
      if (!scroll || !scroll.isConnected) {
        teardown();
        return;
      }
      const box = scroll.getBoundingClientRect();
      const delta = autoScrollDelta(drag.clientY, box.top, box.bottom, AUTO_SCROLL_EDGE_PX, AUTO_SCROLL_MAX_STEP);
      if (delta !== 0) {
        const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
        const next = Math.min(max, Math.max(0, scroll.scrollTop + delta));
        if (next !== scroll.scrollTop) scroll.scrollTop = next;
      }
      updateSlot();
      if (dragRef.current === drag && drag.phase === "dragging") drag.frame = requestAnimationFrame(autoScroll);
    };

    const stopTimers = (drag: DragState) => {
      if (drag.timer !== null) window.clearTimeout(drag.timer);
      if (drag.frame !== null) cancelAnimationFrame(drag.frame);
      drag.timer = null;
      drag.frame = null;
    };

    /** Ends the gesture: timers, frame, capture, listeners and the view. */
    function teardown() {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      stopTimers(drag);
      scrollElement()?.removeEventListener("scroll", onScroll);
      window.removeEventListener("touchmove", onTouchMove);
      try {
        if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
      } catch {
        // Already released with the pointer.
      }
      removeListeners();
      lockDocument(false, "");
      setView(null);
    }

    /** Escape or a second pointer: the row goes back where it was. */
    function cancel(event?: { timeStamp: number }) {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.phase !== "pending") {
        drag.phase = "cancelled";
        suppressClickUntilRef.current = (event?.timeStamp ?? performance.now()) + CLICK_SUPPRESS_MS;
      }
      teardown();
    }

    /** While a touch drag is live the panel must not scroll under the finger. */
    function onTouchMove(event: TouchEvent) {
      const drag = dragRef.current;
      if (!drag || drag.phase !== "dragging") return;
      if (event.cancelable) event.preventDefault();
    }

    const startDragging = (drag: DragState) => {
      const scroll = scrollElement();
      if (!scroll || !scroll.isConnected || !drag.element.isConnected) {
        teardown();
        return;
      }
      const rows = measure();
      if (!rows) {
        teardown();
        return;
      }
      stopTimers(drag);
      drag.rows = rows;
      drag.phase = "dragging";
      drag.slot = drag.from;
      if (drag.pointerType === "touch") window.addEventListener("touchmove", onTouchMove, { passive: false });
      // A release outside the window still reaches the row; touch has an implicit capture.
      try {
        drag.element.setPointerCapture(drag.pointerId);
      } catch {
        // The window listeners still see the pointer.
      }
      scroll.addEventListener("scroll", onScroll, { passive: true });
      lockDocument(true, "grabbing");
      drag.frame = requestAnimationFrame(autoScroll);
      updateSlot(true);
    };

    function onPointerMove(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      // A release outside the window before the drag took the capture: no pointerup came.
      if (drag.pointerType !== "touch" && event.buttons === 0) {
        teardown();
        return;
      }
      drag.clientY = event.clientY;
      if (drag.phase === "pending") {
        const moved = distance(drag.startX, drag.startY, event.clientX, drag.clientY);
        if (drag.pointerType === "touch") {
          if (moved > REORDER_LONG_PRESS_SLOP_PX) teardown(); // a swipe: the panel scrolls as usual
        } else if (moved >= REORDER_DRAG_START_PX) {
          startDragging(drag);
        }
        return;
      }
      if (drag.phase === "dragging") updateSlot();
    }

    function onPointerUp(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.phase === "dragging") {
        drag.clientY = event.clientY;
        const count = optionsRef.current.count;
        const to = moveTargetIndex(drag.from, slotAt(drag), count);
        if (to !== drag.from && to >= 0 && to < count) optionsRef.current.onCommit(drag.from, to);
      }
      // A plain click (still pending) reaches the row's own buttons; after a pickup it must not.
      if (drag.phase !== "pending") suppressClickUntilRef.current = event.timeStamp + CLICK_SUPPRESS_MS;
      teardown();
    }

    function onPointerCancel(event: PointerEvent) {
      if (dragRef.current && event.pointerId === dragRef.current.pointerId) teardown();
    }

    // A second finger (or pointer) is not a drag.
    function onOtherPointerDown(event: PointerEvent) {
      if (dragRef.current && event.pointerId !== dragRef.current.pointerId) cancel(event);
    }

    // Escape puts the row back. In the capture phase, marked handled, so the
    // window-level Escape that stops a running agent leaves it alone.
    function onKeyDown(event: KeyboardEvent) {
      const drag = dragRef.current;
      if (!drag || event.key !== "Escape" || drag.phase === "cancelled") return;
      if (drag.phase === "pending") {
        teardown();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      cancel(event);
    }

    // Android's long-press menu, or a Ctrl+click: a press not picked up yet
    // ends; once picked up the menu is held back.
    function onContextMenu(event: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.phase === "pending") {
        teardown();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    }

    function onBlur() {
      teardown();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") teardown();
    }

    function addListeners() {
      window.addEventListener("pointermove", onPointerMove, true);
      window.addEventListener("pointerup", onPointerUp, true);
      window.addEventListener("pointercancel", onPointerCancel, true);
      window.addEventListener("pointerdown", onOtherPointerDown, true);
      window.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("contextmenu", onContextMenu, true);
      window.addEventListener("blur", onBlur);
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    function removeListeners() {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("pointerdown", onOtherPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }

    return {
      onPointerDown(index: number, event: ReactPointerEvent<HTMLElement>) {
        if (optionsRef.current.enabled === false || dragRef.current) return;
        if (!event.isPrimary || event.button !== 0 || event.ctrlKey || event.metaKey) return;
        // The row's own controls (hide/show buttons) keep their clicks; the drag
        // handle is a button too, but it is exactly where a drag may start.
        const target = event.target;
        if (target instanceof Element && !target.closest("[data-list-reorder-grip]")) {
          if (target.closest("button, a, input, select, textarea")) return;
        }
        const element = event.currentTarget;
        const drag: DragState = {
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          from: index,
          element,
          startX: event.clientX,
          startY: event.clientY,
          clientY: event.clientY,
          phase: "pending",
          timer: null,
          frame: null,
          rows: [],
          slot: index,
        };
        dragRef.current = drag;
        addListeners();
        // Touch scrolls the panel natively: it picks a row up with a long press,
        // which then holds the panel still through the non-passive touchmove above.
        if (event.pointerType === "touch") {
          drag.timer = window.setTimeout(() => {
            const live = dragRef.current;
            if (live === drag && live.phase === "pending") startDragging(live);
          }, REORDER_LONG_PRESS_MS);
        }
      },
      cancel,
      teardown,
    };
  }, []);

  const { enabled = true } = options;
  useEffect(() => {
    if (!enabled) machine.teardown();
  }, [enabled, machine]);

  // Rows appearing/disappearing or the list reordering under a live drag: the
  // measured geometry no longer describes the list, so the gesture ends.
  useEffect(() => {
    const drag = dragRef.current;
    if (!drag || drag.phase === "pending") return;
    if (drag.from >= options.count || drag.rows.length !== options.count) machine.cancel();
  }, [options.count, machine]);

  useEffect(() => () => machine.teardown(), [machine]);

  const onClickCapture = useCallback((event: ReactMouseEvent) => {
    const until = suppressClickUntilRef.current;
    if (until === 0) return;
    suppressClickUntilRef.current = 0;
    if (event.timeStamp > until) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const onPointerDownCapture = useCallback(() => {
    suppressClickUntilRef.current = 0;
  }, []);

  return { view, rowRef, onPointerDown: machine.onPointerDown, onPointerDownCapture, onClickCapture };
}

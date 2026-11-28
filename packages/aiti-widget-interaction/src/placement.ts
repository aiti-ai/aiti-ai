/**
 * Placement helpers for interaction windows and desktop cover windows.
 *
 * The shell accepts absolute screen coordinates, so the host decides where a card or
 * cover goes. `placeOutside` keeps confirmation cards out of a recording rectangle
 * (they would otherwise end up in the captured pixels); `placeOnMonitor` maps a
 * monitor-local offset to absolute coordinates for multi-head setups.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface PlacementOptions {
  /** Gap between the avoided rectangle and the window, in pixels. */
  gap?: number;
  /** Preferred order; defaults to bottom, top, right, left. */
  prefer?: Array<"bottom" | "top" | "right" | "left">;
  /** Optional monitor bounds; a candidate outside them is rejected when alternatives exist. */
  monitors?: Rect[];
  /** Where to look for free space; defaults to the avoided rect. */
  bounds?: Rect;
}

const clamp = (value: number) => Math.max(0, Math.round(value));

/**
 * Place `size` next to `avoid` without overlapping it.
 *
 * Candidates are tried in `prefer` order. A candidate is rejected when it overlaps the
 * avoided rect or leaves the monitor bounds; if every candidate fails, the bottom slot
 * is returned (still outside the rect when there is room below it).
 */
export function placeOutside(avoid: Rect, size: Size, options: PlacementOptions = {}): { x: number; y: number } {
  const gap = Math.max(0, Math.round(options.gap ?? 16));
  const prefer = options.prefer?.length ? options.prefer : (["bottom", "top", "right", "left"] as const);
  const bounds = options.monitors?.length
    ? (options.bounds ?? options.monitors[0])
    : options.bounds ?? null;
  const slots: Record<"bottom" | "top" | "right" | "left", { x: number; y: number }> = {
    bottom: { x: avoid.x + Math.round((avoid.width - size.width) / 2), y: avoid.y + avoid.height + gap },
    top: { x: avoid.x + Math.round((avoid.width - size.width) / 2), y: avoid.y - gap - size.height },
    right: { x: avoid.x + avoid.width + gap, y: avoid.y + Math.round((avoid.height - size.height) / 2) },
    left: { x: avoid.x - gap - size.width, y: avoid.y + Math.round((avoid.height - size.height) / 2) },
  };
  const fits = (slot: { x: number; y: number }) => {
    if (slot.x < 0 || slot.y < 0) return false;
    if (!bounds) return true;
    return (
      slot.x + size.width <= bounds.x + bounds.width &&
      slot.y + size.height <= bounds.y + bounds.height &&
      slot.x >= bounds.x &&
      slot.y >= bounds.y
    );
  };
  for (const key of prefer) {
    const slot = slots[key];
    if (fits(slot)) return { x: clamp(slot.x), y: clamp(slot.y) };
  }
  // Nothing fits cleanly: fall back to the first preference, clamped into monitor bounds.
  const fallback = slots[prefer[0]];
  const x = bounds ? Math.min(Math.max(fallback.x, bounds.x), bounds.x + bounds.width - size.width) : fallback.x;
  const y = bounds ? Math.min(Math.max(fallback.y, bounds.y), bounds.y + bounds.height - size.height) : fallback.y;
  return { x: clamp(x), y: clamp(y) };
}

/** Map monitor-local offsets to absolute screen coordinates (the shell's `--display` math). */
export function placeOnMonitor(monitor: Rect, size: Size, offset: Partial<{ x: number; y: number }> = {}): { x: number; y: number } {
  return {
    x: monitor.x + Math.round(offset.x ?? (monitor.width - size.width) / 2),
    y: monitor.y + Math.round(offset.y ?? (monitor.height - size.height) / 2),
  };
}

/** Convert a monitor-local rect (e.g. video capture area) to absolute screen coordinates. */
export function monitorRect(monitor: Rect, rect: Rect): Rect {
  return { x: monitor.x + rect.x, y: monitor.y + rect.y, width: rect.width, height: rect.height };
}

/** Clamp a rect inside monitor bounds (used by the cover window). */
export function clampRect(rect: Rect, monitor: Rect): Rect {
  const x = Math.min(Math.max(rect.x, monitor.x), monitor.x + monitor.width - 1);
  const y = Math.min(Math.max(rect.y, monitor.y), monitor.y + monitor.height - 1);
  return {
    x,
    y,
    width: Math.max(1, Math.min(rect.width, monitor.x + monitor.width - x)),
    height: Math.max(1, Math.min(rect.height, monitor.y + monitor.height - y)),
  };
}

/**
 * New-session welcome page "top/bottom widget" layout and preferences — pure logic, SSR-safe.
 *
 * The welcome page's two widget areas (top = above the message area, bottom = below the composer)
 * receive widgets registered by extensions or host built-ins via the `newSessionWidgets` slot
 * (meta declares allowed areas and grid sizes; see lib/ext/types.ts `NewSessionWidgetMeta`).
 * This module owns:
 *   - localStorage preference read/write (single-key JSON: a user order each for top/bottom + a hidden set),
 *   - `resolveWidgetLayout()` — merges preferences with currently present items into the final
 *     render order of both areas.
 *
 * Design notes (mirroring the custom-order pattern of lib/topbar-order.ts):
 *   - Preferences are per-area lists (a user order each for top/bottom); panel actions (move within
 *     an area / move across areas / show-hide) are simple O(list) splices; unknown ids (extension
 *     uninstalled etc.) are dropped at resolution time, never written back to grow the pref.
 *   - New items not yet in preferences are appended to their defaultArea in ascending meta.priority
 *     order (registration order by default).
 *   - If an entry in a user order is no longer allowed in that area (meta tightened), it is skipped
 *     at resolution time — it returns via the "not in preferences" path to the defaultArea it is
 *     currently allowed in, rather than disappearing.
 */

export const NSW_PREF_KEY = "pi-new-session-widgets";
export const NSW_PREF_EVENT = "pi-new-session-widgets-changed";

export type NswArea = "top" | "bottom";

/** User preferences (single-key JSON). Empty list/missing = no customization for that dimension. */
export interface NewSessionWidgetPref {
  top: string[];
  bottom: string[];
  hidden: string[];
}

export const EMPTY_NSW_PREF: NewSessionWidgetPref = Object.freeze({ top: [], bottom: [], hidden: [] });

/** Input item for layout resolution (the host normalizes slot items + built-in entries into this shape). */
export interface NewSessionWidgetItem {
  /** Composite id: extension entries "extId:itemId"; built-ins "builtin:recent" etc. */
  id: string;
  /** Origin extension id (absent for built-ins; used for the panel's "from extension" label). */
  extId?: string;
  title: string;
  /** Allowed area set (non-empty after normalization). */
  areas: NswArea[];
  defaultArea: NswArea;
  /** Grid column width 1..8 (4 columns on mobile / 8 on desktop). */
  w: number;
  /** Grid row height 1..3. */
  h: number;
  /** Default-order weight (ascending, stable). */
  priority: number;
}

/** Resolution result: render order for both areas + the effective hidden set + whether nothing is customized. */
export interface NewSessionWidgetLayout {
  top: string[];
  bottom: string[];
  hidden: string[];
  isDefault: boolean;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Normalize each meta dimension (shared by host and tests: out-of-range/illegal values fall back to defaults, empty areas → both). */
export function normalizeWidgetItem(
  raw: Partial<NewSessionWidgetItem> & { id: string; title?: string },
): NewSessionWidgetItem {
  const areas: NswArea[] = [];
  for (const a of raw.areas ?? []) {
    if ((a === "top" || a === "bottom") && !areas.includes(a)) areas.push(a);
  }
  if (areas.length === 0) areas.push("top", "bottom");
  const defaultArea: NswArea =
    raw.defaultArea === "top" || raw.defaultArea === "bottom"
      ? raw.defaultArea
      : areas[0];
  return {
    id: raw.id,
    extId: raw.extId,
    title: raw.title ?? raw.id,
    areas,
    defaultArea: areas.includes(defaultArea) ? defaultArea : areas[0],
    w: clampInt(raw.w ?? 4, 1, 8, 4),
    h: clampInt(raw.h ?? 1, 1, 3, 1),
    priority: typeof raw.priority === "number" && Number.isFinite(raw.priority) ? raw.priority : 0,
  };
}

export function readNewSessionWidgetPref(): NewSessionWidgetPref | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(NSW_PREF_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const pickList = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
    return {
      top: pickList(obj.top),
      bottom: pickList(obj.bottom),
      hidden: pickList(obj.hidden),
    };
  } catch {
    return null;
  }
}

export function writeNewSessionWidgetPref(pref: NewSessionWidgetPref): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NSW_PREF_KEY, JSON.stringify(pref));
  } catch {
    // storage full / disabled — non-fatal
  }
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(NSW_PREF_EVENT));
    } catch { /* non-browser */ }
  }
}

/** Reset to defaults = remove the key + event (once subscribed, zones/panels revert to the default layout immediately). */
export function resetNewSessionWidgetPref(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(NSW_PREF_KEY);
  } catch { /* non-fatal */ }
  try {
    window.dispatchEvent(new CustomEvent(NSW_PREF_EVENT));
  } catch { /* non-browser */ }
}

/** Subscribe to preference changes (this page's write events + storage events echoed from other tabs). Returns an unsubscribe function. */
export function subscribeNewSessionWidgetPref(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === NSW_PREF_KEY || e.key === null) cb();
  };
  window.addEventListener(NSW_PREF_EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(NSW_PREF_EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Merge preferences with present items into the final order of both areas:
 *   1. Each area first takes its user order (filtered: not present / not allowed in the area / hidden);
 *   2. Items in neither user order and not hidden are appended to their defaultArea in ascending,
 *      stable priority order;
 *   3. hidden = preferences ∩ present (stale ids dropped).
 * isDefault = all three preference lists empty (equivalent to the default layout).
 */
export function resolveWidgetLayout(
  items: NewSessionWidgetItem[],
  pref: NewSessionWidgetPref | null,
): NewSessionWidgetLayout {
  const byId = new Map(items.map((it) => [it.id, it]));
  const hiddenPref = new Set((pref?.hidden ?? []).filter((id) => byId.has(id)));
  const placed = new Set<string>();
  const out: NewSessionWidgetLayout = { top: [], bottom: [], hidden: [...hiddenPref], isDefault: false };

  const userList = (area: NswArea): string[] => {
    const list: string[] = [];
    for (const id of pref?.[area] ?? []) {
      if (placed.has(id) || hiddenPref.has(id)) continue;
      const item = byId.get(id);
      if (!item || !item.areas.includes(area)) continue;
      placed.add(id);
      list.push(id);
    }
    return list;
  };

  out.top = userList("top");
  out.bottom = userList("bottom");

  // Default append: present items not in preferences → defaultArea (ascending stable priority; registration order relies on Array.sort stability)
  const rest = items
    .filter((it) => !placed.has(it.id) && !hiddenPref.has(it.id))
    .sort((a, b) => a.priority - b.priority);
  for (const area of ["top", "bottom"] as const) {
    for (const it of rest) {
      if (it.defaultArea !== area) continue;
      out[area].push(it.id);
      placed.add(it.id);
    }
  }

  out.isDefault = (pref?.top.length ?? 0) === 0 && (pref?.bottom.length ?? 0) === 0 && (pref?.hidden.length ?? 0) === 0;
  return out;
}

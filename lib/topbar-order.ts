/**
 * Topbar button ordering / hiding / separator persistence — pure logic, SSR-safe.
 *
 * AppShell renders its topbar tool buttons as an ordered entry list. Users can
 * reorder buttons, hide ones they don't use, and insert separator tokens between
 * buttons to group them visually. This module owns:
 *   - the localStorage persistence keys/readers/writers,
 *   - `resolveTopbarLayout()` — merging the stored order + hidden set with the
 *     currently available items into the final panel list and render list.
 *
 * Design notes:
 *   - Order/hidden/separators are orthogonal. A hidden button keeps its position
 *     in the stored order (restoring it puts it back in place). Separators are
 *     layout tokens (`"sep"`) that never consume a button id.
 *   - Separator normalization is DERIVED, never persisted: leading/trailing
 *     separators are dropped and consecutive ones collapse, so a button hidden
 *     between two separators never leaves a run of dividers on screen. The raw
 *     stored order still keeps both separators, so the original layout returns
 *     when the button comes back.
 */

export const TOPBAR_ORDER_KEY = "pi-topbar-order";
export const TOPBAR_HIDDEN_KEY = "pi-topbar-hidden";

/** Separator layout token — may appear multiple times in an order list. */
export const SEPARATOR = "sep";

/** Built-in topbar button ids. */
export type BuiltinTopbarId =
  | "theme"
  | "language"
  | "services"
  | "history"
  | "export"
  | "title"
  | "branch"
  | "system";

/** Any button id: built-in, or an extension item id (e.g. "aiti-devtools:aiti-inspect"). */
export type TopbarItemId = BuiltinTopbarId | (string & {});

/** One entry of an order list: a button id or a separator token. */
export type TopbarOrderItem = TopbarItemId | typeof SEPARATOR;

/**
 * Default order for the built-in buttons. Extension items are inserted by
 * AppShell around these (toolbar-slot items after "services", sessionTopbar
 * items after "system") when building the effective default order.
 */
export const DEFAULT_TOPBAR_ORDER: TopbarOrderItem[] = [
  "theme",
  "language",
  "services",
  // toolbar-slot extension items go here (registration order)
  "history",
  "export",
  "title",
  "branch",
  "system",
  // sessionTopbar-slot extension items go here
];

/** Result of resolving a stored layout against the current available items. */
export interface TopbarLayout {
  /**
   * Panel list: buttons (hidden ones kept in place) + separators, normalized.
   * This is what the customize panel displays and what panel edits are based on.
   */
  order: TopbarOrderItem[];
  /**
   * Render list: `order` minus hidden buttons, re-normalized (so a hidden
   * button anchoring a separator can collapse consecutive separators).
   * This is what the toolbar row and the "⋯" overflow menu render.
   */
  visible: TopbarOrderItem[];
  /** Effective hidden set (stale ids already dropped). */
  hidden: TopbarItemId[];
  /** True when the layout equals the default (no separators, nothing hidden). */
  isDefault: boolean;
}

function readList(key: string): TopbarOrderItem[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (x): x is TopbarOrderItem => typeof x === "string" && x.length > 0,
    );
  } catch {
    return null;
  }
}

/** Read the stored user order (null when absent/corrupt). May contain SEPARATOR tokens. */
export function readTopbarOrder(): TopbarOrderItem[] | null {
  return readList(TOPBAR_ORDER_KEY);
}

/** Read the stored hidden set (null when absent/corrupt). */
export function readTopbarHidden(): TopbarItemId[] | null {
  const list = readList(TOPBAR_HIDDEN_KEY);
  if (!list) return null;
  return list.filter((x): x is TopbarItemId => x !== SEPARATOR);
}

export function writeTopbarOrder(order: TopbarOrderItem[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOPBAR_ORDER_KEY, JSON.stringify(order));
  } catch {
    // storage full / disabled — non-fatal
  }
}

export function writeTopbarHidden(hidden: TopbarItemId[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOPBAR_HIDDEN_KEY, JSON.stringify(hidden));
  } catch {
    // non-fatal
  }
}

/**
 * Derived separator normalization: drop leading/trailing separators and
 * collapse consecutive ones. Never persisted — applied to the return value.
 */
export function normalizeTopbarOrder(order: TopbarOrderItem[]): TopbarOrderItem[] {
  const out: TopbarOrderItem[] = [];
  for (const item of order) {
    if (item === SEPARATOR) {
      if (out.length === 0) continue; // leading separator
      if (out[out.length - 1] === SEPARATOR) continue; // consecutive
      out.push(item);
    } else {
      out.push(item);
    }
  }
  while (out.length > 0 && out[out.length - 1] === SEPARATOR) out.pop(); // trailing
  return out;
}

/**
 * Merge the stored layout with the currently available buttons:
 *   1. items present in the user order come first (in that order); separators
 *      are kept as-is; stale ids (extension unloaded etc.) are dropped;
 *   2. remaining available items are appended in `defaultOrder` order;
 *   3. `order` (panel list) is normalized once with hidden buttons still in
 *      place (they anchor separators), then `visible` is derived by stripping
 *      hidden buttons and normalizing once more.
 */
export function resolveTopbarLayout(
  custom: TopbarOrderItem[] | null,
  hidden: TopbarItemId[] | null,
  availableIds: TopbarItemId[],
  defaultOrder: TopbarOrderItem[],
): TopbarLayout {
  const available = new Set(availableIds);
  const hiddenSet = new Set<TopbarItemId>();
  for (const id of hidden ?? []) {
    if (available.has(id)) hiddenSet.add(id);
  }

  const merged: TopbarOrderItem[] = [];
  const seen = new Set<string>();

  const pushButton = (id: TopbarItemId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    merged.push(id);
  };

  // 1. user order first (separators kept, stale/hidden buttons still placed)
  for (const item of custom ?? []) {
    if (item === SEPARATOR) {
      merged.push(item);
    } else if (available.has(item)) {
      pushButton(item);
    }
  }

  // 2. default-order tail (hidden buttons still enter the panel list so the
  //    customize panel can grey them out and restore them; `visible` strips)
  for (const item of defaultOrder) {
    if (item === SEPARATOR) continue;
    if (!available.has(item)) continue;
    pushButton(item);
  }

  // 3a. panel list: normalize with hidden buttons in place
  const order = normalizeTopbarOrder(merged);

  // 3b. render list: strip hidden, normalize again (hidden button may have
  //     anchored separators that now become leading/trailing/consecutive)
  const visible = normalizeTopbarOrder(
    order.filter((item) => item === SEPARATOR || !hiddenSet.has(item as TopbarItemId)),
  );

  // isDefault: no separators, nothing hidden, and the visible buttons exactly
  // match the default order (restricted to currently available ids).
  const defaultVisible = defaultOrder.filter(
    (item): item is TopbarItemId => item !== SEPARATOR && available.has(item),
  );
  const visibleButtons = visible.filter(
    (item): item is TopbarItemId => item !== SEPARATOR,
  );
  const isDefault =
    hiddenSet.size === 0 &&
    !visible.includes(SEPARATOR) &&
    visibleButtons.length === defaultVisible.length &&
    visibleButtons.every((id, i) => id === defaultVisible[i]);

  return {
    order,
    visible,
    hidden: [...hiddenSet],
    isDefault,
  };
}

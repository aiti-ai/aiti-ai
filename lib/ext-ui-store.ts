/**
 * Client-side extension UI store — a tiny registry on window.__piWebExtUI.
 *
 * The extension client bundles call ctx.registerItems(slot, items) during
 * module registration; core components render them via <ExtSlot name=.../>.
 * A version counter lets React hooks re-render when items are registered.
 *
 * Adopted from the DSH adapter work (docs/dsh-adapter-assessment.md §5.2):
 *  - Registrations are isolated per extension (stamped with extId) so reload/HMR
 *    can unwind one extension at a time (disposer semantics) instead of a full
 *    reset + re-import.
 *  - registerExtUiItems returns a disposer: effect semantics — calling it removes
 *    exactly that registration.
 */
"use client";

import type { ReactNode } from "react";
import type { ExtSlotName, ExtUiItem, ExtUiItemIcon, NewSessionPrepareResult } from "@/lib/ext/types";

export interface ExtRenderProps {
  /** Current selected session (null for a fresh new-session composer). */
  currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null;
  [key: string]: unknown;
}

export interface ExtUiItemRegistered {
  id: string;
  /** The extension id this item was registered by (for precise unwind/HMR removal). */
  extId?: string;
  /** Boolean feature id gating this item (declared by the extension in ctx.registerItems).
   *  While the feature is off the host skips rendering the item (it stays in the
   *  registry; manually enabling it via the extension manager can still trigger an
   *  on-demand mount); extensions don't need their own gating code in components. */
  feature?: string;
  /** [lazy-loading v2] Static item marker: a manifest ui[slot][] declaration rendered
   *  by the host as a zero-bundle entry before the client materializes. Once a
   *  registered item with the same (extId,id) shows up, the static item retires. */
  static?: boolean;
  /** [lazy-loading v2] Static item click-through load in progress (ExtToolbarIconButton
   *  shows a loading state and guards against double clicks). */
  pending?: boolean;
  /** Component receiving ExtRenderProps (currentSession etc.).
   *  Optional: the toolbar slot supports declarative items — without render the host
   *  renders a standard button from meta.icon + meta.onClick (other slots still require
   *  render; consumers filter by typeof render === "function"). */
  render?: (props: ExtRenderProps) => ReactNode;
  meta?: {
    label?: string;
    title?: string;
    badge?: boolean;
    noMenuLabel?: boolean;
    /** Declarative icon (toolbar): rendered by the host (the ⋯ menu icon slot and the
     *  standard toolbar button when render is absent); once provided, the extension's
     *  render menu branch is no longer used. */
    icon?: ExtUiItemIcon;
    /** Declarative item click callback (toolbar, pairs with meta.icon; only client
     *  registrations can carry it — server ui: intent declarations are not serializable):
     *  invoked for both ⋯ menu row clicks and standard toolbar button clicks
     *  (receives the click event). */
    onClick?: (e?: unknown) => void;
    /** fileViewer takeover predicate (the file-editor extension): called by the core
     *  FileViewer trampoline to decide whether a file is handed to this extension for
     *  rendering (default = no takeover → core viewer fallback, zero regression). */
    match?: (filePath: string, opts: { cwd?: string; kind?: "file" | "folder" }) => boolean;
    /** sessionRequestCard routing (agent-capability UI moved out of core): the set of
     *  request kinds this item claims (`interaction:plan_approval` / `permission` /
     *  `provider_headers` / backend-specific…). The host filters by
     *  request.kind ∈ kinds && (backend undeclared | "*" | == the session's backendSource);
     *  the highest-priority match takes over; misses fall back to the host's minimal card. */
    kinds?: string[];
    backend?: string | "*";
    priority?: number;
    /** newSessionPreparers registration surface (branch/worktree pickers etc.): a
     *  pre-creation pipeline callback — ensureNewSession awaits meta.prepare({cwd})
     *  in order before the POST: {cwd} rewrites the target directory / {abort} cancels
     *  creation (via the existing throw→notice channel; see
     *  docs/pi-web-new-session-branch-worktree-plan.md §3). */
    prepare?: (ctx: { cwd: string }) => Promise<NewSessionPrepareResult>;
  };
}

/** Whether render exists (type-narrowing predicate after render became optional; consumers use it to filter declarative items). */
export function hasExtRender<T extends ExtUiItemRegistered>(it: T): it is T & { render: (props: ExtRenderProps) => ReactNode } {
  return typeof it.render === "function";
}

/** Extension-level metadata (manifest: name/icon) used by host UI to label the extension. */
export interface ExtMeta {
  name: string;
  icon?: string | null;
  /** Capability takeover declaration (manifest ui.provides, e.g. ["session-delete"]) —
   *  the host hides the corresponding built-in UI accordingly. */
  provides?: string[];
}

export interface ExtUiStore {
  items: Partial<Record<ExtSlotName, ExtUiItemRegistered[]>>;
  /** [lazy-loading v2] Manifest static items (zero-bundle entries renderable before
   *  materialization; registered items override them by (extId,id)). Stored separately
   *  from items; getExtUiItems merges both. */
  staticItems: Partial<Record<ExtSlotName, ExtUiItemRegistered[]>>;
  /** extId → manifest metadata (name/icon) */
  metas: Record<string, ExtMeta>;
  version: number;
  listeners: Set<() => void>;
}

declare global {
  var __piWebExtUI: ExtUiStore | undefined;
}

function getStore(): ExtUiStore {
  // This module lives on globalThis and survives HMR; after a shape upgrade
  // (e.g. v2 adding staticItems) a partial store left by the old version passes a
  // plain truthy check → getExtUiItems' Object.keys blows up with "Cannot convert
  // undefined or null to object" (hard SSR crash). Fill in each field here.
  const s = globalThis.__piWebExtUI ?? (globalThis.__piWebExtUI = {} as ExtUiStore);
  s.items ??= {};
  s.staticItems ??= {};
  s.metas ??= {};
  s.version ??= 0;
  s.listeners ??= new Set();
  return s;
}

function bump(): void {
  const store = getStore();
  store.version += 1;
  for (const l of store.listeners) l();
}

/** Overwrite-write extension metadata from the manifest (called after loadExtensions fetches the manifest). */
export function registerExtMetas(metas: Record<string, ExtMeta>): void {
  const store = getStore();
  store.metas = metas;
  bump();
}

// ── Stable extension order (manifest listing order): client bundle registration
//    completion order is nondeterministic (the startup batch and per-slot on-demand
//    materialization pipelines interleave; whoever reaches register first enters the
//    store first), so the items array order in the store cannot be the display order —
//    slots rendered in array order (top bar/status bar etc.) would reshuffle on every
//    load. The host writes the listing order (≈ install/registration order, stable)
//    after fetching the manifest; getExtUiItems stable-sorts by it before returning.
//    Extensions outside the manifest (dynamically registered) keep registration order
//    at the end. ──
let extOrder: Record<string, number> = {};

/** Writes the stable extension order (manifest extensions array order). Bumps on change (re-sorts registered items). */
export function setExtOrder(ids: string[]): void {
  const next: Record<string, number> = {};
  for (let i = 0; i < ids.length; i++) next[ids[i]] = i;
  const prevKeys = Object.keys(extOrder);
  const changed =
    prevKeys.length !== Object.keys(next).length ||
    prevKeys.some((k) => extOrder[k] !== next[k]);
  extOrder = next;
  if (changed) bump(); // advance version: invalidates the getExtUiItems cache → re-sort by the new order
}

/** Display sort key for an extension: manifest listing order first; unknown/missing extId sorts last (keeps registration order). */
function extSortKey(extId: string | undefined): number {
  if (extId === undefined) return Number.MAX_SAFE_INTEGER - 1;
  return extOrder[extId] ?? Number.MAX_SAFE_INTEGER;
}

export function getExtMetas(): Record<string, ExtMeta> {
  return getStore().metas;
}

/**
 * Registers a set of slot items (attributed to the given extId). Returns a disposer:
 * calling it removes exactly this registration from the store (DSH effect semantics —
 * registration and unwind are paired; reload unwinds extension by extension).
 */
export function registerExtUiItems(
  slot: ExtSlotName,
  items: ExtUiItemRegistered[],
  extId?: string,
): () => void {
  const store = getStore();
  const stamped = items.map((it) => ({ ...it, ...(extId ? { extId } : {}) }));
  // Idempotent registration: same (extId, id) replaces the old item (in place)
  // instead of appending. Fast Refresh rebuilds the ExtSlots/ext-client-loader
  // modules (loadStarted/modules reset to zero) but this store lives on globalThis
  // and survives HMR — a provider remount materializes every extension again, and
  // pure append would accumulate duplicate keys (React "two children with the same
  // key"; requiring each extension to hand-roll idempotency is unreasonable).
  // Replace semantics makes repeated registrations converge naturally and picks up
  // fresh render closures after a refresh; when content is identical, skip bump
  // to avoid a pointless re-render.
  const existing = store.items[slot] ?? [];
  const keyed = new Map(existing.map((it) => [`${it.extId ?? ""}\u0000${it.id}`, it]));
  for (const it of stamped) keyed.set(`${it.extId ?? ""}\u0000${it.id}`, it);
  const next = [...keyed.values()];
  const unchanged =
    next.length === existing.length &&
    next.every(
      (it, i) =>
        it.id === existing[i].id &&
        it.extId === existing[i].extId &&
        it.render === existing[i].render &&
        it.meta === existing[i].meta,
    );
  if (!unchanged) {
    store.items[slot] = next;
    bump();
  }
  return () => {
    const cur = store.items[slot] ?? [];
    const stampedIds = new Set(stamped.map((s) => s.id));
    store.items[slot] = cur.filter((it) => !(stampedIds.has(it.id) && it.extId === extId));
    bump();
  };
}

/** Removes specific items an extension registered in a slot (disposer semantics, precise unwind). */
export function disposeExtUiItems(slot: ExtSlotName, extId: string, ids: string[]): void {
  const store = getStore();
  const idSet = new Set(ids);
  const cur = store.items[slot] ?? [];
  const next = cur.filter((it) => !(it.extId === extId && idSet.has(it.id)));
  if (next.length !== cur.length) {
    store.items[slot] = next;
    bump();
  }
}

/** Removes all items an extension registered across every slot (HMR unwind / extension invalidation). */
export function removeExtUiItems(extId: string): void {
  const store = getStore();
  let changed = false;
  for (const slot of Object.keys(store.items) as ExtSlotName[]) {
    const cur = store.items[slot] ?? [];
    const next = cur.filter((it) => it.extId !== extId);
    if (next.length !== cur.length) {
      store.items[slot] = next;
      changed = true;
    }
  }
  if (changed) bump();
}

/** Clear all items for every slot (used when re-importing bundles on reload). */
export function resetExtUiItems(): void {
  const store = getStore();
  store.items = {};
  bump();
}

// ── [lazy-loading v2] Manifest static items (zero-bundle entries) ──
// Data lives in the manifest (id/label/title/icon/feature, serializable), behavior in
// the client (onClick supplied by the registered item after materialization). The host
// renders static items before the client materializes; a click → forwarder materializes
// → the registered item replaces the static one by (extId,id) (same id, so top-bar
// ordering/⋯ menu/button appearance switch seamlessly).
// See §4.3 of the lazy-loading plan doc.

/** Static item click forwarder (injected once by ExtSlots loadExtensions; this store
 *  does not depend back on the loader). slot lets the forwarder look up which slot the
 *  registered item lives in; ev is the original click event (forwarded to the registered
 *  item's onClick after materialization). */
let staticClickHandler: ((extId: string, itemId: string, slot: ExtSlotName, ev?: unknown) => Promise<void>) | null = null;

export function setStaticClickHandler(fn: ((extId: string, itemId: string, slot: ExtSlotName, ev?: unknown) => Promise<void>) | null): void {
  staticClickHandler = fn;
}

/** Static item pending state (key `extId\0id`) — set while the forwarder materializes; the button shows a loading state and rejects double clicks. */
const staticPending = new Set<string>();

/** Forwarder-only: flips a static item's pending state and bumps (render layer reflects immediately). */
export function setStaticItemPending(extId: string, itemId: string, pending: boolean): void {
  const key = `${extId}\u0000${itemId}`;
  if (pending === staticPending.has(key)) return;
  if (pending) staticPending.add(key);
  else staticPending.delete(key);
  bump();
}

/**
 * Registers an extension's static items in a slot (called after the manifest ui[slot][]
 * is fetched; overwrite-write — an extension's old declarations in the same slot are
 * replaced as a group, always mirroring the manifest). Item ids are the extension-local
 * raw ids; merged output exposes the composite id "extId:rawId" (same rule as registered
 * item ids, invisible to consumers).
 */
export function registerStaticItems(
  slot: ExtSlotName,
  items: (ExtUiItem & { meta?: ExtUiItemRegistered["meta"] })[],
  extId: string,
): void {
  const store = getStore();
  const built: ExtUiItemRegistered[] = items.map((decl) => {
    const compositeId = `${extId}:${decl.id}`;
    return {
      ...decl,
      id: compositeId,
      extId,
      static: true,
      meta: {
        label: decl.meta?.label ?? decl.label,
        title: decl.meta?.title ?? decl.title,
        badge: decl.meta?.badge ?? decl.badge,
        noMenuLabel: decl.meta?.noMenuLabel,
        icon: decl.meta?.icon ?? decl.icon,
        onClick: (e?: unknown) => {
          void Promise.resolve(staticClickHandler?.(extId, compositeId, slot, e)).catch(() => {});
        },
      },
    };
  });
  const prev = (store.staticItems[slot] ?? []).filter((it) => it.extId !== extId);
  const next = [...prev, ...built];
  const cur = store.staticItems[slot] ?? [];
  store.staticItems[slot] = next;
  if (next.length !== cur.length || next.some((it, i) => it !== cur[i])) bump();
}

/** Prunes static items whose extension is not in activeIds (called after a manifest refetch; same trigger points as pruneDeclaredSlots). */
export function pruneStaticItems(activeIds: Iterable<string>): void {
  const store = getStore();
  const active = new Set(activeIds);
  let changed = false;
  for (const slot of Object.keys(store.staticItems) as ExtSlotName[]) {
    const cur = store.staticItems[slot] ?? [];
    const next = cur.filter((it) => it.extId !== undefined && active.has(it.extId));
    if (next.length !== cur.length) {
      store.staticItems[slot] = next;
      changed = true;
    }
  }
  if (changed) bump();
}

/** Removes an extension's static items across all slots (called when an extension flips
 *  from lazy back to immediate — its static entries retire with that; leaving them would
 *  let ghost buttons/placeholders linger even after registered items arrive). */
export function removeStaticItems(extId: string): void {
  const store = getStore();
  let changed = false;
  for (const slot of Object.keys(store.staticItems) as ExtSlotName[]) {
    const cur = store.staticItems[slot] ?? [];
    const next = cur.filter((it) => it.extId !== extId);
    if (next.length !== cur.length) {
      store.staticItems[slot] = next;
      changed = true;
    }
  }
  if (changed) bump();
}

const NO_UI_ITEMS: ExtUiItemRegistered[] = [];

// Reads filter by feature gating (cached to keep references stable — required for
// snapshot stability, see the NO_UI_ITEMS note). The cache key is store instance +
// version: a feature change goes through patchExtFeature → bump() advances the
// version; when tests/HMR swap globalThis for a fresh store, the differing instance
// invalidates it naturally.
let gatedCache: { store: ExtUiStore; version: number; items: Partial<Record<ExtSlotName, ExtUiItemRegistered[]>> } | null = null;

// [lazy-loading v2] Warn on static/registered item id mismatch (double-button risk,
// §7-R1) — at most one warning per (slot,extId,id).
const staticIdMismatchWarned = new Set<string>();

export function getExtUiItems(slot: ExtSlotName): ExtUiItemRegistered[] {
  const store = getStore();
  if (!gatedCache || gatedCache.store !== store || gatedCache.version !== store.version) {
    const next: Partial<Record<ExtSlotName, ExtUiItemRegistered[]>> = {};
    const slotKeys = new Set([...Object.keys(store.items), ...Object.keys(store.staticItems)] as ExtSlotName[]);
    for (const s of slotKeys) {
      const registered = store.items[s] ?? [];
      const statics = store.staticItems[s] ?? [];
      // [lazy-loading v2] Merge: registered items override static items by (extId,id) —
      // once a registered item with render/onClick arrives, the static item retires
      // naturally (same id before/after materialization; top-bar ordering/⋯ menu/button
      // appearance switch seamlessly).
      let merged = registered;
      if (statics.length > 0) {
        const regKeys = new Set(registered.map((it) => `${it.extId ?? ""}\u0000${it.id}`));
        const tail = statics.filter((st) => !regKeys.has(`${st.extId ?? ""}\u0000${st.id}`));
        if (tail.length > 0) {
          merged = [...registered, ...tail];
          // dev assertion: the same extension has registered items in this slot but none matches the static id → double-button risk
          for (const st of tail) {
            const hasOther = registered.some((it) => it.extId === st.extId);
            const wkey = `${s}\u0000${st.extId ?? ""}\u0000${st.id}`;
            if (hasOther && !staticIdMismatchWarned.has(wkey)) {
              staticIdMismatchWarned.add(wkey);
              console.warn(`[ext] static/registered item id mismatch in slot "${s}" for ${st.extId}: static "${st.id}" has no matching registered item — check ui declaration vs ctx.registerItems id (double-button risk)`);
            }
          }
        }
        // pending-state injection (a new object identity is produced only on flips; the render layer re-reads the snapshot via bump)
        merged = merged.map((it) => (it.static && it.extId !== undefined && staticPending.has(`${it.extId}\u0000${it.id}`) ? { ...it, pending: true } : it));
      }
      // Filter by feature gating first, then stable-sort by manifest listing order
      // (registration completion order is random, see the setExtOrder note). The
      // original index as tiebreaker keeps registration order within an extension
      // and avoids relying on the engine's sort stability.
      const filtered = merged.filter((it) => !(it.feature && it.extId && !getExtFeature(it.extId, it.feature)));
      next[s] = filtered
        .map((it, idx) => ({ it, idx }))
        .sort((a, b) => (extSortKey(a.it.extId) - extSortKey(b.it.extId)) || (a.idx - b.idx))
        .map((x) => x.it);
    }
    gatedCache = { store, version: store.version, items: next };
  }
  return gatedCache.items[slot] ?? NO_UI_ITEMS;
}

export function subscribeExtUi(cb: () => void): () => void {
  const store = getStore();
  store.listeners.add(cb);
  return () => store.listeners.delete(cb);
}

export function extUiVersion(): number {
  return getStore().version;
}

// ── Extension feature state (managed by the extension manager): the host fetches it
//    once to fill everything (manifest); extensions only read + subscribe to changes —
//    no independent requests/polling. A change: extension-manager set-feature →
//    broadcasts pi-web:ext-features-changed → the host listens and updates in place via
//    patchExtFeature → subscribeExtFeatures subscribers are notified. ──
let featureState: Record<string, Record<string, boolean | string>> = {};
const featureListeners = new Set<() => void>();

/** Bulk-writes one extension's feature state (called by the host on manifest fetch; empty/undeclared removes the entry). */
export function setExtFeatures(extId: string, features: Record<string, boolean | string> | null): void {
  const next = { ...featureState };
  if (features && Object.keys(features).length > 0) next[extId] = features;
  else delete next[extId];
  featureState = next;
  bump(); // advance the ui-store version in lockstep: feature-gated slot items show/hide immediately
}

/** Updates a single feature item in place (extension-manager change event → host patch, no refetch). Booleans for booleans, strings for strings. */
export function patchExtFeature(extId: string, featureId: string, value: boolean | string): void {
  const per = { ...(featureState[extId] ?? {}) };
  per[featureId] = value;
  featureState = { ...featureState, [extId]: per };
  for (const l of featureListeners) l();
  bump(); // advance the ui-store version in lockstep: feature-gated slot items show/hide immediately
}

/** Synchronously reads one extension's feature state (undeclared/unknown → undefined !== false → treated as enabled). */
export function getExtFeaturesOf(extId: string): Record<string, boolean | string> {
  return featureState[extId] ?? {};
}

/** Synchronously reads whether a single feature item is enabled (boolean). String-typed values are always true. */
export function getExtFeature(extId: string, featureId: string): boolean {
  const v = featureState[extId]?.[featureId];
  if (typeof v === "string") return v !== "";
  return v !== false;
}

/** Subscribes to feature state changes (returns an unsubscribe function). */
export function subscribeExtFeatures(cb: () => void): () => void {
  featureListeners.add(cb);
  return () => { featureListeners.delete(cb); };
}

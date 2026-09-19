/**
 * ExtClientLoader — the browser half of the client-modules mechanism (adopted from
 * the DSH adapter work, see docs/dsh-adapter-assessment.md §5.1).
 *
 * The server assembles extension client bundles into a boot graph (PiWebBootGraph,
 * anchored by rev); this loader loads it in two phases:
 *  - prefetch(id): fetch the bundle (ESM import) and only keep the register entry —
 *    side effects (registerItems/registerChatHook etc.) all live inside register(ctx)
 *    and don't happen until it is called.
 *  - materialize(id, ctx): call register(ctx), memoized (one registration per rev).
 *  - invalidate(id): drop registered items and the materialized flag (HMR hook) →
 *    the next materialize re-imports and re-registers.
 *  - reconcileGraph(newGraph): diff by rev → invalidate only changed extensions
 *    (precise HMR unwind instead of a full reset + re-import).
 *
 * Backward compatibility: existing extension bundles are still "export default
 * register(ctx)" (import runs the top level; side effects live in register) — this
 * loader's prefetch/materialize semantics align with that (top-level execution =
 * register entry ready; calling register = materialize).
 */
"use client";

import { apiUrl } from "../lib/base-path.ts";
import type { PiWebBootGraph, PiWebBootEntry } from "@/lib/ext/client-modules";

/** Load state of one extension client module. */
interface ClientModule {
  id: string;
  url: string;
  rev: string;
  /** The register entry exported by the bundle (obtained on import, called at
   *  materialize time). The ctx type is supplied by the host (ExtSlots.makeClientContext)
   *  — the loader stays framework-agnostic and does not depend on a concrete ctx shape
   *  (so node tests don't have to parse tsx files). */
  registerFn: ((ctx: unknown) => unknown) | null;
  /** Disposer returned by register(ctx) (DI plan P2: used to unwind cross-extension
   *  client services; non-function returns are ignored). Called on invalidate
   *  (rev change / extension removal) — the service broadcasts "down" as it goes
   *  away, which consumers can observe via onExtServiceChange. */
  disposeFn: (() => void) | null;
  /** Already materialized (register has been called) — registered once per rev. */
  materialized: boolean;
}

const modules = new Map<string, ClientModule>();
/** In-flight materialize (guards against concurrent duplicate registration: the startup loop and on-demand triggers can arrive at the same time). */
const materializing = new Map<string, Promise<boolean>>();

/**
 * Load state of the eager batch bundle (server artifact of lib/ext/client-bundle.ts):
 * a single import yields { registry: { [extId]: registerFn } } used to prefetch all
 * eager extensions. Import failure / missing entry → returns null and prefetch falls
 * back to per-extension URLs (the batch bundle is a pure optimization, not a single
 * point of failure).
 */
let bundleLoad: { url: string; promise: Promise<Map<string, (ctx: unknown) => unknown> | null> } | null = null;

/** Module source URL for a graph entry: batch-bundle members go through the bundle, everything else uses the per-extension URL. */
function moduleSourceUrl(entry: PiWebBootEntry): string {
  const bundle = bootGraph.bundle;
  return bundle && bundle.ids.includes(entry.id) ? bundle.url : entry.url;
}

/** Imports the batch bundle and reconciles it into an id → register-entry map; returns null on failure (caller falls back to per-extension imports). */
async function loadBundleRegistry(): Promise<Map<string, (ctx: unknown) => unknown> | null> {
  const bundle = bootGraph.bundle;
  if (!bundle) return null;
  if (bundleLoad && bundleLoad.url === bundle.url) return bundleLoad.promise;
  const url = bundle.url;
  const promise = (async () => {
    try {
      const mod: unknown = await import(/* webpackIgnore: true */ apiUrl(url));
      const registry = (mod as { registry?: Record<string, unknown> }).registry;
      const map = new Map<string, (ctx: unknown) => unknown>();
      if (registry && typeof registry === "object") {
        for (const [id, fn] of Object.entries(registry)) {
          if (typeof fn === "function") map.set(id, fn as (ctx: unknown) => unknown);
        }
      }
      return map;
    } catch (e) {
      console.error("[ext] client bundle import failed — falling back to per-extension bundles:", e);
      // Don't stick on failure: the next prefetch retries (other extensions already went through their own fallbacks, unaffected).
      if (bundleLoad?.url === url) bundleLoad = null;
      return null;
    }
  })();
  bundleLoad = { url, promise };
  return promise;
}
/** Extensions already warned about for "no register export" (prevents duplicate log spam). */
const warnedNullRegister = new Set<string>();
let bootGraph: PiWebBootGraph = { rev: "", entries: [] };

/**
 * UI slots declared by each extension (from the manifest ui definitions) — the basis
 * for on-demand loading: when ExtSlot renders a slot and some extension declared that
 * slot without being materialized yet, its materialize is triggered (bundle fetch +
 * registration side effects happen on first use only).
 */
const declaredSlots = new Map<string, string[]>();

/** Records the slots an extension declares (slot keys from ui definitions) after the
 *  manifest is fetched. An empty declaration clears the old value (after reload, when
 *  an extension no longer declares a slot, the previous declaration must not linger —
 *  otherwise on-demand loading would trigger spuriously). */
export function registerDeclaredSlots(extId: string, slots: string[]): void {
  if (slots.length > 0) declaredSlots.set(extId, slots);
  else declaredSlots.delete(extId);
}

/**
 * [page-open plan §5] Slot declaration seed delivered by SSR (the server registry's
 * ground truth, available before the client manifest). The first frame can already
 * decide "who takes over which slot": TakeoverSlot skips mounting fallback components
 * (saving one full list fetch), and absence rulings like useExtSlotSettled can settle early.
 * @param decls slot → extId[]; null = server not ready (unknown, known flag not set)
 */
let serverDeclarationsKnown = false;
export function seedServerDeclarations(decls: Record<string, string[]> | null | undefined): void {
  if (!decls) return; // unknown: stay unknown (must not be used for takeover rulings)
  serverDeclarationsKnown = true;
  for (const [slot, ids] of Object.entries(decls)) {
    for (const id of ids) {
      const cur = declaredSlots.get(id);
      if (!cur) declaredSlots.set(id, [slot]);
      else if (!cur.includes(slot)) cur.push(slot);
    }
  }
}

/** Whether the server slot declarations have been delivered (when true, "nobody declares this" is authoritative). */
export function isServerDeclarationsKnown(): boolean {
  return serverDeclarationsKnown;
}

/** Whether a graph entry is an "immediate" item (immediately:false = lazy, left for on-demand triggering). */
export function isImmediateEntry(entry: PiWebBootEntry): boolean {
  return entry.immediately !== false;
}

/** Targets for the startup batch: immediate items only — lazy extensions are neither prefetched nor materialized. */
export function immediateEntries(graph: PiWebBootGraph): PiWebBootEntry[] {
  return graph.entries.filter(isImmediateEntry);
}

/** Startup materialize order (unified SSE port plan §3-B): immediate items stable-sorted
 *  by descending priority (same priority keeps graph order). The caller materializes the
 *  first item alone (priority > 0 infrastructure extensions, e.g. the event-bus extension
 *  → window.__piEventBus mounts its slot first), then the rest in parallel — consumers
 *  probing via getEventBus no longer see a "bus arrived late" race window. */
export function immediateEntriesByPriority(graph: PiWebBootGraph): PiWebBootEntry[] {
  return immediateEntries(graph)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (b.e.priority ?? 0) - (a.e.priority ?? 0) || a.i - b.i)
    .map((x) => x.e);
}

/** Prunes slot declarations not in activeIds (called after a manifest refetch —
 *  uninstalled/disabled extensions no longer appear in the manifest, and stale
 *  declarations would make pendingForSlot trigger pointlessly on every render). */
export function pruneDeclaredSlots(activeIds: Iterable<string>): void {
  const active = new Set(activeIds);
  for (const id of [...declaredSlots.keys()]) {
    if (!active.has(id)) declaredSlots.delete(id);
  }
}

export function getBootGraph(): PiWebBootGraph {
  return bootGraph;
}

/** Writes the latest graph after the manifest is fetched (first load / refresh after reload). */
export function setBootGraph(graph: PiWebBootGraph): void {
  bootGraph = graph;
}

/** A given extension's entry in the graph; unknown ids return undefined. */
export function entryOf(id: string): PiWebBootEntry | undefined {
  return bootGraph.entries.find((e) => e.id === id);
}

/** Phase one: fetch the bundle and grab the register entry (never called, no side effects). */
export async function prefetch(id: string): Promise<void> {
  const entry = entryOf(id);
  if (!entry) return;
  const sourceUrl = moduleSourceUrl(entry);
  const existing = modules.get(id);
  if (existing && existing.url === sourceUrl && existing.rev === entry.rev) return; // same source, same rev: already tracked
  try {
    // Phase 1: batch-bundle members first (eager extensions share a single request).
    if (bootGraph.bundle?.ids.includes(id)) {
      const registry = await loadBundleRegistry();
      const bundled = registry?.get(id);
      if (typeof bundled === "function") {
        modules.set(id, { id, url: sourceUrl, rev: entry.rev, registerFn: bundled, disposeFn: null, materialized: false });
        return;
      }
      // Missing entry (pruned at build time / drift) → continue with the per-extension import fallback.
    }
    // webpackIgnore: keep the native dynamic import (Next would otherwise
    // rewrite it into a bundled context stub). apiUrl adds the basePath (the
    // graph's assetUrl is a bare /api/...; subpath deployments need the /dev prefix).
    const importBundle = (bust?: number) =>
      import(/* webpackIgnore: true */ bust
        ? `${apiUrl(entry.url)}${entry.url.includes("?") ? "&" : "?"}bust=${bust}`
        : apiUrl(entry.url));
    let mod: unknown;
    try {
      mod = await importBundle();
    } catch (firstErr) {
      // Module negative-cache workaround: the HTML module map tracks URLs, so within
      // one document a failed import of the same URL always fails again without
      // sending a request — a transient network blip (dev recompile / deploy reload
      // window) surfaces as "the button did nothing". The bundle is content-addressed
      // (rev anchored), so adding a one-off query param keeps semantics identical and
      // one retry punches through the negative cache.
      mod = await importBundle(Date.now());
      console.warn(
        `[ext] ${id}: bundle import retry succeeded (first failure: ${String((firstErr as Error)?.message ?? firstErr).slice(0, 120)})`,
      );
    }
    const ns = mod as { default?: unknown; register?: (ctx: unknown) => void };
    const registerFn =
      typeof ns.default === "function"
        ? (ns.default as (ctx: unknown) => void)
        : typeof ns.register === "function"
          ? ns.register
          : null;
    modules.set(id, { id, url: sourceUrl, rev: entry.rev, registerFn, disposeFn: null, materialized: false });
  } catch (e) {
    console.error(`[ext] failed to fetch client bundle for ${id}:`, e);
    modules.delete(id);
  }
}

/**
 * Phase two: call register(ctx) (side effects happen here). Memoized: no-op if the
 * same rev is already materialized.
 * @returns true when this call actually performed the registration (callers use it to
 * decide whether unwinding is needed).
 */
export async function materialize(id: string, makeCtx: (id: string) => unknown): Promise<boolean> {
  // Mutual exclusion must be established synchronously at function entry (before
  // prefetch's await) — with concurrent calls (StrictMode double effect / startup
  // batch + slot on-demand trigger), if both check in-flight only after awaiting
  // prefetch they interleave and each runs register → duplicate registration.
  const inFlight = materializing.get(id);
  if (inFlight) return inFlight;
  const run = (async () => {
    let mod = modules.get(id);
    if (!mod) {
      await prefetch(id);
      mod = modules.get(id);
    }
    if (!mod) return false;
    if (mod.materialized) return false;
    if (!mod.registerFn) {
      // Bundle contract violation (no default/register export) — warn once and do
      // not mark materialized (on-demand triggers retry, without repeated spam).
      if (!warnedNullRegister.has(id)) {
        warnedNullRegister.add(id);
        console.warn(`[ext] ${id}: client bundle exports no register function (expected export default register(ctx))`);
      }
      return false;
    }
    try {
      const ret: unknown = mod.registerFn(makeCtx(id));
      // DI plan P2: capture the disposer register returned (unwinds the client-service registration on invalidate)
      mod.disposeFn = typeof ret === "function" ? (ret as () => void) : null;
      mod.materialized = true;
      return true;
    } catch (e) {
      console.error(`[ext] failed to materialize ${id}:`, e);
      return false;
    }
  })();
  materializing.set(id, run);
  try {
    return await run;
  } finally {
    materializing.delete(id);
  }
}

/** Ids of materialized extensions (used by the extension-management UI to show load state). */
export function materializedIds(): string[] {
  return [...modules.values()].filter((m) => m.materialized).map((m) => m.id);
}

/** Ids of prefetched extensions (bundle fetched but not materialized). */
export function prefetchedIds(): string[] {
  return [...modules.values()].filter((m) => !m.materialized).map((m) => m.id);
}

/**
 * Declared extensions of a slot that are not materialized yet (the on-demand loading
 * queue). The immediately flag (graph entry) only affects whether phase one prefetched
 * at startup; regardless of prefetching, extensions declaring this slot are returned
 * here and ExtSlot triggers their materialize on render.
 */
export function pendingForSlot(slot: string): string[] {
  return [...declaredSlots.entries()]
    .filter(([, slots]) => slots.includes(slot))
    .map(([id]) => id)
    .filter((id) => {
      const m = modules.get(id);
      return !m || !m.materialized; // not fetched, or fetched but not registered
    });
}

/** Whether any extension declares a slot (manifest ui snapshot; effective once
 *  registerDeclaredSlots has recorded it). Used for "absence → native fallback"
 *  rulings: nobody declaring = settled by one snapshot, independent of materialization
 *  timing/success. */
export function slotDeclared(slot: string): boolean {
  for (const slots of declaredSlots.values()) if (slots.includes(slot)) return true;
  return false;
}

/**
 * [lazy-loading v2] For always-mounted slot auto-triggering: exclude every lazy
 * extension (immediately:false) from pendingForSlot. Always-mounted slots (toolbar/
 * sidebar/…20+) render on first paint — without the exclusion, "marked lazy" would
 * still materialize at startup. A lazy extension's entry point in an always-mounted
 * slot is the manifest static item (clicks go through ensureMaterialized).
 */
export function pendingForSlotAuto(slot: string): string[] {
  // [page-open plan §1 F1] fail-closed: when the boot graph isn't ready, entryOf()
  // returns undefined and the old check `?.immediately !== false` would wave unknown
  // entries through as immediate → lazy extensions got auto-materialized on
  // always-mounted slots (toolbar/dialogs/pages/banners; measured: with graphLen=0,
  // 13/13 lazy extensions were all pulled up).
  // Graph not ready → never auto-materialize; graph ready but no entry (no client
  // bundle) → don't let it through either.
  if (!bootGraph.entries.length) return [];
  return pendingForSlot(slot).filter((id) => {
    const e = entryOf(id);
    return !!e && e.immediately !== false;
  });
}

/**
 * [lazy-loading v2] Slots mounted on interaction: their useExtSlotItems materialize
 * effect keeps the "first render pulls up every declaring extension (lazy included)"
 * semantics — the slot mounting itself is a user-perceivable interaction moment
 * (opening settings / opening a file / opening a terminal…). Slots outside this list
 * (always mounted) all go through pendingForSlotAuto.
 * Host-maintained; register new interaction-mounted slots here (see the full table in
 * §1.2 of the lazy-loading plan doc).
 */
export const INTERACTIVE_SLOTS: ReadonlySet<string> = new Set([
  "sessionStats",
  "fileViewer",
  "pathPicker",
  "settingsModels",
  "settingsAgents",
  "settingsAgentsFeature",
  // New-session widget zone: the Zone only mounts on the isEmptyNew welcome page —
  // exactly the "user wants to see widgets" interaction moment; the session page never
  // mounts the Zone (zero requests). Lazy extensions declaring this slot materialize
  // on the welcome page (widgets need a real render; static items can only enter the
  // panel) — an explicit opt-in by the extension.
  "newSessionWidgets",
]);
// ❌ Removed (page-open plan §1 F2/F3, 2026-09-12): these two slots are NOT real
// interaction slots —
//   · "rightFileDock": AppShell calls useExtSlotItems() at mount time to derive the
//     dock tab list (right-dock tab section of components/AppShell.tsx), not "only
//     when the right dock opens";
//   · "terminalDock": TerminalPanelBridge is an always-mounted hidden container in
//     AppShell (restored terminal tabs).
// Keeping them here would unconditionally materialize lazy extensions (ai-schedule/
// doc-center/git-review/mail/subagents/service-tunnels/the command extension) on page
// open. They are now pulled up explicitly at real interaction moments:
//   · dock tab activated/opened → the extension's own entry point (toolbar static item
//     click) → after materialization the registered item brings its own render;
//   · terminal tab visible → ensureExtSlotMaterialized("terminalDock") inside
//     components/TerminalPanelBridge.tsx.

/**
 * [lazy-loading v2] Idempotent materialize: ensure an extension's client has run
 * register(ctx) (concurrency-safe — reuses materialize's materializing Map mutex).
 * @returns true when this call actually performed the registration; already
 * materialized / no bundle returns false.
 */
export async function ensureMaterialized(id: string, makeCtx: (id: string) => unknown): Promise<boolean> {
  const mod = modules.get(id);
  if (mod?.materialized) return false;
  return materialize(id, makeCtx);
}

/**
 * [lazy-loading v2] Materializes every lazy extension declaring the slot (for
 * interaction-mounted slots and takeover direct-read trampolines). Idempotent:
 * no-op when everything is already materialized.
 */
export async function ensureSlotMaterialized(slot: string, makeCtx: (id: string) => unknown): Promise<void> {
  const pending = pendingForSlot(slot);
  for (const id of pending) {
    await ensureMaterialized(id, makeCtx);
  }
}

/**
 * HMR hook: drop an extension's registered items and materialized flag (rev changed).
 * @param removeItems host-provided "clear UI items per extension" callback
 * (ext-ui-store.removeExtUiItems).
 * @returns the extension's next materialize re-imports and re-registers.
 */
export function invalidate(id: string, removeItems?: (extId: string) => void): void {
  // DI plan P2: unwind the disposer register returned (deregisters cross-extension client services → broadcasts down)
  const mod = modules.get(id);
  try { mod?.disposeFn?.(); } catch (e) { console.warn(`[ext] ${id}: client dispose failed:`, e); }
  removeItems?.(id);
  modules.delete(id);
}

/**
 * Unwinds against a new graph: rev diff → invalidate only changed/vanished
 * extensions; new extensions automatically enter the next prefetch/materialize
 * round. Returns the list of unwound extension ids.
 */
export function reconcileGraph(
  newGraph: PiWebBootGraph,
  removeItems?: (extId: string) => void,
): string[] {
  const oldById = new Map(bootGraph.entries.map((e) => [e.id, e]));
  const newById = new Map(newGraph.entries.map((e) => [e.id, e]));
  const oldBundleIds = new Set(bootGraph.bundle?.ids ?? []);
  const newBundleIds = new Set(newGraph.bundle?.ids ?? []);
  const invalidated: string[] = [];
  for (const [id, oldEntry] of oldById) {
    const newEntry = newById.get(id);
    // A module source change (batch-bundle membership flip) must also unwind —
    // otherwise prefetch would reset the module without re-registering (the
    // materialized state is lost and UI items linger).
    const membershipChanged = oldBundleIds.has(id) !== newBundleIds.has(id);
    if (!newEntry || newEntry.rev !== oldEntry.rev || membershipChanged) {
      invalidate(id, removeItems);
      invalidated.push(id);
    }
  }
  // When the batch bundle's rev changes (same member set but a member's content
  // changed), unchanged members keep their module entries (the registerFn closure
  // still points at the old bundle, which behaves correctly); changed members were
  // already unwound by the rev diff above, and their next prefetch re-imports the
  // new bundle because bundle.url changed.
  bootGraph = newGraph;
  return invalidated;
}

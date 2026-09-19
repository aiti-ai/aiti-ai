/**
 * client-modules — bundle distribution contract (informed by the DSH adapter
 * assessment §5.1).
 *
 * The server assembles extension client bundles into a "boot graph" (wire
 * single source):
 *  - each row = one extension's client bundle (content-hash rev + rev-carrying URL)
 *  - graph rev = whole-graph consistency anchor: any row change → graph rev
 *    change (the frontend compares graph revs for precise HMR reconciliation)
 *  - inject edges: extensions may declare dependencies on other extensions
 *    (parallel prefetch / load-order hint, informational)
 *
 * The frontend loads per graph in two phases (prefetch registers factories →
 * materialize lazily runs side effects); reload invalidates only changed items
 * by rev diff — replacing full reset + re-import.
 *
 * Relation to the manifest: the manifest carries "UI metadata + clientUrl",
 * the graph carries the "load graph (rev + dependency edges + prefetch
 * flags)". Both share the same scan source, but only the graph feeds the
 * frontend loader; the manifest's clientUrl remains for the legacy load path.
 */

/** One row of the graph: an extension's client bundle. */
export interface PiWebBootEntry {
  /** Extension id (== entry name). */
  id: string;
  /** Bundle endpoint, e.g. /api/extensions/<id>/assets/<client>?rev=<rev>. */
  url: string;
  /** Bundle content hash (cache-invalidation consistency anchor; rides the URL as cache-busting). */
  rev: string;
  /** Dependency edges: other extension ids this bundle depends on (parallel prefetch hint, informational). */
  inject?: string[];
  /** Phase-one prefetch flag: fetch and register the factory at startup; unflagged ones are fetched at first materialize. */
  immediately?: boolean;
  /** Frontend materialize priority (unified SSE port design §3-B): higher first — the startup batch materializes the
   *  highest-priority item alone first (the event-bus extension mounts its window.__piEventBus slot first), the rest
   *  of the immediate items in parallel. Default = 0, passed through from the backend startupPriority. */
  priority?: number;
}

/** Input for a single graph row (a buildBootGraph argument row). */
export interface PiWebBootGraphInput {
  id: string;
  /** Asset path relative to the client bundle (no hash query), e.g. /api/extensions/demo/assets/client/demo.mjs */
  assetUrl: string;
  /** bundle content hash (12 hex chars) */
  hash: string;
  inject?: string[];
  immediately?: boolean;
  /** Passed through under the same name as PiWebBootEntry.priority (extension startupPriority). */
  priority?: number;
  /** Excluded from the eager bundle (entries using import.meta or otherwise sensitive to the load path). */
  bundleExcluded?: boolean;
}

/** The full boot graph injected into the frontend. */
export interface PiWebBootGraph {
  /** Whole-graph consistency anchor: hash of the composed entries. Any row change → graph rev change. */
  rev: string;
  /** Composed entries; order carries no semantics (activation order is the frontend's on-demand materialize). */
  entries: PiWebBootEntry[];
  /** Eager extension bundle (omitted when there are no eager rows). */
  bundle?: PiWebClientBundle;
}

/** Empty graph (the frontend loader's initial value when no client extensions exist). */
export const EMPTY_BOOT_GRAPH: PiWebBootGraph = { rev: "", entries: [] };

/**
 * Compose the boot graph (pure function). The bundle content hash shares its
 * source with the manifest clientUrl's ?v=, keeping graph rev and clientUrl
 * cache invalidation consistent.
 *
 * @param entries scanned (id, clientUrl, hash, inject, immediately) rows
 * @returns the composed graph; EMPTY_BOOT_GRAPH when there is no bundle
 */
export function buildBootGraph(entries: PiWebBootGraphInput[]): PiWebBootGraph {
  const valid = entries.filter((e) => e.hash); // extensions without a client bundle (or unreadable ones) stay out of the graph
  const rows: PiWebBootEntry[] = valid.map((e) => ({
    id: e.id,
    url: `${e.assetUrl}?rev=${e.hash}`,
    rev: e.hash,
    ...(e.inject?.length ? { inject: e.inject } : {}),
    ...(e.immediately === false ? { immediately: false } : {}),
    ...(typeof e.priority === "number" && e.priority !== 0 ? { priority: e.priority } : {}),
  }));
  if (rows.length === 0) return EMPTY_BOOT_GRAPH;
  // Eager bundle: rows with immediately !== false and not excluded (order =
  // priority desc + graph order, matching the frontend's
  // immediateEntriesByPriority; top-level execution order of modules within the
  // bundle is therefore stable).
  const bundleRows = valid
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.immediately !== false && !e.bundleExcluded)
    .sort((a, b) => (b.e.priority ?? 0) - (a.e.priority ?? 0) || a.i - b.i)
    .map(({ e }) => ({ id: e.id, rev: e.hash }));
  const bundle: PiWebClientBundle | undefined = bundleRows.length
    ? (() => {
        const rev = clientBundleRev(bundleRows);
        return { url: clientBundleUrl(rev), rev, ids: bundleRows.map((r) => r.id) };
      })()
    : undefined;
  // priority participates in the graph hash: priority changes (e.g. infrastructure
  // extension tuning) must also change the graph rev → the frontend reconciles
  const graphRev = hashText(JSON.stringify({
    rows: rows.map((r) => ({ id: r.id, rev: r.rev, inject: r.inject, priority: r.priority ?? 0 })),
    bundle: bundle?.rev ?? "",
  }));
  return { rev: graphRev, entries: rows, ...(bundle ? { bundle } : {}) };
}

/** Content hash (first 12 hex chars of sha256, same as registry.clientHash). */
import { createHash } from "node:crypto";

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/* ------------------------------------------------------------------ *
 * Eager bundle (client-bundle) — request-count governance:
 * extensions guaranteed to load on first paint need not fire one request each;
 * registry.computeBundle() composes eager rows (immediately !== false and not
 * marked bundleExcluded) into a single bundle row, which the frontend loader
 * imports once and then materializes per graph. Bundle build/server logic
 * lives in client-bundle.ts (this file stays pure functions with zero
 * fs/esbuild dependencies, safe to reference from the client).
 * ------------------------------------------------------------------ */

/** Bundle URL path (the client's apiUrl() appends the basePath). */
export const CLIENT_BUNDLE_PATH = "/api/extensions/client-bundle";

/** Bundle format version (bump on algorithm/wrapper-shape changes to force all clients to re-fetch).
 *  v4: lazy-chunk extensions (usesLazyChunks) externalize static relative imports — shared chunk files are single-instanced. */
export const CLIENT_BUNDLE_VERSION = 4;

/** Bundle descriptor (attached to the boot graph; entries' rev/url keep their per-extension semantics). */
export interface PiWebClientBundle {
  url: string;
  rev: string;
  /** Extension ids packed into the bundle (frontend prefetch uses bundle loading only for these ids; missing ones automatically fall back to single-extension URLs). */
  ids: string[];
}

export function clientBundleUrl(rev: string): string {
  return `${CLIENT_BUNDLE_PATH}?rev=${rev}`;
}

/** Bundle content-addressed rev (over the extension set + version). */
export function clientBundleRev(entries: Array<{ id: string; rev: string }>): string {
  return hashText(JSON.stringify({
    v: CLIENT_BUNDLE_VERSION,
    rows: entries.map((e) => [e.id, e.rev]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  }));
}

/**
 * Recovery items provider registry (contract types in lib/composer/types.ts).
 *
 * Things like the P2 draft cluster merge "leftover input" into the queue recovery
 * dialog as recovery items: the extension registers a provider, and ChatWindow
 * merges them via useRecoveryProviderItems() when synthesizing recoveryItems
 * (≤5-line integration). Subscription semantics align with React
 * useSyncExternalStore: getItems must return a stable reference (same array when
 * content is unchanged), and subscribe notifies when items may have changed.
 */
import { useSyncExternalStore } from "react";
import type { RecoveryItemsProvider } from "./types";

export type { RecoveryItemsProvider };

const providers: RecoveryItemsProvider[] = [];
const listeners = new Set<() => void>();
let cached: unknown[] = [];

function invalidate(): void {
  const out: unknown[] = [];
  for (const p of providers) {
    try {
      out.push(...p.getItems());
    } catch (e) {
      console.warn(`[composer] recovery provider "${p.id}" getItems failed:`, e);
    }
  }
  cached = out;
  for (const l of listeners) l();
}

/** Register a recovery items provider; returns a disposer. Re-aggregates automatically when items change. */
export function registerRecoveryItemsProvider(p: RecoveryItemsProvider): () => void {
  providers.push(p);
  const unsub = p.subscribe?.(() => invalidate());
  invalidate();
  return () => {
    const i = providers.indexOf(p);
    if (i >= 0) providers.splice(i, 1);
    unsub?.();
    invalidate();
  };
}

/** Flattened aggregation of all providers' items (used by ChatWindow to synthesize the recovery list). */
export function getRecoveryProviderItems(): unknown[] {
  return cached;
}

/** React subscription: re-renders when providers or their items change. */
export function useRecoveryProviderItems(): readonly unknown[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => cached,
    () => [],
  );
}

/** Test helper: clear all state (do not call in production code). */
export function resetRecoveryProvidersForTests(): void {
  providers.length = 0;
  listeners.clear();
  cached = [];
}

/**
 * User decision routing: dispatch ids to the provider that owns them by prefix
 * (kept/discarded). ChatWindow's recovery dialog calls this for ids of unknown
 * origin; unclaimed ids are returned as-is.
 */
export function routeRecoveryResolve(kept: string[], discarded: string[]): { kept: string[]; discarded: string[] } {
  const byOwner = (id: string) => providers.find((p) => id.startsWith(`${p.id}:`));
  const groups = new Map<RecoveryItemsProvider, { kept: string[]; discarded: string[] }>();
  const bucket = (id: string, kind: "kept" | "discarded") => {
    const owner = byOwner(id);
    if (!owner?.onResolve) return false;
    let g = groups.get(owner);
    if (!g) { g = { kept: [], discarded: [] }; groups.set(owner, g); }
    g[kind].push(id);
    return true;
  };
  const rest = { kept: kept.filter((id) => !bucket(id, "kept")), discarded: discarded.filter((id) => !bucket(id, "discarded")) };
  for (const [p, g] of groups) {
    try {
      p.onResolve!(g.kept, g.discarded);
    } catch (e) {
      console.warn(`[composer] recovery provider "${p.id}" onResolve failed:`, e);
    }
  }
  return rest;
}

/**
 * provider-quota — pi-session account-quota fallback for the get_usage
 * protocol (plan: pi-web-pi-session-provider-quota §4-A2).
 *
 * pi-family sessions (in-process + spawn) have no backend-owned getUsage(); the
 * handle-adapter falls back here with the session's current model provider and
 * we answer with that provider's account quota from the usage-adapter registry
 * (lib/provider-usage). Unsupported provider / query failure → null → the UI
 * quota surfaces hide silently (fail-honest, same contract as qoder/zcode).
 *
 * Caching: 60s ok / 10s error TTL, entries hold the in-flight promise so
 * concurrent triggers (state arrival + badge panel open) share one upstream
 * query. Timeouts/security are NOT re-implemented here — the core
 * secure-fetch already carries a 15s timeout + origin pinning + 64KB cap.
 */

// Query chain stays lazy: this module is statically reachable from
// handle-adapter (and thus from node:test runs) — only pure modules are
// imported eagerly (id catalog + the dynamic-adapter ledger), so the
// short-circuit check below never touches ModelRuntime. The full facade (which
// imports ModelRuntime AND triggers the built-in adapters' self-registration)
// loads on first real query — loading it BEFORE any adapter-presence judgement
// matters: after a fresh process start the registry is empty until that import
// runs. Timeouts/security are NOT re-implemented here — the core secure-fetch
// already carries a 15s timeout + origin pinning + 64KB cap.

import { isProviderUsageId } from "../provider-usage-ids.ts";
import { listUsageAdaptersWithOwners } from "../provider-usage/registry.ts";
import { providerReportToUsageSnapshot } from "./provider-quota-convert.ts";
import type { UsageReport } from "./types.ts";

const OK_TTL_MS = 60_000;
const ERROR_TTL_MS = 10_000;

interface CacheEntry {
  at: number;
  /** null while the query is in flight; boolean once settled (false → error TTL). */
  ok: boolean | null;
  promise: Promise<UsageReport | null>;
}

const cache = new Map<string, CacheEntry>();

/** Test/diagnostic escape hatch: drop every cached snapshot. */
export function invalidateProviderQuotaCache(): void {
  cache.clear();
}

export async function queryProviderQuotaSnapshot(providerId: string): Promise<UsageReport | null> {
  const now = Date.now();
  const hit = cache.get(providerId);
  if (hit) {
    // In-flight entries (ok === null) are always shared; settled ones honor their TTL.
    if (hit.ok === null || now - hit.at < (hit.ok ? OK_TTL_MS : ERROR_TTL_MS)) return hit.promise;
    cache.delete(providerId);
  }

  let settled: boolean | null = null;
  const promise = (async (): Promise<UsageReport | null> => {
    try {
      // Fast short-circuit on pure state only (id catalog + registered dynamic
      // ledger): unknown ids never load the heavy facade (node:test safety —
      // fake provider ids must not reach ModelRuntime). Built-in ids pass here
      // and load the facade below, which self-registers the adapters then queries.
      const dynamicRegistered = listUsageAdaptersWithOwners()
        .some((entry) => entry.extId !== null && entry.adapter.id === providerId);
      if (!isProviderUsageId(providerId) && !dynamicRegistered) return null;
      const { queryProviderUsage } = await import("../provider-usage.ts");
      const result = await queryProviderUsage(providerId);
      if (result.status !== "ready") {
        console.warn(`[provider-quota] ${providerId}: ${result.status}${result.message ? ` — ${result.message}` : ""}`);
        settled = false; // negative-cache: unsupported/auth-missing ids re-probe after the error TTL (a later dynamic registration must not be blocked forever)
        return null;
      }
      const snapshot = providerReportToUsageSnapshot(result.report, providerId);
      settled = true;
      return snapshot;
    } catch (caught) {
      console.warn(`[provider-quota] ${providerId}: query failed — ${caught instanceof Error ? caught.message : String(caught)}`);
      settled = false;
      return null;
    }
  })();

  const entry: CacheEntry = { at: now, ok: null, promise };
  cache.set(providerId, entry);
  void promise.finally(() => {
    if (settled !== null) entry.ok = settled;
  });
  return promise;
}

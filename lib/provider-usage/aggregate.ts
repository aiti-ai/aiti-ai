import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import "./adapters";
import { queryUsageTargets, resolveUsageTargets } from "./key-pool.ts";
import { getUsageAdapter, listUsageAdapters } from "./registry.ts";
import type { ProviderUsageResult, UsageReport } from "./types.ts";

// Overview aggregation: enumerate configured + adaptable providers, query each
// with bounded concurrency (allSettled — one failure never blocks the rest),
// TTL-cached in-process. Event-driven only: no timers, no polling (repo rule).

const TTL_MS = 5 * 60_000;
const CONCURRENCY = 3;

export interface OverviewEntry {
  providerId: string;
  providerName: string;
  kind: string;
  status: "ready" | "auth-unavailable" | "query-failed";
  report?: UsageReport;
  message?: string;
}

export interface UsageOverview {
  capturedAt: number;
  providers: OverviewEntry[];
}

let cache: { at: number; overview: UsageOverview } | null = null;

export function invalidateUsageOverviewCache(): void {
  cache = null;
}

export async function queryUsageOverview(force = false): Promise<UsageOverview> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.overview;
  const overview = await aggregate();
  cache = { at: Date.now(), overview };
  return overview;
}

async function aggregate(): Promise<UsageOverview> {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  const candidates = new Map<string, { displayName: string; baseUrl?: string }>();
  for (const adapter of listUsageAdapters()) {
    candidates.set(adapter.id, { displayName: adapter.displayName });
  }
  for (const provider of runtime.getProviders()) {
    const adapter = getUsageAdapter(provider.id, provider.baseUrl);
    if (!adapter) continue;
    candidates.set(provider.id, { displayName: adapter.displayName, baseUrl: provider.baseUrl });
  }

  const entries = [...candidates.entries()];
  const results: OverviewEntry[] = new Array(entries.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < entries.length) {
      const index = cursor++;
      const [providerId, meta] = entries[index];
      results[index] = await queryOne(runtime, providerId, meta);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
  results.sort((a, b) => a.providerName.localeCompare(b.providerName));
  return { capturedAt: Date.now(), providers: results };
}

async function queryOne(runtime: ModelRuntime, providerId: string, meta: { displayName: string; baseUrl?: string }): Promise<OverviewEntry> {
  const adapter = getUsageAdapter(providerId, meta.baseUrl);
  if (!adapter) return { providerId, providerName: meta.displayName, kind: "usage", status: "query-failed", message: "No usage adapter." };
  // Runtime credential, or the models.json rotation pool when the provider sits
  // behind the pi-models-combo proxy (see key-pool.ts).
  const targets = await resolveUsageTargets(runtime, providerId);
  if (!targets) {
    return { providerId, providerName: adapter.displayName, kind: "usage", status: "auth-unavailable", message: "Connect this provider before querying usage." };
  }
  try {
    const report = await queryUsageTargets(adapter, targets);
    return { providerId, providerName: adapter.displayName, kind: "usage", status: "ready", report };
  } catch (caught) {
    return {
      providerId,
      providerName: adapter.displayName,
      kind: "usage",
      status: "query-failed",
      message: caught instanceof Error ? caught.message : "The provider usage query failed.",
    };
  }
}

export type { ProviderUsageResult };

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import "./provider-usage/adapters";
import { queryUsageTargets, resolveUsageTargets } from "./provider-usage/key-pool";
import { getUsageAdapter } from "./provider-usage/registry";
import type { ProviderUsageResult, UsageReport } from "./provider-usage/types";
import type { ProviderUsageId } from "./provider-usage-ids";

export { PROVIDER_USAGE_IDS, isProviderUsageId, type ProviderUsageId } from "./provider-usage-ids";
export { queryUsageOverview, type UsageOverview, type OverviewEntry } from "./provider-usage/aggregate";
export { listUsageAdapters, registerUsageAdapter, getUsageAdapter } from "./provider-usage/registry";
export type { UsageBucket, UsageMetric, UsageReport, ProviderUsageResult, ProviderUsageStatus, UsageAdapter } from "./provider-usage/types";

// Thin facade over the registry (lib/provider-usage/*). Query formats follow
// @narumitw/pi-usage (MIT, Copyright (c) 2026 narumiruna), but this module
// deliberately has no runtime dependency on that extension.

export async function queryProviderUsage(providerId: ProviderUsageId): Promise<ProviderUsageResult> {
  let runtime: ModelRuntime;
  try {
    runtime = await ModelRuntime.create({ refreshOnCreate: false });
  } catch {
    return { providerId, status: "query-failed", message: "The provider usage query failed." };
  }
  const provider = runtime.getProvider(providerId);
  const adapter = getUsageAdapter(providerId, provider?.baseUrl);
  if (!adapter) {
    return { providerId, status: "unsupported", message: "This provider does not expose a usage endpoint." };
  }
  if (!provider) {
    return { providerId, status: "query-failed", message: "The provider usage query failed." };
  }
  // Runtime credential, or the models.json rotation pool for proxied multi-key
  // providers (pi-models-combo hands out dummy tokens; see key-pool.ts).
  const targets = await resolveUsageTargets(runtime, providerId);
  if (!targets) {
    return { providerId, status: "auth-unavailable", message: "Connect this provider before querying usage." };
  }
  try {
    const report = await queryUsageTargets(adapter, targets);
    return { providerId, status: "ready", report };
  } catch (caught) {
    return { providerId, status: "query-failed", message: caught instanceof Error ? caught.message : "The provider usage query failed." };
  }
}

export function isOfficialProviderUsageOrigin(providerId: ProviderUsageId, baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return false;
  }
  return getUsageAdapter(providerId)?.origins.includes(origin) ?? false;
}

export function normalizeProviderUsagePayload(
  providerId: ProviderUsageId,
  payload: Record<string, unknown>,
  _capturedAt = Date.now(),
): UsageReport {
  const adapter = getUsageAdapter(providerId);
  if (!adapter?.normalize) throw new Error(`No usage adapter for ${providerId}.`);
  return adapter.normalize(payload, { providerId, auth: {} });
}

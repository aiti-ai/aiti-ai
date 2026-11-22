import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { UsageAdapter, UsageAuth, UsageBucket, UsageMetric, UsageReport } from "./types.ts";

// Multi-key rotation pools (models.json `apiKeys[]`, pi-models-combo).
//
// The rotation engine installs a local proxy per pool provider and registers it
// with a random per-session dummy token (`sk-dummy-…`), so the runtime credential
// a usage query receives is that dummy — sending it upstream yields 401. The real
// key set lives in models.json, so usage reads the pool here and fans out one
// query per key, labeling every window with its key (`Rolling · liyong`) so a
// pool spread over several accounts stays readable. Rules mirror the engine:
// `apiKeys[]` wins over the single `apiKey`, `enabled:false` entries are skipped.

export interface ProviderPoolKey {
  name: string;
  key: string;
}

export interface UsageQueryTarget {
  /** Rotation key name (undefined = the runtime credential). */
  name?: string;
  auth: UsageAuth;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let modelsFileCache: { path: string; mtimeMs: number; providers: Record<string, unknown> } | null = null;

function readProviderConfigs(): Record<string, unknown> {
  const path = join(getAgentDir(), "models.json");
  try {
    const stat = statSync(path);
    if (modelsFileCache && modelsFileCache.path === path && modelsFileCache.mtimeMs === stat.mtimeMs) {
      return modelsFileCache.providers;
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const providers = isRecord(parsed) && isRecord(parsed.providers) ? parsed.providers : {};
    modelsFileCache = { path, mtimeMs: stat.mtimeMs, providers };
    return providers;
  } catch {
    // Unreadable/damaged models.json keeps the last good read; never throws.
    return modelsFileCache?.path === path ? modelsFileCache.providers : {};
  }
}

/** Enabled `apiKeys` entries of a configured provider (rotation order preserved). */
export function readProviderPoolKeys(providerId: string): ProviderPoolKey[] {
  const config = readProviderConfigs()[providerId];
  if (!isRecord(config) || !Array.isArray(config.apiKeys)) return [];
  const keys: ProviderPoolKey[] = [];
  config.apiKeys.forEach((raw, index) => {
    if (!isRecord(raw) || raw.enabled === false) return;
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    if (!key) return;
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `key-${index + 1}`;
    keys.push({ name, key });
  });
  return keys;
}

/** pi-models-combo registers every session with its own random `sk-dummy-…` token. */
export function isProxyDummyKey(apiKey: unknown): boolean {
  return typeof apiKey === "string" && apiKey.startsWith("sk-dummy-");
}

function hasCredentials(auth: UsageAuth | undefined): boolean {
  if (!auth) return false;
  if (typeof auth.apiKey === "string" && auth.apiKey.length > 0) return true;
  return Boolean(auth.headers && Object.keys(auth.headers).length > 0);
}

/**
 *Credentials a usage query should use: the rotation pool when the provider has
 * one (≥2 enabled keys are always proxied, so the runtime key is a dummy), the
 * runtime credential otherwise. `null` = nothing usable (auth-unavailable).
 */
export async function resolveUsageTargets(runtime: ModelRuntime, providerId: string): Promise<UsageQueryTarget[] | null> {
  let runtimeAuth: UsageAuth | undefined;
  try {
    const resolved = await runtime.getAuth(providerId);
    runtimeAuth = resolved?.auth as UsageAuth | undefined;
  } catch {
    // No runtime credential (e.g. proxy-only provider) — the pool below may still have keys.
  }
  const pool = readProviderPoolKeys(providerId);
  const poolTargets: UsageQueryTarget[] = pool.map((entry) => ({
    name: entry.name,
    auth: { ...(runtimeAuth ?? {}), apiKey: entry.key },
  }));
  if (pool.length >= 2) return poolTargets;
  if (hasCredentials(runtimeAuth) && !isProxyDummyKey(runtimeAuth?.apiKey)) {
    // Runtime-credential path: an unconnected provider (e.g. OAuth without a
    // valid session) should read "connect this provider", not an upstream 401.
    if (runtime.getProviderAuthStatus?.(providerId)?.configured === false) return null;
    return [{ auth: runtimeAuth! }];
  }
  if (poolTargets.length) return poolTargets;
  // Dummy runtime token without a pool: keep the previous best-effort behavior.
  if (hasCredentials(runtimeAuth)) return [{ auth: runtimeAuth! }];
  return null;
}

/**
 * Run one query per target and merge the reports. A single ready target returns
 * its report untouched; multiple targets get key-suffixed bucket labels. Failed
 * keys never hide the healthy ones — they surface as a report note instead.
 */
export async function queryUsageTargets(adapter: UsageAdapter, targets: UsageQueryTarget[]): Promise<UsageReport> {
  const outcomes: Array<{ name?: string; report?: UsageReport; message?: string }> = [];
  for (const target of targets) {
    try {
      outcomes.push({ name: target.name, report: await adapter.query({ providerId: adapter.id, auth: target.auth }) });
    } catch (caught) {
      outcomes.push({ name: target.name, message: caught instanceof Error ? caught.message : "The provider usage query failed." });
    }
  }
  const ready = outcomes.filter((outcome): outcome is { name?: string; report: UsageReport } => outcome.report !== undefined);
  const failureNotes = outcomes
    .filter((outcome) => outcome.report === undefined)
    .map((outcome) => `${outcome.name ? `${outcome.name}: ` : ""}${outcome.message}`);
  if (ready.length === 0) throw new Error(failureNotes[0] ?? "The provider usage query failed.");
  if (ready.length === 1) {
    const report = ready[0].report;
    if (failureNotes.length === 0) return report;
    return { ...report, notes: [...new Set([...(report.notes ?? []), ...failureNotes])] };
  }
  const buckets: UsageBucket[] = [];
  const metrics: UsageMetric[] = [];
  for (const { name, report } of ready) {
    const prefix = name ? `${name}:` : "";
    const suffix = name ? ` · ${name}` : "";
    for (const bucket of report.buckets) {
      buckets.push({ ...bucket, id: `${prefix}${bucket.id}`, label: `${bucket.label}${suffix}` });
    }
    for (const metric of report.metrics) {
      metrics.push({ ...metric, id: `${prefix}${metric.id}`, label: `${metric.label}${suffix}` });
    }
  }
  const notes = [...new Set([...ready.flatMap(({ report }) => report.notes ?? []), ...failureNotes])];
  return {
    providerId: ready[0].report.providerId,
    providerName: ready[0].report.providerName,
    capturedAt: Date.now(),
    buckets,
    metrics,
    ...(ready.some(({ report }) => report.exhausted) ? { exhausted: true } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

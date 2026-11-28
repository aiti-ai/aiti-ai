import type { ProviderUsageId } from "@/lib/provider-usage-ids";
// Value import uses the relative path: @/lib is a Next-only alias (tsconfig paths),
// and this module is also loaded from node:test direct runs where it must resolve.
import { PROVIDER_USAGE_IDS } from "../provider-usage-ids.ts";
import type { UsageAdapter } from "./types.ts";

// Registry of usage adapters. Central code only resolves + executes; it never
// enumerates providers or hardcodes endpoints (adapters self-register at load).
// Besides the built-in static adapters, extensions may register dynamic ones at
// runtime via the host ctx (registerUsageAdapter; plan:
// pi-web-pi-session-provider-quota §4-B1/B2) — ownership is tracked per ext id
// so the shutdown cycle can remove exactly that extension's entries.

const adapters = new Map<ProviderUsageId, UsageAdapter>();

/** adapterId → owning extId for dynamically registered adapters (built-ins absent). */
const dynamicOwners = new Map<string, string>();

export function registerUsageAdapter(adapter: UsageAdapter): void {
  if (adapters.has(adapter.id)) {
    console.warn(`[provider-usage] duplicate adapter for ${adapter.id}; replacing previous registration`);
  }
  adapters.set(adapter.id, adapter);
  dynamicOwners.delete(adapter.id);
}

export interface DynamicUsageAdapterRegistration {
  ok: boolean;
  reason?: "invalid-adapter" | "builtin-conflict" | "owned-by-other-extension";
}

/** Minimal structural validation — the adapter arrives from extension code (any
 *  object at the type level), so the registry enforces the shape it relies on. */
function isValidUsageAdapter(adapter: unknown): adapter is UsageAdapter {
  if (!adapter || typeof adapter !== "object") return false;
  const a = adapter as Partial<UsageAdapter>;
  return typeof a.id === "string" && a.id.length > 0
    && Array.isArray(a.origins) && a.origins.length > 0 && a.origins.every((o) => typeof o === "string")
    && typeof a.displayName === "string"
    && typeof a.normalize === "function"
    && typeof a.query === "function";
}

/** Runtime registration slot for extensions (ctx.registerUsageAdapter). Conflict
 *  policy: built-in static ids are protected (never overwritten); a dynamic id
 *  can be re-registered by its owner (hot-reload idempotency) but never taken
 *  over by another extension (anti-hijack). */
export function registerDynamicUsageAdapter(extId: string, adapter: unknown): DynamicUsageAdapterRegistration {
  if (!isValidUsageAdapter(adapter)) return { ok: false, reason: "invalid-adapter" };
  if ((PROVIDER_USAGE_IDS as readonly string[]).includes(adapter.id)) return { ok: false, reason: "builtin-conflict" };
  const owner = dynamicOwners.get(adapter.id);
  if (owner !== undefined && owner !== extId) return { ok: false, reason: "owned-by-other-extension" };
  adapters.set(adapter.id as ProviderUsageId, adapter);
  dynamicOwners.set(adapter.id, extId);
  return { ok: true };
}

/** Remove one dynamic adapter owned by extId (ctx.unregisterUsageAdapter). Returns false when the id is not a dynamic entry of that extension. */
export function unregisterDynamicUsageAdapter(extId: string, id: string): boolean {
  if (dynamicOwners.get(id) !== extId) return false;
  adapters.delete(id as ProviderUsageId);
  dynamicOwners.delete(id);
  return true;
}

/** Remove every dynamic adapter owned by extId (shutdown cycle; mirrors unregisterImageProviders). */
export function unregisterDynamicUsageAdapters(extId: string): number {
  let removed = 0;
  for (const [id, owner] of [...dynamicOwners.entries()]) {
    if (owner !== extId) continue;
    adapters.delete(id as ProviderUsageId);
    dynamicOwners.delete(id);
    removed++;
  }
  return removed;
}

export interface UsageAdapterWithOwner {
  adapter: UsageAdapter;
  /** null = built-in static adapter; otherwise the owning extension id. */
  extId: string | null;
}

export function listUsageAdaptersWithOwners(): UsageAdapterWithOwner[] {
  return [...adapters.values()].map((adapter) => ({ adapter, extId: dynamicOwners.get(adapter.id) ?? null }));
}

export function getUsageAdapter(providerId: string, baseUrl?: string): UsageAdapter | undefined {
  const exact = adapters.get(providerId as ProviderUsageId);
  if (exact) return exact;
  if (!baseUrl) return undefined;
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
  const matches = [...adapters.values()].filter(
    (adapter) => !adapter.exactIdOnly && adapter.origins.includes(origin),
  );
  // Only match when the origin is unambiguous; shared origins (ark, opencode zen)
  // must never be guessed from a custom-aliased provider id.
  return matches.length === 1 ? matches[0] : undefined;
}

export function listUsageAdapters(): UsageAdapter[] {
  return [...adapters.values()];
}

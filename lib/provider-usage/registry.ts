import type { ProviderUsageId } from "@/lib/provider-usage-ids";
import type { UsageAdapter } from "./types";

// Registry of usage adapters. Central code only resolves + executes; it never
// enumerates providers or hardcodes endpoints (adapters self-register at load).

const adapters = new Map<ProviderUsageId, UsageAdapter>();

export function registerUsageAdapter(adapter: UsageAdapter): void {
  if (adapters.has(adapter.id)) {
    console.warn(`[provider-usage] duplicate adapter for ${adapter.id}; replacing previous registration`);
  }
  adapters.set(adapter.id, adapter);
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

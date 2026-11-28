import type { UsageAdapter } from "./types.ts";

// Host usage-adapter source (plan: pi-web-pi-session-provider-quota §4-B3b) —
// the extension entry caches the host's ctx.usageAdapters slot here at startup
// so the local catalog can (a) query third-party dynamic adapters registered by
// other extensions and (b) merge them into the overview. null = old host / slot
// absent; own-extension entries are filtered by ownership everywhere (they are
// already covered by the local static catalog).

export interface HostUsageAdapterEntry {
  adapter: UsageAdapter;
  extId: string | null;
}

export interface HostUsageAdapterSource {
  list(): HostUsageAdapterEntry[];
}

let source: HostUsageAdapterSource | null = null;

export function setHostUsageAdapterSource(next: HostUsageAdapterSource | null): void {
  source = next;
}

/** Third-party dynamic adapters only: hosted by another extension (our own entries and
 *  built-ins are excluded — the local registry already covers them). */
export function listThirdPartyUsageAdapters(): UsageAdapter[] {
  const entries = source?.list() ?? [];
  const out: UsageAdapter[] = [];
  for (const entry of entries) {
    if (entry.extId === null || entry.extId === "aiti-provider-usage") continue;
    out.push(entry.adapter);
  }
  return out;
}

/** Resolve an adapter for providerId: local registry first (exact/origin match),
 *  then a third-party dynamic adapter from the host slot (exact id only). */
export function resolveUsageAdapter(providerId: string, baseUrl?: string): UsageAdapter | undefined {
  return getLocalOrHostAdapter(providerId, baseUrl);
}

import { getUsageAdapter } from "./registry.ts";

function getLocalOrHostAdapter(providerId: string, baseUrl?: string): UsageAdapter | undefined {
  const local = getUsageAdapter(providerId, baseUrl);
  if (local) return local;
  for (const adapter of listThirdPartyUsageAdapters()) {
    if (adapter.id === providerId) return adapter;
  }
  return undefined;
}

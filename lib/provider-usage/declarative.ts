import type { ProviderUsageId } from "@/lib/provider-usage-ids";
import { registerUsageAdapter } from "./registry";
import { buildAuthHeaders, fetchOfficialJson } from "./secure-fetch";
import type { UsageAdapter, UsageAuth, UsageNormalizer } from "./types";

// Factory for JSON-endpoint usage adapters: shared hardened fetch, per-provider
// URL/auth/normalize. Adding a simple balance provider = one declaration row.

export interface JsonAdapterSpec {
  id: ProviderUsageId;
  displayName: string;
  origins: string[];
  exactIdOnly?: boolean;
  /** Extra static headers, e.g. raw-key auth styles that must not use Bearer. */
  headers?: (auth: UsageAuth) => Record<string, string> | undefined;
  url: (auth: UsageAuth) => string;
  /** Extra endpoints tried in order when the primary fails (HTTP/network/normalize). */
  fallbackUrls?: (auth: UsageAuth) => string[];
  normalize: UsageNormalizer;
}

export function createJsonAdapter(spec: JsonAdapterSpec): UsageAdapter {
  return {
    id: spec.id,
    displayName: spec.displayName,
    origins: spec.origins,
    ...(spec.exactIdOnly ? { exactIdOnly: true } : {}),
    normalize: spec.normalize,
    async query(ctx) {
      const headers = buildAuthHeaders(ctx.auth, spec.headers?.(ctx.auth));
      const urls = [spec.url(ctx.auth), ...(spec.fallbackUrls?.(ctx.auth) ?? [])];
      let lastError: unknown;
      for (const url of urls) {
        try {
          const payload = await fetchOfficialJson(spec.origins, url, headers);
          return spec.normalize(payload, ctx);
        } catch (caught) {
          lastError = caught;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("The provider usage query failed.");
    },
  };
}

export function registerJsonAdapter(spec: JsonAdapterSpec): void {
  registerUsageAdapter(createJsonAdapter(spec));
}

/** Raw-key auth style (Authorization: <key>, no Bearer prefix). */
export function rawKeyHeader(auth: UsageAuth): Record<string, string> | undefined {
  if (auth.apiKey) return { Authorization: auth.apiKey };
  return undefined;
}

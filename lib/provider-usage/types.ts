import type { ProviderUsageId } from "@/lib/provider-usage-ids";

// Shared server/client data model for provider usage/quota reports.
// Query formats follow @narumitw/pi-usage (MIT, Copyright (c) 2026 narumiruna),
// but this module deliberately has no runtime dependency on that extension.

export type UsageUnit = "percent" | "currency" | "count";

/** Window state reported by the provider (OpenCode rate-limited, Z.AI used-up, …). */
export type UsageBucketState = "ok" | "rate-limited" | "exhausted";

export interface UsageBucket {
  id: string;
  label: string;
  /** Model name / plan bucket name — render layer groups by this (multi-window providers). */
  groupLabel?: string;
  used?: number;
  remaining?: number;
  limit?: number;
  unit: UsageUnit;
  currency?: string;
  windowMinutes?: number;
  resetsAt?: number;
  period?: string;
  status?: UsageBucketState;
}

export interface UsageMetric {
  id: string;
  label: string;
  value: number | string;
  unit?: UsageUnit;
  currency?: string;
  groupLabel?: string;
}

export interface UsageReport {
  providerId: ProviderUsageId;
  providerName: string;
  capturedAt: number;
  buckets: UsageBucket[];
  metrics: UsageMetric[];
  notes?: string[];
  /** True when a window/limit currently blocks usage (used up or rate limited). */
  exhausted?: boolean;
}

export type ProviderUsageStatus = "ready" | "unsupported" | "auth-unavailable" | "query-failed";

export type ProviderUsageResult =
  | { providerId: ProviderUsageId; status: "ready"; report: UsageReport }
  | { providerId: ProviderUsageId; status: ProviderUsageStatus; message: string };

/** Resolved credentials for one query (shape of ModelRuntime.getAuth()). */
export interface UsageAuth {
  apiKey?: string;
  headers?: Record<string, string | null>;
  baseUrl?: string;
}

export interface UsageQueryContext {
  providerId: ProviderUsageId;
  auth: UsageAuth;
}

/** One provider family adapter. Register at module load via registerUsageAdapter(). */
export interface UsageAdapter {
  id: ProviderUsageId;
  displayName: string;
  /** Official origins credentials may be sent to; any other origin is refused. */
  origins: string[];
  /** Origin match may not be used as a fallback for custom-aliased providers (shared origins). */
  exactIdOnly?: boolean;
  query(ctx: UsageQueryContext): Promise<UsageReport>;
  /** Payload normalizer, exposed for tests/re-normalization (no network). */
  normalize?: (payload: Record<string, unknown>, ctx: UsageQueryContext) => UsageReport;
}

/** Payload normalizer signature shared by adapters and the declarative factory. */
export type UsageNormalizer = (payload: Record<string, unknown>, ctx: UsageQueryContext) => UsageReport;

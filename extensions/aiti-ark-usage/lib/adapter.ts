/**
 * adapter — the ark-plan usage adapter (UsageAdapter shape, registered into the
 * host registry via ctx.usageAdapters.register at startup).
 *
 * Query chain: signed control-plane actions GetCodingPlanUsage (Coding Plan,
 * percent windows) → GetAFPUsage (Agent Plan, absolute AFP windows). A account
 * typically subscribes to exactly one; "auto" tries Coding first and falls
 * back to Agent (both are read-only). AK/SK comes from the extension config —
 * the models.json API key cannot query plan quota (research 2026-11-28).
 *
 * Window labels are canonicalized to the stable names the host's three quota
 * UIs already map (5h → five_hour, 1w → weekly, 1mo → monthly_credits, see
 * lib/session/provider-quota-convert.ts NAME_PATTERNS).
 */

import { fetchArkResult, ArkApiError } from "./ark-api.ts";
import { isConfigured, readConfig, type ArkUsageConfig } from "./config.ts";
import { OPENAPI_HOST } from "./sigv4.ts";

export const ARK_DISPLAY_NAME = "Volcano Ark Plan";

/** UsageAdapter-shaped object as the host registry sees it (structural typing;
 *  extensions cannot import host types across the jiti boundary). */
export interface AdapterLike {
  id: string;
  displayName: string;
  origins: string[];
  exactIdOnly: boolean;
  query(ctx: ArkQueryContext): Promise<ArkReport>;
  normalize(payload: Record<string, unknown>, ctx: ArkQueryContext): ArkReport;
}

export interface ArkQueryContext {
  providerId: string;
  auth: Record<string, unknown>;
}

export interface ArkBucket {
  id: string;
  label: string;
  used?: number;
  remaining?: number;
  limit?: number;
  unit: "percent" | "count";
  resetsAt?: number;
  status?: "ok" | "exhausted";
}

export interface ArkReport {
  providerId: string;
  providerName: string;
  capturedAt: number;
  buckets: ArkBucket[];
  metrics: Array<{ id: string; label: string; value: number | string }>;
  notes?: string[];
  exhausted?: boolean;
}

const CANONICAL_ORDER = ["5h", "1d", "1w", "1mo"];

/** Map any provider spelling of a window onto the canonical labels the quota
 *  UIs recognize ("5h"/"five hour"/"session" → 5h, daily → 1d, week/1w/7d → 1w, …). */
export function canonicalWindowLabel(raw: unknown): string {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return "window";
  if (/5\s*h|five[_\s-]?hour|session/.test(value)) return "5h";
  if (/1\s*d\b|daily/.test(value)) return "1d";
  if (/1\s*w\b|weekly?|7\s*d/.test(value)) return "1w";
  if (/1\s*mo\b|monthly?|30\s*d/.test(value)) return "1mo";
  return String(raw).trim();
}

function labelRank(label: string): number {
  const index = CANONICAL_ORDER.indexOf(label);
  return index === -1 ? CANONICAL_ORDER.length : index;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Gateway timestamps are unix seconds (sometimes already ms); normalize to seconds.
 *  ms/s threshold 1e11 aligned with the dsh-ark-quota reference implementation. */
function toEpochSeconds(value: unknown): number | undefined {
  const n = num(value);
  if (n === undefined || n <= 0) return undefined;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

interface WindowRow {
  label: string;
  usedPercent?: number;
  used?: number;
  total?: number;
  resetsAt?: number;
}

/** Coding Plan shape: `Result.QuotaUsage[]` rows with percent (+ optional absolutes). */
function parseCodingWindows(result: Record<string, unknown>): WindowRow[] {
  const rows = result.QuotaUsage ?? result.Usages ?? result.Details;
  if (!Array.isArray(rows)) return [];
  const out: WindowRow[] = [];
  for (const rowValue of rows) {
    if (typeof rowValue !== "object" || rowValue === null) continue;
    const row = rowValue as Record<string, unknown>;
    const rawLabel = row.Level ?? row.Type ?? row.Period;
    if (rawLabel === undefined || rawLabel === null || rawLabel === "") continue;
    const percent = num(row.Percent ?? row.UsedPercent ?? row.UsagePercent);
    if (percent === undefined) continue;
    out.push({
      label: canonicalWindowLabel(rawLabel),
      usedPercent: clampPercent(percent),
      used: num(row.Used ?? row.UsedCount ?? row.Consumed),
      total: num(row.Total ?? row.Quota ?? row.Limit ?? row.TotalCount),
      resetsAt: toEpochSeconds(row.ResetTime ?? row.ResetTimestamp),
    });
  }
  return out;
}

/** Agent Plan shape: `Result.{AFPFiveHour, AFPDaily, AFPWeekly, AFPMonthly}` absolute windows.
 *  AFPDaily observed in live responses (2026-11-28) — the dsh-ark-quota reference predates it. */
const AFP_WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ["AFPFiveHour", "5h"],
  ["AFPDaily", "1d"],
  ["AFPWeekly", "1w"],
  ["AFPMonthly", "1mo"],
];

function parseAgentWindows(result: Record<string, unknown>): WindowRow[] {
  const out: WindowRow[] = [];
  for (const [key, label] of AFP_WINDOWS) {
    const win = result[key];
    if (typeof win !== "object" || win === null) continue;
    const window = win as Record<string, unknown>;
    const quota = num(window.Quota);
    if (quota === undefined || quota <= 0) continue;
    const used = num(window.Used) ?? 0;
    out.push({
      label,
      usedPercent: clampPercent((used / quota) * 100),
      used,
      total: quota,
      resetsAt: toEpochSeconds(window.ResetTime),
    });
  }
  return out;
}

/** Is this payload's Result a Coding Plan response? (present + parseable rows) */
function looksLikeCodingPlan(result: Record<string, unknown>): boolean {
  const rows = result.QuotaUsage ?? result.Usages ?? result.Details;
  return Array.isArray(rows);
}

/** Build the UsageReport from one plan's window rows (empty rows → null). */
function reportFromWindows(rows: WindowRow[], ctx: ArkQueryContext, planKind: "Coding Plan" | "Agent Plan", result: Record<string, unknown>): ArkReport | null {
  if (rows.length === 0) return null;
  const ordered = [...rows].sort((a, b) => labelRank(a.label) - labelRank(b.label));
  const buckets: ArkBucket[] = [];
  const seen = new Map<string, number>();
  let exhausted = false;
  for (const row of ordered) {
    const n = (seen.get(row.label) ?? 0) + 1;
    seen.set(row.label, n);
    const id = n === 1 ? row.label : `${row.label}-${n}`;
    const resets = row.resetsAt ? { resetsAt: row.resetsAt } : {};
    // Absolute allowance when the payload carries real totals (Agent Plan always;
    // Coding Plan optionally) — keeps the true limit visible in the quota UIs.
    // Share-of-window otherwise (Coding Plan's primary signal is the percent).
    if (row.total !== undefined && row.total > 0 && row.used !== undefined) {
      const remaining = Math.max(0, row.total - row.used);
      buckets.push({
        id,
        label: row.label,
        used: row.used,
        remaining,
        limit: row.total,
        unit: "count",
        ...resets,
        ...(remaining <= 0 ? { status: "exhausted" as const } : {}),
      });
      if (remaining <= 0) exhausted = true;
      continue;
    }
    if (row.usedPercent === undefined) continue;
    buckets.push({
      id,
      label: row.label,
      used: Math.round(row.usedPercent * 100) / 100,
      remaining: Math.round((100 - row.usedPercent) * 100) / 100,
      limit: 100,
      unit: "percent",
      ...resets,
      ...(row.usedPercent >= 100 ? { status: "exhausted" as const } : {}),
    });
    if (row.usedPercent >= 100) exhausted = true;
  }
  const metrics: ArkReport["metrics"] = [{ id: "plan", label: "Plan", value: planKind }];
  if (result.HasReward === true) metrics.push({ id: "reward", label: "Reward quota", value: "included" });
  const status = typeof result.Status === "string" && result.Status && result.Status !== "ok"
    ? result.Status
    : undefined;
  if (status) metrics.push({ id: "status", label: "Status", value: status });
  return {
    providerId: ctx.providerId,
    providerName: ARK_DISPLAY_NAME,
    capturedAt: Date.now(),
    buckets,
    metrics,
    ...(exhausted ? { exhausted: true } : {}),
  };
}

/**
 * Normalize one gateway response envelope into a UsageReport (no network).
 * Detects the plan shape from the Result: a QuotaUsage-style array reads as
 * Coding Plan; the AFP window objects read as Agent Plan. An unusable Result
 * (no windows) throws — callers surface query-failed (fail-honest).
 */
export function normalizeArkPlanPayload(payload: Record<string, unknown>, ctx: ArkQueryContext): ArkReport {
  const result = typeof payload.Result === "object" && payload.Result !== null && !Array.isArray(payload.Result)
    ? payload.Result as Record<string, unknown>
    : payload;
  const coding = looksLikeCodingPlan(result);
  const rows = coding ? parseCodingWindows(result) : parseAgentWindows(result);
  const report = reportFromWindows(rows, ctx, coding ? "Coding Plan" : "Agent Plan", result);
  if (!report) throw new ArkApiError("Volcano Ark returned no plan quota windows (no Coding/Agent Plan subscription for this account?).");
  return report;
}

function isAuthErrorCode(code: string | undefined): boolean {
  // Broad auth-shaped matching, aligned with the dsh-ark-quota reference and
  // extended with `accesskey` (the live gateway emits InvalidAccessKey for
  // unknown keys): auth errors are terminal (wrong keys never fix themselves
  // by retrying the other plan API).
  return /auth|signature|accessdenied|accesskey|denied|unauthorized|forbidden|credential|token/.test(String(code ?? "").toLowerCase());
}

/** Auth-shaped failures hard-stop the plan fallback (code match or HTTP 401/403). */
export function isAuthHardStop(error: unknown): boolean {
  if (!(error instanceof ArkApiError)) return false;
  if (error.status === 401 || error.status === 403) return true;
  return isAuthErrorCode(error.code);
}

/**
 * Create the adapter for one provider id (default ark-plan — same-name direct
 * match with the pi provider id in models.json; exactIdOnly since the quota
 * gateway origin can never be a data-plane baseUrl origin).
 */
export function createArkPlanAdapter(configDir: string, providerId = "ark-plan"): AdapterLike {
  return {
    id: providerId,
    displayName: ARK_DISPLAY_NAME,
    origins: [`https://${OPENAPI_HOST}`],
    exactIdOnly: true,
    normalize: normalizeArkPlanPayload,
    async query(ctx) {
      const cfg: ArkUsageConfig = readConfig(configDir);
      if (!isConfigured(cfg)) {
        throw new ArkApiError(
          "Volcano Ark AK/SK is not configured for aiti-ark-usage — set accessKeyId/secretAccessKey in the extension config (see the setup skill). The models.json API key cannot query plan quota.",
        );
      }
      const gateway = {
        accessKeyId: cfg.accessKeyId!,
        secretAccessKey: cfg.secretAccessKey!,
        ...(cfg.region ? { region: cfg.region } : {}),
        ...(cfg.gatewayHost ? { gatewayHost: cfg.gatewayHost } : {}),
      };
      const product = cfg.product ?? "auto";
      let lastError: unknown;
      let codingStatus: string | undefined;
      let agentPlanType: string | undefined;
      const attempt = async (action: string, kind: "Coding Plan" | "Agent Plan"): Promise<{ report: ArkReport | null; result: Record<string, unknown> }> => {
        const result = await fetchArkResult({ ...gateway, action });
        const coding = kind === "Coding Plan";
        const rows = coding ? parseCodingWindows(result) : parseAgentWindows(result);
        return { report: reportFromWindows(rows, ctx, kind, result), result };
      };
      // Auth failures are terminal (wrong keys never fix themselves on retry
      // with the other plan API) — rethrow immediately.
      try {
        if (product !== "agent") {
          const { report, result } = await attempt("GetCodingPlanUsage", "Coding Plan");
          if (report) return report;
          codingStatus = typeof result.Status === "string" && result.Status ? result.Status : undefined;
          if (product === "coding") throw new ArkApiError("Volcano Ark returned no Coding Plan quota windows" + (codingStatus ? ` (status: ${codingStatus})` : "") + ".");
        }
      } catch (caught) {
        if (product === "coding" || isAuthHardStop(caught)) throw caught;
        lastError = caught;
      }
      try {
        if (product !== "coding") {
          const { report, result } = await attempt("GetAFPUsage", "Agent Plan");
          if (report) return report;
          agentPlanType = typeof result.PlanType === "string" && result.PlanType ? result.PlanType : undefined;
          if (product === "agent") throw new ArkApiError("Volcano Ark returned no Agent Plan quota windows (no subscription for this account).");
        }
      } catch (caught) {
        if (product === "agent" || isAuthHardStop(caught)) throw caught;
        lastError = caught;
      }
      if (lastError instanceof Error) throw lastError;
      throw new ArkApiError(
        "Volcano Ark returned no plan quota windows"
        + (codingStatus ? ` (Coding Plan status: ${codingStatus}` : " (Coding Plan: no subscription")
        + `; Agent Plan: ${agentPlanType ? `type ${agentPlanType} quota empty` : "no subscription"}).`,
      );
    },
  };
}

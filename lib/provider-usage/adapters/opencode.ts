import { registerJsonAdapter } from "../declarative.ts";
import { clamp, epochSeconds, nonnegative, record } from "../helpers.ts";
import type { UsageBucket, UsageBucketState, UsageReport } from "../types.ts";

// OpenCode Go plan windows (rolling/weekly/monthly): {status, percent, resetsAt}.
// `/zen/go/v1/usage` is the only usage endpoint OpenCode exposes to API keys
// (it reports the Go plan; 403 EntitlementError without a Go subscription).
// Zen (pay-per-use balance) has no API at all — its balance lives in the web
// console behind a login session — so `opencode` / `opencode-zen` ids are
// deliberately NOT adapted: no row beats attributing Go-plan windows to a Zen
// provider. Only `opencode-go` is registered, exact-id (shared origin).

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const WINDOW_LABELS: Record<string, string> = { rolling: "Rolling", weekly: "Weekly", monthly: "Monthly" };
const DISPLAY_NAME = "OpenCode Go";

registerJsonAdapter({
  id: "opencode-go",
  displayName: DISPLAY_NAME,
  origins: ["https://opencode.ai"],
  exactIdOnly: true,
  url: () => USAGE_URL,
  normalize: (payload, ctx) => normalizeOpenCode(payload, ctx, DISPLAY_NAME),
});

function normalizeOpenCode(payload: Record<string, unknown>, ctx: { providerId: UsageReport["providerId"] }, name: string): UsageReport {
  const usage = record(payload.usage) ?? record(record(payload.data)?.usage) ?? payload;
  const buckets: UsageBucket[] = [];
  for (const [key, rowValue] of Object.entries(usage)) {
    const row = record(rowValue);
    if (!row) continue;
    const label = WINDOW_LABELS[key] ?? key.replace(/_/g, " ");
    const usedPercent = nonnegative(row.percent ?? row.used_percent ?? row.percent_used ?? row.percentage);
    const used = nonnegative(row.used ?? row.current_value);
    const limit = nonnegative(row.limit ?? row.total);
    const remaining = nonnegative(row.remaining);
    const resetsAt = epochSeconds(row.resetsAt ?? row.resets_at ?? row.reset_at);
    const rawStatus = typeof row.status === "string" ? row.status : undefined;
    let status: UsageBucketState = "ok";
    if (rawStatus === "rate-limited") status = "rate-limited";
    else if (usedPercent !== undefined && usedPercent >= 100) status = "exhausted";
    if (limit !== undefined && limit > 0) {
      buckets.push({
        id: `window-${key}`,
        label,
        ...(used !== undefined ? { used } : {}),
        ...(remaining !== undefined ? { remaining } : used !== undefined ? { remaining: Math.max(0, limit - used) } : {}),
        limit,
        unit: "count",
        status,
        ...(resetsAt ? { resetsAt } : {}),
      });
      continue;
    }
    if (usedPercent === undefined) continue;
    buckets.push({
      id: `window-${key}`,
      label,
      used: clamp(usedPercent),
      remaining: 100 - clamp(usedPercent),
      limit: 100,
      unit: "percent",
      status,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  if (!buckets.length) throw new Error("OpenCode Go returned no usage data.");
  const exhausted = buckets.some((bucket) => bucket.status === "rate-limited" || bucket.status === "exhausted");
  return {
    providerId: ctx.providerId,
    providerName: name,
    capturedAt: Date.now(),
    buckets,
    metrics: [],
    ...(exhausted ? { exhausted: true, notes: ["Any window at its limit blocks requests."] } : {}),
  };
}

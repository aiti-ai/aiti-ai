import { registerJsonAdapter } from "../declarative";
import { clamp, epochSeconds, nonnegative, record } from "../helpers";
import type { UsageBucket, UsageBucketState, UsageReport } from "../types";

// OpenCode plan windows (rolling/weekly/monthly): {status, percent, resetsAt}.
// One endpoint serves opencode / opencode-go / opencode-zen — which plan a key
// can see is decided by its subscription (403 EntitlementError otherwise).
// All three ids are registered; the shared origin is exact-id only.
// NOTE: this endpoint is the OpenCode **Go** plan quota API (without a Go
// subscription it answers 403). Zen is a different product with no public usage
// endpoint, so a Zen id that has a Go-entitled key will report Go-plan windows
// under its own name; the OpenCode Go provider stays the canonical row.

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const WINDOW_LABELS: Record<string, string> = { rolling: "Rolling", weekly: "Weekly", monthly: "Monthly" };

for (const [id, name] of [
  ["opencode", "OpenCode Zen"],
  ["opencode-go", "OpenCode Go"],
  ["opencode-zen", "OpenCode Zen"],
] as const) {
  registerJsonAdapter({
    id,
    displayName: name,
    origins: ["https://opencode.ai"],
    exactIdOnly: true,
    url: () => USAGE_URL,
    normalize: (payload, ctx) => normalizeOpenCode(payload, ctx, name),
  });
}

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
  if (!buckets.length) throw new Error("OpenCode returned no usage data.");
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

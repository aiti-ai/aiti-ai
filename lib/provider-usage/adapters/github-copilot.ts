import { registerJsonAdapter } from "../declarative";
import { nonnegative, record, stringValue } from "../helpers";
import type { UsageBucket, UsageReport } from "../types";

// GitHub Copilot (OAuth credentials): quota snapshots per feature
// (chat / premium_interactions / completions) with entitlement + remaining.

registerJsonAdapter({
  id: "github-copilot",
  displayName: "GitHub Copilot",
  origins: ["https://api.github.com"],
  url: () => "https://api.github.com/copilot_internal/user",
  normalize: (payload, ctx) => {
    const snapshots = record(payload.quota_snapshots);
    if (!snapshots) throw new Error("Copilot returned no quota snapshots.");
    const buckets: UsageBucket[] = [];
    const reset = stringValue(payload.quota_reset_date);
    for (const [key, rowValue] of Object.entries(snapshots)) {
      const row = record(rowValue);
      if (!row || row.unlimited === true) continue;
      const entitlement = nonnegative(row.entitlement);
      const remaining = nonnegative(row.remaining);
      if (entitlement === undefined || entitlement === 0) continue;
      const used = remaining !== undefined ? entitlement - remaining : undefined;
      buckets.push({
        id: `quota-${key}`,
        label: key.replace(/_/g, " "),
        ...(used !== undefined ? { used } : {}),
        ...(remaining !== undefined ? { remaining } : {}),
        limit: entitlement,
        unit: "count",
        ...(reset ? { period: `resets ${reset}` } : {}),
      });
    }
    const metrics: UsageReport["metrics"] = [];
    const plan = stringValue(payload.copilot_plan);
    if (plan) metrics.push({ id: "plan", label: "Plan", value: plan });
    if (!buckets.length && !metrics.length) throw new Error("Copilot returned no quota data.");
    return { providerId: ctx.providerId, providerName: "GitHub Copilot", capturedAt: Date.now(), buckets, metrics };
  },
});

import { registerJsonAdapter } from "../declarative";
import { nonnegative, record } from "../helpers";
import type { UsageBucket, UsageReport } from "../types";

// OpenCode Zen Go plan: rolling/weekly/monthly windows. Requires an explicit
// User-Agent (Cloudflare blocks the default; set in secure-fetch). Without a
// subscription the endpoint returns 403 — surfaced as a business error.

registerJsonAdapter({
  id: "opencode-go",
  displayName: "OpenCode Go",
  origins: ["https://opencode.ai"],
  // opencode-zen (custom /zen/v1) shares this origin — exact-id match only.
  exactIdOnly: true,
  url: () => "https://opencode.ai/zen/go/v1/usage",
  normalize: (payload, ctx) => {
    const buckets: UsageBucket[] = [];
    const roots = [record(payload.usage) ?? payload, record(payload.data) ?? payload];
    for (const root of roots) {
      for (const [key, rowValue] of Object.entries(root)) {
        const row = record(rowValue);
        if (!row) continue;
        const usedPercent = nonnegative(row.used_percent ?? row.percent_used ?? row.percentage);
        const used = nonnegative(row.used ?? row.current_value);
        const limit = nonnegative(row.limit ?? row.total);
        const remaining = nonnegative(row.remaining);
        if (usedPercent === undefined && limit === undefined) continue;
        if (limit !== undefined && limit > 0) {
          buckets.push({
            id: `window-${key}`,
            label: key.replace(/_/g, " "),
            ...(used !== undefined ? { used } : {}),
            ...(remaining !== undefined ? { remaining } : limit !== undefined && used !== undefined ? { remaining: limit - used } : {}),
            limit,
            unit: "count",
          });
          continue;
        }
        buckets.push({ id: `window-${key}`, label: key.replace(/_/g, " "), used: usedPercent!, remaining: 100 - usedPercent!, limit: 100, unit: "percent" });
      }
      if (buckets.length) break;
    }
    if (!buckets.length) throw new Error("OpenCode Go returned no usage data.");
    return { providerId: ctx.providerId, providerName: "OpenCode Go", capturedAt: Date.now(), buckets, metrics: [] };
  },
});

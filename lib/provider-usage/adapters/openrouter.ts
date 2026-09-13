import { registerJsonAdapter } from "../declarative";
import { nonnegative, record, stringValue } from "../helpers";
import type { UsageReport } from "../types";

registerJsonAdapter({
  id: "openrouter",
  displayName: "OpenRouter",
  origins: ["https://openrouter.ai"],
  url: () => "https://openrouter.ai/api/v1/key",
  normalize: (payload, ctx) => {
    const data = record(payload.data);
    if (!data) throw new Error("OpenRouter returned no key data.");
    const buckets: UsageReport["buckets"] = [];
    const limit = nonnegative(data.limit);
    const remaining = nonnegative(data.limit_remaining);
    if (limit !== undefined) {
      buckets.push({
        id: "key-limit",
        label: "Key limit",
        limit,
        ...(remaining !== undefined ? { remaining, used: Math.max(0, limit - remaining) } : {}),
        unit: "currency",
        currency: "USD",
        ...(stringValue(data.limit_reset) ? { period: stringValue(data.limit_reset) } : {}),
      });
    }
    const metrics: UsageReport["metrics"] = [];
    for (const [id, label, field] of [
      ["daily", "Usage today", "usage_daily"],
      ["weekly", "Usage this week", "usage_weekly"],
      ["monthly", "Usage this month", "usage_monthly"],
      ["total", "All-time usage", "usage"],
    ] as const) {
      const amount = nonnegative(data[field]);
      if (amount !== undefined) metrics.push({ id, label, value: amount, unit: "currency", currency: "USD" });
    }
    if (!buckets.length && !metrics.length) throw new Error("OpenRouter returned no usage data.");
    return { providerId: ctx.providerId, providerName: "OpenRouter", capturedAt: Date.now(), buckets, metrics };
  },
});

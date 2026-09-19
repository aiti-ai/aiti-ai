import { registerJsonAdapter } from "../declarative";
import { nonnegative, number, record } from "../helpers";
import type { UsageBucket, UsageReport } from "../types";

// Kimi Coding plan: usage windows (5h/daily/weekly) + booster wallet.
// Wire shape not fixture-pinned; normalizer is tolerant and fails soft.

registerJsonAdapter({
  id: "kimi-coding",
  displayName: "Kimi Coding",
  origins: ["https://api.kimi.com"],
  url: () => "https://api.kimi.com/coding/v1/usages",
  normalize: (payload, ctx) => {
    const buckets: UsageBucket[] = [];
    const sources: unknown[] = [
      payload.usage,
      payload.usages,
      ...(Array.isArray(payload.windows) ? payload.windows : []),
      ...(record(payload.data)?.usage !== undefined ? [record(payload.data)!.usage] : []),
    ];
    for (const source of sources) {
      const row = record(source);
      if (!row) continue;
      for (const [key, rowValue] of Object.entries(row)) {
        const window = record(rowValue);
        if (!window) continue;
        const used = nonnegative(window.used_percent ?? window.percent_used ?? window.usage_percent);
        const remaining = nonnegative(window.remaining_percent ?? window.percent_remaining);
        const resetsAt = number(window.reset_at ?? window.reset_time) !== undefined ? Math.floor(number(window.reset_at ?? window.reset_time)! / 1000) : undefined;
        if (used === undefined && remaining === undefined) continue;
        buckets.push({
          id: `window-${key}`,
          label: key.replace(/_/g, " "),
          ...(used !== undefined ? { used } : {}),
          ...(remaining !== undefined ? { remaining } : { remaining: 100 - (used ?? 0) }),
          limit: 100,
          unit: "percent",
          ...(resetsAt ? { resetsAt } : {}),
        });
      }
    }
    const metrics: UsageReport["metrics"] = [];
    const wallet = record(payload.booster_wallet) ?? record(record(payload.data)?.booster_wallet);
    if (wallet) {
      const balance = nonnegative(wallet.balance ?? wallet.remaining);
      if (balance !== undefined) metrics.push({ id: "booster", label: "Booster wallet", value: String(balance), unit: "currency", currency: "USD" });
    }
    if (!buckets.length && !metrics.length) throw new Error("Kimi Coding returned no usage data.");
    return { providerId: ctx.providerId, providerName: "Kimi Coding", capturedAt: Date.now(), buckets, metrics };
  },
});

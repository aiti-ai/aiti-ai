import { registerJsonAdapter } from "../declarative.ts";
import { nonnegative, record, stringValue } from "../helpers.ts";
import type { UsageBucket, UsageReport } from "../types.ts";

// OpenRouter: /credits carries the account balance (total credits − usage);
// /key carries key limits + rolling spend windows. Primary /credits, fallback
// /key (management keys may not answer /credits the same way).

const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const KEY_URL = "https://openrouter.ai/api/v1/key";

function money(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

registerJsonAdapter({
  id: "openrouter",
  displayName: "OpenRouter",
  origins: ["https://openrouter.ai"],
  url: () => CREDITS_URL,
  fallbackUrls: () => [KEY_URL],
  normalize: (payload, ctx) => {
    const data = record(payload.data);
    if (!data) throw new Error("OpenRouter returned no key data.");
    const buckets: UsageBucket[] = [];
    const metrics: UsageReport["metrics"] = [];

    // —— /credits: account-level balance (only when the balance field is present) ——
    const totalCredits = nonnegative(data.total_credits);
    if (totalCredits !== undefined) {
      const usage = nonnegative(data.total_usage) ?? 0;
      const remaining = totalCredits - usage;
      const overdrawn = remaining < 0;
      buckets.push({
        id: "credits",
        label: "Account balance",
        used: usage,
        remaining,
        limit: totalCredits,
        unit: "currency",
        currency: "USD",
        status: overdrawn ? "exhausted" : "ok",
      });
      metrics.push({ id: "topped-up", label: "Top-up", value: money(totalCredits), unit: "currency", currency: "USD" });
      metrics.push({ id: "spent", label: "Used", value: money(usage), unit: "currency", currency: "USD" });
      return {
        providerId: ctx.providerId,
        providerName: "OpenRouter",
        capturedAt: Date.now(),
        buckets,
        metrics,
        exhausted: overdrawn,
      };
    }

    // —— /key fallback: key limit + rolling spend windows ——
    const limit = nonnegative(data.limit);
    const remaining = nonnegative(data.limit_remaining);
    const freeTier = data.is_free_tier === true || (limit === 0 && nonnegative(data.credits) === 0);
    if (freeTier) {
      metrics.push({ id: "tier", label: "Tier", value: "Free · pay-as-you-go" });
    } else if (limit !== undefined && limit > 0) {
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

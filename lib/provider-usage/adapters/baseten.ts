import { registerJsonAdapter } from "../declarative";
import { nonnegative, record } from "../helpers";
import type { UsageReport } from "../types";

// Baseten billing: rated spend for a window (30 days). Money in cents.

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

registerJsonAdapter({
  id: "baseten",
  displayName: "Baseten",
  origins: ["https://api.baseten.co"],
  url: () => `https://api.baseten.co/v1/billing/usage_summary?start_date=${isoDaysAgo(30)}&end_date=${isoDaysAgo(0)}`,
  normalize: (payload, ctx) => {
    const totalCents = nonnegative(payload.total_rated_usage_cents)
      ?? nonnegative(record(payload.summary)?.total_rated_usage_cents)
      ?? nonnegative(payload.total_usage_cents);
    if (totalCents === undefined) throw new Error("Baseten returned no usage summary.");
    const metrics: UsageReport["metrics"] = [
      { id: "spend-30d", label: "Rated spend (30d)", value: (totalCents / 100).toFixed(2), unit: "currency", currency: "USD" },
    ];
    const rows = Array.isArray(payload.usage) ? payload.usage : [];
    for (const [index, rowValue] of rows.entries()) {
      const row = record(rowValue);
      const cents = nonnegative(row?.rated_usage_cents ?? row?.total_rated_usage_cents);
      const model = typeof row?.model_id === "string" ? row.model_id : undefined;
      if (cents === undefined || !model) continue;
      if (index >= 8) break;
      metrics.push({ id: `model-${model}`, label: model, value: (cents / 100).toFixed(2), unit: "currency", currency: "USD" });
    }
    return { providerId: ctx.providerId, providerName: "Baseten", capturedAt: Date.now(), buckets: [], metrics };
  },
});

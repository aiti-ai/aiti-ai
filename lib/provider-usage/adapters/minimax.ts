import { registerJsonAdapter } from "../declarative";
import { nonnegative, nonnegativeInteger, number, record } from "../helpers";
import type { UsageBucket, UsageReport } from "../types";

// MiniMax: sk-api- keys use the account balance endpoint, other keys the
// token-plan remains endpoint (per-model windows).

for (const [id, origin, currency, name] of [
  ["minimax", "https://api.minimax.io", "USD", "MiniMax"],
  ["minimax-cn", "https://api.minimaxi.com", "CNY", "MiniMax CN"],
] as const) {
  registerJsonAdapter({
    id,
    displayName: name,
    origins: [origin],
    url: (auth) => (auth.apiKey?.startsWith("sk-api-") ? `${origin}/account/query_balance` : `${origin}/v1/token_plan/remains`),
    normalize: (payload, ctx) => normalizeMiniMax(payload, ctx, currency, name),
  });
}

function normalizeMiniMax(payload: Record<string, unknown>, ctx: { providerId: UsageReport["providerId"] }, currency: string, name: string): UsageReport {
  const base = record(payload.base_resp);
  if (base && base.status_code !== 0) throw new Error("MiniMax returned an unsuccessful response.");
  const capturedAt = Date.now();
  if (Array.isArray(payload.model_remains)) {
    const buckets: UsageBucket[] = [];
    for (const [index, rowValue] of payload.model_remains.entries()) {
      const row = record(rowValue);
      if (!row) continue;
      const groupLabel = groupLabelOf(row.model_name) ?? `Quota ${index + 1}`;
      addWindow(buckets, row, groupLabel, "interval", "current_interval_remaining_percent", "current_interval_usage_count", "current_interval_total_count", "end_time", "start_time");
      addWindow(buckets, row, groupLabel, "weekly", "current_weekly_remaining_percent", "current_weekly_usage_count", "current_weekly_total_count", "weekly_end_time", "weekly_start_time");
    }
    if (!buckets.length) throw new Error("MiniMax returned no quota data.");
    return { providerId: ctx.providerId, providerName: name, capturedAt, buckets, metrics: [] };
  }
  const metrics = [
    ["available", "Available balance", payload.available_amount],
    ["cash", "Cash balance", payload.cash_balance],
    ["voucher", "Voucher balance", payload.voucher_balance],
    ["credit", "Credit balance", payload.credit_balance],
  ].flatMap(([key, label, value]) => {
    const amount = nonnegative(value) !== undefined ? String(number(value)) : undefined;
    return amount === undefined ? [] : [{ id: String(key), label: String(label), value: amount, unit: "currency" as const, currency }];
  });
  if (!metrics.length) throw new Error("MiniMax returned no balance data.");
  return { providerId: ctx.providerId, providerName: name, capturedAt, buckets: [], metrics };
}

function groupLabelOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 80);
  return cleaned || undefined;
}

function addWindow(buckets: UsageBucket[], row: Record<string, unknown>, groupLabel: string, suffix: string, percentField: string, countField: string, totalField: string, endField: string, startField: string): void {
  const status = number(row[`${suffix === "interval" ? "current_interval" : "current_weekly"}_status`]);
  const end = number(row[endField]);
  const start = number(row[startField]);
  const percent = nonnegative(row[percentField]);
  const label = suffix === "weekly" ? "Weekly" : "Rolling";
  if (status === 3) {
    buckets.push({ id: `${groupLabel}:${suffix}`, label, groupLabel, remaining: 100, unit: "percent", period: "Unlimited" });
    return;
  }
  const total = nonnegativeInteger(row[totalField]);
  const count = nonnegativeInteger(row[countField]);
  if (total === undefined && percent === undefined) return;
  const windowMinutes = end !== undefined && start !== undefined ? Math.max(1, Math.round((end - start) / 60_000)) : undefined;
  const resetsAt = end !== undefined ? Math.floor(end / 1_000) : undefined;
  if (total && count !== undefined) {
    let remaining = count;
    if (percent !== undefined) {
      const asRemaining = count / total * 100;
      const asUsed = (total - count) / total * 100;
      if (Math.abs(asUsed - percent) < Math.abs(asRemaining - percent)) remaining = total - count;
    }
    buckets.push({ id: `${groupLabel}:${suffix}`, label, groupLabel, used: total - remaining, remaining, limit: total, unit: "count", ...(windowMinutes ? { windowMinutes } : {}), ...(resetsAt ? { resetsAt } : {}) });
    return;
  }
  buckets.push({ id: `${groupLabel}:${suffix}`, label, groupLabel, used: 100 - percent!, remaining: percent!, limit: 100, unit: "percent", ...(windowMinutes ? { windowMinutes } : {}), ...(resetsAt ? { resetsAt } : {}) });
}

import { registerJsonAdapter } from "../declarative.ts";
import { epochSeconds, nonnegative, nonnegativeInteger, number, record, stringValue, windowLabel } from "../helpers.ts";
import type { UsageBucket, UsageMetric, UsageReport } from "../types.ts";

// Kimi Coding plan quota (`/coding/v1/usages`). Two wire generations share the
// endpoint, so the normalizer tries both and keeps whichever yields data:
// 1. Plan usage (#848 response sample): scalar `usage` record + `limits[]`
//    rate windows with decimal-string counts and `window.duration`/`TIME_UNIT_*`,
//    plus `parallel.limit` and `user.membership.level` plan details.
// 2. Tolerant fallback: window maps keyed by name with `used_percent`, plus the
//    booster wallet balance.

const KIMI_TIME_UNIT_SECONDS = new Map([
  ["TIME_UNIT_SECOND", 1],
  ["TIME_UNIT_MINUTE", 60],
  ["TIME_UNIT_HOUR", 3_600],
  ["TIME_UNIT_DAY", 86_400],
]);

registerJsonAdapter({
  id: "kimi-coding",
  displayName: "Kimi Coding",
  origins: ["https://api.kimi.com"],
  url: () => "https://api.kimi.com/coding/v1/usages",
  normalize: (payload, ctx) => normalizePlanUsage(payload, ctx) ?? normalizeWindowMap(payload, ctx),
});

function normalizePlanUsage(payload: Record<string, unknown>, ctx: { providerId: UsageReport["providerId"] }): UsageReport | undefined {
  const buckets: UsageBucket[] = [];
  // Counts arrive as decimal strings. `usage` is the plan's overall quota and
  // `limits[]` the rate-limit windows, each with its own duration.
  const addBucket = (id: string, label: string, detail: Record<string, unknown> | undefined, seconds?: number) => {
    const limit = nonnegativeInteger(detail?.limit);
    const used = nonnegativeInteger(detail?.used);
    const remaining = nonnegativeInteger(detail?.remaining)
      ?? (limit !== undefined && used !== undefined ? Math.max(0, limit - used) : undefined);
    if (limit === undefined || remaining === undefined) return;
    const resetsAt = epochSeconds(detail?.resetTime);
    buckets.push({
      id,
      label,
      used: used ?? Math.max(0, limit - remaining),
      remaining,
      limit,
      unit: "count",
      ...(seconds ? { windowMinutes: Math.ceil(seconds / 60) } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  };
  addBucket("usage", "Overall", record(payload.usage));
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  limits.forEach((item, index) => {
    const value = record(item);
    const window = record(value?.window);
    const duration = nonnegative(window?.duration);
    const unitSeconds = KIMI_TIME_UNIT_SECONDS.get(stringValue(window?.timeUnit) ?? "");
    const seconds = duration !== undefined && unitSeconds ? duration * unitSeconds : undefined;
    addBucket(`limit-${index}`, windowLabel(seconds), record(value?.detail), seconds);
  });
  if (!buckets.length) return undefined;
  const metrics: UsageMetric[] = [];
  const parallel = nonnegativeInteger(record(payload.parallel)?.limit);
  if (parallel !== undefined) metrics.push({ id: "parallel", label: "Parallel requests", value: parallel, unit: "count" });
  const level = stringValue(record(record(payload.user)?.membership)?.level);
  if (level) metrics.push({ id: "membership", label: "Membership", value: level.replace(/^LEVEL_/u, "") });
  return { providerId: ctx.providerId, providerName: "Kimi Coding", capturedAt: Date.now(), buckets, metrics };
}

function normalizeWindowMap(payload: Record<string, unknown>, ctx: { providerId: UsageReport["providerId"] }): UsageReport {
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
}

import { registerJsonAdapter } from "../declarative";
import { nonnegative, number, record, stringValue } from "../helpers";
import type { UsageAdapter, UsageAuth, UsageBucket, UsageMetric, UsageQueryContext, UsageReport } from "../types";

// GLM Coding Plan quota: /api/monitor/usage/quota/limit returns window limits
// (5h/week token windows, MCP monthly bucket) with per-model usage details.
// api.z.ai expects the raw key in Authorization (no Bearer prefix).

const UNIT_NAMES: Record<number, string> = { 2: "m", 3: "h", 4: "d", 5: "mo", 6: "w" };

function windowLabel(limit: Record<string, unknown>): string {
  const count = number(limit.number);
  const unitWord = UNIT_NAMES[number(limit.unit) ?? -1];
  if (count !== undefined && unitWord) return `${count}${unitWord}`;
  return stringValue(limit.type)?.replace(/_/g, " ").toLowerCase() ?? "Quota window";
}

function normalizeLimit(payload: Record<string, unknown>, ctx: UsageQueryContext, name: string): UsageReport {
  const data = record(payload.data);
  if (payload.code !== 200 || payload.success !== true || !data) throw new Error("Z.AI returned an unsuccessful response.");
  const rows = Array.isArray(data.limits) ? data.limits : [];
  const buckets: UsageBucket[] = [];
  const metrics: UsageMetric[] = [];
  for (const [index, rowValue] of rows.entries()) {
    const row = record(rowValue);
    if (!row) continue;
    const label = windowLabel(row);
    const resetsAt = number(row.nextResetTime) !== undefined ? Math.floor(number(row.nextResetTime)! / 1_000) : undefined;
    const limit = number(row.usage);
    const used = number(row.currentValue);
    // Derive remaining when the payload omits it but carries usage + current value.
    const remaining = number(row.remaining) ?? (limit !== undefined && used !== undefined ? Math.max(0, limit - used) : undefined);
    if (limit !== undefined && limit > 0) {
      buckets.push({
        id: `limit-${index}`,
        label,
        used: used ?? (remaining !== undefined ? limit - remaining : undefined),
        remaining,
        limit,
        unit: "count",
        status: remaining !== undefined && remaining <= 0 ? "exhausted" : "ok",
        ...(resetsAt ? { resetsAt } : {}),
      });
      const details = Array.isArray(row.usageDetails) ? row.usageDetails : [];
      for (const detailValue of details) {
        const detail = record(detailValue);
        const model = stringValue(detail?.modelCode);
        const usage = nonnegative(detail?.usage);
        if (model && usage !== undefined) metrics.push({ id: `limit-${index}:${model}`, label: model, value: usage, unit: "count", groupLabel: label });
      }
      continue;
    }
    const percentage = number(row.percentage);
    if (percentage === undefined) continue;
    const usedPercent = Math.min(100, Math.max(0, percentage));
    buckets.push({
      id: `limit-${index}`,
      label,
      used: usedPercent,
      remaining: 100 - usedPercent,
      limit: 100,
      unit: "percent",
      status: usedPercent >= 100 ? "exhausted" : "ok",
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  if (!buckets.length) throw new Error("Z.AI returned no quota data.");
  const level = stringValue(data.level);
  const exhausted = buckets.some((bucket) => bucket.status === "exhausted" || bucket.status === "rate-limited");
  const notes = [
    ...(level ? [`Plan level: ${level}`] : []),
    ...(exhausted ? ["Any quota window at its limit blocks requests."] : []),
  ];
  return {
    providerId: ctx.providerId,
    providerName: name,
    capturedAt: Date.now(),
    buckets,
    metrics,
    ...(exhausted ? { exhausted: true } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

function authHeaders(auth: UsageAuth, bearer: boolean): Record<string, string> | undefined {
  if (auth.apiKey) return { Authorization: bearer ? `Bearer ${auth.apiKey}` : auth.apiKey };
  return undefined;
}

function spec(id: UsageAdapter["id"], displayName: string, origin: string, bearer: boolean) {
  return {
    id,
    displayName,
    origins: [origin],
    headers: (auth: UsageAuth) => authHeaders(auth, bearer),
    url: () => `${origin}/api/monitor/usage/quota/limit`,
    normalize: (payload: Record<string, unknown>, ctx: UsageQueryContext) => normalizeLimit(payload, ctx, displayName),
  };
}

registerJsonAdapter(spec("zai", "Z.AI", "https://api.z.ai", false));
registerJsonAdapter(spec("zai-coding-cn", "Z.AI Coding CN", "https://open.bigmodel.cn", true));

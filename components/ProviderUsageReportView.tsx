"use client";

// Shared rendering for provider usage reports: remaining-first rows with
// progress bars, grouped by model/plan (groupLabel), severity-colored.

import { useI18n } from "@/hooks/useI18n";

export type UsageBucket = {
  id: string;
  label: string;
  groupLabel?: string;
  used?: number;
  remaining?: number;
  limit?: number;
  unit: "percent" | "currency" | "count";
  currency?: string;
  windowMinutes?: number;
  resetsAt?: number;
  period?: string;
};

export type UsageMetric = { id: string; label: string; value: number | string; unit?: string; currency?: string; groupLabel?: string };
export type UsageReport = { capturedAt: number; buckets: UsageBucket[]; metrics: UsageMetric[]; notes?: string[] };

export function severityColor(remaining: number | undefined, limit: number | undefined): string {
  if (remaining === undefined || limit === undefined || limit <= 0) return "var(--text-muted)";
  const ratio = remaining / limit;
  if (ratio >= 0.5) return "#4ade80";
  if (ratio >= 0.2) return "#fbbf24";
  return "#f87171";
}

function groupRows(buckets: UsageBucket[]): Array<{ key: string; group?: string; rows: UsageBucket[] }> {
  const groups: Array<{ key: string; group?: string; rows: UsageBucket[] }> = [];
  for (const bucket of buckets) {
    const last = groups[groups.length - 1];
    if (last && last.group === bucket.groupLabel) last.rows.push(bucket);
    else groups.push({ key: bucket.groupLabel ?? `__ungrouped-${groups.length}`, group: bucket.groupLabel, rows: [bucket] });
  }
  return groups;
}

export function ProviderUsageReportView({ report }: { report: UsageReport }) {
  const { t } = useI18n();
  const freeMetrics = report.metrics.filter((metric) => !metric.groupLabel);
  const detailsByGroup = new Map<string, string[]>();
  for (const metric of report.metrics) {
    if (!metric.groupLabel) continue;
    const list = detailsByGroup.get(metric.groupLabel) ?? [];
    list.push(`${metric.label} ${metric.value}`);
    detailsByGroup.set(metric.groupLabel, list);
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      {groupRows(report.buckets).map((group) => (
        <div key={group.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {group.group && <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>{group.group}</span>}
          {group.rows.map((bucket) => {
            const ratio = bucket.limit !== undefined && bucket.limit > 0
              ? Math.min(100, Math.max(0, ((bucket.remaining ?? 0) / bucket.limit) * 100))
              : undefined;
            const color = severityColor(bucket.remaining, bucket.limit);
            return (
              <div key={bucket.id} style={{ display: "grid", gridTemplateColumns: "minmax(64px, auto) minmax(70px, 110px) minmax(0, 1fr)", columnGap: 10, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bucket.label}</span>
                {ratio !== undefined ? (
                  <span style={{ display: "block", height: 5, borderRadius: 3, background: "var(--bg-panel)", overflow: "hidden" }}>
                    <span style={{ display: "block", height: "100%", width: `${ratio}%`, borderRadius: 3, background: color, transition: "width 0.4s ease" }} />
                  </span>
                ) : <span />}
                <span style={{ fontSize: 12, color, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {formatBucket(bucket, t("providerUsage.available"))}
                </span>
              </div>
            );
          })}
          {detailsByGroup.get(group.group ?? "")?.length ? (
            <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", paddingLeft: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {detailsByGroup.get(group.group ?? "")!.join(" · ")}
            </span>
          ) : null}
        </div>
      ))}
      {freeMetrics.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
          {freeMetrics.map((metric) => (
            <span key={metric.id} style={{ fontSize: 12, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
              <span style={{ color: "var(--text-dim)", fontFamily: "inherit", marginRight: 6 }}>{metric.label}</span>
              {formatMetric(metric)}
            </span>
          ))}
        </div>
      )}
      {report.notes?.length ? (
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{report.notes.join(" · ")}</span>
      ) : null}
    </div>
  );
}

export function formatBucket(bucket: UsageBucket, availableLabel: string): string {
  if (bucket.unit === "percent" && bucket.remaining !== undefined) {
    const reset = bucket.resetsAt ? ` · ${formatReset(bucket.resetsAt)}` : "";
    return `${Math.round(bucket.remaining)}%${reset}`;
  }
  if (bucket.unit === "currency") return `${bucket.currency === "CNY" ? "¥" : "$"}${formatAmount(bucket.remaining ?? bucket.limit)}`;
  if (bucket.remaining !== undefined && bucket.limit !== undefined) return `${formatAmount(bucket.remaining)} / ${formatAmount(bucket.limit)}${bucket.resetsAt ? ` · ${formatReset(bucket.resetsAt)}` : ""}`;
  return bucket.period ?? availableLabel;
}

export function formatMetric(metric: UsageMetric): string {
  if (metric.unit === "currency") return `${metric.currency === "CNY" ? "¥" : "$"}${metric.value}`;
  return String(metric.value);
}

function formatAmount(value: number | undefined): string {
  return value === undefined ? "-" : Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function formatReset(seconds: number): string {
  return new Date(seconds * 1_000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatUpdated(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

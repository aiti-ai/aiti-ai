"use client";

// Shared rendering for provider usage reports: remaining-first rows with
// progress bars, grouped by model/plan (groupLabel), severity-colored.
// Window state (rate-limited / used up), relative reset countdowns and
// used/limit detail are carried through from the adapter reports.

import { useI18n } from "@/hooks/useI18n";
import type { UsageBucket, UsageMetric, UsageReport } from "@/lib/provider-usage/types";

export type { UsageBucket, UsageMetric, UsageReport } from "@/lib/provider-usage/types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The quota color scale uses theme semantic tokens (--ok/--warn/--danger in app/globals.css; each theme
 *  defines its own set; dark's --ok matches the message-area tool-name color #16a34a — the bright green
 *  #4ade80 is deprecated). */
export function severityColor(remaining: number | undefined, limit: number | undefined): string {
  if (remaining === undefined || limit === undefined || limit <= 0) return "var(--text-muted)";
  const ratio = remaining / limit;
  if (ratio >= 0.5) return "var(--ok)";
  if (ratio >= 0.2) return "var(--warn)";
  return "var(--danger)";
}

/** True when this window currently blocks usage (provider said so, or zero left). */
export function isBucketAlarming(bucket: UsageBucket): boolean {
  if (bucket.status === "rate-limited" || bucket.status === "exhausted") return true;
  return bucket.limit !== undefined && bucket.limit > 0 && bucket.remaining !== undefined && bucket.remaining <= 0;
}

export function isReportExhausted(report: UsageReport): boolean {
  return report.exhausted === true || report.buckets.some(isBucketAlarming);
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
            // Only draw a bar when the remaining amount is known; used/limit-only
            // buckets would otherwise render a misleading empty bar.
            const ratio = bucket.remaining !== undefined && bucket.limit !== undefined && bucket.limit > 0
              ? Math.min(100, Math.max(0, (bucket.remaining / bucket.limit) * 100))
              : undefined;
            const alarming = isBucketAlarming(bucket);
            const color = alarming ? "var(--danger)" : severityColor(bucket.remaining, bucket.limit);
            return (
              <div key={bucket.id} style={{ display: "grid", gridTemplateColumns: "minmax(64px, auto) minmax(70px, 110px) minmax(0, 1fr)", columnGap: 10, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bucket.label}</span>
                {ratio !== undefined ? (
                  <span style={{ display: "block", height: 5, borderRadius: 3, background: "var(--bg-panel)", overflow: "hidden" }}>
                    <span style={{ display: "block", height: "100%", width: `${ratio}%`, borderRadius: 3, background: color, transition: "width 0.4s ease" }} />
                  </span>
                ) : <span />}
                <span style={{ fontSize: 12, color, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {formatBucket(bucket, t)}
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

function bucketStateText(bucket: UsageBucket, t: Translate): string {
  if (bucket.status === "rate-limited") return ` · ${t("providerUsage.stateRateLimited")}`;
  if (bucket.status === "exhausted") return ` · ${t("providerUsage.stateExhausted")}`;
  return "";
}

export function formatBucket(bucket: UsageBucket, t: Translate): string {
  const state = bucketStateText(bucket, t);
  const reset = bucket.resetsAt ? ` · ${formatReset(bucket.resetsAt)}` : "";
  if (bucket.unit === "percent" && bucket.remaining !== undefined) {
    return `${Math.round(bucket.remaining)}%${state}${reset}`;
  }
  if (bucket.unit === "currency") {
    const symbol = bucket.currency === "CNY" ? "¥" : "$";
    if (bucket.remaining !== undefined && bucket.limit !== undefined) {
      return `${symbol}${formatAmount(bucket.remaining)} / ${symbol}${formatAmount(bucket.limit)}${state}${reset}`;
    }
    if (bucket.remaining !== undefined) return `${symbol}${formatAmount(bucket.remaining)}${state}${reset}`;
    if (bucket.limit !== undefined) return `${symbol}${formatAmount(bucket.limit)} ${t("providerUsage.limit")}${state}${reset}`;
    return `${bucket.period ?? t("providerUsage.available")}${state}${reset}`;
  }
  if (bucket.remaining !== undefined && bucket.limit !== undefined) {
    const usedPct = bucket.used !== undefined && bucket.limit > 0 ? ` · ${Math.round((bucket.used / bucket.limit) * 100)}% ${t("providerUsage.used")}` : "";
    return `${formatAmount(bucket.remaining)} / ${formatAmount(bucket.limit)}${usedPct}${state}${reset}`;
  }
  if (bucket.used !== undefined && bucket.limit !== undefined) {
    return `${formatAmount(bucket.used)} / ${formatAmount(bucket.limit)} · ${t("providerUsage.used")}${state}${reset}`;
  }
  return `${bucket.period ?? t("providerUsage.available")}${state}${reset}`;
}

export function formatMetric(metric: UsageMetric): string {
  if (metric.unit === "currency") return `${metric.currency === "CNY" ? "¥" : "$"}${metric.value}`;
  return String(metric.value);
}

function formatAmount(value: number | undefined): string {
  return value === undefined ? "-" : Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** < 6h → HH:MM:SS countdown (session windows); otherwise a local date/time.
 *  The countdown is computed at render time and advances with host re-renders
 *  (no timer — repo no-polling rule); a long-idle panel can show a stale value. */
export function formatReset(seconds: number): string {
  const target = seconds * 1_000;
  const delta = target - Date.now();
  if (delta > 0 && delta <= 6 * 3600_000) {
    const total = Math.floor(delta / 1_000);
    const h = String(Math.floor(total / 3600)).padStart(2, "0");
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }
  return new Date(target).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatUpdated(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

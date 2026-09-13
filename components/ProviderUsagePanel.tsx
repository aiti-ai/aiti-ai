"use client";

// Session-info "remaining quota" block: current session provider expanded on
// top, other configured+supported providers collapsed one-line summaries.
// Event-driven: fetch on mount / manual refresh / model change. No polling.

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { apiUrl } from "@/lib/base-path";
import { ProviderUsageReportView, formatBucket, formatMetric, formatUpdated, severityColor, type UsageBucket, type UsageReport } from "./ProviderUsageReportView";

const STORAGE_KEY = "pi-web:provider-usage:overview";

type OverviewEntry = { providerId: string; providerName: string; kind: string; status: string; report?: UsageReport; message?: string };
type Overview = { capturedAt: number; providers: OverviewEntry[] };

export function ProviderUsagePanel({ currentProviderId, expanded }: { currentProviderId?: string | null; expanded?: boolean }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [querying, setQuerying] = useState(false);
  const [refreshDone, setRefreshDone] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useI18n();

  const query = useCallback(async (force: boolean) => {
    setQuerying(true);
    try {
      const response = await fetch(apiUrl("/api/provider-usage/overview"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(force ? { force: true } : {}),
      });
      if (!response.ok) return;
      const result = await response.json() as Overview;
      if (!result || !Array.isArray(result.providers)) return;
      setOverview(result);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(result)); } catch {}
      if (force) {
        setRefreshDone(true);
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => setRefreshDone(false), 2000);
      }
    } catch {
      // Keep previous state on failure; a manual refresh can retry.
    } finally {
      setQuerying(false);
    }
  }, []);

  useEffect(() => {
    try {
      const cached = localStorage.getItem(STORAGE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as Overview;
        if (parsed?.providers && Date.now() - (parsed.capturedAt ?? 0) < 5 * 60_000) setOverview(parsed);
      }
    } catch {
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
    }
    void query(false);
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [query]);

  if (!overview) return null;
  const ready = overview.providers.filter((entry) => entry.status === "ready" && entry.report);
  if (!ready.length) return null;
  const current = currentProviderId ? ready.find((entry) => entry.providerId === currentProviderId) : undefined;
  const others = ready.filter((entry) => entry !== current);

  return (
    <section data-provider-usage-panel style={{ borderTop: "1px solid var(--border)", marginTop: 14, paddingTop: 12, display: "flex", flexDirection: "column", gap: 10, ...(expanded === false ? {} : {}) }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flex: 1 }}>{t("providerUsage.remainingQuota")}</span>
        <button
          type="button"
          onClick={() => void query(true)}
          disabled={querying}
          title={t(querying ? "providerUsage.refreshing" : "providerUsage.refresh")}
          aria-label={t(querying ? "providerUsage.refreshing" : "providerUsage.refresh")}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 24, padding: 0, background: "none", border: "none", color: refreshDone ? "#4ade80" : "var(--text-dim)", cursor: "pointer", borderRadius: 5, transition: "color 0.3s" }}
        >
          {refreshDone ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={querying ? { animation: "spin 0.8s linear infinite" } : undefined} aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
          )}
        </button>
        <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{formatUpdated(overview.capturedAt)}</span>
      </div>

      {current && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ width: 6, height: 6, borderRadius: 3, background: "#4ade80", flexShrink: 0, alignSelf: "center" }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{current.providerName}</span>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("providerUsage.currentSession")}</span>
          </div>
          <div style={{ paddingLeft: 14 }}>
            <ProviderUsageReportView report={current.report!} />
          </div>
        </div>
      )}

      {others.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 11, color: "var(--text-dim)", userSelect: "none", listStyle: "none", display: "flex", alignItems: "center", gap: 6 }}>
            <span aria-hidden="true">▸</span>
            {t("providerUsage.otherProviders", { count: others.length })}
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 14, paddingTop: 6 }}>
            {others.map((entry) => (
              <OtherProviderRow key={entry.providerId} entry={entry} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function OtherProviderRow({ entry }: { entry: OverviewEntry }) {
  const report = entry.report!;
  const worst = pickWorstBucket(report);
  const fallbackMetric = report.metrics.find((metric) => metric.unit === "currency") ?? report.metrics[0];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(80px, 140px) minmax(0, 1fr)", columnGap: 10, alignItems: "center", fontSize: 11.5 }}>
      <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.providerName}</span>
      <span style={{ color: severityColor(worst?.remaining, worst?.limit), fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {worst ? formatBucket(worst, worst.period ?? "") : fallbackMetric ? formatMetric(fallbackMetric) : ""}
        {report.notes?.length ? ` · ${report.notes[0]}` : ""}
      </span>
    </div>
  );
}

function pickWorstBucket(report: UsageReport): UsageBucket | undefined {
  let worst: UsageBucket | undefined;
  for (const bucket of report.buckets) {
    if (bucket.remaining === undefined || bucket.limit === undefined || bucket.limit <= 0) continue;
    if (!worst || bucket.remaining / bucket.limit < worst.remaining! / worst.limit!) worst = bucket;
  }
  return worst;
}

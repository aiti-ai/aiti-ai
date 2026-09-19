"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { apiUrl } from "@/lib/base-path";
import { isProviderUsageId } from "@/lib/provider-usage-ids";
import { ProviderUsageReportView, formatUpdated, type UsageReport } from "./ProviderUsageReportView";

const STORAGE_PREFIX = "pi-web:provider-usage:";
// Server overview cache is 5min; piggyback on it to avoid duplicate queries.
const LOCAL_REUSE_MS = 5 * 60_000;

type UsageResponse = { providerId: string; status: "ready" | "unsupported" | "auth-unavailable" | "query-failed"; report?: UsageReport; message?: string };

export function ProviderUsageSummary({ providerId, enabled }: { providerId: string; enabled: boolean }) {
  if (!enabled || !isProviderUsageId(providerId)) return null;
  return <ProviderUsageContent providerId={providerId} />;
}

function ProviderUsageContent({ providerId }: { providerId: string }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshDone, setRefreshDone] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useI18n();

  useEffect(() => {
    setReport(null);
    setUnsupported(false);
    setError(null);
    try {
      const cached = localStorage.getItem(`${STORAGE_PREFIX}${providerId}`);
      if (cached) {
        const parsed = JSON.parse(cached) as { at?: number; response?: UsageResponse };
        if (parsed?.response?.status === "ready" && parsed.response.report && parsed.at && Date.now() - parsed.at < LOCAL_REUSE_MS) {
          setReport(parsed.response.report);
        }
      }
    } catch {
      try { localStorage.removeItem(`${STORAGE_PREFIX}${providerId}`); } catch {}
    }
  }, [providerId]);

  const query = useCallback(async (isRefresh: boolean) => {
    setQuerying(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/provider-usage/query"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId }),
      });
      const result = await response.json() as UsageResponse & { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      if (result.status === "ready" && result.report) {
        setReport(result.report);
        try { localStorage.setItem(`${STORAGE_PREFIX}${providerId}`, JSON.stringify({ at: Date.now(), response: result })); } catch {}
        if (isRefresh) {
          setRefreshDone(true);
          if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = setTimeout(() => setRefreshDone(false), 2000);
        }
      } else if (result.status === "unsupported") {
        setUnsupported(true);
      } else {
        setError(result.message ?? t("providerUsage.queryFailed"));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("providerUsage.queryFailed"));
    } finally {
      setQuerying(false);
    }
  }, [providerId, t]);

  useEffect(() => {
    if (report || unsupported) return;
    void query(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, report, unsupported]);

  useEffect(() => () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
  }, []);

  if (unsupported) return null;
  return (
    <section style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 600, lineHeight: 1.35 }}>{t("providerUsage.usage")}</span>
        <button
          type="button"
          onClick={() => void query(true)}
          disabled={querying}
          title={t(querying ? "providerUsage.refreshing" : "providerUsage.refresh")}
          aria-label={t(querying ? "providerUsage.refreshing" : "providerUsage.refresh")}
          style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 30, padding: 0, background: "none", border: "none", color: refreshDone ? "#4ade80" : "var(--text-dim)", cursor: querying ? "default" : "pointer", borderRadius: 5, flexShrink: 0, transition: "color 0.3s" }}
        >
          {refreshDone ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={querying ? { animation: "spin 0.8s linear infinite" } : undefined} aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          )}
        </button>
        {report && <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{t("providerUsage.updated", { time: formatUpdated(report.capturedAt) })}</span>}
      </div>

      {!report && !error && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("providerUsage.loading")}</span>}
      {error && <span style={{ fontSize: 12, color: "#f87171" }}>{error}</span>}
      {report && <ProviderUsageReportView report={report} />}
    </section>
  );
}

"use client";

// Session-info "remaining quota" block: current session provider expanded on
// top, other configured+supported providers below (summary line each, click to
// expand the full report). Event-driven: fetch on mount / manual refresh.
// (A model change only re-selects which provider is pinned as current.)
// No polling.
// （自 pi-web fork components/ProviderUsagePanel.tsx 外迁，B1：useI18n → host-shim t、
//   apiUrl → host-shim apiUrl、数据源 /api/extensions/aiti-provider-usage/overview。）

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl, t } from "./host-shim";
import { bucketLabel, fmtLastTurn, type BackendUsage } from "./StatsChip";
import {
  ProviderUsageReportView,
  formatBucket,
  formatMetric,
  formatUpdated,
  isReportExhausted,
  severityColor,
  type UsageBucket,
  type UsageReport,
} from "./ReportView";

const STORAGE_KEY = "pi-web:provider-usage:overview";

type OverviewEntry = { providerId: string; providerName: string; kind: string; status: string; report?: UsageReport; message?: string };
type Overview = { capturedAt: number; providers: OverviewEntry[] };

export function ProviderUsagePanel({ currentProviderId, backendUsage, backendSource, sessionId }: {
  currentProviderId?: string | null;
  backendUsage?: BackendUsage | null;
  backendSource?: string;
  sessionId?: string | null;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  // Start as querying so the section shows a loading placeholder before the
  // first fetch resolves (instead of rendering nothing until data arrives).
  const [querying, setQuerying] = useState(true);
  const [refreshDone, setRefreshDone] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = useCallback(async (force: boolean) => {
    setQuerying(true);
    try {
      const response = await fetch(apiUrl("/api/extensions/aiti-provider-usage/overview"), {
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

  const ready = overview ? overview.providers.filter((entry) => entry.status === "ready" && entry.report) : [];
  const current = overview && currentProviderId ? ready.find((entry) => entry.providerId === currentProviderId) : undefined;
  // Flat list: current-session provider pinned on top, the rest follow in overview
  // order — no intermediate "other providers" group (one row per provider).
  const rows = [...ready].sort((a, b) => (a === current ? -1 : b === current ? 1 : 0));

  return (
    <section data-provider-usage-panel style={{ borderTop: "1px solid var(--border)", marginTop: 14, paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flex: 1 }}>{t("providerUsage.remainingQuota")}</span>
        <button
          type="button"
          onClick={() => void query(true)}
          disabled={querying}
          title={t(querying ? "providerUsage.refreshing" : "providerUsage.refresh")}
          aria-label={t(querying ? "providerUsage.refreshing" : "providerUsage.refresh")}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 24, padding: 0, background: "none", border: "none", color: refreshDone ? "var(--ok, #16a34a)" : "var(--text-dim)", cursor: "pointer", borderRadius: 5, transition: "color 0.3s" }}
        >
          {refreshDone ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ok, #16a34a)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={querying ? { animation: "spin 0.8s linear infinite" } : undefined} aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
          )}
        </button>
        {overview && <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{formatUpdated(overview.capturedAt)}</span>}
      </div>

      {rows.length ? (
        rows.map((entry) => (
          <ProviderRow key={entry.providerId} entry={entry} isCurrent={entry === current} />
        ))
      ) : (
        // Placeholder while the first fetch is in flight (or when nothing is
        // queryable yet) — keeps the section visible instead of popping in later.
        <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "2px 0" }}>
          {querying ? t("providerUsage.loading") : t("providerUsage.notQueried")}
        </div>
      )}

      {/* Active backend session's own account quota (get_usage snapshot, e.g.
          qoder credits + 基础/扩展/组织 buckets) — shown above/below the provider
          list as its own block; renders nothing for backends without usage data. */}
      <AccountQuotaSection usage={backendUsage ?? null} backendSource={backendSource} sessionId={sessionId} />
    </section>
  );
}

/** 当前会话账号配额明细：总剩余 / 已用条形 + 各配额桶 + 套餐/到期/来源 + 上一轮用量。 */
export function AccountQuotaSection({ usage, backendSource, sessionId }: {
  usage: BackendUsage | null;
  backendSource?: string;
  sessionId?: string | null;
}) {
  if (!usage) return null;
  const credits = usage.credits;
  const buckets = usage.buckets ?? [];
  if (!credits && !usage.quotaExceeded && buckets.length === 0) return null;

  const exhausted = Boolean(usage.quotaExceeded && (credits?.remaining == null || credits.remaining <= 0));
  const usedPct = credits?.usedPercent;
  // The bar shows what is LEFT (same remaining-first language as provider rows).
  const remainingPct = usedPct != null ? Math.min(100, Math.max(0, 100 - usedPct)) : undefined;
  const totalColor = exhausted ? "var(--danger, #ef4444)" : usedPct != null && usedPct >= 70 ? "var(--warn, #d97706)" : "var(--text)";
  const source = backendSource ?? usage.provider;
  const lastTurn = fmtLastTurn(usage);

  const meta: string[] = [];
  if (usage.plan) meta.push(`${t("providerUsage.plan")} ${usage.plan}`);
  if (credits?.expiresAt) meta.push(`${t("providerUsage.expires")} ${new Date(credits.expiresAt).toLocaleDateString()}`);
  if (source) meta.push(`${t("providerUsage.source")} ${source}`);

  return (
    <div data-account-quota style={{ display: "flex", flexDirection: "column", gap: 7, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8 }}>
      <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-muted)" }} title={sessionId ?? undefined}>
        {t("providerUsage.account")}
      </span>

      {(credits || usage.quotaExceeded) && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(64px, auto) minmax(70px, 110px) minmax(0, 1fr)", columnGap: 10, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--text)" }}>{t("providerUsage.remaining")}</span>
          {remainingPct !== undefined ? (
            <span style={{ display: "block", height: 5, borderRadius: 3, background: "var(--bg-panel)", overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: `${remainingPct}%`, borderRadius: 3, background: totalColor, transition: "width 0.4s ease" }} />
            </span>
          ) : <span />}
          <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: totalColor, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {exhausted
              ? t("providerUsage.quotaExceeded")
              : `${credits?.remaining != null ? credits.remaining : "?"}${credits?.unit ? ` ${credits.unit}` : ""}${usedPct != null ? ` · ${usedPct}% ${t("providerUsage.used")}` : ""}`}
          </span>
        </div>
      )}

      {buckets.map((b) => {
        const ratio = b.remaining != null && b.total != null && b.total > 0 ? Math.min(100, Math.max(0, (b.remaining / b.total) * 100)) : undefined;
        const pct = b.usedPercent ?? (b.used != null && b.total != null && b.total > 0 ? Math.round((b.used / b.total) * 100) : undefined);
        const color = pct != null && pct >= 90 ? "var(--danger, #ef4444)" : pct != null && pct >= 70 ? "var(--warn, #d97706)" : "var(--text-muted)";
        return (
          <div key={b.name} style={{ display: "grid", gridTemplateColumns: "minmax(64px, auto) minmax(70px, 110px) minmax(0, 1fr)", columnGap: 10, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "var(--text)" }}>{bucketLabel(b.name)}</span>
            {ratio !== undefined ? (
              <span style={{ display: "block", height: 5, borderRadius: 3, background: "var(--bg-panel)", overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${ratio}%`, borderRadius: 3, background: severityColor(b.remaining, b.total), transition: "width 0.4s ease" }} />
              </span>
            ) : <span />}
            <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {b.remaining ?? 0}/{b.total ?? "?"}{pct != null ? ` · ${pct}%` : ""}
            </span>
          </div>
        );
      })}

      {(meta.length > 0 || lastTurn) && (
        <span style={{ fontSize: 10.5, color: "var(--text-dim)", display: "flex", flexWrap: "wrap", gap: "2px 12px" }}>
          {meta.length > 0 && <span>{meta.join(" · ")}</span>}
          {lastTurn && <span style={{ fontFamily: "var(--font-mono)" }}>{t("providerUsage.lastTurn")} {lastTurn}</span>}
        </span>
      )}
    </div>
  );
}


function ProviderRow({ entry, isCurrent }: { entry: OverviewEntry; isCurrent: boolean }) {
  const report = entry.report!;
  const worst = pickWorstBucket(report);
  const fallbackMetric = report.metrics.find((metric) => metric.unit === "currency") ?? report.metrics[0];
  const alarming = isReportExhausted(report);
  return (
    <details open={isCurrent}>
      <summary style={{ display: "grid", gridTemplateColumns: "minmax(80px, 180px) minmax(0, 1fr)", columnGap: 10, alignItems: "center", cursor: "pointer", listStyle: "none", fontSize: 11.5 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {isCurrent ? (
            <span style={{ width: 6, height: 6, borderRadius: 3, background: "var(--ok, #16a34a)", flexShrink: 0, alignSelf: "center" }} />
          ) : (
            <span aria-hidden="true" style={{ color: "var(--text-dim)", fontSize: 9 }}>▸</span>
          )}
          {entry.providerName}
          {alarming && <ExhaustedBadge label={t("providerUsage.exhausted")} />}
          {isCurrent && <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{t("providerUsage.currentSession")}</span>}
        </span>
        <span style={{ color: alarming ? "var(--danger, #ef4444)" : worst ? severityColor(worst.remaining, worst.limit) : "var(--text-muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {worst ? `${worst.label} ${formatBucket(worst, t)}` : fallbackMetric ? formatMetric(fallbackMetric) : ""}
        </span>
      </summary>
      <div style={{ paddingLeft: 14, paddingTop: 6 }}>
        <ProviderUsageReportView report={report} />
      </div>
    </details>
  );
}

function ExhaustedBadge({ label }: { label: string }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 99, color: "var(--danger, #ef4444)", background: "color-mix(in srgb, var(--danger, #ef4444) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--danger, #ef4444) 35%, transparent)", whiteSpace: "nowrap" }}>
      {label}
    </span>
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

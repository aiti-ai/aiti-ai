"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useOverlayBack } from "@/hooks/useOverlayBack";
import { apiUrl } from "@/lib/base-path";
import { dedupeFetch } from "@/lib/dedupe-fetch";
import type { PendingRecoveryItem } from "@/lib/queue-store";

/**
 * Restart recovery wizard (frontend for the host app's restart-recovery P1/P2 work).
 *
 * On page load, checks /api/agent/recovery/interrupted once for sessions that were mid-run
 * when the host process was interrupted. Two-step wizard: first pick a session → then handle
 * that session's queued messages; the decision options match QueueRecoveryDialog
 * (discard / requeue / requeue and continue), with only a session-selection layer and
 * "dismiss this session" added on top. The resume prompt is uniformly "continue"
 * (the original prompt is not replayed — it may be a dangerous command).
 */

interface InterruptedItem {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  kind: "local" | "external";
  interruptedAt: number;
  state: "pending" | "dismissed";
  title: string;
  lastPrompt: string;
  lastAssistant: string;
  queueCount: number;
  turnInterrupted: boolean;
  resumable: boolean;
  reason?: string;
}

interface InterruptedReport {
  items: InterruptedItem[];
  pendingCount: number;
  totalQueued: number;
}

export function RestartRecoveryWizard() {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [report, setReport] = useState<InterruptedReport | null>(null);
  const [active, setActive] = useState<InterruptedItem | null>(null);
  const [items, setItems] = useState<PendingRecoveryItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);

  const refresh = useCallback(async (): Promise<InterruptedReport | null> => {
    try {
      // dedupeFetch(ttl=0): pure in-flight merging (StrictMode's double effect / remounts must not hit the
      // endpoint twice; a refresh after a user action re-fetches immediately, nothing is cached).
      const res = await dedupeFetch(apiUrl("/api/agent/recovery/interrupted"), { cache: "no-store", ttlMs: 0 });
      if (!res.ok) return null;
      const data = await res.json() as InterruptedReport;
      setReport(data);
      return data;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openSession = useCallback(async (item: InterruptedItem) => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(item.sessionId)}/queue-recovery`), { cache: "no-store" });
      const data = await res.json() as { items?: PendingRecoveryItem[] };
      const list = data.items ?? [];
      setItems(list);
      setSelected(new Set(list.map((i) => i.id)));
      setActive(item);
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : String(error), ok: false });
    } finally {
      setBusy(false);
    }
  }, []);

  const finishSession = useCallback(async () => {
    setActive(null);
    setItems([]);
    setSelected(new Set());
    await refresh();
  }, [refresh]);

  const doResolve = useCallback(async (opts: { keep?: string[]; discard?: string[]; continueRun?: boolean; dismiss?: boolean }) => {
    if (!active) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(apiUrl("/api/agent/recovery/resolve"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: active.sessionId,
          sessionFile: active.sessionFile,
          continueText: t("chat.continue"),
          ...opts,
        }),
      });
      const data = await res.json() as { ok?: boolean; error?: string; failed?: string[] };
      if (!res.ok || !data.ok) {
        setStatus({ text: data.error ?? `HTTP ${res.status}`, ok: false });
        return;
      }
      if (data.failed && data.failed.length > 0) {
        setStatus({ text: t("chat.restartRecoveryPartial", { count: String(data.failed.length) }), ok: false });
      }
      await finishSession();
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : String(error), ok: false });
    } finally {
      setBusy(false);
    }
  }, [active, finishSession, t]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const pendingItems = (report?.items ?? []).filter((i) => i.state === "pending");
  const visible = Boolean(active) || pendingItems.length > 0;
  // Mobile system back = close the wizard (same as "dismiss"; ignored while busy, to avoid interrupting a recovery action)
  useOverlayBack(isMobile && visible, () => {
    if (busy) return;
    // The two wizard steps differ: with a session selected (active) back = dismiss; on step one (session list)
    // it behaves like the ✕ — close locally
    if (active) void doResolve({ dismiss: true });
    else setReport({ items: [], pendingCount: 0, totalQueued: 0 });
  });
  if (!visible) return null;

  const selectedIds = items.filter((i) => selected.has(i.id)).map((i) => i.id);
  const hasSelection = selectedIds.length > 0;

  // ── Shared button styles (aligned with QueueRecoveryDialog) ──
  const btnBase: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "6px 12px",
    borderRadius: 7,
    fontSize: 12.5,
    fontWeight: 550,
    cursor: "pointer",
    transition: "background 0.12s, border-color 0.12s, color 0.12s, opacity 0.12s",
    whiteSpace: "nowrap",
  };
  const btnDanger: React.CSSProperties = { ...btnBase, color: "#ef4444", background: "transparent", border: "1px solid color-mix(in srgb, #ef4444 35%, var(--border))" };
  const btnPrimary: React.CSSProperties = { ...btnBase, color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))" };
  const btnPrimarySolid: React.CSSProperties = { ...btnBase, color: "#fff", background: "var(--accent)", border: "1px solid var(--accent)" };
  const dim = (s: React.CSSProperties, off: boolean): React.CSSProperties => ({ ...s, opacity: off ? 0.45 : 1, cursor: off ? "not-allowed" : "pointer" });
  // Session-row message preview (user/AI capped at 2 lines each, ellipsis beyond)
  const previewTextStyle: React.CSSProperties = {
    minWidth: 0, flex: 1,
    fontSize: 12, lineHeight: 1.5, color: "var(--text)",
    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
    overflow: "hidden", wordBreak: "break-word",
  };

  const stepTitle = active
    ? t("chat.restartRecoveryQueueOf", { name: active.title || active.sessionId.slice(0, 8) })
    : t("chat.restartRecoveryTitle", { count: String(pendingItems.length) });

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: isMobile ? 10 : 24,
        background: "rgba(0,0,0,0.4)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={stepTitle}
        style={{
          width: "min(760px, calc(100vw - 32px))",
          maxHeight: "88%",
          display: "flex", flexDirection: "column",
          border: "1px solid var(--border)", borderRadius: 10,
          background: "var(--bg)", boxShadow: "0 8px 32px rgba(0,0,0,0.22)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          padding: isMobile ? "10px 12px" : "12px 14px",
          borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "flex-start", gap: isMobile ? 10 : 12,
        }}>
          {active && (
            <button
              onClick={() => { setActive(null); setItems([]); }}
              disabled={busy}
              title={t("chat.restartRecoveryBack")}
              aria-label={t("chat.restartRecoveryBack")}
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 28, height: 28, flexShrink: 0, alignSelf: "center",
                borderRadius: 7, border: "1px solid var(--border)",
                background: "transparent", color: "var(--text-muted)", cursor: "pointer",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}
          <div
            style={{
              flexShrink: 0, width: isMobile ? 30 : 34, height: isMobile ? 30 : 34,
              borderRadius: isMobile ? 8 : 9,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "color-mix(in srgb, var(--accent) 12%, transparent)",
              color: "var(--accent)",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
              <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
            </svg>
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "var(--text)", fontSize: isMobile ? 14 : 15, fontWeight: 700 }}>
              {stepTitle}
            </div>
            <div style={{ marginTop: 3, color: "var(--text-muted)", fontSize: isMobile ? 11 : 12.5, lineHeight: 1.5 }}>
              {active
                ? (active.lastPrompt
                  ? t("chat.restartRecoveryWasRunning", { prompt: active.lastPrompt })
                  : t("chat.restartRecoveryQueueOf", { name: active.title || active.sessionId.slice(0, 8) }))
                : t("chat.restartRecoveryDesc", { continue: t("chat.continue") })}
            </div>
          </div>
          {!active && (
            <button
              onClick={() => setReport({ items: [], pendingCount: 0, totalQueued: 0 })}
              title={t("chat.close")}
              aria-label={t("chat.close")}
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 28, height: 28, flexShrink: 0,
                borderRadius: 7, border: "1px solid transparent",
                background: "transparent", color: "var(--text-dim)", cursor: "pointer",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? 10 : 12, display: "grid", gap: 8, alignContent: "start" }}>
          {!active && pendingItems.map((item) => {
            const openable = item.resumable;
            return (
              <button
                key={item.sessionFile}
                onClick={() => { if (openable) void openSession(item); }}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 11,
                  width: "100%", padding: "9px 11px", borderRadius: 8,
                  border: `1px solid ${openable ? "var(--border)" : "color-mix(in srgb, var(--border) 60%, transparent)"}`,
                  background: "var(--bg-panel)",
                  cursor: openable ? "pointer" : "default",
                  textAlign: "left",
                  opacity: openable ? 1 : 0.72,
                  transition: "border-color 0.12s, background 0.12s",
                }}
                onMouseEnter={(e) => { if (openable) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (openable) e.currentTarget.style.background = "var(--bg-panel)"; }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{
                      fontSize: 13, fontWeight: 650, color: "var(--text)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      maxWidth: isMobile ? "100%" : 380,
                    }}>
                      {item.title || item.sessionId.slice(0, 12)}
                    </span>
                    {item.queueCount > 0 && (
                      <span style={{
                        fontSize: 10.5, fontWeight: 650, padding: "2px 8px", borderRadius: 999,
                        color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 8%, transparent)",
                        border: "1px solid color-mix(in srgb, var(--accent) 40%, transparent)",
                      }}>
                        {t("chat.restartRecoveryQueued", { count: String(item.queueCount) })}
                      </span>
                    )}
                    {!openable && (
                      <span style={{
                        fontSize: 10.5, fontWeight: 650, padding: "2px 8px", borderRadius: 999,
                        color: "var(--text-dim)", border: "1px solid var(--border)",
                      }}>
                        {item.reason === "external"
                          ? t("chat.restartRecoveryExternal")
                          : item.reason === "other-instance"
                            ? t("chat.restartRecoveryOtherInstance")
                            : t("chat.restartRecoveryBridge")}
                      </span>
                    )}
                  </div>
                  <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 11, color: "var(--text-dim)" }}>
                    <span>{item.cwd.split("/").filter(Boolean).pop() || item.cwd}</span>
                    <span>{new Date(item.interruptedAt).toLocaleString()}</span>
                    {item.turnInterrupted
                      ? <span style={{ color: "#d97706" }}>⚠ {t("chat.restartRecoveryInterrupted")}</span>
                      : <span>✓ {t("chat.restartRecoveryCompleted")}</span>}
                  </div>
                  {(item.lastPrompt || item.lastAssistant) && (
                    <div style={{ marginTop: 7, display: "grid", gap: 4 }}>
                      {item.lastPrompt && (
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                          <span style={{
                            flexShrink: 0, minWidth: 34, textAlign: "center",
                            fontSize: 10, fontWeight: 650, padding: "1px 6px", borderRadius: 5,
                            marginTop: 1.5, color: "var(--text-muted)", border: "1px solid var(--border)",
                          }}>{t("chat.restartRecoveryLastUser")}</span>
                          <span style={previewTextStyle}>{item.lastPrompt}</span>
                        </div>
                      )}
                      {item.lastAssistant && (
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                          <span style={{
                            flexShrink: 0, minWidth: 34, textAlign: "center",
                            fontSize: 10, fontWeight: 650, padding: "1px 6px", borderRadius: 5,
                            marginTop: 1.5, color: "var(--accent)",
                            border: "1px solid color-mix(in srgb, var(--accent) 40%, transparent)",
                            background: "color-mix(in srgb, var(--accent) 6%, transparent)",
                          }}>{t("chat.restartRecoveryLastAi")}</span>
                          <span style={{ ...previewTextStyle, color: "var(--text-muted)" }}>{item.lastAssistant}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </button>
            );
          })}

          {active && items.length === 0 && (
            <div style={{ padding: "18px 10px", textAlign: "center", color: "var(--text-dim)", fontSize: 12.5 }}>
              {t("chat.restartRecoveryEmptyQueue")}
            </div>
          )}

          {active && items.map((item) => {
            const checked = selected.has(item.id);
            return (
              <button
                key={item.id}
                onClick={() => toggle(item.id)}
                aria-pressed={checked}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 11,
                  width: "100%", padding: "9px 11px", borderRadius: 8,
                  border: `1px solid ${checked ? "color-mix(in srgb, var(--accent) 50%, var(--border))" : "var(--border)"}`,
                  background: checked ? "color-mix(in srgb, var(--accent) 6%, var(--bg-panel))" : "var(--bg-panel)",
                  cursor: "pointer", textAlign: "left",
                  transition: "border-color 0.12s, background 0.12s",
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(item.id)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ marginTop: 3, accentColor: "var(--accent)", width: 15, height: 15, flexShrink: 0, cursor: "pointer" }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{
                      fontSize: 10, fontWeight: 650, letterSpacing: "0.05em", textTransform: "uppercase",
                      padding: "2px 8px", borderRadius: 999,
                      border: item.kind === "steer" ? "1px solid color-mix(in srgb, var(--accent) 40%, transparent)" : "1px solid var(--border)",
                      color: item.kind === "steer" ? "var(--accent)" : "var(--text-dim)",
                      background: item.kind === "steer" ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "transparent",
                    }}>
                      {item.kind === "steer" ? t("chat.queueRecoveryKindSteer") : t("chat.queueRecoveryKindFollowUp")}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
                      {new Date(item.queuedAt).toLocaleString()}
                    </span>
                    {item.hasImages && (
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>📎 {t("chat.queueRecoveryImages")}</span>
                    )}
                  </div>
                  <div style={{
                    marginTop: 6, fontSize: 12.5, lineHeight: 1.55, color: "var(--text)",
                    whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 110, overflowY: "auto",
                    borderLeft: `2px solid ${checked ? "var(--accent)" : "var(--border)"}`, paddingLeft: 9,
                  }}>
                    {item.text || <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>{t("chat.queueRecoveryNoText")}</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ padding: "10px 14px 12px", borderTop: "1px solid var(--border)", display: "grid", gap: 9 }}>
          <div style={{
            display: "grid", gap: 8,
            ...(isMobile
              ? { gridTemplateColumns: "1fr 1fr" }
              : { gridTemplateColumns: "auto auto auto auto", justifyContent: "end", alignItems: "center" }),
          }}>
            {!active && pendingItems.length > 0 && (
              <button
                style={{ ...btnBase, color: "var(--text-muted)", background: "transparent", border: "none", padding: "6px 8px", ...(isMobile ? { justifySelf: "start" } : {}) }}
                onClick={() => { if (!busy) void doResolveAllDismiss(); }}
                disabled={busy}
              >
                {t("chat.restartRecoveryDismissAll")}
              </button>
            )}
            {active && (
              <>
                <button
                  style={{ ...btnBase, color: "var(--text-muted)", background: "transparent", border: "none", padding: "6px 8px", ...(isMobile ? { justifySelf: "start" } : {}) }}
                  onClick={() => { if (!busy) void doResolve({ dismiss: true }); }}
                  disabled={busy}
                  title={t("chat.restartRecoveryDismissSessionTitle")}
                >
                  {t("chat.restartRecoveryDismissSession")}
                </button>
                <button
                  style={dim(btnDanger, busy || !hasSelection)}
                  onClick={() => { if (hasSelection) void doResolve({ discard: selectedIds }); }}
                  disabled={busy || !hasSelection}
                >
                  {t("chat.queueRecoveryDiscard")}
                </button>
                <button
                  style={dim(btnPrimary, busy || !hasSelection)}
                  onClick={() => { if (hasSelection) void doResolve({ keep: selectedIds }); }}
                  disabled={busy || !hasSelection}
                >
                  {t("chat.queueRecoveryRequeue")}
                </button>
                <button
                  style={dim(btnPrimarySolid, busy || (!active.resumable))}
                  onClick={() => { void doResolve({ keep: selectedIds, continueRun: true }); }}
                  disabled={busy || !active.resumable}
                  title={t("chat.restartRecoveryContinueTitle", { continue: t("chat.continue") })}
                >
                  {t("chat.restartRecoveryContinue")}
                </button>
              </>
            )}
          </div>
          {status && (
            <div style={{
              display: "flex", alignItems: "center", gap: 6, fontSize: 12,
              padding: "5px 9px", borderRadius: 7,
              background: status.ok ? "color-mix(in srgb, #22c55e 9%, transparent)" : "color-mix(in srgb, #ef4444 9%, transparent)",
              color: status.ok ? "#16a34a" : "#ef4444",
              border: `1px solid ${status.ok ? "color-mix(in srgb, #22c55e 30%, transparent)" : "color-mix(in srgb, #ef4444 30%, transparent)"}`,
            }}>
              {status.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  async function doResolveAllDismiss() {
    setBusy(true);
    try {
      for (const item of pendingItems) {
        await fetch(apiUrl("/api/agent/recovery/resolve"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: item.sessionId, sessionFile: item.sessionFile, dismiss: true }),
        });
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }
}

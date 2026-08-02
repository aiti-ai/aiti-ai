"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { QueueEntry } from "@/lib/queue-store";
import { queueToMarkdown, queueToJson, downloadQueueExport } from "@/lib/queue-export";
import {
  promptsToMarkdown,
  promptsToJson,
  downloadText,
  type PromptExportEntry,
} from "@/lib/export-prompts";

type Tab = "prompts" | "queue";
type Format = "md" | "json";

interface Props {
  sessionId: string;
  /** Resolve queue entries (live + recovery) — wired to exportQueueData. */
  onExportQueue: () => Promise<{ live: QueueEntry[]; recovery: QueueEntry[] } | null>;
  onClose: () => void;
}

function toDateTimeLocal(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const PAGE_SIZES = [10, 20, 50];

export function ExportDialog({ sessionId, onExportQueue, onClose }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();

  const [tab, setTab] = useState<Tab>("prompts");
  const [format, setFormat] = useState<Format>("md");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);

  // Prompts data (user messages from the session file).
  const [prompts, setPrompts] = useState<PromptExportEntry[] | null>(null);
  const [compactionCount, setCompactionCount] = useState(0);
  const [promptError, setPromptError] = useState<string | null>(null);

  // Queue data.
  const [queue, setQueue] = useState<QueueEntry[] | null>(null);

  // Filters + selection.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context`);
        const data = await res.json();
        const ctx = data?.context;
        const messages: Array<{ role?: string; content?: unknown; timestamp?: number }> = ctx?.messages ?? [];
        const entryIds: string[] = ctx?.entryIds ?? [];
        const userPrompts = messages
          .map((m, i) => ({ role: m.role, content: m.content, timestamp: m.timestamp, entryId: entryIds[i] }))
          .filter((m) => m.role === "user")
          .map((m) => {
            let text = "";
            if (typeof m.content === "string") text = m.content.trim();
            else if (Array.isArray(m.content)) {
              text = m.content
                .map((b) => {
                  if (typeof b === "object" && b && (b as { type?: string }).type === "text") return (b as { text?: string }).text ?? "";
                  if (typeof b === "object" && b && (b as { type?: string }).type === "image") return "[image]";
                  return "";
                })
                .filter(Boolean)
                .join("\n")
                .trim();
            }
            return { id: m.entryId, timestamp: m.timestamp, text };
          })
          .filter((p) => p.text);
        if (!cancelled) {
          setPrompts(userPrompts);
          setCompactionCount(0); // file has no compaction markers via this API; kept for future
          setSelected(new Set(userPrompts.map((_, i) => i)));
          // Default the time range to the session's first/last prompt (minute precision).
          const ts = userPrompts.map((p) => p.timestamp).filter((v): v is number => !!v);
          if (ts.length > 0) {
            setDateFrom(toDateTimeLocal(Math.min(...ts)));
            setDateTo(toDateTimeLocal(Math.max(...ts)));
          }
        }
      } catch (e) {
        if (!cancelled) setPromptError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  const loadQueue = useCallback(async () => {
    if (queue !== null) return;
    setBusy(true);
    try {
      const data = await onExportQueue();
      if (data) {
        setQueue([...data.live, ...data.recovery]);
        setSelected(new Set([...data.live, ...data.recovery].map((_, i) => i)));
      }
    } catch (e) {
      setStatus({ text: String(e), ok: false });
    } finally {
      setBusy(false);
    }
  }, [onExportQueue, queue]);

  useEffect(() => {
    if (tab === "queue") void loadQueue();
  }, [tab, loadQueue]);

  // Time-range filter (applies to prompts; queue entries carry queuedAt too).
  const filteredPrompts = useMemo(() => {
    if (!prompts) return [];
    const from = dateFrom ? new Date(dateFrom).getTime() : 0;
    const to = dateTo ? new Date(dateTo).getTime() : Infinity;
    return prompts.filter((p) => !p.timestamp || (p.timestamp >= from && p.timestamp <= to));
  }, [prompts, dateFrom, dateTo]);

  const filteredQueue = useMemo(() => {
    if (!queue) return [];
    const from = dateFrom ? new Date(dateFrom).getTime() : 0;
    const to = dateTo ? new Date(dateTo).getTime() : Infinity;
    return queue.filter((q) => !q.queuedAt || (q.queuedAt >= from && q.queuedAt <= to));
  }, [queue, dateFrom, dateTo]);

  const filtered = tab === "prompts" ? filteredPrompts : filteredQueue;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageItems = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  const toggle = (idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };
  // 全选/反选作用于当前页（pageItems 的全局索引）。
  const pageGlobalIndexes = pageItems.map((_, i) => currentPage * pageSize + i);
  const selectPage = () => {
    setSelected((prev) => new Set([...prev, ...pageGlobalIndexes]));
  };
  const invertPage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const gi of pageGlobalIndexes) {
        if (next.has(gi)) next.delete(gi);
        else next.add(gi);
      }
      return next;
    });
  };

  const exportSelected = useCallback(() => {
    const items = filtered.filter((_, i) => selected.has(i));
    if (items.length === 0) {
      setStatus({ text: t("export.noneSelected"), ok: false });
      return;
    }
    setBusy(true);
    try {
      if (tab === "prompts") {
        const entries = items as PromptExportEntry[];
        const meta = { sessionId, compactionCount };
        const content = format === "md" ? promptsToMarkdown(entries, meta) : promptsToJson(entries, meta);
        downloadText(content, `prompts-${sessionId}.${format === "md" ? "md" : "json"}`, format === "md" ? "text/markdown" : "application/json");
      } else {
        const entries = items as QueueEntry[];
        const meta = { sessionId, source: "live" as const };
        downloadQueueExport(entries, meta, format);
      }
      setStatus({ text: t("export.done", { count: String(items.length) }), ok: true });
    } catch (e) {
      setStatus({ text: String(e), ok: false });
    } finally {
      setBusy(false);
    }
  }, [filtered, selected, tab, format, sessionId, compactionCount, t]);

  const label = (item: PromptExportEntry | QueueEntry, idx: number) => {
    if (tab === "prompts") {
      const p = item as PromptExportEntry;
      const ts = p.timestamp ? new Date(p.timestamp).toLocaleString() : "";
      return { ts, text: p.text };
    }
    const q = item as QueueEntry;
    const ts = q.queuedAt ? new Date(q.queuedAt).toLocaleString() : "";
    const kind = q.kind === "steer" ? "steer" : "follow-up";
    return { ts, text: `${kind}${q.text ? ": " + q.text : ""}` };
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.45)",
        padding: isMobile ? 8 : 24,
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
          width: isMobile ? "100%" : 560,
          maxWidth: "100%",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{t("export.title")}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            {(["prompts", "queue"] as Tab[]).map((tb) => (
              <button
                key={tb}
                type="button"
                onClick={() => { setTab(tb); setPage(0); }}
                style={{
                  padding: "4px 10px",
                  fontSize: 12,
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: tab === tb ? "var(--bg-selected)" : "transparent",
                  color: tab === tb ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                {t(tb === "prompts" ? "export.promptsTab" : "export.queueTab")}
              </button>
            ))}
          </div>
          <button type="button" onClick={onClose} title={t("export.close")} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 16, padding: "0 4px" }}>✕</button>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "1px solid var(--border)", fontSize: 12, flexWrap: "wrap" }}>
          <label style={{ color: "var(--text-muted)" }}>{t("export.dateFrom")}</label>
          <input type="datetime-local" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(0); }} style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: 12, padding: "2px 4px" }} />
          <label style={{ color: "var(--text-muted)" }}>{t("export.dateTo")}</label>
          <input type="datetime-local" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(0); }} style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: 12, padding: "2px 4px" }} />
          <button type="button" onClick={selectPage} style={{ marginLeft: "auto", fontSize: 12, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}>
            {t("export.selectAll")}
          </button>
          <button type="button" onClick={invertPage} style={{ fontSize: 12, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}>
            {t("export.selectInvert")}
          </button>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflow: "auto", minHeight: 200 }}>
          {promptError && <div style={{ padding: 12, color: "red", fontSize: 12 }}>{promptError}</div>}
          {tab === "queue" && !queue && !busy && <div style={{ padding: 12, color: "var(--text-muted)", fontSize: 12 }}>{t("export.loading")}</div>}
          {filtered.length === 0 && (
            <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>{t("export.empty")}</div>
          )}
          {pageItems.map((item, i) => {
            const { ts, text } = label(item, currentPage * pageSize + i);
            const globalIdx = currentPage * pageSize + i;
            return (
              <div
                key={globalIdx}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "6px 14px",
                  borderBottom: "1px solid var(--border)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
                onClick={() => toggle(globalIdx)}
              >
                <input type="checkbox" checked={selected.has(globalIdx)} readOnly style={{ marginTop: 2, accentColor: "var(--accent)" }} />
                <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>{ts}</span>
                <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{text}</span>
              </div>
            );
          })}
        </div>

        {/* Pagination */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderTop: "1px solid var(--border)", fontSize: 12 }}>
          <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} style={{ border: "1px solid var(--border)", borderRadius: 4, background: "none", color: "var(--text)", cursor: currentPage === 0 ? "not-allowed" : "pointer", padding: "2px 8px", opacity: currentPage === 0 ? 0.4 : 1 }}>‹</button>
          <span>{currentPage + 1} / {pageCount}</span>
          <button type="button" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)} style={{ border: "1px solid var(--border)", borderRadius: 4, background: "none", color: "var(--text)", cursor: currentPage >= pageCount - 1 ? "not-allowed" : "pointer", padding: "2px 8px", opacity: currentPage >= pageCount - 1 ? 0.4 : 1 }}>›</button>
          <label style={{ marginLeft: "auto", color: "var(--text-muted)" }}>{t("export.perPage")}</label>
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }} style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: 12 }}>
            {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {/* Footer */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("export.selected", { count: String(filtered.filter((_, i) => selected.has(i)).length) })}</span>
          {status && <span style={{ fontSize: 12, color: status.ok ? "#4ade80" : "red" }}>{status.text}</span>}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <select value={format} onChange={(e) => setFormat(e.target.value as Format)} style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: 12, padding: "4px 6px" }}>
              <option value="md">Markdown</option>
              <option value="json">JSON</option>
            </select>
            <button
              type="button"
              onClick={exportSelected}
              disabled={busy}
              style={{
                padding: "5px 14px",
                fontSize: 12,
                borderRadius: 6,
                border: "none",
                background: "var(--accent)",
                color: "white",
                cursor: busy ? "not-allowed" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? t("export.busy") : t("export.button", { count: String(filtered.filter((_, i) => selected.has(i)).length) })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * export-dialog —— 「导出 Prompts」弹窗（defork B2：自 pi-web fork components/ExportDialog
 * 的 prompts 页签外迁重建；队列页签不迁——live 队列导出已在 aiti-queue-keeper 面板、
 * 恢复队列导出在 QueueRecoveryDialog、移动端 ＋面板另有独立入口，三重覆盖）。
 *
 * 入口：sessionTopbar 按钮（props.currentSession 提供 sessionId）→ 模块级 store 打开
 * dialogs 插槽弹窗。数据源：core /api/sessions/[id]/context（公开 API，机制留核）。
 */

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { apiUrl, t } from "./host-shim";
import {
  promptsToMarkdown,
  promptsToJson,
  downloadText,
  type PromptExportEntry,
} from "./export-prompts";

type Format = "md" | "json";

// ── 模块级开合状态（sessionTopbar 按钮 → dialogs 弹窗） ──
const listeners = new Set<() => void>();
const store: { open: boolean; sessionId: string | null } = { open: false, sessionId: null };
function notify() { for (const l of [...listeners]) l(); }
export function openExportDialog(sessionId: string) {
  store.open = true;
  store.sessionId = sessionId;
  notify();
}
function closeExportDialog() {
  store.open = false;
  notify();
}
function useSyncStore(): typeof store {
  // useSyncExternalStore 委托（host-shim 无该 hook，退化为手动订阅）
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return store;
}

function toDateTimeLocal(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  // 带秒：默认值=min/max 时间戳，截断到分钟会把恰在 max 上的 prompt 过滤掉（深审 2026-09-16）
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const PAGE_SIZES = [10, 20, 50];

/**
 * toolbar 声明式注册（无 render）：宿主渲染标准图标按钮；静态桩阶段点击经
 * staticClickForwarder 物化后转发 meta.onClick。sessionId 不经 onClick 传——
 * 弹窗自己从 dialogs 插槽 props.currentSession 取（懒物化两阶段都成立）。
 */
export function exportPromptsOnClick() {
  openExportDialog(null);
}

/** dialogs 插槽弹窗（open 信号由 store 驱动；sessionId 取自插槽 props.currentSession）。 */
export function ExportPromptsDialog(props: Record<string, any>) {
  const s = useSyncStore();
  const sessionIdFromSlot = typeof props?.currentSession?.id === "string" ? props.currentSession.id : null;
  const [format, setFormat] = useState<Format>("md");
  const [prompts, setPrompts] = useState<PromptExportEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionId = s.sessionId ?? sessionIdFromSlot;

  useEffect(() => {
    if (!s.open || !sessionId) return;
    let cancelled = false;
    setPrompts(null);
    setError(null);
    setPage(0);
    setSelected(new Set());
    (async () => {
      try {
        const res = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/context`));
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
        if (cancelled) return;
        setPrompts(userPrompts);
        setSelected(new Set(userPrompts.map((_, i) => i)));
        const ts = userPrompts.map((p) => p.timestamp).filter((v): v is number => !!v);
        if (ts.length > 0) {
          setDateFrom(toDateTimeLocal(Math.min(...ts)));
          setDateTo(toDateTimeLocal(Math.max(...ts)));
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [s.open, sessionId]);

  const filtered = useMemo(() => {
    if (!prompts) return [] as Array<{ p: PromptExportEntry; oi: number }>;
    const from = dateFrom ? new Date(dateFrom).getTime() : 0;
    const to = dateTo ? new Date(dateTo).getTime() : Infinity;
    // 携带原数组索引——selection 语义恒为原数组位，时间过滤后不错位（深审 2026-09-16）
    return prompts.map((p, oi) => ({ p, oi })).filter(({ p }) => !p.timestamp || (p.timestamp >= from && p.timestamp <= to));
  }, [prompts, dateFrom, dateTo]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageItems = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  const toggle = (oi: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(oi)) next.delete(oi);
      else next.add(oi);
      return next;
    });
  };
  const pageOrigIndexes = pageItems.map((x) => x.oi);
  const selectPage = () => setSelected((prev) => new Set([...prev, ...pageOrigIndexes]));
  const invertPage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const oi of pageOrigIndexes) {
        if (next.has(oi)) next.delete(oi);
        else next.add(oi);
      }
      return next;
    });
  };

  const flash = (text: string, ok: boolean) => {
    setStatus({ text, ok });
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), 2500);
  };

  const exportSelected = useCallback(() => {
    const items = filtered.filter(({ oi }) => selected.has(oi)).map(({ p }) => p);
    if (items.length === 0) {
      flash(t("exportPrompts.noneSelected"), false);
      return;
    }
    setBusy(true);
    try {
      const meta = { sessionId: sessionId ?? undefined };
      const content = format === "md" ? promptsToMarkdown(items, meta) : promptsToJson(items, meta);
      downloadText(content, `prompts-${sessionId}.${format}`, format === "md" ? "text/markdown" : "application/json");
      flash(t("exportPrompts.done", { count: String(items.length) }), true);
    } catch (e) {
      flash(String(e), false);
    } finally {
      setBusy(false);
    }
  }, [filtered, selected, format, sessionId]);

  if (!s.open) return null;

  const smallBtn = { background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "3px 8px" } as const;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)", padding: 16 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) closeExportDialog(); }}
    >
      <div
        data-ext-float="1"
        data-ext-float-w="560"
        data-ext-float-h="480"
        style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,0.3)", width: "min(560px, 100%)", maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{t("exportPrompts.title")}</span>
          <button type="button" onClick={closeExportDialog} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 16, lineHeight: 1 }} aria-label={t("exportPrompts.close")}>✕</button>
        </div>

        <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8, overflow: "auto", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("exportPrompts.dateFrom")}</span>
            <input type="datetime-local" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(0); }} style={{ fontSize: 11, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", padding: "3px 6px" }} />
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("exportPrompts.dateTo")}</span>
            <input type="datetime-local" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(0); }} style={{ fontSize: 11, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", padding: "3px 6px" }} />
            <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              <button type="button" style={smallBtn} onClick={selectPage}>{t("exportPrompts.selectAll")}</button>
              <button type="button" style={smallBtn} onClick={invertPage}>{t("exportPrompts.selectInvert")}</button>
            </span>
          </div>

          {error ? (
            <span style={{ fontSize: 12, color: "#f87171" }}>{error}</span>
          ) : prompts === null ? (
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("exportPrompts.loading")}</span>
          ) : filtered.length === 0 ? (
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("exportPrompts.empty")}</span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {pageItems.map(({ p, oi }) => {
                return (
                  <label key={oi} style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer", fontSize: 12, color: "var(--text)" }}>
                    <input type="checkbox" checked={selected.has(oi)} onChange={() => toggle(oi)} style={{ marginTop: 2 }} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{p.timestamp ? new Date(p.timestamp).toLocaleString() : ""}</span>
                      <span style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as any, overflow: "hidden", whiteSpace: "pre-wrap" }}>{p.text}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("exportPrompts.perPage")}</span>
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }} style={{ fontSize: 11, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", padding: "2px 4px" }}>
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("exportPrompts.selected", { count: String(selected.size) })}</span>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            {status && <span style={{ fontSize: 11, color: status.ok ? "#4ade80" : "#f87171" }}>{status.text}</span>}
            <button type="button" style={smallBtn} onClick={() => setFormat(format === "md" ? "json" : "md")}>{format === "md" ? "MD" : "JSON"}</button>
            <button type="button" onClick={exportSelected} disabled={busy} style={{ ...smallBtn, color: "var(--text)", fontWeight: 600 }}>{busy ? t("exportPrompts.busy") : t("exportPrompts.button", { count: String(filtered.filter(({ oi }) => selected.has(oi)).length) })}</button>
          </span>
        </div>
      </div>
    </div>
  );
}

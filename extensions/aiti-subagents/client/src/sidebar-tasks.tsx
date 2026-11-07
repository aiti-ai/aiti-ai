/**
 * sidebar-tasks —— aiti-subagents 的 sidebarTasks 插槽组件（aiti-float dock 方案 v0.5.1 §4.4.2）。
 *
 * 宿主 SessionSidebar 渲染折叠头（▾ 任务）+ 本组件；无 items 时宿主整块不渲染。
 * 数据：fleet/status 拉一次 + fleet/events SSE 事件驱动刷新（红线：零轮询）。
 * 交互：点击任务 → pi-web:open-session 在 SPA 内打开对应会话（openSessionByFile 语义，
 * 与 Fleet 面板一致；本文件自带一份精简实现避免与 entry 相互 import 成环）。
 */
import { useEffect, useState } from "react";
import { apiUrl } from "./host-shim";

type FleetRun = {
  id?: string;
  agent?: string;
  status?: string;
  task?: string;
  turns?: number;
  sessionFile?: string;
  startedAt?: number | string;
};
type FleetState = { running?: FleetRun[]; recent?: FleetRun[] };

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "5px 10px 5px 14px",
  background: "none",
  border: "none",
  color: "var(--text)",
  cursor: "pointer",
  fontSize: 12,
  textAlign: "left",
};

export function SidebarTasksSection() {
  const [state, setState] = useState<FleetState>({});

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch(apiUrl("/api/extensions/aiti-subagents/fleet/status"))
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (alive && d) setState(d); })
        .catch(() => {});
    };
    load();
    // fleet/events SSE：事件触发即整刷（EventSource 规范自动重连；引擎未起时 204 重连无害）
    let es: EventSource | undefined;
    try {
      es = new EventSource(apiUrl("/api/extensions/aiti-subagents/fleet/events"));
      es.onmessage = (e) => {
        if (!e.data || e.data === "heartbeat") return;
        try { const ev = JSON.parse(e.data); if (ev && ev.type) load(); } catch { /* 畸形帧 */ }
      };
    } catch { /* ignore */ }
    return () => { alive = false; try { es?.close(); } catch { /* ignore */ } };
  }, []);

  const running = state.running ?? [];
  const recent = (state.recent ?? []).slice(0, 5);

  const openByFile = (file?: string) => {
    if (!file) return;
    fetch(apiUrl("/api/sessions?refresh=1"))
      .then((r) => r.json())
      .then((d) => {
        const rows = d?.sessions || [];
        const row = rows.find((x: { path?: string }) => x.path === file)
          || rows.find((x: { path?: string }) => x.path && file.endsWith(x.path))
          || rows.find((x: { id?: string }) => x.id === file);
        if (!row) return;
        window.dispatchEvent(new CustomEvent("pi-web:open-session", { detail: { id: row.id } }));
        window.dispatchEvent(new Event("sm:sessions-changed"));
      })
      .catch(() => {});
  };

  if (running.length === 0 && recent.length === 0) {
    return (
      <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--text-dim)" }}>还没有任务</div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", paddingBottom: 4 }}>
      {running.length > 0 && (
        <div style={{ padding: "4px 14px 2px", fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          运行中 {running.length}
        </div>
      )}
      {running.map((r, i) => (
        <button key={"r" + (r.id ?? i)} type="button" style={rowStyle} onClick={() => openByFile(r.sessionFile)} title={r.task || r.agent || ""}>
          <span style={{ width: 7, height: 7, borderRadius: 99, background: "var(--warn, #f59e0b)", flexShrink: 0, animation: "pi-spin 1s linear infinite" }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {r.agent || "subagent"} · {r.task || "…"}
          </span>
        </button>
      ))}
      {recent.length > 0 && (
        <div style={{ padding: "6px 14px 2px", fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          最近完成
        </div>
      )}
      {recent.map((r, i) => {
        const ok = r.status === "ok" || r.status === "success" || r.status === "completed";
        return (
          <button key={"p" + (r.id ?? i)} type="button" style={rowStyle} onClick={() => openByFile(r.sessionFile)} title={r.task || r.agent || ""}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: ok ? "#10b981" : "var(--text-dim)", flexShrink: 0 }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, color: "var(--text-muted)" }}>
              {r.agent || "subagent"} · {r.task || "…"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * aiti-subagents client entry —— JSX + vite 构建版（自手写 h() 一比一迁移，SOP §三）。
 *
 * 结构变化仅「组件从 register 闭包提升到模块作用域」（原版经 ctx 解构取原语，现经 host-shim
 * import，语义等价）；逻辑与行为 1:1，无迁移修正项。
 *
 * UI：
 *   - 工具栏舰队按钮（声明式条目：meta.icon + onClick，宿主统一渲染）→ Fleet 面板
 *   - Fleet 面板（dialogs）：运行中/最近完成分组树，SSE 实时刷新
 *   - 检查器（dialogs）：单次运行详情（摘要/输出/运行报告/工具调用/原始数据）+ steer 输入行
 *   - Agent 管理器（dialogs）：内置/自定义 agent 列表 + 编辑器（执行器接管/新建/删除）
 */

import { useEffect, useRef, useState } from "react";
import { __setCtx, apiUrl, createElement } from "./host-shim";
import { SidebarTasksSection } from "./sidebar-tasks";

type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | string;
type FleetRun = {
  id: string;
  agent?: string;
  status?: RunStatus;
  task?: string;
  cwd?: string;
  turns?: number;
  tokens?: number;
  model?: string;
  durationMs?: number;
  startedAt?: number | string;
  createdAt?: number;
  sessionFile?: string;
  parentSessionFile?: string;
  parentTitle?: string;
};
type FleetState = { running?: FleetRun[]; recent?: FleetRun[]; agentCount?: number; runCount?: number; engine?: string };
type AgentDef = {
  name: string;
  description?: string;
  model?: string;
  tools?: string[];
  excludeTools?: string[];
  systemPrompt?: string;
  isUserDefined?: boolean;
  runner?: { type?: string; adapter?: string; backend?: string; command?: string; options?: { backend?: string } };
};
type BackendDef = { key: string; label?: string };

// ---- 模块级面板开关（多处入口共享）----
// dock v3（P2 批）：Fleet 面板显隐收口展示状态机（openFloat/closePanel）；渲染门控 useGate
import { useGate, usePresent, DockBody, openFloat, closePanel, seedDockDefault, declareDockZones, presentState, useGateSidebar, sidebarZoneOf } from "../../../_shared/ext-float-dock";
// dock 头工具条 v3（方案 pi-web-dock-header-toolbar-plan）：face 声明按钮、内容实现命令+状态
import { useDockCommands, useDockHeaderState, useDockHeaderStateOf, requestDockCommand } from "../../../_shared/ext-float-dock";
import type { DockHeaderAction } from "../../../_shared/ext-float-dock";

const FLEET_KEY = "aiti-subagents:fleet";
function setFleetOpen(v: boolean) { if (v) openFloat(FLEET_KEY); else closePanel(FLEET_KEY); }

let inspectorOpen = false;
let activeRunId: string | null = null;
const inspectorListeners = new Set<() => void>();
function setInspectorOpen(v: boolean) { inspectorOpen = v; for (const l of inspectorListeners) l(); }
function openInspector(runId: string) { activeRunId = runId; inspectorOpen = true; for (const l of inspectorListeners) l(); }

let agentsOpen = false;
const agentsListeners = new Set<() => void>();
function setAgentsOpen(v: boolean) { agentsOpen = v; for (const l of agentsListeners) l(); }

let cfgOpen = false;
const cfgListeners = new Set<() => void>();
function setCfgOpen(v: boolean) { cfgOpen = v; for (const l of cfgListeners) l(); }

// ---- 工具 ----
function fmtDuration(ms?: number): string {
  if (!ms) return "进行中";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}
// 状态颜色（图标见 STATUS_PATHS，lucide clock/loader/check/x/ban）
function statusMeta(status?: RunStatus): string {
  return ({
    pending: "#a0a0a0", running: "#00d4ff",
    completed: "var(--ok, #10b981)", failed: "var(--danger, #ef4444)", cancelled: "#a0a0a0",
  } as Record<string, string>)[status as string] || "#888";
}

// ---- 图标（与系统统一：lucide 风格线条 SVG，同 AppShell/aiti-cmd）----
type IconPath = [string, Record<string, unknown>];
const STATUS_PATHS: Record<string, IconPath[]> = {
  pending: [["circle", { cx: 12, cy: 12, r: 10 }], ["polyline", { points: "12 6 12 12 16 14" }]],
  running: [["path", { d: "M21 12a9 9 0 1 1-9-9" }]],
  completed: [["path", { d: "M20 6 9 17l-5-5" }]],
  failed: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
  cancelled: [["circle", { cx: 12, cy: 12, r: 10 }], ["path", { d: "m4.9 4.9 14.2 14.2" }]],
};
// 内置 agent 图标：scout=search / worker=wrench / reviewer=eye / oracle=sparkles /
// researcher=book-open / delegate=bot；未知回退 users
const USERS_PATHS: IconPath[] = [
  ["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }],
  ["circle", { cx: 9, cy: 7, r: 4 }],
  ["path", { d: "M22 21v-2a4 4 0 0 0-3-3.87" }],
  ["path", { d: "M16 3.13a4 4 0 0 1 0 7.75" }],
];
const AGENT_PATHS: Record<string, IconPath[]> = {
  scout: [["circle", { cx: 11, cy: 11, r: 8 }], ["path", { d: "m21 21-4.3-4.3" }]],
  worker: [["path", { d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" }]],
  reviewer: [["path", { d: "M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" }], ["circle", { cx: 12, cy: 12, r: 3 }]],
  oracle: [
    ["path", { d: "M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.13 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z" }],
    ["path", { d: "M20 3v4" }], ["path", { d: "M22 5h-4" }],
  ],
  researcher: [["path", { d: "M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" }], ["path", { d: "M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" }]],
  delegate: [["path", { d: "M12 8V4H8" }], ["rect", { width: 16, height: 12, x: 4, y: 8, rx: 2 }], ["path", { d: "M2 14h2" }], ["path", { d: "M20 14h2" }], ["path", { d: "M15 13v2" }], ["path", { d: "M9 13v2" }]],
};

// 线条 SVG 工厂（系统统一风格）；paths: [tag, attrs][]
function iconSvg(paths: IconPath[], s = 16) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths.map(([tag, attrs], i) => createElement(tag, { key: "i" + i, ...attrs }))}
    </svg>
  );
}
const statusIcon = (status?: RunStatus, s = 13) => iconSvg(STATUS_PATHS[status as string] || STATUS_PATHS.pending, s);
const agentIconEl = (name?: string, s = 14) => iconSvg(AGENT_PATHS[name as string] || USERS_PATHS, s);
const FLEET_ICON = (s = 16) => iconSvg(USERS_PATHS, s);

// dock 头工具条 v3 图标（刷新 / Agent 管理）
const REFRESH_PATHS: IconPath[] = [["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }], ["path", { d: "M3 3v5h5" }]];
const GEAR_PATHS: IconPath[] = [
  ["circle", { cx: 12, cy: 12, r: 3 }],
  ["path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" }],
];
const RefreshIcon = () => iconSvg(REFRESH_PATHS, 13);
const AgentsIcon = () => iconSvg(GEAR_PATHS, 13);

function useFleetOpen(): boolean {
  return usePresent(FLEET_KEY) !== "closed";
}

function useInspectorOpen() {
  const [open, setOpen] = useState(inspectorOpen);
  useEffect(() => {
    const l = () => setOpen(inspectorOpen);
    inspectorListeners.add(l);
    return () => inspectorListeners.delete(l);
  }, []);
  return open;
}

// ---- Fleet 状态 + SSE 实时订阅（仅面板打开时连接，关闭即清理）----
function useFleetState(open: boolean, reloadKey: number): FleetState {
  const [state, setState] = useState<FleetState>({ running: [], recent: [], agentCount: 0, runCount: 0 });
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () => {
      fetch(apiUrl("/api/extensions/aiti-subagents/fleet/status"))
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (alive && d) setState(d); })
        .catch(() => {});
    };
    load();
    // SSE：事件触发时刷新完整状态（EventSource 规范自动重连，onerror 不手动 close）。
    // fork 引擎下端点返回 204：EventSource 自动重连无害，刷新靠打开 + ⟳ 按钮。
    let es: EventSource | undefined;
    try {
      es = new EventSource(apiUrl("/api/extensions/aiti-subagents/fleet/events"));
      es.onmessage = (e) => {
        if (!e.data || e.data === "heartbeat") return;
        try { const ev = JSON.parse(e.data); if (ev && ev.type) load(); } catch {}
      };
    } catch {}
    return () => { alive = false; if (es) es.close(); };
  }, [open, reloadKey]);
  return state;
}

// ---- 轻提示 toast（openSessionByFile 等操作反馈；常驻 DOM，事件驱动）----
(function installToast() {
  try {
    const el = document.createElement("div");
    el.style.cssText = "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9900;background:var(--bg-panel,#1a1a2e);color:var(--text,#eee);border:1px solid var(--border,#444);border-radius:8px;padding:8px 16px;font-size:12px;box-shadow:0 6px 24px rgba(0,0,0,0.35);display:none;pointer-events:none;";
    document.body.appendChild(el);
    let timer: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener("aiti-subagents:toast", (e) => {
      el.textContent = String((e as CustomEvent).detail ?? "");
      el.style.display = "block";
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { el.style.display = "none"; }, 2600);
    });
  } catch { /* 非 DOM 环境 */ }
})();
function setMsgGlobal(t: string) { try { window.dispatchEvent(new CustomEvent("aiti-subagents:toast", { detail: t })); } catch {} }

// ---- 会话跳转（SPA 内打开，面板保持）----
// 通过 /api/sessions（refresh=1 绕 5s TTL）把 sessionFile/父会话路径解析成会话 id，
// 再经 AppShell 事件在当前页面内打开消息窗口；同时刷新左侧树。
async function openSessionByFile(file: string, label?: string): Promise<boolean> {
  try {
    const d = await fetch(apiUrl("/api/sessions?refresh=1")).then((r) => r.json());
    const rows = d?.sessions || [];
    const row = rows.find((s: { path?: string; id?: string }) => s.path === file) || rows.find((s: { path?: string }) => s.path && file && file.endsWith(s.path)) || rows.find((s: { id?: string }) => s.id === file);
    if (!row) { setMsgGlobal(`未在索引中找到${label || "会话"}（稍后重试）`); return false; }
    // AppShell 事件通道：SPA 内切换会话（面板保持），不依赖 session-manager open-live
    window.dispatchEvent(new CustomEvent("pi-web:open-session", { detail: { id: row.id } }));
    window.dispatchEvent(new Event("sm:sessions-changed")); // 左侧树同步刷新
    setMsgGlobal(`已打开${label || "会话"}窗口`);
    return true;
  } catch (e) {
    setMsgGlobal("打开失败: " + (e instanceof Error ? e.message : String(e)));
    return false;
  }
}

// ---- Agent 编辑器 ----
/** 设置风格自定义下拉（替代原生 select：fixed 弹窗内原生弹层易闪退；fixed 定位防滚动容器裁剪）。 */
function ConfigSelect({ value, options, onChange }: { value: string; options: { value: string; label: string; disabled?: boolean }[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const el = btnRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      const up = window.innerHeight - r.bottom < 260 && r.top > 260;
      setPos({ top: up ? undefined : r.bottom + 4, bottom: up ? window.innerHeight - r.top + 4 : undefined, left: r.left, width: Math.max(r.width, 260) });
    }
    const onDoc = (e: MouseEvent) => { const t = e.target as Node; if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return; setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [open]);

  const current = options.find((o) => o.value === value);
  return (
    <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(!open)}
        style={{ width: "100%", height: 34, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, padding: "0 9px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 12, cursor: "pointer", textAlign: "left" }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: current ? "var(--text)" : "var(--text-dim)" }}>{current ? current.label : "选择…"}</span>
        <span style={{ flexShrink: 0, fontSize: 9, color: "var(--text-dim)", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>{"▾"}</span>
      </button>
      {open && pos && (
        <div
          ref={popRef}
          style={{ position: "fixed", top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, zIndex: 3400, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 10px 28px rgba(0,0,0,0.28)", padding: 4, maxHeight: 250, overflowY: "auto" }}
        >
          {options.map((o) => (
            <div
              key={o.value}
              title={o.label}
              onMouseDown={(e) => { e.preventDefault(); if (o.disabled) return; onChange(o.value); setOpen(false); }}
              onMouseEnter={(e) => { if (!o.disabled && o.value !== value) e.currentTarget.style.background = "var(--bg-hover, rgba(127,127,127,0.14))"; }}
              onMouseLeave={(e) => { if (o.value !== value) e.currentTarget.style.background = "transparent"; }}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 9px", borderRadius: 5, fontSize: 12, lineHeight: 1.4, cursor: o.disabled ? "not-allowed" : "pointer", color: o.disabled ? "var(--text-dim)" : "var(--text)", background: o.value === value ? "var(--bg-hover, rgba(127,127,127,0.14))" : "transparent", fontWeight: o.value === value ? 600 : 400 }}
            >
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.label}</span>
              {o.value === value && <span style={{ flexShrink: 0, fontSize: 11, color: "var(--accent, #7c8cff)" }}>{"✓"}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Agent 管理主体（列表 + 编辑模态 + CRUD/接管）——浮窗版与设置页植入版共用。 */
function AgentsManagerBody({ embedded }: { embedded?: boolean }) {
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [editing, setEditing] = useState<null | "new" | AgentDef>(null); // null=未编辑 | "new"=新建 | agent obj=编辑
  const [form, setForm] = useState<Record<string, string>>({ name: "", description: "", model: "", tools: "", excludeTools: "", systemPrompt: "", runnerKind: "keep", runnerAdapter: "claude-code", runnerCommand: "" });
  const [backends, setBackends] = useState<BackendDef[]>([]);
  const [msg, setMsg] = useState("");

  const load = () => {
    fetch(apiUrl("/api/extensions/aiti-subagents/agents"))
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setAgents(Array.isArray(d) ? d : []))
      .catch(() => {});
  };
  // 挂载即加载（浮窗打开 = 挂载；设置页植入版随页签挂载——之后手动「↻ 刷新」）
  useEffect(() => { load(); }, []);
  // pi-web 启动类后端清单（执行器下拉；挂载时刷新一次）
  useEffect(() => {
    fetch(apiUrl("/api/extensions/aiti-subagents/agents/backends"))
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setBackends(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

  // 对齐系统设置表单语言（AgentsConfig controlStyle / config-field-label 同款）
  const inputStyle: Record<string, string | number> = {
    width: "100%", minWidth: 0, boxSizing: "border-box", height: 34, padding: "0 9px",
    border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
  };
  const labelStyle: Record<string, string | number> = { display: "block", fontSize: 11, fontWeight: 500, color: "var(--text-muted)", marginBottom: 4, marginTop: 10 };
  const set = (k: string) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  // 编辑默认 "keep"（保持原样）——用户不主动改执行器就绝不重建 runner 块，
  // 块内未在表单呈现的字段（promptDelivery/capabilities/未来扩展）零丢失。
  const runnerCurrentLabel = (runner?: AgentDef["runner"]) => !runner || runner.type === "pi" ? "内置 pi"
    : runner.type === "external-job" ? `pi-web 会话（${runner.backend || runner.options?.backend || "pi"}）`
    : `外部 CLI ${runner.adapter}${runner.command ? `（${runner.command}）` : ""}`;
  const runnerState = (agent: AgentDef) => ({
    runnerKind: "keep",
    runnerAdapter: agent.runner?.adapter || agent.runner?.backend || "claude-code",
    runnerCommand: agent.runner?.command || "",
    runnerCurrent: runnerCurrentLabel(agent.runner),
  });
  const applyForm = (agent: AgentDef) => setForm({
    name: agent.name, description: agent.description || "", model: agent.model || "",
    tools: (agent.tools || []).join(", "), excludeTools: (agent.excludeTools || []).join(", "),
    systemPrompt: agent.systemPrompt || "",
    ...runnerState(agent),
  });

  const startEdit = (agent: AgentDef | null) => {
    setEditing(agent ? { ...agent } : "new");
    setMsg("");
    if (!agent) { setForm({ name: "", description: "", model: "", tools: "", excludeTools: "", systemPrompt: "", runnerKind: "pi", runnerAdapter: "claude-code", runnerCommand: "", runnerCurrent: "" }); return; }
    // 列表项不含 systemPrompt，需拉单个详情回填（否则编辑会把系统提示词清空保存）
    setForm({ name: agent.name, description: agent.description || "", model: agent.model || "",
      tools: (agent.tools || []).join(", "), excludeTools: (agent.excludeTools || []).join(", "), systemPrompt: "", ...runnerState(agent) });
    fetch(apiUrl(`/api/extensions/aiti-subagents/agents/${encodeURIComponent(agent.name)}`))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && d.name === agent.name) applyForm(d); })
      .catch(() => {});
  };

  const save = async () => {
    const body = {
      name: form.name.trim(), description: form.description.trim(),
      model: form.model.trim() || undefined,
      tools: form.tools ? form.tools.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      excludeTools: form.excludeTools ? form.excludeTools.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      systemPrompt: form.systemPrompt,
      // 执行器：external-cli / pi-web(external-job) → runner 块落盘；pi → 删除 runner（回退内置）；keep → 不动
      runner: form.runnerKind === "external-cli"
        ? { type: "external-cli", adapter: form.runnerAdapter, command: form.runnerCommand.trim() || undefined }
        : form.runnerKind === "pi-web"
          ? { type: "external-job", provider: "pi-web-rpc", options: { backend: form.runnerAdapter || "pi" } }
          : form.runnerKind === "pi" ? { type: "pi" } : undefined,
    };
    const r = await fetch(apiUrl("/api/extensions/aiti-subagents/agents"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d?.ok) { setMsg("已保存（覆盖内置需同名）"); setEditing(null); load(); }
    else setMsg("❌ " + (d?.error || "保存失败"));
  };

  const takeOver = async (name: string) => {
    const r = await fetch(apiUrl("/api/extensions/aiti-subagents/agents/takeover"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    });
    const d = await r.json();
    setMsg(d?.ok ? `${name} 已由 pi-web 后端 ${d.backend} 接管（删除自定义可恢复 fork 直启）` : "❌ " + (d?.error || "接管失败"));
    load();
  };

  const del = async (name: string) => {
    const r = await fetch(apiUrl(`/api/extensions/aiti-subagents/agents/${encodeURIComponent(name)}`), { method: "DELETE" });
    const d = await r.json();
    setMsg(d?.ok ? (d?.restored ? "已删除自定义，恢复默认" : "已删除") : "❌ " + (d?.error || "删除失败"));
    load();
  };

  // 编辑弹窗（独立层，叠在列表之上；关编辑不关列表）
  const editOverlay = editing !== null ? (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 3310, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => { setEditing(null); setMsg(""); }}
    >
      <div
        style={{ width: 520, maxHeight: "85vh", display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", boxShadow: "0 10px 40px rgba(0,0,0,0.35)", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)", userSelect: "none" }}>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{editing === "new" ? "新建 Agent" : `编辑 Agent · ${editing.name}`}</span>
          <button title="关闭编辑" onClick={() => { setEditing(null); setMsg(""); }} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, padding: 2 }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 14px 10px" }}>
          <label style={labelStyle}>{"名称（字母/数字/下划线/连字符）"}</label>
          <input style={inputStyle} value={form.name} disabled={editing !== "new"} onChange={set("name")} placeholder="my-agent" />
          <label style={labelStyle}>{"描述"}</label>
          <input style={inputStyle} value={form.description} onChange={set("description")} placeholder="这个 agent 做什么" />
          <label style={labelStyle}>{"模型（可选，如 claude-haiku-4-5；留空继承父会话）"}</label>
          <input style={inputStyle} value={form.model} onChange={set("model")} placeholder="留空 = 继承父模型" />
          <label style={labelStyle}>{`执行器（外部 CLI 或 pi-web 会话——决定 fork 用什么启动这个子代理）${form.runnerCurrent ? `　当前：${form.runnerCurrent}` : ""}`}</label>
          <div style={{ display: "flex", gap: 6 }}>
            <ConfigSelect
              value={form.runnerKind}
              options={[
                { value: "keep", label: form.runnerCurrent ? `保持原样（${form.runnerCurrent}）` : "保持原样", disabled: !form.runnerCurrent },
                { value: "pi", label: "内置 pi" },
                { value: "external-cli", label: "外部 CLI（Claude Code / Codex / Cursor）" },
                { value: "pi-web", label: "pi-web 会话（RPC/ACP，可从前端 attach）" },
              ]}
              onChange={(v) => setForm({ ...form, runnerKind: v })}
            />
            {form.runnerKind === "external-cli" && (
              <ConfigSelect
                value={form.runnerAdapter}
                options={["claude-code", "claude-code-writer", "codex-exec", "codex-exec-writer", "cursor-agent", "cursor-agent-writer"].map((a) => ({ value: a, label: a }))}
                onChange={(v) => setForm({ ...form, runnerAdapter: v })}
              />
            )}
            {form.runnerKind === "pi-web" && (
              <ConfigSelect
                value={form.runnerAdapter}
                options={(backends.length ? backends : [{ key: "pi", label: "pi（内置 RPC 会话）" }]).map((b) => ({ value: b.key, label: b.label || b.key }))}
                onChange={(v) => setForm({ ...form, runnerAdapter: v })}
              />
            )}
          </div>
          {form.runnerKind === "external-cli" && <input style={{ ...inputStyle, marginTop: 6 }} value={form.runnerCommand} onChange={set("runnerCommand")} placeholder="命令（留空按 adapter 默认：claude / codex / cursor-agent）" />}
          {form.runnerKind === "pi-web" && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>{"子代理将启动为真正的 pi-web 会话：出现在会话列表、可实时打开观察、可 steer。"}</div>}
          <label style={labelStyle}>{"tools 白名单（逗号分隔，留空 = 全部系统工具）"}</label>
          <input style={inputStyle} value={form.tools} onChange={set("tools")} placeholder="read, grep, find, ls, bash, edit, write" />
          <label style={labelStyle}>{"excludeTools 黑名单（逗号分隔，排除交互类等）"}</label>
          <input style={inputStyle} value={form.excludeTools} onChange={set("excludeTools")} placeholder="user_confirm, user_input" />
          <label style={labelStyle}>{"系统提示词（给子代理 LLM 的角色定义）"}</label>
          <textarea style={{ ...inputStyle, minHeight: 160, fontFamily: "var(--font-mono, monospace)", lineHeight: 1.5, resize: "vertical" }} value={form.systemPrompt} onChange={set("systemPrompt")} placeholder="你是 ..." />
        </div>
        <div style={{ display: "flex", gap: 8, padding: "8px 14px", borderTop: "1px solid var(--border)", alignItems: "center" }}>
          <span style={{ flex: 1, fontSize: 11, color: "var(--text-dim)" }}>{msg}</span>
          <button className="config-button config-button-secondary config-button-small" onClick={() => { setEditing(null); setMsg(""); }}>{"取消"}</button>
          <button className="config-button config-button-primary config-button-small" onClick={save}>{"保存"}</button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      {editOverlay}
      <div style={{ padding: "8px 12px", display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "var(--text-dim)", flex: 1 }}>{`${agents.length} 个 agent（用户自定义覆盖内置，编辑保存即生效）`}</span>
        {embedded && (
          <button onClick={() => setFleetOpen(true)} title="打开子代理舰队（运行总览 / 检查器 / 委派）" style={{ background: "rgba(0,212,255,0.12)", border: "1px solid rgba(0,212,255,0.3)", color: "#00d4ff", borderRadius: 6, padding: "3px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>{"子代理舰队"}</button>
        )}
        <button onClick={load} title="重新加载列表" style={{ background: "none", border: "1px solid var(--border)", color: "var(--text-muted)", borderRadius: 6, padding: "3px 10px", fontSize: 12, cursor: "pointer" }}>{"↻ 刷新"}</button>
        <button onClick={() => startEdit(null)} style={{ background: "rgba(0,212,255,0.12)", border: "1px solid rgba(0,212,255,0.3)", color: "#00d4ff", borderRadius: 6, padding: "3px 12px", fontSize: 12, cursor: "pointer" }}>{"＋ 新建"}</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 8px", minHeight: 0 }}>
        {agents.map((a) => (
          <div key={a.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", marginBottom: 4 }}>
            <span style={{ fontWeight: 600, fontSize: 12, width: 90, flexShrink: 0 }}>{a.name}</span>
            <span
              title={a.runner ? runnerCurrentLabel(a.runner) : "内置 pi 执行器"}
              style={{ fontSize: 9, padding: "0 5px", borderRadius: 6, flexShrink: 0, background: !a.runner ? "rgba(0,212,255,0.1)" : a.runner.type === "external-job" ? "color-mix(in srgb, var(--ok, var(--ok, #10b981)) 15%, transparent)" : "rgba(168,85,247,0.15)", color: !a.runner ? "#00d4ff" : a.runner.type === "external-job" ? "var(--ok, #10b981)" : "#a855f7" }}
            >
              {!a.runner
                ? "pi"
                : a.runner.type === "external-job"
                  ? `pw:${a.runner.backend || "pi"}`
                  : ({ "claude-code": "CC", "claude-code-writer": "CC✎", "codex-exec": "codex", "codex-exec-writer": "codex✎", "cursor-agent": "cursor", "cursor-agent-writer": "cursor✎" } as Record<string, string>)[a.runner.adapter || ""] || a.runner.adapter}
            </span>
            <span style={{ flex: 1, fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.description || "(无描述)"}</span>
            {a.isUserDefined && <span style={{ fontSize: 9, padding: "0 5px", borderRadius: 6, background: "color-mix(in srgb, var(--ok, var(--ok, #10b981)) 15%, transparent)", color: "var(--ok, #10b981)", flexShrink: 0 }}>{"自定义"}</span>}
            {!a.isUserDefined && a.runner?.type === "external-cli" && (() => {
              const backend = ({ "claude-code": "claude", "claude-code-writer": "claude", "codex-exec": "codex", "codex-exec-writer": "codex", "cursor-agent": "cursor", "cursor-agent-writer": "cursor" } as Record<string, string>)[a.runner?.adapter || ""];
              const ready = backend && backends.some((b) => b.key === backend);
              return (
                <button
                  disabled={!ready}
                  title={ready ? `执行替换为 pi-web 后端 ${backend}（同名覆盖，删除自定义即恢复 fork 直启）` : `pi-web 后端 ${backend || "?"} 未就绪`}
                  onClick={() => takeOver(a.name)}
                  style={{ background: ready ? "color-mix(in srgb, var(--ok, var(--ok, #10b981)) 12%, transparent)" : "none", border: `1px solid ${ready ? "color-mix(in srgb, var(--ok, var(--ok, #10b981)) 40%, transparent)" : "var(--border)"}`, color: ready ? "var(--ok, #10b981)" : "var(--text-dim)", borderRadius: 4, padding: "1px 8px", fontSize: 11, cursor: ready ? "pointer" : "not-allowed", flexShrink: 0, opacity: ready ? 1 : 0.55 }}
                >
                  {"接管"}
                </button>
              );
            })()}
            <button onClick={() => startEdit(a)} style={{ background: "none", border: "1px solid var(--border)", color: "var(--text-muted)", borderRadius: 4, padding: "1px 8px", fontSize: 11, cursor: "pointer", flexShrink: 0 }}>{"编辑"}</button>
            {a.isUserDefined && <button onClick={() => del(a.name)} title="删除自定义（恢复默认）" style={{ background: "none", border: "1px solid var(--danger, #ef4444)", color: "var(--danger, #ef4444)", borderRadius: 4, padding: "1px 8px", fontSize: 11, cursor: "pointer", flexShrink: 0 }}>{"删除"}</button>}
          </div>
        ))}
      </div>
      <div style={{ padding: "4px 12px", fontSize: 11, color: "var(--text-dim)", borderTop: "1px solid var(--border)" }}>{msg || "内置 agent 编辑保存后以同名覆盖（删除恢复默认）"}</div>
    </div>
  );
}

/** 设置「子代理」页签整页接管（settingsAgents 插槽）：Agent 管理直接植入设置面板，替换原生 AgentsConfig。 */
function AgentsSettingsPanel(_props: { currentSession?: unknown; cwd?: string; sessionId?: string | null; onClose?: () => void }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: "var(--text)", overflow: "hidden" }}>
      <AgentsManagerBody embedded />
    </div>
  );
}

function AgentsDialog() {
  const [open, setOpen] = useState(agentsOpen);
  useEffect(() => {
    const l = () => setOpen(agentsOpen);
    agentsListeners.add(l);
    return () => agentsListeners.delete(l);
  }, []);

  if (!open) return null;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 3300, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => setAgentsOpen(false)}
    >
      <div
        data-ext-float="1"
        data-ext-float-w="560" data-ext-float-h="520"
        data-ext-float-min-w="420" data-ext-float-min-h="360"
        data-ext-float-full="1"
        style={{ width: 560, height: 520, display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", boxShadow: "0 10px 40px rgba(0,0,0,0.35)", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)", cursor: "grab", userSelect: "none" }}>
          <span style={{ color: "var(--text-muted)", display: "flex" }}>{FLEET_ICON(14)}</span>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{"Agent 管理"}</span>
          <button title="关闭" onClick={() => setAgentsOpen(false)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, padding: 2 }}>✕</button>
        </div>
        <AgentsManagerBody />
      </div>
    </div>
  );
}

// ---- 并发配置 dialog（读写上游 <agentDir>/extensions/subagent/config.json；
//      保存即生效——上游 loadConfig 每次 spawn 实时读文件；变更处理归本扩展自己，不写死到任何宿主面板） ----
function ConcurrencyDialog() {
  const [open, setOpen] = useState(cfgOpen);
  useEffect(() => {
    const l = () => setOpen(cfgOpen);
    cfgListeners.add(l);
    return () => { cfgListeners.delete(l); };
  }, []);

  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetch(apiUrl("/api/extensions/aiti-subagents/config"))
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        const v: Record<string, string> = {};
        for (const m of d.meta ?? []) {
          const cur = m.key.split(".").reduce<any>((o, k) => (o && typeof o === "object" ? o[k] : undefined), d.config);
          v[m.key] = cur === undefined || cur === null ? "" : String(cur);
        }
        setVals(v);
      })
      .catch(() => setMsg("加载失败"));
  };
  useEffect(() => { if (open) { setMsg(""); load(); } }, [open]); // 打开拉一次；保存后重拉（变更自己处理，零轮询）

  if (!open) return null;

  // capacitySlotMs 展示为分钟（false 原样）；其余原样
  const displayVal = (m: { type?: string }, raw: string) => {
    if (m.type !== "capacitySlotMs" || raw === "" || raw === "false") return raw;
    const n = Number(raw);
    return Number.isFinite(n) ? String(Math.round(n / 60000)) : raw;
  };
  const defText = (m: { key: string; type?: string }) => {
    const d = (data?.defaults as Record<string, unknown> | undefined)?.[m.key];
    if (d === null || d === undefined) return "默认 不限";
    return `默认 ${m.type === "capacitySlotMs" ? `${Math.round(Number(d) / 60000)}min` : d}`;
  };
  const save = async (config: Record<string, unknown>) => {
    setBusy(true); setMsg("");
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-subagents/config"), {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config }),
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) setMsg("❌ " + (d.error || `HTTP ${r.status}`));
      else { setMsg("已保存，对新启动的子代理立即生效"); load(); }
    } catch (e) { setMsg("❌ " + e); }
    setBusy(false);
  };

  const inputStyle: Record<string, string | number> = { width: 96, padding: "3px 8px", fontSize: 12, fontFamily: "var(--font-mono, monospace)", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", outline: "none", minWidth: 0 };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 3300, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setCfgOpen(false)}>
      <div
        data-ext-float="1"
        data-ext-float-w="560" data-ext-float-h="520"
        data-ext-float-min-w="420" data-ext-float-min-h="360"
        data-ext-float-full="1"
        style={{ width: 560, height: 520, display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", boxShadow: "0 10px 40px rgba(0,0,0,0.35)", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)", cursor: "grab", userSelect: "none" }}>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{"子代理并发配置"}</span>
          <button title="关闭" onClick={() => setCfgOpen(false)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, padding: 2 }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 14px", minHeight: 0 }}>
          {data?.readable === false ? (
            <div style={{ fontSize: 12, color: "var(--danger, #ef4444)", lineHeight: 1.6 }}>{`配置文件损坏，拒绝读写：${data.path}（${data.error}）——先手工修复后再试`}</div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 8 }}>
                {"四层闸门：单 run 并发 → 单 run 累计 → 会话累计 → 跨 run 活跃顶层 async 数（唯一能拦跨 run 并发的闸门，2026-10-10 12 路并行事故漏配的维度）。留空=不改；↺=回退缺省。保存后对新启动的子代理立即生效，无需重启。"}
              </div>
              {((data?.meta as { key: string; type?: string; label: string; desc: string }[] | undefined) ?? []).map((m) => (
                <div key={m.key} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 9px", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12, fontWeight: 600, flex: 1, minWidth: 120 }} title={m.key}>{m.label}</span>
                    <input
                      value={displayVal(m, vals[m.key] ?? "")}
                      disabled={busy}
                      title={m.key}
                      onChange={(e) => {
                        const input = e.target.value;
                        setVals((prev) => ({ ...prev, [m.key]: m.type === "capacitySlotMs" && input !== "" && input !== "false" && Number.isFinite(Number(input)) ? String(Number(input) * 60000) : input }));
                      }}
                      placeholder={defText(m)}
                      style={inputStyle}
                    />
                    <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 70 }}>{defText(m)}</span>
                    <button
                      disabled={busy}
                      title="恢复缺省（删除该键）"
                      onClick={() => void save({ [m.key]: null })}
                      style={{ background: "none", border: "1px solid var(--border)", color: "var(--text-muted)", borderRadius: 4, padding: "1px 8px", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
                    >{"↺"}</button>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45, marginTop: 3 }}>{m.desc}</div>
                </div>
              ))}
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, padding: "8px 14px", borderTop: "1px solid var(--border)", alignItems: "center" }}>
          <span style={{ flex: 1, fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{msg || String(data?.path ?? "")}</span>
          <button
            className="config-button config-button-primary config-button-small"
            disabled={busy}
            onClick={() => {
              const config: Record<string, unknown> = {};
              for (const m of (data?.meta as { key: string; type?: string; label: string }[] | undefined) ?? []) {
                const s = String(vals[m.key] ?? "").trim();
                if (s === "") continue;
                if (m.type === "capacitySlotMs") {
                  if (s !== "false" && !Number.isFinite(Number(s))) { setMsg(`「${m.label}」请输入分钟数或 false`); return; }
                  config[m.key] = s === "false" ? false : Number(s) * 60000;
                } else {
                  if (!Number.isFinite(Number(s))) { setMsg(`「${m.label}」请输入数字`); return; }
                  config[m.key] = Number(s);
                }
              }
              if (!Object.keys(config).length) { setMsg("请先填入要修改的值（留空=不改）"); return; }
              void save(config);
            }}
          >{busy ? "保存中…" : "保存"}</button>
        </div>
      </div>
    </div>
  );
}

// ---- Fleet 面板 ----
/** Fleet 内容体（分组树 + 底栏）：浮窗/停靠两面共用（dock v3 P2）。仅激活面挂载，open 恒 true。
 *  dockItemKey 仅左栏区块 face 传（v3：刷新/Agent 管理按钮上提 dock 头，内容区不再重复）。 */
function FleetBody(props?: { dockItemKey?: string }) {
  const dockKey = typeof props?.dockItemKey === "string" && props.dockItemKey ? props.dockItemKey : undefined;
  const [reloadKey, setReloadKey] = useState(0);
  // 委派生命周期信号（pi-web core 在 subagent 工具执行 / subagent-* 消息时广播）：列表即时刷新
  useEffect(() => {
    const onActivity = () => setReloadKey((k) => k + 1);
    window.addEventListener("aiti-subagents:activity", onActivity);
    return () => window.removeEventListener("aiti-subagents:activity", onActivity);
  }, []);
  const state = useFleetState(true, reloadKey);

  const running = state.running || [];
  const recent = (state.recent || []).slice(0, 12);
  const all = [...running, ...recent];

  // 父会话分组树（对齐上游 TUI fleetView：父 run → 子代理行）
  const groups = new Map<string, { key: string; title: string; runs: FleetRun[] }>();
  for (const run of all) {
    const key = run.parentSessionFile || " __orphan__";
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: run.parentTitle || (run.parentSessionFile ? key.split("/").pop()?.replace(/\.jsonl$/, "") || "" : ""),
        runs: [],
      });
    }
    groups.get(key)!.runs.push(run);
  }
  const groupList = [...groups.values()].sort((a, b) => {
    const aRunning = a.runs.some((r) => r.status === "running");
    const bRunning = b.runs.some((r) => r.status === "running");
    if (aRunning !== bRunning) return aRunning ? -1 : 1; // 有运行中的组在前
    const aT = Math.max(...a.runs.map((r) => r.createdAt || 0));
    const bT = Math.max(...b.runs.map((r) => r.createdAt || 0));
    return bT - aT;
  });
  const openSession = (file: string) => { try { window.dispatchEvent(new CustomEvent("pi-web:open-session", { detail: { file } })); } catch {} };

  // dock 头工具条 v3：命令实现 + 状态上报（按钮由 face 声明；跑动数经 count 徽标显示）
  useDockCommands(dockKey, dockKey ? {
    refresh: () => setReloadKey((k) => k + 1),
    agents: () => setAgentsOpen(true),
  } : null);
  useDockHeaderState(dockKey, dockKey ? { runningCount: running.length, total: all.length } : null);

  return (
    <>
      {/* 运行列表（父会话分组树：父会话组头 → 子代理行，对齐上游 TUI fleetView） */}
      <div style={{ flex: 1, overflowY: "auto", padding: 6, minHeight: 0 }}>
        {all.length === 0 ? (
          <div style={{ textAlign: "center", color: "var(--text-muted)", padding: 40, fontSize: 12, whiteSpace: "pre-line" }}>
            {"暂无子代理运行。\n在 AI 会话中调用 subagent 工具，或让模型使用 scout/worker/reviewer。"}
          </div>
        ) : (
          groupList.map((group) => {
            const runningCount = group.runs.filter((r) => r.status === "running").length;
            const isOrphan = group.key === " __orphan__";
            return (
              <div key={group.key} style={{ marginBottom: 8 }}>
                {/* 父会话组头 */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", background: "rgba(128,128,128,0.08)", borderRadius: 6, marginBottom: 2 }}>
                  <span style={{ color: "var(--text-muted)", fontSize: 10 }}>{"▾"}</span>
                  <span style={{ flex: 1, fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={group.key}>
                    {isOrphan
                      ? `早期运行（父会话未知 · ${new Date(Math.max(...group.runs.map((r) => r.createdAt || 0))).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 前后）`
                      : group.title || "父会话"}
                  </span>
                  {runningCount > 0 && <span style={{ fontSize: 10, padding: "0 6px", borderRadius: 8, background: "rgba(0,212,255,0.15)", color: "#00d4ff" }}>{`${runningCount} 运行中`}</span>}
                  <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{`${group.runs.length} 子代理`}</span>
                  {!isOrphan && group.key && (
                    <button title="打开父会话" onClick={() => openSession(group.key)} style={{ background: "none", border: "1px solid var(--border)", color: "var(--text-muted)", borderRadius: 4, padding: "1px 8px", fontSize: 10, cursor: "pointer", flexShrink: 0 }}>{"打开"}</button>
                  )}
                </div>
                {/* 子代理行 */}
                {group.runs.map((run) => {
                  const color = statusMeta(run.status);
                  const rowBg = run.status === "running" ? "rgba(0,212,255,0.07)" : "transparent";
                  const wsBase = run.cwd ? String(run.cwd).split("/").filter(Boolean).pop() || "" : "";
                  const metaBits = [
                    run.turns ? `${run.turns} turns` : "",
                    run.tokens ? `${Math.round(run.tokens / 1000)}k tok` : "",
                    run.model ? run.model.split("/").pop() : "",
                  ].filter(Boolean).join(" · ");
                  const liveElapsed = run.status === "running" && run.startedAt ? fmtDuration(Date.now() - Number(run.startedAt)) : "";
                  return (
                    <div key={run.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px 6px 22px", borderRadius: 6, background: rowBg }}>
                      <span style={{ color: "var(--text-dim)", width: 12, flexShrink: 0, fontSize: 10 }}>{"└"}</span>
                      <span style={{ color, width: 16, display: "flex", justifyContent: "center", flexShrink: 0 }}>{statusIcon(run.status)}</span>
                      <span style={{ display: "flex", color: "var(--text-muted)", flexShrink: 0 }}>{agentIconEl(run.agent)}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flexShrink: 0 }}>{run.agent}</span>
                          {wsBase && <span title={run.cwd} style={{ fontSize: 10, padding: "0 6px", borderRadius: 8, background: "rgba(0,212,255,0.10)", border: "1px solid rgba(0,212,255,0.25)", color: "#00d4ff", flexShrink: 0, maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{`${wsBase}`}</span>}
                          <span style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{metaBits}</span>
                        </div>
                        <div title={run.task || ""} style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {(run.task || "").slice(0, 90) || "（无任务文本）"}
                        </div>
                      </div>
                      <span style={{ fontSize: 11, color: run.status === "running" ? "#00d4ff" : "var(--text-muted)", flexShrink: 0 }}>{liveElapsed || fmtDuration(run.durationMs)}</span>
                      {run.sessionFile && (
                        <button title="打开子代理会话（transcript 回看全过程）" onClick={() => openSession(run.sessionFile as string)} style={{ background: "none", border: "1px solid rgba(0,212,255,0.4)", color: "#00d4ff", borderRadius: 4, padding: "1px 6px", fontSize: 11, cursor: "pointer", flexShrink: 0 }}>{"会话"}</button>
                      )}
                      {run.status === "running" && (
                        <button
                          title="中止（/web 桥 abort 优先，回退 control inbox）"
                          onClick={() => {
                            fetch(apiUrl("/api/extensions/aiti-subagents/fleet/bridge"), {
                              method: "POST", headers: { "content-type": "application/json" },
                              body: JSON.stringify({ id: run.id, action: "abort" }),
                            }).then((r) => r.json()).then((r) => { if (!r.ok) alert("中止失败: " + (r.error || "未知")); }).catch(() => {});
                          }}
                          style={{ background: "none", border: "1px solid var(--border)", color: "var(--danger, #ef4444)", borderRadius: 4, padding: "1px 6px", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
                        >
                          {"■"}
                        </button>
                      )}
                      <button title="详情" onClick={() => openInspector(run.id)} style={{ background: "none", border: "1px solid var(--border)", color: "var(--text-muted)", borderRadius: 4, padding: "1px 8px", fontSize: 11, cursor: "pointer", flexShrink: 0 }}>{"详情"}</button>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
      {/* 底部 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-muted)" }}>
        <span style={{ flex: 1 }}>{`共 ${state.runCount} 次运行`}</span>
        <button title="刷新" aria-label="刷新" onClick={() => setReloadKey((k) => k + 1)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 13, padding: 2 }}>⟳</button>
        <button onClick={() => setAgentsOpen(true)} title="管理/自定义 agent 定义" style={{ background: "none", border: "1px solid var(--border)", color: "var(--text-muted)", borderRadius: 4, padding: "1px 8px", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
          {FLEET_ICON(11)}
          {"Agent 管理"}
        </button>
        <button onClick={() => setCfgOpen(true)} title="并发配置（单 run 并发 / 累计预算 / 跨 run 活跃顶层 async 数）" style={{ background: "none", border: "1px solid var(--border)", color: "var(--text-muted)", borderRadius: 4, padding: "1px 8px", fontSize: 11, cursor: "pointer" }}>{"并发"}</button>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: "var(--ok, #10b981)", display: "inline-block" }} />
          {"SSE 实时"}
        </span>
      </div>
    </>
  );
}

/** 浮窗 face（dialogs item）：仅 floating 态渲染（gate 是唯一渲染开关） */
function FleetDialog() {
  const open = useGate(FLEET_KEY, "float");
  // 打开面板即请求左侧树刷新（子代理 session 落盘晚于父会话消息，sidebar 缓存可能滞后）
  useEffect(() => {
    if (open) { try { window.dispatchEvent(new Event("sm:sessions-changed")); } catch {} }
  }, [open]);
  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 3100, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
      <div
        data-ext-float="1"
        data-ext-float-key={FLEET_KEY}
        data-ext-float-dock={`${sidebarZoneOf(FLEET_KEY)} right-panel`}
        data-ext-float-dock-default={sidebarZoneOf(FLEET_KEY)}
        data-ext-float-w="460" data-ext-float-h="380"
        data-ext-float-min-w="320" data-ext-float-min-h="220"
        data-ext-float-full="1"
        style={{
          pointerEvents: "auto",
          width: 460, height: 380, display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10,
          color: "var(--text)", boxShadow: "0 10px 40px rgba(0,0,0,0.35)", overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏（首个子元素 = aiti-float 拖拽把手） */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)", cursor: "grab", userSelect: "none" }}>
          <span style={{ color: "var(--text-muted)", display: "flex" }}>{FLEET_ICON(15)}</span>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{"子代理舰队"}</span>
          <span style={{ fontSize: 10, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 8, padding: "1px 8px" }}>{"fork 引擎"}</span>
          <button title="关闭" aria-label="关闭" onClick={() => setFleetOpen(false)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, padding: 2 }}>✕</button>
        </div>
        <FleetBody />
      </div>
    </div>
  );
}

/** 停靠 face（sidebarExplorerDock item "fleet"）：sidebar 族区块位（含旧 sidebar-explorer）渲染。
 *  v3 头工具条：Face 声明刷新/Agent 管理按钮（未挂载也可见，点击自动展开 + 排队补跑）；
 *  zone 用规范值 sidebar:<key>（旧 sidebar-explorer 兼容读，存量 dockpref 不受影响）。 */
function FleetDockLeft() {
  const docked = useGateSidebar(FLEET_KEY);
  const hs = useDockHeaderStateOf(FLEET_KEY);
  if (!docked) return null;
  const runningCount = typeof hs.runningCount === "number" ? hs.runningCount : 0;
  const actions: DockHeaderAction[] = [
    { id: "refresh", title: "刷新", icon: <RefreshIcon/>, visibility: "always", onClick: () => { requestDockCommand(FLEET_KEY, "refresh"); } },
    { id: "agents", title: "Agent 管理", icon: <AgentsIcon/>, visibility: "always", onClick: () => { requestDockCommand(FLEET_KEY, "agents"); } },
  ];
  return (
    <DockBody itemKey={FLEET_KEY} title="子代理舰队" chrome="section"
      count={runningCount > 0 ? runningCount : undefined}
      zones={[sidebarZoneOf(FLEET_KEY), "right-panel"]} defaultZone={sidebarZoneOf(FLEET_KEY)}
      headerActions={actions}>
      <FleetBody dockItemKey={FLEET_KEY} />
    </DockBody>
  );
}

/** 停靠 face（rightFileDock item "fleet"）：仅 docked:right-panel 渲染 */
function FleetDockRight() {
  const docked = useGate(FLEET_KEY, { dock: "right-panel" });
  if (!docked) return null;
  return (
    <DockBody itemKey={FLEET_KEY} zone="right-panel" title="子代理舰队" chrome="tab"
      zones={[sidebarZoneOf(FLEET_KEY), "right-panel"]} defaultZone={sidebarZoneOf(FLEET_KEY)}>
      <FleetBody />
    </DockBody>
  );
}

// ---- 消息输入行（fork 详情·运行中：向上游 control inbox 投递消息） ----
function SteerRow({ runId, active }: { runId: string; active: boolean }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const send = () => {
    if (!text.trim() || sending) return;
    setSending(true);
    // /web 桥优先（即时回执），后端自动回退 control inbox 文件投递
    fetch(apiUrl("/api/extensions/aiti-subagents/fleet/bridge"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: runId, action: "steer", message: text }),
    })
      .then((r) => r.json())
      .then((r) => {
        setMsg(r.ok ? "已投递" : "✕ " + (r.error || "失败"));
        if (r.ok) setText("");
      })
      .catch(() => setMsg("网络错误"))
      .finally(() => setSending(false));
  };
  return (
    <div style={{ display: "flex", gap: 6, padding: "8px 10px", borderTop: "1px solid var(--border)", alignItems: "center" }}>
      <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{"发消息:"}</span>
      <input
        value={text}
        disabled={!active || sending}
        placeholder={active ? "向运行中的子代理发消息…" : "run 已结束，不能发消息"}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === "Enter") send(); }}
        style={{ flex: 1, fontSize: 12, padding: "4px 8px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)" }}
      />
      <button
        onClick={send}
        disabled={!active || sending || !text.trim()}
        style={{ background: "none", border: "1px solid var(--border)", color: active && text.trim() ? "#00d4ff" : "var(--text-muted)", borderRadius: 4, padding: "3px 10px", fontSize: 11, cursor: active && text.trim() ? "pointer" : "default", flexShrink: 0 }}
      >
        {sending ? "…" : "发送"}
      </button>
      {msg && <span style={{ fontSize: 11, color: msg.startsWith("✓") ? "var(--ok, #10b981)" : "var(--danger, #ef4444)", flexShrink: 0 }}>{msg}</span>}
    </div>
  );
}

// ---- 检查器 ----
function InspectorDialog() {
  const open = useInspectorOpen();
  const [run, setRun] = useState<Record<string, unknown> | null>(null);
  const [tab, setTab] = useState("summary");
  const runId = activeRunId;

  useEffect(() => {
    if (!open || !runId) return;
    let alive = true;
    setRun(null);
    setTab("summary");
    // fork 引擎富详情（状态/steps/usage/cost/运行报告）
    fetch(apiUrl(`/api/extensions/aiti-subagents/fleet/run/${runId}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no fork detail"))))
      .then((d) => {
        if (!alive || !d) return;
        const stateMap: Record<string, string> = { complete: "completed", running: "running", queued: "pending", failed: "failed" };
        d.status = stateMap[d.state] || d.state || "unknown";
        setRun(d);
      })
      .catch(() => fetch(apiUrl(`/api/extensions/aiti-subagents/runs/${runId}`))
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (alive && d) setRun(d); })
        .catch(() => {}));
    return () => { alive = false; };
  }, [open, runId]);

  if (!open) return null;

  const tabs = [{ id: "summary", label: "摘要" }, { id: "output", label: "输出" }, { id: "report", label: "运行报告" }, { id: "tools", label: "工具调用" }, { id: "raw", label: "原始数据" }];
  const isForkDetail = Boolean(run && run.engine === "fork");

  let body: unknown = null;
  if (!run) {
    body = <div style={{ textAlign: "center", color: "var(--text-muted)", padding: 40, fontSize: 12 }}>{"加载中..."}</div>;
  } else {
    const color = statusMeta(run.status as RunStatus);
    const mono: Record<string, string | number> = { fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 };
    if (tab === "summary") {
      const totalTokens = run.totalTokens as number | { input?: number; output?: number; total?: number } | undefined;
      const cost = Number((run.totalCost as { costUsd?: number } | number | undefined)?.costUsd ?? run.totalCost ?? 0);
      body = (
        <div style={{ padding: 12, fontSize: 12, lineHeight: 1.7 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}><b>{"agent:"}</b>{agentIconEl(run.agent as string)}{run.agent}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <b>{"状态:"}</b>
            <span style={{ color, display: "flex" }}>{statusIcon(run.status as RunStatus)}</span>
            {run.status}
            {isForkDetail && run.pidAlive != null ? `（runner pid ${run.pid}${run.pidAlive ? " 存活" : " 已退出"}）` : ""}
          </div>
          {run.cwd ? <div><b>{"Workspace: "}</b><span title={String(run.cwd)} style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 11 }}>{String(run.cwd)}</span></div> : null}
          <div><b>{"耗时: "}</b>{fmtDuration(run.durationMs as number)}</div>
          <div><b>{"任务: "}</b>{String(run.task ?? "")}</div>
          {isForkDetail && (
            <div>
              <b>{"用量: "}</b>
              {`tokens ${typeof totalTokens === "object" && totalTokens ? `${totalTokens.input ?? 0}↑ ${totalTokens.output ?? 0}↓（总 ${totalTokens.total ?? 0}）` : String(totalTokens ?? "-")} · turns ${run.turnCount ?? "-"} · tool 调用 ${run.toolCount ?? "-"} · $${Number(cost).toFixed(4)}`}
            </div>
          )}
          {!isForkDetail && (run as { tokenUsage?: { input?: number; output?: number; cost?: number } }).tokenUsage ? (
            <div><b>{"用量: "}</b>{`↑${(run.tokenUsage as { input?: number }).input || 0} ↓${(run.tokenUsage as { output?: number }).output || 0} $${Number((run.tokenUsage as { cost?: number }).cost || 0).toFixed(4)}`}</div>
          ) : null}
          {isForkDetail && Array.isArray(run.steps) && (run.steps as unknown[]).length > 0 && (
            <div style={{ marginTop: 6 }}>
              <b>{"Steps:"}</b>
              {(run.steps as { agent: string; state?: string; description?: string }[]).map((s, i) => (
                <div key={i} style={{ fontSize: 11, color: "var(--text-muted)" }}>{`  ${i + 1}. ${s.agent} [${s.state || "?"}] ${String(s.description || "").slice(0, 80)}`}</div>
              ))}
            </div>
          )}
          {isForkDetail && (run as { steering?: { requested?: number; delivered?: number; pending?: number } }).steering && (
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {`发消息: 发起 ${(run.steering as { requested?: number }).requested ?? 0} · 已送达 ${(run.steering as { delivered?: number }).delivered ?? 0} · 待发 ${(run.steering as { pending?: number }).pending ?? 0}`}
            </div>
          )}
          {isForkDetail && (
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              {(run.sessionFile || run.childSessionFile) && (
                <button onClick={() => openSessionByFile((run.childSessionFile || run.sessionFile) as string, "子代理会话")} style={{ background: "none", border: "1px solid #00d4ff", color: "#00d4ff", borderRadius: 4, padding: "2px 10px", fontSize: 11, cursor: "pointer" }}>
                  {"打开子代理消息窗口"}
                </button>
              )}
              {(run.parentSessionFile || (run as { asyncDetail?: { parentSessionFile?: string } }).asyncDetail?.parentSessionFile) && (
                <button onClick={() => openSessionByFile((run.parentSessionFile || (run as { asyncDetail?: { parentSessionFile?: string } }).asyncDetail!.parentSessionFile) as string, "父会话")} style={{ background: "none", border: "1px solid var(--border)", color: "var(--text-muted)", borderRadius: 4, padding: "2px 10px", fontSize: 11, cursor: "pointer" }}>
                  {"↩ 打开父会话"}
                </button>
              )}
            </div>
          )}
          {isForkDetail && (run as { bridge?: { attached?: boolean; error?: string; state?: { isStreaming?: boolean; model?: { provider?: string; id?: string }; pendingMessageCount?: number }; recentMessages?: { role: string; text: string }[] } }).bridge && (() => {
            const bridge = (run as { bridge?: { attached?: boolean; error?: string; state?: { isStreaming?: boolean; model?: { provider?: string; id?: string }; pendingMessageCount?: number }; recentMessages?: { role: string; text: string }[] } }).bridge!;
            return bridge.attached ? (
              <div style={{ marginTop: 4, padding: "6px 8px", background: "color-mix(in srgb, var(--ok, var(--ok, #10b981)) 8%, transparent)", borderRadius: 6, fontSize: 11 }}>
                <div style={{ color: "var(--ok, #10b981)" }}>{`🟢 /web RPC 已连接 · ${bridge.state?.isStreaming ? "流式执行中" : "空闲"} · ${bridge.state?.model?.provider ?? ""}/${bridge.state?.model?.id ?? ""} · 待投递 ${bridge.state?.pendingMessageCount ?? 0}`}</div>
                {(bridge.recentMessages || []).slice(-3).map((m, i) => (
                  <div key={i} style={{ color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{`[${m.role}] ${m.text.slice(0, 120)}`}</div>
                ))}
              </div>
            ) : (
              <div style={{ marginTop: 4, padding: "6px 8px", background: "rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 11 }}>
                {`bridge 未连接（${bridge.error || "socket 不可达"}）——控制回退 control inbox 文件投递`}
              </div>
            );
          })()}
          {run.error ? <div style={{ color: "var(--danger, #ef4444)" }}><b>{"错误: "}</b>{String(run.error)}</div> : null}
        </div>
      );
    } else if (tab === "report") {
      body = (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", margin: 8 }}>
          <pre style={{ ...mono, padding: 12, background: "rgba(0,0,0,0.25)", borderRadius: 6, margin: 0 }}>{String(run.logMarkdown || "（fork 引擎无运行报告——run 未落盘或仍在进行）")}</pre>
        </div>
      );
    } else if (tab === "output") {
      // 弹性高度（flex:1 填满面板）——面板拉大/最大化时输出区跟着变大
      body = (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", margin: 8 }}>
          <pre style={{ ...mono, padding: 12, background: "rgba(0,0,0,0.25)", borderRadius: 6, margin: 0 }}>{String(run.output || "(无输出)")}</pre>
        </div>
      );
    } else if (tab === "tools") {
      const calls = (run.toolCalls as { tool: string; args?: unknown }[] | undefined) || [];
      body = (
        <div style={{ padding: 8, flex: 1, minHeight: 0, overflow: "auto" }}>
          {calls.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 12, padding: 8 }}>{"(无工具调用)"}</div>
          ) : (
            calls.map((tc, i) => (
              <div key={i} style={{ padding: "4px 8px", borderBottom: "1px solid var(--border)", fontSize: 11, display: "flex", gap: 8 }}>
                <span style={{ color: "#00d4ff", flexShrink: 0 }}>{tc.tool}</span>
                <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(tc.args || "")}</span>
              </div>
            ))
          )}
        </div>
      );
    } else {
      body = (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", margin: 8 }}>
          <pre style={{ ...mono, padding: 12, background: "rgba(0,0,0,0.25)", borderRadius: 6, margin: 0 }}>{JSON.stringify(run, null, 2)}</pre>
        </div>
      );
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 3200, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
      <div
        data-ext-float="1"
        data-ext-float-w="560" data-ext-float-h="460"
        data-ext-float-min-w="400" data-ext-float-min-h="300"
        data-ext-float-full="1"
        style={{ pointerEvents: "auto", width: 560, height: 460, display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", boxShadow: "0 10px 40px rgba(0,0,0,0.35)", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)", cursor: "grab", userSelect: "none" }}>
          <span style={{ color: "var(--text-muted)", display: "flex" }}>{iconSvg(AGENT_PATHS.scout, 14)}</span>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{`检查器${run ? ` · ${run.agent}` : ""}`}</span>
          <button title="关闭" aria-label="关闭" onClick={() => setInspectorOpen(false)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, padding: 2 }}>✕</button>
        </div>
        {/* tab 栏 */}
        <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border)", background: "rgba(0,0,0,0.15)" }}>
          {tabs.map((tb) => (
            <div
              key={tb.id}
              onClick={() => setTab(tb.id)}
              style={{
                padding: "6px 14px", fontSize: 12, cursor: "pointer",
                borderBottom: tab === tb.id ? "2px solid #00d4ff" : "2px solid transparent",
                color: tab === tb.id ? "#00d4ff" : "var(--text-muted)",
              }}
            >
              {tb.label}
            </div>
          ))}
        </div>
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>{body}</div>
        {/* steer 行：fork 详情且运行中时可用（向上游 control inbox 投递消息） */}
        {isForkDetail && <SteerRow runId={String(run!.id)} active={run!.status === "running"} />}
      </div>
    </div>
  );
}

/** 设置 Agents 页顶部 feature 区块接管（settingsAgentsFeature 跳板范式）：
 *  pi-subagents 引擎横幅 + 「打开子代理舰队」入口，替换原生「内置子代理」死开关。
 *  宿主（AgentsConfig）在扩展未注册时渲染原版开关区兑底。 */
function AgentsFeatureBanner({ cwd }: { cwd?: string; currentSession?: unknown; sessionId?: string | null }) {
  void cwd;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 200 }}>
        <span style={{ display: "inline-flex", color: "var(--accent)" }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </span>
        <strong style={{ fontSize: 13 }}>子代理引擎 · pi-subagents</strong>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>唯一引擎（内置子代理已禁用）；运行与 agent 管理都在舰队面板</span>
      </div>
      <button
        type="button"
        onClick={() => setFleetOpen(true)}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--accent)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
        title="打开子代理舰队（运行总览 / 检查器 / Agent 管理）"
      >
        <span style={{ display: "inline-flex" }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </span>
        打开子代理舰队
      </button>
    </div>
  );
}

export default function register(ctx: Record<string, unknown>) {
  // aiti-float dock v0.5.1：sidebarTasks「任务」区（float 方案 §4.4.2）——子代理任务列表。
  // 数据 = fleet/status + fleet/events SSE（事件驱动零轮询）；点击经 pi-web:open-session 打开会话。
  ctx.registerItems?.("sidebarTasks", [{ id: "tasks", render: SidebarTasksSection, meta: { title: "任务" } }]);
  __setCtx(ctx);
  const reg = ctx.registerItems as ((slot: string, items: unknown[]) => void) | undefined;
  // ---- 工具栏按钮 ----
  // ToolbarButton 已迁声明式条目（meta.icon + meta.onClick，宿主统一渲染按钮）
  reg?.("toolbar", [{
    id: "aiti-subagents",
    meta: {
      label: "子代理舰队",
      title: "子代理舰队",
      icon: "icons/users.svg",
      onClick: () => {
        // v3.1 修正：原 `!fleetOpen` 引用未定义标识符（点击 ReferenceError，工具条按钮失效）；
        // 且停靠后台态点击应「置前」而非 toggle 关闭——docked 一律 openFloat（幂等 open=激活）。
        const st = presentState(FLEET_KEY);
        if (st === "closed" || st.startsWith("docked:")) setFleetOpen(true);
        else setFleetOpen(false);
      },
    },
  }]);
  reg?.("dialogs", [
    { id: "aiti-subagents-fleet", render: FleetDialog, meta: { label: "子代理舰队" } },
    { id: "aiti-subagents-inspector", render: InspectorDialog, meta: { label: "子代理检查器" } },
    { id: "aiti-subagents-agents", render: AgentsDialog, meta: { label: "Agent 管理" } },
    { id: "aiti-subagents-concurrency", render: ConcurrencyDialog, meta: { label: "并发配置" } },
  ]);
  // aiti-float dock v3（P2 批）：Fleet 默认左栏（运行监控窄条驻留），右栏可选；行点击 Inspector 浮窗联动照旧
  // zone 规范值 sidebar:<key>（v4；旧 sidebar-explorer 兼容读，存量偏好不迁移也照常渲染）
  seedDockDefault(FLEET_KEY, sidebarZoneOf(FLEET_KEY));
  // zones 进注册表：TabBar ⇱ 菜单（后台 tab）也能看到 left⇄right 全集（v3.1）
  declareDockZones(FLEET_KEY, [sidebarZoneOf(FLEET_KEY), "right-panel"], sidebarZoneOf(FLEET_KEY));
  reg?.("sidebarExplorerDock", [{ id: "fleet", render: FleetDockLeft, meta: { title: "子代理舰队", priority: 1, maxHeightPct: 30 } }]); // 任务区块（默认序 1 + 次级限高 30%：项目→任务→文件→停靠）
  reg?.("rightFileDock", [{ id: "fleet", render: FleetDockRight, meta: { title: "舰队" } }]);
  // 设置 Agents 页顶部 feature 区块接管（pi-subagents 引擎横幅 + 打开舰队；未注册时宿主原版开关区兑底）
  reg?.("settingsAgentsFeature", [{ id: "engine-banner", render: AgentsFeatureBanner }]);
  reg?.("settingsAgents", [{ id: "agents-manager", render: AgentsSettingsPanel }]);

  console.log("[aiti-subagents] client 已注册（toolbar + fleet + inspector + agents + settingsAgents（设置页签整页接管），JSX 构建版）");
}

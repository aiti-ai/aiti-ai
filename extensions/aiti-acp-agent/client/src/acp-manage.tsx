/**
 * aiti-acp-agent · 重模块（懒 chunk，2026-09-14 薄壳拆分）。
 *
 * 所有设置集中在一个弹窗内（dialogs 插槽，AppShell 全局渲染、任意页面可弹出）：
 * agent 列表（状态点/名称/命令/agentKey/删除）+ 添加表单。
 * data-ext-float="1" → aiti-float 自动接管拖拽/缩放/位置持久化。
 *
 * 加载时机：只在用户打开面板（toolbar 🔌 / Backend 选择器旁入口 / 停靠面激活）时由
 * entry 薄壳经 _shared/ext-lazy 动态 import（首屏不加载；批量包把本 chunk 外置为
 * 文件 URL）。host-shim/ext-float-dock 由 rollup 收进共享 entry chunk，运行时单实例。
 */

import { useState, useEffect } from "react";
import { apiUrl } from "./host-shim";
import { ACP_KEY, PlugIcon, setDialogOpen } from "./common";
// dock v3（P2 批）：弹窗显隐收口展示状态机（左栏列表驻留，不接右栏）；渲染门控 usePresent
import { usePresent, DockBody, isSidebarDockState, sidebarZoneOf } from "../../../_shared/ext-float-dock";
// dock 头工具条 v3：face 声明按钮（刷新），内容实现命令 + 状态上报
import { useDockCommands, useDockHeaderState, useDockHeaderStateOf, requestDockCommand } from "../../../_shared/ext-float-dock";
import type { DockHeaderAction } from "../../../_shared/ext-float-dock";

// ---- API ----
interface AcpAgent { name: string; bin: string; args?: string[]; agentKey?: string; registered?: boolean }
async function fetchAgents(): Promise<{ agents: AcpAgent[]; builtinNames: string[] }> {
  const res = await fetch(apiUrl("/api/extensions/aiti-acp-agent/agents"));
  if (!res.ok) return { agents: [], builtinNames: [] };
  return res.json();
}
async function apiAddAgent(body: { name: string; bin: string; args: string[]; agentKey?: string }): Promise<boolean> {
  const res = await fetch(apiUrl("/api/extensions/aiti-acp-agent/agents"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}
async function apiRemoveAgent(name: string): Promise<boolean> {
  const res = await fetch(apiUrl(`/api/extensions/aiti-acp-agent/agents?name=${encodeURIComponent(name)}`), { method: "DELETE" });
  return res.ok;
}

// ---- 弹窗本体（dialogs 插槽；dock v3：双面 face 参数化，只有激活面渲染/拉数据）----
export function AcpDialog() { return renderAcpDialog("float"); }
export function AcpDockLeft() { return renderAcpDialog("left"); }
export function AcpDockRight() { return renderAcpDialog("right"); }

function renderAcpDialog(face?: string) {
  const st = usePresent(ACP_KEY);
  // 头行按钮状态（内容上报）；hook 必须在早退之前调用（hook 顺序稳定）
  const hs = useDockHeaderStateOf(ACP_KEY);
  // 三面（本批 P5）：float=浮窗 / right=右栏 tab / left=左栏区块（sidebar 族任意落位）
  const open = face === "float" ? st === "floating"
    : face === "right" ? st === "docked:right-panel"
    : isSidebarDockState(st);
  const floating = face === "float";
  // 只有左栏区块面把按钮上提 dock 头（右栏 tab 无头行）
  const dockKey: string | undefined = face === "left" ? ACP_KEY : undefined;
  const [agents, setAgents] = useState<AcpAgent[]>([]);
  const [builtinSet, setBuiltinSet] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [binStr, setBinStr] = useState("");
  const [agentKey, setAgentKey] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetchAgents().then((d) => {
      if (!alive) return;
      setAgents(d.agents ?? []);
      setBuiltinSet(new Set(d.builtinNames ?? []));
      setLoaded(true);
    }).catch(() => {});
    return () => { alive = false; };
  }, [open]);

  const refresh = () => fetchAgents().then((d) => {
    setAgents(d.agents ?? []);
    setBuiltinSet(new Set(d.builtinNames ?? []));
  }).catch(() => {});
  // dock 头工具条 v3：命令实现（刷新）+ 状态上报（agent 数）；按钮由 face 声明
  useDockCommands(dockKey, dockKey ? { refresh: () => { refresh(); } } : null);
  useDockHeaderState(dockKey, dockKey ? { count: agents.length } : null);

  if (!open) return null;

  const doAdd = async () => {
    if (!name.trim() || !binStr.trim() || busy) return;
    setBusy(true);
    await apiAddAgent({
      name: name.trim(),
      bin: binStr.split(/\s+/)[0],
      args: binStr.split(/\s+/).slice(1),
      agentKey: agentKey.trim() || undefined,
    });
    setName(""); setBinStr(""); setAgentKey("");
    setBusy(false);
    refresh();
  };

  const doRemove = async (n: string) => {
    await apiRemoveAgent(n);
    refresh();
  };

  const acpContent = (
    <>
      {/* 标题栏（首个子元素 = aiti-float 拖拽把手）；关闭按钮仅浮窗态（停靠 chrome 已带 ✕/⇲） */}
      {floating && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)", cursor: "grab", userSelect: "none" }}>
          <span style={{ color: "var(--text-muted)", display: "flex" }}><PlugIcon size={15} /></span>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>ACP Backend Agents</span>
          <button
            title="Close" aria-label="Close"
            onClick={() => setDialogOpen(false)}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 4px" }}
          >✕</button>
        </div>
      )}
        {/* 列表（可滚动） */}
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 14px" }}>
          {!loaded ? (
            <div style={{ padding: "16px 0", color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>…</div>
          ) : agents.length === 0 ? (
            <div style={{ padding: "16px 0", color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>No ACP agents found on PATH.</div>
          ) : agents.map((a) => (
            <div key={a.name} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: a.registered ? "#22c55e" : "#ef444455", flexShrink: 0 }} />
              <strong style={{ minWidth: 100, color: "var(--text)" }}>{a.name}</strong>
              <span style={{ color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {a.bin + (a.args?.length ? " " + a.args.join(" ") : "")}
              </span>
              {a.agentKey && (
                <span style={{ fontSize: 10, color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 3, padding: "0 4px" }}>{a.agentKey}</span>
              )}
              {!builtinSet.has(a.name) && (
                <button
                  onClick={() => void doRemove(a.name)}
                  title={`Remove ${a.name}`} aria-label={`Remove ${a.name}`}
                  style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 13, padding: "0 2px" }}
                >✕</button>
              )}
            </div>
          ))}
        </div>
        {/* 添加表单 */}
        <div style={{ borderTop: "1px solid var(--border)", padding: "10px 14px" }}>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
            <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)}
              style={{ width: 90, padding: "4px 7px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11 }} />
            <input placeholder="binary --args" value={binStr} onChange={(e) => setBinStr(e.target.value)}
              style={{ flex: 1, minWidth: 120, padding: "4px 7px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11 }} />
            <input placeholder="key" value={agentKey} onChange={(e) => setAgentKey(e.target.value)}
              style={{ width: 80, padding: "4px 7px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11 }} />
            <button onClick={() => void doAdd()} disabled={busy}
              style={{ padding: "4px 12px", border: "none", borderRadius: 5, background: "var(--accent)", color: "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
              {busy ? "…" : "+ Add"}
            </button>
          </div>
          <div style={{ marginTop: 5, fontSize: 10, color: "var(--text-dim)" }}>
            Reload extensions after adding to activate new backends.
          </div>
        </div>
    </>
  );
  // dock v3 分面：float = 遮罩+浮窗壳；left = 左栏 DockSection
  if (floating) {
    return (
      <div
        style={{ position: "fixed", inset: 0, zIndex: 310, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
        onClick={() => setDialogOpen(false)}
      >
        <div
          data-ext-float="1"
          data-ext-float-key={ACP_KEY}
          data-ext-float-dock={`${sidebarZoneOf(ACP_KEY)} right-panel`}
          data-ext-float-dock-default={sidebarZoneOf(ACP_KEY)}
          data-ext-float-w="420" data-ext-float-h="360"
          data-ext-float-min-w="320" data-ext-float-min-h="220"
          style={{
            width: 420, height: 360, display: "flex", flexDirection: "column",
            background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10,
            color: "var(--text)", boxShadow: "0 10px 40px rgba(0,0,0,0.35)", overflow: "hidden",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {acpContent}
        </div>
      </div>
    );
  }
  const acpInner = (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", color: "var(--text)", fontSize: 12 }}>
      {acpContent}
    </div>
  );
  const acpZones: any[] = [sidebarZoneOf(ACP_KEY), "right-panel"];
  // 右栏 tab face（chrome="tab"：无头行）
  if (face === "right") {
    return (
      <DockBody itemKey={ACP_KEY} zone="right-panel" title="ACP Backend Agents" chrome="tab"
        zones={acpZones} defaultZone={sidebarZoneOf(ACP_KEY)}>{acpInner}</DockBody>
    );
  }
  // 左栏区块 face：统一头行（标题 + 业务按钮 + ⇱ detach + ⋮）；zone 用规范值 sidebar:<key>
  const acpCount = typeof hs.count === "number" ? hs.count : 0;
  const actions: DockHeaderAction[] = [
    { id: "refresh", title: "刷新", icon: (<svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>), visibility: "always", onClick: () => { requestDockCommand(ACP_KEY, "refresh"); } },
  ];
  return (
    <DockBody itemKey={ACP_KEY} title="ACP Backend Agents" chrome="section" kind="dockable"
      count={acpCount > 0 ? acpCount : undefined}
      zones={acpZones} defaultZone={sidebarZoneOf(ACP_KEY)}
      headerActions={actions}>
      {acpInner}
    </DockBody>
  );
}

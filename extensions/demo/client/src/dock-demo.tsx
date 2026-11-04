/**
 * dock-demo —— aiti-float 停靠方案 v0.5.0 试点（docs/aiti-web-ext-float-dock-plan.md §6 接入范式的可运行示例）。
 *
 * 一个面板、两处注册、一个状态机（结构性防双开）：
 *   ① dialogs item（浮窗 face）：useGate(k,"float") 门控——仅 floating 渲染；
 *      面板根声明 data-ext-float="1"（浮窗接管）+ data-ext-float-dock="right-panel sidebar-explorer"（位置菜单目标）
 *      + data-ext-float-dock-default="right-panel"（v3：无用户偏好时 open 直达右栏，验收 default 语义用）。
 *   ② rightFileDock item（右栏停靠 face）：useGate(k,{dock:"right-panel"}) 门控；DockBody chrome="tab"（TabBar 已有 ✕，防双 ✕）。
 *   ③ sidebarExplorerDock item（侧栏停靠 face）：useGate(k,{dock:"sidebar-explorer"}) 门控；DockBody chrome="section"。
 *   ④ 打开入口收口：toolbar 按钮 → openFloat(k)（≡ present(k,"open")，有 dockPref 直达停靠）。
 *
 * 状态自管示范（§7 重建语义）：切形态 = 内容组件 remount，useState 全丢——
 * 计数值存模块级 store（mount 恢复 / 卸载前写回），重建对用户透明。
 */
import { useEffect, useState } from "react";
import { useGate, usePresent, DockBody, openFloat, closePanel, isSidebarDockState, sidebarZoneOf, type PresentState } from "../../../_shared/ext-float-dock";
// dock 头工具条 v3（方案 pi-web-dock-header-toolbar-plan）：face 声明按钮 + 内容实现命令/状态
import { useDockCommands, useDockHeaderState, useDockHeaderStateOf, requestDockCommand, type DockHeaderAction } from "../../../_shared/ext-float-dock";

export const DOCK_ITEM_KEY = "demo:dock";

/* ── §7 状态自管：模块级 store（切形态 remount 不丢） ── */
let sharedCount = 0;

function useSharedCount(): { count: number; incr: () => void } {
  const [count, setCount] = useState(sharedCount);
  useEffect(() => {
    setCount(sharedCount); // mount：恢复
    return () => { sharedCount = count; }; // 卸载前写回（cleanup 闭包持有当次值）
  }, []);
  return { count, incr: () => setCount((n) => { sharedCount = n + 1; return n + 1; }) };
}

function stateBadge(state: PresentState): string {
  if (state === "floating") return "⇱ 可停靠（floating）";
  if (state.startsWith("docked:")) return `⇲ 已停靠（${state.slice(7)}）`;
  return "closed";
}

/* 共享内容组件：三个 face 渲染同一份（§6「同一内容组件注册两处」）。
 * dockItemKey 仅左栏区块 face 传：内容把「计数 +1」实现为 dock 头命令并上报状态。 */
function DockDemoContent(props?: { dockItemKey?: string }) {
  const { count, incr } = useSharedCount();
  const dockKey = typeof props?.dockItemKey === "string" && props.dockItemKey ? props.dockItemKey : undefined;
  useDockCommands(dockKey, dockKey ? { incr: () => incr() } : null);
  useDockHeaderState(dockKey, dockKey ? { count } : null);
  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, fontSize: 12, color: "var(--text)" }}>
      <p style={{ margin: 0, lineHeight: 1.6, color: "var(--text-muted)" }}>
        aiti-float 停靠试点：本面板可 ⇱ 停靠到右栏 tab 或侧栏文件区下方；同一时刻只有一个形态（状态机防双开）。
        切形态 = 组件重建，下方计数经 §7 自管 store 保留。
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          onClick={incr}
          style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}
        >
          计数 +1（跨形态保留）
        </button>
        <span style={{ fontSize: 14, fontFamily: "var(--font-mono)" }}>{count}</span>
      </div>
    </div>
  );
}

/* ① 浮窗 face（dialogs item）：仅 floating 渲染 */
export function DockDemoDialog() {
  const gate = useGate(DOCK_ITEM_KEY, "float");
  if (!gate) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 311, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => closePanel(DOCK_ITEM_KEY)}>
      <div
        data-ext-float="1"
        data-ext-float-dock={`right-panel ${sidebarZoneOf(DOCK_ITEM_KEY)}`}
        data-ext-float-dock-default="right-panel"
        data-ext-float-key={DOCK_ITEM_KEY}
        style={{ width: 400, padding: 14, borderRadius: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", boxShadow: "0 10px 40px rgba(0,0,0,0.35)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1 }}>🧩 停靠示例（浮窗态）</h3>
          <button onClick={() => closePanel(DOCK_ITEM_KEY)} aria-label="关闭" title="关闭"
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, padding: "2px 8px" }}>✕</button>
        </div>
        <DockDemoContent />
      </div>
    </div>
  );
}

/* ② 右栏停靠 face（rightFileDock item）：仅 docked:right-panel 渲染 */
export function DockDemoRightTab() {
  const docked = useGate(DOCK_ITEM_KEY, { dock: "right-panel" });
  if (!docked) return null;
  return (
    <DockBody itemKey={DOCK_ITEM_KEY} zone="right-panel" title="🧩 停靠示例" chrome="tab"
      zones={["right-panel", sidebarZoneOf(DOCK_ITEM_KEY)]} defaultZone="right-panel">
      <DockDemoContent />
    </DockBody>
  );
}

/* ③ 侧栏停靠 face（sidebarExplorerDock item）：sidebar 族区块位渲染 */
export function DockDemoSidebarSection() {
  const docked = isSidebarDockState(usePresent(DOCK_ITEM_KEY));
  const hs = useDockHeaderStateOf(DOCK_ITEM_KEY); // 内容上报状态（hook 早退前调用）
  if (!docked) return null;
  const count = typeof hs.count === "number" ? hs.count : 0;
  const actions: DockHeaderAction[] = [
    { id: "incr", title: "计数 +1（dock 头命令示范）", badge: count > 0 ? count : undefined, visibility: "always", onClick: () => { requestDockCommand(DOCK_ITEM_KEY, "incr"); } },
  ];
  return (
    <DockBody itemKey={DOCK_ITEM_KEY} title="🧩 停靠示例" chrome="section" kind="dockable"
      count={count > 0 ? count : undefined}
      zones={["right-panel", sidebarZoneOf(DOCK_ITEM_KEY)]} defaultZone="right-panel"
      headerActions={actions}>
      <DockDemoContent dockItemKey={DOCK_ITEM_KEY} />
    </DockBody>
  );
}

/* 工具条按钮（打开入口收口示范）：任何入口都调 openFloat → 状态机统一分派 */
export function DockDemoToolbarButton() {
  const state = usePresent(DOCK_ITEM_KEY);
  return (
    <button
      type="button"
      title={state === "closed" ? "打开停靠示例" : state.startsWith("docked:") ? "停靠示例已在停靠区（再点闪提示）" : "停靠示例已打开（置前）"}
      onClick={() => openFloat(DOCK_ITEM_KEY)}
      style={{
        display: "flex", alignItems: "center", gap: 6, padding: "5px 10px",
        borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg-hover)",
        color: "var(--text)", cursor: "pointer", fontSize: 12,
      }}
    >
      🧩 停靠示例
    </button>
  );
}

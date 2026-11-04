/**
 * entry.tsx —— aiti-ai-schedule client 入口（JSX 版）
 *
 * 插槽：toolbar（⏰ 线图按钮入口）+ pages（弹窗面板，data-ext-float 规范）。
 * 委托入口：window.__aitiAiScheduleOpen(prefill?) —— prompt 收藏/cmd 行内 ⏰ 调起预填新建。
 */
import { __setCtx } from "./host-shim";
import { SchedulePageSlot, ScheduleDockRight, ScheduleDockSidebar, SCHED_KEY } from "./schedule-app";
import { seedDockDefault, sidebarZoneOf, declareDockZones, presentState, present } from "../../../_shared/ext-float-dock";

const OPEN_EVENT = "aiti-ai-schedule:open";
function requestOpen(prefill?: Record<string, unknown>) {
  // 事件只被「已挂载的 face」接收（pages/dock face 组件内监听）。面板从未打开过时
  // 没有任何 face 在听——工具条/应用中心入口必须先经 present 状态机把 dock face 拉起
  // （DockStack 按 present 态按需挂载 face），再广播事件（已挂载 face 消费 prefill）。
  try {
    if (presentState(SCHED_KEY) === "closed") present(SCHED_KEY, `dock:${sidebarZoneOf(SCHED_KEY)}`);
  } catch { /* 忽略（降级层缺席时仍走事件） */ }
  try { window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: prefill || null })); } catch { /* 忽略 */ }
}

export default function register(ctx: Record<string, any>) {
  __setCtx(ctx); // 必须在任何 JSX 渲染前

  // 全局委托入口（register 层一次挂载——顶栏会把按钮挂载两份且各有模块实例，
  // 经 window CustomEvent 广播保证任意实例的 pages 槽都能收到）
  (window as any).__aitiAiScheduleOpen = (pf?: Record<string, unknown>) =>
    requestOpen(pf && typeof pf === "object" ? pf : undefined);
  // DI 方案 P2：services 通道双轨注册（旧全局保留；旧宿主 no-op）
  try { ctx.registerExtService?.("aiti-ai-schedule.open", (window as any).__aitiAiScheduleOpen); } catch {}

  function ToolbarButton() {
    return (
      <button type="button" title="调度：定时任务与计划管理" onClick={() => requestOpen()}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, padding: 0, background: "none", borderTop: "none", borderRight: "1px solid var(--border)", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0 }}>
        {/* lucide clock 线图（系统同风格） */}
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx={12} cy={12} r={10} />
          <path d="M12 7v5l3 3" />
        </svg>
      </button>
    );
  }

  // meta.label 不带 emoji：⋯ 菜单行 = 按钮 SVG 图标 + 标签文字，emoji 会造成「一行两个图标」
  // 懒加载 v2 两段式：声明式条目（无 render）
  ctx.registerItems?.("toolbar", [{
    id: "aiti-ai-schedule-open",
    meta: {
      label: "调度",
      title: "调度：定时任务与计划管理",
      icon: "icons/clock.svg",
      onClick: () => requestOpen(),
    },
  }]);
  ctx.registerItems?.("pages", [{ id: "aiti-ai-schedule-page", render: SchedulePageSlot, meta: { label: "调度" } }]);
  // aiti-float dock v3（P3 批）+ v4 对齐分组：任务（定时任务，用户拍板 2026-09-16 区块名就叫「任务」）=核心区块，默认位=左栏区块（上对齐组，
  // priority 1 紧随项目）；右栏 tab 保留为可选位。老用户已存的 dockpref（旧默认 right-panel）
  // 不被覆盖（seed 只填缺席）——由 session-manager 编排器显式 dock 一次性迁入左栏。
  seedDockDefault(SCHED_KEY, sidebarZoneOf(SCHED_KEY));
  // zones 全集注册（v3.1）：TabBar 页签/浮窗 ⇱ 位置菜单的数据源——face 未挂载
  // （右栏 tab 后台态）时菜单只能靠这里；浮窗壳另带 DOM 属性兑底。
  declareDockZones(SCHED_KEY, [sidebarZoneOf(SCHED_KEY), "right-panel"], sidebarZoneOf(SCHED_KEY));
  ctx.registerItems?.("rightFileDock", [{ id: "panel", render: ScheduleDockRight, meta: { title: "调度" } }]);
  // 展开高度策略在 face 层（schedule-app 嵌入态 maxHeight 55vh + body 内部滚动）——
  // cell 级 maxHeightPct 百分比在互斥折叠后的 auto 高 wrapper 里解析不了，不传。
  ctx.registerItems?.("sidebarExplorerDock", [{ id: "panel", render: ScheduleDockSidebar, meta: { title: "任务", priority: 1, align: "top" } }]);
  try { console.log("[aiti-ai-schedule] 管理弹窗已挂载（toolbar ⏰ 入口 → pages 弹窗）"); } catch { /* noop */ }
}

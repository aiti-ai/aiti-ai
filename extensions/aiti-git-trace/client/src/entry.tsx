/**
 * aiti-git-trace · client 入口（JSX + TypeScript + vite 构建）
 *
 * 装配（§8.2）：
 *   - toolbar「⎇ 关注路径」/「⎇ 时间线」
 *   - dialogs：关注路径面板 / ops 时间线 / 回撤三选项对话框（全局 Promise API）
 *   - banners：回撤后验横幅（兜底版，window.__aitiGitTraceBanner）
 *   - userMessageActions：「⎇」徽标（打开时间线）
 *
 * 跨扩展对接点（window）：__aitiGitTraceForkDialog（forkGate 未来调用）、__aitiGitTraceBanner（core fork 后调用）
 */
import { __setCtx } from "./host-shim";
import { seedDockDefault, declareDockZones, sidebarZoneOf } from "../../../_shared/ext-float-dock";
// 薄壳版：面板组件名保持不变（内部是懒加载包装），新增 requestForkDialog（用到才拉重 chunk）
import { WatchToolbarButton, TimelineToolbarButton, TimelineComposerButton, WatchPanelSlot, WatchDockLeft, WatchDockRight, TimelineSlot, TimelineDockRight, TimelineDockLeft, ForkDialogSlot, BannerSlot, MessageBadge, installSessionService, requestForkDialog } from "./trace-app";
import { TraceFilesRow } from "./trace-files-row";

export default function register(ctx: Record<string, any>) {
  __setCtx(ctx);
  // 统一会话状态服务订阅（pi-web.session）：仅 active 时用 canonical id；服务缺席降级 props 通道。
  installSessionService(ctx);

  // aiti-float dock v3（P1/P2 批）：时间线默认右栏（用户定调，left⇄right 可切）；关注路径不设 default。
  // dock 槽注册专用 face 变体（face 参数保证只有激活面渲染，防 dialogs/dock 双实例同渲）
  seedDockDefault("aiti-git-trace:timeline", "right-panel");
  // zones 进注册表：TabBar ⇱ 菜单（后台 tab）也能看到 left⇄right 全集（v3.1）
  declareDockZones("aiti-git-trace:timeline", ["right-panel", sidebarZoneOf("aiti-git-trace:timeline")], "right-panel");
  declareDockZones("aiti-git-trace:watch", [sidebarZoneOf("aiti-git-trace:watch"), "right-panel"], sidebarZoneOf("aiti-git-trace:watch"));
  ctx.registerItems?.("rightFileDock", [
    { id: "timeline", render: TimelineDockRight, meta: { title: "时间线" } },
    { id: "watch", render: WatchDockRight, meta: { title: "关注路径" } },
  ]);
  ctx.registerItems?.("sidebarExplorerDock", [
    { id: "timeline", render: TimelineDockLeft, meta: { title: "时间线", priority: 3 } },
    { id: "watch", render: WatchDockLeft, meta: { title: "关注路径", priority: 3 } },
  ]);

  // 工具条独立入口：静态注册 + feature 门控（默认关）——宿主按 feature 统一显隐（关 → 顶栏行/⋯菜单/自定义面板都不进，
  // extman 切换实时生效），扩展零门控代码（参照 session-manager / aiti-acp-agent）
  //   ⎇ 关注路径 → trace.watchUI（入口在时间线面板顶部）
  //   ⎇ 时间线   → trace.timelineUI（主入口在输入框下方控制行 composerTools 插槽）
  ctx.registerItems?.("toolbar", [
    { id: "aiti-git-trace-watch", render: WatchToolbarButton, meta: { label: "关注路径", icon: "icons/git-branch.svg" }, feature: "trace.watchUI" },
    { id: "aiti-git-trace-timeline", render: TimelineToolbarButton, meta: { label: "时间线", icon: "icons/git-commit-horizontal.svg" }, feature: "trace.timelineUI" },
  ]);
  ctx.registerItems?.("composerTools", [
    { id: "aiti-git-trace-timeline-entry", render: TimelineComposerButton, meta: { label: "时间线" } },
  ]);
  ctx.registerItems?.("dialogs", [
    { id: "aiti-git-trace-watch-dialog", render: WatchPanelSlot },
    { id: "aiti-git-trace-timeline-dialog", render: TimelineSlot },
    { id: "aiti-git-trace-fork-dialog", render: ForkDialogSlot },
  ]);
  ctx.registerItems?.("banners", [{ id: "aiti-git-trace-banner", render: BannerSlot }]);
  ctx.registerItems?.("userMessageActions", [{ id: "aiti-git-trace-badge", render: MessageBadge }]);
  // assistantMessageFooter（2026-09-17）：assistant 消息底部 trace 变更文件行
  // （方案 docs/aiti-git-trace-message-files-ext-plan.md）。旧宿主无此插槽 →
  // registerItems 可能抛错/无渲染点，try/catch 静默降级（aiti-ctx-meter 先例）。
  try {
    ctx.registerItems?.("assistantMessageFooter", [
      { id: "aiti-git-trace-footer", render: TraceFilesRow },
    ]);
  } catch { /* 旧宿主：无此插槽，静默无 UI */ }

  // §5.4 forkGate：编辑重发/fork 前置门——有被追踪操作时弹回撤三选项；弹窗未就绪/无操作则放行
  ctx.registerSessionForkGate?.(async (info: any) => {
    try {
      // 薄壳拆分：gate 触发时才加载重面板（含三选项对话框）——语义与原 window 全局一致。
      const r = await requestForkDialog({
        sessionId: info?.sessionId || "",
        entryId: info?.entryId || "",
        // 方案 §3.3：被裁轮次集合（M 及之后全部用户消息 entryId）——优先按它精确圈定区间（含被编辑轮）
        cutUserEntryIds: Array.isArray(info?.cutUserEntryIds) ? info.cutUserEntryIds.map(String).filter(Boolean) : [],
      });
      return !(r && r.action === "cancel"); // rollback/keep 都放行 fork（回滚已先行落地）
    } catch { return true; }
  });

  try { console.log("[aiti-git-trace] client 已挂载（关注路径/时间线/回撤对话框/横幅/徽标）"); } catch {}
  return () => {};
}

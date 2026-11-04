/**
 * aiti-ai-usage · client 入口（JSX + TypeScript + vite 构建）。
 *
 * Slots:
 *  - toolbar: 📊 顶栏入口按钮 → 打开报表面板（常驻唯一工具条入口）
 *  - sessionStats: 会话统计下拉内「用量报表」按钮（宿主只放开插槽，扩展自渲染自调起）
 *  - dialogs: UsageReport（总览/模型/Keys/会话 四标签）
 */
import { __setCtx } from "./host-shim";
import { seedDockDefault } from "../../../_shared/ext-float-dock";
import { UsageReport, ToolbarEntry, SessionStatsEntry, ReportDockFace, REPORT_KEY, panel } from "./report";

export default function register(ctx: Record<string, unknown>) {
  // 必须在任何 JSX 渲染前调用（host-shim 模块级持 ctx）
  __setCtx(ctx);

  // aiti-float dock v3（P1 批）：播种默认落位——用户无偏好时 open 直达右栏 tab
  seedDockDefault(REPORT_KEY, "right-panel");
  // meta.onClick：懒加载下 toolbar 静态条目点击后由宿主转发——panel.open() 驱动 float 状态机
  // （模块级），物化前后调用都生效。
  ctx.registerItems?.("toolbar", [{ id: "usage", render: ToolbarEntry, meta: { label: "用量", icon: "icons/chart-column.svg", onClick: () => panel.open() } }]);
  ctx.registerItems?.("sessionStats", [{ id: "report-entry", render: SessionStatsEntry }]);
  ctx.registerItems?.("dialogs", [{ id: "report", render: UsageReport }]);
  // 右栏停靠 face：注册 raw itemId（宿主拼 extId:itemId = REPORT_KEY）
  ctx.registerItems?.("rightFileDock", [{ id: "report", render: ReportDockFace, meta: { title: "用量" } }]);
}

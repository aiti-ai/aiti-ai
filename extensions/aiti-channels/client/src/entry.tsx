/**
 * aiti-channels · client 入口（JSX + TypeScript + vite 构建）。
 *
 * register(ctx) 装配：
 *   - toolbar 💬 按钮（打开面板 + 首拉全部数据）
 *   - dialogs slot 全屏面板（9 tab：总览/安装/配置/项目/渠道/会话/消息/日志/原版）
 *
 * 构建：node tools/build-client.mjs   （或 npm run build:client）
 * 部署：node tools/deploy.mjs         （自动先构建再整目录同步）
 */
import { __setCtx } from "./host-shim";
import { ToolbarButton, ChannelsPanelComp, setupNavMediaQuery, openFromToolbar } from "./channels-app";

export default function register(ctx: Record<string, unknown>) {
  // 重要：必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx）
  __setCtx(ctx);

  setupNavMediaQuery();

  // 懒加载 v2 两段式：声明式条目（无 render）；ToolbarButton 组件退役（外观归宿主）
  ctx.registerItems?.("toolbar", [{
    id: "aiti-channels-open",
    meta: {
      label: "IM 渠道",
      title: "IM 渠道：cc-connect 托管 + 渠道管理台",
      icon: "icons/message-circle.svg",
      onClick: () => openFromToolbar(),
    },
  }]);
  ctx.registerItems?.("dialogs", [{ id: "aiti-channels-panel", render: ChannelsPanelComp }]);
}

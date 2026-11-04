/**
 * aiti-ui-env · client 入口（JSX + TypeScript + vite 构建）。
 *
 * register(ctx) 装配：
 *   - toolbar 🖥️ 按钮（模块级 setPanelOpen 开关，toggle 打开/关闭）
 *   - dialogs 面板（显示环境管理：4 模式 / 环境卡 / VNC / RDP / 预览 / 安装状态）
 *
 * 构建：node tools/build-client.mjs   （或 npm run build:client）
 * 部署：node tools/deploy.mjs         （自动先构建再整目录同步）
 */
import { __setCtx } from "./host-shim";
import { togglePanelFromToolbar, UiEnvDialog, UiEnvDockFace } from "./ui-env-app";

export default function register(ctx: Record<string, unknown>) {
  // 重要：必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx）
  __setCtx(ctx);

  ctx.registerItems?.("dialogs", [{ id: "ui-env-dialog", render: UiEnvDialog }]);
  // aiti-float dock v3（P3 批）：右栏可选（保守无 default，open 默认仍浮窗）
  ctx.registerItems?.("rightFileDock", [{ id: "panel", render: UiEnvDockFace, meta: { title: "显示环境" } }]);
  // 懒加载 v2 两段式：声明式条目（无 render）
  ctx.registerItems?.("toolbar", [{
    id: "ui-env-toolbar",
    meta: {
      label: "显示环境",
      title: "UI 环境管理：桌面/无头虚拟屏 + VNC-on-web",
      icon: "icons/monitor.svg",
      onClick: () => togglePanelFromToolbar(),
    },
  }]);
  try { console.log("[aiti-ui-env] client 已挂载（toolbar 触发 → dialogs 渲染）"); } catch {}
}

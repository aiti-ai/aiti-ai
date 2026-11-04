/**
 * aiti-extman · client 入口（JSX + TypeScript + vite 构建）。
 *
 * register(ctx) 装配：
 *   - sidebarFooter 「扩展」按钮（唯一入口，小屏默认全屏展开）
 *   - dialogs 管理面板（左列表 + 右详情 + 信任弹窗）
 *
 * 构建：node tools/build-client.mjs   （或 npm run build:client）
 * 部署：node tools/deploy.mjs         （自动先构建再拷贝）
 */
import { __setCtx, t } from "./host-shim";
import { state, setState, setHostCaps, EXTMAN_KEY } from "./extman-core";
import { seedDockDefault } from "../../../_shared/ext-float-dock";
import { ExtManPanel, ExtManDockFace, SidebarFooterButton, openExtmanPanel } from "./extman-ui";

function setHostIsMobile(v: boolean) { if (state.isMobile !== v) setState({ isMobile: v }); }

export default function register(ctx: Record<string, any>) {
  // 重要：必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx）
  __setCtx(ctx);
  // reloadExtensions / extLoaderState（optional 兼容旧宿主）
  setHostCaps({ reloadExtensions: ctx.reloadExtensions, extLoaderState: ctx.extLoaderState, ctx });

  // 小屏跟踪
  const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(max-width: 640px)") : null;
  if (mq) {
    const apply = () => setHostIsMobile(mq.matches);
    apply();
    if (mq.addEventListener) mq.addEventListener("change", apply);
  }

  // meta.onClick：懒加载（clientImmediately:false）下 sidebarFooter 静态条目点击后
  // 由宿主转发到此行为——物化前也要能打开面板（openExtmanPanel 直接驱动模块级 store）。
  ctx.registerItems?.("sidebarFooter", [{
    id: "aiti-extman-open",
    render: SidebarFooterButton,
    meta: { label: t("ext.shortLabel"), title: t("ext.title"), icon: "icons/wrench.svg", onClick: () => openExtmanPanel() },
  }]);
  ctx.registerItems?.("dialogs", [{ id: "aiti-extman-panel", render: (props: any) => <ExtManPanel {...(props || {})} /> }]);
  // aiti-float dock v3（P1 批）：默认右栏 tab；注册 raw itemId（宿主拼 extId:itemId = EXTMAN_KEY）
  seedDockDefault(EXTMAN_KEY, "right-panel");
  ctx.registerItems?.("rightFileDock", [{ id: "panel", render: (props: any) => <ExtManDockFace {...(props || {})} />, meta: { title: "扩展" } }]);
}

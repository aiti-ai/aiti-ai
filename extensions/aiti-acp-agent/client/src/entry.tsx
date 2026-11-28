/**
 * aiti-acp-agent client 入口（薄壳，2026-09-14 薄壳拆分；vite lib mode 构建 → dist/acp-manager.mjs）。
 *
 * 薄壳只做零/低成本的事（方案 pi-web-eager-ext-split-plan.md §5.3，最简试点）：
 *   - feature 门控 stub：toolbar 声明式条目（meta.onClick/open → setDialogOpen）；
 *     Backend 下拉扩展选项（newSessionBackendOptions，占位式「Manage ACP Agents…」）；
 *   - dialogs / rightFileDock / sidebarExplorerDock 三插槽注册 **懒加载包装**（_shared/ext-lazy
 *     lazyExtView：active 才 import——dialogs/dock 插槽常挂载，import 绝不能挂 mount）；
 *   - register 期 dock 注册表调用（seedDockDefault / declareDockZones，纯状态层零 JSX）。
 * 弹窗本体/列表/表单（~22 KB）全部在 acp-manage.tsx 懒 chunk，用户打开面板才加载。
 *
 * 构建：node tools/build-client.mjs   部署：tools/deploy.mjs（先构建再整目录同步）
 */

import { __setCtx, t } from "./host-shim";
import { ACP_KEY, setDialogOpen, acpDefaultZone } from "./common";
import { usePresent, isSidebarDockState, seedDockDefault, declareDockZones } from "@aiti-ai/ext-shared/ext-float-dock-lite";
import { dockIconDecl } from "@aiti-ai/ext-shared/dock-icons";
import { lazyExtView, createLazyModule } from "@aiti-ai/ext-shared/ext-lazy";

// 重模块单例：面板三面（float/right/left）与命令式入口共享一次 import
const acpManageRef = createLazyModule(() => import("./acp-manage"));

// ---- 常挂插槽懒包装（active 由 usePresent 门控；active=false 渲染 null 且不 import）----

export function AcpDialogSlot() {
  const st = usePresent(ACP_KEY);
  return lazyExtView({ active: st === "floating", load: acpManageRef, pick: "AcpDialog" });
}
export function AcpDockRightSlot() {
  const st = usePresent(ACP_KEY);
  return lazyExtView({ active: st === "docked:right-panel", load: acpManageRef, pick: "AcpDockRight" });
}
export function AcpDockLeftSlot() {
  const st = usePresent(ACP_KEY);
  return lazyExtView({ active: isSidebarDockState(st), load: acpManageRef, pick: "AcpDockLeft" });
}

let localeListener: (() => void) | null = null;

// 新会话欢迎页 Backend 下拉的扩展选项（不是后端条目：选中即打开管理弹窗，
// 下拉值由宿主复位）——不再在 Backend 选择器外渲染按钮。
export default function register(ctx: Record<string, unknown>) {
  // 重要：必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx）
  __setCtx(ctx);

  // Declarative item labels are captured at registration time; re-register on the
  // host locale-change event so the dropdown option follows the active language.
  const registerEntries = () => {
    ctx.registerItems?.("toolbar", [{
      id: "aiti-acp-manage-open",
      meta: { label: "ACP", title: t("acp.manage.title"), icon: "icons/plug.svg", onClick: () => setDialogOpen(true), open: () => setDialogOpen(true) },
      feature: "behavior.showAcpManager",
    }]);
    ctx.registerItems?.("newSessionBackendOptions", [{
      id: "acp-manage-option",
      meta: { label: t("acp.manage.option.label"), title: t("acp.manage.title"), onClick: () => setDialogOpen(true) },
    }]);
    ctx.registerItems?.("dialogs", [{
      id: "acp-manage-dialog",
      render: AcpDialogSlot,
      meta: {
        label: t("acp.manage.dialog.label"),
        open: () => setDialogOpen(true),
      },
    }]);
  };
  registerEntries();
  if (typeof window !== "undefined") {
    if (localeListener) window.removeEventListener("pi-web:locale-changed", localeListener);
    localeListener = registerEntries;
    window.addEventListener("pi-web:locale-changed", registerEntries);
  }
  // aiti-float dock v3（P2 批）：后端列表默认左栏（状态灯列表窄条）
  // zone 规范值 sidebar:<key>（v4；旧 sidebar-explorer 兼容读）
  seedDockDefault(ACP_KEY, acpDefaultZone());
  declareDockZones(ACP_KEY, [acpDefaultZone(), "right-panel"], acpDefaultZone());
  ctx.registerItems?.("rightFileDock", [{ id: "manage", render: AcpDockRightSlot, meta: { title: "ACP", icon: dockIconDecl("plug") } }]);
  ctx.registerItems?.("sidebarExplorerDock", [{ id: "manage", render: AcpDockLeftSlot, meta: { title: "ACP", priority: 3 } }]);

  console.log("[aiti-acp-agent] client 已注册（薄壳 + 懒弹窗 chunk）");
}

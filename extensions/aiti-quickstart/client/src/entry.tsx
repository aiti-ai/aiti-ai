/**
 * aiti-quickstart · client 入口。
 *
 * register(ctx) 装配三组注册：
 *   - newSessionWidgets ×3：同 id 接管 manifest 静态条目（meta 共用 quickstart-logic
 *     WIDGET_METAS，title 走 t() 多语；render 分发到组件层）；
 *   - sidebarFooter「快速上手」：同 id 接管静态条目——物化前静态条目点击经宿主
 *     staticClickForwarder 物化本扩展并转发到此 onClick（extman 同款范式）；
 *   - client 服务 `aiti-quickstart.api`（renderQuickstart）：session-manager 编排器
 *     消费，作 DockStack filler 渲染进全折叠空白（与 aiti-app-center 同屏共存）。
 */
import { __setCtx, regSvc, t } from "./host-shim";
import { QuickstartFiller, QuickstartFooterButton, openQuickstart, renderWidget } from "./quickstart";
import { SERVICE_KEY, FOOTER_ITEM_ID, WIDGET_METAS, WIDGET_TITLE_KEYS } from "./quickstart-logic";

export default function register(ctx: Record<string, unknown>): () => void {
  // 必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx）
  __setCtx(ctx);

  // 欢迎页 widget：meta 与 manifest 静态条目同源（WIDGET_METAS），注册后同 id 接管
  ctx.registerItems?.("newSessionWidgets", WIDGET_METAS.map((m) => ({
    id: m.id,
    render: (props: Record<string, unknown>) => renderWidget(m.id, props ?? {}),
    meta: {
      title: t(WIDGET_TITLE_KEYS[m.id] ?? m.id),
      areas: m.areas,
      defaultArea: m.defaultArea,
      w: m.w,
      h: m.h,
      priority: m.priority,
    },
  })));

  // 侧栏底部「快速上手」（meta.onClick = 重返欢迎页；物化前由静态条目转发器直达此行为）
  ctx.registerItems?.("sidebarFooter", [{
    id: FOOTER_ITEM_ID,
    render: QuickstartFooterButton,
    meta: { label: t("qs.footer.label"), title: t("qs.footer.title"), icon: "icons/rocket.svg", onClick: () => { void openQuickstart(); } },
  }]);

  // session-manager 编排器 filler 交付面（renderQuickstart 供 filler 组合消费）
  const dispose = regSvc(SERVICE_KEY, { renderQuickstart: () => <QuickstartFiller /> });

  return () => {
    try { dispose?.(); } catch { /* ignore */ }
  };
}

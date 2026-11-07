/**
 * aiti-quickstart · client 入口。
 *
 * register(ctx) 装配（v2）：
 *   - newSessionWidgets ×3：同 id 接管 manifest 静态条目（meta 共用 quickstart-logic
 *     WIDGET_METAS，title 走 t() 多语；render 分发到组件层——guide 为状态机开始卡）；
 *   - sidebarFooter「快速上手」：同 id 接管静态条目（extman 范式）；
 *   - workspacePickerActions「获取工作区…」：Workspace 下拉底部动作区（Hub 入口）；
 *   - dialogs `aiti-quickstart-hub`：Hub 对话框（window 事件/服务双通道打开）；
 *   - client 服务：`aiti-quickstart.api`（renderQuickstart → session-manager filler）、
 *     `aiti-quickstart.open`（跨扩展开 Hub）。
 */
import { __setCtx, regSvc, t } from "./host-shim";
import { QuickstartFiller, WorkspacePickerAcquireEntry, openQuickstart, renderWidget } from "./quickstart";
import { WorkspaceHubRoot } from "./workspace-hub";
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

  // sidebarFooter「快速上手」：**只作 app center 收编源**（2026-11-07 用户拍板：左下工具条
  // 与 extman 同排不放按钮，应用中心有卡就够）。render = null 接管静态条目（宿主底部行
  // 不渲染任何东西），meta.onClick 保留 → app center buildApps 仍收编为 manage 卡
  // （已钉住的 `manage:aiti-quickstart:quickstart-open` id 不变）。物化前静态条目短暂
  // 渲染标准按钮，session-manager ensureMaterialized 挂载即拉起、接管后消失。
  ctx.registerItems?.("sidebarFooter", [{
    id: FOOTER_ITEM_ID,
    render: () => null,
    meta: { label: t("qs.footer.label"), title: t("qs.footer.title"), icon: "icons/rocket.svg", onClick: () => { void openQuickstart(); } },
  }]);

  // Workspace 下拉底部动作区「获取工作区…」（静态条目同 id 接管；不设 onClick——
  // 该插槽宿主直接渲染条目组件，点击行为在组件内）
  ctx.registerItems?.("workspacePickerActions", [{ id: "acquire", render: WorkspacePickerAcquireEntry }]);

  // Hub 对话框（dialogs 插槽：自绘 portal，宿主 ExtSlot 渲染面；aiti-float 浮动契约在组件根）
  ctx.registerItems?.("dialogs", [{ id: "aiti-quickstart-hub", render: () => <WorkspaceHubRoot /> }]);

  // 跨扩展服务：filler 交付面 + Hub 打开（ai-helper 等未来消费）
  const disposeApi = regSvc(SERVICE_KEY, { renderQuickstart: () => <QuickstartFiller /> });
  const disposeOpen = regSvc("aiti-quickstart.open", { open: () => { try { window.dispatchEvent(new CustomEvent("aiti-quickstart:open-hub")); } catch { /* ignore */ } } });

  return () => {
    try { disposeApi?.(); } catch { /* ignore */ }
    try { disposeOpen?.(); } catch { /* ignore */ }
  };
}

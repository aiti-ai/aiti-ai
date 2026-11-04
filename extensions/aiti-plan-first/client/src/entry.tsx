/**
 * aiti-plan-first · client 入口（JSX + TS + vite 构建；git-trace 同构）
 *
 * 装配（docs/aiti-plan-first-plan.md §7）：
 *   - toolbar「📋 方案先行」（feature 门控：plan.toolbar）
 *   - PlanToolbarButton：状态点（灰=未绑定 / 绿=已绑定 / 琥珀=提醒中/mute）
 *     + 锚定下拉（主视图 / md 选择器）+ EventSource remind 事件 + 10s 自动收起
 */
import { __setCtx } from "./host-shim";
import { PlanToolbarButton, PlanDropdownSlot, PlanRowMeta, openPlanDropdownFromEvent, installSessionService } from "./app";

export default function register(ctx: Record<string, any>) {
  __setCtx(ctx);
  // 统一会话状态服务订阅（pi-web.session）：仅在会话 active 时用 canonical id 发请求；
  // 服务缺席（旧宿主）静默降级到 props.currentSession 通道。
  installSessionService(ctx);

  // 工具条入口 + 下拉 slot（哑按钮 dispatch 事件，dialogs 常驻持状态——⋯ 菜单触发也不随菜单卸载）
  // 声明式图标 + onClick（2026-08 契约）：⋯ 菜单里图标槽/点击归宿主，render 仅承担工具条本体（状态色）
  ctx.registerItems?.("toolbar", [
    {
      id: "aiti-plan-first-button",
      render: PlanToolbarButton,
      feature: "plan.toolbar",
      meta: {
        label: "方案先行",
        icon: "icons/clipboard-list.svg",
        onClick: (e?: any) => {
          // 标记宿主行为触发元素（onOutside 用 data-pf-trigger 判定）：保住「二次点击 = 关闭」的切换语义
          try { (e?.currentTarget as HTMLElement | undefined)?.setAttribute?.("data-pf-trigger", "1"); } catch {}
          openPlanDropdownFromEvent(e);
        },
      },
    },
  ]);
  ctx.registerItems?.("dialogs", [
    { id: "aiti-plan-first-dropdown", render: PlanDropdownSlot },
  ]);
  ctx.registerItems?.("sessionRowMeta", [
    { id: "aiti-plan-first-meta", render: PlanRowMeta },
  ]);

  try { console.log("[aiti-plan-first] client 已挂载（方案先行按钮 + 提醒下拉）"); } catch {}
  return () => {};
}

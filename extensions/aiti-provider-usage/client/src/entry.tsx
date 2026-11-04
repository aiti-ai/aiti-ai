/**
 * entry.tsx —— aiti-provider-usage 扩展客户端入口（defork B1）。
 *
 * - 注册 sessionInfoPanel 插槽项（「剩余额度」面板；经 ExtSlot 由 AppShell 会话
 *   信息面板渲染，extra.currentProviderId 决定置顶展开的 provider）
 * - feature 门控：providerUsage.enabled 关闭时不注册插槽项 → 面板消失（上游同形）
 *
 * 构建：vite lib mode → dist/aiti-provider-usage.mjs
 */
import { __setCtx } from "./host-shim";
import { ProviderUsagePanel } from "./Panel";
import { UsageBadge } from "./UsageBadge";

function PanelSlot(props: Record<string, unknown>) {
  const currentProviderId = typeof props.currentProviderId === "string" ? props.currentProviderId : null;
  return <ProviderUsagePanel currentProviderId={currentProviderId} />;
}

/** chatOverlay 用量徽标（P3 去核化）：数据 = extra.backendUsage（core get_usage 协议透传）。 */
function UsageBadgeSlot(props: Record<string, unknown>) {
  const usage = (props.backendUsage ?? null) as import("./UsageBadge").BackendUsage | null;
  return <UsageBadge backendUsage={usage} />;
}

export default function register(ctx: Record<string, unknown>) {
  __setCtx(ctx);

  const applyFeature = () => {
    const features = (ctx.getFeatures as (() => Record<string, boolean | string>) | undefined)?.() ?? {};
    const enabled = features["providerUsage.enabled"] !== false;
    ctx.disposeItems?.("sessionInfoPanel", ["panel"]);
    ctx.disposeItems?.("chatOverlay", ["usage-badge"]);
    if (enabled) {
      ctx.registerItems("sessionInfoPanel", [{ id: "panel", render: (p: Record<string, unknown>) => <PanelSlot {...p} /> }]);
      // 旧宿主无 chatOverlay 插槽 → throw 降级不抛（core 自带徽标仍在的场景仅存在于旧核，无叠影）
      try {
        ctx.registerItems("chatOverlay", [{ id: "usage-badge", render: (p: Record<string, unknown>) => <UsageBadgeSlot {...p} /> }]);
      } catch (e) {
        console.warn("[aiti-provider-usage] chatOverlay 注册失败（宿主过旧）:", (e as Error)?.message ?? e);
      }
    }
  };
  applyFeature();
  (ctx.onFeatureChange as ((fn: () => void) => void) | undefined)?.(applyFeature);
}

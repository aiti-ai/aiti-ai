/**
 * entry.tsx —— aiti-provider-usage 扩展客户端入口（defork B1）。
 *
 * 两个挂载点，各自独立开关：
 * - sessionStatsInline：会话统计行尾部的账号剩余额度 chip（数值 + 悬停摘要；
 *   明细走会话信息面板）。feature `usageChip`。
 * - sessionInfoPanel：会话信息弹出里的「剩余额度」面板（provider 列表 + 当前
 *   会话账号配额明细）。feature `providerUsage.enabled`，关闭 → 面板消失（上游同形）。
 *
 * 数据链路：extra.backendUsage = 宿主 get_usage 协议快照（core 上提，仅数据）。
 *
 * 构建：vite lib mode → dist/aiti-provider-usage.mjs
 */
import { __setCtx } from "./host-shim";
import { ProviderUsagePanel } from "./Panel";
import { StatsChip, usageTooltipLine, type BackendUsage } from "./StatsChip";

function readUsage(props: Record<string, unknown>): BackendUsage | null {
  return (props.backendUsage ?? null) as BackendUsage | null;
}

function PanelSlot(props: Record<string, unknown>) {
  const currentProviderId = typeof props.currentProviderId === "string" ? props.currentProviderId : null;
  return (
    <ProviderUsagePanel
      currentProviderId={currentProviderId}
      backendUsage={readUsage(props)}
      backendSource={typeof props.backendSource === "string" ? props.backendSource : undefined}
      sessionId={typeof props.sessionId === "string" ? props.sessionId : null}
    />
  );
}

function ChipSlot(props: Record<string, unknown>) {
  return (
    <StatsChip
      backendUsage={readUsage(props)}
      isMobile={props.isMobile === true}
      isCompact={props.isCompact === true}
    />
  );
}

export default function register(ctx: Record<string, unknown>) {
  __setCtx(ctx);

  const applyFeature = () => {
    const features = (ctx.getFeatures as (() => Record<string, boolean | string>) | undefined)?.() ?? {};
    const panelEnabled = features["providerUsage.enabled"] !== false;
    const chipEnabled = features["usageChip"] !== false;
    ctx.disposeItems?.("sessionInfoPanel", ["panel"]);
    ctx.disposeItems?.("sessionStatsInline", ["quota-chip"]);
    if (panelEnabled) {
      ctx.registerItems("sessionInfoPanel", [{ id: "panel", render: (p: Record<string, unknown>) => <PanelSlot {...p} /> }]);
    }
    if (chipEnabled) {
      // order 20: after the sysmon chips (order 10) at the tail of the stats row.
      ctx.registerItems("sessionStatsInline", [{
        id: "quota-chip",
        render: (p: Record<string, unknown>) => <ChipSlot {...p} />,
        meta: { label: "i18n:providerUsage.chip.label", tooltip: usageTooltipLine, order: 20 },
      }]);
    }
  };
  applyFeature();
  (ctx.onFeatureChange as ((fn: () => void) => void) | undefined)?.(applyFeature);
}

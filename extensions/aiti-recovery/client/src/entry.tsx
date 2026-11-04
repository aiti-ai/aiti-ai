/**
 * entry.tsx —— aiti-recovery 扩展客户端入口（defork B3）。
 *
 * - recoveryDialog 插槽：队列/导入恢复对话框（活 props 注入：items/onResolve/onExport/
 *   onImport/onDismiss/mode——queuePanel 同款注入式插槽；仅 ChatWindow 有恢复项时挂载）
 * - dialogs 插槽：重启恢复向导（自触发：mount 后查 /api/agent/recovery/interrupted，
 *   有中断会话才显示；两步向导）
 *
 * 构建：vite lib mode → dist/aiti-recovery.mjs
 */
import { __setCtx } from "./host-shim";
import { QueueRecoveryDialog } from "./QueueRecoveryDialog";
import { RestartRecoveryWizard } from "./RestartRecoveryWizard";

export default function register(ctx: Record<string, unknown>) {
  __setCtx(ctx);
  const applyFeature = () => {
    const features = (ctx.getFeatures as (() => Record<string, boolean | string>) | undefined)?.() ?? {};
    const enabled = features["recovery.enabled"] !== false;
    ctx.disposeItems?.("recoveryDialog", ["dialog"]);
    ctx.disposeItems?.("dialogs", ["wizard"]);
    if (enabled) {
      ctx.registerItems?.("recoveryDialog", [{ id: "dialog", render: (p: Record<string, unknown>) => <QueueRecoveryDialog {...p} /> }]);
      ctx.registerItems?.("dialogs", [{ id: "wizard", render: () => <RestartRecoveryWizard /> }]);
    }
  };
  applyFeature();
  ctx.onFeatureChange?.(applyFeature);
}

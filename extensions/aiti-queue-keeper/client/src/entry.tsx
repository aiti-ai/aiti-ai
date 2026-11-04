/**
 * entry.tsx —— aiti-queue-keeper 扩展客户端入口。
 *
 * - 注册 queuePanel 插槽项（QueuePanel 主组件；经 ExtSlot 由 ChatInput 渲染）
 * - 注册 QueuePanelController（expand/notice）——core 恢复/导入解析后强制展开
 * - feature 门控：queuePanel.enabled 关闭时不注册插槽项 → 回落 core 兜底 banner
 *
 * 契约类型：./types.ts（core lib/composer/queue-api.ts 的结构镜像）。
 * 构建：node tools/build-client.mjs（vite lib mode → client/aiti-queue-keeper.mjs）
 */
import { __setCtx } from "./host-shim";
import { QueuePanel } from "./QueuePanel";
import { QueueImportButton } from "./QueueImportButton";
import { getPanelCommands } from "./panel-bus";
import type { QueuePanelProps } from "./types";

/** queuePanel 插槽组件：props 透传给 QueuePanel 主组件（额外字段如 currentSession 忽略）。 */
function QueuePanelSlot(props: QueuePanelProps & Record<string, unknown>) {
  const panelProps: QueuePanelProps = {
    live: props.live,
    trash: props.trash,
    queueCount: props.queueCount,
    trashCount: props.trashCount,
    actions: props.actions,
    isMobile: Boolean(props.isMobile),
    isCoarsePointer: Boolean(props.isCoarsePointer),
  };
  return <QueuePanel {...panelProps} />;
}

export default function register(ctx: Record<string, unknown>) {
  __setCtx(ctx);

  // feature 门控：queuePanel.enabled 关闭 → 不注册插槽项（core 兑底 banner 兜底）。
  // 开关即时生效（onFeatureChange 驱动重新注册/注销），extman 切换无需刷新页面。
  const applyFeature = () => {
    const features = (ctx.getFeatures as (() => Record<string, boolean | string>) | undefined)?.() ?? {};
    const enabled = features["queuePanel.enabled"] !== false;
    ctx.disposeItems?.("queuePanel", ["panel"]);
    // 队列面板（完整 UI）
    if (enabled) ctx.registerItems?.("queuePanel", [{ id: "panel", render: QueuePanelSlot }]);
    // composerTools 行导入入口（与压缩/导入同排；队列空时回到底部控制行而非孤零零浮在上方）
    ctx.registerItems?.("composerTools", [{ id: "import", render: QueueImportButton }]);
  };
  applyFeature();
  ctx.onFeatureChange?.(applyFeature);

  // ext → core 反向通道：core 恢复/导入解析后 expand()（无接管时 core 兜底 no-op）。
  // 调用经 panel-bus 转发到 QueuePanel 内部（挂载时登记，未挂载 no-op）。
  ctx.registerQueuePanelController?.({
    expand: () => getPanelCommands()?.expand(),
    notice: (text: string, ok: boolean) => getPanelCommands()?.notice(text, ok),
  });

  // 输入框 × 清空 → 回收站写入接口（专门直接写入，不走 live 队列）。
  // core 在 clearInput 前经 emitComposerClearToTrash 分发快照到本增强器；
  // 本扩展实现写入（执行器 getComposerTrashWriter 由 core 挂载，内部走
  // trash_direct_add RPC）。未注册本增强器时清空仅保留内存 5s 撤销。
  const offClearToTrash =
    typeof ctx.registerComposerEnhancement === "function"
      ? ctx.registerComposerEnhancement({
          id: "aiti-queue-keeper.trash",
          onClearToTrash: (snapshot) => {
            const write = (ctx.getComposerTrashWriter as (() => ((s: unknown) => void) | null) | undefined)?.();
            if (typeof write !== "function") return;
            try {
              write(snapshot);
            } catch (e) {
              console.error("[aiti-queue-keeper] trash write failed:", e);
            }
          },
        })
      : null;

  console.log("[aiti-queue-keeper] client 已注册（queuePanel 插槽 + controller + 回收站写入接口）");
  return () => {
    offClearToTrash?.();
  };
}
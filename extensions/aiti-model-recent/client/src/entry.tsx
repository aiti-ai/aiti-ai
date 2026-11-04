/**
 * entry.tsx —— aiti-model-recent 扩展客户端入口（defork P4）。
 *
 * 纯数据提供方扩展（零 UI）：
 * - client service "aiti-model-recent.recentOptions"：core ModelSelector 面板
 *   渲染「最近使用」段时同步调用 getRecent（渲染期同步读 localStorage）
 * - 监听 window "pi-web:model-picked"：core choose() 派发 → 入库 LRU
 *
 * 即时物化（clientImmediately: true）：service 须在首次打开面板前注册。
 */
import { __setCtx } from "./host-shim";
import { pickRecentOptions, readRecentModels, rememberRecentModel, type ModelSelectorOption } from "./recent";

export default function register(ctx: Record<string, unknown>) {
  __setCtx(ctx);

  let dispose: (() => void) | null = null;
  const applyFeature = () => {
    const features = (ctx.getFeatures as (() => Record<string, boolean | string>) | undefined)?.() ?? {};
    const enabled = features["modelRecent.enabled"] !== false;
    dispose?.();
    dispose = null;
    if (!enabled) return;
    dispose = (ctx.registerExtService as ((key: string, impl: unknown) => (() => void) | null) | undefined)?.(
      "aiti-model-recent.recentOptions",
      {
        getRecent(opts: { open: boolean; filter: string; sortedOptions: ModelSelectorOption[] }): ModelSelectorOption[] {
          return pickRecentOptions(readRecentModels(), opts.sortedOptions, { open: opts.open, filter: opts.filter });
        },
      },
    );
  };
  applyFeature();
  ctx.onFeatureChange?.(applyFeature);

  const onPick = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail && typeof detail.provider === "string" && typeof detail.modelId === "string") {
      rememberRecentModel(detail.provider, detail.modelId);
    }
  };
  window.addEventListener("pi-web:model-picked", onPick);
}

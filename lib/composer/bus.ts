/**
 * Composer 增强总线（契约实现在 lib/composer/types.ts 旁；设计文档
 * docs/composer-enhancement-contract.md）。
 *
 * - 注册表 + 固定时机分发。分发同步、按注册序；单个 enhancer 抛错被隔离
 *   （console.warn，不打断其他 enhancer 与主流程）。
 * - writer 由 ChatInput 装配（setComposerWriter）；扩展不直接持有 writer——
 *   程序化写值走 ctx.writeComposerValue → HostApi → ChatInput handle（P2 接通）。
 * - 本模块零 React 依赖：ChatInput 在既有 effect 里调用 emit*，不需要订阅。
 */
import type {
  ComposerEnhancement,
  ComposerSnapshot,
  ComposerWriter,
} from "./types";

export type { ComposerEnhancement, ComposerSnapshot, ComposerWriter };

const enhancers: ComposerEnhancement[] = [];
let writer: ComposerWriter | null = null;

/** 注册增强器；返回 disposer（精确移除本次注册）。 */
export function registerComposerEnhancement(enh: ComposerEnhancement): () => void {
  enhancers.push(enh);
  return () => {
    const i = enhancers.indexOf(enh);
    if (i >= 0) enhancers.splice(i, 1);
  };
}

/** ChatInput 装配/卸载受控写入口。传 null = 卸载（composer 未挂载）。 */
export function setComposerWriter(w: ComposerWriter | null): void {
  writer = w;
}

export function getComposerWriter(): ComposerWriter | null {
  return writer;
}

function safeCall(enh: ComposerEnhancement, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn(`[composer] enhancement "${enh.id}" callback failed:`, e);
  }
}

/** 值变化分发（ChatInput 在 [value, attachedImages] effect 调用）。 */
export function emitComposerChange(snapshot: ComposerSnapshot): void {
  for (const enh of enhancers) {
    if (!enh.onChange) continue;
    safeCall(enh, () => enh.onChange!(snapshot));
  }
}

/** draftKey 切换分发（ChatInput 在 draftKey effect 调用，写入新 key 之后）。 */
export function emitComposerKeyChange(previousKey: string | undefined, nextKey: string | undefined): void {
  for (const enh of enhancers) {
    if (!enh.onKeyChange) continue;
    safeCall(enh, () => enh.onKeyChange!(previousKey, nextKey));
  }
}

/**
 * 发送前链式钩子：按注册序依次给 enhancer 替换文本的机会。
 * 任一环返回非字符串（void/undefined）= 原文放行到下一环。
 */
export function runComposerSubmit(text: string, imageCount: number): string {
  let current = text;
  for (const enh of enhancers) {
    if (!enh.onSubmit) continue;
    try {
      const out = enh.onSubmit(current, imageCount);
      if (out && typeof out.text === "string") current = out.text;
    } catch (e) {
      console.warn(`[composer] enhancement "${enh.id}" onSubmit failed:`, e);
    }
  }
  return current;
}

/** 测试辅助：清空全部状态（生产代码勿调）。 */
export function resetComposerBusForTests(): void {
  enhancers.length = 0;
  writer = null;
}

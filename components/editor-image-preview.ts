"use client";

import { ensureExtMaterialized } from "./ExtSlots";

/**
 * 消息/输入框/markdown 图片 → aiti-editor 统一查看器（浮窗）的宿主桥。
 *
 * 图片预览不再有宿主容器（image tab 机制已删除）：扩展在 __aitiEditor 上暴露
 * openImagePreview(src, {alt})——与 hasFileFace/openFileFace 同一「宿主可选调用、
 * 扩展缺席全降级」约定。调用前先幂等物化 aiti-editor（懒扩展；图片点击 = 交互时刻，
 * 首次点击顺带完成加载，超时 1.5s 兜底）。
 *
 * 返回 false（未装/未物化/超时/异常/扩展未实现）→ 调用方回退上游行为
 * （ImagePreview 的原生 lightbox dialog；markdown 图片保持无动作）。
 */
export async function openImageInEditorViewer(
  src: string,
  options?: { alt?: string },
): Promise<boolean> {
  if (!src) return false;
  try {
    await Promise.race([
      ensureExtMaterialized("aiti-editor"),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    const ed = (window as unknown as {
      __aitiEditor?: { openImagePreview?: (src: string, options?: { alt?: string }) => boolean };
    }).__aitiEditor;
    if (typeof ed?.openImagePreview === "function") {
      return ed.openImagePreview(src, options) !== false;
    }
  } catch { /* 扩展不可用 → 调用方回退 */ }
  return false;
}

"use client";

import { createContext, useContext } from "react";

/**
 * 「打开右栏图片预览 tab」的宿主通道（AppShell 提供 handleOpenImagePreview 实现）。
 *
 * 消息里的图片点击预览从全屏 lightbox 改走右侧文件区（可多开、不遮挡消息流）：
 * ImagePreview / MarkdownBody 消费本 context；返回 null（宿主未接，如独立预览页）
 * 时调用方回退自带行为（lightbox / 无点击）。
 */
export type OpenImagePanelFn = (src: string, options?: { alt?: string }) => void;

export const ImagePanelContext = createContext<OpenImagePanelFn | null>(null);

export function useOpenImagePanel(): OpenImagePanelFn | null {
  return useContext(ImagePanelContext);
}

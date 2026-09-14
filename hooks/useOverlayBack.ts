"use client";

import { useEffect, useRef } from "react";

import { acquireOverlayBack } from "@/lib/overlay-back";

/**
 * 小屏浮层「系统返回关闭」接线（React 侧薄封装）：
 *   useOverlayBack(isMobile && open, () => setOpen(false))
 *
 * active 变 true 时把 close 注册为历史退栈层；变 false / 卸载时释放。
 * `close` 每次渲染经 ref 刷新，注册句柄始终调用最新闭包。
 * active 由调用方自行做小屏门控（桌面不改变浏览器返回语义）。
 */
export function useOverlayBack(active: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!active) return;
    const handle = acquireOverlayBack(() => closeRef.current());
    return () => handle.release();
  }, [active]);
}

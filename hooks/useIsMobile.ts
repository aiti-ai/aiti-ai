"use client";

import { useSyncExternalStore } from "react";

// Mobile breakpoint shared with app/globals.css (max-width: 640px).
const MOBILE_QUERY = "(max-width: 640px)";

function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Returns true when the viewport is at or below the mobile breakpoint.
 * SSR-safe: renders as desktop (false) on the server and first client paint,
 * then syncs to the real viewport after hydration.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Compact desktop (pad portrait): 641–959px. ChatMinimap 等桌面增强在此档隐藏
 * （右侧 36px 通道 + 消息/输入 52px 留白把内容挤窄——pad 竖屏实测"右边空一大片"），
 * 与 globals.css 的紧凑桌面档（文件面板 overlay 等）同一套断点。
 */
const COMPACT_QUERY = "(min-width: 641px) and (max-width: 959px)";

export function useIsCompact(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(COMPACT_QUERY);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    () => (typeof window === "undefined" || !window.matchMedia ? false : window.matchMedia(COMPACT_QUERY).matches),
    () => false,
  );
}

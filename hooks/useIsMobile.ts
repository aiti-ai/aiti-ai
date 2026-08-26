"use client";

import { useSyncExternalStore } from "react";

// Mobile breakpoint shared with app/globals.css (max-width: 640px).
const MOBILE_QUERY = "(max-width: 640px)";
// Narrow phones keep secondary toolbar actions behind the More button.
const NARROW_MOBILE_QUERY = "(max-width: 480px)";

function subscribeToQuery(query: string, cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(query);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function queryMatches(query: string): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(query).matches;
}

const subscribeMobile = (cb: () => void) => subscribeToQuery(MOBILE_QUERY, cb);
const getMobileSnapshot = () => queryMatches(MOBILE_QUERY);
const subscribeNarrowMobile = (cb: () => void) => subscribeToQuery(NARROW_MOBILE_QUERY, cb);
const getNarrowMobileSnapshot = () => queryMatches(NARROW_MOBILE_QUERY);

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Returns true when the viewport is at or below the mobile breakpoint.
 * SSR-safe: renders as desktop (false) on the server and first client paint,
 * then syncs to the real viewport after hydration.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribeMobile, getMobileSnapshot, getServerSnapshot);
}

/** Returns true when the compact mobile toolbar should collapse extra actions. */
export function useIsNarrowMobile(): boolean {
  return useSyncExternalStore(subscribeNarrowMobile, getNarrowMobileSnapshot, getServerSnapshot);
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

/**
 * True when the PRIMARY pointer is touch (phones/tablets).
 *
 * Currently used to disable HTML5 drag-and-drop on coarse-pointer devices
 * (they get the dedicated touch-drag implementation instead). Uses
 * `pointer: coarse` rather than `any-pointer`: the latter also matches
 * touchscreen laptops whose primary pointer is still a mouse, so primary
 * pointer type is the correct signal.
 *
 * SSR-safe: renders as desktop (false) on the server and first client paint,
 * then syncs to the real pointer type after hydration.
 */
const COARSE_QUERY = "(pointer: coarse)";

export function useIsCoarsePointer(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(COARSE_QUERY);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    () => (typeof window === "undefined" || !window.matchMedia ? false : window.matchMedia(COARSE_QUERY).matches),
    () => false,
  );
}

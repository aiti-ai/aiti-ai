"use client";

import { useEffect, useRef } from "react";

import { acquireOverlayBack } from "@/lib/overlay-back";

/**
 * Wiring for "system back closes the overlay" on small screens (thin React-side
 * wrapper):
 *   useOverlayBack(isMobile && open, () => setOpen(false))
 *
 * When active turns true, close is registered as a history pop layer; it is
 * released when active turns false or on unmount. `close` is refreshed via a
 * ref on each render, so the registered handle always invokes the latest
 * closure. The caller is responsible for gating active to small screens
 * (desktop browser back behavior is left untouched).
 */
export function useOverlayBack(active: boolean, close: () => void): void {
  const closeRef = useRef(close);
  // Do not write refs during render (React rule): the close closure is refreshed
  // via an effect so the registered handle always calls the latest value
  useEffect(() => {
    closeRef.current = close;
  }, [close]);
  useEffect(() => {
    if (!active) return;
    const handle = acquireOverlayBack(() => closeRef.current());
    return () => handle.release();
  }, [active]);
}

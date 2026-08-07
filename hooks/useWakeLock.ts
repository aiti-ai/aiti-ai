"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Keep the device screen awake while `active` is true, via the Screen Wake
 * Lock API (https://developer.mozilla.org/docs/Web/API/Screen_Wake_Lock_API).
 *
 * Browsers auto-release the lock when the tab is hidden, so the lock is
 * re-requested whenever the tab becomes visible again while still active.
 * Unsupported or permission-denied environments degrade silently — the hook
 * never throws.
 *
 * @returns true when the wake-lock API is available (the screen will stay on
 *   while `active`), false when the browser cannot keep the screen awake.
 *   Computed in an effect so server-rendered HTML and hydration agree.
 */
export function useWakeLock(active: boolean): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    if (typeof navigator !== "undefined" && "wakeLock" in navigator) setSupported(true);
  }, []);

  const activeRef = useRef(active);
  activeRef.current = active;
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;

    let disposed = false;

    const acquire = async () => {
      if (disposed || !activeRef.current || sentinelRef.current) return;
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (disposed || !activeRef.current) {
          sentinel.release().catch(() => {});
          return;
        }
        sentinelRef.current = sentinel;
        sentinel.addEventListener("release", () => {
          if (sentinelRef.current === sentinel) sentinelRef.current = null;
          // The browser may drop the lock while the tab stays visible (e.g.
          // the user toggles it from the browser UI) — re-acquire as long as
          // follow is still active.
          if (activeRef.current && !disposed && document.visibilityState === "visible") acquire();
        });
      } catch {
        // NotAllowedError (hidden tab / denied) — retried on visibilitychange.
      }
    };

    acquire();

    const onVisibility = () => {
      if (document.visibilityState === "visible") acquire();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (sentinel) sentinel.release().catch(() => {});
    };
  }, [active]);

  return supported;
}

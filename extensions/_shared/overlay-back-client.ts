/**
 * Extension-side wiring for "close the overlay on the small-screen system back gesture" (a thin
 * wrapper consuming the host back-stack service `pi-web.overlayBack`).
 *
 * Host side: `pi-web/lib/overlay-back.ts` (the single writer of the history back stack) + the client
 * service `ctx.getExtService("pi-web.overlayBack")`. Extensions must **not** listen to popstate
 * themselves (two stacks would step on each other).
 *
 * Usage (React extensions, pick one):
 *   // (1) The component is open as soon as it mounts (confirm/selector panels are open-state by nature)
 *   useEffect(() => dismissOnBack(() => extSvc("pi-web.overlayBack"), onClose), []);
 *   // (2) There is an open state (the dialog renders persistently but shows conditionally)
 *   useEffect(() => (open ? dismissOnBack(() => extSvc("pi-web.overlayBack"), () => close()) : undefined), [open]);
 *
 * Degradation: old hosts / absent service / desktop (>640px, matching the repo-wide mobile breakpoint) /
 * non-browser -> returns a no-op; browser back semantics unchanged. Whether to register is decided by
 * the built-in small-screen check; callers need no matchMedia of their own.
 * Dynamic breakpoint re-evaluation (same as the aiti-float back layer): crossing the breakpoint during
 * registration (rotation/window resize) auto acquires/releases — no "layer registered at desktop width
 * lingering into a narrow window" and no "dialog opened in a narrow window losing back-to-close after
 * returning to a wide screen".
 * Plan: docs/pi-web-mobile-back-dismiss-coverage-plan.md; contract: docs/aiti-web-ext-float-dialogs.md.
 */
export interface OverlayBackHandle {
  release(): void;
}

export interface OverlayBackService {
  acquire(close: () => void): OverlayBackHandle;
}

/** Small-screen breakpoint (same as the host useIsMobile / data-ext-float-full). */
export const OVERLAY_BACK_MOBILE_QUERY = "(max-width: 640px)";

/**
 * Register the "close on system back" layer. Returns release (idempotent; called on unmount/close).
 * @param getService fetches the host service (re-read on every breakpoint re-evaluation/re-registration; tolerates lazy loading / late-arriving services)
 * @param close the close action executed when back triggers (same as clicking ✕ / cancel / dismiss)
 */
export function dismissOnBack(
  getService: () => OverlayBackService | null | undefined,
  close: () => void,
): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(OVERLAY_BACK_MOBILE_QUERY);
  let handle: OverlayBackHandle | null = null;
  let released = false;
  const sync = (): void => {
    if (released) return;
    let service: OverlayBackService | null | undefined;
    try {
      service = getService();
    } catch {
      service = null;
    }
    const should = mq.matches && !!service && typeof service.acquire === "function";
    if (should && !handle) {
      try {
        handle = service!.acquire(close);
      } catch {
        handle = null;
      }
    } else if (!should && handle) {
      const prev = handle;
      handle = null;
      try {
        prev.release();
      } catch {
        /* a degrading host must not block the extension */
      }
    }
  };
  sync();
  const onChange = () => sync();
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
  else mq.addListener(onChange);
  return () => {
    if (released) return;
    released = true;
    if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", onChange);
    else mq.removeListener(onChange);
    const prev = handle;
    handle = null;
    if (prev) {
      try {
        prev.release();
      } catch {
        /* ignore */
      }
    }
  };
}

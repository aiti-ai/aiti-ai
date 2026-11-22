/**
 * Page-level unified toast service (pi-web.toast, 2026-09-13).
 *
 * Background: extensions used to build their own toasts (per-component state + setTimeout);
 * the host had no unified channel. This service lets the host (AppShell) own the top-right
 * toast queue, consumed by extensions via `ctx.getExtService("pi-web.toast")`'s
 * `show(text, opts?)` — the same "host provides, extensions consume" contract as
 * `pi-web.session`.
 *
 * Semantics:
 *   - show(text, { ms }): enqueue one toast, auto-dismiss after 3s by default, returns an id;
 *   - the queue supports multiple concurrent toasts (each with its own timer); the renderer
 *     can dismiss each individually via its ✕;
 *   - rendering and subscription belong to the host component HostToastHost (mounted by
 *     AppShell) — extensions only call show and never render.
 *
 * Registration: AppShell module top level `registerExtClientService("pi-web", "pi-web.toast", …)`
 * — earlier than any extension client materialize (module top-level side effects run before
 * the effect phase).
 */

export interface HostToastOptions {
  /** Auto-dismiss delay in ms, default 3000. 0 means no auto-dismiss (close manually via ✕). */
  ms?: number;
}

export interface HostToastItem {
  id: number;
  text: string;
  ms: number;
}

export interface HostToastService {
  /** Enqueue one toast; returns its id. */
  show(text: string, opts?: HostToastOptions): number;
  /** Remove the given toast immediately (used by the renderer's ✕ button). */
  dismiss(id: number): void;
}

let toasts: HostToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) {
    try { l(); } catch { /* subscriber errors must not break the loop */ }
  }
}

/** Current toast queue (renderer's useSyncExternalStore snapshot; returns the reference — a fresh array replaces it wholesale on change). */
export function getToasts(): HostToastItem[] {
  return toasts;
}

/** Subscribe to queue changes (add/remove); returns an unsubscribe function. */
export function subscribeToasts(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Remove the given toast (harmless when it does not exist). */
export function dismissToast(id: number): void {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** ctx service implementation (registered by AppShell under the key `pi-web.toast`). */
export const piWebToastService: HostToastService = {
  show(text, opts) {
    const ms = opts?.ms ?? 3000;
    const id = nextId++;
    toasts = [...toasts, { id, text, ms }];
    emit();
    if (ms > 0) {
      setTimeout(() => dismissToast(id), ms);
    }
    return id;
  },
  dismiss: dismissToast,
};

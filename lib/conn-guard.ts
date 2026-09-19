// Page-wide connection-pool anti-lock guard
//
// Background: browsers allow only ~6 concurrent HTTP/1.1 connections per host. Long-lived
// connections on the page (running/events, agent/[id]/events, terminal events, file watch,
// extension bridge SSE…) are opened separately by components/extensions; stacked across multiple
// tabs/panels the total reaches ≥6, after which every new fetch pends forever — the page starves
// as a whole (observed: videos / random fetches spin "frozen" on timeout while curl works fine).
// Refreshing temporarily frees connections, hence "may freeze after several refreshes / opening
// a few panels".
//
// Mechanism (purely event-driven, zero polling):
//   - Wraps window.fetch with header-level pending observation of same-origin requests (promise
//     resolve = response headers arrived; body streaming speed is not part of the judgment).
//   - Each registered request gets a one-shot timeout (no periodic scans); any request exceeding
//     STARVE_THRESHOLD_MS without response headers → connection pool judged starved → broadcast starve.
//   - A settle in the pending queue (fetch completed/failed) with no other overage requests →
//     broadcast unstarve.
//   - SSE holders subscribe to the starvation signal and proactively close to yield (freeing the
//     socket); after recovery each rebuilds via its existing reconnect mechanism (all reconnects
//     are safe to drop; yielding is lossless).
//   - Minimum gap MIN_STARVE_GAP_MS: minimum interval between two starve broadcasts, preventing
//     close/connect storms (unlocking takes time; repeated broadcasts don't help).
//
// Extension bundles consume it via the window CustomEvent dual channel (same precedent as
// onBackendConnChange):
//   window.addEventListener("piwe-conn-starve", (e) => { e.detail.starved ... })

export const STARVE_THRESHOLD_MS = 8_000;
export const MIN_STARVE_GAP_MS = 3_000;
/** Recovery delay: after overage requests clear, wait this long before broadcasting unstarve. An
 *  immediate recovery would let the rebuilt SSEs instantly re-occupy sockets and the next fetch
 *  would hit the full threshold again — a periodic 8s oscillation. The delayed recovery gives short
 *  requests a clear window (SSEs being offline for a few seconds is imperceptible; their reconnect
 *  mechanisms pick them back up). */
export const UNSTARVE_REBUILD_DELAY_MS = 5_000;
/** Recovery jitter: multiple tabs often enter/exit starvation nearly simultaneously (same wave of
 *  refreshes / same wave of yielding); a fixed delay would have every tab's SSE re-occupy the
 *  connection pool in the same millisecond — a reconnect storm. Each tab independently waits a
 *  random 0~JITTER before broadcasting unstarve, naturally staggering the reconnect moments. */
export const UNSTARVE_JITTER_MS = 4_000;

interface PendingEntry {
  url: string;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

type StarveListener = (starved: boolean) => void;

const starveListeners = new Set<StarveListener>();
let pending = new Map<number, PendingEntry>();
let nextId = 1;
let starved = false;
let lastStarveAt = 0;
let installed = false;
let unstarveTimer: ReturnType<typeof setTimeout> | null = null;

declare global {
  interface Window {
    __connGuardInstalled?: boolean;
  }
}

function broadcast(next: boolean): void {
  if (starved === next) return;
  starved = next;
  if (next) lastStarveAt = Date.now();
  starveListeners.forEach((f) => { try { f(starved); } catch { /* subscriber errors don't propagate */ } });
  try {
    window.dispatchEvent(new CustomEvent("piwe-conn-starve", { detail: { starved } }));
  } catch { /* non-browser */ }
}

/** Whether any request is overage (no response headers past the threshold). Called when a registered timer fires / any request settles. */
function hasOverageLocked(now: number): boolean {
  for (const entry of pending.values()) {
    if (now - entry.startedAt >= STARVE_THRESHOLD_MS) return true;
  }
  return false;
}

function settle(id: number): void {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timeout);
  pending.delete(id);
  if (starved && !hasOverageLocked(Date.now()) && !unstarveTimer) {
    // Recovery delay (see UNSTARVE_REBUILD_DELAY_MS): gives short requests a clear window,
    // avoiding the periodic oscillation of "SSE re-occupies → the next fetch hits the full
    // threshold again"; plus random jitter (UNSTARVE_JITTER_MS) to stagger recovery/reconnect
    // moments across tabs.
    const delay = UNSTARVE_REBUILD_DELAY_MS + Math.random() * UNSTARVE_JITTER_MS;
    unstarveTimer = setTimeout(() => {
      unstarveTimer = null;
      if (pending.size === 0 || !hasOverageLocked(Date.now())) broadcast(false);
    }, delay);
  }
}

/** Idempotently install the fetch observation (call once from the page client side). */
export function installConnGuard(): void {
  if (installed || typeof window === "undefined" || typeof window.fetch !== "function") return;
  if (window.__connGuardInstalled) return;
  installed = true;
  window.__connGuardInstalled = true;

  const origFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const sameOrigin = typeof url === "string" && (url.startsWith("/") || url.startsWith(`${location.origin}/`));
    if (!sameOrigin) return origFetch(input as RequestInfo, init);

    const id = nextId++;
    const entry: PendingEntry = {
      url,
      startedAt: Date.now(),
      // one-shot timeout (scheduled at registration, cleared on settle) — starvation judged event-driven, not by periodic polling
      timeout: setTimeout(() => {
        if (Date.now() - entry.startedAt < STARVE_THRESHOLD_MS) return;
        if (starved) {
          // still overage (starvation unresolved): cancel the in-flight recovery — SSEs must not come back while starved requests remain
          if (unstarveTimer) { clearTimeout(unstarveTimer); unstarveTimer = null; }
          return;
        }
        // starvation broadcast throttle: unlocking takes time; no repeat broadcast within MIN_STARVE_GAP_MS
        if (Date.now() - lastStarveAt < MIN_STARVE_GAP_MS) return;
        broadcast(true);
      }, STARVE_THRESHOLD_MS),
    };
    pending.set(id, entry);

    const p = origFetch(input as RequestInfo, init);
    p.then(
      () => settle(id),
      () => settle(id),
    );
    return p;
  }) as typeof window.fetch;
}

/** Subscribe to starvation transitions (returns an unsubscribe function). Subscribers (SSE holders) receiving true should proactively close to yield. */
export function onConnStarvation(listener: StarveListener): () => void {
  starveListeners.add(listener);
  return () => { starveListeners.delete(listener); };
}

/** Whether currently starved (check once before subscribing to avoid missing a transition). */
export function isConnStarved(): boolean {
  return starved;
}

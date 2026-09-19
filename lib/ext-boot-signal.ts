/**
 * ext-boot-signal — host boot signal hub (lightweight lib-side sharing, no
 * React/component dependencies).
 *
 * 1) boot-settle: the extension boot batch settle signal (§3-C1).
 * 2) Event bus deployment verdict: after the manifest is fetched, records
 *    whether the event bus extension is in the deployment manifest (disabled
 *    extensions do not appear in the manifest = the manifest is the source of
 *    truth for "installed and enabled"). getEventBus makes a three-way
 *    verdict from it: deployed but not ready → queue the subscription (never
 *    fall back to native); not deployed → fall back; unknown (manifest not
 *    back yet) → optimistic queueing. Set by ExtSlots.fetchManifestData.
 */

let settled = false;
const listeners = new Set<() => void>();

/** Boot batch settle (the first attempt finished, success or failure alike). Idempotent: repeated calls only take effect the first time. */
export function notifyExtBootSettled(): void {
  if (settled) return;
  settled = true;
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* a failed snapshot notification does not block the rest */ }
  }
  listeners.clear();
}

/** Whether the boot batch has settled. */
export function isExtBootSettled(): boolean {
  return settled;
}

/** Subscribes to the settle signal (fires synchronously once if already settled). Returns an unsubscribe function. */
export function onExtBootSettled(fn: () => void): () => void {
  if (settled) {
    try { fn(); } catch { /* consumer exceptions do not propagate */ }
    return () => {};
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Event bus deployment verdict (unified SSE port plan v2: deployment
// fact, not runtime guessing) ──────
// Set by the host (ExtSlots.fetchManifestData) after the manifest is fetched:
// the event bus extension being in the manifest (disabled extensions are
// skipped by loadAll and do not appear in the manifest) = the bus is
// installed and enabled, and client registration is only a matter of time.
// getEventBus makes a three-way verdict from it:
//   true  → not-ready subscription requests are queued (never fall back to
//           native SSE — this eliminates the leak source)
//   false → not deployed; callers fall back to native SSE per their own
//           contract (the only fallback condition)
//   null  → manifest not back yet (very early window): optimistic queueing,
//           routed after the verdict arrives
// A reload that pulls a fresh manifest can flip the verdict
// (install/uninstall/enable/disable), and waiters are re-routed accordingly.

let busDeployed: boolean | null = null;
const busDeployedListeners = new Set<(deployed: boolean) => void>();

/** Deployment verdict (called as soon as the manifest is back; notifies waiters when the value changes). */
export function settleEventBusDeployed(deployed: boolean): void {
  if (busDeployed === deployed) return;
  busDeployed = deployed;
  for (const fn of [...busDeployedListeners]) {
    try { fn(deployed); } catch { /* consumer exceptions do not propagate */ }
  }
}

/** Current verdict: true deployed / false not deployed / null unknown (manifest not back yet). */
export function eventBusDeployedVerdict(): boolean | null {
  return busDeployed;
}

/** Subscribes to the deployment verdict (fires synchronously once if already settled). Returns an unsubscribe function. */
export function onEventBusDeployed(fn: (deployed: boolean) => void): () => void {
  if (busDeployed !== null) {
    try { fn(busDeployed); } catch { /* consumer exceptions do not propagate */ }
    return () => {};
  }
  busDeployedListeners.add(fn);
  return () => busDeployedListeners.delete(fn);
}

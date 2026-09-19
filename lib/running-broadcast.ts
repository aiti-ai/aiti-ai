/**
 * Running-set bus broadcast (2026-09-15): decouples running-frame production
 * from the connection lifecycle of /api/agent/running/events.
 *
 * Background (observed in production on 2026-09-15): the original producer of
 * running frames lived inside the events route's GET — the three-way
 * subscription (rpc/handle/bridge) was only registered when a client
 * connected to that route directly. After page events were consolidated into
 * the shared event bus, nobody connected directly (0 connections in
 * production that day, per nginx) → the bus running topic got no frames →
 * the session-manager "received a running frame" health check stayed false →
 * every client fell back to polling /api/agent/running every 30s (the
 * fallback polling was amplified into the norm).
 *
 * This module: subscribes to running changes on all three paths (the
 * subscription sets are all globalThis-backed — rpc's __piRunningListeners,
 * handle's __piHandleRunningListeners, bridge's __aitiBridgeRunning.listeners,
 * effective across module-graph realms); any change → merge the full set →
 * dedupe against the previous content → broadcast the running frame widely
 * (core sinks + bus slot accessors). ensureRunningBroadcast() is called from
 * entry points guaranteed to load (the instrumentation startup section / the
 * /api/agent/running snapshot route — two entry points as a safety net);
 * globalThis makes it idempotent — registered only once across realms.
 *
 * Relationship with the events route: the route keeps its own three-way
 * subscription (self-sufficient in direct-connect mode; a direct
 * publishPageEvent call only reaches this module graph's sinks); the
 * cross-client main channel (the bus) is fed uniformly by this module, with
 * no double-emission between the two (see comments inside the route).
 */
import { getRunningRpcSessionIds, subscribeRunningSessions } from "./rpc-manager.ts";
import { getRunningHandleIds, subscribeRunningHandles } from "./session/handle-store.ts";
import { getBridgeRunningIds, subscribeBridgeRunning } from "./session/bridge-running.ts";
import { publishPageEventToBus } from "./agent-page-events.ts";
import { mergeRunningIds, runningFrameKey } from "./running-broadcast-core.ts";

/** Merges the three-way running set (rpc local + handle backend + TUI bridge unclaimed), matching the inline versions in each route. */
export function mergedRunningIds(): string[] {
  return mergeRunningIds(getRunningRpcSessionIds(), getRunningHandleIds(), getBridgeRunningIds());
}

const KEY_SLOT = "__piRunningBroadcastKey";
const WIRED_SLOT = "__piRunningBroadcastWired";

/**
 * Merges and publishes the running frame (skips when the content is identical
 * to the previous one — if multiple paths fire on the same change, or the
 * change fires again across realms, only one frame is emitted).
 * The dedupe key lives on globalThis: shared across module-graph realms so
 * the same change is not re-emitted once per realm.
 */
export function publishMergedRunning(): void {
  const ids = mergedRunningIds();
  const key = runningFrameKey(ids);
  const g = globalThis as Record<string, unknown>;
  if (g[KEY_SLOT] === key) return;
  g[KEY_SLOT] = key;
  publishPageEventToBus("running", { runningSessionIds: ids });
}

/**
 * Idempotently registers the three-way subscriptions + emits the first frame
 * snapshot. The globalThis flag guarantees registration happens only once
 * across realms (the first registrant's closure is held by the globalThis
 * subscription sets and stays alive for the process lifetime).
 *
 * Call sites (two entry points as a safety net):
 *   - instrumentation.register(): after the bus startup (early, full coverage);
 *   - app/api/agent/running/route.ts GET: activates on first access in any
 *     deployment shape.
 */
export function ensureRunningBroadcast(): void {
  const g = globalThis as Record<string, unknown>;
  if (g[WIRED_SLOT]) return;
  g[WIRED_SLOT] = true;
  subscribeRunningSessions(() => publishMergedRunning());
  subscribeRunningHandles(() => publishMergedRunning());
  subscribeBridgeRunning(() => publishMergedRunning());
  // Initial snapshot (emit even when empty: a newly subscribed page aligns
  // with the authoritative empty set right away instead of waiting for the
  // first change)
  publishMergedRunning();
}

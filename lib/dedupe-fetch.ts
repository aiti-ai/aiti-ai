// Load-window fetch dedupe (see docs/pi-web-load-duplicate-requests-analysis.md §3.1).
//
// "Single-flight + micro cache" for read-only GETs: concurrent requests to the same URL
// share the in-flight promise; successful responses are reused directly within ttlMs.
// This covers duplicate requests inside a seconds-wide window caused by component
// remounts, desktop moves across dual instances, or multiple consumers -- it does not
// change any polling/SSE contract (SSE remains the authoritative source; a fallback
// snapshot that is 2-3s stale is fine).
//
// Only apply it to "read-only, no-store, idempotent" GETs (/api/home,
// /api/agent/running, */status and the like); requests with write semantics or that
// must be fresh every time must not go through here.

const DEFAULT_TTL_MS = 2_500;

interface CacheEntry {
  /** Resolves to the **unconsumed** original Response -- clones are teed off from here */
  promise: Promise<Response>;
  /** Cache expiry time (set only for successful responses; 0 = still in flight / failures are not cached) */
  freshUntil: number;
}

const inflight = new Map<string, CacheEntry>();

export interface DedupeFetchOptions extends RequestInit {
  /** Micro-cache duration for successful responses (default 2.5s; only covers the load window) */
  ttlMs?: number;
}

/**
 * dedupeFetch(url, {ttlMs}): concurrent callers for the same URL share a single network
 * request, and each caller receives its own Response clone (the original body never
 * leaks directly; whoever calls .json() first does not affect the others).
 * - In-flight coalescing: a second concurrent caller shares the first caller's round trip;
 * - TTL micro cache: new calls within ttlMs of a successful (res.ok) response reuse it with zero network;
 * - Failed responses are not cached (the next caller retries immediately); only the in-flight entry is released.
 */
export function dedupeFetch(url: string, options?: DedupeFetchOptions): Promise<Response> {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const hit = inflight.get(url);
  // Still in flight (freshUntil=0) or cache fresh -> share; only fetch anew once expired
  if (hit && (hit.freshUntil === 0 || Date.now() < hit.freshUntil)) return hit.promise.then((r) => r.clone());
  const promise = fetch(url, options).then((res) => {
    const entry = inflight.get(url);
    if (entry && entry.promise === promise) {
      // Success: stamp the cache expiry time; failure: keep no cache (the next call really fetches)
      if (res.ok) entry.freshUntil = Date.now() + ttlMs;
      else inflight.delete(url);
    }
    return res;
  }).catch((err) => {
    const entry = inflight.get(url);
    if (entry && entry.promise === promise) inflight.delete(url);
    throw err;
  });
  inflight.set(url, { promise, freshUntil: 0 });
  return promise.then((r) => r.clone());
}

/** Test hook: clear all cached state. */
export function resetDedupeFetch(): void {
  inflight.clear();
}

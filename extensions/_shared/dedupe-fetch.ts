// Load-window fetch dedupe (plan docs/pi-web-load-duplicate-requests-analysis.md
// §3.1/§3.4; the pi-web host-side twin lives in pi-web lib/dedupe-fetch.ts).
//
// "Single-flight + micro cache" for read-only GETs: concurrent requests to the same URL
// share the in-flight promise; successful responses are reused directly within ttlMs.
// Covers duplicate requests inside a seconds-wide window caused by component remounts,
// desktop/mobile twin instances, and multiple consumer surfaces — it changes no
// polling/SSE contract (SSE remains the authority; a fallback snapshot 2-3s stale is fine).
//
// Applies only to "read-only, no-store, idempotent" GETs (/api/home, /api/agent/running,
// */status types); requests with write semantics or that must be fresh every time
// must not go through here.

const DEFAULT_TTL_MS = 2_500;

interface CacheEntry {
  /** Resolves to the **unconsumed** original Response — the clone branch tees off it */
  promise: Promise<Response>;
  /** Cache expiry instant (set only for successful responses; 0 = still in flight / failures not cached) */
  freshUntil: number;
}

const inflight = new Map<string, CacheEntry>();

export interface DedupeFetchOptions extends RequestInit {
  /** Micro-cache duration for successful responses (default 2.5s; covers only the load window) */
  ttlMs?: number;
}

/**
 * dedupeFetch(url, {ttlMs}): concurrent calls to the same URL share one network request;
 * each caller gets its own Response clone (the original body never leaks out directly;
 * whoever .json()s first doesn't affect the others).
 * - in-flight merge: a second concurrent caller shares the first's network round-trip;
 * - TTL micro cache: a new call within ttlMs of a successful (res.ok) response reuses it
 *   with zero network;
 * - failed responses are not cached (the next caller retries immediately); only the
 *   in-flight entry is released.
 */
export function dedupeFetch(url: string, options?: DedupeFetchOptions): Promise<Response> {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const hit = inflight.get(url);
  // still in flight (freshUntil=0) or cache fresh → share; only an expiry pulls a real new request
  if (hit && (hit.freshUntil === 0 || Date.now() < hit.freshUntil)) return hit.promise.then((r) => r.clone());
  const promise = fetch(url, options).then((res) => {
    const entry = inflight.get(url);
    if (entry && entry.promise === promise) {
      // success: mark the cache expiry; failure: keep no cache (the next call pulls for real)
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

/** Test hook: clears all cache state. */
export function resetDedupeFetch(): void {
  inflight.clear();
}

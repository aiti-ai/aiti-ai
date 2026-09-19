/**
 * Client-side model list cache (localStorage, slotted by cwd).
 *
 * Motivation: /api/models results must be reloaded on first paint and on
 * session switches, and the browser main thread is often busy with extension
 * scripts/first-frame rendering — the request goes out late (measured 3.7s
 * after page load) and the response arrives even later (0.6~5.8s per request
 * measured over the public internet), so model names/default model show up
 * very late. This caches the most recent successful response: `loadModels`
 * synchronously replays the cache on mount (stale-while-revalidate), then
 * overwrites it with the network result when that arrives — the model name
 * column renders immediately, without waiting for the request round trip.
 *
 * Cached content is display data only (model id/name/provider/thinking
 * tiers, same shape as the /api/models response; no keys, no local paths).
 * Best-effort: unavailable storage/quota overrun/corruption all degrade
 * silently (same style as workspace-memory); a single cwd slot over
 * MAX_BYTES is not written (protection against abnormal bloat).
 *
 * Invalidation: once MAX_ENTRIES is full, LRU eviction by last-write time;
 * slots older than MAX_AGE_MS are treated as nonexistent on read (and
 * removed on the spot); model config changes (`pi-web:models-changed`) are
 * fully cleared by the caller via `clearCachedModels()`.
 */

const KEY_PREFIX = "pi-web:models-cache:";
const INDEX_KEY = `${KEY_PREFIX}__index__`;
/** A slot older than this is considered invalid (matches the /api/models server-side disk snapshot cap). */
export const MODELS_CLIENT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Maximum number of cwd slots kept (LRU eviction). */
export const MODELS_CLIENT_CACHE_MAX_ENTRIES = 8;
/** Per-slot serialization cap: nothing larger is written (guards localStorage against abnormal bloat). */
export const MODELS_CLIENT_CACHE_MAX_BYTES = 256 * 1024;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Minimal shape validation for cache entries: anything less counts as no cache (callers always get a usable shape). */
interface CachedModelsShape {
  models: Record<string, string>;
  modelList: unknown[];
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function cacheKeyFor(cwd: string): string {
  // An empty cwd (server-side process.cwd() semantics) still gets a stable slot.
  return `${KEY_PREFIX}${cwd || "@default"}`;
}

function readIndex(storage: StorageLike): Record<string, number> {
  try {
    const raw = storage.getItem(INDEX_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function removeSlot(storage: StorageLike, cwd: string, index: Record<string, number>): void {
  try {
    storage.removeItem(cacheKeyFor(cwd));
  } catch {
    // ignore
  }
  delete index[cwd];
}

function pruneIndex(storage: StorageLike, index: Record<string, number>): void {
  const keys = Object.keys(index);
  if (keys.length <= MODELS_CLIENT_CACHE_MAX_ENTRIES) return;
  keys
    .sort((a, b) => (index[a] ?? 0) - (index[b] ?? 0))
    .slice(0, keys.length - MODELS_CLIENT_CACHE_MAX_ENTRIES)
    .forEach((key) => removeSlot(storage, key, index));
}

/**
 * Reads and replays the cache for a cwd. Missing/expired/corrupt → null
 * (expired slots are removed on the spot).
 */
export function readCachedModels<T>(cwd: string, storage: StorageLike | null = getBrowserStorage()): T | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(cacheKeyFor(cwd));
    if (!raw) return null;
    const entry = JSON.parse(raw) as { savedAt?: unknown; data?: unknown };
    const savedAt = typeof entry?.savedAt === "number" ? entry.savedAt : 0;
    if (!entry?.data || typeof entry.data !== "object") return null;
    if (Date.now() - savedAt > MODELS_CLIENT_CACHE_MAX_AGE_MS) {
      const index = readIndex(storage);
      removeSlot(storage, cwd, index);
      try {
        storage.setItem(INDEX_KEY, JSON.stringify(index));
      } catch {
        // ignore
      }
      return null;
    }
    const data = entry.data as Partial<CachedModelsShape>;
    // Discard on failed shape validation: callers always get a usable structure (models map + modelList array).
    if (!data.models || typeof data.models !== "object" || !Array.isArray(data.modelList)) return null;
    return data as T;
  } catch {
    return null;
  }
}

/**
 * Writes the cache for a cwd (overwrites the old value). Quota overrun/
 * corruption/unavailable storage are silently ignored.
 */
export function writeCachedModels(cwd: string, data: unknown, storage: StorageLike | null = getBrowserStorage()): void {
  if (!storage) return;
  try {
    const payload = JSON.stringify({ savedAt: Date.now(), data });
    if (payload.length > MODELS_CLIENT_CACHE_MAX_BYTES) return;
    storage.setItem(cacheKeyFor(cwd), payload);
    const index = readIndex(storage);
    index[cwd] = Date.now();
    pruneIndex(storage, index);
    storage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // quota / private mode / unavailable — the cache is best-effort
  }
}

/**
 * The most recently written cached cwd (newest LRU slot); no cache/corrupt
 * index → null. Lets AppShell warm the model list before the real cwd is
 * ready (the vast majority of visits return to the previous project).
 */
export function readMostRecentCachedCwd(storage: StorageLike | null = getBrowserStorage()): string | null {
  if (!storage) return null;
  try {
    const index = readIndex(storage);
    let best: string | null = null;
    let bestAt = -1;
    for (const [cwd, at] of Object.entries(index)) {
      if (at > bestAt) {
        bestAt = at;
        best = cwd;
      }
    }
    if (best === null) return null;
    return best;
  } catch {
    return null;
  }
}

/**
 * Clears all slots (called on the model config changed broadcast so a stale
 * list is not replayed next time).
 */
export function clearCachedModels(storage: StorageLike | null = getBrowserStorage()): void {
  if (!storage) return;
  try {
    const index = readIndex(storage);
    for (const cwd of Object.keys(index)) {
      try {
        storage.removeItem(cacheKeyFor(cwd));
      } catch {
        // ignore
      }
    }
    storage.removeItem(INDEX_KEY);
  } catch {
    // ignore
  }
}

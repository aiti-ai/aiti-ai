/**
 * Client-side singleton for the home directory (shared across extensions; dedupes
 * requests made when pages open).
 *
 * Several consumers fetch `/api/home` on page open (the host fallback sidebar,
 * the session manager, the folder panel…); previously each fetched on its own
 * (some deduped only within the extension, but across extensions it was still
 * multiple network requests). This module converges that into an in-process
 * singleton: one fetch + a cached result + subscription broadcast; the host
 * hands it out to extensions via the `pi-web.home` client service
 * (`ctx.getExtService("pi-web.home")`), so extensions no longer fetch it themselves.
 *
 * "Fetch only when needed": the request fires only when `ensure()` is called
 * (the first consumer that actually needs the ~ abbreviation).
 */
import { apiUrl } from "./base-path";

/** Shape exposed by the client service (consumed on the extension side). */
export interface HomeDirService {
  /** Read the cached value synchronously (null when not ready). */
  get(): string | null;
  /** Fetch once (in-flight requests merge); returns null on failure (callers fall back to showing the full path). */
  ensure(): Promise<string | null>;
}

let homeDir: string | null = null;
let inflight: Promise<string | null> | null = null;
const subs = new Set<(dir: string | null) => void>();

export function getHomeDir(): string | null {
  return homeDir;
}

export function ensureHomeDir(): Promise<string | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (homeDir) return Promise.resolve(homeDir);
  if (inflight) return inflight;
  const p = fetch(apiUrl("/api/home"))
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { home?: unknown } | null) => {
      if (j && typeof j.home === "string" && j.home) {
        homeDir = j.home;
        for (const cb of [...subs]) {
          try { cb(homeDir); } catch { /* one subscriber's error must not affect the others */ }
        }
      }
      return homeDir;
    })
    .catch(() => null)
    .finally(() => { inflight = null; });
  inflight = p;
  return p;
}

/** Subscribe to the home directory becoming available (returns an unsubscribe; does not trigger ensure — whether to fetch is the consumer's call). */
export function subscribeHomeDir(cb: (dir: string | null) => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

/** Client-service implementation handed out to extensions. */
export const homeDirService: HomeDirService = { get: getHomeDir, ensure: ensureHomeDir };

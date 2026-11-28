/**
 * Home directory for "~" display — one request per page shared by every picker.
 *
 * Prefers the host's shared service ("pi-web.home", lib/home-dir single fetch across the
 * host and all extensions); older hosts fall back to /api/home through dedupeFetch.
 * Lazy on purpose: a module-level fetch would run before the host's register(ctx), so
 * apiUrl would miss the base path on sub-path deployments.
 */
import { apiUrl, getExtService } from "./host-shim";
import { dedupeFetch } from "@aiti-ai/ext-shared/dedupe-fetch";

let cached: string | null = null;
let pending: Promise<string> | null = null;

export function fetchHomeDir(): Promise<string> {
  if (cached !== null) return Promise.resolve(cached);
  if (pending) return pending;
  const svc = getExtService<{ ensure: () => Promise<string | null> }>("pi-web.home");
  const request = svc?.ensure
    ? svc.ensure()
    : dedupeFetch(apiUrl("/api/home"))
        .then((response) => response.json())
        .then((data: { home?: string } | null) => data?.home ?? null)
        .catch(() => null);
  pending = Promise.resolve(request)
    .then((dir) => {
      cached = typeof dir === "string" ? dir : "";
      return cached;
    })
    .finally(() => { pending = null; });
  return pending;
}

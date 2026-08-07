// Base-path helpers for sub-path deployments.
//
// pi-web does not hardcode support for Next.js `basePath` everywhere — client
// fetches, EventSource streams and asset references use absolute root paths
// (`/api/...`, `/sw.js`). These helpers make every client-originated URL
// base-path aware so the app can be served under e.g. `https://host/dev/`.
//
// The value comes from `NEXT_PUBLIC_BASE_PATH` (set alongside `basePath` in
// next.config.ts) and is empty for a root deployment. It is read per call —
// Next.js statically inlines NEXT_PUBLIC_* at build time, so this is a
// constant in production builds, and it keeps the module unit-testable.

/** The configured base path (`/dev`) or empty string for root deployments. */
export function getBasePath(): string {
  return (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");
}

/** Prefix a root-absolute path with the configured base path. */
export function withBasePath(path: string): string {
  const basePath = getBasePath();
  if (!basePath) return path;
  if (path === basePath || path.startsWith(`${basePath}/`) || path.startsWith(`${basePath}?`)) {
    return path;
  }
  return `${basePath}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Prefix an API path (`/api/...`) with the configured base path. */
export function apiUrl(path: string): string {
  return withBasePath(path);
}

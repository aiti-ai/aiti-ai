import { isIP } from "node:net";

// globalThis state written by the service-tunnels extension (self-expose config):
// __piWebExposeConfig = parsed PI_WEB_EXPOSE result (allowHost etc.),
// __piWebAllowHostsOverride = runtime allowHost overrides (written via the extension API).
// This module (the core gate) is read-only and does not drift with extension
// load state (unset = no exceptions).
declare global {
  var __piWebAllowHostsOverride: string[] | undefined;
  var __piWebExposeConfig: Record<string, unknown> | undefined;
}

function normalizeHostname(value: string): string {
  const unbracketed = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  return unbracketed.toLowerCase().replace(/\.$/, "");
}

function hostnameFromAuthority(value: string): string | null {
  if (!value || /[\s/@\\]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}

function normalizeAuthority(value: string): string | null {
  if (!value || /[\s/@\\]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    const hostname = normalizeHostname(parsed.hostname);
    return parsed.port ? `${hostname}:${parsed.port}` : hostname;
  } catch {
    return null;
  }
}

function normalizeConfiguredHostname(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return isIP(trimmed) ? normalizeHostname(trimmed) : hostnameFromAuthority(trimmed);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function configuredHostnamesFromEnvironment(): string[] {
  const out = [
    process.env.PI_WEB_HOSTNAME,
    process.env.PI_WEB_BASE_DOMAIN,
    ...(process.env.PI_WEB_ALLOWED_HOSTS?.split(",") ?? []),
  ].filter((value): value is string => Boolean(value?.trim()));
  // allowlocal exception hosts (PI_WEB_EXPOSE allowHost / runtime overrides) —
  // operator-protected front domains that pass the host gate even when
  // allowlocal=false.
  if (Array.isArray(globalThis.__piWebAllowHostsOverride)) {
    out.push(...globalThis.__piWebAllowHostsOverride);
  }
  const cfg = globalThis.__piWebExposeConfig;
  const ah = cfg?.allowHost;
  if (Array.isArray(ah)) out.push(...ah.map(String));
  else if (typeof ah === "string") out.push(ah);
  return out;
}

function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getRequestOrigin(request: Request): string | null {
  const requestUrl = new URL(request.url);
  // After the middleware self-forward rewrite, host=127.0.0.1:port and
  // requestUrl is the internal target; the browser actually connects to the
  // vhost (nginx sets X-Forwarded-Host/Proto). Reconstruct the real expected
  // origin from the forwarded headers, otherwise Origin (https://vhost) and
  // http://127.0.0.1 would never match.
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? requestUrl.protocol.replace(":", "");
  return host ? canonicalOrigin(`${proto}://${host}`) : null;
}

function isPdfFileReadUrl(url: URL): boolean {
  if (!url.pathname.startsWith("/api/files/") || url.searchParams.get("type") !== "read") return false;
  const lastSegment = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(lastSegment).toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

/**
 * A top-level GET the user clicked can arrive marked cross-site with no Origin
 * when the page holding the link has an opaque origin: a PWA's own window
 * opening the session export, or Android Chrome's `data:` placeholder for a PDF
 * it will not render in the viewer's iframe (#1298). Only routes with no side
 * effect whose response cannot run script in the Pi Web origin qualify: the
 * export page (framing denied) and `type=read` of a `.pdf`, which the route
 * always serves as `application/pdf` with nosniff. The opening page cannot
 * read either response.
 */
function isUserInitiatedSessionExportNavigation(request: Request): boolean {
  if (
    request.method !== "GET"
    || request.headers.get("sec-fetch-mode") !== "navigate"
    || request.headers.get("sec-fetch-dest") !== "document"
    || request.headers.get("sec-fetch-user") !== "?1"
  ) {
    return false;
  }

  try {
    return /^\/api\/sessions\/[^/]+\/export$/.test(new URL(request.url).pathname);
  } catch {
    return false;
  }
}

function isUserInitiatedDocumentNavigation(request: Request): boolean {
  if (
    request.method !== "GET"
    || request.headers.get("sec-fetch-mode") !== "navigate"
    || request.headers.get("sec-fetch-dest") !== "document"
    || request.headers.get("sec-fetch-user") !== "?1"
  ) {
    return false;
  }

  try {
    const url = new URL(request.url);
    return /^\/api\/sessions\/[^/]+\/export$/.test(url.pathname) || isPdfFileReadUrl(url);
  } catch {
    return false;
  }
}

/** The configured base domain (e.g. example.com): the serving vhost
 *  (*.example.com) is a subdomain of it and reaches the API only after
 *  middleware resolve + auth, so it is trusted. */
function baseDomainHostnames(): string[] {
  const out: string[] = [];
  for (const v of [process.env.PI_WEB_BASE_DOMAIN, process.env.PI_WEB_HOSTNAME]) {
    const h = normalizeConfiguredHostname(v);
    if (h && !isIP(h)) out.push(h);
  }
  return out;
}

function isBaseDomainSubdomain(hostname: string): boolean {
  return baseDomainHostnames().some((b) => hostname === b || hostname.endsWith(`.${b}`));
}

/** Operator-trusted hosts: loopback/IP literals, the configured base domain
 *  and its subdomains, and explicitly configured hosts (PI_WEB_HOSTNAME /
 *  PI_WEB_BASE_DOMAIN / PI_WEB_ALLOWED_HOSTS / runtime allowHost). IP
 *  literals preserve LAN access and cannot be DNS-rebound. */
function isTrustedHostname(hostname: string, configuredHostnames: string[]): boolean {
  if (isLoopbackHostname(hostname) || isIP(hostname)) return true;
  // the serving vhost (*.example.com) is an operator-domain subdomain — already resolved+authenticated by middleware
  if (isBaseDomainSubdomain(hostname)) return true;
  return configuredHostnames.some(
    (configured) => normalizeConfiguredHostname(configured) === hostname,
  );
}

/**
 * Only trust local names, IP literals, or the hostname explicitly selected by
 * the operator. IP literals preserve LAN access but cannot be DNS-rebound
 * because the browser keeps the literal address in the Host header.
 */
export function isApiRequestHostAllowed(
  request: Request,
  configuredHostnames = configuredHostnamesFromEnvironment(),
): boolean {
  const host = request.headers.get("host");
  const hostname = host ? hostnameFromAuthority(host) : null;
  if (!hostname) return false;
  return isTrustedHostname(hostname, configuredHostnames);
}

/**
 * A relay can report the external scheme in `x-forwarded-proto` while rewriting
 * `Origin` onto the backend authority, so the two disagree on the scheme alone
 * for a request that really is same-origin (Azure Dev Tunnels does this). Accept
 * that pairing only when the Origin's authority still equals the Host header,
 * a proxy is in front, and Fetch Metadata still reports a same-origin request.
 */
function isProxyRewrittenSameOrigin(request: Request, origin: string): boolean {
  if (
    request.headers.get("sec-fetch-site") !== "same-origin"
    || !request.headers.get("x-forwarded-proto")
  ) return false;

  const host = request.headers.get("host");
  if (!host) return false;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  const originAuthority = normalizeAuthority(originHost);
  return originAuthority !== null && originAuthority === normalizeAuthority(host);
}

/** Reject browser cross-site API requests while preserving non-browser clients. */
export function isApiRequestOriginAllowed(
  request: Request,
  configuredHostnames = configuredHostnamesFromEnvironment(),
): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  // Explicitly configured extra allowed origins (API_ALLOW_ORIGINS,
  // comma-separated; supports `*` or exact/prefix `scheme://host` matching).
  // Purpose: the devtools injection page (service-tunnels vhost) connecting
  // cross-origin straight to the bridge — configure the injection page domain
  // at deploy time; use localhost for local development. Explicit config, not
  // a hardcoded whitelist; a configured match is allowed (cross-site
  // included).
  const allowOrigins = (process.env.API_ALLOW_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (origin) {
    for (const a of allowOrigins) {
      if (a === "*") return true;
      if (origin.startsWith(a.replace(/\/+$/, ""))) return true;
    }
  }

  if (fetchSite === "cross-site") return false;
  if (!origin) return true;

  const requestOrigin = getRequestOrigin(request);
  // If the expected origin comes from x-forwarded-host (not the actual host),
  // the forwarded header must itself be trusted (loopback/IP/operator-domain
  // subdomain or explicitly configured host), otherwise a malicious page
  // could forge XFH to match its own Origin and bypass the CSRF gate. This
  // check precedes every allow path.
  if (request.headers.get("x-forwarded-host")) {
    const fh = request.headers.get("x-forwarded-host");
    const hostname = fh ? hostnameFromAuthority(fh) : null;
    if (hostname && !isTrustedHostname(hostname, configuredHostnames)) {
      return false;
    }
  }
  if (requestOrigin !== null && canonicalOrigin(origin) === requestOrigin) return true;

  // Upstream: the proxy-rewritten-Origin same-origin pairing (Azure Dev
  // Tunnels etc.) — relies on browser-only Fetch Metadata (sec-fetch-site);
  // non-browser clients were already rejected by the cross-site gate above.
  return isProxyRewrittenSameOrigin(request, origin);
}

export function shouldCheckApiRequestOrigin(request: Request): boolean {
  return request.headers.has("origin") || request.headers.has("sec-fetch-site");
}

export function isApiRequestAllowed(
  request: Request,
  configuredHostnames = configuredHostnamesFromEnvironment(),
): boolean {
  if (!isApiRequestHostAllowed(request, configuredHostnames)) return false;
  if (isUserInitiatedSessionExportNavigation(request)) return true;
  if (isUserInitiatedDocumentNavigation(request)) return true;
  return !shouldCheckApiRequestOrigin(request) || isApiRequestOriginAllowed(request, configuredHostnames);
}

export function hasJsonContentType(request: Request): boolean {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json"
    || Boolean(mediaType?.startsWith("application/") && mediaType.endsWith("+json"));
}

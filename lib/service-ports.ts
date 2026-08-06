import type { ServicePortInfo } from "service-tunnels";
import { getServiceTunnels } from "./service-tunnels-integration.ts";
import { getBaseDomains as getBaseDomainsShared, getServiceHostSuffixes } from "./service-proxy-shared.ts";

/**
 * Service-port discovery — thin adapter over the service-tunnels library.
 *
 * Everything platform-specific (Linux /proc, macOS ps+lsof, Windows
 * Get-CimInstance+netstat, wildcard address expansion, marker-based child
 * discovery) now lives in the library; this module keeps pi-web's discovery
 * + virtual-host suffix machinery on top of it.
 *
 * Discovery here is a CANDIDATE LIST for the UI only. The proxy allow-list is
 * read directly from the library's persisted enrollment (state.json bindings)
 * by the middleware — no pi-web-owned cache file is written anymore.
 */

export type { ServicePortInfo } from "service-tunnels";

// Platform parsers + address expansion live in the library (re-exported so
// pi-web and its tests use exactly the same implementations as discovery).
export { decodeIpv4, decodeIpv6, expandListeningAddresses, parseLsofAddress, parseNetstatAddress } from "service-tunnels";

/** pi-web's own process cmdline patterns (never "services"). */
const PI_WEB_OWN = [/next[\\/]dist[\\/]bin[\\/]next/, /next-server/, /pi-web(-options)?\.js/, /bin[\\/]pi-web/];

/** True for command lines that are pi-web itself (not a user test service). */
export function isPiWebProcess(cmdline: string): boolean {
  return PI_WEB_OWN.some((re) => re.test(cmdline));
}

/** Uncached, Map-form discovery (port → info) — for tests / ad-hoc use. */
export function discoverServicePorts(): Map<number, ServicePortInfo> {
  return new Map(
    getServiceTunnels().discovery.discoverPorts({ excludeCmdline: PI_WEB_OWN }).map((p) => [p.port, p]),
  );
}

/** Discovery — candidate list for the UI (the proxy allow-list is read from
 *  the library's persisted state.json by the middleware, no cache file here). */
export function getServicePorts(force = false): ServicePortInfo[] {
  return getServiceTunnels().discovery.getPorts({ excludeCmdline: PI_WEB_OWN, force });
}

/** Whether a port may be proxied (server-side; middleware uses the file). */
export function isServicePortAllowed(port: number): boolean {
  return getServiceTunnels().discovery.isPortAllowed(port);
}

/** Virtual-host suffix used for service URLs, e.g. ".pi.localhost". */
export function getServiceHostSuffix(): string {
  const raw = process.env.PI_WEB_SVC_HOST_SUFFIX ?? ".pi.localhost";
  return raw.startsWith(".") ? raw : `.${raw}`;
}

/** Base domains for the service-tunnels integration (PI_WEB_BASE_DOMAIN
 *  primary, PI_WEB_ALLOWED_HOSTS / PI_WEB_HOSTNAME fallbacks; host:port kept).
 *  Re-exported from the middleware-safe helper so both sides agree. */
export const getBaseDomains = getBaseDomainsShared;

/** Virtual-host suffixes accepted by proxy.ts (shared with middleware). */
export { getServiceHostSuffixes };

/**
 * Strip pi-web's own basePath (e.g. /dev) from a path before forwarding it to
 * a proxied service. Service URLs carry the basePath so reverse proxies that
 * path-route pi-web (nginx `location /dev/`) send them to pi-web; the service
 * itself must see the ORIGINAL path, so /dev/foo → /foo. Paths that do not
 * start with the basePath pass through untouched.
 */
export function stripBasePath(pathname: string, basePath: string): string {
  const base = (basePath ?? "").replace(/\/+$/, "");
  if (!base || pathname === "/") return pathname;
  if (pathname === base) return "/";
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length);
  return pathname;
}

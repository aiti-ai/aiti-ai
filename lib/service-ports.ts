import { writeFileSync } from "fs";
import type { ServicePortInfo } from "service-tunnels";
import { getServiceTunnels } from "./service-tunnels-integration";
import { allowedPortsFile } from "./service-proxy-shared";

/**
 * Service-port discovery — thin adapter over the service-tunnels library.
 *
 * Everything platform-specific (Linux /proc, macOS ps+lsof, Windows
 * Get-CimInstance+netstat, wildcard address expansion, marker-based child
 * discovery) now lives in the library; this module keeps pi-web's proxy
 * allow-list + virtual-host suffix machinery on top of it.
 */

export type { ServicePortInfo } from "service-tunnels";

/** pi-web's own process cmdline patterns (never "services"). */
const PI_WEB_OWN = [/next[\\/]dist[\\/]bin[\\/]next/, /next-server/, /pi-web(-options)?\.js/, /bin[\\/]pi-web/];

/** Cached discovery — the cache doubles as the proxy allow-list. Every run
 *  also mirrors the port set to a cache file that the middleware (proxy.ts,
 *  which cannot import the library) reads as its allow-list. */
export function getServicePorts(force = false): ServicePortInfo[] {
  const ports = getServiceTunnels().discovery.getPorts({ excludeCmdline: PI_WEB_OWN, force });
  try {
    writeFileSync(allowedPortsFile(), JSON.stringify({ ports: ports.map((p) => p.port), at: Date.now() }), "utf8");
  } catch {
    // best-effort — the proxy falls back to an empty allow-list
  }
  return ports;
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

/**
 * All suffixes that proxy.ts accepts as service virtual hosts, in priority
 * order: the built-in .pi.localhost, the explicit PI_WEB_SVC_HOST_SUFFIX, and
 * the operator-configured hosts (PI_WEB_HOSTNAME / PI_WEB_ALLOWED_HOSTS) so a
 * deployment at example.com automatically serves <port>.example.com too.
 */
export function getServiceHostSuffixes(): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const s = raw.trim().toLowerCase().replace(/^\./, "");
    // IP literals (e.g. PI_WEB_HOSTNAME=127.0.0.1) cannot be wildcard suffixes.
    if (!s || isIP(s) !== 0) return;
    if (!out.includes(`.${s}`)) out.push(`.${s}`);
  };
  add(getServiceHostSuffix());
  for (const h of (process.env.PI_WEB_HOSTNAME ?? "").split(",")) add(h);
  for (const h of (process.env.PI_WEB_ALLOWED_HOSTS ?? "").split(",")) add(h);
  return out;
}

function isIP(s: string): number {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return 4;
  if (s.includes(":")) return 6;
  return 0;
}

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

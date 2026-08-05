import { homedir } from "os";
import { existsSync } from "fs";
import { join } from "path";
import { createServiceTunnels, type ServiceTunnels } from "service-tunnels";

/**
 * service-tunnels integration — library mode inside pi-web.
 *
 * The manager runs in pi-web's process (no daemon): helpers it spawns become
 * pi-web's descendants, discovery scopes to pi-web's process tree, and the
 * internal registry keeps framework ports (nginx/authelia/redis) out of the
 * user-service discovery results.
 *
 * Dirs are pi-web-specific (~/.pi/service-tunnels{,-cache}) so pi-web and a
 * standalone CLI install never share config/cache. Marker "pi-web" keeps the
 * allow-list cache keyed to this instance.
 *
 * SITE isolation (service-tunnels ≥0.2.38, sites-design.md): pi-web's own UI
 * and its subprocess dev servers live in two SEPARATE auth realms — different
 * domains, different user dbs, different providers. `ensureSites()` presets
 * them idempotently; exposeService/exposeSelf route to their own site.
 */

declare global {
  var __piServiceTunnels: ServiceTunnels | undefined;
}

/** Default tool paths: PI_WEB_TUNNEL_TOOL_PATHS overrides, then ~/pi-tunnels. */
function toolPathsFromEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const overrides = JSON.parse(process.env.PI_WEB_TUNNEL_TOOL_PATHS ?? "{}") as Record<string, string>;
    for (const [k, v] of Object.entries(overrides ?? {})) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
  } catch {
    // ignore invalid JSON
  }
  // Local installs (pi-tunnels dir) are a default, not an override.
  for (const name of ["cloudflared", "ngrok", "frpc", "localtunnel"]) {
    const p = join(homedir(), "pi-tunnels", name);
    if (existsSync(p)) out[name] ??= p;
  }
  return out;
}

export function getServiceTunnels(): ServiceTunnels {
  if (!globalThis.__piServiceTunnels) {
    globalThis.__piServiceTunnels = createServiceTunnels({
      configDir: join(homedir(), ".pi", "service-tunnels"),
      cacheDir: join(homedir(), ".pi", "service-tunnels-cache"),
      marker: "pi-web",
      toolPaths: toolPathsFromEnv(),
    });
  }
  return globalThis.__piServiceTunnels;
}

/** pi-web's own process cmdline patterns (never "services"). */
const PI_WEB_OWN = [/next[\\/]dist[\\/]bin[\\/]next/, /next-server/, /pi-web(-options)?\.js/, /bin[\\/]pi-web/];

/** User test services only (framework ports excluded by the registry). */
export function listPiServices() {
  return getServiceTunnels().discovery.getPorts({ excludeCmdline: PI_WEB_OWN });
}

/**
 * Preset the two auth realms (idempotent; a user-registered site wins):
 *   - site "pi-web"    → pi-web's own admin UI (portal, its own users)
 *   - site "services"  → pi-web subprocess dev servers (basic, separate users)
 */
export function ensureSites(): void {
  const st = getServiceTunnels();
  const existing = st.sites.list().map((s) => s.name);
  const presets: Record<string, { provider?: string; domain?: string; policy?: string }> = {
    "pi-web": { provider: "portal", policy: "two_factor" },
    services: { provider: "basic" },
  };
  for (const [name, cfg] of Object.entries(presets)) {
    if (existing.includes(name)) continue;
    try {
      st.sites.add(name, cfg);
    } catch {
      // name conflict — keep whatever the user registered
    }
  }
}

/** One-shot expose with optional gateway auth. tunnelParams/providerParams
 *  are schema-driven form values (service-tunnels applies them).
 *
 *  mode: "tunnel" (default, public URL) | "proxy" (local vhost, no tunnel) |
 *        "both" (local vhost + public tunnel, same site).
 *  site: auth realm — "services" (subprocess dev servers), "pi-web" (pi-web's
 *        own UI), or "default" (legacy behavior). Default "default" keeps
 *        existing callers unchanged.
 */
export async function exposeService(
  port: number,
  opts: {
    auth?: boolean;
    tunnel?: string;
    provider?: string;
    mode?: "tunnel" | "proxy" | "both";
    site?: string;
    ngrokAuthtoken?: string;
    policy?: string;
    protocol?: "http" | "https" | "tcp";
    allowToolDownload?: boolean;
    tunnelParams?: Record<string, unknown>;
    providerParams?: Record<string, unknown>;
  } = {},
) {
  const st = getServiceTunnels();
  return st.auth.expose(port, {
    auth: opts.auth ?? false,
    mode: opts.mode,
    site: opts.site,
    tunnelType: opts.tunnel ?? "cloudflared",
    provider: opts.provider,
    ngrokAuthtoken: opts.ngrokAuthtoken,
    policy: opts.policy as "one_factor" | "two_factor" | undefined,
    protocol: opts.protocol,
    allowToolDownload: opts.allowToolDownload,
    tunnelParams: opts.tunnelParams,
    providerParams: opts.providerParams,
    // Caller-side naming: same port can be exposed with several providers;
    // distinct tunnelName keeps them coexisting (service-tunnels default would
    // collide on expose-<port>).
    tunnelName: `expose-${port}-${opts.provider ?? "direct"}`,
  });
}

/** pi-web's OWN UI under site "pi-web" — separate users from dev services. */
export async function exposeSelf(
  port: number,
  opts: { tunnel?: boolean; mode?: "proxy" | "both" } = {},
) {
  return getServiceTunnels().auth.expose(port, {
    auth: true,
    mode: opts.mode ?? (opts.tunnel ? "both" : "proxy"),
    site: "pi-web",
    tunnelType: "cloudflared",
    tunnelName: `expose-self-${port}`,
  });
}

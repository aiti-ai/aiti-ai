import { homedir } from "os";
import { join } from "path";
import { createServiceTunnels, type ServiceTunnels } from "service-tunnels/src/index.ts";

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
 * NOTE: the sibling service-tunnels checkout is imported via relative path so
 * `next dev` compiles it directly (SWC handles the TS). A released integration
 * should depend on the npm package instead:
 *   import { createServiceTunnels } from "service-tunnels";
 */

declare global {
  var __piServiceTunnels: ServiceTunnels | undefined;
}

export function getServiceTunnels(): ServiceTunnels {
  if (!globalThis.__piServiceTunnels) {
    globalThis.__piServiceTunnels = createServiceTunnels({
      configDir: join(homedir(), ".pi", "service-tunnels"),
      cacheDir: join(homedir(), ".pi", "service-tunnels-cache"),
      marker: "pi-web",
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

/** One-shot expose with optional gateway auth. */
export async function exposeService(port: number, opts: { auth?: boolean; tunnel?: string } = {}) {
  const st = getServiceTunnels();
  return st.auth.expose(port, {
    auth: opts.auth ?? false,
    tunnelType: opts.tunnel ?? "cloudflared",
  });
}

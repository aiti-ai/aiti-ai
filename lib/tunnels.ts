import { getServiceTunnels } from "./service-tunnels-integration";
import type { TunnelInfo as LibTunnelInfo } from "service-tunnels";

/**
 * Tunnel management — thin adapter over the service-tunnels library.
 *
 * Process spawning, output capture, known-domain URL parsing, state
 * persistence and cleanup live in the library. Exposing happens through
 * `st.auth.expose` (the dialog's 公网访问 section): pick a tunnel type +
 * auth provider, the library owns the whole flow. This module only adapts
 * the tunnel info shape for the Services dialog / /api/services.
 *
 * NOTE: the legacy boot-time env tunnels (PI_WEB_TUNNELS / PI_WEB_TUNNEL_CMD)
 * were removed — expose in place from the dialog instead.
 */

export interface TunnelInfo {
  name: string;
  cmd: string;
  running: boolean;
  pid: number | null;
  /** Public URL parsed from the tunnel's output (ngrok/cloudflared/...). */
  url: string | null;
  lastOutput: string;
}

function infoFrom(t: LibTunnelInfo): TunnelInfo {
  return {
    name: t.name,
    cmd: t.type === "command" ? (t.lastOutput || t.name) : t.type,
    running: t.running,
    pid: t.pid,
    url: t.url,
    lastOutput: t.lastOutput,
  };
}

export function getTunnelInfos(): TunnelInfo[] {
  return getServiceTunnels().tunnels.list().map(infoFrom);
}

// The library's TunnelManager lives in the process singleton (globalThis),
// so its cleanup hooks (role markers + guardian) run with pi-web; no extra
// process.once teardown needed here.

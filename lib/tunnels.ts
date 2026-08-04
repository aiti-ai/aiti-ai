import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Tunnel management — launch-command based, multi-tunnel.
 *
 * The operator configures tunnels at startup; each is listed in the Services
 * dialog with Start/Stop buttons and the public URL parsed from its output.
 *
 *   PI_WEB_TUNNELS='[{"name":"ngrok","cmd":"ngrok http 30141","auto":true},
 *                    {"name":"cfd","cmd":"cloudflared tunnel --url http://localhost:30141"}]'
 *   PI_WEB_TUNNEL_CMD="lt --port 30141"   # legacy single-tunnel form (auto-starts)
 *
 * - `auto: true` tunnels are spawned at server boot (instrumentation.ts) and
 *   killed when the server exits; others stay listed but stopped until the
 *   user starts them from the dialog.
 * - Process output is kept in memory (globalThis, survives hot reload), so
 *   3s-poll refreshes keep showing the parsed public URL until the tunnel is
 *   stopped.
 */

export interface TunnelConfig {
  name: string;
  cmd: string;
  auto?: boolean;
}

export interface TunnelInfo {
  name: string;
  cmd: string;
  running: boolean;
  pid: number | null;
  /** Public URL parsed from the tunnel's output (ngrok/cloudflared/...). */
  url: string | null;
  lastOutput: string;
}

interface TunnelState {
  child: ChildProcess | null;
  output: string;
  url: string | null;
  cmd: string;
}

/** Per-port tunnel command templates (the tool binaries resolve at runtime). */
export interface TunnelCommandTemplate {
  name: string;
  cmd: string;
  /** Tool needs setup first (e.g. ngrok authtoken) — surfaced in the UI. */
  requiresAuth?: boolean;
}

declare global {
  var __piTunnels: Map<string, TunnelState> | undefined;
}

const OUTPUT_LIMIT = 8192;

function states(): Map<string, TunnelState> {
  if (!globalThis.__piTunnels) globalThis.__piTunnels = new Map();
  return globalThis.__piTunnels;
}

function stateFor(name: string): TunnelState | undefined {
  return states().get(name);
}

/** Configured tunnels from PI_WEB_TUNNELS (JSON) + legacy PI_WEB_TUNNEL_CMD. */
export function getTunnelConfigs(): TunnelConfig[] {
  const out: TunnelConfig[] = [];
  const add = (name: string, cmd: string, auto: boolean) => {
    const c = cmd.trim();
    if (!c) return;
    const n = name.trim() || c.split(/\s+/)[0] || "tunnel";
    if (!out.some((t) => t.name === n)) out.push({ name: n, cmd: c, auto });
  };
  try {
    const raw = process.env.PI_WEB_TUNNELS;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.cmd === "string") {
            add(String(item.name ?? ""), item.cmd, Boolean(item.auto));
          }
        }
      }
    }
  } catch {
    // ignore invalid PI_WEB_TUNNELS JSON
  }
  const legacy = process.env.PI_WEB_TUNNEL_CMD?.trim();
  if (legacy) add(process.env.PI_WEB_TUNNEL_NAME ?? "", legacy, true);
  return out;
}

/** Public URL inside tunnel output: known tunnel domains first, else any
 *  non-localhost http(s) URL. */
export function extractTunnelUrl(output: string): string | null {
  if (!output) return null;
  const known =
    /(https?:\/\/[a-z0-9][a-z0-9.-]*\.(?:ngrok(?:\.app|\.io)|trycloudflare\.com|loca\.lt|serveo\.net|wormhole\.app|localhost\.run|hop\.to)[^\s"'<>)\]]*)/i.exec(
      output,
    );
  if (known) return known[1];
  const any = /(https?:\/\/[a-z0-9][a-z0-9.-]*(?::\d+)?[^\s"'<>)\]]*)/i.exec(output);
  if (any && !/localhost|127\.0\.0\.1|0\.0\.0\.0|::1?/.test(any[1])) return any[1];
  return null;
}

export function getTunnelInfos(): TunnelInfo[] {
  const configs = getTunnelConfigs();
  const configured = new Set(configs.map((c) => c.name));
  const infos: TunnelInfo[] = configs.map((cfg) => {
    const state = stateFor(cfg.name);
    return infoFrom(cfg.name, cfg.cmd, state);
  });
  // One-off per-port tunnels (name port-<port>-<tool>) are not in the config
  // list but must stay visible (and their URLs kept) across poll refreshes.
  for (const [name, state] of states()) {
    if (!configured.has(name)) infos.push(infoFrom(name, state.cmd, state));
  }
  return infos;
}

function infoFrom(name: string, cmd: string, state: TunnelState | undefined): TunnelInfo {
  const child = state?.child;
  return {
    name,
    cmd,
    running: Boolean(child && child.exitCode === null && !child.killed),
    pid: child?.pid ?? null,
    url: state?.url ?? null,
    lastOutput: state?.output ?? "",
  };
}

/** Resolve a tunnel tool binary: PI_WEB_TUNNEL_TOOL_PATHS override, then
 *  ~/pi-tunnels/<name>, then PATH. */
function resolveToolPath(name: string): string {
  try {
    const overrides = JSON.parse(process.env.PI_WEB_TUNNEL_TOOL_PATHS ?? "{}") as Record<string, string>;
    const hit = overrides?.[name]?.trim();
    if (hit) return hit;
  } catch {
    // ignore invalid JSON
  }
  try {
    const local = join(homedir(), "pi-tunnels", name);
    if (existsSync(local)) return local;
  } catch {
    // ignore
  }
  return name;
}

/**
 * Tunnel commands that expose ONE test-service port (never pi-web itself).
 * ngrok needs an authtoken; cloudflared on CN networks may need --edge
 * (see docs/service-port-proxy.md).
 */
export function getPortTunnelTemplates(port: number): TunnelCommandTemplate[] {
  return [
    { name: "cloudflared", cmd: `${resolveToolPath("cloudflared")} tunnel --url http://127.0.0.1:${port}` },
    { name: "localtunnel", cmd: `lt --port ${port}` },
    { name: "ngrok", cmd: `${resolveToolPath("ngrok")} http ${port}`, requiresAuth: true },
    { name: "serveo", cmd: `ssh -R 80:127.0.0.1:${port} serveo.net` },
  ];
}

/** Internal spawn: manages the process, caches output + parsed URL. */
function spawnTunnel(name: string, cmd: string): TunnelState | null {
  const map = states();
  const existing = map.get(name);
  if (existing?.child && existing.child.exitCode === null && !existing.child.killed) {
    return existing;
  }
  const state: TunnelState = existing ?? { child: null, output: "", url: null, cmd };
  if (existing) state.cmd = cmd;
  map.set(name, state);

  let child: ChildProcess;
  try {
    // detached so the tunnel runs in its own process group and can be killed
    // as a group (shell + spawned tool) without leaking the child.
    child = spawn(cmd, { shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    state.child = null;
    return null;
  }
  state.child = child;

  const appendOutput = (chunk: Buffer) => {
    state.output = (state.output + chunk.toString()).slice(-OUTPUT_LIMIT);
    // Re-parse on every chunk with KNOWN tunnel domains first, so a URL that
    // appears later in the output (e.g. the real trycloudflare host after an
    // unrelated cloudflare.com link) replaces an earlier false positive. The
    // output stays cached until stopped, so 3s poll refreshes keep showing it.
    state.url = extractTunnelUrl(state.output);
  };
  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);
  child.once("exit", () => {
    if (state.child === child) state.child = null;
  });

  state.url = extractTunnelUrl(state.output);
  return state;
}

/** Start a configured tunnel by name. Idempotent; returns false if unknown. */
export function startTunnel(name: string): boolean {
  const cfg = getTunnelConfigs().find((c) => c.name === name);
  if (!cfg) return false;
  return spawnTunnel(cfg.name, cfg.cmd) !== null;
}

/**
 * Start a one-off tunnel for a single service port. Idempotent per tool
 * (one localtunnel, one cloudflared, ... per port); different tools coexist.
 */
export function startPortTunnel(port: number, tool: string): boolean {
  const template = getPortTunnelTemplates(port).find((t) => t.name === tool);
  if (!template) return false;
  return spawnTunnel(`port-${port}-${tool}`, template.cmd) !== null;
}

/** Kill a tunnel process and its group (detached spawn). */
function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed || child.pid === undefined) return;
  try {
    // Negative pid targets the whole process group (shell + spawned tool).
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}

/** Stop a running tunnel by name. Returns false if unknown. */
export function stopTunnel(name: string): boolean {
  const state = stateFor(name);
  const child = state?.child;
  if (!child) return Boolean(state); // configured but not running
  killChild(child);
  state.child = null;
  return true;
}

/** Spawn tunnels marked `auto: true` (called once at server boot). */
export function startAutoTunnels(): void {
  for (const cfg of getTunnelConfigs()) {
    if (cfg.auto) startTunnel(cfg.name);
  }
}

// Best-effort cleanup on server exit (normal 'exit' + signals). Signal handlers
// are one-shot so we never override the app's own signal handling.
for (const event of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.once(event, () => {
    for (const state of states().values()) {
      const child = state.child;
      if (child && child.exitCode === null && !child.killed) {
        killChild(child);
      }
    }
  });
}

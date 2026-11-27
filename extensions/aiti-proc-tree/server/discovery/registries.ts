/**
 * aiti-proc-tree · server/discovery/registries.ts — read the five ecosystem registries.
 *
 * All reads are best-effort: a missing file/dir or a corrupt JSON blob degrades
 * to an empty list and never breaks the panel. Detached registries are shared
 * by every pi-web instance of the same user (single-writer per file), so this
 * module never writes anything.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface RegistrySnapshot {
  cmdHost: any[];
  agentStarter: any[];
  bridge: Record<string, any>;
  tunnels: any[];
  subagents: any[];
}

const home = () => homedir();

async function readJson(file: string): Promise<any> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function listJson(dir: string): Promise<any[]> {
  const out: any[] = [];
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const value = await readJson(join(dir, name));
    if (value && typeof value === "object") out.push(value);
  }
  return out;
}

/** aiti-cmd detached PTY sessions: <root>/registry/<sid>.json */
async function readCmdHost(): Promise<any[]> {
  const root = process.env.AITI_CMD_HOST_DIR || join(home(), ".pi", "agent", "aiti-cmd-host");
  return listJson(join(root, "registry"));
}

/** agent-starter detached agent sessions: <root>/registry/<key>.json */
async function readAgentStarter(): Promise<any[]> {
  const root = process.env.PI_AGENT_STARTER_DIR || join(home(), ".pi", "agent", "agent-starter");
  return listJson(join(root, "registry"));
}

/** TUI /web bridge registry: {sessionFile: {socket, pid, startedAt}} */
async function readBridge(): Promise<Record<string, any>> {
  const file = process.env.PI_BRIDGE_REGISTRY || join(home(), ".pi", "agent", "bridge-registry.json");
  const raw = await readJson(file);
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, any> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const pid = Number((entry as any).pid);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!isAlive(pid)) continue;
    out[key] = entry;
  }
  return out;
}

/** Candidate service-tunnels cache dirs (dev/prod/sandbox variants). */
function tunnelCacheDirs(): string[] {
  const dirs: string[] = [];
  const override = process.env.AITI_SERVICE_TUNNELS_CACHE;
  if (override) dirs.push(override);
  dirs.push(join(home(), ".cache", "service-tunnels"));
  dirs.push(join(home(), ".pi", "service-tunnels", "cache"));
  dirs.push(join(home(), ".pi", "web", "data", "service-tunnels", "cache"));
  dirs.push(join(home(), ".pi", "web-dev", "data", "service-tunnels", "cache"));
  return Array.from(new Set(dirs));
}

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * service-tunnels PID registry files: registered-pids-<parentPid>.json with
 * [{pid, role, t}]. Only files whose parent process is alive are trusted.
 */
async function readTunnels(): Promise<any[]> {
  const out: any[] = [];
  const seen = new Set<number>();
  for (const dir of tunnelCacheDirs()) {
    if (!existsSync(dir)) continue;
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^registered-pids-(\d+)\.json$/.exec(name);
      if (!m) continue;
      const parentPid = Number(m[1]);
      if (!isAlive(parentPid)) continue;
      const list = await readJson(join(dir, name));
      if (!Array.isArray(list)) continue;
      for (const e of list) {
        const pid = Number(e && e.pid);
        if (!Number.isFinite(pid) || seen.has(pid)) continue;
        seen.add(pid);
        out.push({
          pid,
          role: String((e && e.role) || "tunnel"),
          t: Number(e && e.t) || undefined,
          parentPid,
        });
      }
    }
  }
  return out;
}

/**
 * pi-subagents async runs: <tmp>/pi-subagents-<scope>/async-subagent-runs/<runId>/status.json
 * Only live states are returned; attached runs (no pid) are listed without pid
 * and attached=true so the tree can hang them under the host.
 */
async function readSubagents(): Promise<any[]> {
  const out: any[] = [];
  const seen = new Set<string>();
  let scopes: string[] = [];
  try {
    scopes = (await readdir(tmpdir())).filter((n) => n.startsWith("pi-subagents-"));
  } catch {
    return out;
  }
  for (const scope of scopes) {
    const root = join(tmpdir(), scope, "async-subagent-runs");
    let runs: string[] = [];
    try {
      runs = await readdir(root);
    } catch {
      continue;
    }
    for (const runId of runs) {
      if (!/^[0-9a-f-]{36}$/i.test(runId)) continue;
      const file = join(root, runId, "status.json");
      let status: any = null;
      try {
        if (!(await stat(file)).isFile()) continue;
        status = await readJson(file);
      } catch {
        continue;
      }
      if (!status) continue;
      if (seen.has(runId)) continue;
      seen.add(runId);
      const state = String(status.state || "");
      if (!["running", "queued", "paused"].includes(state)) continue;
      const pid = Number(status.pid);
      out.push({
        runId,
        state,
        pid: Number.isFinite(pid) && pid > 0 ? pid : undefined,
        attached: !(Number.isFinite(pid) && pid > 0),
        agent: String(status.agent || status.mode || "subagent"),
        cwd: status.cwd || undefined,
        sessionFile: status.sessionFile || undefined,
        startedAt: Number(status.startedAt) || undefined,
      });
    }
  }
  return out;
}

export async function readRegistries(): Promise<RegistrySnapshot> {
  const [cmdHost, agentStarter, bridge, tunnels, subagents] = await Promise.all([
    readCmdHost(),
    readAgentStarter(),
    readBridge(),
    readTunnels(),
    readSubagents(),
  ]);
  return { cmdHost, agentStarter, bridge, tunnels, subagents };
}

/**
 * aiti-proc-tree · server/discovery/instances.ts — identify the hosting pi-web instance.
 *
 * Walks the real parent chain from `process.pid` up to the `bin/pi-web.js` CLI
 * process (inclusive) and parses `--port` to label dev/prod/custom. Other
 * pi-web instances are intentionally NOT scanned in v1: the default view only
 * collects this instance's own tree (unrelated processes stay untouched).
 */
import { readFile } from "node:fs/promises";

export interface SelfInstance {
  selfPid: number;
  cliPid: number;
  port: number | null;
  mode: string;
}

let cached: SelfInstance | null = null;
let cachedAt = 0;

async function readCmdline(pid: number): Promise<string> {
  try {
    return (await readFile("/proc/" + pid + "/cmdline", "utf8")).replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}

async function readPpid(pid: number): Promise<number | null> {
  try {
    const line = await readFile("/proc/" + pid + "/stat", "utf8");
    const close = line.lastIndexOf(")");
    if (close < 0) return null;
    const rest = line.slice(close + 2).trim().split(/\s+/);
    return Number(rest[1]) || null;
  } catch {
    return null;
  }
}

function parsePort(cmd: string): number | null {
  const m = /(?:^|\s)(?:-p|--port)[=\s]+(\d+)/.exec(cmd);
  return m ? Number(m[1]) : null;
}

/** PORT / PI_WEB_PORT from a process env (dev units often pass the port via env). */
async function portFromEnv(pid: number): Promise<number | null> {
  try {
    const env = await readFile("/proc/" + pid + "/environ", "utf8");
    const m = /(?:^|\0)(?:PORT|PI_WEB_PORT)=(\d+)(?:\0|$)/.exec(env + "\0");
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function modeOf(port: number | null): string {
  if (port === 20341) return "prod";
  if (port === 30142) return "dev";
  return port ? "port:" + port : "custom";
}

/** Resolve (and cache) the current instance's CLI ancestor + port. */
export async function resolveSelf(): Promise<SelfInstance> {
  const now = Date.now();
  if (cached && now - cachedAt < 5 * 60 * 1000) return cached;
  const selfPid = process.pid;
  let cliPid = selfPid;
  let port: number | null = null;

  if (process.platform === "linux") {
    let cur: number | null = selfPid;
    let depth = 0;
    const seen = new Set<number>();
    while (cur && cur > 1 && depth < 32 && !seen.has(cur)) {
      seen.add(cur);
      const cmd = await readCmdline(cur);
      if (cur === selfPid) port = parsePort(cmd) || port;
      // `bin/pi-web.js wrapper --config ...` is an agent-starter wrapper, not a
      // pi-web instance CLI; skip it and keep climbing. Dev units run
      // `next dev -p 30142` directly, so accept that launcher shape too.
      const isNext = /next[\\/]dist[\\/]bin[\\/]next/.test(cmd) && /(?:^|\s)(?:dev|start)(?:\s|$)/.test(cmd);
      const isCli = (/bin[\\/]pi-web\.js|bin[\\/]pi-web\b/.test(cmd) && !/\swrapper\s/.test(cmd)) || isNext;
      if (isCli) {
        cliPid = cur;
        port = parsePort(cmd) || (await portFromEnv(cur)) || port;
        break;
      }
      cur = readPpid(cur);
      depth++;
    }
    if (cliPid === selfPid) {
      // No CLI ancestor (dev runner / tests): keep the direct parent when it
      // looks like the next-server process, but never climb past init.
      const ppid = readPpid(selfPid);
      if (ppid && ppid > 1) {
        const cmd = await readCmdline(ppid);
        if ((cmd.includes("next") || cmd.includes("pi-web")) && !/\swrapper\s/.test(cmd)) cliPid = ppid;
      }
    }
  }

  cached = { selfPid, cliPid, port, mode: modeOf(port) };
  cachedAt = now;
  return cached;
}

export function resetSelf(): void {
  cached = null;
  cachedAt = 0;
}

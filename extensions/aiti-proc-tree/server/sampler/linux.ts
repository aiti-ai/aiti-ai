/**
 * aiti-proc-tree · server/sampler/linux.ts — /proc reader.
 *
 * Two phases (the panel never collects unrelated processes):
 *   phase A: stat-only scan of every pid to build the ppid graph (cheap)
 *   phase B: status/cmdline/cwd/env reads for the visible set only
 *
 * Nothing here starts a timer; the client's poll cadence is the only driver.
 */
import { readdir, readFile, readlink } from "node:fs/promises";
import os from "node:os";
// ESM import (not require): the transpiled form goes through jitiImport, which
// respects the loader's moduleCache:false — a bare require() would hit Node's
// process-level CJS cache and keep serving the pre-reload core forever.
import * as core from "../../core.ts";

export interface RawProc {
  pid: number;
  ppid: number;
  state: string;
  utime: number;
  stime: number;
  starttime: number;
}

export interface ProcDetail {
  name?: string;
  user?: string;
  uid?: number | null;
  state?: string;
  mem?: number | null;
  cmd?: string;
  cwd?: string;
  envText?: string;
  etimeMs?: number | null;
  fdCount?: number | null;
  ports?: string[];
}

const CLK_TCK = 100;
let btimeSec: number | null = null;

/** Boot time (epoch seconds) from /proc/stat, cached for the process lifetime. */
async function bootTime(): Promise<number> {
  if (btimeSec != null) return btimeSec;
  try {
    const m = /^btime\s+(\d+)/m.exec(await readFile("/proc/stat", "utf8"));
    btimeSec = m ? Number(m[1]) : Math.floor(Date.now() / 1000 - os.uptime());
  } catch {
    btimeSec = Math.floor(Date.now() / 1000 - os.uptime());
  }
  return btimeSec;
}

/** Phase A: one stat read per pid; malformed entries are skipped. */
export async function scanRaw(): Promise<Map<number, RawProc>> {
  const out = new Map<number, RawProc>();
  let entries: string[] = [];
  try {
    entries = (await readdir("/proc")).filter((n) => /^\d+$/.test(n));
  } catch {
    return out;
  }
  // One Promise.all over every pid: fs promise overhead per file is ~0.1ms, so
  // the whole graph read lands ~60-90ms async (vs ~25ms sync) while the event
  // loop stays free — the trade this extension deliberately makes for the
  // >1s-blocking red line. Details/other reads follow the same pattern.
  const lines = await Promise.all(entries.map((name) => readFile("/proc/" + name + "/stat", "utf8").catch(() => null)));
  for (let j = 0; j < entries.length; j++) {
    const line = lines[j];
    if (!line) continue;
    const close = line.lastIndexOf(")");
    if (close < 0) continue;
    const pid = Number(entries[j]);
    const rest = line.slice(close + 2).trim().split(/\s+/);
    if (!Number.isFinite(pid) || rest.length < 20) continue;
    out.set(pid, {
      pid,
      state: rest[0] || "?",
      ppid: Number(rest[1]) || 0,
      utime: Number(rest[11]) || 0,
      stime: Number(rest[12]) || 0,
      starttime: Number(rest[19]) || 0,
    });
  }
  return out;
}

/**
 * Global TCP LISTEN table from /proc/net/tcp + tcp6: Map<socket inode, "addr:port">.
 * Two small kernel files; parsing is pure (core.ts) and stays well under a
 * millisecond even with thousands of sockets.
 */
export async function readListenTable(): Promise<Map<string, string>> {
  const texts = await Promise.all([
    readFile("/proc/net/tcp", "utf8").catch(() => ""),
    readFile("/proc/net/tcp6", "utf8").catch(() => ""),
  ]);
  return core.parseProcNetListen(texts);
}

/** Port number of an "addr:port" entry (NaN when unparsable). */
const portNum = (s: string): number => core.portOf(s);

/** Effective start time (epoch ms) derived from starttime + boot time. */
export async function startMs(p: RawProc): Promise<number> {
  return ((await bootTime()) + p.starttime / CLK_TCK) * 1000;
}

/** Phase B: one process detail. `withEnv` is opt-in (ownership markers only). */
export async function readDetail(
  pid: number,
  opts: { withEnv?: boolean; listenMap?: Map<string, string> } = {},
): Promise<ProcDetail> {
  const d: ProcDetail = {};
  try {
    const status = await readFile("/proc/" + pid + "/status", "utf8");
    const name = /^Name:\s*(.+)$/m.exec(status);
    if (name) d.name = name[1].trim();
    const state = /^State:\s*(\S+)/m.exec(status);
    if (state) d.state = state[1];
    const rss = /^VmRSS:\s*(\d+)\s*kB/m.exec(status);
    if (rss) d.mem = Number(rss[1]) * 1024;
    const uid = /^Uid:\s*(\d+)/m.exec(status);
    if (uid) d.uid = Number(uid[1]);
  } catch {
    /* vanished */
  }
  try {
    const cmd = await readFile("/proc/" + pid + "/cmdline", "utf8");
    d.cmd = cmd.replace(/\0/g, " ").trim();
  } catch {
    /* keep empty */
  }
  try {
    d.cwd = await readlink("/proc/" + pid + "/cwd");
  } catch {
    /* permission / vanished */
  }
  try {
    d.user = process.env.USER || process.env.LOGNAME || "";
    if (d.uid != null && d.uid === 0) d.user = "root";
    else if (d.uid != null && os.userInfo) {
      try {
        const info = os.userInfo();
        if (info.uid === d.uid) d.user = info.username;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  if (opts.withEnv) {
    try {
      d.envText = await readFile("/proc/" + pid + "/environ", "utf8");
    } catch {
      /* other-user or hidden */
    }
  }
  try {
    const p = await readFile("/proc/" + pid + "/stat", "utf8");
    const close = p.lastIndexOf(")");
    if (close > 0) {
      const rest = p.slice(close + 2).trim().split(/\s+/);
      const start = Number(rest[19]) || 0;
      d.etimeMs = Math.max(0, Date.now() - ((await bootTime()) + start / CLK_TCK) * 1000);
    }
  } catch { /* ignore */ }
  try {
    const fds = await readdir("/proc/" + pid + "/fd");
    d.fdCount = fds.length;
    // Same readdir pass doubles as the LISTEN lookup: readlink each fd, keep
    // socket inodes, intersect with the global listen table. Other-user pids
    // fail at readdir above and simply carry no ports (same visibility as ps).
    if (opts.listenMap && opts.listenMap.size) {
      const links = await Promise.all(
        fds.map((f) => readlink("/proc/" + pid + "/fd/" + f).catch(() => "")),
      );
      const inodes = new Set<string>();
      for (const l of links) {
        const m = /^socket:\[(\d+)\]$/.exec(l);
        if (m) inodes.add(m[1]);
      }
      const ports: string[] = [];
      for (const ino of inodes) {
        const entry = opts.listenMap.get(ino);
        if (entry && !ports.includes(entry)) ports.push(entry);
      }
      if (ports.length) d.ports = ports.sort((a, b) => portNum(a) - portNum(b));
    }
  } catch {
    d.fdCount = null;
  }
  return d;
}

/** Best-effort uid of a process (null when unreadable). */
export async function uidOf(pid: number): Promise<number | null> {
  try {
    const status = await readFile("/proc/" + pid + "/status", "utf8");
    const m = /^Uid:\s*(\d+)/m.exec(status);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Cheap existence + starttime check used for cache keys. */
export async function procStart(pid: number): Promise<number | null> {
  try {
    const line = await readFile("/proc/" + pid + "/stat", "utf8");
    const close = line.lastIndexOf(")");
    if (close < 0) return null;
    const rest = line.slice(close + 2).trim().split(/\s+/);
    return Number(rest[19]) || null;
  } catch {
    return null;
  }
}

export const platform = "linux";
export { CLK_TCK };

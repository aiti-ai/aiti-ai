/**
 * aiti-proc-tree · server/sampler/darwin.ts — ps-based sampler (degraded).
 *
 * macOS has no /proc: one `ps` call returns pid/ppid/cpu/rss/state/etime/command
 * for every process. `pcpu` is the average CPU over the process lifetime, not an
 * instantaneous delta — the UI marks it with "≈".
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
// ESM import (not require): bare require() would hit Node's process-level CJS
// cache and keep serving the pre-reload core after POST /reload.
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
  cpu?: number | null;
}

const exec = promisify(execFile);
export const platform = "darwin";

function parseEtime(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s || "").trim());
  if (!m) return null;
  const days = Number(m[1] || 0);
  const hours = Number(m[2] || 0);
  const mins = Number(m[3] || 0);
  const secs = Number(m[4] || 0);
  return (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
}

/** One ps call → raw + detail maps. Throws when ps is unavailable. */
export async function scan(): Promise<{ raw: Map<number, RawProc>; details: Map<number, ProcDetail> }> {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,pcpu=,rss=,stat=,etime=,uid=,command="], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 8000,
  });
  const raw = new Map<number, RawProc>();
  const details = new Map<number, ProcDetail>();
  for (const line of String(stdout || "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[8] || "";
    raw.set(pid, {
      pid,
      ppid: Number(m[2]) || 0,
      state: m[5] || "?",
      utime: 0,
      stime: 0,
      starttime: 0,
    });
    details.set(pid, {
      name: cmd.split(/\s+/)[0] || "",
      user: "",
      uid: Number(m[7]),
      state: m[5] || "",
      mem: Number(m[4]) * 1024,
      cmd,
      etimeMs: parseEtime(m[6]),
      cpu: Number(m[3]),
    });
  }
  return { raw, details };
}

export function readDetail(pid: number, opts: { withEnv?: boolean } = {}): ProcDetail {
  // Details come from the single scan() call; env is not read on macOS in v1
  // (ownership relies on registries/services — ps -E needs extra permissions).
  void pid;
  void opts;
  return {};
}

export function uidOf(pid: number): number | null {
  void pid;
  return null;
}

export function procStart(pid: number): number | null {
  void pid;
  return null;
}

/**
 * TCP LISTEN sockets by pid: one async `lsof` call (spawn, no event-loop
 * blocking). Fails soft: permission/availability problems yield an empty map.
 */
export async function listenByPid(): Promise<Map<number, string[]>> {
  try {
    const { stdout } = await exec("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN"], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 8000,
    });
    return core.parseLsofListen(String(stdout || ""));
  } catch {
    return new Map();
  }
}

export const CLK_TCK = 100;

/**
 * aiti-proc-tree · server/sampler/win32.ts — degraded Windows sampler.
 *
 * Preferred path: one PowerShell CIM query (pid/ppid/rss/cmdline). Fallback:
 * `tasklist /fo csv` (pid + memory only, no tree). CPU is unavailable in v1
 * (the UI shows "—"); kill goes through `taskkill /T /F` in kill.ts.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
export const platform = "win32";

async function scanCim(): Promise<{ raw: Map<number, RawProc>; details: Map<number, ProcDetail> }> {
  // KernelModeTime + UserModeTime enable Linux-style CPU deltas between scans;
  // CreationDate gives real process age (100ns ticks since 1601-01-01).
  const { stdout } = await exec("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine,CreationDate,KernelModeTime,UserModeTime,Name | ConvertTo-Json -Compress",
  ], { maxBuffer: 16 * 1024 * 1024, timeout: 12000, windowsHide: true });
  const parsed = JSON.parse(String(stdout || "[]"));
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const raw = new Map<number, RawProc>();
  const details = new Map<number, ProcDetail>();
  for (const p of list) {
    const pid = Number(p && p.ProcessId);
    if (!Number.isFinite(pid)) continue;
    const cmd = String((p && p.CommandLine) || "");
    // ConvertTo-Json serializes CIM DateTime as Microsoft JSON: "/Date(epochMs)/"
    const createdRaw = p && p.CreationDate;
    const createdMatch = typeof createdRaw === "string" ? /Date\((\d+)\)/.exec(createdRaw) : null;
    const created = createdMatch ? Number(createdMatch[1]) : typeof createdRaw === "number" ? createdRaw : null;
    const etimeMs = Number.isFinite(created) && created > 0 ? Math.max(0, Date.now() - created) : null;
    // 100ns ticks → cumulative CPU; the sampler diff converts to percent
    const ticks = Number(p && p.KernelModeTime) + Number(p && p.UserModeTime);
    // Clean display name: the exe basename from the CIM Name field. Script hosts
    // (node/powershell/cmd/bash/python) get a short argv hint so ten identical
    // "node" rows are tellable apart.
    const exeName = String((p && p.Name) || "").replace(/\.exe$/i, "") || "process";
    const argvHint = /^(node|powershell|pwsh|cmd|bash|wsl|python|java)$/i.test(exeName)
      ? (() => {
          const m = /(?:^\s*(?:"[^"]*"|\S+)\s+)(.{0,42})/.exec(cmd);
          const hint = m ? m[1].trim() : "";
          return hint ? " · " + (hint.length >= 42 ? hint.slice(0, 40) + "…" : hint) : "";
        })()
      : "";
    raw.set(pid, {
      pid,
      ppid: Number(p && p.ParentProcessId) || 0,
      state: "?",
      utime: Number.isFinite(ticks) ? ticks : 0,
      stime: 0,
      starttime: Number.isFinite(created) ? Math.round(created / 10) : 0, // keep in 100ns ticks for tick-key identity
    });
    details.set(pid, {
      name: exeName + argvHint,
      user: process.env.USERNAME || "",
      uid: null,
      state: "",
      mem: Number(p && p.WorkingSetSize) || 0,
      cmd,
      etimeMs,
      cpu: null,
    });
  }
  return { raw, details };
}

async function scanTasklist(): Promise<{ raw: Map<number, RawProc>; details: Map<number, ProcDetail> }> {
  const { stdout } = await exec("tasklist", ["/fo", "csv", "/nh"], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 8000,
    windowsHide: true,
  });
  const raw = new Map<number, RawProc>();
  const details = new Map<number, ProcDetail>();
  for (const line of String(stdout || "").split("\n")) {
    const m = /^"([^"]*)","(\d+)","[^"]*","[^"]*","([\d,]+) K"$/.exec(line.trim());
    if (!m) continue;
    const pid = Number(m[2]);
    raw.set(pid, { pid, ppid: 0, state: "?", utime: 0, stime: 0, starttime: 0 });
    details.set(pid, {
      name: m[1],
      user: process.env.USERNAME || "",
      uid: null,
      state: "",
      mem: Number(String(m[3]).replace(/,/g, "")) * 1024,
      cmd: m[1],
      etimeMs: null,
      cpu: null,
    });
  }
  return { raw, details };
}

export async function scan(): Promise<{ raw: Map<number, RawProc>; details: Map<number, ProcDetail> }> {
  try {
    return await scanCim();
  } catch {
    return await scanTasklist();
  }
}

export function readDetail(pid: number, opts: { withEnv?: boolean } = {}): ProcDetail {
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

export const CLK_TCK = 100;

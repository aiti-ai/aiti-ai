/**
 * aiti-proc-tree · server/sampler/index.ts — platform dispatch + CPU delta cache.
 *
 * Sampling is request-driven only: no timers live here. The 500ms raw cache
 * merges concurrent polls from the dock face and the floating panel.
 */
import * as linux from "./linux.ts";
import * as darwin from "./darwin.ts";
import * as win32 from "./win32.ts";
// ESM import (not require): bare require() hits Node's process-level CJS cache
// and would keep serving the pre-reload core after POST /reload.
import * as core from "../../core.ts";

const os = require("node:os");

export const platform: string = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : "win32";
const impl: any = platform === "linux" ? linux : platform === "darwin" ? darwin : win32;

let rawCache: { ts: number; map: Map<number, any> } = { ts: 0, map: new Map() };
let ticks = new Map<string, { utime: number; stime: number; ts: number }>();
let firstTick = true;
let lastScanTs = 0;

// Non-Linux platforms collect LISTEN tables via one spawn (lsof/netstat).
// Results — failures included — are cached, so repeated drawer opens never
// re-spawn a failing tool more than once per TTL window.
let implListen: { ts: number; map: Map<number, string[]>; note?: string } | null = null;
const IMPL_LISTEN_TTL_OK = 5000;
const IMPL_LISTEN_TTL_FAIL = 15000;

async function implListenData(): Promise<{ map: Map<number, string[]>; note?: string }> {
  const now = Date.now();
  if (implListen && now - implListen.ts < (implListen.note ? IMPL_LISTEN_TTL_FAIL : IMPL_LISTEN_TTL_OK)) {
    return implListen;
  }
  try {
    const r = await impl.listenByPid();
    implListen = { ts: now, map: r.map, note: r.note };
  } catch (e: any) {
    // listenByPid never throws on the known platforms; belt-and-suspenders for
    // unexpected shapes — report as a note instead of breaking the endpoint.
    implListen = { ts: now, map: new Map(), note: "listen scan failed: " + String((e && (e.message || e)) || e).slice(0, 80) };
  }
  return implListen;
}

/**
 * On-demand LISTEN lookup for one pid (detail drawer endpoint). Never runs in
 * the sampling loop; never throws — callers get ports and/or a note.
 */
export async function listenFor(pid: number): Promise<{ ports: string[]; note?: string }> {
  if (platform === "linux") {
    const r = await linux.listenPortsFor(pid);
    return { ports: r.ports, note: r.note };
  }
  const { map, note } = await implListenData();
  const ports = map.get(pid);
  return { ports: Array.isArray(ports) ? ports : [], note };
}

/** Clock ticks per second (Linux 100; other platforms unused). */
const HZ = 100;

function pruneTicks(raw: Map<number, any>) {
  const alive = new Set<string>();
  for (const p of raw.values()) alive.add(p.pid + ":" + p.starttime);
  for (const key of Array.from(ticks.keys())) {
    if (!alive.has(key)) ticks.delete(key);
  }
}

/**
 * Sample the visible process set.
 * - raw: stat-level graph (all pids on Linux; platform scan result elsewhere)
 * - details: status/cmdline/cwd (+ env for seed pids) for the visible set only
 * - cpu: delta from the previous request; null on the first tick
 */
export async function sample(opts: {
  selfPid: number;
  cliPid: number;
  rows: any[];
}): Promise<{
  raw: Map<number, any>;
  details: Map<number, any>;
  firstTick: boolean;
  scanned: number;
  visible: number;
  approxCpu: boolean;
}> {
  const now = Date.now();

  if (platform === "linux") {
    let raw: Map<number, any>;
    if (now - rawCache.ts < 500 && rawCache.map.size) {
      raw = rawCache.map;
    } else {
      raw = await linux.scanRaw();
      rawCache = { ts: now, map: raw };
    }
    const preview = core.visibleSet(raw, opts.rows, opts.selfPid, opts.cliPid);
    const details = new Map<number, any>();
    // Parallel detail reads: the async path awaits per-file I/O; serial awaits
    // multiplied per-pid latency. Promise.all keeps one event-loop yield per
    // read while the wall clock stays close to the slowest single read.
    const readIds = Array.from(preview.visible).filter((pid) => raw.has(pid));
    const readResults = await Promise.all(
      readIds.map(async (pid) => {
        const p = raw.get(pid)!;
        const d: any = await linux.readDetail(pid, { withEnv: preview.seeds.has(pid) });
        const key = pid + ":" + p.starttime;
        const prev = ticks.get(key);
        const dt = lastScanTs ? now - lastScanTs : 0;
        // Window cap (plan §3.4): the panel closing pauses the client loop, so the
        // gap since the previous request can be arbitrarily long. Deltas over 60s
        // would render as a meaningless diluted average — treat them as a fresh
        // first tick (null) instead. Below the cap a reopening panel gets real
        // CPU values on its very first tick.
        d.cpu = prev && dt > 0 && dt <= 60_000 ? core.cpuPercent(prev, p, dt, HZ) : null;
        ticks.set(key, { utime: p.utime, stime: p.stime, ts: now });
        return [pid, d] as const;
      }),
    );
    for (const [pid, d] of readResults) details.set(pid, d);
    const wasFirst = firstTick;
    firstTick = false;
    lastScanTs = now;
    pruneTicks(raw);
    return { raw, details, firstTick: wasFirst, scanned: raw.size, visible: details.size, approxCpu: false };
  }

  if (platform === "darwin") {
    const scanned = await darwin.scan();
    const preview = core.visibleSet(scanned.raw, opts.rows, opts.selfPid, opts.cliPid);
    const details = new Map<number, any>();
    for (const pid of preview.visible) {
      const d = scanned.details.get(pid);
      if (!d) continue;
      details.set(pid, d);
    }
    const wasFirst = firstTick;
    firstTick = false;
    return { raw: scanned.raw, details, firstTick: wasFirst, scanned: scanned.raw.size, visible: details.size, approxCpu: true };
  }

  const scanned = await win32.scan();
  const preview = core.visibleSet(scanned.raw, opts.rows, opts.selfPid, opts.cliPid);
  const details = new Map<number, any>();
  // Win32_Process carries 100ns cumulative CPU ticks — same delta math as Linux
  // (HZ = 1e7). First tick or >60s gaps render null like the Linux path.
  const WIN_HZ = 10_000_000;
  const nowW = Date.now();
  const dtW = lastScanTs ? nowW - lastScanTs : 0;
  for (const pid of preview.visible) {
    const p = scanned.raw.get(pid);
    const d: any = scanned.details.get(pid);
    if (!p || !d) continue;
    const key = pid + ":" + p.starttime;
    const prev = ticks.get(key);
    d.cpu = prev && dtW > 0 && dtW <= 60_000 ? core.cpuPercent(prev, p, dtW, WIN_HZ) : null;
    ticks.set(key, { utime: p.utime, stime: p.stime, ts: nowW });
    details.set(pid, d);
  }
  pruneTicks(scanned.raw);
  const wasFirst = firstTick;
  firstTick = false;
  lastScanTs = nowW;
  return { raw: scanned.raw, details, firstTick: wasFirst, scanned: scanned.raw.size, visible: details.size, approxCpu: false };
}

/** Reset caches (tests / extension reload). */
export function reset(): void {
  rawCache = { ts: 0, map: new Map() };
  ticks = new Map();
  firstTick = true;
  lastScanTs = 0;
  implListen = null;
}

const TICKS_FILE = "sampler-ticks.json";

/** Persist raw ticks + timestamps so a reload's first tick keeps CPU values. */
export function persistTicks(stateDir: string): void {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    fs.mkdirSync(stateDir, { recursive: true });
    const payload = {
      savedAt: Date.now(),
      lastScanTs,
      ticks: Array.from(ticks.entries()),
    };
    fs.writeFileSync(path.join(stateDir, TICKS_FILE), JSON.stringify(payload));
  } catch { /* best effort */ }
}

/** Restore ticks persisted by a previous instance (same boot only). */
export function restoreTicks(stateDir: string): void {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const raw = fs.readFileSync(path.join(stateDir, TICKS_FILE), "utf8");
    const saved = JSON.parse(raw);
    // Ignore snapshots from a previous boot: starttime values encode boot-relative
    // process identity, so a stale table would mismatch every pid.
    if (!saved || !saved.savedAt || Date.now() - saved.savedAt > 10 * 60_000) return;
    if (!Array.isArray(saved.ticks)) return;
    ticks = new Map(saved.ticks);
    lastScanTs = saved.lastScanTs || 0;
    firstTick = ticks.size > 0 ? false : firstTick;
  } catch { /* missing/corrupt file — start cold */ }
}

export function uidOf(pid: number): number | null {
  return platform === "linux" ? linux.uidOf(pid) : impl.uidOf ? impl.uidOf(pid) : null;
}

export function procStart(pid: number): number | null {
  return platform === "linux" ? linux.procStart(pid) : null;
}

export { os };

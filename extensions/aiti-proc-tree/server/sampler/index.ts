/**
 * aiti-proc-tree · server/sampler/index.ts — platform dispatch + CPU delta cache.
 *
 * Sampling is request-driven only: no timers live here. The 500ms raw cache
 * merges concurrent polls from the dock face and the floating panel.
 */
import * as linux from "./linux.ts";
import * as darwin from "./darwin.ts";
import * as win32 from "./win32.ts";

const core = require("../../core.cjs");

const os = require("node:os");

export const platform: string = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : "win32";
const impl: any = platform === "linux" ? linux : platform === "darwin" ? darwin : win32;

let rawCache: { ts: number; map: Map<number, any> } = { ts: 0, map: new Map() };
let ticks = new Map<string, { utime: number; stime: number; ts: number }>();
let firstTick = true;
let lastScanTs = 0;

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
      raw = linux.scanRaw();
      rawCache = { ts: now, map: raw };
    }
    const preview = core.visibleSet(raw, opts.rows, opts.selfPid, opts.cliPid);
    const details = new Map<number, any>();
    for (const pid of preview.visible) {
      const p = raw.get(pid);
      if (!p) continue;
      const d: any = linux.readDetail(pid, { withEnv: preview.seeds.has(pid) });
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
      details.set(pid, d);
    }
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
      if (d) details.set(pid, d);
    }
    const wasFirst = firstTick;
    firstTick = false;
    return { raw: scanned.raw, details, firstTick: wasFirst, scanned: scanned.raw.size, visible: details.size, approxCpu: true };
  }

  const scanned = await win32.scan();
  const preview = core.visibleSet(scanned.raw, opts.rows, opts.selfPid, opts.cliPid);
  const details = new Map<number, any>();
  for (const pid of preview.visible) {
    const d = scanned.details.get(pid);
    if (d) details.set(pid, d);
  }
  const wasFirst = firstTick;
  firstTick = false;
  return { raw: scanned.raw, details, firstTick: wasFirst, scanned: scanned.raw.size, visible: details.size, approxCpu: true };
}

/** Reset caches (tests / extension reload). */
export function reset(): void {
  rawCache = { ts: 0, map: new Map() };
  ticks = new Map();
  firstTick = true;
  lastScanTs = 0;
}

export function uidOf(pid: number): number | null {
  return platform === "linux" ? linux.uidOf(pid) : impl.uidOf ? impl.uidOf(pid) : null;
}

export function procStart(pid: number): number | null {
  return platform === "linux" ? linux.procStart(pid) : null;
}

export { os };

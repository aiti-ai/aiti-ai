/**
 * aiti-proc-tree · server/kill.ts — execute a validated kill plan.
 *
 * The plan (who may be signalled, in which order) is computed by core.killPlan;
 * this module only performs signals and writes the audit trail. POSIX:
 * SIGTERM, wait up to 1.5s, then SIGKILL for survivors. Windows: taskkill /F.
 * The wait loop is a bounded kill grace period, not a polling mechanism.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export interface KillResult {
  pid: number;
  ok: boolean;
  signal?: string;
  error?: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until every pid is gone or the grace window elapses. */
async function waitGone(pids: number[], graceMs: number): Promise<number[]> {
  const deadline = Date.now() + graceMs;
  let remaining = pids.filter(alive);
  while (remaining.length && Date.now() < deadline) {
    await sleep(150);
    remaining = remaining.filter(alive);
  }
  return remaining;
}

function audit(stateDir: string, record: unknown): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, "kill-audit.jsonl"), JSON.stringify(record) + "\n", "utf8");
  } catch {
    /* audit failure must not break the kill response */
  }
}

export async function executeKill(opts: {
  allowed: Array<{ pid: number; depth: number }>;
  denied: Array<{ pid: number; reason: string }>;
  mode: string;
  stateDir: string;
  allowHost: boolean;
  selfPid: number;
}): Promise<{ results: KillResult[]; denied: Array<{ pid: number; reason: string }> }> {
  const results: KillResult[] = [];
  const pids = opts.allowed.map((a) => a.pid);
  if (!pids.length) {
    return { results: [], denied: opts.denied };
  }

  if (process.platform === "win32") {
    for (const pid of pids) {
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore", timeout: 8000 });
        results.push({ pid, ok: true, signal: "TASKKILL" });
      } catch (e: any) {
        results.push({ pid, ok: false, error: String(e?.message || e) });
      }
    }
  } else {
    const termOk = new Map<number, boolean>();
    for (const pid of pids) termOk.set(pid, signal(pid, "SIGTERM"));
    const survivors = await waitGone(pids, 1500);
    const survivorSet = new Set(survivors);
    for (const pid of pids) {
      if (!survivorSet.has(pid)) {
        results.push({ pid, ok: termOk.get(pid) !== false, signal: "SIGTERM" });
      }
    }
    for (const pid of survivors) {
      const ok = signal(pid, "SIGKILL");
      results.push({ pid, ok, signal: "SIGKILL", ...(ok ? {} : { error: "signal failed" }) });
    }
  }

  audit(opts.stateDir, {
    ts: new Date().toISOString(),
    actor: "ui",
    mode: opts.mode,
    selfPid: opts.selfPid,
    allowHost: opts.allowHost,
    pids,
    results,
    denied: opts.denied,
  });
  return { results, denied: opts.denied };
}

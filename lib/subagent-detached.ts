/**
 * Upstream pi-subagents detached-run liveness (implements the fork integration
 * plan §5.4 and the upstream extension-api.md "Host session lifetime"
 * warning).
 *
 * Background: the host session idle GC (10 minutes) only looks at the parent
 * session's own isRunning(). After the parent delegates a background
 * subagent it is necessarily idle — if the wrapper were reclaimed on idle,
 * the upstream extension's completion watcher / wait subscriptions would be
 * destroyed with it; the symptom is "background subagents never report back"
 * (the work is not lost — the detached child process keeps running to
 * completion and persists its output, but the notify/wait chains break).
 *
 * Liveness rules (implemented per the upstream doc checklist):
 *   - scan async-subagent-runs/<runId>/status.json under each
 *     pi-subagents-<scope> domain in the temp directory
 *   - only state queued or running can be a live run (paused/complete/failed
 *     are all terminal)
 *   - status.sessionId matches the host session in two forms: file path
 *     first (getSessionFile()); unpersisted sessions degrade to the bare
 *     sessionId
 *   - the runner pid is authoritative for liveness (pid alive = live; the
 *     status file is not rewritten during long silent tool calls, so file
 *     age is not a heartbeat); a live state with no pid is conservatively
 *     treated as live (better to extend life than to kill by mistake)
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const LIVE_STATES = new Set(["queued", "running"]);

function pidAlive(pid: unknown): boolean {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return true; // no pid → conservatively treat as alive
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the session still has live detached subagents.
 * @param sessionFile session file path (getSessionFile(), may be empty)
 * @param sessionId   session uuid (getSessionId())
 * @returns true = a live run exists, the host should extend its life and not
 * reclaim it. Any read error conservatively returns true.
 */
export function hasLiveDetachedRuns(sessionFile: string, sessionId: string): boolean {
  if (!sessionFile && !sessionId) return false;
  let tmpEntries: string[];
  try {
    tmpEntries = readdirSync(tmpdir());
  } catch {
    return true; // liveness check unavailable → conservatively extend life
  }
  for (const name of tmpEntries) {
    if (!name.startsWith("pi-subagents-")) continue;
    const runsDir = join(tmpdir(), name, "async-subagent-runs");
    let runIds: string[];
    try {
      runIds = readdirSync(runsDir);
    } catch {
      continue; // no async dir for this scope
    }
    for (const runId of runIds) {
      let status: Record<string, unknown>;
      try {
        status = JSON.parse(readFileSync(join(runsDir, runId, "status.json"), "utf8")) as Record<string, unknown>;
      } catch {
        continue; // missing/corrupt dirs do not block
      }
      if (!LIVE_STATES.has(String(status.state ?? ""))) continue;
      const sid = String(status.sessionId ?? "");
      if ((sessionFile && sid === sessionFile) || (sessionId && sid === sessionId)) {
        return pidAlive(status.pid);
      }
    }
  }
  return false;
}

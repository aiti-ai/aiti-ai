/**
 * agent-starter — public surface.
 *
 *   types.ts        AgentStarter / WrapperStarter contracts (Strategy)
 *   direct.ts       DirectStarter (today's behavior)
 *   wrapper.ts      LinuxMacWrapperStarter (detachable, socket hosted)
 *   registry.ts     on-disk session registry (recovery routing data)
 *   runner.ts       systemd-run / plain-detached probe + launch (Factory input)
 *   socket-child.ts ChildProcess facade over the framed socket (Adapter)
 *   (the wrapper program ships as `bin/agent-wrapper.mjs`, run via `pi-web wrapper`)
 *   wire.ts         framing + control frames
 *
 * The factory decides ONCE per process which strategies exist; callers (the
 * session layer) pick one per session and inject it through
 * `createSession({ agentStarter })`.
 *
 * Switches (top → bottom, first match wins):
 *   PI_WEB_AGENT_DETACH=0        force DirectStarter everywhere
 *   PI_AGENT_STARTER_RUNNER=...  force systemd-run | plain (verification matrix)
 *   provider.detachable !== true / createSession({ detach: false })
 *   default: wrapper when the factory produced one
 *
 * Idle lifecycle: PI_WEB_IDLE_TIMEOUT_MS is shared with pi-web's in-process
 * session GC. A wrapper-hosted agent with no attached client and no output for
 * that long is reaped by the wrapper itself (see bin/agent-wrapper.mjs); while a
 * client is attached, pi-web owns the lifecycle (handle-store idle governor).
 */

import { existsSync } from "node:fs";
import { DirectStarter } from "./direct.ts";
import { LinuxMacWrapperStarter } from "./wrapper.ts";
import { probeRunner } from "./runner.ts";
import { backfillDetachedPreferences, listEntries, pruneDeadEntries, setDetachedPreference, starterRoot } from "./registry.ts";
import type { AgentStarter, WrapperStarter } from "./types.ts";

export type { AgentStarter, AgentStarterSpawnOptions, WrapperStarter } from "./types.ts";
export { DirectStarter } from "./direct.ts";
export { LinuxMacWrapperStarter } from "./wrapper.ts";
export { SocketChild, isDetachableChild, REPLAY_END_EVENT } from "./socket-child.ts";
export {
  starterRoot,
  registryDir,
  runDir,
  logDir,
  launchDir,
  prefsDir,
  sessionKey,
  listEntries,
  findEntryBySession,
  pruneDeadEntries,
  setDetachedPreference,
  getDetachedPreference,
  clearDetachedPreference,
  listDetachedPreferenceIds,
  backfillDetachedPreferences,
  type SessionEntry,
  type DetachedPreference,
  type RunnerKind,
} from "./registry.ts";

export type AgentStarters = {
  direct: DirectStarter;
  /** Undefined when detaching is disabled or unavailable on this host. */
  wrapper?: WrapperStarter;
  /** Why the wrapper is missing (diagnostics / one-time log line). */
  detail: string;
};

declare global {
  // globalThis: Next.js dev/HMR loads several module copies; the starters must
  // be one instance (same rationale as __sessionProviders).
  // eslint-disable-next-line no-var
  var __agentStarters: Promise<AgentStarters> | undefined;
  var __agentStartersPruned: boolean | undefined;
}

export function detachDisabledByEnv(): boolean {
  const raw = (process.env.PI_WEB_AGENT_DETACH || "").trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off";
}

/**
 * Idle reap timeout handed to wrappers — the same env var and contract as the
 * in-process session GC (rpc-manager.resolveSessionIdleTimeoutMs, kept local
 * to avoid the import cycle): unset/blank → 10 minutes, "0" → disabled,
 * otherwise the value clamped to Node's timer range; invalid falls back to the
 * default with a warning.
 */
function resolveWrapperIdleTimeoutMs(rawValue: string | undefined = process.env.PI_WEB_IDLE_TIMEOUT_MS): number {
  if (rawValue !== undefined && rawValue.trim() !== "") {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2_147_483_647) return parsed;
    console.warn(`[agent-starter] invalid PI_WEB_IDLE_TIMEOUT_MS "${rawValue}", falling back to 10 minutes`);
  }
  return 10 * 60 * 1000;
}

/**
 * Build (once per process) the strategy set. Runner probing is async (a single
 * `systemctl --user is-system-running` call), so this returns a promise and the
 * session layer awaits it only when a session actually needs a starter.
 */
export function getAgentStarters(): Promise<AgentStarters> {
  if (!globalThis.__agentStarters) {
    globalThis.__agentStarters = buildStarters();
  }
  return globalThis.__agentStarters;
}

async function buildStarters(): Promise<AgentStarters> {
  const direct = new DirectStarter();
  if (detachDisabledByEnv()) {
    return { direct, detail: "PI_WEB_AGENT_DETACH=0 (detaching disabled)" };
  }
  try {
    const probe = await probeRunner();
    const wrapper = new LinuxMacWrapperStarter({ runner: probe.kind, runnerEnv: probe.env, idleTimeoutMs: resolveWrapperIdleTimeoutMs() });
    if (!globalThis.__agentStartersPruned) {
      globalThis.__agentStartersPruned = true;
      // Startup sweep: entries whose wrapper died (crash, reboot) are noise in
      // holds() lookups; pruning here keeps the probe cheap. The wrappers that are
      // still alive then get their survive-restart marker backfilled: spawns from
      // older builds left none, and the next idle reap is the last moment the fact
      // "this session was hosted detached" can be written down.
      void pruneDeadEntries()
        .then(() => backfillDetachedPreferences(listEntries()))
        .catch(() => {});
    }
    return { direct, wrapper, detail: `${probe.kind}: ${probe.detail}` };
  } catch (err) {
    return {
      direct,
      detail: `probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Detach availability as the UI needs it (one cheap, cached probe). */
export type DetachSupportInfo = {
  /** Can a provider host its agent in a wrapper on this host right now? */
  available: boolean;
  /** Which runner would be used ("systemd-run" | "plain"). */
  runner?: string;
  /** Why it is unavailable / which runner was chosen (shown as a tooltip). */
  reason: string;
};

export async function describeDetachSupport(): Promise<DetachSupportInfo> {
  const starters = await getAgentStarters();
  if (!starters.wrapper) return { available: false, reason: starters.detail };
  return { available: true, runner: starters.wrapper.runner, reason: starters.detail };
}

/** Wrapper strategy only when it exists (recovery routing: holds/attach). */
export async function getWrapperStarter(): Promise<WrapperStarter | undefined> {
  const starters = await getAgentStarters();
  return starters.wrapper;
}

/**
 * The hosted agent moved to another session on its own (a rebind-shaped fork: pi's RPC
 * `fork` moves the one subprocess to a NEW session file and announces the new id).
 *
 * Stop it and forget its registry entry, then mark the new session as
 * detached-preferred. Why: the registry key, socket path and systemd unit still carry
 * the SOURCE id after a rebind, so once the process moved away
 *   - the source session can never start an agent again (the unit name / socket path
 *     stay taken — spawn is refused as "already hosted"), and
 *   - the copy has no entry of its own (a second agent could open the same file).
 * Both session files stay intact; each one cold-starts from its own file afterwards
 * (the copy keeps detached hosting through the preference).
 *
 * Returns true when a hosted process was actually released.
 */
export async function releaseReboundWrapper(newSessionId: string): Promise<boolean> {
  if (!newSessionId) return false;
  const wrapper = await getWrapperStarter();
  if (!wrapper) return false;
  const entry = wrapper.describe(newSessionId);
  if (!entry) return false; // not wrapper-hosted (direct/in-process) — nothing to release
  let released = false;
  try {
    released = await wrapper.kill(newSessionId);
  } catch {
    released = false;
  }
  try {
    setDetachedPreference(newSessionId, {
      mode: "subprocess-detached",
      ...(entry.providerType ? { providerType: entry.providerType } : {}),
      ...(entry.agentKey ? { agentKey: entry.agentKey } : {}),
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
    });
  } catch {
    /* the next open falls back to in-process hosting */
  }
  return released;
}

/**
 * Choose the strategy for one session. Called by the core at the createSession
 * call sites — never inside a provider and never inside spawn().
 */
export function selectStarter(
  starters: AgentStarters,
  options: { detach?: boolean; providerDetachable?: boolean },
): AgentStarter {
  if (options.detach === false) return starters.direct;
  // Opt-in only: a provider must declare `detachable: true` to receive the
  // wrapper strategy. Everything else keeps today's plain child process (a
  // backend that never calls options.agentStarter is unaffected either way).
  // Providers that need node IPC (`child.send`) or non-pipe stdio simply do not
  // opt in: a facade child cannot represent either.
  if (options.providerDetachable !== true) return starters.direct;
  if (!starters.wrapper) return starters.direct;
  return starters.wrapper;
}

/** Test hook: drop the process-wide cache (env changes between cases). */
export function resetAgentStartersForTest(): void {
  globalThis.__agentStarters = undefined;
  globalThis.__agentStartersPruned = undefined;
}

/** Registry health snapshot (diagnostics endpoint / tests). */
export function starterHomeExists(): boolean {
  return existsSync(starterRoot());
}

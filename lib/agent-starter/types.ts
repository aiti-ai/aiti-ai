/**
 * AgentStarter — the single entry point every agent backend uses to start its
 * agent process.
 *
 * Motivation: external agent backends (pi --mode rpc, claude/codex/cursor
 * spawn, ACP bridges) all do `spawn(command, args, opts)` and wrap the child in
 * their own handle. If the process is a direct child of pi-web, it dies with
 * pi-web (restart / extension reload) and an in-flight turn is lost. A
 * detachable wrapper fixes that without touching a single line of the agent's
 * stdio handling — the child process surface is preserved.
 *
 * Pattern note (Strategy + Factory + DI):
 *   - Strategy: DirectStarter (today's behavior) vs WrapperStarter (detached).
 *     Both expose the same `spawn` signature; implementations contain no
 *     branching.
 *   - Factory: `createAgentStarter()` decides runner availability once, at
 *     construction time (systemd-run vs plain detached, feature switches).
 *   - DI: the core builds the starters and passes one through
 *     `createSession({ agentStarter })`; extensions never import the factory.
 */

import type { ChildProcess } from "node:child_process";
import type { SessionEntry } from "./registry.ts";

/** Spawn options accepted by both strategies (node spawn fields we honor). */
export type AgentStarterSpawnOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cwd?: string;
  /** Mirrors node's spawn option; a wrapper child runs through a shell when set. */
  shell?: boolean | string;
  /**
   * Only "pipe" stdio is representable over the socket. The injection layer
   * routes non-pipe requests to DirectStarter, so this field is informational.
   */
  stdio?: unknown;
  /** Agent family ("pi" | "claude" | …) — join key for recovery routing. */
  agentKey?: string;
  /** Native session id — registry key for reattach. Required by wrappers. */
  sessionId?: string;
  /**
   * Registry key of the provider that owns the session ("aiti-pi-agent/spawn").
   * Recorded in the registry entry so a reattach can pick exactly the provider
   * that spawned it instead of guessing by agentKey.
   */
  owner?: string;
};

/** The strategy interface. `spawn` is the only mandatory method. */
export interface AgentStarter {
  /** "direct" = plain child process; "wrapper" = detachable hosted process. */
  readonly kind: "direct" | "wrapper";
  spawn(command: string, args: string[], options?: AgentStarterSpawnOptions): Promise<ChildProcess>;
}

/** Capabilities a detachable implementation adds (used by the core, not extensions). */
export interface WrapperStarter extends AgentStarter {
  readonly kind: "wrapper";
  /** Reattach to a session that outlived pi-web (journal replay included). */
  attach(sessionId: string): Promise<ChildProcess>;
  /** Registry probe: is this session hosted by a live wrapper right now? */
  holds(sessionId: string): Promise<boolean>;
  /** Registry entry for a session (agentKey/cwd/pid — the recovery routing data). */
  describe(sessionId: string): SessionEntry | undefined;
  /** Stop the hosted agent (control frame), then drop the registry entry. */
  kill(sessionId: string, signal?: string): Promise<boolean>;
  /** Every entry the registry currently knows about. */
  list(): SessionEntry[];
}

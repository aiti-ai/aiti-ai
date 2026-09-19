/**
 * lib/subagent.ts — subagent entry point (a subagent = a forked, fully persisted session with a
 * parent marker)
 *
 * Design principle (aligned with the original pi-subagents): keep the difference between a
 * subagent and a real agent session as small as possible — reuse the full session creation flow
 * (createAgentSessionServices + createAgentSessionFromServices + startRpcSession); persistence,
 * indexing, stats, message viewing, and extension notifications are all shared. The only
 * difference is the parentSession marker in the session header (pointing at the parent session
 * file), from which the frontend identifies "whose subagent it is".
 *
 * Mechanism:
 *   1. SessionManager.create(cwd).newSession({ parentSession: <parent session file> })
 *      → forks an empty session; the header automatically carries parentSession (same as a
 *      from-scratch /fork)
 *   2. startRpcSession(forkFile, ..., { subagent: { systemPrompt, excludeTools } })
 *      → reuses the full session creation (persistence/registry/extension notification); injects
 *      the agent definition's systemPrompt
 *   3. wrapper.send({ type: "prompt", message: task }) drives execution
 *   4. Subscribe to agent_settled / prompt_done → getLastAssistantText() for the final output
 *
 * Exposed via globalThis.__piSubagentFactory (called by the subagents extension, same pattern as the bridge).
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

export interface SubagentAgentDef {
  name: string;
  systemPrompt: string;
  /** Optional: model to use (provider/modelId or bare modelId; inherits from the parent when unresolved) */
  modelId?: string;
  /** Optional: tool allowlist (omitted = all enabled, inheriting all system/extension tools) */
  tools?: string[];
  /** Optional: tool denylist (all enabled by default; e.g. exclude interactive user_* tools) */
  excludeTools?: string[];
}

export interface CreateSubagentOptions {
  /** Absolute path of the parent session file (source of the parentSession marker) */
  parentSessionFile: string;
  /** Subagent working directory (the fork's cwd; usually the same as the parent) */
  cwd: string;
  /** Agent definition */
  agent: SubagentAgentDef;
  /** Subagent task (drives execution as the first user message) */
  task: string;
  /** Timeout in ms (default 10 minutes) */
  timeoutMs?: number;
  /** Abort signal: stops the subagent when triggered (marks aborted + closes the wrapper) */
  signal?: AbortSignal;
  /** Optional: run-time control callback for the subagent (invoked as soon as the wrapper is ready, for mid-run steer/abort). */
  onControl?: (control: SubagentControl) => void;
}

export interface SubagentResult {
  sessionId: string;
  sessionFile: string;
  output: string;
  parentSessionFile: string;
  agent: string;
  /** Result status: completed / error / timeout / aborted */
  status: "completed" | "error" | "timeout" | "aborted";
}

/**
 * Run-time control handle for a subagent (invoked back to the caller as soon as the subagent
 * session is created, for mid-run steer / abort — aligned with the pi-subagents ecosystem's
 * steer_subagent semantics).
 * Valid only while the subagent wrapper is running; after completion steer becomes a no-op
 * (blocked by the settle guard).
 */
export interface SubagentControl {
  sessionId: string;
  /** Inject a steering message mid-run (rpc-manager's type:"steer" channel → inner.steer). */
  steer: (text: string) => Promise<void>;
  /** Proactively abort the subagent (equivalent to a signal abort; marks aborted and returns the current output). */
  abort: () => void;
  /** Whether still running (false after settle). */
  isRunning: () => boolean;
}

const SUBAGENT_TIMEOUT_DEFAULT = 10 * 60 * 1000;

/**
 * Creates and runs a subagent session (fork + full session flow + agent definition controls).
 * Returns the child session's final output (the session is persisted: message history viewable,
 * stats shared).
 */
export async function createSubagentSession(options: CreateSubagentOptions): Promise<SubagentResult> {
  const { parentSessionFile, cwd, agent, task, timeoutMs = SUBAGENT_TIMEOUT_DEFAULT, signal, onControl } = options;

  // 1. Fork an empty session + parent marker (same as a from-scratch /fork: SessionManager.create + newSession)
  const sm = SessionManager.create(cwd, undefined, { id: randomUUID() });
  sm.newSession({ parentSession: parentSessionFile });
  // Force persistence: with no assistant messages, SessionManager lazily skips writing to disk;
  // if the file doesn't exist, startRpcSession recreates it on open (losing the parentSession
  // header). Same as the host app's fork _rewriteFile handling (rpc-manager case "fork").
  try {
    (sm as unknown as { _rewriteFile?: () => void })._rewriteFile?.();
    (sm as unknown as { flushed?: boolean }).flushed = true;
  } catch (e) {
    console.warn("[subagent] fork force-flush to disk failed (continuing):", e instanceof Error ? e.message : e);
  }
  const sessionFile = sm.getSessionFile();
  if (!sessionFile) throw new Error("subagent fork failed: no session file was generated");

  // 2. Reuse the full session creation flow (persistence/registry/extension notification) + agent definition controls
  // Lazy-load rpc-manager (static resolution fails at instrumentation startup; importing at
  // runtime avoids it)
  // Use the @/ alias (turbopack's resolution of relative .js suffixes is unstable in the
  // instrumentation environment)
  const { startRpcSession } = await import("@/lib/rpc-manager");
  const { session: wrapper, realSessionId } = await startRpcSession(
    `__subagent__${randomUUID()}`,
    sessionFile,
    cwd,
    {
      ...(agent.modelId ? { initialModel: parseModelId(agent.modelId) } : {}),
      // tools allowlist (non-empty → activate these + extension tools; empty array → all disabled; omitted → all enabled)
      ...(agent.tools ? { toolNames: agent.tools } : {}),
      // The newly forked file is necessarily local; skip the bridge occupancy check
      skipBridgeCheck: true,
      subagent: {
        systemPrompt: agent.systemPrompt,
        ...(agent.excludeTools?.length ? { excludeTools: agent.excludeTools } : {}),
      },
    },
  );

  // 3. Drive execution + subscribe to the result
  return new Promise<SubagentResult>((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    let onAbort: (() => void) | null = null;
    let liveWrapper: typeof wrapper | null = wrapper;

    // Run-time control handle: invoked as soon as the wrapper is ready, for the extension side to
    // implement steer_subagent / background mode.
    // steer goes through rpc-manager's type:"steer" channel; abort reuses the signal abort path
    // (mark aborted + return current output).
    if (onControl) {
      onControl({
        sessionId: realSessionId,
        steer: async (text: string) => {
          if (settled || !liveWrapper) return;
          // Don't swallow exceptions: let the caller (the extension's steerRun) sense injection failure (e.g. the session is being replaced/closed)
          await liveWrapper.send({ type: "steer", message: text });
        },
        abort: () => {
          if (settled) return;
          void wrapper.send({ type: "abort" }).catch(() => {});
          finish("aborted", wrapper.inner.getLastAssistantText() ?? "");
        },
        isRunning: () => !settled,
      });
    }

    // Teardown: clear timer + unsubscribe events + close the wrapper (the file is kept; only removed from the active registry, no accumulation)
    const teardown = () => {
      clearTimeout(timer);
      unsubscribe();
      liveWrapper = null;
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      void wrapper.shutdown("idle").catch((err) => {
        console.warn("[subagent] wrapper shutdown failed:", err instanceof Error ? err.message : err);
      });
    };

    const finish = (status: "completed" | "timeout" | "error" | "aborted", out: string) => {
      if (settled) return;
      settled = true;
      teardown();
      resolve({
        sessionId: realSessionId,
        sessionFile,
        output: out,
        parentSessionFile,
        agent: agent.name,
        status,
      });
    };

    const timer = setTimeout(() => {
      finish("timeout", wrapper.inner.getLastAssistantText() ?? "");
    }, timeoutMs);

    // Abort signal: stop the subagent (user clicks Fleet "Stop" / parent session abort)
    if (signal) {
      if (signal.aborted) {
        finish("aborted", "");
      } else {
        onAbort = () => {
          void wrapper.send({ type: "abort" }).catch(() => {});
          finish("aborted", wrapper.inner.getLastAssistantText() ?? "");
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // agent_settled: one full execution round finished (including after retries/compaction)
    unsubscribe = wrapper.onEvent((event) => {
      if (event.type === "agent_settled") {
        finish("completed", wrapper.inner.getLastAssistantText() ?? "");
      }
    });

    // 4. Send the task
    void wrapper.send({ type: "prompt", message: task }).catch((err) => {
      console.warn("[subagent] send failed:", err instanceof Error ? err.message : err);
      finish("error", "");
    });
  });
}

/** Parses "provider/modelId" or a bare "modelId" into startRpcSession's initialModel format */
function parseModelId(raw: string): { provider: string; modelId: string } {
  const idx = raw.indexOf("/");
  if (idx > 0) return { provider: raw.slice(0, idx), modelId: raw.slice(idx + 1) };
  // Bare modelId: leave provider empty; startRpcSession resolves by modelId
  return { provider: "", modelId: raw };
}

/** Mounts onto globalThis: called by the subagents extension (same pattern as the bridge's globalThis.__aitiBridges) */
export function installSubagentFactory(): void {
  const g = globalThis as Record<string, unknown>;
  if (!g.__piSubagentFactory) {
    g.__piSubagentFactory = {
      create: createSubagentSession,
    };
  }
}

// Declare globalThis types (for TS)
declare global {
  // eslint-disable-next-line no-var
  var __piSubagentFactory: { create: typeof createSubagentSession } | undefined;
}

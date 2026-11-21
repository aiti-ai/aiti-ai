/**
 * Server-side pending-compaction queue.
 *
 * A compact request that arrives while the session is busy is parked HERE (keyed by
 * session id) instead of in the requesting browser tab. The registry watches the
 * live session wrapper's event stream and flushes the parked compaction as soon as
 * the session settles — so the pending state survives page reloads, session switches
 * and tab closes, which the previous client-only queue lost silently.
 *
 * Wiring (see POST/GET /api/agent/[id]):
 *   - {type:"compact", queueIfBusy:true} on a busy session → parkCompact; on an idle
 *     session the route executes the compaction right away (helper answers null).
 *   - Every settle-ish wrapper event arms ONE debounced state check — no polling:
 *     still busy (or queued follow-ups pending) → wait for the next event; idle →
 *     run the compaction through the same wrapper. The compaction's own
 *     compaction_start/compaction_end events reach clients over the normal SSE
 *     stream, so the UI shows progress and the result banner without extra wiring.
 *   - get_state responses OR-in `compactQueued` so a reopened page restores the
 *     pending indicator.
 *   - {type:"cancel_compact_queue"} removes a parked entry.
 *
 * Scope notes:
 *   - In-memory by design: a pi-web process restart drops parked entries (the
 *     parked-during-compaction prompt queue in rpc-manager is in-memory too).
 *   - The wrapper is captured at park time; if it dies or rebinds to another
 *     session (fork), the entry is dropped rather than compacting the wrong target.
 *   - A flushed compaction that fails surfaces through the normal compaction_end
 *     {errorMessage} event (the client already renders it as the compact banner);
 *     the entry is not retried automatically.
 */

/** The slice of WrappedSessionLike (lib/session/handle-adapter.ts) the queue needs. */
export interface CompactQueueWrapper {
  isAlive(): boolean;
  send(command: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (event: { type: string; [key: string]: unknown }) => void): () => void;
}

export interface ParkedCompact {
  customInstructions?: string;
  queuedAt: number;
}

interface ParkedEntry extends ParkedCompact {
  wrapper: CompactQueueWrapper;
  unsubscribe: () => void;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Guards against a re-entrant flush while a state read / compaction is in flight. */
  flushing: boolean;
  checkDelayMs: number;
}

/** Wrapper events that mark a settle/queue transition worth re-checking idle on. */
const SETTLE_EVENTS = new Set([
  "agent_settled",
  "agent_end",
  "prompt_done",
  "compaction_end",
  "auto_compaction_end",
  "queue_update",
]);

/** Wrapper events that mean the session is gone — drop the park instead of flushing. */
const DEATH_EVENTS = new Set(["session_backend_dead", "session_shutdown"]);

/** Debounce window after a settle event before the idle check runs. */
const DEFAULT_CHECK_DELAY_MS = 400;

const parks = new Map<string, ParkedEntry>();

function readState(wrapper: CompactQueueWrapper): Promise<Record<string, unknown>> {
  return wrapper.send({ type: "get_state" }) as Promise<Record<string, unknown>>;
}

/** Same busy criteria the frontend's stateIsActive uses, read from a get_state payload. */
function stateBusy(state: Record<string, unknown> | null | undefined): boolean {
  if (!state) return true; // unreadable state → treat as busy, wait for the next event
  return Boolean(
    state.isRunning === true
    || state.isStreaming === true
    || state.isPromptRunning === true
    || state.isCompacting === true,
  );
}

/** Queued steer/follow-up messages still waiting: let them run before compacting. */
function stateQueuedPending(state: Record<string, unknown> | null | undefined): boolean {
  const q = state?.queuedMessages as { steering?: unknown[]; followUp?: unknown[] } | undefined;
  return (q?.steering?.length ?? 0) + (q?.followUp?.length ?? 0) > 0;
}

function drop(id: string): void {
  const entry = parks.get(id);
  if (!entry) return;
  parks.delete(id);
  if (entry.flushTimer) clearTimeout(entry.flushTimer);
  try {
    entry.unsubscribe();
  } catch { /* a dying wrapper's unsubscribe must not throw into the event path */ }
}

function armCheck(id: string, delayMs: number): void {
  const entry = parks.get(id);
  if (!entry || entry.flushTimer) return;
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = null;
    void flushCheck(id);
  }, delayMs);
}

/** One idle check for a parked entry: flush when settled, keep waiting otherwise. */
async function flushCheck(id: string): Promise<void> {
  const entry = parks.get(id);
  if (!entry || entry.flushing) return;
  if (!entry.wrapper.isAlive()) {
    drop(id);
    return;
  }
  entry.flushing = true;
  try {
    const state = await readState(entry.wrapper);
    // A fork rebind (wrapper now drives a different session) must not compact the
    // wrong target — drop instead.
    const sid = state?.sessionId;
    if (typeof sid === "string" && sid && sid !== id) {
      drop(id);
      return;
    }
    if (stateBusy(state) || stateQueuedPending(state)) return; // next settle event re-arms
    // Replaced/canceled while the state read was in flight → the newer entry wins.
    if (parks.get(id) !== entry) return;
    drop(id);
    const { customInstructions } = entry;
    void entry.wrapper
      .send({ type: "compact", ...(customInstructions ? { customInstructions } : {}) })
      .catch((error) => {
        // The compaction_end {errorMessage} event already tells connected clients;
        // this log is the server-side trace for sessions nobody is watching.
        console.error(
          "[compact-queue] flushed compaction failed:",
          error instanceof Error ? error.message : String(error),
        );
      });
  } catch {
    // Transient state-read failure: keep the park; the next settle event retries.
  } finally {
    entry.flushing = false;
  }
}

/**
 * Park a compaction for `id` unless the session is idle right now.
 * Answers the parked entry, or null when the caller should execute the compaction
 * immediately (idle session — the ordinary blocking path).
 */
export async function parkCompactIfBusy(
  id: string,
  wrapper: CompactQueueWrapper,
  entry: { customInstructions?: string },
  opts?: { checkDelayMs?: number },
): Promise<ParkedCompact | null> {
  let state: Record<string, unknown> | null = null;
  try {
    state = await readState(wrapper);
  } catch { /* unreadable state → treat as busy and park; the first check re-verifies */ }
  if (state && !stateBusy(state)) return null;

  // Replace any previous park (one pending compaction per session; the newest wins).
  cancelCompactQueue(id);
  const checkDelayMs = opts?.checkDelayMs ?? DEFAULT_CHECK_DELAY_MS;
  const parked: ParkedEntry = {
    customInstructions: entry.customInstructions,
    queuedAt: Date.now(),
    wrapper,
    unsubscribe: () => {},
    flushTimer: null,
    flushing: false,
    checkDelayMs,
  };
  parked.unsubscribe = wrapper.onEvent((event) => {
    const current = parks.get(id);
    if (!current || current.wrapper !== wrapper) return;
    const type = String((event as { type?: unknown })?.type ?? "");
    if (DEATH_EVENTS.has(type)) {
      drop(id);
      return;
    }
    if (SETTLE_EVENTS.has(type)) armCheck(id, current.checkDelayMs);
  });
  parks.set(id, parked);
  // Arm one check right away: the run may settle between the caller's busy probe
  // and this subscription, and without an initial arm that park would wait for an
  // event that already happened.
  armCheck(id, checkDelayMs);
  return { customInstructions: parked.customInstructions, queuedAt: parked.queuedAt };
}

/** Remove a parked compaction. True when one was actually parked. */
export function cancelCompactQueue(id: string): boolean {
  if (!parks.has(id)) return false;
  drop(id);
  return true;
}

/** Whether a compaction is currently parked for `id`. */
export function isCompactQueued(id: string): boolean {
  return parks.has(id);
}

/**
 * OR the parked flag into a get_state payload (mutates `state` when parked). Used by
 * the agent routes so a reopened page restores the pending indicator from server state.
 */
export function applyQueuedFlag(id: string, state: Record<string, unknown> | undefined | null): void {
  if (state && isCompactQueued(id)) state.compactQueued = true;
}

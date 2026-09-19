/**
 * Session run outcome — the single source of truth for "the result of the most recent run".
 *
 * Background: the last assistant message in a session file already carries the result
 * semantics (stopReason / errorMessage), but nothing used to read it — notifications kept
 * reporting "task completed" even after a failed run. This module provides pure functions so
 * that session-file derivation (session-reader) and the runtime wrapper's in-memory check
 * (rpc-manager) share one rule.
 *
 * Decision table (only the **last** assistant message counts — intermediate states such as a
 * steer interruption are superseded by later messages):
 *   error                  → failed (with errorMessage)
 *   aborted                → aborted (user-initiated stop)
 *   stop / length          → completed
 *   toolUse / pending / deferred and other non-terminal → interrupted
 *   no assistant message   → undefined (not marked)
 *
 * Note: `interrupted` is the objective file-level state; whether the session is currently
 * running is decided by the caller (the running set) and takes precedence.
 */

export type SessionRunStatus = "completed" | "failed" | "aborted" | "interrupted";

/** Terminal state of the session's most recent run (SessionInfo.lastRun). error carries the raw errorMessage; the display side truncates it as needed. */
export interface SessionLastRun {
  status: SessionRunStatus;
  /** Time of the terminal message (ISO 8601). */
  at: string;
  /** Only set for failed. */
  error?: string;
}

/** Minimal message shape for the decision input (common subset of pi messages and locally parsed messages). */
export interface RunOutcomeMessageLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
}

function statusForStopReason(stopReason: string | undefined): SessionRunStatus {
  switch (stopReason) {
    case "error":
      return "failed";
    case "aborted":
      return "aborted";
    case "stop":
    case "length":
      return "completed";
    default:
      // toolUse / pending / deferred / unknown: run has not reached a terminal state
      return "interrupted";
  }
}

/**
 * Derive the most recent run outcome from a message sequence. Returns undefined when there is
 * no assistant message.
 *
 * @param messages Session messages in chronological order
 * @param fallbackAt Fallback time (ISO) when the terminal message lacks a timestamp; when
 *   omitted, the undefined-return semantics apply (only when the message has no time either)
 */
export function deriveRunOutcome(
  messages: ReadonlyArray<RunOutcomeMessageLike> | undefined | null,
  fallbackAt?: string,
): SessionLastRun | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const at = typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? new Date(message.timestamp).toISOString()
      : fallbackAt;
    if (!at) return undefined;
    const status = statusForStopReason(message.stopReason);
    return {
      status,
      at,
      ...(status === "failed" && typeof message.errorMessage === "string" && message.errorMessage.trim()
        ? { error: message.errorMessage }
        : {}),
    };
  }
  return undefined;
}

/** Error summary (notifications/inline display): flattens newlines and repeated whitespace, truncates overly long text with an ellipsis (code-point truncation, emoji-safe). */
export function truncateRunError(error: string | undefined, max = 120): string {
  if (!error) return "";
  const flat = error.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return `${chars.slice(0, max - 1).join("")}…`;
}

/** Whether lastRun should notify (completed/failed notify; aborted is a user-initiated stop and does not notify; interrupted has no moment to notify). */
export function runOutcomeNotifies(status: SessionRunStatus): boolean {
  return status === "completed" || status === "failed";
}

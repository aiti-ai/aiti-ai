/**
 * Relay — agent-to-agent message passing (aligned with the cc-connect
 * bot-to-bot model).
 *
 * Delivers a message to a target live session (any backend), waits for its turn
 * to settle and collects the final assistant text. Initiators can be: frontend
 * orchestration, another session via an API call, or a future agent autonomy
 * tool.
 *
 * Constraints (Phase 1):
 *   - Target must be alive and idle; busy targets are rejected (no queueing —
 *     queueing semantics belong to each backend's queue)
 *   - Reply text = assistant deltas accumulated this turn; no history included
 *   - The reply is not auto-injected into the initiator's session (the caller
 *     decides how to use it)
 */

import { getHandle } from "./handle-store.ts";
import type { SessionHandle } from "./types.ts";

export interface RelayResult {
  ok: boolean;
  /** Final assistant text of the target's turn (on success). */
  reply?: string;
  /** Target id (echoed back for auditing). */
  to?: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Send `message` to the target live session and collect its reply.
 *
 * Flow: subscribe → prompt(target) → accumulate message_update deltas →
 * resolve on agent_settled (or timeout / backend death).
 */
export async function relayToSession(
  to: string,
  message: string,
  options: { timeoutMs?: number; images?: never[] } = {},
): Promise<RelayResult> {
  const handle = getHandle(to);
  if (!handle) {
    return { ok: false, error: `target session not found or dead: ${to}` };
  }
  if (handle.isRunning()) {
    return { ok: false, to, error: "target is busy (running a turn)" };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let replyText = "";
  const settled = false;
  let backendDead: string | null = null;

  const unsubscribe = handle.subscribe((event) => {
    const type = String(event.type ?? "");
    if (type === "session_backend_dead") {
      backendDead = String(event.reason ?? "backend died");
      return;
    }
    // Support both streaming event names: the adapter-normalized message_update and the native delta field
    if (type === "message_update" && typeof event.delta === "string") {
      replyText += event.delta;
      return;
    }
    if (type === "agent_message_chunk") {
      const block = (event.contentBlock ?? event.content ?? {}) as Record<string, unknown>;
      if (typeof block.text === "string") replyText += block.text;
      return;
    }
    if (type === "assistant_message" && typeof event.text === "string") {
      replyText = event.text; // full frame overrides deltas
    }
  });

  try {
    // Send (prompt handles preflight/queue semantics internally)
    await handle.prompt(message);
  } catch (e) {
    unsubscribe();
    return { ok: false, to, error: e instanceof Error ? e.message : String(e) };
  }

  // Wait for settle
  const startedAt = Date.now();
  while (!settled && !backendDead && Date.now() - startedAt < timeoutMs) {
    if (!handle.isRunning() && replyText !== "") break;
    await sleep(200);
    // Re-check state that may have been set via events
    if (!handle.alive()) backendDead = "target died mid-turn";
  }
  unsubscribe();

  if (backendDead) return { ok: false, to, error: `target died: ${backendDead}` };
  if (!settled && Date.now() - startedAt >= timeoutMs && handle.isRunning()) {
    return { ok: false, to, error: `timeout after ${timeoutMs}ms (target still running)` };
  }

  // Fallback: the settle event may fall outside the subscription window — ask a
  // getLastAssistantText-style capability once
  if (!replyText) {
    const t = await safeLastText(handle);
    if (t) replyText = t;
  }

  return { ok: true, to, reply: replyText.trim() || "(empty reply)" };
}

/** If the target implements a getLastAssistantText-style query, fetch via it (optional capability; silently skipped when absent). */
async function safeLastText(handle: SessionHandle): Promise<string | undefined> {
  try {
    const r = (await (handle as unknown as {
      send?: (cmd: Record<string, unknown>) => Promise<unknown>;
    }).send?.({ type: "get_last_assistant_text" })) as { text?: string } | undefined;
    return r?.text || undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

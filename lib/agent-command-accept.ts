/**
 * Bounded accept-window sending — the prompt-family commands of POST /api/agent/[id] no
 * longer wait synchronously for the whole turn to finish.
 *
 * Background: "acceptance" vs "full-turn completion" for the prompt family differs wildly
 * across backends —
 *   - local pi sessions / CC / qoder / cursor: acceptance resolves immediately (stdin write /
 *     preflight pass);
 *   - zcode / codex / acp: send() only resolves after the whole turn has run (minutes).
 * The second kind keeps the POST open for minutes, which inevitably hits the nginx
 * proxy_read_timeout (60s) → gateway 504, which the frontend then misreads as "the backend
 * is restarting". A prompt's result never depended on the POST response anyway — the
 * frontend drives the UI off the SSE events channel (agent_start / message_* /
 * agent_settled) as soon as the POST is sent.
 *
 * Semantics: if send settles within the window (resolve/throw) → original semantics hold
 * (200 / error mapped by the catch path); if it is still pending at timeout → treat as
 * accepted (202 {success,accepted,pending}); a late failure no longer has an HTTP outlet —
 * log it and best-effort re-emit prompt_error via wrapper.emit (pi vocabulary, the frontend
 * already has a consumption path for it) — the same convergence pattern as rpc-manager's
 * async prompt failures and restart-recovery's "do not await prompt".
 */

/** The accept window only applies to commands with "queue one message" semantics; other commands (get_state/set_model/…)
 *  must settle synchronously — callers depend on their return values. */
export const PROMPT_FAMILY_TYPES = new Set(["prompt", "steer", "follow_up"]);

/** Window value: synchronous rejections (session disposed/stdin closed/missing capability) throw within milliseconds;
 *  10s is enough to separate "real failures" from "slow turns", and far below the nginx 60s gateway timeout. */
export const PROMPT_ACCEPT_WINDOW_MS = 10_000;

export type AcceptVerdict =
  | { settled: true; result?: unknown; error?: unknown }
  | { settled: false };

export async function sendWithAcceptWindow(
  wrapper: {
    send(command: Record<string, unknown>): Promise<unknown>;
    /** Re-emit channel for failures that arrive after acceptance (optional; defaults to logging only). */
    emit?(event: Record<string, unknown>): unknown;
  },
  body: Record<string, unknown>,
  windowMs: number = PROMPT_ACCEPT_WINDOW_MS,
): Promise<AcceptVerdict> {
  const sending = wrapper.send(body);
  if (!PROMPT_FAMILY_TYPES.has(String(body.type ?? ""))) {
    try {
      return { settled: true, result: await sending };
    } catch (error) {
      return { settled: true, error };
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const verdict = await Promise.race([
    sending.then(
      (result) => ({ settled: true, result }) as AcceptVerdict,
      (error) => ({ settled: true, error }) as AcceptVerdict,
    ),
    new Promise<AcceptVerdict>((resolve) => {
      timer = setTimeout(() => resolve({ settled: false }), windowMs);
    }),
  ]);
  clearTimeout(timer);

  if (!verdict.settled) {
    // Swallow the late rejection (prevents unhandledRejection); the error goes out over the event channel instead.
    void sending.catch((error) => {
      console.error(
        "[pi-web] prompt accepted (202) but failed afterwards:",
        error instanceof Error ? error.message : error,
      );
      try {
        wrapper.emit?.({
          type: "prompt_error",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } catch { /* a failed re-emit is not fatal (the wrapper may already be disposed) */ }
    });
  }
  return verdict;
}

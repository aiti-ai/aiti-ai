import { apiUrl } from "./base-path.ts";
// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && error.code === "prompt_rejected"
    && error.accepted === false;
}

/** Bare status codes within the backend-restart window (nginx 502): add a "refresh" hint beyond
 *  them (users explicitly reported the missing guidance). Only applies to gateway errors without a
 *  JSON body; when the upstream app provides its own error field the semantics are unchanged. */
function backendDownHint(status: number): string {
  if (status === 502 || status === 503 || status === 504) return " (the backend may be restarting; refresh the page and retry shortly)";
  return "";
}

/** User-facing error message: transport failures (fetch throws TypeError — backend restarting and
 *  refusing connections / network down) get the refresh hint appended here; AgentCommandError's
 *  message already contains the hint on the bare gateway status code path and is returned as-is. */
export function describeAgentCommandError(error: unknown): string {
  if (error instanceof AgentCommandError) return error.message;
  return "Network request failed — the backend may be restarting; refresh the page and retry shortly";
}

/**
 * GET /api/agent/[id] without the system prompt, for status reads: the usage read after each
 * reply and on every stream connect, the settle and reconcile polls. None of them shows the
 * prompt, and it is nearly all of the reply (context files, skills, tool notes: hundreds of KB
 * in a large project), fetched again after every model call (#1302).
 */
export function agentStatusUrl(sessionId: string): string {
  return apiUrl(`/api/agent/${encodeURIComponent(sessionId)}?systemPrompt=0`);
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  // Transport failures pass through untouched (existing contract: distinguishable from
  // HTTP semantic errors, see agent-client.test.mjs)
  const res = await fetch(apiUrl(`/api/agent/${encodeURIComponent(sessionId)}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    accepted?: boolean;
  };
  if (!res.ok || body.error) {
    throw new AgentCommandError(
      body.error ?? `HTTP ${res.status}${backendDownHint(res.status)}`,
      res.status,
      body.code,
      body.accepted,
    );
  }
  return body.data as T;
}

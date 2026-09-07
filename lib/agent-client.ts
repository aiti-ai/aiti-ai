import { apiUrl } from "./base-path";
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

/** 后端重启窗口（nginx 502）裸状态码：之外给出「刷新」指引（用户明确反馈过缺指引）。
 *  仅对无 JSON body 的网关错误生效；上游应用自带 error 字段时语义不动。 */
function backendDownHint(status: number): string {
  if (status === 502 || status === 503 || status === 504) return "（后端可能正在重启，请稍后刷新页面重试）";
  return "";
}

/** 面向用户展示的错误文案：传输失败（fetch 抛 TypeError，后端重启拒连/断网）在此
 *  带上刷新指引；AgentCommandError 的 message 已在裸网关状态码路径含指引，原样返回。 */
export function describeAgentCommandError(error: unknown): string {
  if (error instanceof AgentCommandError) return error.message;
  return "网络请求失败——后端可能正在重启，请稍后刷新页面重试";
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  // 传输失败原样透传（既有契约：与 HTTP 语义错误可区分，见 agent-client.test.mjs）
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

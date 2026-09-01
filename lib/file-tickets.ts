import { apiUrl } from "@/lib/base-path";

// —— 文件路径不进 URL 的统一通道 ——
//
// 设计契约：禁止文件路径出现在 URL（path 段或 query）。凡要传路径一律走 POST body：
//   - fetch 型请求（list/read/meta/preview/download）→ POST /api/files/get { path, type, sessionId }
//   - 只能用 GET URL 的消费者（<img>/<video>/EventSource/<iframe>）→ 先 POST /api/files/ticket
//     { path, type } 换短时效票据（5 分钟 TTL、随机不可逆），再 GET /api/files/_t/<ticket>?type=…
//
// 不沿用永久的稳态路径令牌：令牌一旦落入隧道/代理 access log，路径将永久泄露；短票据过期失效，
// EventSource 重连时重新换票即可。

export type FileGetType = "list" | "read" | "meta" | "preview" | "download";
export type FileTicketType = "read" | "download" | "preview" | "watch" | "list" | "meta";

/** 换短时效票据（TTL 内可重复用）。失败抛错。 */
export function resolveFileTicket(filePath: string, type: FileTicketType): Promise<string> {
  return fetch(apiUrl("/api/files/ticket"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: filePath, type }),
  })
    .then((r) => r.json().catch(() => ({})))
    .then((d: { ticket?: string; error?: string }) => {
      if (!d.ticket) throw new Error(d.error ?? `HTTP ticket issue failed`);
      return d.ticket;
    });
}

/** 构造短时效票据 GET URL（路径不进 URL）：供 <img>/<video>/EventSource 等只能 GET 的消费者。 */
export async function buildTicketUrl(
  filePath: string,
  type: FileTicketType,
  params: Record<string, string | number | undefined> = {},
): Promise<string> {
  const ticket = await resolveFileTicket(filePath, type);
  const searchParams = new URLSearchParams({ type });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return apiUrl(`/api/files/_t/${encodeURIComponent(ticket)}?${searchParams.toString()}`);
}

/** fetch 型文件请求（list/read/meta/preview/download）：路径走 body。 */
export function fetchFileGet(
  filePath: string,
  type: FileGetType,
  sessionId?: string | null,
): Promise<Response> {
  return fetch(apiUrl("/api/files/get"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: filePath, type, sessionId: sessionId || undefined }),
  });
}

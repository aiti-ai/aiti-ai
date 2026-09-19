import { apiUrl } from "@/lib/base-path";

// —— Unified channel that keeps file paths out of URLs ——
//
// Design contract: file paths must never appear in a URL (path segment or query).
// Any request carrying a path goes through a POST body:
//   - fetch-style requests (list/read/meta/preview/download) → POST /api/files/get { path, type, sessionId }
//   - consumers limited to GET URLs (<img>/<video>/EventSource/<iframe>) → first POST /api/files/ticket
//     { path, type } to exchange for a short-lived ticket (5-minute TTL, random and irreversible),
//     then GET /api/files/_t/<ticket>?type=…
//
// No permanent stable path tokens: once such a token leaks into a tunnel/proxy access
// log the path is exposed forever; short tickets expire, and an EventSource reconnect
// simply exchanges for a fresh one.

export type FileGetType = "list" | "read" | "meta" | "preview" | "download";
export type FileTicketType = "read" | "download" | "preview" | "watch" | "list" | "meta";

/** Exchanges for a short-lived ticket (reusable within its TTL). Throws on failure. */
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

/** Builds a GET URL from a short-lived ticket (path never in the URL): for <img>/<video>/EventSource and other GET-only consumers. */
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

/** fetch-style file request (list/read/meta/preview/download): the path goes in the body. Only non-sensitive pagination/format params travel as URL query; the path never enters a URL. */
export function fetchFileGet(
  filePath: string,
  type: FileGetType,
  sessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): Promise<Response> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return fetch(apiUrl(`/api/files/get${qs ? `?${qs}` : ""}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: filePath, type, sessionId: sessionId || undefined }),
  });
}

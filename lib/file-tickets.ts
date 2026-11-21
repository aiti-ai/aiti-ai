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

/** Exchanges for a short-lived ticket (reusable within its TTL). Revision ref/gitDir ride the POST body and are stored in the ticket payload (same channel as path — never in a URL/access log). Throws on failure. */
export function resolveFileTicket(filePath: string, type: FileTicketType, params: Record<string, string | number | undefined> = {}): Promise<string> {
  const body: Record<string, unknown> = { path: filePath, type };
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && (k === "ref" || k === "gitDir")) body[k] = String(v);
  }
  return fetch(apiUrl("/api/files/ticket"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
  // ref/gitDir must ride the POST body too: the ticket issuer stat-checks the path and
  // would 404 a deleted file before the revision branch of the GET handler ever runs.
  // They are stored in the ticket payload; the GET URL only carries type + benign params.
  const ticket = await resolveFileTicket(filePath, type, params);
  const searchParams = new URLSearchParams({ type });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && key !== "ref" && key !== "gitDir") searchParams.set(key, String(value));
  }
  return apiUrl(`/api/files/_t/${encodeURIComponent(ticket)}?${searchParams.toString()}`);
}

/** fetch-style file request (list/read/meta/preview/download): the path AND revision tuple (ref/gitDir) go in the body; only benign pagination/format params travel as URL query. */
export function fetchFileGet(
  filePath: string,
  type: FileGetType,
  sessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): Promise<Response> {
  const search = new URLSearchParams();
  const body: Record<string, unknown> = { path: filePath, type };
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (key === "ref" || key === "gitDir") body[key] = String(value);
    else search.set(key, String(value));
  }
  if (sessionId) body.sessionId = sessionId;
  const qs = search.toString();
  return fetch(apiUrl(`/api/files/get${qs ? `?${qs}` : ""}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

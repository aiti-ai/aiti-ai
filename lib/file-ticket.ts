import { randomBytes } from "crypto";

/**
 * Short-lived file download tickets (reusable, 5-minute TTL).
 *
 * Motivation: GET /api/files/<path>?type=download leaks local absolute paths into
 * tunnel/proxy access logs. Two-step download: POST /api/files/ticket { path }
 * exchanges for a random ticket → GET /api/files/_t/<ticket> streams the download.
 * Also serves /viewer window opening: POST { path, kind, cwd } issues a view ticket
 * → the child window fetches and redeems the ticket via opener once loaded.
 * Redeemable repeatedly within the TTL (friendly to external downloaders / resume
 * retries); void immediately on expiry; not bound to cookies (downloaders carry no
 * session). No timers: expired entries are lazily swept on issue/redeem.
 */
export interface FileTicket {
  path: string;
  /** Purpose: "download" (streaming download) | "view" (target opened by /viewer, with kind/cwd attached) */
  type: string;
  /** Viewer target kind (present only when type="view"): "file" | "folder" */
  kind?: string;
  /** Viewer working directory (present only when type="view") */
  cwd?: string;
  exp: number;
}

const TICKET_TTL_MS = 5 * 60 * 1000;
const tickets = new Map<string, FileTicket>();

function sweep(now: number): void {
  for (const [k, v] of tickets) if (v.exp <= now) tickets.delete(k);
}

export function issueFileTicket(path: string, type = "download", extra?: { kind?: string; cwd?: string }): { ticket: string; expiresIn: number } {
  const now = Date.now();
  sweep(now);
  const ticket = randomBytes(24).toString("base64url");
  tickets.set(ticket, { path, type, ...(extra?.kind ? { kind: extra.kind } : {}), ...(extra?.cwd ? { cwd: extra.cwd } : {}), exp: now + TICKET_TTL_MS });
  return { ticket, expiresIn: Math.round(TICKET_TTL_MS / 1000) };
}

export function redeemFileTicket(ticket: string | null | undefined): FileTicket | null {
  const now = Date.now();
  sweep(now);
  if (!ticket) return null;
  return tickets.get(ticket) ?? null;
}

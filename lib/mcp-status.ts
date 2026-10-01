import type { McpScope, McpServerInfo, McpServerStatus } from "./api-types";

// The last known connection state of each `mcp.json` entry, for the status
// dots of Settings › MCP (ADR 0006). GET /api/mcp reads files only and never
// connects, so what a connection did comes from here: a Test writes its
// result (`lib/mcp-test.ts`), and session hosts will write theirs. Route
// handlers are bundled separately and hot reload re-evaluates modules, so the
// map lives on globalThis; a server restart forgets every state, which only
// shows the servers as untested again.
//
// A record is keyed by the file and the name, never the name alone: a project
// entry may share its name with a global one, and two projects each have
// their own `.pi/mcp.json`. It holds the `configKey` (`mcpConfigKey()`, an
// HMAC of the entry's canonical JSON) of the entry it was recorded for, and is
// shown only while the file still holds that entry: an edited entry reads as
// untested instead of carrying the old entry's result.

/** Records held at once; the least recently written goes first. */
export const MCP_STATUS_MAX_RECORDS = 500;

const STORE_KEY: symbol = Symbol.for("pi-web:mcp-status");

/** Which entry a status is about: its scope, the file that defines it (as the panel names it), and its name. */
export interface McpStatusEntry {
  scope: McpScope;
  sourcePath: string;
  name: string;
}

interface StatusRecord {
  configKey: string;
  status: McpServerStatus;
}

function records(): Map<string, StatusRecord> {
  const store = globalThis as Record<symbol, Map<string, StatusRecord> | undefined>;
  return (store[STORE_KEY] ??= new Map());
}

/** `scope\0sourcePath\0name`: a NUL appears in none of them, so the key cannot be ambiguous. */
export function mcpStatusKey(entry: McpStatusEntry): string {
  return `${entry.scope}\0${entry.sourcePath}\0${entry.name}`;
}

/** Records the last known state of `entry` as it read `configKey`; a later record for the entry replaces it. */
export function recordMcpStatus(entry: McpStatusEntry, configKey: string, status: McpServerStatus): void {
  const map = records();
  const key = mcpStatusKey(entry);
  // Written again goes last, so eviction drops the entry written longest ago.
  map.delete(key);
  map.set(key, { configKey, status });
  while (map.size > MCP_STATUS_MAX_RECORDS) {
    const oldest = map.keys().next().value as string;
    map.delete(oldest);
  }
}

/**
 * The status recorded for the entry as the file holds it now, or undefined.
 * A record made for other content is stale: it is dropped, so a changed entry
 * reads as untested, and still does once it is changed back.
 */
export function readMcpStatus(entry: McpStatusEntry, configKey: string): McpServerStatus | undefined {
  const map = records();
  const key = mcpStatusKey(entry);
  const record = map.get(key);
  if (!record) return undefined;
  if (record.configKey === configKey) return record.status;
  map.delete(key);
  return undefined;
}

/**
 * The listing with each server's current status attached. Records of a file
 * that was read (`readFiles`, the files listed without a problem that hides
 * their servers) whose name the file no longer defines are dropped, which
 * keeps the map to what the files hold.
 */
export function withMcpStatuses(
  servers: McpServerInfo[],
  readFiles: readonly { scope: McpScope; path: string }[],
): McpServerInfo[] {
  const map = records();
  const listed = new Set(servers.map(mcpStatusKey));
  const read = new Set(readFiles.map((file) => `${file.scope}\0${file.path}\0`));
  for (const key of [...map.keys()]) {
    const fileKey = key.slice(0, key.lastIndexOf("\0") + 1);
    if (read.has(fileKey) && !listed.has(key)) map.delete(key);
  }
  return servers.map((server) => {
    const status = readMcpStatus(server, server.configKey);
    return status ? { ...server, status } : server;
  });
}

/** How many records are held; for tests. */
export function mcpStatusCount(): number {
  return records().size;
}

/** Forgets every record; for tests. */
export function clearMcpStatuses(): void {
  records().clear();
}

/**
 * Zero-value session state file for the pi-web management UI (M3) and for
 * post-mortem attribution: which aliases are mounted in which session, which
 * landing mode is active. It never contains a value, a placeholder mapping or
 * a key — safe to inspect.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./crypto.ts";

export interface VaultSessionRecord {
  cwd: string;
  landing: string;
  /** Display name (explicit /name, or a redacted first-message excerpt). */
  name?: string;
  /** Session JSONL file; the web UI opens it via the pi-web:open-session event. */
  file?: string;
  /** Aliases mounted in this session (names only). */
  mounted: string[];
  /** Owning pi process (same host); used by the management UI to hide dead sessions. */
  pid?: number;
  updatedAt: string;
}

/** Session records older than this are pruned when they have no owning PID. */
export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SESSION_RECORDS = 50;

export interface VaultSessionStateFile {
  version: 1;
  sessions: Record<string, VaultSessionRecord>;
}

export const EMPTY_SESSION_STATE: VaultSessionStateFile = { version: 1, sessions: {} };

export function readSessionState(path: string): VaultSessionStateFile {
  if (!existsSync(path)) return { version: 1, sessions: {} };
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as VaultSessionStateFile;
    if (!doc || doc.version !== 1 || typeof doc.sessions !== "object") return { version: 1, sessions: {} };
    return doc;
  } catch {
    return { version: 1, sessions: {} };
  }
}

/** Drop stale pid-less records and enforce the size cap. */
function prune(file: VaultSessionStateFile, now = Date.now()): VaultSessionStateFile {
  const entries = Object.entries(file.sessions)
    .filter(([, rec]) => {
      if (rec.pid) return true; // a live/dead process is judged by the reader
      const at = Date.parse(rec.updatedAt);
      return Number.isFinite(at) ? now - at <= SESSION_RETENTION_MS : false;
    })
    .sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
    .slice(0, MAX_SESSION_RECORDS);
  return { version: 1, sessions: Object.fromEntries(entries) };
}

export function writeSessionRecord(path: string, sessionId: string, record: Omit<VaultSessionRecord, "updatedAt">): void {
  const file = readSessionState(path);
  file.sessions[sessionId || "unknown"] = { ...record, updatedAt: new Date().toISOString() };
  // bounded by age (pid-less records) and by the 50 most recently updated records
  writeFileAtomic(path, JSON.stringify(prune(file), null, 2) + "\n");
}

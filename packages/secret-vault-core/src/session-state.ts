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
  /** Aliases mounted in this session (names only). */
  mounted: string[];
  updatedAt: string;
}

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

export function writeSessionRecord(path: string, sessionId: string, record: Omit<VaultSessionRecord, "updatedAt">): void {
  const file = readSessionState(path);
  file.sessions[sessionId || "unknown"] = { ...record, updatedAt: new Date().toISOString() };
  // keep the file bounded: the 50 most recently updated sessions
  const entries = Object.entries(file.sessions).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt)).slice(0, 50);
  writeFileAtomic(path, JSON.stringify({ version: 1, sessions: Object.fromEntries(entries) }, null, 2) + "\n");
}

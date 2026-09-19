import { randomUUID } from "crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";

/**
 * Durable store for queued (steer / follow-up) messages.
 *
 * pi keeps its steering/follow-up queues purely in memory. If the server dies
 * before a queued message is processed, that message would be lost. This module
 * mirrors the queue to a per-session sidecar file (`<session>.jsonl.queue.json`)
 * so pi-web can offer the user a manual recovery list after a restart.
 *
 * Design rules (see AGENTS.md / recovery UX):
 * - The sidecar only SAVES entries — it never auto-delivers them.
 * - After a restart every entry in the sidecar becomes a "pending recovery"
 *   item; the user decides to re-queue, discard, or export each one.
 */

export type QueueKind = "steer" | "followUp" | "composer";

/**
 * "composer" is not a queued message: it is input content (text + images) written
 * straight to the trash when the user clears the composer via its ✕ button. Such
 * entries never appear in the live queue and never go through enqueue/steer/
 * followUp; on recovery they are restored into the composer for continued editing
 * (see rpc-manager restore_trash_item).
 */

export interface QueueImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface QueueEntry {
  id: string;
  kind: QueueKind;
  text: string;
  images?: QueueImage[];
  queuedAt: number;
}

/** Client-supplied shape for import_queue (ids are assigned server-side). */
export interface QueueEntryInput {
  kind: QueueKind;
  text: string;
  images?: QueueImage[];
}

/** Public (non-image) view of an entry awaiting the user's recovery decision. */
export interface PendingRecoveryItem {
  id: string;
  kind: QueueKind;
  text: string;
  hasImages: boolean;
  queuedAt: number;
  /** Client-side synthetic entry for an unsent input draft (crash recovery). */
  origin?: "draft";
}

/** Public (non-image) view of a soft-deleted entry sitting in the trash. */
export interface QueueTrashItem {
  id: string;
  kind: QueueKind;
  text: string;
  hasImages: boolean;
  queuedAt: number;
}

interface QueueFile {
  version: 2;
  entries: QueueEntry[];
  /** Soft-deleted entries (recoverable from the trash bin). */
  trash: QueueEntry[];
}

export function queueSidecarPath(sessionFile: string): string {
  return `${sessionFile}.queue.json`;
}

export function createQueueEntry(
  kind: QueueKind,
  text: string,
  images?: QueueImage[],
): QueueEntry {
  return {
    id: randomUUID(),
    kind,
    text,
    ...(images && images.length > 0 ? { images } : {}),
    queuedAt: Date.now(),
  };
}

function isValidEntry(e: unknown): e is QueueEntry {
  return Boolean(e) &&
    ((e as QueueEntry).kind === "steer" || (e as QueueEntry).kind === "followUp" || (e as QueueEntry).kind === "composer") &&
    typeof (e as QueueEntry).text === "string";
}

/**
 * Load the full sidecar: live/recovery entries plus the trash. v1 sidecars
 * (no trash section) migrate transparently — trash starts empty and the file
 * is rewritten as v2 on the next save.
 */
export function loadQueueFile(sessionFile: string): { entries: QueueEntry[]; trash: QueueEntry[] } {
  const path = queueSidecarPath(sessionFile);
  if (!existsSync(path)) return { entries: [], trash: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<QueueFile> & { version?: 1 | 2 };
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [], trash: [] };
    const entries = parsed.entries.filter(isValidEntry);
    if (parsed.version !== 2) {
      // v1 sidecar: no trash section yet.
      return { entries, trash: [] };
    }
    const trash = Array.isArray(parsed.trash) ? parsed.trash.filter(isValidEntry) : [];
    return { entries, trash };
  } catch {
    // Corrupt sidecar — treat as empty rather than blocking the session.
    return { entries: [], trash: [] };
  }
}

/** Live/recovery entries only (used by the lightweight queue-recovery read). */
export function loadQueue(sessionFile: string): QueueEntry[] {
  return loadQueueFile(sessionFile).entries;
}

/** Atomically replace the sidecar (tmp file + rename). */
export function saveQueue(sessionFile: string, entries: QueueEntry[], trash: QueueEntry[] = []): void {
  if (!sessionFile) return;
  const path = queueSidecarPath(sessionFile);
  const payload: QueueFile = { version: 2, entries, trash };
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, JSON.stringify(payload), "utf8");
    renameSync(tmp, path);
  } catch (error) {
    // Any failure must not crash the session; best-effort cleanup of tmp.
    try {
      rmSync(tmp, { force: true });
    } catch { /* ignore */ }
    console.error(
      `[pi-web] failed to persist queue sidecar ${path}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function removeQueue(sessionFile: string): void {
  try {
    rmSync(queueSidecarPath(sessionFile), { force: true });
  } catch { /* ignore */ }
}

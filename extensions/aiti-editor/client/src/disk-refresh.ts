/**
 * aiti-editor · disk-change auto-refresh decision layer (pure functions, zero window/ctx deps).
 *
 * Plan: docs/aiti-editor-preview-watch-refresh-plan.md §3.1
 *
 * Why a standalone module: the ed-watch frame used to be consumed only by media files
 * (isMediaFile hardcoded in the watch effect). Generalizing watch to all file types widens
 * the decision surface (own-save echo suppression / throttle / per-view dispatch), so the
 * decisions live here where node --test can pin them down.
 */

/** Signature of the file on disk as seen by an ed-watch frame or a /stat response. */
export interface DiskSig { mtimeMs: number; size: number }

/**
 * Echo suppression: does this frame signature match the last disk state we already know?
 * Used to ignore frames caused by our own save (the /save response reports the new
 * mtimeMs+size, which we record in diskSigRef). mtime tolerance ±2ms absorbs the
 * float→floor conversion done server-side (`Math.floor(mtimeMs)` in the watch frame).
 */
export function sameDiskSig(a: DiskSig | null | undefined, b: DiskSig | null | undefined): boolean {
  if (!a || !b) return false;
  if (typeof a.mtimeMs !== "number" || typeof b.mtimeMs !== "number") return false;
  return Math.abs(a.mtimeMs - b.mtimeMs) <= 2 && a.size === b.size;
}

/** Which kind of view is currently shown for this file. */
export type ViewKind = "binary" | "text";

/**
 * Should an incoming disk-change frame trigger an automatic reload?
 * - binary views (image / video / audio / pdf / archive): always — they are read-only,
 *   there is no unsaved buffer to lose.
 * - text views (edit / split / preview): only when clean. With unsaved edits we never
 *   silently overwrite — the caller shows the existing "disk modified" bar instead
 *   (three-way merge / load from disk / keep local).
 */
export function shouldAutoReload(kind: ViewKind, dirty: boolean): boolean {
  if (kind === "binary") return true;
  return !dirty;
}

/**
 * Throttle gate for automatic text reloads: agents streaming into a file can produce a
 * frame every 300ms (server debounce); reloading + re-rendering Monaco that often is
 * wasteful, so automatic reloads keep a minimum interval. Skipped frames still update
 * the known signature (the next frame or the manual Reload menu item catches up).
 */
export function throttleOk(lastReloadAt: number, now: number, minIntervalMs = 1000): boolean {
  return now - lastReloadAt >= minIntervalMs;
}

/**
 * Parse an ed-watch frame into a DiskSig. Returns null for malformed frames
 * (missing/NaN fields) and for "gone" frames — the caller handles gone separately.
 */
export function sigOfFrame(frame: { mtimeMs?: unknown; size?: unknown } | null | undefined): DiskSig | null {
  if (!frame) return null;
  const mtimeMs = frame.mtimeMs;
  const size = frame.size;
  if (typeof mtimeMs !== "number" || !isFinite(mtimeMs)) return null;
  if (typeof size !== "number" || !isFinite(size) || size < 0) return null;
  return { mtimeMs, size };
}

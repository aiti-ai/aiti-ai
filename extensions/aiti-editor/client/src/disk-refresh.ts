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
 * Cache-busted media URL for a binary preview (image / video / audio / pdf).
 *
 * The bust rides as a QUERY parameter: ticketed media URLs carry no query string of
 * their own (`…/t/<ticket>/file`), so a bare `&v=` would glue onto the endpoint path
 * (`…/file&v=1` → 404). That 404 used to feed the viewer's ticket-recovery retry,
 * which re-issues a ticket on every error → an endless reload loop in the preview.
 */
export function mediaUrlWithBust(base: string, bust: number): string {
  if (!base || !(bust > 0)) return base;
  return base + (base.includes("?") ? "&" : "?") + "v=" + bust;
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

// ── Coalescing budgets (plan §3.5) ────────────────────────────────────────────────
// Auto-reload used to be a dropping throttle: a suppressed final frame was recorded as
// "known" and the view stayed stale until the next write. Callers now feed every frame into
// a coalescer (./coalesce.ts): quiet-period debounce + max-wait ceiling + trailing guarantee.
export const DISK_RELOAD_QUIET_MS = 350;
export const DISK_RELOAD_MAX_MS = 1500;
export const PREVIEW_APPLY_QUIET_MS = 250;
export const PREVIEW_APPLY_MAX_MS = 1200;
/** Above this size a document render is expensive enough to deserve a longer quiet window. */
export const LARGE_DOC_BYTES = 256 * 1024;

/**
 * Preview coalescing budget for a document of `bytes` characters.
 * Large documents stretch both windows (rendering scales with size); the max ceiling keeps
 * a long agent stream visible at least every ~1.8s.
 */
export function previewBudget(bytes: number): { quietMs: number; maxMs: number } {
  const large = (bytes || 0) > LARGE_DOC_BYTES;
  return large
    ? { quietMs: PREVIEW_APPLY_QUIET_MS * 2, maxMs: Math.round(PREVIEW_APPLY_MAX_MS * 1.5) }
    : { quietMs: PREVIEW_APPLY_QUIET_MS, maxMs: PREVIEW_APPLY_MAX_MS };
}

// ── Minimal text edit (plan §3.3) ─────────────────────────────────────────────────
/** A single contiguous replacement, offsets in UTF-16 code units (Monaco model offsets). */
export interface TextEdit { start: number; end: number; text: string }

const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * Common-prefix/suffix diff: the smallest single edit that turns `oldText` into `newText`.
 * Returns null when the texts are identical (caller skips the edit entirely — no undo entry).
 * Surrogate pairs are never split (Monaco positions would break on a half emoji).
 */
export function diffRange(oldText: string, newText: string): TextEdit | null {
  const a = String(oldText == null ? "" : oldText);
  const b = String(newText == null ? "" : newText);
  if (a === b) return null;
  const aLen = a.length, bLen = b.length;
  const max = Math.min(aLen, bLen);
  let prefix = 0;
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix
    && a.charCodeAt(aLen - 1 - suffix) === b.charCodeAt(bLen - 1 - suffix)) suffix++;
  if (prefix > 0 && isLowSurrogate(b.charCodeAt(prefix))) prefix--;
  if (suffix > 0 && isLowSurrogate(b.charCodeAt(bLen - suffix))) suffix--;
  const start = prefix;
  const end = Math.max(prefix, aLen - suffix);
  return { start, end, text: b.slice(start, bLen - suffix) };
}

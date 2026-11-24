/**
 * aiti-editor · size policy (single source of truth for server + client).
 *
 * Why a shared module: the open decision has to be identical on both ends —
 * the client must not ask for content the server is going to refuse, and the
 * server must still refuse when an old client asks anyway. Keep this file free
 * of node/browser imports so it can be bundled into the client by vite and
 * loaded directly by the extension server.
 *
 * The values are user-editable (extman → aiti-editor → settings); the server
 * reads them per request from `editor-prefs.json` so changes apply on the next
 * file open without reloading the extension.
 *
 * Ladder (defaults):
 *   <= 1MB   edit      Monaco, editable, cache + preview enabled
 *   <= 2MB   readonly  Monaco read-only, no cache/preview/language workers
 *   <= 16MB  info      info card by default; "show part (read-only)" or explicit editor
 *   >  16MB  viewer    info card only; chunked plain-text viewer, never Monaco
 *   force open may bypass the 16MB ceiling up to forceMaxMB (64MB) with explicit consent.
 */

export interface EditorLimits {
  /** Editable ceiling; above this files open read-only. */
  readonlyMB: number;
  /** Above this the info card (no content loaded) is the default view. */
  infoMB: number;
  /** Monaco ceiling (read-only). Above this: chunked viewer only. */
  monacoMB: number;
  /** Hard ceiling for the explicit "I know the risk" force-open. */
  forceMaxMB: number;
  /** Offer the force-open button at all. */
  allowForceOpen: boolean;
  /** Edit cache ceiling (only editable files use the cache). */
  cacheKB: number;
  /** Above this the cache uses full content instead of diff-match-patch. */
  cacheDiffKB: number;
  /** Markdown/HTML preview ceiling. */
  previewKB: number;
  /** Language-service providers (outline/folding/diagnostics) ceiling. */
  providerMB: number;
}

export const DEFAULT_LIMITS: EditorLimits = {
  readonlyMB: 1,
  infoMB: 2,
  monacoMB: 16,
  forceMaxMB: 64,
  allowForceOpen: true,
  cacheKB: 1024,
  cacheDiffKB: 512,
  previewKB: 1024,
  providerMB: 2,
};

const clampNum = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

/**
 * Coerce arbitrary user input (JSON file / API body) into a safe, ordered limits object.
 * Ordering invariants: readonly <= info <= monaco <= forceMax; cacheDiff <= cache.
 */
export function normalizeLimits(raw: unknown): EditorLimits {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_LIMITS;
  const readonlyMB = clampNum(r.readonlyMB, d.readonlyMB, 0.05, 256);
  const infoMB = Math.max(readonlyMB, clampNum(r.infoMB, d.infoMB, 0.05, 512));
  const monacoMB = Math.max(infoMB, clampNum(r.monacoMB, d.monacoMB, 0.05, 1024));
  const forceMaxMB = Math.max(monacoMB, clampNum(r.forceMaxMB, d.forceMaxMB, 0.05, 4096));
  const cacheKB = clampNum(r.cacheKB, d.cacheKB, 8, 16 * 1024);
  const cacheDiffKB = Math.min(cacheKB, clampNum(r.cacheDiffKB, d.cacheDiffKB, 8, 16 * 1024));
  const previewKB = clampNum(r.previewKB, d.previewKB, 8, 16 * 1024);
  const providerMB = clampNum(r.providerMB, d.providerMB, 0.05, 256);
  return {
    readonlyMB,
    infoMB,
    monacoMB,
    forceMaxMB,
    // Accept real booleans plus the usual JSON/UI spellings ("false"/0); default on.
    allowForceOpen: !(r.allowForceOpen === false || r.allowForceOpen === 0 || r.allowForceOpen === "false" || r.allowForceOpen === "0"),
    cacheKB,
    cacheDiffKB,
    previewKB,
    providerMB,
  };
}

const MB = 1024 * 1024;
const KB = 1024;

export interface LimitBytes {
  readonlyBytes: number;
  infoBytes: number;
  monacoBytes: number;
  forceMaxBytes: number;
  cacheBytes: number;
  cacheDiffBytes: number;
  previewBytes: number;
  providerBytes: number;
}

export function limitBytes(l: EditorLimits): LimitBytes {
  return {
    readonlyBytes: Math.round(l.readonlyMB * MB),
    infoBytes: Math.round(l.infoMB * MB),
    monacoBytes: Math.round(l.monacoMB * MB),
    forceMaxBytes: Math.round(l.forceMaxMB * MB),
    cacheBytes: Math.round(l.cacheKB * KB),
    cacheDiffBytes: Math.round(l.cacheDiffKB * KB),
    previewBytes: Math.round(l.previewKB * KB),
    providerBytes: Math.round(l.providerMB * MB),
  };
}

export type OpenMode = "edit" | "readonly" | "info" | "viewer";

/** Open mode from file size (kind-independent; binary files never reach this). */
export function decideOpenModeWith(l: EditorLimits, size: number): OpenMode {
  const b = limitBytes(l);
  const n = Number.isFinite(size) && size > 0 ? size : 0;
  if (n <= b.readonlyBytes) return "edit";
  if (n <= b.infoBytes) return "readonly";
  if (n <= b.monacoBytes) return "info";
  return "viewer";
}

/** Whether the explicit "open in editor (read-only)" escape hatch may be offered. */
export function canOpenInEditorWith(l: EditorLimits, size: number): boolean {
  return Number.isFinite(size) && size > 0 && size <= limitBytes(l).monacoBytes;
}

/** Whether "I know the risk, open anyway" may be offered (beyond the Monaco ceiling). */
export function canForceOpenWith(l: EditorLimits, size: number): boolean {
  return !!l.allowForceOpen && Number.isFinite(size) && size > 0 && size <= limitBytes(l).forceMaxBytes;
}

/** Whether an info card (instead of loading content) is the default view. */
export function isDeferredMode(mode: OpenMode): boolean {
  return mode === "info" || mode === "viewer";
}

// ── default-derived constants (kept for call sites that have no user config at hand) ──
export const EDIT_READONLY_BYTES = limitBytes(DEFAULT_LIMITS).readonlyBytes;
export const LARGE_INFO_BYTES = limitBytes(DEFAULT_LIMITS).infoBytes;
export const MONACO_MAX_BYTES = limitBytes(DEFAULT_LIMITS).monacoBytes;
export const RAW_REJECT_BYTES = MONACO_MAX_BYTES;
export const CACHE_MAX_BYTES = limitBytes(DEFAULT_LIMITS).cacheBytes;
export const CACHE_DIFF_MAX_BYTES = limitBytes(DEFAULT_LIMITS).cacheDiffBytes;
export const PREVIEW_MAX_TEXT_BYTES = limitBytes(DEFAULT_LIMITS).previewBytes;
export const PROVIDER_MAX_BYTES = limitBytes(DEFAULT_LIMITS).providerBytes;
export const CSV_DECORATION_MAX_BYTES = 256 * 1024;
export const TEXT_WINDOW_CHUNK_BYTES = 512 * 1024;
export const WINDOW_PAGE_LINES = 2000;
export const CACHE_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const CACHE_TOTAL_BUDGET = 256 * 1024 * 1024;

/** Default-size helpers (backwards-compatible convenience). */
export function decideOpenMode(size: number): OpenMode {
  return decideOpenModeWith(DEFAULT_LIMITS, size);
}
export function canOpenInEditor(size: number): boolean {
  return canOpenInEditorWith(DEFAULT_LIMITS, size);
}

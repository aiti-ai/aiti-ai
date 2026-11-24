/**
 * aiti-editor · runtime size limits (client).
 *
 * The server is authoritative: `/stat` returns the effective limits (read from
 * `editor-prefs.json`, editable in extman), and we store them here so pure
 * providers (outline/folding/diagnostics, cache guards) use the same numbers
 * without threading the values through every call.
 */
import { DEFAULT_LIMITS, limitBytes, normalizeLimits, type EditorLimits, type LimitBytes } from "../../shared/limits";

let current: EditorLimits = DEFAULT_LIMITS;
let currentBytes: LimitBytes = limitBytes(DEFAULT_LIMITS);

export function setRuntimeLimits(raw: unknown): EditorLimits {
  current = normalizeLimits(raw);
  currentBytes = limitBytes(current);
  return current;
}

export function getRuntimeLimits(): EditorLimits {
  return current;
}

export function getRuntimeBytes(): LimitBytes {
  return currentBytes;
}

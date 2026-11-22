import { normalizeRawMessages } from "./normalize.ts";
import type { AgentMessage } from "./types.ts";

/**
 * Cursor-based pagination for external-backend sessions (zcode/cursor/… provider handles, bridge attach).
 *
 * The get_messages calls on these channels return a flat array of id-less messages (unlike the
 * SessionEntry tree of local pi sessions); historically the detail/context routes returned
 * everything in one shot — a session with thousands of entries produced a 1MB+ first-open payload,
 * and parsing/processing it on the frontend main thread turned into multi-second long tasks.
 *
 * This module adds the same pagination contract local sessions already have:
 *   - Synthesized stable entryIds: `ext-<i>` (i = the message's index in the full array; external
 *     sessions are append-only, so the prefix is stable and comparable across pages/requests).
 *   - `tail`: the first pull returns only the last N messages (default 50, clamped to 1000, same as local).
 *   - `before`: the oldest entryId (ext-i) the client already holds → returns the [i-tail, i) page
 *     (excluding `before` itself, matching the local excludeLeaf semantics, so prepending has no duplicates).
 *
 * The server still pulls everything from the handle and then slices — handle-side reads are
 * millisecond-scale (a 15MB session took ~300ms via direct sqlite reads in practice, <100ms when
 * warm); the bottleneck is transfer and frontend processing, not the read.
 */

export const EXTERNAL_ENTRY_ID_PREFIX = "ext-";

export function parseExternalEntryId(id: string | null | undefined): number | null {
  if (!id?.startsWith(EXTERNAL_ENTRY_ID_PREFIX)) return null;
  const n = Number(id.slice(EXTERNAL_ENTRY_ID_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function clampTailParam(raw: string | null | undefined, fallback = 50): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : fallback;
}

export interface ExternalPagedContext {
  messages: AgentMessage[];
  entryIds: string[];
  oldestEntryId: string | null;
  hasMore: boolean;
  totalCount: number;
}

export function buildExternalPagedContext(
  rawEntries: unknown[],
  opts: { tail?: number; before?: string | null } = {},
): ExternalPagedContext {
  const all = normalizeRawMessages(rawEntries);
  const tail = opts.tail && opts.tail > 0 ? Math.min(opts.tail, 1000) : all.length;
  const beforeIdx = parseExternalEntryId(opts.before);
  const end = beforeIdx !== null ? Math.min(beforeIdx, all.length) : all.length;
  const start = Math.max(0, end - tail);
  const messages = all.slice(start, end);
  const entryIds = messages.map((_, i) => `${EXTERNAL_ENTRY_ID_PREFIX}${start + i}`);
  return {
    messages,
    entryIds,
    oldestEntryId: entryIds[0] ?? null,
    hasMore: start > 0,
    totalCount: all.length,
  };
}

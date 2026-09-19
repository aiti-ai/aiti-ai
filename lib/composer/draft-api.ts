/**
 * Draft storage API registry (primitives after the composer contract consolidation).
 *
 * Design (plan A "keeper as sole owner"): the core no longer touches slots
 * directly (saveDraft/clearDraft/rekeyDraft are retired); it only declares
 * **intent**, and all slot read/write/clear/move happen inside the keeper state
 * machine's (draft-keeper extension client core.mjs) single sequential order —
 * this removes the earlier race window between the core's slot clearing and the
 * keeper's clear chain / promote move.
 *
 * The core accesses it via applyDraftIntent(). Deployment-order independent:
 * with an old keeper (no applyIntent) it falls back to v1 methods emulating the
 * same semantics.
 */
/** Persisted form of a draft image (base64 data, no previewUrl). */
export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface DraftSnapshot {
  value: string;
  images: ChatDraftImage[];
}

/** Draft intent from core → keeper (the sole write entry point). */
export type DraftIntent =
  /** A new session was promoted to a real session: the provisional draft is voided; subsequent
   *  input on provisionalKey is redirected by the keeper into the sessionId slot (removes the
   *  "leftover after message sent" race). */
  | { type: "sessionCreated"; provisionalKey: string; sessionId: string }
  /** Send failed/rejected: merge the submission back into the draft (submission first, original
   *  draft after); when the target is the current box it is written back into the box. */
  | { type: "rejected"; key: string; text: string; images?: ChatDraftImage[] };

export interface DraftApi {
  /** Read-only: fetch the draft for the given key. */
  getDraft(key: string): DraftSnapshot | null;
  /** Clear all draft slots of a session (session deletion; includes legacy per-tab leftovers). */
  clearAllDrafts(sessionId: string): void;
  /** Synchronously flush all pending drafts (before unload/hide). */
  flushAll(): void;
  /** Sole write entry point: core only declares intent; the keeper decides all slot operations. */
  applyIntent(intent: DraftIntent): void;
  // ---- deprecated v1 (legacy-keeper fallback only; new core does not call directly) ----
  saveDraft?(key: string, draft: DraftSnapshot): void;
  clearDraft?(key: string): void;
  rekeyDraft?(previousKey: string, nextKey: string, currentDraft?: DraftSnapshot): DraftSnapshot | null;
  restoreSubmission?(key: string, text: string, images?: { data: string; mimeType: string }[]): DraftSnapshot;
}

let api: DraftApi | null = null;

export function registerDraftApi(a: DraftApi | null): void {
  api = a;
}

export function getDraftApi(): DraftApi | null {
  return api;
}

/** Core-side sole write entry point: prefer the new primitives; with an old keeper (no applyIntent) fall back to v1 methods emulating the same semantics. */
export function applyDraftIntent(intent: DraftIntent): void {
  const a = api;
  if (!a) return;
  if (typeof a.applyIntent === "function") {
    a.applyIntent(intent);
    return;
  }
  // Old-keeper fallback: clearing the provisional slot is enough (the rekey move
  // has a read-slot race — prefer losing content over leaving leftovers)
  if (intent.type === "sessionCreated") {
    a.clearDraft?.(intent.provisionalKey);
  } else if (intent.type === "rejected") {
    a.restoreSubmission?.(intent.key, intent.text, intent.images);
  }
}

/**
 * Composer enhancement contract types (defork P1).
 *
 * Goal: turn the composer's extension deltas (draft persistence, queue UI, input
 * augmentation…) from "editing ChatInput in place" into "policy plugins over the
 * mechanism". This file holds types only; the registry and dispatch live in bus.ts.
 */

export interface ComposerSnapshot {
  value: string;
  /**
   * Persisted form of the attached images (base64 data, no previewUrl) — shared by
   * object reference and serialized only when persisting; no copy overhead on
   * high-frequency onChange.
   */
  images: { data: string; mimeType: string }[];
  /** Convenience field: images.length */
  imageCount: number;
  /** The box has text or images (including while the user is typing) */
  hasInput: boolean;
  /** true = the current value is a temporary prefill (e.g. "edit from here") and must not be saved as a draft (matches core suppressDraft) */
  suppress?: boolean;
}

/** Enhancer implemented on the extension side; core calls back at fixed points. All callbacks are synchronous; thrown errors are isolated. */
export interface ComposerEnhancement {
  id: string;
  /** Value changed (user input / programmatic write / clear). High frequency — throttling is the implementer's job. */
  onChange?(snapshot: ComposerSnapshot): void;
  /** draftKey switched (session switch / new-session promote rekey). undefined = no key (no-cwd empty state). */
  onKeyChange?(previousKey: string | undefined, nextKey: string | undefined): void;
  /** Last step before send (before clearing). May return replacement text (chained); returning void/undefined = pass the original text through. */
  onSubmit?(text: string, imageCount: number): { text: string } | void;
  /**
   * Called on input × clear (core invokes it before clearInput, with a snapshot of the
   * cleared content). Registered by the queue-keeper extension: it writes the content
   * straight to the recycle bin (trash_direct_add); if unregistered, clearing only
   * keeps an in-memory 5s undo. Implementers fetch the writer executor mounted by core
   * via getComposerTrashWriter() — the interface lives here (provided by the
   * extension), the mechanism lives in core (RPC).
   */
  onClearToTrash?(snapshot: ComposerSnapshot): void;
}

/** The controlled write entry point core provides to the enhancement flow (held via the bus; assembled by ChatInput). */
export interface ComposerWriter {
  snapshot(): ComposerSnapshot;
  /**
   * Programmatic value write: the React state write lands in the DOM via the existing
   * [value] DOM-sync effect, which goes through writeTextareaValue (native setter +
   * _valueTracker sync) — never bypass this path by writing textarea.value directly
   * (lesson from b30d131).
   */
  setValue(text: string): void;
}

/**
 * Recovery item provider (P2: the draft cluster etc. merge leftover input into the
 * recovery dialog; implementation in lib/composer/recovery.ts). items share the same
 * structure as server-side queue recovery items. id convention: a provider's items are
 * named with the `${providerId prefix}:…` (e.g. "ext:draft:…"); ChatWindow routes user
 * decisions (keep/discard) back to onResolve by prefix.
 */
export interface RecoveryItemsProvider {
  id: string;
  getItems(): unknown[];
  /** Subscribe to items changes (storage events etc.); returns an unsubscribe function. */
  subscribe?(cb: () => void): () => void;
  /** User decision on provider items: kept = keep (already applied by core, or applied by the caller itself), discarded = drop. */
  onResolve?(kept: string[], discarded: string[]): void;
}

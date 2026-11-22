/**
 * Queue panel contract (externalization P3; see the queue-cluster extension plan).
 *
 * Goal: move the ~900–1000-line queue enhancement UI inside ChatInput
 * (banner / row actions / trash / undo bar / import-export / notifications /
 * drag-and-drop) out of "editing ChatInput in place" into the queue-keeper
 * extension rendered via the queuePanel slot; core returns to "upstream-shaped
 * mechanism + thin integration" (fallback banner + single-line ExtSlot
 * integration + edit-intent check).
 *
 * Same spirit as the existing composer contract (value observation / value
 * write / restore items): core keeps the mechanism (rpc-manager queue
 * persistence and all 12 RPCs stay in core), the extension keeps the policy
 * (UI consumes action primitives).
 *
 * Direction:
 *   core → ext   QueuePanelProps (live/trash views + action primitives) passed in via the slot
 *   ext  → core  QueuePanelController (expand: force-open the panel after restore/import parsing)
 *
 * Zero data migration: sidecar/trash live entirely in core (rpc-manager); the
 * extension has no storage of its own — disabling the extension just falls
 * back to the banner, with no data loss in any state.
 */
import type {
  QueueEntry,
  QueueEntryInput,
  QueueImage,
  QueueKind,
  QueueTrashItem,
} from "../queue-store.ts";
import type { QueueExportMeta } from "../queue-export.ts";

export type { QueueExportMeta };
export type {
  QueueEntry,
  QueueEntryInput,
  QueueImage,
  QueueKind,
  QueueTrashItem,
};

/** Row view (core projects it from queueMirror, stripping image base64 — the extension fetches images via recallOne when needed). */
export interface QueueEntryView {
  id: string;
  kind: QueueKind;
  text: string;
  hasImages: boolean;
  /** Forward-compat: the queue path does not support file attachments yet
   *  (steer/followUp take images only), always false; once files can be
   *  queued the extension's row icon lights up automatically. */
  hasFiles?: boolean;
  queuedAt: number;
  index: number;
}

/** Live queue view (a projection shaped like core's queuedMessages). */
export interface QueueLiveView {
  steering: QueueEntryView[];
  followUp: QueueEntryView[];
}

/** Queue action primitives callable from the extension (core forwards all of them to existing RPC handlers; the core fallback works without them when no extension is present). */
export interface QueuePanelActions {
  /** Move within the queue (clear + re-enqueue). */
  move(kind: QueueKind, from: number, to: number): Promise<boolean>;
  /** Convert an entry's kind (steer ↔ followUp). */
  convert(kind: QueueKind, index: number, target: QueueKind): Promise<boolean>;
  /** Recall one entry into the composer (core also sets edit-intent); returns the text for the extension to display. */
  recallOne(kind: QueueKind, index: number): Promise<{ text: string } | null>;
  /** Put a recalled, edited entry back at its original position. */
  requeueAt(kind: QueueKind, index: number, text: string, images?: QueueImage[]): Promise<boolean>;
  /** Remove one entry (soft-delete → trash; permanent skips trash). Returns the removed entry view (for undo). */
  remove(kind: QueueKind, index: number, opts?: { permanent?: boolean }): Promise<QueueTrashItem | null>;
  /** Restore from trash (optional index puts it back at that position within its kind). */
  restore(id: string, index?: number): Promise<boolean>;
  /** Restore from trash into the composer (only kind="composer" composer-cleared entries; editing continues after refill). */
  restoreToComposer(id: string): Promise<boolean>;
  /** Permanently delete trash entries (omit ids = empty the whole trash). */
  purge(ids?: string[]): Promise<boolean>;
  /** Recall all (clear the live queue, merge text into the composer). */
  recallAll(): void;
  /** Send the queue head as a steer (the extension is responsible for afterwards removing the head via remove, permanent). Entries with images send their images along.
   *  Optional on purpose: presence *is* the steer capability. Core omits it when the session has no mid-run steer surface (backend declares steer:false, or the
   *  agent isn't running) — the extension must then hide every "steer this entry" affordance instead of calling through: the entry gets removed but never
   *  delivered, i.e. silent input loss. */
  steerSend?(text: string, images?: QueueImage[]): void;
  /** Export (full live + recovery data). */
  exportAll(): Promise<{ live: QueueEntry[]; recovery: QueueEntry[] } | null>;
  /** Trigger a browser download (md/json; implemented in core, single source). */
  downloadExport(entries: QueueEntry[], meta: QueueExportMeta, format: "md" | "json"): void;
  /** Parse imported file text (core pure function; invalid entries are skipped, a broken file returns an empty array). */
  parseImport(content: string): QueueEntryInput[];
  /** Import entries (ids assigned server-side; returns the enqueued count). */
  importEntries(entries: QueueEntryInput[]): Promise<number | null>;
  /** Stage imported entries as pending recovery (opens the recovery dialog). */
  stageImport(entries: QueueEntryInput[]): Promise<number | null>;
}

/** Extra props of the queuePanel slot (core → ext one-way data + action primitives). */
export interface QueuePanelProps {
  /** Live queue projection (text view; image info is only the hasImages flag). */
  live: QueueLiveView;
  /** Trash entries (soft-deleted; restorable). */
  trash: QueueTrashItem[] | null;
  queueCount: number;
  trashCount: number;
  /** All queue action primitives. */
  actions: QueuePanelActions;
  /** Small-screen adaptation (same source as core's useIsMobile). */
  isMobile?: boolean;
  /** Coarse-pointer (touch) detection — the extension has no useIsCoarsePointer hook, core passes it in (HTML5 drag vs touch drag). */
  isCoarsePointer?: boolean;
  /** steer readonly (derived from backend capabilities, not session-id shape):
   *  entries were already injected into the backend process's steer queue
   *  (auto-consumed between tool calls) and the protocol does not support
   *  recall/move/convert — management ops on these entries always raise
   *  AgentCommandError. The extension should hide row-level actions for steer
   *  entries and display only; the core fallback banner is display-only to begin
   *  with and unaffected. Local pi sessions and pi-protocol backends (which
   *  reinject their remote queue) stay manageable. */
  steerReadonly?: boolean;
}

/** ext → core reverse channel (registered on the bus; called by core's recovery flow etc., no-op when nothing has taken over). */
export interface QueuePanelController {
  /** Force-open the queue panel after restore/import parsing. */
  expand(): void;
  /** Cross-component notice (optional: not registered when the extension renders itself; the core fallback banner has no collapsed state and needs none). */
  notice?(text: string, ok: boolean): void;
}

let controller: QueuePanelController | null = null;

/** Register the queue panel controller; returns a disposer that removes exactly this registration. Pass null = unregister. */
export function registerQueuePanelController(c: QueuePanelController | null): () => void {
  controller = c;
  return () => {
    if (controller === c) controller = null;
  };
}

/** Synchronously read the current controller (called by core's recovery flow; null when nothing has taken over). */
export function getQueuePanelController(): QueuePanelController | null {
  return controller;
}

/** Test helper: clear state (do not call from production code). */
export function resetQueuePanelControllerForTests(): void {
  controller = null;
}

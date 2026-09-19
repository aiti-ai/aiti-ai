/**
 * Composer enhancement bus (contract types alongside in lib/composer/types.ts).
 *
 * - Registry + fixed-point dispatch. Dispatch is synchronous, in registration order;
 *   an enhancer that throws is isolated (console.warn, without breaking other
 *   enhancers or the main flow).
 * - The writer is assembled by ChatInput (setComposerWriter); extensions never hold
 *   the writer directly — programmatic value writes go ctx.writeComposerValue →
 *   HostApi → ChatInput handle (wired up in P2).
 * - This module has zero React dependencies: ChatInput calls emit* inside its existing
 *   effects; no subscription needed.
 */
import type {
  ComposerEnhancement,
  ComposerSnapshot,
  ComposerWriter,
} from "./types";

export type { ComposerEnhancement, ComposerSnapshot, ComposerWriter };

const enhancers: ComposerEnhancement[] = [];
let writer: ComposerWriter | null = null;
let enhancersVersion = 0;
const enhancerListeners = new Set<() => void>();

/**
 * Recycle-bin writer executor (assembled by core; invoked through the onClearToTrash
 * enhancer callback in ChatInput clearWithUndo; symmetric to setComposerWriter).
 * Extensions never hold the RPC directly — the interface is provided by the extension's
 * enhancer, and the executor is mounted here by core (the mechanism stays in core).
 */
let trashWriter: ((snapshot: ComposerSnapshot) => void) | null = null;

/** ChatInput assembles/unmounts the recycle-bin writer executor. null = unmount. */
export function setComposerTrashWriter(w: ((snapshot: ComposerSnapshot) => void) | null): void {
  trashWriter = w;
}

export function getComposerTrashWriter(): ((snapshot: ComposerSnapshot) => void) | null {
  return trashWriter;
}

/** Test helper: clear the recycle-bin writer executor (never call from production code). */
export function clearComposerTrashWriterForTests(): void {
  trashWriter = null;
}

/** Register an enhancer; returns a disposer (removes exactly this registration). */
export function registerComposerEnhancement(enh: ComposerEnhancement): () => void {
  enhancers.push(enh);
  enhancersVersion++;
  for (const l of enhancerListeners) l();
  return () => {
    const i = enhancers.indexOf(enh);
    if (i >= 0) enhancers.splice(i, 1);
    enhancersVersion++;
    for (const l of enhancerListeners) l();
  };
}

/** Whether an enhancer with the given id exists (core yields by capability: e.g. draft scanning yields to the draft-keeper extension). */
export function hasComposerEnhancement(id: string): boolean {
  return enhancers.some((e) => e.id === id);
}

/** React subscription: re-render when the enhancer set changes (pairs with useSyncExternalStore). */
export function subscribeComposerEnhancers(cb: () => void): () => void {
  enhancerListeners.add(cb);
  return () => enhancerListeners.delete(cb);
}
export function getComposerEnhancersVersion(): number {
  return enhancersVersion;
}

/** ChatInput assembles/unmounts the controlled write entry point. null = unmount (composer not mounted). */
export function setComposerWriter(w: ComposerWriter | null): void {
  writer = w;
}

export function getComposerWriter(): ComposerWriter | null {
  return writer;
}

function safeCall(enh: ComposerEnhancement, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn(`[composer] enhancement "${enh.id}" callback failed:`, e);
  }
}

/** Value-change dispatch (ChatInput calls it in the [value, attachedImages] effect). */
export function emitComposerChange(snapshot: ComposerSnapshot): void {
  for (const enh of enhancers) {
    if (!enh.onChange) continue;
    safeCall(enh, () => enh.onChange!(snapshot));
  }
}

/** draftKey-change dispatch (ChatInput calls it in the draftKey effect, after writing the new key). */
export function emitComposerKeyChange(previousKey: string | undefined, nextKey: string | undefined): void {
  for (const enh of enhancers) {
    if (!enh.onKeyChange) continue;
    safeCall(enh, () => enh.onKeyChange!(previousKey, nextKey));
  }
}

/**
 * Input × clear dispatch (ChatInput calls it before clearInput with a snapshot):
 * with an enhancer registered for onClearToTrash (queue-keeper) → it writes to the
 * recycle bin and we return true; without → return false (clearing only keeps an
 * in-memory 5s undo).
 */
export function emitComposerClearToTrash(snapshot: ComposerSnapshot): boolean {
  let handled = false;
  for (const enh of enhancers) {
    if (!enh.onClearToTrash) continue;
    safeCall(enh, () => enh.onClearToTrash!(snapshot));
    handled = true;
  }
  return handled;
}

/**
 * Pre-send chained hook: each enhancer, in registration order, gets a chance to
 * replace the text. Any link returning a non-string (void/undefined) = pass the
 * original text through to the next link.
 */
export function runComposerSubmit(text: string, imageCount: number): string {
  let current = text;
  for (const enh of enhancers) {
    if (!enh.onSubmit) continue;
    try {
      const out = enh.onSubmit(current, imageCount);
      if (out && typeof out.text === "string") current = out.text;
    } catch (e) {
      console.warn(`[composer] enhancement "${enh.id}" onSubmit failed:`, e);
    }
  }
  return current;
}

/** Test helper: clear all state (never call from production code). */
export function resetComposerBusForTests(): void {
  enhancers.length = 0;
  writer = null;
  trashWriter = null;
}

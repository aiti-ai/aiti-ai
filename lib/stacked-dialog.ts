/**
 * Escape and focus for dialogs that can open above another one, such as the
 * trust dialog opened from Settings › MCP. Settings closes on an Escape that
 * reaches `document` in the bubble phase unhandled; a dialog above it takes the
 * key in the capture phase on `document`, which runs before every bubble-phase
 * listener on the way (the focused element's, Settings' own, and the
 * window-level Escape that stops a running agent), and stops it there. One
 * Escape therefore closes only the topmost dialog. Client-safe: the target is
 * passed in, so tests can hand over a stand-in for `document`.
 */

type KeyDownListener = (event: KeyboardEvent) => void;

/** The part of `document` these listeners use. */
export interface EscapeKeyTarget {
  addEventListener(type: "keydown", listener: KeyDownListener, capture: boolean): void;
  removeEventListener(type: "keydown", listener: KeyDownListener, capture: boolean): void;
}

/** The part of `document` a dialog opening above another uses: where focus is now, and its keys. */
export interface StackedDialogDocument extends EscapeKeyTarget {
  readonly activeElement: Element | null;
}

/** Anything focus can move to: an element, or a stand-in for one in tests. */
interface Focusable {
  focus(options?: FocusOptions): void;
}

/**
 * Escape for a dialog shown above another: listened for in the capture phase,
 * marked handled (`preventDefault()`) and stopped there (`stopPropagation()`),
 * so nothing below sees it, including handlers that do not check
 * `defaultPrevented`. An Escape that cancels an IME composition is stopped
 * too, but does not close the dialog. Returns the cleanup.
 */
export function listenForStackedDialogEscape(target: EscapeKeyTarget, onEscape: () => void): () => void {
  const handleKeyDown: KeyDownListener = (event) => {
    if (event.key !== "Escape") return;
    // Nothing below the dialog reacts to it, whatever it is for.
    event.stopPropagation();
    if (event.isComposing) return;
    event.preventDefault();
    onEscape();
  };
  target.addEventListener("keydown", handleKeyDown, true);
  return () => target.removeEventListener("keydown", handleKeyDown, true);
}

/**
 * Escape for a panel that closes on it (Settings): the bubble phase, and only
 * while nothing nearer handled the key first (`defaultPrevented`), such as a
 * menu or a nested modal inside the panel. Returns the cleanup.
 */
export function listenForPanelEscape(target: EscapeKeyTarget, onEscape: () => void): () => void {
  const handleKeyDown: KeyDownListener = (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onEscape();
  };
  target.addEventListener("keydown", handleKeyDown, false);
  return () => target.removeEventListener("keydown", handleKeyDown, false);
}

/**
 * What a dialog opening above another needs once it is on the page: focus
 * moves into it (the dialog element itself, so a screen reader reads its title
 * and nothing is pressed by a stray Enter), Escape closes it alone, and the
 * returned cleanup stops listening and gives focus back to what had it before
 * the dialog opened, when that is still on the page. An opener that went away
 * meanwhile (the restricted-mode banner of a project the dialog just trusted)
 * is left alone: focusing a detached element does nothing.
 */
export function openStackedDialog(
  doc: StackedDialogDocument,
  dialog: Focusable | null,
  onEscape: () => void,
): () => void {
  const opener = doc.activeElement;
  dialog?.focus({ preventScroll: true });
  const stopListening = listenForStackedDialogEscape(doc, onEscape);
  return () => {
    stopListening();
    if (!opener || !opener.isConnected) return;
    const focusable = opener as Element & Partial<Focusable>;
    if (typeof focusable.focus === "function") focusable.focus({ preventScroll: true });
  };
}

/** The part of `document` `focusIfLost()` reads. */
export interface FocusDocument {
  readonly activeElement: Element | null;
  readonly body: Element | null;
}

/**
 * Moves focus to `target` when the element that had it left the page, so focus
 * fell back to `body` (or nowhere): a control that went away under the
 * keyboard, such as Settings › MCP's Trust… button, which the trust dialog
 * hands focus back to on close and the panel's reload then removes with its
 * notice. Focus anywhere else is where the user put it, and stays. Returns
 * whether it moved focus.
 */
export function focusIfLost(doc: FocusDocument, target: Focusable | null): boolean {
  const active = doc.activeElement;
  if (!target || (active && active !== doc.body)) return false;
  target.focus({ preventScroll: true });
  return true;
}

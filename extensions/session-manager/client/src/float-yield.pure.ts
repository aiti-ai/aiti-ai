/**
 * session-manager · float yield decision (pure functions, zero DOM — the browser-side logic
 * that is hard to test lives here).
 *
 * Background (field report): while All Sessions is a **full-screen / maximized** float,
 * clicking a session (or "open external session") leaves the target — main-chat session,
 * archived viewer, external-session viewer — behind the panel: "I clicked and nothing
 * happened, yet the session opened in the background". A docked panel or a normal-size
 * float does not cover the main area, and those forms must keep the "pick one, see one"
 * flow, so we cannot always close the panel.
 *
 * Decision (two rules, neither guesses the form from breakpoints):
 *   1) aiti-float reports isFull (manual ⛶ maximize / small-screen ≤640px auto full) → covers;
 *   2) panel area ≥ COVER_RATIO of the viewport → dragged-large / viewport-filling → covers.
 * Why area only, without also requiring "crosses the viewport center": the default 680×700
 * float is itself centered on the middle of the screen, so a center test would classify it
 * as covering too and kill the consecutive-pick flow. Area is the one quantity that
 * separates "main area still visible behind it" from "main area fully hidden".
 */

/** Area ratio threshold: default float ≈0.33, maximized ≈1.0 — 0.6 sits between them
 *  (full width plus ~60% height already counts as covering). */
export const COVER_RATIO = 0.6;

export interface RectLike {
  left: number; top: number; right: number; bottom: number;
  width: number; height: number;
}
export interface ViewportLike { width: number; height: number }

/** Does the panel cover the main area? isFull = aiti-float's maximize / small-screen full. */
export function coversMainArea(rect: RectLike | null | undefined, viewport: ViewportLike, isFull = false): boolean {
  if (isFull) return true;
  if (!rect) return false;
  // Not laid out yet / hidden panel (display:none, first frame of the entrance animation)
  if (!(rect.width >= 40) || !(rect.height >= 30)) return false;
  const view = Math.max(1, viewport.width * viewport.height);
  const area = Math.max(0, rect.width) * Math.max(0, rect.height);
  return area / view >= COVER_RATIO;
}

/**
 * FileToolbar mid-band overflow squeeze — pure state machine (no DOM / no React).
 *
 * Why: the toolbar has a single compact breakpoint (COMPACT_AT). Between COMPACT_AT and the
 * toolbar's full natural width the flex row genuinely overflows — every right-side button is
 * flexShrink:0, so the tail (close row / share / ⋮) gets clipped by the container with no
 * scrollbar: the "⋯ menu unreachable" band. squeezeStep() models the graduated collapse driven
 * by a real overflow reading (scrollWidth > clientWidth, measured by the caller):
 *
 *   overflow        → strip one more group (capped at SQUEEZE_MAX); if already at max,
 *                     force compact and ratchet the exit threshold (width + SQUEEZE_FORCE_MARGIN)
 *   no overflow     → if width < exit threshold (forced compact active) freeze the level, so
 *                     exiting forced compact re-renders straight at squeeze-max and cannot loop;
 *                     otherwise restore one level only when spacer slack ≥ RESTORE_SLACK
 *                     (larger than any single restorable group → a restore can never re-overflow)
 *   compact         → width < COMPACT_AT or width < ratcheted exit threshold
 *
 * Callers feed committed state + fresh measurements each tick (ResizeObserver / post-render
 * effect); the function is pure and idempotent, so repeated ticks at a stable width are no-ops
 * and the cascade converges without oscillation.
 */

/** Bar width below this → compact (all secondary buttons live in the ⋯ menu). */
export const COMPACT_AT = 620;
/** Graduated squeeze levels: how many secondary button groups are collapsed into the ⋯ menu
 *  while the bar is wider than COMPACT_AT but still overflowing.
 *  L1 close icon row → L2 new-window/terminal/download → L3 ‹› nav + count. */
export const SQUEEZE_MAX = 3;
/** Restore hysteresis (px of spacer slack, measured beyond the spacer's 8px minWidth): one
 *  squeeze level back only when slack reaches this; sized larger than any single restorable
 *  group (nav+count ≈ 115px) so a restore can never immediately re-overflow. */
export const RESTORE_SLACK = 190;
/** Forced-compact exit margin: the exit threshold ratchets to (failure width + this) so exiting
 *  forced compact re-renders at squeeze-max directly; only sub-pixel variance separates the two
 *  overflow observations at one width, so 60px is a safely converging dead band. */
export const SQUEEZE_FORCE_MARGIN = 60;

export type SqueezeStep = {
  /** Graduated collapse level 0..SQUEEZE_MAX (groups stripped into the ⋯ menu). */
  squeeze: number;
  /** Ratcheted exit width threshold for forced compact (0 = never forced). */
  forceCompactAt: number;
  /** Compact face: width < COMPACT_AT or below the forced-compact exit threshold. */
  compact: boolean;
};

export function squeezeStep(
  cur: number,
  forceCompactAt: number,
  width: number,
  overflow: boolean,
  slack: number,
): SqueezeStep {
  let fc = forceCompactAt;
  if (overflow && cur >= SQUEEZE_MAX) {
    fc = Math.max(fc, width + SQUEEZE_FORCE_MARGIN);
  }
  const compact = width < COMPACT_AT || width < fc;
  let squeeze = cur;
  if (overflow) {
    squeeze = Math.min(cur + 1, SQUEEZE_MAX);
  } else if (width < fc) {
    // Forced compact active: freeze the level so the exit render keeps the stripped state.
    squeeze = cur;
  } else if (cur > 0 && slack >= RESTORE_SLACK) {
    squeeze = cur - 1;
  }
  return { squeeze, forceCompactAt: fc, compact };
}

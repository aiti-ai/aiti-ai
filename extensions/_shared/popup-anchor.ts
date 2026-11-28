/**
 * _shared/popup-anchor.ts — shared fixed-positioning utilities for popups (zero react; inlined into
 * each extension's bundle at build time).
 *
 * Background: the left sidebar-container (desktop width animation overflow:hidden) -> StackCell ->
 * DockBody are all overflow:hidden, so popups anchored with absolute (dropdowns/menus) are always
 * clipped by ancestors when in short/collapsed/bottom-stack cells (the popup's own
 * getBoundingClientRect is still inside the viewport, so viewport-clamping fallbacks cannot detect it).
 * The way out = always anchor popups with position:fixed to the trigger rect — fixed escapes overflow
 * clipping. The one exception: ancestors with transform/filter etc. become the fixed element's
 * containing block, in which case coordinates must be corrected by that ancestor's origin (fixedOrigin).
 */

/** Whether an ancestor constitutes a fixed containing block (common CSS subset:
 *  transform/perspective/filter, will-change declaring the same properties, contain
 *  layout values, zoom≠1 — standardized CSS zoom makes fixed descendants position
 *  relative to the zoomed ancestor with insets scaled by it; verified on Chrome 157:
 *  an inset:0 overlay inside a zoom container renders at the container size, not the
 *  viewport size). */
function isFixedContainingBlock(cs: CSSStyleDeclaration): boolean {
  const zoomValue = parseFloat(cs.zoom || "");
  if (Number.isFinite(zoomValue) && zoomValue !== 1) return true;
  if (cs.transform !== "none" || cs.perspective !== "none" || cs.filter !== "none") return true;
  if (/transform|perspective|filter/.test(cs.willChange || "")) return true;
  const c = cs.contain;
  return c === "strict" || c === "content" || c === "layout" || c === "paint";
}

/** Origin of el's nearest fixed-containing-block ancestor (viewport coords; none = {x:0,y:0}).
 *  A fixed popup's coordinates = expected viewport coords minus this value (i.e. viewport coords when
 *  there is no transformed ancestor). */
export function fixedOrigin(el: Element): { x: number; y: number } {
  let n = el.parentElement;
  while (n && n !== document.documentElement) {
    try {
      if (isFixedContainingBlock(getComputedStyle(n))) {
        const r = n.getBoundingClientRect();
        return { x: r.left, y: r.top };
      }
    } catch { /* ignore */ }
    n = n.parentElement;
  }
  return { x: 0, y: 0 };
}

/** Product of `zoom` values on el's ancestor chain (excluding el itself; 1 when none).
 *  Standardized CSS zoom makes the nearest zoomed ancestor the containing block of
 *  fixed descendants and scales their insets — a popup rendered inside a zoomed panel
 *  must divide viewport-space coordinates by this factor after subtracting the
 *  containing-block origin (fixedOrigin, which now matches on zoomed ancestors too):
 *  local = (expectedViewport − origin) / zoomFactor. */
export function zoomFactorOf(el: Element): number {
  let z = 1;
  let n = el.parentElement;
  while (n && n !== document.documentElement) {
    try {
      const zoomValue = parseFloat(getComputedStyle(n).zoom || "");
      if (Number.isFinite(zoomValue) && zoomValue > 0 && zoomValue !== 1) z *= zoomValue;
    } catch { /* ignore */ }
    n = n.parentElement;
  }
  return z;
}

/** Clamp inside the viewport (pad inset; when width/height exceed the viewport, align flush to pad). Inputs/outputs are viewport coords. */
export function clampToViewport(left: number, top: number, width: number, height: number, pad = 8): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    left: Math.max(pad, Math.min(left, vw - pad - width)),
    top: Math.max(pad, Math.min(top, Math.max(pad, vh - pad - height))),
  };
}

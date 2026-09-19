/** Single source for context-urgency color tiers (design: docs/context-compaction-urgency-plan.md §3.1):
 *  the top-bar indicator / session-info panel / both ChatInput compact buttons all consume
 *  this one function; the first three thresholds match the top bar's original tiering
 *  (>70 yellow / >90 red); the fourth critical tier is new. */
export type CtxUrgencyLevel = "calm" | "warn" | "urgent" | "critical";

export interface CtxUrgency {
  level: CtxUrgencyLevel;
  /** Primary color (text/icons) */
  color: string;
  /** Button tint background */
  bg: string;
  /** Button border */
  border: string;
}

/** Breathing animation name for the critical tier (@keyframes defined in app/globals.css, disabled under prefers-reduced-motion). */
export const CTX_BREATHE_ANIMATION = "ctx-urgency-breathe";

/** Animation shorthand for the critical tier (for direct use in inline style animation fields). */
export const CTX_BREATHE_CSS = `${CTX_BREATHE_ANIMATION} 1.2s ease-in-out infinite alternate`;

const CALM: CtxUrgency = { level: "calm", color: "var(--text-muted)", bg: "none", border: "var(--border)" };
const WARN: CtxUrgency = { level: "warn", color: "rgba(234,179,8,0.95)", bg: "rgba(234,179,8,0.1)", border: "rgba(234,179,8,0.4)" };
const URGENT: CtxUrgency = { level: "urgent", color: "#ef4444", bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.35)" };
const CRITICAL: CtxUrgency = { level: "critical", color: "#dc2626", bg: "rgba(220,38,38,0.1)", border: "rgba(220,38,38,0.4)" };

/** null/undefined (unknown) percent falls back to calm gray; thresholds: >70 warn, >90 urgent, >97 critical. */
export function contextUrgency(percent: number | null | undefined): CtxUrgency {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return CALM;
  if (percent > 97) return CRITICAL;
  if (percent > 90) return URGENT;
  if (percent > 70) return WARN;
  return CALM;
}

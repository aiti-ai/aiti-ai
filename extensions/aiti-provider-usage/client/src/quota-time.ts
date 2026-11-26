import type { UsageBucket } from "../../lib/server/types";

// Cycle-time ratio for quota windows: turns resetsAt + windowMinutes into the
// fraction of the window that has NOT elapsed yet, rendered next to the quota
// remaining so the two can be compared in the same direction (both 100 → 0).

/** Fraction (0-100) of the quota window's time still left, from resetsAt and
 *  windowMinutes (window start ≈ resetsAt − length). Calendar resets
 *  (weekly/monthly) are approximated this way on purpose — close enough to
 *  compare "quota left" against "time left" in one row. undefined when the
 *  window length is unknown. */
export function cycleTimeLeftPct(
  bucket: Pick<UsageBucket, "resetsAt" | "windowMinutes">,
  now: number = Date.now(),
): number | undefined {
  if (!bucket.resetsAt || !bucket.windowMinutes || bucket.windowMinutes <= 0) return undefined;
  const remainingMs = bucket.resetsAt * 1_000 - now;
  const pct = (remainingMs / (bucket.windowMinutes * 60_000)) * 100;
  return Math.min(100, Math.max(0, pct));
}

/** Suffix appended after the reset timestamp, e.g. ` (time:63%)`. */
export function cycleTimeSuffix(bucket: UsageBucket, now: number = Date.now()): string {
  const pct = cycleTimeLeftPct(bucket, now);
  return pct === undefined ? "" : ` (time:${Math.round(pct)}%)`;
}

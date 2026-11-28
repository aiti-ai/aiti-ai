/**
 * aiti-editor · coalescing scheduler (quiet period + max wait + trailing guarantee).
 *
 * Plan: docs/aiti-editor-silent-preview-refresh-plan.md §3.5
 *
 * Why: an agent writing a file through tools can produce a burst of disk frames. Refreshing
 * on every frame is wasteful, but plain throttling DROPS frames — and if the dropped frame is
 * the last one, the view stays on stale content forever (the old code recorded the signature
 * before the throttle check, so the final write was considered "known"). This scheduler keeps
 * at most one pending run and always fires on the trailing edge.
 *
 * Timers are injectable so node --test can drive a fake clock without real waiting.
 */

export interface CoalescerTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

/** Budget values may be functions: document size (and therefore render cost) changes at runtime. */
export type BudgetValue = number | (() => number);

export interface CoalescerOptions {
  /** Start the run after this much quiet time (resets on every schedule()). */
  quietMs: BudgetValue;
  /** Upper bound from the first pending schedule — a continuous burst still refreshes. */
  maxMs: BudgetValue;
  /** The work to run; it always sees the latest state (callers read fresh values inside). */
  run: () => void;
  timers?: Partial<CoalescerTimers>;
}

export interface Coalescer {
  /** Request a run (idempotent while pending; slides the quiet deadline, never the max one). */
  schedule: () => void;
  /** Run now if pending (manual reload / unmount flush). */
  flush: () => void;
  /** Drop the pending run (file switch / teardown). */
  cancel: () => void;
  readonly pending: boolean;
}

const DEFAULT_TIMERS: CoalescerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export function createCoalescer(opts: CoalescerOptions): Coalescer {
  const timers: CoalescerTimers = { ...DEFAULT_TIMERS, ...(opts.timers || {}) };
  const budget = (v: BudgetValue) => Math.max(0, typeof v === "function" ? v() : v);
  let handle: unknown = null;
  let firstPendingAt = 0;

  const fire = () => {
    handle = null;
    firstPendingAt = 0;
    opts.run();
  };

  const schedule = () => {
    const now = timers.now();
    if (firstPendingAt === 0) firstPendingAt = now;
    if (handle !== null) timers.clearTimeout(handle);
    // Quiet deadline vs remaining max budget: whichever comes first wins. Once the budget is
    // spent the delay clamps to 0, so a continuous stream still produces a run (trailing edge).
    const remainingMax = firstPendingAt + budget(opts.maxMs) - now;
    const delay = Math.max(0, Math.min(budget(opts.quietMs), remainingMax));
    handle = timers.setTimeout(fire, delay);
  };

  const flush = () => {
    if (handle === null) return;
    timers.clearTimeout(handle);
    fire();
  };

  const cancel = () => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
    firstPendingAt = 0;
  };

  return {
    schedule,
    flush,
    cancel,
    get pending() { return handle !== null; },
  };
}

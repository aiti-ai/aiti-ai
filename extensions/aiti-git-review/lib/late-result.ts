/**
 * Late-answer store for AI runs that outlive their deadline.
 *
 * A generation that runs past its deadline keeps running server-side: the caller gets the session
 * id and may pull the answer afterwards instead of losing the work (provider retries alone can take
 * minutes). This store remembers which session ids are still pullable (`track`), holds the final
 * text once the session settles (`settle`), and serves it for `ttlMs` (`get`).
 *
 * Pure bookkeeping (no timers, no network) so it can be unit-tested; the caller owns the clock.
 */
export interface LateResultStore {
  /** Mark a session id as pullable (after its caller timed out). */
  track(sessionId: string, now?: number): void;
  isTracked(sessionId: string): boolean;
  /** Cache the settled answer. Returns true when the id was tracked by a timed-out caller. */
  settle(sessionId: string, text: string, now?: number): boolean;
  /** Record that the run failed without an answer (text stays null). */
  fail(sessionId: string, error: string, now?: number): boolean;
  /** Failure reason of a tracked session, or null while running / after success / expired. */
  errorOf(sessionId: string, now?: number): string | null;
  /** Final answer for a tracked session, or null while it is still running / unknown / expired. */
  get(sessionId: string, now?: number): string | null;
  /** Number of live entries (tests/diagnostics). */
  size(now?: number): number;
}

export interface LateResultStoreOptions {
  /** How long a timed-out session stays pullable (default 10 minutes). */
  ttlMs?: number;
  /** Maximum tracked sessions; the oldest ones are dropped first (default 20). */
  max?: number;
}

export function createLateResultStore(opts: LateResultStoreOptions = {}): LateResultStore {
  const ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : 10 * 60_000;
  const max = opts.max && opts.max > 0 ? opts.max : 20;
  const entries = new Map<string, { at: number; text: string | null; error: string | null }>();

  const prune = (now: number): void => {
    for (const [sid, e] of entries) {
      if (now - e.at > ttlMs) entries.delete(sid);
    }
  };

  return {
    track(sessionId, now = Date.now()) {
      const sid = String(sessionId ?? "");
      if (!sid) return;
      prune(now);
      const prev = entries.get(sid);
      entries.set(sid, { at: now, text: prev?.text ?? null, error: prev?.error ?? null });
      while (entries.size > max) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    isTracked(sessionId) {
      const sid = String(sessionId ?? "");
      return !!sid && entries.has(sid);
    },
    settle(sessionId, text, now = Date.now()) {
      const sid = String(sessionId ?? "");
      const e = entries.get(sid);
      if (!e) return false;
      e.text = String(text ?? "");
      e.error = null;
      e.at = now;
      return true;
    },
    fail(sessionId, error, now = Date.now()) {
      const sid = String(sessionId ?? "");
      const e = entries.get(sid);
      if (!e) return false;
      e.text = null;
      e.error = String(error ?? "") || "the run failed without an answer";
      e.at = now;
      return true;
    },
    errorOf(sessionId, now = Date.now()) {
      const sid = String(sessionId ?? "");
      const e = entries.get(sid);
      if (!e) return null;
      if (now - e.at > ttlMs) {
        entries.delete(sid);
        return null;
      }
      return e.error;
    },
    get(sessionId, now = Date.now()) {
      const sid = String(sessionId ?? "");
      const e = entries.get(sid);
      if (!e) return null;
      if (now - e.at > ttlMs) {
        entries.delete(sid);
        return null;
      }
      return e.text;
    },
    size(now = Date.now()) {
      prune(now);
      return entries.size;
    },
  };
}

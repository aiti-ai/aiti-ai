/**
 * Page-level "current session state" store (unified session-state service; 2026-09-12 plan
 * docs/pi-web-session-state-and-perf-plan.md §4).
 *
 * The host (AppShell) derives a snapshot from initialNavigation.sessionId / initialSessionRestored /
 * selectedSession and publishes it; extensions consume it via the `pi-web.session` service's
 * `get()/subscribe()` under `ctx.services` — unifying the semantics of
 * "resolving (?session= being resolved) / active (canonical id established) / none (no session)"
 * and replacing per-extension reads of unverified ids from the URL `?session=` for requests.
 *
 * Also dispatches the window event `pi-web:session-state` (detail = snapshot; compatibility/debug
 * channel — the official contract is the ctx service).
 *
 * Registration: AppShell module top level `registerExtClientService("pi-web", "pi-web.session", …)`
 * — earlier than any extension client materialize (module top-level side effects run before the effect phase).
 */

export type PiWebSessionPhase = "resolving" | "active" | "none";

export type PiWebSessionSource =
  | "initial"        // first frame (no URL session)
  | "url"            // URL ?session= being resolved / resolved
  | "url-failed"     // URL ?session= validation failed (404/missing)
  | "select"         // user selection
  | "created"        // new session created
  | "fork"           // fork
  | "canonicalized"  // id canonicalized (legacy ?session= URL / placeholder id)
  | "deleted"        // current session deleted
  | "cwd-switch"     // project/workspace switch cleared the session
  | "restore";       // restored lastOpenSession on project switch

export interface PiWebSessionSummary {
  id: string;
  cwd: string;
  name?: string;
  firstMessage?: string;
}

export interface PiWebSessionSnapshot {
  phase: PiWebSessionPhase;
  /** Original id requested via the URL (unverified; the old id is kept for reference after canonicalization). null when there is no URL session */
  requestedId: string | null;
  /** Verified canonical session id (non-null when phase=active) */
  sessionId: string | null;
  /** Session summary (when active) */
  session: PiWebSessionSummary | null;
  source: PiWebSessionSource;
  /** Monotonically increasing revision (subscriber dedupe) */
  rev: number;
}

export interface PiWebSessionService {
  get(): PiWebSessionSnapshot;
  /** Subscribe to state changes; the callback fires once immediately with the current snapshot on subscribe. Returns an unsubscribe function. */
  subscribe(cb: (snapshot: PiWebSessionSnapshot) => void): () => void;
  /**
   * Open a session by id (AppShell fills the handleOpenSession delegate). Optional member —
   * absent on old host service objects, so consumers must degrade with `svc?.open?.(id)`
   * (extension-service hard rule).
   */
  open?(id: string): void;
}

// open(id) delegate slot: AppShell backfills the latest closure on every render (same pattern as hostUiRef, avoiding stale closures).
let openDelegate: ((id: string) => void) | null = null;

/** Called from the AppShell render body: backfill/clear the open-session delegate (pass null on unmount). */
export function setSessionOpener(fn: ((id: string) => void) | null): void {
  openDelegate = fn;
}

/** Open a session via the host delegate (direct in-host entry — used by the built-in recent-sessions widget; no-op when no delegate is set). */
export function openSessionById(id: string): void {
  openDelegate?.(id);
}

const INITIAL_SNAPSHOT: PiWebSessionSnapshot = Object.freeze({
  phase: "none",
  requestedId: null,
  sessionId: null,
  session: null,
  source: "initial",
  rev: 0,
});

let snapshot: PiWebSessionSnapshot = INITIAL_SNAPSHOT;
const listeners = new Set<(snapshot: PiWebSessionSnapshot) => void>();

/** Current snapshot (synchronous read; direct entry for scenarios outside the missing-service case). */
export function getSessionSnapshot(): PiWebSessionSnapshot {
  return snapshot;
}

function sameSummary(a: PiWebSessionSummary | null, b: PiWebSessionSummary | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.cwd === b.cwd
    && (a.name ?? "") === (b.name ?? "")
    && (a.firstMessage ?? "") === (b.firstMessage ?? "");
}

/**
 * Publish a new snapshot (rev increments). Skipped when the content matches the current one
 * (phase/requestedId/sessionId/session summary) — calling this on every React render produces
 * no duplicate notifications.
 */
export function publishSessionState(next: {
  phase: PiWebSessionPhase;
  requestedId: string | null;
  sessionId: string | null;
  session: PiWebSessionSummary | null;
  source: PiWebSessionSource;
}): void {
  if (
    next.phase === snapshot.phase
    && next.requestedId === snapshot.requestedId
    && next.sessionId === snapshot.sessionId
    && next.source === snapshot.source
    && sameSummary(next.session, snapshot.session)
  ) {
    return;
  }
  snapshot = {
    phase: next.phase,
    requestedId: next.requestedId,
    sessionId: next.sessionId,
    session: next.session,
    source: next.source,
    rev: snapshot.rev + 1,
  };
  for (const cb of [...listeners]) {
    try { cb(snapshot); } catch { /* subscriber errors must not break the loop */ }
  }
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent("pi-web:session-state", { detail: snapshot }));
    } catch { /* ignored outside a browser environment */ }
  }
}

/** Subscribe to snapshot changes; the callback fires once immediately with the current value on subscribe (snapshot semantics). Returns an unsubscribe function. */
export function subscribeSessionState(cb: (snapshot: PiWebSessionSnapshot) => void): () => void {
  listeners.add(cb);
  try { cb(snapshot); } catch { /* ignore */ }
  return () => { listeners.delete(cb); };
}

/** The ctx.services service implementation (used by AppShell to register key `pi-web.session`). */
export const piWebSessionService: PiWebSessionService = {
  get: getSessionSnapshot,
  subscribe: subscribeSessionState,
  open: (id: string) => openSessionById(id),
};

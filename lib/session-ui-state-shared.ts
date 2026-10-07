// The sidebar's own UI state for sessions and projects: which session families
// are pinned or archived, and which projects are pinned. It is pi-web's state,
// never written into a session's `.jsonl`, so the pi CLI does not see it. The
// server keeps it in `pi-web-session-state.json` in the agent dir
// (`lib/session-ui-state.ts`); this module holds the types and the pure rules
// both sides apply, so the client can apply a change optimistically exactly as
// the server will. Client-safe: no Node imports.

export const SESSION_UI_STATE_VERSION = 1;
/** The session ids pi writes (UUIDs); same as `lib/session-reader.ts`. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
export const MAX_SESSION_UI_IDS_PER_REQUEST = 500;
/** Longest projectKey or project root a request or the file may carry. */
const MAX_PROJECT_STRING_LENGTH = 4096;

/** Epoch ms, keyed by the FAMILY ROOT session id. */
export interface SessionUiFamilyState { pinnedAt?: number; archivedAt?: number }
/** Keyed by projectKey (`workspaceKeyOf`). */
export interface SessionUiProjectState { pinnedAt: number; root: string }
export interface SessionUiState {
  version: 1;
  /** Monotonic, bumped by the server on every changing write. */
  revision: number;
  sessions: Record<string, SessionUiFamilyState>;
  projects: Record<string, SessionUiProjectState>;
}
/** One family's flags before a change, for undo; null = absent. */
export interface SessionUiFlagsSnapshot { id: string; pinnedAt: number | null; archivedAt: number | null }

export type SessionUiStateRequest =
  | { action: "set"; ids: string[]; pinned: boolean }
  | { action: "set"; ids: string[]; archived: boolean }
  /** Undo: writes back exact prior values (null = absent). */
  | { action: "restore"; entries: SessionUiFlagsSnapshot[] }
  | { action: "pin-project"; projectKey: string; root: string; pinned: boolean };

export interface SessionUiStateResponse { state: SessionUiState }

/** Why `POST /api/sessions/ui-state` refused; `error` is English diagnostic text. */
export type SessionUiStateRefusalReason = "request-denied" | "content-type" | "invalid-request" | "locked" | "internal";
export interface SessionUiStateErrorResponse { error: string; reason: SessionUiStateRefusalReason }

const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Epoch ms as the file and requests carry them. */
function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/** `__proto__` would set the record's prototype instead of adding a key. */
function isProjectString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_PROJECT_STRING_LENGTH
    && value !== "__proto__";
}

export function emptySessionUiState(): SessionUiState {
  return { version: SESSION_UI_STATE_VERSION, revision: 0, sessions: {}, projects: {} };
}

function normalizeFamily(value: unknown): SessionUiFamilyState | null {
  if (!isPlainObject(value)) return null;
  const family: SessionUiFamilyState = {};
  if (isTimestamp(value.pinnedAt)) family.pinnedAt = value.pinnedAt;
  if (isTimestamp(value.archivedAt)) family.archivedAt = value.archivedAt;
  return family.pinnedAt === undefined && family.archivedAt === undefined ? null : family;
}

function normalizeProject(value: unknown): SessionUiProjectState | null {
  if (!isPlainObject(value) || !isTimestamp(value.pinnedAt) || !isProjectString(value.root)) return null;
  return { pinnedAt: value.pinnedAt, root: value.root };
}

/** Tolerant: returns a clean state from unknown JSON, dropping malformed entries; null if the root shape is unusable. */
export function normalizeSessionUiState(value: unknown): SessionUiState | null {
  if (!isPlainObject(value)) return null;
  // Another version may mean other rules; it is not read as this one.
  if (value.version !== undefined && value.version !== SESSION_UI_STATE_VERSION) return null;
  if (value.sessions !== undefined && !isPlainObject(value.sessions)) return null;
  if (value.projects !== undefined && !isPlainObject(value.projects)) return null;
  const state = emptySessionUiState();
  const revision = value.revision;
  if (typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0) state.revision = revision;
  for (const [id, entry] of Object.entries(value.sessions ?? {})) {
    if (!isSessionId(id)) continue;
    const family = normalizeFamily(entry);
    if (family) state.sessions[id] = family;
  }
  for (const [key, entry] of Object.entries(value.projects ?? {})) {
    if (!isProjectString(key)) continue;
    const project = normalizeProject(entry);
    if (project) state.projects[key] = project;
  }
  return state;
}

type ParseResult = { ok: true; request: SessionUiStateRequest } | { ok: false; error: string };

function parseIds(value: unknown): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: "ids must be a non-empty array" };
  if (value.length > MAX_SESSION_UI_IDS_PER_REQUEST) {
    return { ok: false, error: `ids may hold at most ${MAX_SESSION_UI_IDS_PER_REQUEST} session ids` };
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (!isSessionId(id)) return { ok: false, error: "ids must be session ids" };
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ok: true, ids };
}

function parseSnapshotValue(value: unknown): number | null | undefined {
  if (value === null) return null;
  return isTimestamp(value) ? value : undefined;
}

/** Validates an untrusted body. ids: non-empty, unique after dedupe, each matches SESSION_ID_PATTERN, at most MAX_SESSION_UI_IDS_PER_REQUEST. projectKey/root: non-empty strings <= 4096 chars. */
export function parseSessionUiStateRequest(body: unknown): ParseResult {
  if (!isPlainObject(body)) return { ok: false, error: "Expected a JSON object" };
  switch (body.action) {
    case "set": {
      const hasPinned = hasOwn(body, "pinned");
      if (hasPinned === hasOwn(body, "archived")) return { ok: false, error: "Send exactly one of pinned or archived" };
      const value = hasPinned ? body.pinned : body.archived;
      if (typeof value !== "boolean") return { ok: false, error: `${hasPinned ? "pinned" : "archived"} must be a boolean` };
      const ids = parseIds(body.ids);
      if (!ids.ok) return ids;
      return {
        ok: true,
        request: hasPinned
          ? { action: "set", ids: ids.ids, pinned: value }
          : { action: "set", ids: ids.ids, archived: value },
      };
    }
    case "restore": {
      const raw = body.entries;
      if (!Array.isArray(raw)) return { ok: false, error: "entries must be an array" };
      if (raw.length > MAX_SESSION_UI_IDS_PER_REQUEST) {
        return { ok: false, error: `entries may hold at most ${MAX_SESSION_UI_IDS_PER_REQUEST} sessions` };
      }
      const entries: SessionUiFlagsSnapshot[] = [];
      const seen = new Set<string>();
      for (const entry of raw) {
        if (!isPlainObject(entry) || !isSessionId(entry.id)) return { ok: false, error: "Each entry needs a session id" };
        // Two prior values for one family would leave which one wins to chance.
        if (seen.has(entry.id)) return { ok: false, error: "entries must name each session once" };
        seen.add(entry.id);
        const pinnedAt = parseSnapshotValue(entry.pinnedAt);
        const archivedAt = parseSnapshotValue(entry.archivedAt);
        if (pinnedAt === undefined || archivedAt === undefined) {
          return { ok: false, error: "pinnedAt and archivedAt must be timestamps or null" };
        }
        entries.push({ id: entry.id, pinnedAt, archivedAt });
      }
      return { ok: true, request: { action: "restore", entries } };
    }
    case "pin-project": {
      if (!isProjectString(body.projectKey)) {
        return { ok: false, error: `projectKey must be a non-empty string of at most ${MAX_PROJECT_STRING_LENGTH} characters` };
      }
      if (!isProjectString(body.root)) {
        return { ok: false, error: `root must be a non-empty string of at most ${MAX_PROJECT_STRING_LENGTH} characters` };
      }
      if (typeof body.pinned !== "boolean") return { ok: false, error: "pinned must be a boolean" };
      return { ok: true, request: { action: "pin-project", projectKey: body.projectKey, root: body.root, pinned: body.pinned } };
    }
    default:
      return { ok: false, error: "action must be \"set\", \"restore\" or \"pin-project\"" };
  }
}

function sameFamily(a: SessionUiFamilyState | undefined, b: SessionUiFamilyState): boolean {
  return a?.pinnedAt === b.pinnedAt && a?.archivedAt === b.archivedAt;
}

/** Stores `next` for `id` (an empty entry is removed) and says whether that changed anything. */
function writeFamily(sessions: Record<string, SessionUiFamilyState>, id: string, next: SessionUiFamilyState): boolean {
  const previous = hasOwn(sessions, id) ? sessions[id] : undefined;
  const empty = next.pinnedAt === undefined && next.archivedAt === undefined;
  if (empty) {
    if (!previous) return false;
    delete sessions[id];
    return true;
  }
  if (sameFamily(previous, next)) return false;
  sessions[id] = next;
  return true;
}

function nextFamily(
  previous: SessionUiFamilyState | undefined,
  request: Extract<SessionUiStateRequest, { action: "set" }>,
  now: number,
): SessionUiFamilyState {
  const next: SessionUiFamilyState = { ...previous };
  if ("pinned" in request) {
    if (!request.pinned) {
      delete next.pinnedAt;
    } else if (next.pinnedAt === undefined || next.archivedAt !== undefined) {
      // Pin and archive exclude each other: pinning an archived family restores it.
      next.pinnedAt = now;
      delete next.archivedAt;
    }
    return next;
  }
  if (request.archived) {
    // Archiving again refreshes the time, so a family that came back with new activity can be archived again.
    next.archivedAt = now;
    delete next.pinnedAt;
  } else {
    delete next.archivedAt;
  }
  return next;
}

function copyState(state: SessionUiState): SessionUiState {
  const sessions: Record<string, SessionUiFamilyState> = {};
  for (const [id, entry] of Object.entries(state.sessions)) sessions[id] = { ...entry };
  const projects: Record<string, SessionUiProjectState> = {};
  for (const [key, entry] of Object.entries(state.projects)) projects[key] = { ...entry };
  return { ...state, sessions, projects };
}

/** Pure. Returns a NEW state (never mutates input) and whether anything changed. Does NOT touch revision. */
export function applySessionUiStateRequest(
  state: SessionUiState,
  request: SessionUiStateRequest,
  now: number,
): { state: SessionUiState; changed: boolean } {
  const next = copyState(state);
  let changed = false;
  switch (request.action) {
    case "set":
      for (const id of request.ids) {
        const previous = hasOwn(next.sessions, id) ? next.sessions[id] : undefined;
        if (writeFamily(next.sessions, id, nextFamily(previous, request, now))) changed = true;
      }
      break;
    case "restore":
      for (const entry of request.entries) {
        const family: SessionUiFamilyState = {};
        if (entry.pinnedAt !== null) family.pinnedAt = entry.pinnedAt;
        if (entry.archivedAt !== null) family.archivedAt = entry.archivedAt;
        if (writeFamily(next.sessions, entry.id, family)) changed = true;
      }
      break;
    case "pin-project": {
      const { projectKey, root } = request;
      const previous = hasOwn(next.projects, projectKey) ? next.projects[projectKey] : undefined;
      if (request.pinned) {
        if (previous?.root !== root) {
          next.projects[projectKey] = { pinnedAt: now, root };
          changed = true;
        }
      } else if (previous) {
        delete next.projects[projectKey];
        changed = true;
      }
      break;
    }
  }
  return { state: next, changed };
}

/**
 * `items` in slices of at most `size` (a request's limit), in order. A change
 * to more families than one request may carry ("Archive sessions older than 7
 * days" in a busy project, and its Undo) is sent as several requests.
 */
export function chunkForSessionUiRequests<T>(items: readonly T[], size = MAX_SESSION_UI_IDS_PER_REQUEST): T[][] {
  const step = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += step) chunks.push(items.slice(start, start + step));
  return chunks;
}

/** Snapshot of the current flags for undo; each id once, in the order given. */
export function snapshotSessionUiFlags(state: SessionUiState, ids: readonly string[]): SessionUiFlagsSnapshot[] {
  const seen = new Set<string>();
  const snapshot: SessionUiFlagsSnapshot[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = hasOwn(state.sessions, id) ? state.sessions[id] : undefined;
    snapshot.push({ id, pinnedAt: entry?.pinnedAt ?? null, archivedAt: entry?.archivedAt ?? null });
  }
  return snapshot;
}

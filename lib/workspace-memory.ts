/**
 * Per-workspace "last open session" memory.
 *
 * Switching to a workspace (project root or cwd) restores the session the user
 * had open there last, instead of landing on a blank new-session page. Without
 * this, every workspace switch required re-picking the session by hand.
 *
 * The workspace key is the server-provided project identity when known, so
 * Windows path variants and all worktrees of one repo share one memory slot.
 * Transient and legacy session objects fall back to projectRoot/cwd.
 *
 * Stored in localStorage; best-effort (silently ignored when unavailable).
 */

const STORAGE_KEY = "pi-web:last-open-by-workspace";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readMap(storage: StorageLike): Record<string, string | undefined> {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, string | undefined>
      : {};
  } catch {
    return {};
  }
}

/** The remembered session id for a workspace, or null when none/stale. */
export function getLastOpenSession(
  workspaceKey: string,
  storage: StorageLike | null = getBrowserStorage(),
): string | null {
  if (!storage) return null;
  try {
    const id = readMap(storage)[workspaceKey];
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export function setLastOpenSession(
  workspaceKey: string,
  sessionId: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    const map = readMap(storage);
    map[workspaceKey] = sessionId;
    storage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // storage unavailable — memory is best-effort
  }
}

export function clearLastOpen(
  workspaceKey: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    const map = readMap(storage);
    if (!(workspaceKey in map)) return;
    delete map[workspaceKey];
    // Keep the store clean: drop the key entirely when nothing is remembered.
    if (Object.keys(map).length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

/**
 * Drop every remembered entry whose session id equals the given one.
 *
 * Used when an initial `?session=` restore hits a deleted session: the
 * workspace key is unknown at that point (the session record no longer
 * resolves), so scan by value instead. Best-effort like the rest of this
 * module; a no-op when nothing matches.
 */
export function clearLastOpenSessionById(
  sessionId: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage || !sessionId) return;
  try {
    const map = readMap(storage);
    let changed = false;
    for (const key of Object.keys(map)) {
      if (map[key] === sessionId) {
        delete map[key];
        changed = true;
      }
    }
    if (!changed) return;
    if (Object.keys(map).length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

/** Workspace identity for a session: resolved project root when known, else cwd. */
export function workspaceKeyOf(session: {
  cwd: string;
  projectRoot?: string | null;
  projectKey?: string | null;
}): string {
  return session.projectKey ?? session.projectRoot ?? session.cwd;
}

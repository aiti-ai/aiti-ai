/**
 * Per-user "hidden workspaces" list.
 *
 * The workspace picker's project list is derived from sessions
 * (getRecentProjects) and cannot be removed directly — hiding a workspace just
 * filters it out of that list, persisted in localStorage so the choice
 * survives reloads. Sessions/files are untouched.
 *
 * Key + event name are a shared contract with the extension that manages the
 * list (session-manager writes it; core reads it and reacts to the change
 * event so the sidebar dropdown re-filters immediately).
 */

export const HIDDEN_WORKSPACES_KEY = "pi-web:hidden-workspaces";
export const WORKSPACES_CHANGED_EVENT = "pi-web:workspaces-changed";

function readRaw(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HIDDEN_WORKSPACES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Hidden workspace root paths (stable, normalized). */
export function loadHiddenWorkspaces(): Set<string> {
  return new Set(readRaw());
}

/**
 * Replace the whole hidden list. Persists + dispatches WORKSPACES_CHANGED_EVENT
 * so any open sidebar re-filters immediately (cross-tab via storage event too).
 */
export function saveHiddenWorkspaces(roots: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HIDDEN_WORKSPACES_KEY, JSON.stringify([...new Set(roots)]));
  } catch {
    // storage unavailable — best-effort
  }
  try {
    window.dispatchEvent(new Event(WORKSPACES_CHANGED_EVENT));
  } catch { /* noop */ }
}

/** Toggle one workspace's hidden state; returns the new hidden set. */
export function toggleHiddenWorkspace(root: string): Set<string> {
  const next = loadHiddenWorkspaces();
  if (next.has(root)) next.delete(root);
  else next.add(root);
  saveHiddenWorkspaces([...next]);
  return next;
}

export const EXT = "aiti-codehub";
export const WORKITEMS_KEY = `${EXT}:workitems`;
export const CODE_KEY = `${EXT}:code`;
export const DETAIL_KEY = `${EXT}:workitem-detail`;
export const SETTINGS_KEY = `${EXT}:settings`;
export const MR_KEY = `${EXT}:mr`;
export const CLONE_KEY = `${EXT}:clone`;
export const REPO_KEY = `${EXT}:repo-workspace`;
export const HUB_SOURCE_ID = "codehub";
export const CHANGE_EVENT = "aiti-codehub:changed";
/** id of the work-item pick overlay in the dialogs slot (cross-extension service face). */
export const PICK_DIALOG_ID = "workitem-pick";

/* localStorage keys: selected account (instance id) per surface */
export const PROVIDER_KEY = "pi-codehub:provider";
export const SETTINGS_PROVIDER_KEY = "pi-codehub:settings-provider";
/** Collapsed/expanded state of a platform group in the instance picker. */
export const groupOpenKey = (platform: string): string => `pi-codehub:group-open:${platform}`;
/** Collapsed/expanded state of a namespace group in the work-items scope tree. */
export const scopeTreeOpenKey = (provider: string): string => `pi-codehub:scope-tree-open:${provider}`;
/** Last namespace selection per provider (repositories surface). */
export const codeNsKey = (provider: string): string => `pi-codehub:code-ns:${provider}`;
/** Last opened repo per provider (repo workspace restores it on reopen). */
export const repoWsKey = (provider: string): string => `pi-codehub:repo-ws:${provider}`;

/* ── remembered scope per provider, shared by the work-items surface and the
 *    pick dialog (workitem-picker) so both open the same project/repo ── */

export interface StoredScope { id: string; label: string; kind: "project" | "repo" }

export const scopeKey = (provider: string): string => `pi-codehub:scope:${provider}`;

/** Remembered scope: id + label + kind, so reopening restores the exact
 * project/repo even when it is not in the first list page. */
export function readStoredScope(provider: string): StoredScope | null {
  const raw = (() => { try { return localStorage.getItem(scopeKey(provider)); } catch { return null; } })();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredScope>;
    if (parsed && typeof parsed.id === "string" && parsed.id) {
      return { id: parsed.id, label: typeof parsed.label === "string" ? parsed.label : parsed.id, kind: parsed.kind === "repo" ? "repo" : "project" };
    }
  } catch { /* legacy bare-id format falls through */ }
  /* legacy format: a bare id */
  return { id: raw, label: raw, kind: "project" };
}

export function writeStoredScope(provider: string, s: StoredScope): void {
  try { localStorage.setItem(scopeKey(provider), JSON.stringify(s)); } catch { /* ignore */ }
}

/**
 * DirectoryPicker — the one "pick a folder" dialog for every extension surface.
 *
 * Why shared: aiti-folder's hand-rolled `DirectoryBrowser` (bare list + arrow per row,
 * title "Custom path…") outlived the host's move to the Explorer-style picker, so the
 * same product showed two different folder dialogs (the sidebar "add folder" flow used
 * the new one, the folder dock's "Custom path…" still opened the old one). Consumers now
 * bind this module to their own host-shim instead of shipping a third variant.
 *
 * Shape (same as the host picker): Explorer-style breadcrumb (every segment navigates,
 * Alt+D / Ctrl+L / typing enters edit mode, copy button) + drive list at the roots +
 * folder list + "New folder" row + Cancel / Select-this-folder footer.
 *
 * Host-agnostic by construction: every host facility arrives through `host` (basePath
 * URL builder, i18n resolver, portal, cross-extension service reader) because each
 * consuming extension bundles its own host-shim copy. React hooks resolve through the
 * consumer's `react` → host-shim alias, exactly like the other _shared components.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { dismissOnBack, type OverlayBackService } from "./overlay-back-client";
import { DIRECTORY_PICKER_ATTR } from "./directory-picker-dom";
import { PathBreadcrumb } from "./path-breadcrumb";

export interface DirectoryPickerHost {
  /** Base-path aware URL builder from the consuming extension's host-shim. */
  apiUrl: (path: string) => string;
  /** i18n resolver: the component dictionary first (directoryPicker.* keys), host t fallback. */
  t: (key: string, params?: Record<string, unknown>) => string;
  /** Read a cross-extension client service (used for the mobile back-dismiss layer). */
  getExtService?: (key: string) => unknown;
  /** Host portal (ctx.createPortal); absent → the fixed overlay renders in place. */
  createPortal?: (children: unknown, container: Element | DocumentFragment) => unknown;
  /** Create-folder endpoint. Defaults to aiti-folder's filesystem write outlet. */
  createFolderUrl?: string;
}

/** Re-exported so consumers have one import for the dialog and its DOM contract; the predicate
 *  itself lives in ./directory-picker-dom (JSX-free) for callers that only need the check. */
export { DIRECTORY_PICKER_ATTR, isDirectoryPickerTarget } from "./directory-picker-dom";

export interface DirectoryPickerProps {
  onCancel: () => void;
  onSelect: (path: string) => void;
  initialPath?: string;
  /** Caller-side work in flight: every action is disabled while true. */
  busy?: boolean;
  /** Caller-side error line (e.g. the server rejected the picked folder). */
  error?: string | null;
}

interface DirectoryEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  path?: string;
  parentPath?: string | null;
  directories?: DirectoryEntry[];
  drives?: DirectoryEntry[];
  error?: string;
}

const DEFAULT_CREATE_FOLDER_URL = "/api/extensions/aiti-folder/create-folder";

async function loadDirectories(host: DirectoryPickerHost, directory?: string): Promise<BrowseResponse> {
  // The path travels in the body, not the URL (keeps it out of tunnel/proxy access logs).
  const response = await fetch(host.apiUrl("/api/cwd/browse"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: directory ?? undefined }),
  });
  const data = await response.json() as BrowseResponse;
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

/** New folder: reuses aiti-folder's filesystem write outlet (the core files API has no mkdir;
 *  that endpoint does the realpath escape check + allowed-roots sandbox). Returns the created path. */
async function createFolder(host: DirectoryPickerHost, directory: string, name: string): Promise<string> {
  const response = await fetch(host.apiUrl(host.createFolderUrl ?? DEFAULT_CREATE_FOLDER_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: directory, name }),
  });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; path?: string; error?: string };
  if (!response.ok || !data.ok || !data.path) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data.path;
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M1.5 3h4l1.5 2h7.5v7.5h-13z" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <path d="M1.5 3h4l1.5 2h7.5v7.5h-13z" />
      <path d="M8 7v3.5M6.25 8.75h3.5" />
    </svg>
  );
}

function DriveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 9h12" />
      <circle cx="11.5" cy="11" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function isWindowsDriveRoot(directory: string): boolean {
  return /^[a-zA-Z]:[\\/]?$/.test(directory);
}

export function DirectoryPicker(props: DirectoryPickerProps & { host: DirectoryPickerHost }) {
  const { host, onCancel, onSelect, initialPath, busy = false, error } = props;
  const t = host.t;
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [parentDirectory, setParentDirectory] = useState<string | null>(null);
  const [pathEditing, setPathEditing] = useState(false);
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [drives, setDrives] = useState<DirectoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderBusy, setNewFolderBusy] = useState(false);
  const [newFolderError, setNewFolderError] = useState<string | null>(null);

  const navigateTo = useCallback(async (directory?: string) => {
    setLoading(true);
    setLoadError(null);
    // A navigation moves the new-folder target: collapse its row (a name typed for the old
    // folder would create elsewhere).
    setNewFolderOpen(false);
    setNewFolderError(null);
    try {
      const data = await loadDirectories(host, directory);
      const nextPath = data.path ?? directory ?? "/";
      setCurrentPath(nextPath);
      setParentDirectory(data.parentPath ?? null);
      setDirectories(data.directories ?? []);
      setDrives(data.drives ?? null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [host]);

  useEffect(() => {
    setPortalTarget(document.body);
    void navigateTo(initialPath || undefined);
  }, [initialPath, navigateTo]);

  const canSelect = Boolean(currentPath) && !busy && !loading && !pathEditing;
  const canNavigateUp = Boolean(parentDirectory) || isWindowsDriveRoot(currentPath);
  // The new folder lands in the listed folder: no write while the bar is being edited
  // (the edit may commit a different folder) and none in the drive-list view.
  const canCreateFolder = Boolean(currentPath) && drives === null && !loading && !busy && !pathEditing;
  const canSubmitNewFolder = canCreateFolder && !newFolderBusy && Boolean(newFolderName.trim());

  const submitNewFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name || newFolderBusy || !canCreateFolder) return;
    setNewFolderBusy(true);
    setNewFolderError(null);
    try {
      const created = await createFolder(host, currentPath, name);
      setNewFolderName("");
      await navigateTo(created); // open the new folder (going up returns to its parent)
    } catch (cause) {
      setNewFolderError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setNewFolderBusy(false);
    }
  }, [canCreateFolder, currentPath, host, navigateTo, newFolderBusy, newFolderName]);

  const handleNewFolderSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitNewFolder();
  };

  // Mobile system back = cancel (ignored while busy; same wiring as the host picker).
  const busyRef = useRef(busy);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const cancelRef = useRef(onCancel);
  useEffect(() => { cancelRef.current = onCancel; }, [onCancel]);
  useEffect(() => dismissOnBack(
    () => host.getExtService?.("pi-web.overlayBack") as OverlayBackService | null | undefined,
    () => { if (!busyRef.current) cancelRef.current(); },
  ), [host]);

  if (!portalTarget) return null;

  const overlay = (
    <div
      className="directory-picker-backdrop"
      {...{ [DIRECTORY_PICKER_ATTR]: "1" }}
      role="dialog"
      aria-modal="true"
      aria-label={t("directoryPicker.selectDirectory")}
      onClick={(event: any) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      onKeyDown={(event: any) => {
        if (event.key === "Escape" && !busy) onCancel();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 2147483000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}
    >
      <div className="directory-picker-panel" style={{ width: 520, maxWidth: "calc(100vw - 16px)", height: "min(620px, calc(100dvh - 16px))", maxHeight: "calc(100dvh - 16px)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "var(--text)", fontWeight: 700, fontSize: 15 }}>{t("directoryPicker.selectDirectory")}</div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            title={t("i18n.close")}
            aria-label={t("i18n.close")}
            style={{ padding: "2px 6px", border: 0, background: "none", color: "var(--text-muted)", fontSize: 20, lineHeight: 1, cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}
          >
            ×
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <button className="directory-picker-back" type="button" onClick={() => void navigateTo(parentDirectory ?? undefined)} disabled={loading || !canNavigateUp} title={t("directoryPicker.goToParent")} aria-label={t("directoryPicker.goToParent")} style={{ width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: canNavigateUp ? "pointer" : "default", opacity: canNavigateUp ? 1 : 0.45 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
          <PathBreadcrumb
            value={currentPath}
            label={t("directoryPicker.directoryPath")}
            editLabel={t("directoryPicker.editPath")}
            editHint={t("directoryPicker.pathEditHint")}
            copyLabel={t("directoryPicker.copyPath")}
            copiedLabel={t("directoryPicker.copied")}
            placeholder={t("directoryPicker.pathPlaceholder")}
            disabled={loading || busy}
            autoFocus
            onNavigate={(path) => void navigateTo(path)}
            onEditingChange={setPathEditing}
            style={{ flex: 1 }}
          />
        </div>

        <div className="directory-picker-list" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px 10px" }}>
          {loading ? (
            <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.loadingDirectories")}</div>
          ) : drives !== null ? (
            <>
              {drives.length > 0 ? (
                drives.map((drive) => (
                  <button
                    key={drive.path}
                    className="directory-picker-entry"
                    type="button"
                    onClick={() => void navigateTo(drive.path)}
                    title={drive.path}
                    style={{ width: "100%", minHeight: 34, display: "flex", alignItems: "center", gap: 7, padding: "6px 8px", border: 0, borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-mono)", fontSize: 11 }}
                  >
                    <DriveIcon />
                    <span>{drive.name}</span>
                  </button>
                ))
              ) : (
                <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.noDrives")}</div>
              )}
            </>
          ) : directories.length > 0 ? (
            directories.map((entry) => (
              <button
                key={entry.path}
                className="directory-picker-entry"
                type="button"
                onClick={() => void navigateTo(entry.path)}
                title={entry.path}
                style={{ width: "100%", minHeight: 30, display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", border: 0, borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-mono)", fontSize: 11 }}
              >
                <FolderIcon />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
              </button>
            ))
          ) : (
            <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.noSubdirectories")}</div>
          )}
          {(loadError || error) && <div style={{ padding: "8px", color: "var(--danger, #dc2626)", fontSize: 11 }}>{loadError ?? error}</div>}
        </div>

        {newFolderOpen && (
          <form onSubmit={handleNewFolderSubmit} style={{ flexShrink: 0, padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label htmlFor="aiti-directory-new-folder" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>
                {t("directoryPicker.folderName")}
              </label>
              <input
                className="directory-picker-new-folder-name"
                id="aiti-directory-new-folder"
                type="text"
                value={newFolderName}
                placeholder={t("directoryPicker.folderName")}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                onChange={(event: any) => {
                  setNewFolderName(event.target.value);
                  setNewFolderError(null);
                }}
                onKeyDown={(event: any) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setNewFolderOpen(false);
                    setNewFolderError(null);
                  }
                }}
                style={{ minWidth: 0, flex: 1, height: 32, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 6, outline: "none", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12 }}
              />
              <button
                className="directory-picker-action"
                type="submit"
                disabled={!canSubmitNewFolder}
                style={{ minWidth: 58, height: 32, padding: "0 12px", border: 0, borderRadius: 6, background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 600, opacity: canSubmitNewFolder ? 1 : 0.6, cursor: canSubmitNewFolder ? "pointer" : "default" }}
              >
                {newFolderBusy ? t("directoryPicker.creating") : t("directoryPicker.create")}
              </button>
            </div>
            {newFolderError && <div style={{ paddingTop: 6, color: "var(--danger, #dc2626)", fontSize: 11 }}>{newFolderError}</div>}
          </form>
        )}

        <div className="directory-picker-footer" style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
          <button
            className="directory-picker-new-folder"
            type="button"
            onClick={() => {
              setNewFolderOpen(true);
              setNewFolderError(null);
            }}
            disabled={!canCreateFolder}
            title={t("directoryPicker.newFolderIn", { path: currentPath })}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "none", color: "var(--text-muted)", fontSize: 13, opacity: canCreateFolder ? 1 : 0.45, cursor: canCreateFolder ? "pointer" : "default" }}
          >
            <FolderPlusIcon />
            {t("directoryPicker.newFolder")}
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
            <button className="directory-picker-action" type="button" onClick={onCancel} disabled={busy} style={{ padding: "6px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "none", color: "var(--text-muted)", cursor: busy ? "default" : "pointer", fontSize: 13 }}>{t("i18n.cancel")}</button>
            <button
              className="directory-picker-action"
              type="button"
              onClick={() => onSelect(currentPath)}
              disabled={!canSelect}
              title={t("directoryPicker.selectCurrentDirectory")}
              style={{ padding: "6px 16px", border: 0, borderRadius: 6, background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 600, opacity: canSelect ? 1 : 0.6, cursor: canSelect ? "pointer" : "default" }}
            >
              {busy ? t("i18n.checking") : t("directoryPicker.selectThisFolder")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // Portal when the host offers one; an unbound shim (createPortal delegating to a missing
  // ctx returns null) falls back to the fixed overlay in place — the dialog must still open.
  const portaled = host.createPortal ? (host.createPortal(overlay, portalTarget) as any) : null;
  return portaled ?? overlay;
}

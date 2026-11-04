/**
 * sidebar/directory-picker —— 目录选择弹窗（宿主 components/DirectoryPicker.tsx 完整复制）。
 * CWD picker「自定义路径…」入口打开；portal 到 body 避开 transform 祖先。
 */
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { apiUrl, createPortal, getCtx, t } from "../host-shim";
import { dismissOnBack } from "../../../../_shared/overlay-back-client";

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

async function loadDirectories(directory?: string): Promise<BrowseResponse> {
  // path 走 body 不进 URL（防落入隧道/代理 access log）
  const response = await fetch(apiUrl("/api/cwd/browse"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: directory ?? undefined }),
  });
  const data = await response.json() as BrowseResponse;
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

/** 新建文件夹：复用 aiti-folder 的文件系统写出口（核心 files API 无 mkdir；该端点已做 realpath 逃逸校验 + allowed-roots 沙箱）。返回创建出的绝对路径。 */
async function createFolder(directory: string, name: string): Promise<string> {
  const response = await fetch(apiUrl("/api/extensions/aiti-folder/create-folder"), {
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

interface Props {
  onCancel: () => void;
  onSelect: (path: string) => void;
  initialPath?: string;
  busy?: boolean;
  error?: string | null;
}

export function DirectoryPicker({ onCancel, onSelect, initialPath, busy = false, error }: Props) {
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [parentDirectory, setParentDirectory] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState(initialPath ?? "");
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
    setNewFolderOpen(false); // 切目录即换新建落点——输入行随之收起（名字留着、目录已换会建错地方）
    setNewFolderError(null);
    try {
      const data = await loadDirectories(directory);
      const nextPath = data.path ?? directory ?? "/";
      setCurrentPath(nextPath);
      setParentDirectory(data.parentPath ?? null);
      setPathInput(nextPath);
      setDirectories(data.directories ?? []);
      setDrives(data.drives ?? null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPortalTarget(document.body);
    void navigateTo(initialPath || undefined);
  }, [initialPath, navigateTo]);

  const handlePathSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = pathInput.trim();
    if (candidate) void navigateTo(candidate);
  };
  const hasUncommittedPath = pathInput.trim() !== currentPath;
  const canSelect = Boolean(currentPath) && !hasUncommittedPath && !busy;
  const canNavigateUp = Boolean(parentDirectory) || isWindowsDriveRoot(currentPath);
  // 新建落点=已打开的当前目录：盘符列表视图无落点、路径框有未提交内容时落点含糊，都不开放写操作
  const canCreateFolder = Boolean(currentPath) && !hasUncommittedPath && drives === null && !loading && !busy;
  const canSubmitNewFolder = canCreateFolder && !newFolderBusy && Boolean(newFolderName.trim());

  const submitNewFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name || newFolderBusy || !canCreateFolder) return;
    setNewFolderBusy(true);
    setNewFolderError(null);
    try {
      const created = await createFolder(currentPath, name);
      setNewFolderName("");
      await navigateTo(created); // 直接进新目录（回上一级即回到父目录）
    } catch (cause) {
      setNewFolderError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setNewFolderBusy(false);
    }
  }, [canCreateFolder, currentPath, navigateTo, newFolderBusy, newFolderName]);

  const handleNewFolderSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitNewFolder();
  };

  // 小屏系统返回 = 取消选择（busy 中不关；与宿主 DirectoryPicker 同款接线）
  const busyRef = useRef(busy);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const cancelRef = useRef(onCancel);
  useEffect(() => { cancelRef.current = onCancel; }, [onCancel]);
  useEffect(() => dismissOnBack(
    () => (getCtx() as any)?.getExtService?.("pi-web.overlayBack"),
    () => { if (!busyRef.current) cancelRef.current(); },
  ), []);

  if (!portalTarget) return null;

  return createPortal(
    <div
      className="directory-picker-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t("directoryPicker.selectDirectory")}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onCancel();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}
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

        <form onSubmit={handlePathSubmit} style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <button className="directory-picker-back" type="button" onClick={() => void navigateTo(parentDirectory ?? undefined)} disabled={loading || !canNavigateUp} title={t("directoryPicker.goToParent")} aria-label={t("directoryPicker.goToParent")} style={{ width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: canNavigateUp ? "pointer" : "default", opacity: canNavigateUp ? 1 : 0.45 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
          <label htmlFor="sm-directory-path" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>
            {t("directoryPicker.directoryPath")}
          </label>
          <input
            className="directory-picker-path"
            id="sm-directory-path"
            type="text"
            value={pathInput}
            placeholder="/path/to/project or ~/project"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setPathInput(event.target.value);
              setLoadError(null);
            }}
            style={{ minWidth: 0, flex: 1, height: 36, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 6, outline: "none", background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12 }}
          />
          <button
            className="directory-picker-action"
            type="submit"
            disabled={loading || !pathInput.trim()}
            title={t("directoryPicker.goToDirectory")}
            style={{ minWidth: 58, height: 36, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: loading || !pathInput.trim() ? "default" : "pointer", opacity: loading || !pathInput.trim() ? 0.6 : 1 }}
          >
            {t("directoryPicker.go")}
          </button>
        </form>

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
          {(loadError || error) && <div style={{ padding: "8px", color: "#dc2626", fontSize: 11 }}>{loadError ?? error}</div>}
        </div>

        {newFolderOpen && (
          <form onSubmit={handleNewFolderSubmit} style={{ flexShrink: 0, padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label htmlFor="sm-directory-new-folder" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>
                {t("directoryPicker.folderName")}
              </label>
              <input
                className="directory-picker-new-folder-name"
                id="sm-directory-new-folder"
                type="text"
                value={newFolderName}
                placeholder={t("directoryPicker.folderName")}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setNewFolderName(event.target.value);
                  setNewFolderError(null);
                }}
                onKeyDown={(event) => {
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
                {newFolderBusy ? t("sidebar.creating") : t("sidebar.create")}
              </button>
            </div>
            {newFolderError && <div style={{ paddingTop: 6, color: "#dc2626", fontSize: 11 }}>{newFolderError}</div>}
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
            title={hasUncommittedPath ? t("directoryPicker.openBeforeSelecting") : t("directoryPicker.newFolderIn", { path: currentPath })}
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
              title={hasUncommittedPath ? t("directoryPicker.openBeforeSelecting") : t("directoryPicker.selectCurrentDirectory")}
              style={{ padding: "6px 16px", border: 0, borderRadius: 6, background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 600, opacity: canSelect ? 1 : 0.6, cursor: canSelect ? "pointer" : "default" }}
            >
              {busy ? t("i18n.checking") : t("directoryPicker.selectThisFolder")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    portalTarget,
  );
}

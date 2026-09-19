import type { FileViewerState } from "@/lib/file-viewer-state";
import type { Tab } from "./TabBar";

interface OpenFileTabInput {
  fileName: string;
  filePath: string;
  modeHint?: "diff";
  sourceSessionId?: string | null;
  tabId: string;
}

interface OpenFolderTabInput {
  folderName: string;
  folderPath: string;
  tabId: string;
}

export function openFileTab(tabs: Tab[], input: OpenFileTabInput): Tab[] {
  const existing = tabs.find((tab) => tab.id === input.tabId);
  if (!existing) {
    return [...tabs, {
      id: input.tabId,
      label: input.fileName,
      filePath: input.filePath,
      sourceSessionId: input.sourceSessionId,
      initialDisplayMode: input.modeHint,
      viewerState: input.modeHint ? {
        displayMode: input.modeHint,
        wrapLines: false,
        scrollTop: 0,
        scrollLeft: 0,
      } : undefined,
      viewerRevision: 0,
    }];
  }

  const sourceChanged = Boolean(
    input.sourceSessionId && existing.sourceSessionId !== input.sourceSessionId,
  );
  const sourceUnchanged = !sourceChanged;
  if (sourceUnchanged && !input.modeHint) return tabs;

  return tabs.map((tab) => {
    if (tab.id !== input.tabId) return tab;
    const next: Tab = { ...tab };
    if (sourceChanged) next.sourceSessionId = input.sourceSessionId;
    if (input.modeHint) {
      next.initialDisplayMode = input.modeHint;
      next.viewerState = {
        displayMode: input.modeHint,
        wrapLines: tab.viewerState?.wrapLines ?? false,
        scrollTop: 0,
        scrollLeft: 0,
      };
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    } else if (sourceChanged) {
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    }
    return next;
  });
}

export function saveFileViewerState(
  tabs: Tab[],
  tabId: string,
  viewerRevision: number,
  viewerState: FileViewerState,
): Tab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1 || (tabs[index].viewerRevision ?? 0) !== viewerRevision) return tabs;

  const next = [...tabs];
  next[index] = { ...next[index], viewerState };
  return next;
}

/**
 * Open (or reselect) a folder tab. Folder tabs are first-class: clicking an
 * already-open folder just reselects it (no state change needed). The root
 * path is mutable from inside the FolderViewer ("switch folder"), so a reopen
 * of the same path is a no-op.
 */
export function openFolderTab(tabs: Tab[], input: OpenFolderTabInput): Tab[] {
  const existing = tabs.find((tab) => tab.id === input.tabId);
  if (existing) return tabs; // already open — caller just selects it
  return [...tabs, {
    id: input.tabId,
    label: input.folderName,
    filePath: input.folderPath,
    kind: "folder",
  }];
}

/**
 * [Guard for the file-editor extension's lazy-materialization window] Whether this path is
 * currently alive as a dock face (the file-editor extension's file-dock instance list).
 * The file-editor extension is lazily loaded (clientImmediately:false): after a refresh
 * `window.__aitiEditor` is not mounted, but the face instance list is persistent localStorage —
 * while the file is still in the list, openFile must route to the face instead (openFileFace
 * after materialization) and must not land in a host tab, otherwise the editor materializes
 * and auto-presents its floating window before the host tab → the same file opens twice.
 *
 * Returns the instance path from the list (openFileFace uses it to build the face key, so it
 * exactly matches the existing face); null when no face is alive. The extension key shares its
 * name with INSTANCES_KEY in the file-editor extension's file-dock.tsx.
 */
export function findDormantFileFacePath(filePath: string): string | null {
  if (typeof localStorage === "undefined") return null;
  const norm = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "");
  const target = norm(filePath || "");
  if (!target) return null;
  let list: string[] = [];
  try {
    const raw = JSON.parse(localStorage.getItem("pi:sidebar-dock:files") ?? "[]");
    if (Array.isArray(raw)) list = raw.filter((x): x is string => typeof x === "string");
  } catch { return null; }
  return list.find((p) => norm(p) === target) ?? null;
}

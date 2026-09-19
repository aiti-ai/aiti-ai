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
 * [aiti-editor 懒物化窗口期守卫] 该 path 是否正以 dock face 形态存续（aiti-editor
 * file-dock 实例清单）。aiti-editor 是懒加载扩展（clientImmediately:false）：刷新后
 * `window.__aitiEditor` 未挂载，但 face 实例清单是持久 localStorage——清单里还有
 * 这个文件时，openFile 必须改道 face（物化后 openFileFace），不能落宿主 tab，
 * 否则编辑器物化 auto-present 面前浮窗 → 同一文件双开。
 *
 * 返回清单里的实例 path（openFileFace 用它构造 face key，保证与现存 face 精确相等）；
 * 无 face 存续返回 null。扩展键名与 aiti-editor file-dock.tsx 的 INSTANCES_KEY 同源。
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

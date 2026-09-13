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

export interface OpenImageTabInput {
  /** 图片 src（data URL / 会话图片 API URL / blob URL 等可直接喂给 <img> 的地址） */
  src: string;
  label: string;
  tabId: string;
}

/**
 * 图片预览 tab 的稳定 id：对 src 做 FNV-1a 散列——同一张图重复点击命中同一 tab
 * （聚焦而非新开），不同图各占一个 tab（可多开）。src 可能是 MB 级 data URL，全量
 * 扫一遍在点击路径上可接受；极小概率散列碰撞由 openImageTab 的 src 比对兜底（更新）。
 */
export function imageTabId(src: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    hash ^= src.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `image:${(hash >>> 0).toString(36)}`;
}

/**
 * Open (or update) an image preview tab. These tabs hold a direct image src
 * (message images have no disk path — data URLs / session image API URLs), so
 * unlike file tabs there is no FileViewer/watch machinery. Same id + different
 * src (hash collision or refreshed URL) updates the tab in place.
 */
export function openImageTab(tabs: Tab[], input: OpenImageTabInput): Tab[] {
  const existing = tabs.find((tab) => tab.id === input.tabId);
  if (!existing) {
    return [...tabs, {
      id: input.tabId,
      label: input.label,
      filePath: "", // 非磁盘路径——关闭/切换守卫据此跳过 aiti-editor 问询
      kind: "image",
      imageSrc: input.src,
    }];
  }
  if (existing.imageSrc === input.src && existing.label === input.label) return tabs;
  return tabs.map((tab) => (
    tab.id === input.tabId ? { ...tab, imageSrc: input.src, label: input.label } : tab
  ));
}

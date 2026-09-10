"use client";

import { FileViewer } from "./FileViewer";
import { ExtSlot } from "./ExtSlots";
import { TerminalPanelBridge } from "./TerminalPanelBridge";
import type { TerminalTab } from "./terminal-tab-state";
import type { Tab } from "./TabBar";
import type { FileViewerState } from "@/lib/file-viewer-state";
import { getFileName } from "@/lib/file-paths";

/**
 * 右栏内容区与拆出窗口共用的 tab 内容分派（aiti-float tab-detach 方案 §5.4）。
 *
 * host 差异仅三处 prop，其余完全一致：
 *  - watchEnabled（FileViewer）：panel = 右栏开合；window = 恒 true（窗口可见即活动）。
 *  - onMentionLines（FileViewer）：panel 仅右栏开启时接管；window 恒接管。
 *  - active（TerminalPanelBridge）：panel 宿主的 terminal 由 AppShell 常挂载 hidden 容器
 *    渲染（不经本组件）；window 宿主单渲染面恒 active。
 *
 * ⚠ 行为等价约定：本组件是右栏 JSX 的等价重构（tab-detach v0.6.0），改动渲染语义前
 * 先对照右栏原 JSX 回归基线（paneTabs 派生 / 关闭守卫 / viewerState 恢复链）。
 */

/** 宿主上下文打包（AppShell 既有 handler 原样透传；窗口壳与右栏共用同一份）。 */
export interface TabBodyCtx {
  cwd: string | null;
  gitRefreshKey: number;
  /** panel 宿主的右栏开合（watchEnabled/onMentionLines 依据）；window 宿主忽略。 */
  panelOpen: boolean;
  /** folder 分支打开文件的归属会话（file 分支用 tab 自带 sourceSessionId）。 */
  selectedSessionId: string | null;
  onStateChange: (tabId: string, viewerRevision: number, viewerState: FileViewerState) => void;
  onLineMention: (relativePath: string, startLine: number, endLine: number) => void;
  onAtMention: (relativePath: string, isDir: boolean) => void;
  openFile: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff"; select?: boolean }) => void;
  openFolder: (folderPath: string, folderName: string, options?: { select?: boolean }) => void;
  /** window 宿主 terminal：closing 收尾（AppShell handleTerminalClosed 原样透传；
   *  closing === "restart" 时由宿主原地换新 id——原生兜底层重启语义）。 */
  onTerminalClosed: (tab: TerminalTab) => void;
  /** window 宿主 terminal：原生兜底层重启/关闭失败（接管态由扩展自行处置，不经过此）。 */
  onTerminalRestart: (tabId: string) => void;
  onTerminalCloseError: (tabId: string) => void;
  onOpenShellTab: (cwd: string) => void;
}

export function TabBody({ tab, host, ctx }: { tab: Tab; host: "panel" | "window"; ctx: TabBodyCtx }) {
  if (tab.kind === "dock") {
    // 停靠 tab：ExtSlot only 只挂载激活的 dock item（item render 内经状态机 gate，
    // 非 docked → null，结构性防双开）。dock tab 不拆窗（双击 = present float），
    // 本分支仅 panel 宿主可达。
    return <ExtSlot name="rightFileDock" only={tab.id.slice(5)} />;
  }
  if (tab.kind === "folder") {
    return (
      <FileViewer
        key={tab.id}
        kind="folder"
        filePath={tab.filePath}
        cwd={ctx.cwd ?? undefined}
        sourceSessionId={ctx.selectedSessionId}
        gitRefreshKey={ctx.gitRefreshKey}
        watchEnabled={host === "window" ? true : ctx.panelOpen}
        onOpenFile={(filePath) => ctx.openFile(filePath, getFileName(filePath), { sourceSessionId: ctx.selectedSessionId })}
        onOpenFolder={(folderPath) => ctx.openFolder(folderPath, getFileName(folderPath))}
        onAtMention={ctx.onAtMention}
      />
    );
  }
  if (tab.kind === "terminal") {
    // panel 宿主不渲染（AppShell 常挂载容器负责）；window 宿主单渲染面（xterm 实例
    // 唯一性由「单渲染面」结构性保证——detach 期间右栏常挂载列表已把该 tab 摘除）。
    if (host === "panel") return null;
    return (
      <TerminalPanelBridge
        tab={{
          id: tab.id,
          cwd: tab.filePath,
          restored: tab.restored,
          closing: tab.closing === "restart" ? "restart" : tab.closing ? "close" : undefined,
        }}
        active
        onClosed={() => ctx.onTerminalClosed({
          id: tab.id,
          cwd: tab.filePath,
          closing: tab.closing === "restart" ? "restart" : "close",
        })}
        onRestart={() => ctx.onTerminalRestart(tab.id)}
        onCloseError={() => ctx.onTerminalCloseError(tab.id)}
        onOpenShellTab={ctx.onOpenShellTab}
      />
    );
  }
  return (
    <FileViewer
      key={`${tab.id}:${tab.viewerRevision ?? 0}`}
      filePath={tab.filePath}
      cwd={ctx.cwd ?? undefined}
      sourceSessionId={tab.sourceSessionId}
      gitRefreshKey={ctx.gitRefreshKey}
      initialDisplayMode={tab.initialDisplayMode}
      initialState={tab.viewerState}
      watchEnabled={host === "window" ? true : ctx.panelOpen}
      onStateChange={(viewerState) => ctx.onStateChange(tab.id, tab.viewerRevision ?? 0, viewerState)}
      onMentionLines={host === "window" || ctx.panelOpen ? ctx.onLineMention : undefined}
      onAtMention={ctx.onAtMention}
      onOpenFile={(filePath) => ctx.openFile(filePath, getFileName(filePath), { sourceSessionId: tab.sourceSessionId })}
    />
  );
}

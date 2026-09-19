"use client";

import { FileViewer } from "./FileViewer";
import { ExtSlot } from "./ExtSlots";
import { TerminalPanelBridge } from "./TerminalPanelBridge";
import type { TerminalTab } from "./terminal-tab-state";
import type { Tab } from "./TabBar";
import type { FileViewerState } from "@/lib/file-viewer-state";
import { getFileName } from "@/lib/file-paths";

/**
 * Tab content dispatch shared by the right-panel content area and detached windows
 * (tab-detach plan §5.4 of the floating-dialog extension).
 *
 * The host differences are only three props; everything else is identical:
 *  - watchEnabled (FileViewer): panel = right-panel open state; window = always true (a visible window is active).
 *  - onMentionLines (FileViewer): panel takes over only while the right panel is open; window always takes over.
 *  - active (TerminalPanelBridge): the panel host's terminal is rendered by AppShell in a
 *    permanently-mounted hidden container (not through this component); the window host has a
 *    single render surface and is always active.
 *
 * ⚠ Behavioral-equivalence contract: this component is an equivalent refactor of the
 * right-panel JSX (tab-detach v0.6.0); before changing render semantics, regression-check
 * against the original right-panel JSX baseline (paneTabs derivation / close guards /
 * viewerState restore chain).
 */

/** Bundled host context (AppShell's existing handlers passed through as-is; shared by the window shell and the right panel). */
export interface TabBodyCtx {
  cwd: string | null;
  gitRefreshKey: number;
  /** Right-panel open state of the panel host (basis for watchEnabled/onMentionLines); ignored by the window host. */
  panelOpen: boolean;
  /** Owning session for files opened via the folder branch (the file branch uses the tab's own sourceSessionId). */
  selectedSessionId: string | null;
  onStateChange: (tabId: string, viewerRevision: number, viewerState: FileViewerState) => void;
  onLineMention: (relativePath: string, startLine: number, endLine: number) => void;
  onAtMention: (relativePath: string, isDir: boolean) => void;
  openFile: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff"; select?: boolean }) => void;
  openFolder: (folderPath: string, folderName: string, options?: { select?: boolean }) => void;
  /** Window-host terminal: closing finalization (AppShell handleTerminalClosed passed through as-is;
   *  when closing === "restart" the host swaps in a fresh id in place — the native fallback layer's restart semantics). */
  onTerminalClosed: (tab: TerminalTab) => void;
  /** Window-host terminal: restart/close failure in the native fallback layer (the takeover state is handled by the extension itself and does not go through this). */
  onTerminalRestart: (tabId: string) => void;
  onTerminalCloseError: (tabId: string) => void;
  onOpenShellTab: (cwd: string) => void;
}

export function TabBody({ tab, host, ctx }: { tab: Tab; host: "panel" | "window"; ctx: TabBodyCtx }) {
  if (tab.kind === "dock") {
    // Dock tab: ExtSlot only mounts the active dock item (gated by the state machine inside
    // the item render — not docked → null, structurally preventing double-open). Dock tabs
    // are not detached (double-click = present float); this branch is reachable only from
    // the panel host.
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
    // Not rendered on the panel host (AppShell's permanently-mounted container handles it);
    // the window host has a single render surface (xterm instance uniqueness is structurally
    // guaranteed by that single render surface — during detach the right panel's
    // permanently-mounted list has already dropped this tab).
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
  // Defensive: legacy empty-path tabs (the image tab mechanism is gone; stale restore-chain
  // data) — do not render a dangling viewer
  if (!tab.filePath) return null;
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

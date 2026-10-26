"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, BlockingExtensionUiRequest, CustomMessage, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolResultMessage, UserMessage } from "@/lib/types";
import type { AttachedFile } from "@/hooks/useAgentSession";
import { normalizeCustomPanelLines } from "@/lib/ansi";
import { splitNoticeText } from "@/lib/notice-text";
import { EXTENSION_DIALOG_BASE_WIDTH, fitExtensionDialogWidth } from "@/lib/extension-dialog-fit";
import { apiUrl, withBasePath } from "@/lib/base-path";
import { useMoneySynced } from "@/lib/money";
import { dedupeFetch } from "@/lib/dedupe-fetch";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { collapsesProcessDetails, countToolCallBlocks, getDisplayableAssistantBlocks, hasAssistantAnswer, isHiddenCustomMessage, isMessageGroupAnchor, splitFinalAssistantBlocks } from "@/lib/message-display";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import { getFinalAnswerViews, keepWrittenFiles, type FinalAnswerViews } from "@/lib/turn-views";
import { buildQuotedSelection } from "@/lib/quoted-selection";
import { dropMentionText, splitDroppedItems, uploadFiles, type DroppedItem } from "@/lib/file-upload-client";
import { buildFileAtMentionsText } from "@/lib/file-fuzzy";
import { MessageView, estimateTokens } from "./MessageView";
import { SessionRequestCardHost } from "./SessionRequestSlot";
import { MarkdownBody } from "./MarkdownBody";
import { ChatInput, type AttachedImage, type ChatInputHandle } from "./ChatInput";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { ExtSlot, useExtSlotItems } from "./ExtSlots";
import { NewSessionWidgetZone, NewSessionWidgetsCustomize } from "./NewSessionWidgets";
import { hasExtRender } from "@/lib/ext-ui-store";
import type { NewSessionPreparer } from "@/hooks/new-session-preparers";
import type { PendingRecoveryItem, QueueEntry } from "@/lib/queue-store";
import { useRecoveryProviderItems, routeRecoveryResolve } from "@/lib/composer/recovery";
import { runSessionForkGates } from "@/lib/ext/fork-gates";
import { ExtensionStatusBar, ExtensionStatusToast } from "./ExtensionStatusBar";
import { AnsiText } from "./AnsiText";
import { useI18n } from "@/hooks/useI18n";
import { phaseLabel } from "@/lib/chat-phase-label";
import { useAgentSession, type AgentEndInfo, type NewSessionChoices, type NoticeItem } from "@/hooks/useAgentSession";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile, useIsCompact } from "@/hooks/useIsMobile";
import { useScrollbarVisibility } from "@/hooks/useScrollbarVisibility";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { AppUpdateResponse } from "@/lib/api-types";
import type { ToolEntry } from "@/lib/tool-presets";
import type { SettingsSection } from "@/lib/settings-navigation";
import { getHomeDir, subscribeHomeDir } from "@/lib/home-dir";
import { findChatScrollAnchor, type ChatScrollPosition } from "@/lib/chat-scroll-position";
import {
  captureScrollDistance,
  getNextVisibleCount,
  getPromptAnchorSpacerHeight,
  getVisibleRenderWindow,
  isScrollAtTail,
  restoreScrollTop,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";

// Initial render window: mount a full page at once. The mainstream approach is
// virtualization + overscan (2-3x the visible viewport); a narrow viewport fits
// roughly 6-10 messages, so 30 ≈ 3-4 screens with buffer (50 was too high, lowered).

interface Props {
  session: SessionInfo | null;
  searchTarget?: { sessionId: string; entryId: string; blockIndex?: number } | null;
  onSearchTargetHandled?: (target: { sessionId: string; entryId: string }) => void;
  initialScrollPosition?: ChatScrollPosition | null;
  onScrollPositionChange?: (sessionId: string, position: ChatScrollPosition) => void;
  sessionRunning?: boolean;
  newSessionCwd: string | null;
  /** New-session page workspace choice (the target cwd staged by AppShell; null = use
   *  the current workspace). Selecting does not switch the app workspace immediately —
   *  AppShell switches after the session is created (see handleSessionCreated). */
  newSessionWorkspace?: string | null;
  /** Workspace dropdown candidates for the new-session page (recent projects + current cwd; supplied by AppShell). */
  workspaceOptions?: Array<{ key: string; root: string }>;
  onNewSessionWorkspaceChange?: (cwd: string | null) => void;
  newSessionDraftKey: string | null;
  /** Shown above the composer while a fresh composer is still empty: where its session starts. */
  newSessionContextBar?: ReactNode;
  /** A fresh composer's model and reasoning picks, carried from the composer it replaces. */
  initialNewSessionChoices?: NewSessionChoices | null;
  onNewSessionChoicesChange?: (choices: NewSessionChoices) => void;
  onAgentEnd?: (end: AgentEndInfo) => void;
  onToolEnd?: (toolName: string) => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string) => void;
  /** External-session placeholder/alias ids resolved by the server into real composite ids (e.g. zcode:new-* → zcode:sess_*). */
  onSessionIdCanonicalized?: (previousId: string, canonicalId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void, locked: boolean) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  onSystemInfoLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  /** Register the stats refresher so AppShell can pull fresh stats (incl.
   *  contextUsage for idle sessions) when the session panel opens. */
  onSessionStatsRefresherRegister?: (fn: (() => void) | null) => void;
  /** Compaction control registration (AppShell session-info panel's tri-state compact
   *  button): when compact is undefined (no session / sessionCap("compact") fails) the
   *  panel button hides — same rule as ChatInput. */
  onCompactControlsRegister?: (controls: CompactControls | null) => void;
  /** Opens Settings on a section: a bare `/mcp` that pi's built-in MCP extension owns opens Settings › MCP. */
  onOpenSettings?: (section: SettingsSection) => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  /** Current display model changed (AppShell's session-info "remaining quota" section pins the current provider by this). */
  onDisplayModelChange?: (model: { provider: string; modelId: string } | null) => void;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** Files dropped onto the chat were written into the working directory. */
  onFilesUploaded?: () => void;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  /** Expose the queue-export resolver to the parent (AppShell export dialog). */
  onExportQueue?: (resolver: () => Promise<{ live: QueueEntry[]; recovery: QueueEntry[] } | null>) => void;
  onOpenSession?: (sessionId: string) => void;
  onAskInNewChat?: (prompt: string, sourceSessionId: string, sourceEntryId: string) => Promise<void>;
  quoteSelectionEnabled?: boolean;
  initialPrompt?: string;
  onInitialPromptConsumed?: () => void;
  /** Completion sound state + controls, owned by AppShell so tasks finishing in
   *  a non-active workspace can still ring. */
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  playDoneSound?: () => void;
  unlockAudio?: () => void;
}

/** Per-turn elapsed-time badge (mirrors zcode desktop's "working (xm ys)"): a purely
 *  local UI clock that refreshes every second, starting at this turn's agent_start
 *  (useAgentSession.runStartedAtRef); display logic only, no state polling/requests. */
function ElapsedBadge({ startedAt }: { startedAt: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const label = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
  return <span style={{ fontVariantNumeric: "tabular-nums" }}>({label})</span>;
}

const CHAT_MINIMAP_WIDTH = 36;
const CHAT_COLUMN_PADDING = 16;
const LAST_BACKEND_KEY = "pi-web:last-session-backend";
/** Option value prefix for extension entries (newSessionBackendOptions) in the
 *  new-session Backend dropdown. Selecting one runs the entry's action (e.g. opening
 *  ACP agent management) without changing the current backend selection. */
const BACKEND_EXT_OPTION_PREFIX = "__ext_opt__:";
/** Shared look for the new-session Workspace / Backend dropdowns. */
const NEW_SESSION_SELECT_STYLE: CSSProperties = {
  padding: "4px 8px",
  background: "var(--bg-hover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  fontFamily: "inherit",
  fontSize: 12,
  cursor: "pointer",
};

// One update check per page. Every fresh composer mounts the header again
// (each move of the new-session bar does), and a link that turned up late
// each time could push the bar onto a line of its own under the composer's
// eyes; from the second header on it is there in the first paint.
let appUpdateCheck: Promise<AppUpdateResponse | null> | null = null;
let appUpdateFound: AppUpdateResponse | null = null;

function checkAppUpdate(): Promise<AppUpdateResponse | null> {
  appUpdateCheck ??= fetch(apiUrl("/api/app-update"))
    .then(async (response) => {
      if (!response.ok) return null;
      const result = await response.json() as AppUpdateResponse;
      return result.updateAvailable && result.latestVersion && result.releaseUrl ? result : null;
    })
    .then((result) => {
      appUpdateFound = result;
      return result;
    })
    .catch(() => {
      // Update checks are best-effort and must not interrupt a new session;
      // a later header asks again.
      appUpdateCheck = null;
      return null;
    });
  return appUpdateCheck;
}

function NewSessionUpdateLink({
  label,
}: {
  label: (version: string) => string;
}) {
  const [update, setUpdate] = useState<AppUpdateResponse | null>(() => appUpdateFound);

  useEffect(() => {
    if (appUpdateFound) return;
    let cancelled = false;
    void checkAppUpdate().then((result) => {
      if (!cancelled && result) setUpdate(result);
    });
    return () => { cancelled = true; };
  }, []);

  if (!update) return null;
  const accessibleLabel = label(update.latestVersion);

  return (
    <a
      href={update.releaseUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={accessibleLabel}
      aria-label={accessibleLabel}
      onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        alignSelf: "center",
        gap: 3,
        minHeight: 32,
        minWidth: 0,
        padding: "0 4px",
        background: "transparent",
        borderRadius: 5,
        color: "var(--accent)",
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.2,
        textDecoration: "none",
        transition: "background 0.12s",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>v{update.latestVersion}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
        <path d="M7 17 17 7" />
        <path d="M7 7h10v10" />
      </svg>
    </a>
  );
}

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function ProcessDetailsGroup({ messageCount, toolCallCount, defaultExpanded = false, reveal = false, children, t }: { messageCount: number; toolCallCount: number; defaultExpanded?: boolean; reveal?: boolean; children: ReactNode; t: (key: string, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  useLayoutEffect(() => {
    if (reveal) setExpanded(true);
  }, [reveal]);
  const parts = [t("chat.processDetails"), `${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`];
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={expanded || reveal}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={expanded ? t("chat.collapseProcess") : t("chat.expandProcess")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </button>
      {(expanded || reveal) && (
        <div style={{ marginTop: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export interface CompactControls {
  compact?: () => void | Promise<void>;
  abort?: () => void;
  cancelQueue?: () => void;
  isCompacting: boolean;
  compactQueued: boolean;
}

/**
 * Permission-card input summary (permission UI contract, agent spec §6.1): prefer
 * key fields like command/path/url to build a one-line readable summary; object
 * inputs collapse their full JSON into the details view.
 */

export function ChatWindow({ session, searchTarget, onSearchTargetHandled, initialScrollPosition, onScrollPositionChange, sessionRunning, newSessionCwd, newSessionWorkspace = null, workspaceOptions = [], onNewSessionWorkspaceChange, newSessionDraftKey, newSessionContextBar, initialNewSessionChoices, onNewSessionChoicesChange, onAgentEnd, onToolEnd, onAttentionNeeded, onSessionCreated, onSessionForked, onSessionIdCanonicalized, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsChange, onSessionStatsPanelOpen, onSessionStatsRefresherRegister, onCompactControlsRegister, onOpenSettings, onContextUsageChange, onDisplayModelChange, onOpenFile, onFilesUploaded, onOpenSubagent, onExportQueue, onOpenSession, onAskInNewChat, quoteSelectionEnabled = false, initialPrompt, onInitialPromptConsumed, soundEnabled = true, onSoundToggle, playDoneSound = () => {}, unlockAudio }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const isCompact = useIsCompact();

  // ── Session backend selection (multi-agent frontend) ─────────────────────────
  // Shown only on the isNew welcome page; options come from /api/session-backends
  // (extension-registered backends appear automatically).
  // null = local pi (the default; absent from the list and needs no request).
  // The last chosen backend is kept in localStorage and preselected on the next new session.
  const [backendOptions, setBackendOptions] = useState<Array<{ type: string; label: string; agentKey?: string }>>([]);
  // Extension entries inside the new-session Backend dropdown (newSessionBackendOptions),
  // e.g. an ACP agent management entry. Declarative static items get meta.onClick wired
  // by the host forwarder after materialization; entries without onClick don't render
  // (nothing clickable in the dropdown).
  const backendExtraOptions = useExtSlotItems("newSessionBackendOptions")
    .filter((it) => typeof it.meta?.onClick === "function");
  // New-session welcome-page extension pickers (newSessionSelectors, rendered between
  // Workspace×Backend) and the pre-creation preparer pipeline (newSessionPreparers,
  // awaited in order inside ensureNewSession when the first message is sent — worktree
  // creation/checkout and every other write happens at that moment; the selection phase
  // has zero side effects).
  const hasNewSessionSelectors = useExtSlotItems("newSessionSelectors").some(hasExtRender);
  const newSessionPreparers: NewSessionPreparer[] = useExtSlotItems("newSessionPreparers")
    .filter((it) => typeof it.meta?.prepare === "function")
    .map((it) => ({ id: it.id, prepare: it.meta!.prepare as NewSessionPreparer["prepare"] }));
  // New-session welcome-page widget zones (newSessionWidgets, top/bottom render points)
  // + the customize-panel toggle. The Zone consumes slots and preferences itself
  // (lib/new-session-widgets.ts); this only holds panel visibility.
  const [nswCustomizeOpen, setNswCustomizeOpen] = useState(false);
  // Workspace path display: abbreviate the home directory as ~ (passive subscription,
  // no requests — it shortens automatically once another consumer fetches it).
  const [homeDir, setHomeDir] = useState<string | null>(() => getHomeDir());
  useEffect(() => {
    setHomeDir(getHomeDir());
    return subscribeHomeDir(setHomeDir);
  }, []);
  const workspaceLabel = (root: string) =>
    homeDir && root.startsWith(homeDir) ? `~${root.slice(homeDir.length)}` : root;
  const [sessionBackend, setSessionBackend] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_BACKEND_KEY) || null;
    } catch {
      return null;
    }
  });
  const completionNotificationsEnabled = session?.relation?.kind !== "subagent";

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const extensionDialogShownRef = useRef(false);
  const wrappedOnAgentEnd = useCallback((end: AgentEndInfo) => {
    // A run someone stopped did not finish anything.
    if (completionNotificationsEnabled && soundEnabledRef.current && !end.aborted) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.(end);
  }, [completionNotificationsEnabled, onAgentEnd]);

  // Stabilize the onEditContent reference so React.memo keeps history messages from re-rendering
  const handleEditContent = useCallback((message: UserMessage) => {
    chatInputRef?.current?.replaceMessage(message);
  }, [chatInputRef]);

  // Spacer heights measured/derived below (bottom composer + prompt anchor).
  // Reflected up-front so they can be passed into useAgentSession for
  // step-follow geometry.
  const [bottomComposerHeight, setBottomComposerHeight] = useState(0);
  const bottomComposerHeightRef = useRef(0);
  const promptAnchorSpacerHeightRef = useRef(0); // Always 0: step-follow is fully owned by smartFollowStep
  // Bottom "step eye-room" bottomEyeRoom: derived during render (see the scrollViewportH declaration), no longer effect+state.
  const initialScrollPositionRef = useRef(searchTarget ? null : initialScrollPosition ?? null);
  const [pendingScrollRestore, setPendingScrollRestore] = useState<Extract<ChatScrollPosition, { atBottom: false }> | null>(() => {
    const position = initialScrollPositionRef.current;
    return position && !position.atBottom ? position : null;
  });
  const [restoreAnchorReady, setRestoreAnchorReady] = useState(false);

  const {
    loading, error, messages, activeToolResults, entryIds, historyCursor, hasEarlierMessages, streamState,
    agentRunning, settling, bashRunning, pendingBash, aborting, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    modelsRefreshing, modelsRefreshable, refreshModels,
    followPaused,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, compactQueued, cancelCompactQueue, modelSwitchPending, displayModel: displayModelValue, sessionStats, modelSwitching,
    slashCommands, slashCommandsLoading, queuedMessages, sessionTasks,
    pendingRecovery, recoveryIsImport, resolveRecovery, exportQueueData, importQueueData, stageImport, moveQueuedMessage, convertQueuedMessage, recallQueuedMessage, requeueAt, removeQueuedMessage, queueTrash, restoreQueueItem, purgeQueueTrash, trashComposerInput, restoreComposerTrash,
    notices, extensionDialog, waitingExtensionDialogCount, extensionCustomUi, waitingExtensionCustomUiCount, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput, setNoticePaused,
    switchPermissionMode, sessionCapabilities, backendSource, backendUsage,
    sessionRequest, respondToSessionRequest,
    isAutoModelSelection,
    isAutoThinkingSelection,
    defaultModel,
    savedDefaultThinkingLevel,
    agentPhase,
    runStartedAtRef,
    isNew,
    sessionIdRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, promptAnchorActive,
    editEntryId, cancelEdit,
    showScrollToBottom, earlierTurnCount,
    handleSend, handleAbort, handleFork, handleForkNew, handleNavigate, handleEditFromStartSend, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    dismissCompactError,
    refreshSessionStats,
    handleSetDefaultModel, handleSetDefaultThinkingLevel,
    handleRecallQueue, handleContinueQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadSlashCommands, scrollToBottom, scrollUserMsgToTop,
    loadContext, activeLeafId, scrollToMessage, reloadCurrentSession, addNotice,
  } = useAgentSession({
    session, sessionRunning, newSessionCwd, newSessionBackend: sessionBackend, newSessionPreparers, newSessionDraftKey, initialNewSessionChoices, onNewSessionChoicesChange, onAgentEnd: wrappedOnAgentEnd, onToolEnd, onAttentionNeeded, onSessionCreated, onSessionForked, onSessionIdCanonicalized,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsPanelOpen,
    onOpenSettings,
    deferInitialScroll: Boolean(pendingScrollRestore),
    promptAnchorSpacerHeightRef,
    bottomComposerHeightRef,
  });

  // FX rates: only subscribe/fetch when the floating bar actually has a USD cost to show (/api/fx is pulled on demand).
  useMoneySynced((backendUsage?.costUsd ?? 0) > 0);

  // ── Stop pending state: immediate feedback on click (zcode session/stop once took up
  // to 23s; the backend is now fire-and-forget). "Stopping" is owned by useAgentSession
  // and auto-resets when the current turn settles (agent_end / full settle / bash stop).
  // Deliberately NOT tied to agentRunning: after an abort, a queued follow-up turn
  // re-sets running immediately (stop only halts the current message; the queue moves
  // on), so waiting for "fully idle" to reset would leave "stopping" stuck forever
  // (observed 2026-09). ──
  const handleAbortRequest = useCallback(() => {
    void handleAbort(); // handleAbort already sets aborting=true internally and swallows+logs errors; it does not throw
  }, [handleAbort]);

  // ── Capability-aware control gating ──────────────────────────────────────
  // Backend sessions hide unsupported features per capabilities; local sessions
  // (no capabilities) pass everything through.
  const sessionCap = useCallback(<K extends string>(k: K, fallback = true): boolean =>
    sessionCapabilities ? (sessionCapabilities[k] ?? false) : fallback,
  [sessionCapabilities]);

  // Expose the queue-export resolver to the parent (AppShell export dialog).
  useEffect(() => {
    onExportQueue?.(exportQueueData);
  }, [onExportQueue, exportQueueData]);

  // Register the stats refresher (AppShell pulls fresh stats when the session
  // panel opens — idle sessions have no live state to read contextUsage from).
  useEffect(() => {
    onSessionStatsRefresherRegister?.(() => { void refreshSessionStats(); });
    return () => onSessionStatsRefresherRegister?.(null);
  }, [onSessionStatsRefresherRegister, refreshSessionStats]);

  // Compaction control registration: mirrored after the onSessionStatsRefresherRegister
  // precedent, registered back to AppShell (session-info panel button); state tracks
  // isCompacting / compactQueued live.
  const compactControls = useMemo(() => ({
    compact: session || isNew
      ? (sessionCap("compact") ? handleCompact : undefined)
      : undefined,
    abort: handleAbortCompaction,
    cancelQueue: cancelCompactQueue,
    isCompacting,
    compactQueued,
  }), [session, isNew, sessionCap, handleCompact, handleAbortCompaction, cancelCompactQueue, isCompacting, compactQueued]);
  useEffect(() => {
    onCompactControlsRegister?.(compactControls);
    return () => onCompactControlsRegister?.(null);
  }, [onCompactControlsRegister, compactControls]);
  const sessionBusy = agentRunning || bashRunning;
  // The "stopping" state reset now lives in useAgentSession (reset at agent_end /
  // settle / bash completion), see handleAbort and the settlement points — this no
  // longer depends on sessionBusy (it stays true while queued turns continue).

  // ── Manual refresh for stopped sessions (2026-09-15): a quiet "refresh" entry at the
  // very bottom of the message flow. Scenario: the session is stopped but may have been
  // advanced externally (zcode desktop/CLI continuing the same session outside this
  // app; the reused handle holds a stale in-memory history) — one click re-pulls
  // messages and re-aligns state with the source. ──
  const [refreshing, setRefreshing] = useState(false);
  const handleManualRefresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    void reloadCurrentSession().finally(() => setRefreshing(false));
  }, [refreshing, reloadCurrentSession]);
  const [quotedSelection, setQuotedSelection] = useState<{
    text: string;
    top: number;
    left: number;
    sourceEntryId?: string;
  } | null>(null);
  const [quoteInputOpen, setQuoteInputOpen] = useState(false);
  const [quoteSubmitting, setQuoteSubmitting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const quotePopoverRef = useRef<HTMLDivElement | null>(null);
  const quoteChatInputRef = useRef<ChatInputHandle | null>(null);
  const closeQuotedSelection = useCallback(() => {
    setQuotedSelection(null);
    setQuoteInputOpen(false);
    setQuoteError(null);
  }, []);

  useEffect(() => {
    if (!quoteSelectionEnabled) closeQuotedSelection();
  }, [quoteSelectionEnabled, closeQuotedSelection]);

  const captureQuotedSelection = useCallback(() => {
    if (!quoteSelectionEnabled || quoteInputOpen) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const root = messageContentRef.current;
    if (!selection || selection.isCollapsed || !range || !root || !root.contains(range.commonAncestorContainer)) {
      setQuotedSelection(null);
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      setQuotedSelection(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer as Element
      : range.commonAncestorContainer.parentElement;
    const start = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer as Element
      : range.startContainer.parentElement;
    const end = range.endContainer.nodeType === Node.ELEMENT_NODE
      ? range.endContainer as Element
      : range.endContainer.parentElement;
    const sourceEntryId = [ancestor, start, end]
      .map((element) => element?.closest<HTMLElement>("[data-message-role=\"assistant\"]")?.dataset.entryId)
      .find((entryId): entryId is string => Boolean(entryId));
    setQuotedSelection({
      text,
      top: Math.min(window.innerHeight - 44, rect.bottom + 8),
      left: Math.max(64, Math.min(window.innerWidth - 64, rect.left + rect.width / 2)),
      sourceEntryId,
    });
  }, [quoteSelectionEnabled, quoteInputOpen]);

  useEffect(() => {
    if (!quoteInputOpen || !quotedSelection) return;
    quoteChatInputRef.current?.insertIfEmpty(buildQuotedSelection(
      quotedSelection.text,
      t("chat.quoteIntro"),
      t("chat.quoteQuestion"),
    ));
  }, [quoteInputOpen, quotedSelection, t]);

  useLayoutEffect(() => {
    const popover = quotePopoverRef.current;
    if (!popover || !quotedSelection) return;
    const viewport = window.visualViewport;
    const position = () => {
      const rect = popover.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      popover.style.top = `${Math.max(top + 8, Math.min(quotedSelection.top, top + (viewport?.height ?? window.innerHeight) - rect.height - 8))}px`;
      popover.style.left = `${Math.max(left + 8, Math.min(quotedSelection.left - rect.width / 2, left + (viewport?.width ?? window.innerWidth) - rect.width - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(popover);
    window.addEventListener("resize", position);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [quotedSelection, quoteInputOpen, quoteError]);

  useEffect(() => {
    if (!quotedSelection) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!quoteInputOpen && !quotePopoverRef.current?.contains(event.target as Node)) closeQuotedSelection();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (!quoteSubmitting) closeQuotedSelection();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [quotedSelection, quoteInputOpen, quoteSubmitting, closeQuotedSelection]);

  const askSelectionHere = useCallback(() => {
    if (!quotedSelection) return;
    chatInputRef?.current?.insertText(buildQuotedSelection(
      quotedSelection.text,
      t("chat.quoteIntro"),
      t("chat.quoteQuestion"),
    ));
    // No `removeAllRanges()` here: inserting focuses the composer, and that
    // focus already collapses the page's selection. Calling it afterwards also
    // clears the composer's own selection and drops its caret to offset 0
    // (#1319), so the quote would be typed in front of instead of after.
    closeQuotedSelection();
  }, [chatInputRef, quotedSelection, closeQuotedSelection, t]);

  const askSelectionInNewChat = useCallback(async (prompt: string) => {
    const sourceSessionId = sessionIdRef.current ?? session?.id;
    if (quoteSubmitting || !prompt.trim() || !quotedSelection?.sourceEntryId || !sourceSessionId || !onAskInNewChat) return;
    setQuoteSubmitting(true);
    setQuoteError(null);
    unlockAudio?.();
    try {
      await onAskInNewChat(
        prompt,
        sourceSessionId,
        quotedSelection.sourceEntryId,
      );
      closeQuotedSelection();
    } catch (error) {
      quoteChatInputRef.current?.restoreSubmission(prompt);
      setQuoteError(error instanceof Error ? error.message : String(error));
    } finally {
      setQuoteSubmitting(false);
    }
  }, [onAskInNewChat, quotedSelection, quoteSubmitting, session?.id, sessionIdRef, closeQuotedSelection, unlockAudio]);

  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    if (loading || error || !initialPrompt || initialPromptSentRef.current) return;
    initialPromptSentRef.current = true;
    onInitialPromptConsumed?.();
    void handleSend(initialPrompt);
  }, [initialPrompt, loading, error, handleSend, onInitialPromptConsumed]);

  // ── "Edit from here" pending-send marker (frontend-only, takes effect on send) ────────
  // Click: prefill the composer + highlight the message + button becomes "cancel";
  // nothing moves in place, no backend operations.
  // Cancel / navigate away / refresh: auto-restore (state dies with unmount; suppressDraft
  // guarantees nothing lands in the draft).
  // Send: handleSendWrapped first navigates back (navigate_tree; first message → rebuild
  // from root), then sends normally.
  const [editFromHerePending, setEditFromHerePending] = useState<{
    entryId: string;
    /** Rewind target: normally the previous assistant entryId; for the first message, the message's own entryId */
    targetId: string;
    /** Leaf loaded after rewinding (null for the first message) */
    leafId: string | null;
  } | null>(null);
  const editFromHerePendingRef = useRef(editFromHerePending);
  editFromHerePendingRef.current = editFromHerePending;

  // Branch navigation (BranchNavigator/context links) moves the view → the pending
  // "edit from here" marker is invalidated and auto-cancelled (otherwise sending would
  // force a rewind to the marked position, overriding the branch the user just navigated to).
  // The send path is unaffected: handleSendWrapped clears pending before rewinding;
  // setState(null) here is idempotent.
  useEffect(() => {
    setEditFromHerePending(null);
  }, [activeLeafId]);

  // Marking (clicking "edit from here"): don't overwrite when the composer has text and no
  // marker exists (same contract as replaceMessage's canRestore); with an existing marker,
  // clear the old prefill first then mark the new one (leftover text from the previous
  // target would make replaceMessage silently fail).
  // Pre-gate (AI-change handling): edit-from-here = rewind to that branch point and resend →
  // an extension (e.g. the git-history extension's three revert options) first lets the user
  // decide whether to roll back file changes in that range; cancelling aborts the marking
  // (forking a new session doesn't touch the original one, so the gate doesn't apply).
  const handleEditFromHereMark = useCallback(async (entryId: string, message: UserMessage, branchPointId: string | null) => {
    // The quiet pre-check runs before the gate: with composer text and no marker we would
    // silently abort anyway — popping the revert gate first would waste the user's answer.
    const hasPending = editFromHerePendingRef.current != null;
    if (!hasPending && chatInputRef?.current?.hasInput?.()) return;
    const sid = sessionIdRef.current;
    if (sid) {
      // The cut-turn set = the edited message M plus every later user message entryId
      // (in session order) — the extension uses it to scope the rollback range precisely
      // (including the edited turn), not just ops after the entryId.
      // Find M's position in entryIds, then collect the role==="user" entryIds after it.
      let cutUserEntryIds: string[] = [];
      const mi = entryIds.indexOf(entryId);
      if (mi >= 0) {
        for (let i = mi; i < messages.length; i++) {
          if (messages[i]?.role === "user" && entryIds[i]) cutUserEntryIds.push(entryIds[i]);
        }
      }
      const allowed = await runSessionForkGates({ sessionId: sid, entryId, position: "before", cutUserEntryIds });
      if (!allowed) return;
      // The revert gate is a non-modal overlay: the user may have typed while it was open — re-check to avoid clobbering a prefill (canRestore contract).
      if (!editFromHerePendingRef.current && chatInputRef?.current?.hasInput?.()) return;
    }
    if (hasPending) chatInputRef?.current?.clearInput?.();
    setEditFromHerePending({
      entryId,
      targetId: branchPointId ?? entryId,
      leafId: branchPointId,
    });
    handleEditContent(message);
  }, [chatInputRef, handleEditContent, sessionIdRef, messages, entryIds]);

  // Cancel: restore highlighting + clear the prefilled composer (clearInput also clears the draft)
  const handleCancelEditFromHere = useCallback(() => {
    setEditFromHerePending(null);
    chatInputRef?.current?.clearInput?.();
  }, [chatInputRef]);

  // Send: with a pending marker, rewind the session first (the point where it actually
  // takes effect), then send the edited message.
  // Bash commands (! prefix) don't trigger the rewind — the user just wants to run a
  // shell command; the marker stays for the next send.
  const handleSendWrapped = useCallback(async (message: string, images?: AttachedImage[], files?: AttachedFile[]) => {
    const pending = editFromHerePendingRef.current;
    if (pending) {
      if (message.trim().startsWith("!")) {
        await handleSend(message, images, files);
        return;
      }
      setEditFromHerePending(null);
      await handleEditFromStartSend(pending.targetId, pending.leafId, message, images);
      return;
    }
    await handleSend(message, images, files);
  }, [handleEditFromStartSend, handleSend]);
  const [recoveryDismissed, setRecoveryDismissed] = useState(false);
  /** "Continue" button: appears once the AI has fully stopped (no streaming) — clicking
   *  quickly sends a "continue" message to keep the agent running.
   *  Visible only while the agent is idle (ChatInput renders it only in the non-streaming
   *  branch). When the queue still has undelivered messages (e.g. restored after a restart
   *  but never continued), the queue is delivered instead (runAgentContinue path);
   *  only an empty queue sends a plain "continue". */
  const handleContinue = useCallback(() => {
    const queued = (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0);
    if (queued > 0) {
      void handleContinueQueue();
      return;
    }
    void handleSend(t("chat.continue"));
  }, [handleSend, handleContinueQueue, queuedMessages, t]);

  // Bottom "step eye-room": while the agent runs, pad the height (ch-120-composerH) so
  // smartFollowStep's "pin the last message bottom at 120px" never exceeds maxScrollTop
  // (lost when 19031a2 removed the spacer → steps got clamped flush to the bottom).
  // ch changes with the AI pane/window ⇒ tracked by ResizeObserver; the container may
  // mount late (empty session has no container on first paint) ⇒ the callback ref forwards
  // scrollContainerRef and bumps scReady so the RO re-attaches once the container appears.
  const [scReady, setScReady] = useState(0);
  const handleScrollBoxRef = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node;
    setScReady((n) => n + 1);
  }, [scrollContainerRef]);
  const [scrollViewportH, setScrollViewportH] = useState(0);
  useLayoutEffect(() => {
    const sc = scrollContainerRef.current;
    if (!sc) return;
    const update = () => setScrollViewportH(sc.clientHeight);
    update();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(sc);
    return () => ro?.disconnect();
  }, [scReady, scrollContainerRef]);
  // Bottom "step eye-room": while the agent runs, pad the height (ch-120-composerH) so
  // smartFollowStep's "pin the last message bottom at 120px" never exceeds maxScrollTop
  // (lost when 19031a2 removed the spacer → steps got clamped flush to the bottom).
  // Must be derived during render (effect+state will not do): handleSend optimistically
  // sets agentRunning + appends the user message in the same commit, and the send jump
  // (scrollUserMsgToTop) reads maxScrollTop in that commit's layout phase. If the padding
  // lands one beat late (the old effect version), maxScrollTop excludes the padding →
  // target clamps to the current position = no-op, the new message stays below the
  // viewport and later steps are suppressed by the 2s press guard → "nothing moves after
  // sending" (the root cause of step-follow breaking). The derived value lands in the
  // same commit as agentRunning, so the jump naturally sees a maxScrollTop that includes
  // the padding.
  // Loop guard: the padding does not change the flex-fixed clientHeight (the RO reads
  // it; unchanged value → setState bails).
  const bottomEyeRoom = agentRunning
    ? Math.max(0, scrollViewportH - 120 - bottomComposerHeight)
    : 0;

  /** Draft storage key for the active session (matches ChatInput's draftKey).
   *  New sessions MUST use newSessionDraftKey (which contains a unique per-creation
   *  draftId) instead of `new:<cwd>`: a shared cwd-level key would silently restore the
   *  previous new-session leftovers (even a single @) into every subsequent new session,
   *  and promoteNewSession's rekey would never line up. */
  const draftKey = session?.id ?? newSessionDraftKey ?? undefined;

  // Draft cluster moved out (defork P2): draft scanning/silent restore/dialog composition
  // are all taken over by the draft-keeper extension via the composer contract; core no
  // longer owns a draft store and only handles server-side queue recovery + ext routing.
  // Recovery items = server queue recovery + draft items from the extension provider
  // (the keeper).
  const extRecoveryItems = useRecoveryProviderItems() as PendingRecoveryItem[];
  const recoveryItems = [
    ...pendingRecovery,
    ...extRecoveryItems,
  ];

  // Recovery dialog resolution: ext: prefixed items route back to their provider
  // (the keeper decides restore/queue/discard itself); server items go through
  // resolveRecovery; continueRun triggers handleContinueQueue for pure-draft items.
  const handleResolveRecovery = useCallback(async (
    keep: string[],
    discard: string[],
    continueRun: boolean,
  ): Promise<PendingRecoveryItem[]> => {
    const extKept = keep.filter((id) => id.startsWith("ext:")).length;
    const routed = routeRecoveryResolve(keep, discard);
    const serverKeep = routed.kept;
    const serverDiscard = routed.discarded;
    if (serverKeep.length === 0 && serverDiscard.length === 0) {
      if (continueRun && extKept > 0) void handleContinueQueue();
      return pendingRecovery;
    }
    return resolveRecovery(serverKeep, serverDiscard, continueRun && serverKeep.length > 0);
  }, [pendingRecovery, resolveRecovery, handleContinueQueue]);

  // Reset dismissal whenever the session or its pending list changes identity.
  useEffect(() => {
    setRecoveryDismissed(false);
  }, [session?.id]);

  // After recovery/import resolution (pendingRecovery drops to zero), expand
  // the queue panel so the restored messages are visible immediately instead
  // of being hidden behind the auto-collapse threshold.
  const prevRecoveryCountRef = useRef(recoveryItems.length);
  useEffect(() => {
    if (recoveryItems.length === 0 && prevRecoveryCountRef.current > 0) {
      chatInputRef?.current?.expandQueue();
    }
    prevRecoveryCountRef.current = recoveryItems.length;
  }, [recoveryItems.length, chatInputRef]);

  // One sound when a dialog appears with none on screen. A dialog queued behind
  // another one surfaces the moment the user answers that one, so it stays quiet.
  useEffect(() => {
    const surfaced = Boolean(extensionDialog) && !extensionDialogShownRef.current;
    extensionDialogShownRef.current = Boolean(extensionDialog);
    if (!completionNotificationsEnabled || !surfaced) return;
    playDoneSoundRef.current();
  }, [completionNotificationsEnabled, extensionDialog]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbortRequest : null);
  }, [sessionBusy, handleAbortRequest]);

  // --- Scroll-to-earliest / scroll-to-latest floating buttons ---



  // --- Lazy-load historical messages ---
  // Only render the last N messages initially. When the user scrolls to the
  // top, load another page while keeping the scroll position stable.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_PAGE_SIZE);
  // State, not a ref: the sentinel can appear with nothing else changing (a
  // finished turn regrouped into more rows), and must get an observer then.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const messageContentRef = useRef<HTMLDivElement | null>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);
  const loadingOlderRef = useRef(false);
  const restoreStartedRef = useRef(false);
  const pendingScrollRestoreRef = useRef(pendingScrollRestore);
  pendingScrollRestoreRef.current = pendingScrollRestore;
  const [pendingSearchScroll, setPendingSearchScroll] = useState<Props["searchTarget"]>(null);
  const searchMessage = messages[entryIds.indexOf(pendingSearchScroll?.entryId ?? "")];
  const searchBlock = searchMessage?.role === "assistant"
    ? (pendingSearchScroll?.blockIndex === undefined
      ? searchMessage.content.find((block) => block.type === "text")
      : searchMessage.content[pendingSearchScroll.blockIndex])
    : undefined;
  const searchHistoryRef = useRef({ entryIds, historyCursor, hasEarlierMessages });
  searchHistoryRef.current = { entryIds, historyCursor, hasEarlierMessages };
  // The cursor of the older page asked for last, kept until the next cursor
  // renders: the page lands, and loadingOlderRef clears, a moment before that
  // render, and an observer report in between still holds this cursor.
  const requestedCursorRef = useRef<string | null>(null);
  const loadOlderPage = useCallback(async (sid: string, before: string, options?: { tail?: number; signal?: AbortSignal }) => {
    requestedCursorRef.current = before;
    const context = await loadContext(sid, activeLeafId, before, options);
    // Nothing landed, so the same page may be asked for again.
    if (!context && requestedCursorRef.current === before) requestedCursorRef.current = null;
    return context;
  }, [activeLeafId, loadContext]);
  useEffect(() => {
    // A reloaded history can come back to a cursor asked for before.
    if (historyCursor !== requestedCursorRef.current) requestedCursorRef.current = null;
  }, [historyCursor]);

  useLayoutEffect(() => {
    const sessionId = session?.id;
    const container = scrollContainerRef.current;
    const content = messageContentRef.current;
    if (!sessionId || !onScrollPositionChange || !container || !content) return;
    return () => {
      if (pendingScrollRestoreRef.current) return;
      if (isScrollAtTail(container.scrollTop, container.clientHeight, container.scrollHeight)) {
        onScrollPositionChange(sessionId, { atBottom: true });
        return;
      }
      const viewportTop = container.getBoundingClientRect().top;
      const candidates = Array.from(content.children).flatMap((element) => {
        if (!(element instanceof HTMLElement) || !element.dataset.entryId) return [];
        const rect = element.getBoundingClientRect();
        return [{ entryId: element.dataset.entryId, top: rect.top, bottom: rect.bottom }];
      });
      const anchor = findChatScrollAnchor(candidates, viewportTop);
      if (!anchor) return;
      onScrollPositionChange(sessionId, {
        atBottom: false,
        ...anchor,
        oldestEntryId: searchHistoryRef.current.historyCursor,
      });
    };
  }, [loading, onScrollPositionChange, scrollContainerRef, session?.id]);

  useEffect(() => {
    if (searchTarget) setPendingScrollRestore(null);
  }, [searchTarget]);

  useEffect(() => {
    const position = pendingScrollRestore;
    const sessionId = session?.id;
    if (!position || !sessionId || loading || searchTarget || restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    const controller = new AbortController();

    const locate = async () => {
      const initialHistory = searchHistoryRef.current;
      if (initialHistory.entryIds.includes(position.anchorEntryId)) {
        setVisibleCount((current) => Math.max(current, initialHistory.entryIds.length * 2));
        setRestoreAnchorReady(true);
        return;
      }

      loadingOlderRef.current = true;
      let before = initialHistory.historyCursor;
      let hasMore = initialHistory.hasEarlierMessages;
      try {
        while (hasMore && before && !controller.signal.aborted) {
          const context = await loadOlderPage(sessionId, before, { signal: controller.signal });
          if (controller.signal.aborted) return;
          if (!context) {
            scrollToBottom("instant");
            setPendingScrollRestore(null);
            return;
          }
          setVisibleCount((current) => current + Math.max(VISIBLE_PAGE_SIZE, context.messages.length * 2));
          if (context.entryIds.includes(position.anchorEntryId)) {
            setRestoreAnchorReady(true);
            return;
          }
          if (context.oldestEntryId === position.oldestEntryId) break;
          before = context.oldestEntryId;
          hasMore = context.hasMore;
        }
        if (!controller.signal.aborted) {
          scrollToBottom("instant");
          setPendingScrollRestore(null);
        }
      } finally {
        loadingOlderRef.current = false;
      }
    };

    void locate();
    return () => {
      controller.abort();
      // A branch change cancels restoration and must reveal the new context.
      setPendingScrollRestore(null);
    };
  }, [activeLeafId, loadOlderPage, loading, pendingScrollRestore, scrollToBottom, searchTarget, session?.id]);

  useLayoutEffect(() => {
    const position = pendingScrollRestore;
    const content = messageContentRef.current;
    if (!position || !content || searchTarget) return;
    const element = Array.from(content.children).find((candidate) => (
      candidate instanceof HTMLElement && candidate.dataset.entryId === position.anchorEntryId
    ));
    if (element instanceof HTMLElement) {
      scrollToMessage(element, position.anchorOffset);
      // [fork] messages render with content-visibility:auto (estimated 160px placeholders).
      // The first scroll lands against estimated heights above the anchor; once the real
      // blocks lay out, heights shift. Re-anchor one frame later to absorb the drift.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!element.isConnected) return;
        scrollToMessage(element, position.anchorOffset);
      }));
      setPendingScrollRestore(null);
      return;
    }
    if (restoreAnchorReady) {
      scrollToBottom("instant");
      setPendingScrollRestore(null);
    }
  }, [entryIds, pendingScrollRestore, restoreAnchorReady, scrollToBottom, scrollToMessage, searchTarget, visibleCount]);

  useEffect(() => {
    if (!searchTarget || loading) return;
    const controller = new AbortController();
    const locate = async () => {
      const history = searchHistoryRef.current;
      let found = history.entryIds.includes(searchTarget.entryId);
      if (!found && !sessionBusy && history.hasEarlierMessages && history.historyCursor && !loadingOlderRef.current) {
        loadingOlderRef.current = true;
        const container = scrollContainerRef.current;
        if (container) prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
        // ponytail: one extra page of 200 entries; deeper or other-branch hits just open the session.
        const context = await loadOlderPage(searchTarget.sessionId, history.historyCursor, { tail: 200, signal: controller.signal });
        loadingOlderRef.current = false;
        found = Boolean(context?.entryIds.includes(searchTarget.entryId));
      }
      if (controller.signal.aborted) return;
      if (found) {
        prevScrollDistanceRef.current = null;
        setVisibleCount((current) => Math.max(current, (searchHistoryRef.current.entryIds.length + 200) * 2));
        setPendingSearchScroll(searchTarget);
      } else {
        onSearchTargetHandled?.(searchTarget);
      }
    };
    void locate();
    return () => controller.abort();
  }, [searchTarget, loading, sessionBusy, loadOlderPage, onSearchTargetHandled, scrollContainerRef]);

  useLayoutEffect(() => {
    if (!pendingSearchScroll || pendingSearchScroll !== searchTarget) return;
    const selector = `[data-entry-id="${CSS.escape(pendingSearchScroll.entryId)}"]`;
    const element = scrollContainerRef.current?.querySelector<HTMLElement>(searchMessage?.role === "user" ? selector : `${selector} [data-search-target]`);
    if (element) {
      scrollToMessage(element);
      element.animate([
        { backgroundColor: "var(--bg-selected)" },
        { backgroundColor: "transparent" },
      ], { duration: 2500 });
    }
    setPendingSearchScroll(null);
    onSearchTargetHandled?.(pendingSearchScroll);
  }, [pendingSearchScroll, searchTarget, searchMessage, scrollContainerRef, scrollToMessage, onSearchTargetHandled]);

  // IntersectionObserver on the sentinel div at the top of the message list.
  // When it becomes visible, load the next page of older messages.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        // Skip while a page is already loading.
        if (loadingOlderRef.current) return;
        if (!hasEarlierMessages) {
          // Everything is loaded, yet the sentinel shows: the messages render as
          // more rows than the window holds (an answer and its thinking are
          // two), so widen the window. The observer is renewed with it, in case
          // the sentinel stays in view.
          prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
          setVisibleCount((current) => getNextVisibleCount(current));
          return;
        }
        // Fetch the previous page from the server and prepend it (loadContext
        // handles prepend + scroll anchoring).
        const oldestId = historyCursor;
        // Its page already landed; the next cursor has not rendered yet.
        if (!oldestId || oldestId === requestedCursorRef.current) return;
        const sid = session?.id ?? sessionIdRef.current;
        if (!sid) return;
        loadingOlderRef.current = true;
        prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
        void loadOlderPage(sid, oldestId).finally(() => {
          loadingOlderRef.current = false;
        });
      },
      { root: container, threshold: 0, rootMargin: "0px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, visibleCount, historyCursor, hasEarlierMessages, session, loadOlderPage, sessionIdRef, scrollContainerRef]);

  // Keep the rendered window at least as large as what's loaded, so prepended
  // (older) pages stay visible instead of being sliced off the top.
  useEffect(() => {
    setVisibleCount((current) => Math.max(current, messages.length));
  }, [messages.length]);

  // After visibleCount increases (more messages prepended), restore the
  // scroll position so the viewport doesn't jump.
  useEffect(() => {
    if (prevScrollDistanceRef.current == null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = restoreScrollTop(container.scrollHeight, prevScrollDistanceRef.current);
    prevScrollDistanceRef.current = null;
  }, [visibleCount, scrollContainerRef]);
  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
      sessionStats.totalActiveMs ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  const displayModelKey = displayModelValue ? `${displayModelValue.provider}:${displayModelValue.modelId}` : null;
  useEffect(() => {
    if (displayModelKey) {
      const [provider, ...rest] = displayModelKey.split(":");
      onDisplayModelChange?.({ provider, modelId: rest.join(":") });
    } else {
      onDisplayModelChange?.(null);
    }
  }, [displayModelKey, onDisplayModelChange]);
  useEffect(() => () => { onDisplayModelChange?.(null); }, [onDisplayModelChange]);

  // Images attach to the prompt. Other files go through the file explorer's
  // upload into the working directory, never replacing a file already there,
  // and come back as @mentions. The composer's attach button takes the same
  // path, for phones that cannot drop files.
  const uploadDroppedFiles = useCallback(async (files: File[]) => {
    const cwd = session?.cwd ?? newSessionCwd;
    if (!cwd) {
      addNotice({ type: "warning", message: t("chat.dropNeedsCwd") });
      return;
    }
    try {
      const { status, data } = await uploadFiles(cwd, files, "skip");
      if (status !== 200 && status !== 207) throw new Error(data.error ?? `HTTP ${status}`);
      const uploaded = data.uploaded ?? [];
      const skipped = data.skipped ?? [];
      const mentions = dropMentionText(files, [...uploaded, ...skipped]);
      if (mentions) chatInputRef?.current?.insertText(mentions);
      if (uploaded.length > 0) {
        addNotice({ type: "success", message: t("chat.dropUploaded", { count: uploaded.length }) });
        onFilesUploaded?.();
      }
      if (skipped.length > 0) {
        addNotice({ type: "warning", message: t("chat.dropAlreadyExists", { names: skipped.join(", ") }) });
      }
      for (const failure of data.errors ?? []) {
        addNotice({ type: "error", message: t("chat.dropFailed", { message: `${failure.name}: ${failure.error}` }) });
      }
    } catch (uploadError) {
      addNotice({ type: "error", message: t("chat.dropFailed", { message: uploadError instanceof Error ? uploadError.message : String(uploadError) }) });
    }
  }, [addNotice, chatInputRef, newSessionCwd, onFilesUploaded, session?.cwd, t]);

  const onDrop = useCallback((items: DroppedItem[]) => {
    const { images, files, folders } = splitDroppedItems(items);
    if (images.length > 0) chatInputRef?.current?.addImages(images);
    if (folders.length > 0) {
      addNotice({ type: "warning", message: t("chat.dropFoldersUnsupported", { names: folders.join(", ") }) });
    }
    if (files.length > 0) void uploadDroppedFiles(files);
  }, [addNotice, chatInputRef, t, uploadDroppedFiles]);

  // 📎 document attachments mean "show this to the session", not "add to my
  // project": they land in <cwd>/.pi-attachments (auto-created on the server,
  // git-invisible via its own `.gitignore` with `*`) and come back as @mentions
  // of the relative path. Drag-and-drop keeps the explicit upload-to-project
  // semantics (project root, sidebar upload is the same flow).
  const uploadAttachedFiles = useCallback(async (files: File[]) => {
    const cwd = session?.cwd ?? newSessionCwd;
    if (!cwd) {
      addNotice({ type: "warning", message: t("chat.dropNeedsCwd") });
      return;
    }
    try {
      const attachmentsDir = `${cwd.replace(/\/+$/, "")}/.pi-attachments`;
      const { status, data } = await uploadFiles(attachmentsDir, files, "skip", undefined, true);
      if (status !== 200 && status !== 207) throw new Error(data.error ?? `HTTP ${status}`);
      const uploaded = data.uploaded ?? [];
      const skipped = data.skipped ?? [];
      const mentions = buildFileAtMentionsText([...uploaded, ...skipped].map((name) => `.pi-attachments/${name}`));
      if (mentions) chatInputRef?.current?.insertText(mentions);
      if (uploaded.length > 0) {
        addNotice({ type: "success", message: t("chat.attachUploaded", { count: uploaded.length }) });
      }
      if (skipped.length > 0) {
        addNotice({ type: "warning", message: t("chat.attachAlreadyExists", { names: skipped.join(", ") }) });
      }
      for (const failure of data.errors ?? []) {
        addNotice({ type: "error", message: t("chat.dropFailed", { message: `${failure.name}: ${failure.error}` }) });
      }
    } catch (uploadError) {
      addNotice({ type: "error", message: t("chat.dropFailed", { message: uploadError instanceof Error ? uploadError.message : String(uploadError) }) });
    }
  }, [addNotice, chatInputRef, newSessionCwd, session?.cwd, t]);

  const onAttachFiles = useCallback((files: File[]) => {
    const { images, files: docs } = splitDroppedItems(files.map((file) => ({ kind: "file", file })));
    if (images.length > 0) chatInputRef?.current?.addImages(images);
    if (docs.length > 0) void uploadAttachedFiles(docs);
  }, [chatInputRef, uploadAttachedFiles]);

  // Local pi sessions (no backendSource/capabilities in get_state) and backends
  // without the fileAttachments capability have their prompt file attachments
  // dropped silently — route 📎 documents through the .pi-attachments upload
  // instead (onAttachFiles above).
  const docFilesToUpload = backendSource == null || !sessionCap("fileAttachments");

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const visibleMessages = messages.filter((m) => isMessageGroupAnchor(m) || m.role === "assistant");
  // Stable Map identity: `messages` doesn't change during streaming updates
  // (the streaming message lives in streamState), so memoized MessageViews
  // skip re-rendering on every message_update event. An inline `new Map()`
  // here used to defeat MessageView's memo() on each streamed chunk.
  const toolResultsMap = useMemo(() => {
    const map = new Map(activeToolResults);
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        map.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
      }
    }
    return map;
  }, [activeToolResults, messages]);
  // Same idea for the copies a grouped turn passes MessageView (see getFinalAnswerViews).
  const finalAnswerViewCache = useMemo(() => new WeakMap<AssistantMessage, FinalAnswerViews>(), []);
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);
  const messageRefs = useMessageRefs(visibleMessages.length);


  const revealHistoryForMinimap = useCallback(() => {
    setVisibleCount((current) => Math.max(current, messages.length * 2));
  }, [messages.length]);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;
  // Discover available backends (new-session welcome page only; extension-registered
  // backends appear automatically, and the selector doesn't render when there are none).
  useEffect(() => {
    if (!isNew || backendOptions.length > 0) return;
    let cancelled = false;
    // dedupeFetch: StrictMode double effect / remounts share one request (the backend list is stable; 2.5s micro-cache).
    dedupeFetch(apiUrl("/api/session-backends"))
      .then((r) => (r.ok ? r.json() : { providers: [] }))
      .then((d: { providers?: Array<{ type: string; label: string; agentKey?: string }> }) => {
        if (cancelled) return;
        setBackendOptions(d.providers ?? []);
        // Fall back to local pi when the remembered backend no longer exists (extension uninstalled/renamed)
        setSessionBackend((cur) => (cur && (d.providers ?? []).some((p) => p.type === cur) ? cur : null));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isNew, backendOptions.length]);
  useScrollbarVisibility(scrollContainerRef, Boolean(session?.id) || !isEmptyNew);
  const hasStreamingContent = Boolean(streamState.streamingMessage?.content.length);
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;
  const bottomComposerRef = useRef<HTMLDivElement | null>(null);
  const bottomComposerScrollFrameRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const composer = bottomComposerRef.current;
    if (!composer) {
      bottomComposerHeightRef.current = 0;
      setBottomComposerHeight(0);
      return;
    }

    const updateBottomComposerHeight = (height?: number) => {
      // The RO callback passes borderBoxSize (fires after layout, free to read); only the initial/no-arg call reads rect
      const nextHeight = Math.ceil(height ?? composer.getBoundingClientRect().height);
      if (bottomComposerHeightRef.current === nextHeight) return;

      const previousHeight = bottomComposerHeightRef.current;
      bottomComposerHeightRef.current = nextHeight;
      setBottomComposerHeight(nextHeight);

      if (bottomComposerScrollFrameRef.current !== null) {
        cancelAnimationFrame(bottomComposerScrollFrameRef.current);
      }
      bottomComposerScrollFrameRef.current = requestAnimationFrame(() => {
        bottomComposerScrollFrameRef.current = null;
        const currentContainer = scrollContainerRef.current;
        const distanceFromBottom = currentContainer
          ? currentContainer.scrollHeight - currentContainer.clientHeight - currentContainer.scrollTop
          : Number.POSITIVE_INFINITY;
        // Preserve a tail-pinned view while avoiding a jump for history readers.
        if (distanceFromBottom <= Math.abs(nextHeight - previousHeight) + 1) {
          scrollToBottom("auto");
        }
      });
    };
    updateBottomComposerHeight();

    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        updateBottomComposerHeight(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
      });
    observer?.observe(composer);
    return () => {
      observer?.disconnect();
      if (bottomComposerScrollFrameRef.current !== null) {
        cancelAnimationFrame(bottomComposerScrollFrameRef.current);
        bottomComposerScrollFrameRef.current = null;
      }
    };
  }, [error, isEmptyNew, loading, scrollContainerRef, scrollToBottom]);

  // Step-follow is fully owned by useAgentSession's smartFollowStep (useEffect
  // [streamState] → when content grows past the viewport, scrollTo back to 120px).
  // No promptAnchorSpacer here anymore: that spacer's math was independent of content
  // position (constant delta), constantly inflated the 3/4 blank space below the
  // viewport during streaming, and conflicted with smartFollowStep's target computation
  // (measured: constant 457px spacer + sparse steps + abrupt jump at the end).
  // Spacer constant 0 → smartFollowStep steps normally per screen and the last message
  // stays pinned at the viewport's top quarter.

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      sessionId={session?.id ?? null}
      onSend={handleSendWrapped}
      onAbort={handleAbortRequest}
      aborting={aborting}
      // Fork-new-session is only available for local pi sessions (non-empty
      // sessionCapabilities = external backend; the handle adapter has no fork_branch);
      // fresh draft sessions with nothing to copy don't wire it either.
      onForkNew={isNew || sessionCapabilities ? undefined : handleForkNew}
      // Steer needs a mid-run injection surface the backend actually has: gate it by
      // capability like setModel/compact do, otherwise the button appears on every
      // steer:false backend (qoder/codex/cursor/…) and silently enqueues a follow-up.
      onSteer={agentRunning && sessionCap("steer") ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onQueueFollowUp={handleFollowUp}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      onQueueSteerSend={sessionCap("steer") ? handleSteer : undefined}
      onConvertQueueItem={convertQueuedMessage}
      isStreaming={sessionBusy}
      canContinue={!isEmptyNew}
      onContinue={handleContinue}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={modelError}
      modelScopeWarnings={modelScopeWarnings}
      onRefreshModels={isNew && modelsRefreshable ? refreshModels : undefined}
      modelsRefreshing={modelsRefreshing}
      onModelChange={
        session && session.agent && !sessionCap("setModel")
          ? undefined
          : handleModelChange
      }
      modelSwitching={modelSwitching}
      contextPercent={contextUsage?.percent ?? null}
      // Context-meter extension seam: full context snapshot + session panel entry (§4.1 of the context-meter plan doc)
      contextUsage={contextUsage}
      onSessionStatsPanelOpen={onSessionStatsPanelOpen}
      defaultModel={defaultModel}
      onSetDefaultModel={handleSetDefaultModel}
      onCompact={session || isNew
        ? (sessionCap("compact") ? handleCompact : undefined)
        : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      onDismissCompactError={dismissCompactError}
      compactResult={compactResult}
      compactQueued={compactQueued}
      modelSwitchPending={modelSwitchPending}
      onCancelCompactQueue={cancelCompactQueue}
      toolPreset={toolPreset}
      onToolPresetChange={session || isNew
        ? (sessionCap("setActiveTools", true) ? handleToolPresetChange : undefined)
        : undefined}
      sessionCapabilities={sessionCapabilities}
      onSwitchPermissionMode={switchPermissionMode}
      thinkingLevel={thinkingLevel}
      isAutoThinkingSelection={isAutoThinkingSelection}
      onThinkingLevelChange={session || isNew
        ? (sessionCap("setThinkingLevel") ? handleThinkingLevelChange : undefined)
        : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      savedDefaultThinkingLevel={savedDefaultThinkingLevel}
      onSetDefaultThinkingLevel={session || isNew ? handleSetDefaultThinkingLevel : undefined}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      tasks={sessionTasks}
      inputHistory={inputHistory}
      onRecallQueue={handleRecallQueue}
      onExportQueue={exportQueueData}
      onImportQueue={importQueueData}
      onStageImport={stageImport}
      onMoveQueue={moveQueuedMessage}
      onRecallOne={recallQueuedMessage}
      onRequeueAt={requeueAt}
      onRemoveQueueItem={removeQueuedMessage}
      queueTrash={queueTrash}
      onRestoreQueueItem={restoreQueueItem}
      onPurgeQueueTrash={purgeQueueTrash}
      onTrashComposerInput={trashComposerInput}
      onRestoreComposerTrash={restoreComposerTrash}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={draftKey}
      cwd={session?.cwd ?? newSessionCwd}
      suppressDraft={editFromHerePending != null}
      followStreaming={!followPaused}
      extensionStatuses={extensionStatuses}
      extensionWidgets={extensionWidgets}
      onAttachFiles={onAttachFiles}
      docFilesToUpload={docFilesToUpload}
    />
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
         {t("chat.loadingSession")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      className="chat-content relative flex h-full min-w-0 flex-col overflow-hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(37,99,235,0.08)" stroke="rgba(37,99,235,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(37,99,235,0.16)" stroke="rgba(37,99,235,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(37,99,235,0.22)" stroke="rgba(37,99,235,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      {/* 队列恢复对话框由 aiti-recovery 扩展经 recoveryDialog 插槽接管（注入式活 props；
          sole-owner：core 不渲染自身实现——去 fork 化 B3）。渲染条件留 core（有恢复项才挂插槽）。 */}
      {recoveryItems.length > 0 && !recoveryDismissed && (
        <ExtSlot
          name="recoveryDialog"
          extra={{
            items: recoveryItems,
            sessionId: session?.id ?? sessionIdRef.current ?? undefined,
            onResolve: handleResolveRecovery,
            onExport: exportQueueData,
            onImport: importQueueData,
            onDismiss: () => setRecoveryDismissed(true),
            mode: recoveryIsImport ? "import" : "recovery",
          }}
        />
      )}


      <div
        style={{
          position: "absolute",
          top: 12,
          left: 0,
          right: isMobile || isCompact ? 0 : CHAT_MINIMAP_WIDTH,
          zIndex: 40,
          display: "flex",
          // Toasts live in the top-right corner
          justifyContent: "flex-end",
          padding: `0 ${CHAT_COLUMN_PADDING}px`,
          pointerEvents: "none",
        }}
      >
        <NoticeShelf notices={notices} floating onPauseChange={setNoticePaused} />
      </div>

      {/* Session request card takeover seam (agent-capability UI moved out of core):
        extension routing first (the session-cards extension / the zcode agent client
        extension), misses fall to the core minimal fallback card (capabilities never
        render bare). Plan: docs/pi-web-agent-capability-ui-ext-plan.md §2.1. */}
      {sessionRequest && (
        <SessionRequestCardHost
          request={sessionRequest}
          respond={(answer) => respondToSessionRequest(sessionRequest.requestId, answer)}
          backendSource={backendSource}
          currentSession={session ? { id: session.id, cwd: session.cwd, name: session.name, firstMessage: session.firstMessage } : null}
        />
      )}

      {/* New-session welcome-page widget zone · top (newSessionWidgets; renders only on
          isEmptyNew, zero footprint otherwise). The Zone brings its own height-capped
          scrolling (TOP_ZONE_MAX_HEIGHT) and shrink-0 so it never squeezes the message
          area/composer. extra only feeds data {cwd,isMobile,area}; panel state lives in
          this component (nswCustomizeOpen). */}
      {isEmptyNew && (
        <NewSessionWidgetZone
          area="top"
          cwd={newSessionCwd}
          onEdit={() => setNswCustomizeOpen(true)}
        />
      )}

      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {extensionDialog && (
          <ExtensionDialog key={extensionDialog.id} request={extensionDialog} waitingCount={waitingExtensionDialogCount} onRespond={respondToExtensionUi} />
        )}
        {extensionCustomUi && (
          <ExtensionCustomPanel key={extensionCustomUi.id} request={extensionCustomUi} waitingCount={waitingExtensionCustomUiCount} onInput={sendExtensionCustomInput} />
        )}
        {!isEmptyNew && (<>
        <div
          ref={handleScrollBoxRef}
          data-chat-scroll
          // The message list is the one place long output has to be dragged through,
          // so it shows its scrollbar instead of hiding it behind the minimap (#788).
          // A stable gutter keeps the centred column from shifting when a short
          // session grows past one screen.
          className="scrollbar-subtle min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-gutter:stable]"
          style={{ paddingBottom: bottomEyeRoom, visibility: pendingScrollRestore ? "hidden" : undefined }}
        >
          <div style={{ minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div ref={messageContentRef} onPointerUp={captureQuotedSelection} style={{ width: "100%", minWidth: 0, maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
            {(() => {
              let lastUserIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") { lastUserIdx = i; break; }
              }
              // Anchor for live-tail detection. A compaction summary or subagent
              // completion can sit after the last user message and own the
              // still-streaming segment. lastUserIdx stays the scroll target.
              let lastAnchorIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (isMessageGroupAnchor(messages[i])) { lastAnchorIdx = i; break; }
              }

              const visibleRefIndexByMessage = new Map<number, number>();
              let refIdx = 0;
              messages.forEach((msg, idx) => {
                if (isMessageGroupAnchor(msg) || msg.role === "assistant") {
                  visibleRefIndexByMessage.set(idx, refIdx++);
                }
              });

              const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
                messageRefs.current[refIndex] = el;
                if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
              };

              const renderMessage = (idx: number, options: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean; writtenFiles?: WrittenFile[]; turnAssistantEntryIds?: string[]; suppressMessageFooter?: boolean; recoverTruncation?: boolean } = {}): ReactNode => {
                const msg = options.messageOverride ?? messages[idx];
                if (isHiddenCustomMessage(msg)) return null;
                const prevAssistantEntryId =
                  msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
                    ? entryIds[idx - 1]
                    : undefined;
                const isVisible = isMessageGroupAnchor(msg) || msg.role === "assistant";
                const currentRefIdx = visibleRefIndexByMessage.get(idx);
                const keyPrefix = options.keyPrefix ?? "message";
                const messageKey = entryIds[idx] ?? idx;
                let showTimestamp = false;
                if (msg.role === "assistant") {
                  showTimestamp = true;
                  for (let j = idx + 1; j < messages.length; j++) {
                    const r = messages[j].role;
                    if (r === "user") break;
                    if (r === "assistant") { showTimestamp = false; break; }
                  }
                  // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                  if (showTimestamp && streamState.isStreaming && idx === messages.length - 1) {
                    showTimestamp = false;
                  }
                }
                if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
                const view = (
                  <MessageView
                    key={`${keyPrefix}-view-${messageKey}`}
                    message={msg}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    cwd={messageCwd}
                    onOpenFile={onOpenFile}
                    onOpenSubagent={onOpenSubagent}
                    entryId={entryIds[idx]}
                    searchBlock={entryIds[idx] === pendingSearchScroll?.entryId ? searchBlock : undefined}
                    onFork={bashRunning || isNew || !sessionCap("fork") ? undefined : handleFork}
                    forking={forkingEntryId === entryIds[idx]}
                    onNavigate={isNew ? undefined : handleNavigate}
                    prevAssistantEntryId={isNew ? undefined : prevAssistantEntryId}
                    onEditContent={sessionBusy ? undefined : handleEditContent}
                    onCancelEdit={cancelEdit}
                    isEditing={editEntryId === entryIds[idx]}
                    onEditFromHere={sessionBusy || isNew || !(sessionCap("navigateTree") || sessionCap("fork")) ? undefined : handleEditFromHereMark}
                    editingFromStart={editFromHerePending?.entryId === entryIds[idx]}
                    onCancelEditFromStart={handleCancelEditFromHere}
                    showTimestamp={showTimestamp}
                    prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                    writtenFiles={options.writtenFiles}
                    turnAssistantEntryIds={options.turnAssistantEntryIds}
                    suppressMessageFooter={options.suppressMessageFooter}
                    onCompact={options.recoverTruncation ? handleCompact : undefined}
                    isCompacting={options.recoverTruncation ? isCompacting : undefined}
                    compactError={options.recoverTruncation ? compactError : undefined}
                  />
                );
                if (!isVisible || currentRefIdx === undefined) return view;
                return (
                  <div key={`${keyPrefix}-${messageKey}`} data-entry-id={entryIds[idx]} data-chat-msg-role={msg.role} ref={options.attachRef === false ? undefined : attachVisibleRef(idx, currentRefIdx)} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 160px" } as React.CSSProperties}>
                    {view}
                  </div>
                );
              };

              const rendered: ReactNode[] = [];
              for (let idx = 0; idx < messages.length;) {
                const msg = messages[idx];
                const hasAnchor = isMessageGroupAnchor(msg);
                if (!hasAnchor && idx !== 0) {
                  rendered.push(renderMessage(idx));
                  idx += 1;
                  continue;
                }

                // The first history page starts at a fixed entry count, so a turn
                // longer than that page begins without its anchor. Group the
                // leading segment anyway instead of flattening the whole turn.
                const userIdx = hasAnchor ? idx : -1;
                const groupStartIdx = hasAnchor ? idx : 0;
                let endIdx = idx + 1;
                while (endIdx < messages.length && !isMessageGroupAnchor(messages[endIdx])) endIdx += 1;

                const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);

                if (finalAssistantIdx === -1) {
                  for (let renderIdx = groupStartIdx; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                  }
                  idx = endIdx;
                  continue;
                }

                const isLiveTail = (sessionBusy || streamState.isStreaming) && endIdx === messages.length && userIdx === lastAnchorIdx;
                if (isLiveTail) {
                  for (let renderIdx = groupStartIdx; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                  }
                  idx = endIdx;
                  continue;
                }

                if (hasAnchor) rendered.push(renderMessage(userIdx));

                const finalViews = getFinalAnswerViews(finalAnswerViewCache, messages[finalAssistantIdx] as AssistantMessage);
                const finalAnswerMessage = finalViews.answer;

                const processViews: ReactNode[] = [];
                let processToolCount = 0;
                let processRefIdx: number | undefined;
                let revealProcess = false;

                for (let processIdx = userIdx + 1; processIdx <= finalAssistantIdx; processIdx++) {
                  const processMessage = messages[processIdx];
                  if (processMessage.role === "custom") {
                    // Not counted either: a turn whose only extra is a hidden message has no process details.
                    if (isHiddenCustomMessage(processMessage)) continue;
                    revealProcess ||= Boolean(pendingSearchScroll && pendingSearchScroll.entryId === entryIds[processIdx]);
                    processViews.push(renderMessage(processIdx, { attachRef: false, keyPrefix: "process" }));
                    continue;
                  }
                  if (processMessage.role !== "assistant") continue;
                  const message = processIdx === finalAssistantIdx ? finalViews.process : processMessage;
                  const blocks = getDisplayableAssistantBlocks(message);
                  if (blocks.length === 0) continue;
                  processRefIdx ??= visibleRefIndexByMessage.get(processIdx);
                  processToolCount += countToolCallBlocks(blocks);
                  revealProcess ||= Boolean(pendingSearchScroll && entryIds[processIdx] === pendingSearchScroll.entryId && (!searchBlock || blocks.includes(searchBlock)));
                  processViews.push(renderMessage(processIdx, {
                    attachRef: false,
                    keyPrefix: "process",
                    messageOverride: message,
                    showTimestamp: false,
                    // Turn-wide written files are already aggregated by the turn-level
                    // footer at the final answer (assistantEntryIds), so per-message
                    // footers on process messages are suppressed here to avoid the same
                    // file appearing twice when the group is expanded. Only suppressed
                    // when the turn truly has a final answer — an interrupted turn (no
                    // answer blocks) has no final-answer render point, making the process
                    // messages' footer the only display spot; it must be kept.
                    suppressMessageFooter: Boolean(finalAnswerMessage),
                  }));
                }

                if (processViews.length > 0) {
                  const answered = collapsesProcessDetails(finalAnswerMessage);
                  rendered.push(
                    <div
                      key={`process-group-${entryIds[groupStartIdx] ?? groupStartIdx}`}
                      ref={processRefIdx === undefined ? undefined : (el) => { messageRefs.current[processRefIdx] = el; }}
                    >
                      {/* Re-key on answer availability: useState reads defaultExpanded only
                          on mount, so a turn first rendered without an answer (expanded)
                          would otherwise stay open once its answer shows up, e.g. when
                          switching between an answered and an unanswered leaf of the same
                          turn. Manual toggles survive every other re-render. */}
                      <ProcessDetailsGroup key={answered ? "answered" : "unanswered"} messageCount={processViews.length} toolCallCount={processToolCount} defaultExpanded={!answered} reveal={revealProcess} t={t}>
                        {processViews}
                      </ProcessDetailsGroup>
                    </div>,
                  );
                }

                if (finalAnswerMessage) {
                  // Each tool call is stored as its own assistant entry, so the
                  // final answer alone carries no record of what the turn wrote.
                  // Gather the turn's assistant blocks and derive the file list
                  // from the write/edit calls among them.
                  const turnContent: AssistantContentBlock[] = [];
                  const turnAssistantEntryIds: string[] = [];
                  for (let i = userIdx + 1; i <= finalAssistantIdx; i++) {
                    const m = messages[i];
                    if (m?.role === "assistant") {
                      const turnEntryId = entryIds[i];
                      if (turnEntryId) turnAssistantEntryIds.push(turnEntryId);
                      for (const b of (m as AssistantMessage).content ?? []) turnContent.push(b);
                    }
                  }
                  const writtenFiles = keepWrittenFiles(finalViews, extractTurnWrittenFiles(turnContent, toolResultsMap, messageCwd));
                  rendered.push(renderMessage(finalAssistantIdx, {
                    messageOverride: finalAnswerMessage,
                    writtenFiles,
                    turnAssistantEntryIds,
                    recoverTruncation: endIdx === messages.length && !streamState.isStreaming && !hasAssistantAnswer(finalAnswerMessage),
                  }));
                }
                for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
                  rendered.push(renderMessage(renderIdx));
                }
                idx = endIdx;
              }
              const { startIndex } = getVisibleRenderWindow(rendered.length, visibleCount);
              const hasMore = startIndex > 0 || hasEarlierMessages;
              return (
                <>
                  {hasMore && (
                     <div ref={setSentinel} className="py-3 text-center text-xs text-text-muted">
                       {t("chat.loadEarlier")}
                    </div>
                  )}
                  {rendered.slice(startIndex)}
                </>
              );
            })()}
            {streamState.isStreaming && hasStreamingContent && streamState.streamingMessage && (
              <MessageView message={streamState.streamingMessage as AgentMessage} toolResults={toolResultsMap} isStreaming modelNames={modelNames} cwd={messageCwd} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} />
            )}

            {agentRunning && !hasStreamingContent && (agentPhase || isCompacting || settling) && (
              <div className="break-words py-2 text-[13px] text-text-muted">
                {settling && !agentPhase ? (
                  // agent_end: the run's answer is fully on screen, the SDK is just wrapping up
                  // (compaction checks / extension settle hooks). A non-spinning completion chip — the
                  // sidebar may still show running until agent_settled reconciles, but the chat flow
                  // should never scream "still running" once the answer is out.
                  <span>
                    {t("chat.turnCompleteSettling")}
                    {runStartedAtRef.current !== null && <ElapsedBadge startedAt={runStartedAtRef.current} />}
                  </span>
                ) : (
                  <span className="animate-[pulse_1.5s_infinite]">
                    {phaseLabel(agentPhase, t, isCompacting)}
                    {runStartedAtRef.current !== null && <ElapsedBadge startedAt={runStartedAtRef.current} />}
                  </span>
                )}
              </div>
            )}

            {bashRunning && !pendingBash && (
              <div className="py-2 text-[13px] text-text-muted">
                 <span className="animate-[pulse_1.5s_infinite]">{t("chat.runningCommand")}</span>
              </div>
            )}

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                onOpenSubagent={onOpenSubagent}
              />
            )}

            {/* Stopped sessions: a quiet one-line "refresh" entry at the very bottom of
                the message flow (manual re-align when advanced externally / stale in-memory
                history). Common to all agents; hidden while running / on new sessions
                (refreshing a new session would break draft semantics). */}
            {!sessionBusy && !isNew && messages.length > 0 && (
              <div className="flex justify-center py-1.5">
                <button
                  onClick={handleManualRefresh}
                  disabled={refreshing}
                  title={t("chat.refreshSessionHint")}
                  className="text-[11px] leading-none text-text-muted/55 transition-colors hover:text-text-muted hover:underline disabled:opacity-60"
                >
                  {refreshing ? t("chat.refreshing") : `↻ ${t("chat.refreshSession")}`}
                </button>
              </div>
            )}

            {/* Height placeholder for the bottom composer (keeps the tail pin); the step-follow spacer was removed (constant 0) */}
            <div aria-hidden="true" style={{ height: bottomComposerHeight }} />

            <div ref={messagesEndRef} />
            </div>
          </div>
        </div>

        {/* The message scroll nav bar was extracted into an extension (the message-nav
            extension registers into the chatOverlay slot); the message anchor banner
            (the message-anchor extension) uses the same slot. currentSession forwards
            the session title: name + firstMessage (when there is no name, same as the
            left session list, the first user input is used). extra.revealHistory: when
            the message-nav extension's "to earliest/previous" jump target lies outside
            the render window, expand everything at once — same source as ChatMinimap's
            onRevealHistory. */}
        <ExtSlot
          name="chatOverlay"
          currentSession={session ? { id: session.id, cwd: session.cwd, name: session.name, firstMessage: session.firstMessage } : null}
          extra={{ agentRunning, isMobile, revealHistory: revealHistoryForMinimap,
            /* Usage badge seam (P3 de-coring): data stays in core (get_usage protocol),
               display belongs to the provider-usage extension. isEmptyNew semantics
               preserved — a fresh empty session forwards null (same condition the old
               core badge used to render). */
            backendUsage: isEmptyNew ? null : backendUsage, backendSource }}
        />

        {isMobile || isCompact ? null : (
          <ChatMinimap
            messages={messages}
            streamingMessage={streamState.streamingMessage}
            scrollContainer={scrollContainerRef}
            messageRefs={messageRefs}
            onRevealHistory={revealHistoryForMinimap}
            turnsBefore={earlierTurnCount}
          />
        )}
        </>)}
      </div>

      {quoteSelectionEnabled && quotedSelection && createPortal(
        <div
          ref={quotePopoverRef}
          role={quoteInputOpen ? "dialog" : "toolbar"}
          aria-label={t(quoteInputOpen ? "chat.newQuoteChat" : "chat.askSelection")}
          style={{
            position: "fixed",
            top: quotedSelection.top,
            left: quotedSelection.left,
            zIndex: 260,
            display: "flex",
            flexWrap: "wrap",
            gap: 3,
            width: quoteInputOpen ? "min(420px, calc(100vw - 16px))" : undefined,
            maxWidth: "calc(100vw - 16px)",
            maxHeight: "calc(var(--app-viewport-height, 100dvh) - 16px)",
            overflowY: "auto",
            padding: quoteInputOpen ? 12 : 3,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg)",
            boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
          }}
        >
          {quoteInputOpen ? (
            <fieldset
              disabled={quoteSubmitting}
              aria-busy={quoteSubmitting}
              style={{ width: "100%", minWidth: 0, margin: 0, padding: 0, border: "none", display: "flex", flexDirection: "column", gap: 10 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600 }}>{t("chat.askInNewChat")}</span>
                <button type="button" className="file-viewer-icon-button" title={t("i18n.close")} aria-label={t("i18n.close")} disabled={quoteSubmitting} onClick={closeQuotedSelection} style={{ border: "none" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
                </button>
              </div>
              <ChatInput
                ref={quoteChatInputRef}
                compact
                onSend={askSelectionInNewChat}
                onAbort={closeQuotedSelection}
                isStreaming={false}
              />
              {quoteError && <div role="alert" style={{ color: "#dc2626", fontSize: 12, overflowWrap: "anywhere" }}>{quoteError}</div>}
            </fieldset>
          ) : <>
          <button
            type="button"
            className="file-viewer-icon-button"
            title={t("chat.askInCurrent")}
            aria-label={t("chat.askInCurrent")}
            onPointerDown={(event) => event.preventDefault()}
            onClick={askSelectionHere}
            style={{ width: "auto", height: 35, flex: "0 0 auto", gap: 5, padding: "0 10px", border: "none", fontSize: 12, fontWeight: 500 }}
          >
            <span aria-hidden="true" style={{ fontSize: 15 }}>@</span>
            <span>{t("chat.askInCurrent")}</span>
          </button>
          {onAskInNewChat && quotedSelection.sourceEntryId && !bashRunning && (
            <button
              type="button"
              className="file-viewer-icon-button"
              title={t("chat.askInNewChat")}
              aria-label={t("chat.askInNewChat")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => { setQuoteInputOpen(true); window.getSelection()?.removeAllRanges(); }}
              style={{ width: "auto", height: 35, flex: "0 0 auto", gap: 5, padding: "0 10px", border: "none", fontSize: 12, fontWeight: 500 }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 3v12M18 9a9 9 0 0 1-9 9" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
              </svg>
              <span>{t("chat.askInNewChat")}</span>
            </button>
          )}
          </>}
        </div>,
        document.body,
      )}

      

      <div ref={bottomComposerRef} className="relative shrink-0">
        {!isEmptyNew && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
              display: "flex",
              justifyContent: "center",
              paddingBottom: 10,
              pointerEvents: "none",
              zIndex: 20,
            }}
          >
            <button
              type="button"
              className={`chat-scroll-to-bottom${showScrollToBottom && !pendingScrollRestore ? " is-visible" : ""}`}
              title={t("chat.scrollToLatest")}
              aria-label={t("chat.scrollToLatest")}
              onClick={() => scrollToBottom("smooth")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12l7 7 7-7" />
              </svg>
            </button>
          </div>
        )}
        {isEmptyNew && (
          <div className="mb-3 w-full" style={{ paddingLeft: 16, paddingRight: isMobile ? 16 : 52 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto", fontFamily: "var(--font-mono)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 7 : 10, minWidth: 0, flex: 1, lineHeight: 1.4, overflow: "hidden" }}>
                <Image src={withBasePath("/icons/apple-touch-icon.png")} width={32} height={32} alt="" priority style={{ flexShrink: 0 }} />
                <span style={{ fontSize: 22, color: "var(--text)", fontWeight: 700, flexShrink: 0, whiteSpace: "nowrap" }}>Pi Web</span>
                <NewSessionUpdateLink label={(version) => t("appUpdate.releaseNotes", { version })} />
              </div>
              {newSessionContextBar}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                  web <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                  pi <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}</span>
                </span>
              </div>
            </div>
          </div>
        )}
        {isEmptyNew && (workspaceOptions.length > 0 || backendOptions.length > 0 || backendExtraOptions.length > 0 || hasNewSessionSelectors) && (
          <div className="mx-auto mb-3 w-full" style={{ maxWidth: "var(--chat-content-max-width, 820px)", paddingLeft: 32, paddingRight: isMobile ? 32 : 68 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              {/* Workspace selection (before Backend): defaults to the current cwd; choosing
                  only stages a target and doesn't switch immediately — after sending creates
                  the session, AppShell switches into the target workspace and opens the new
                  session. */}
              {workspaceOptions.length > 0 && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, maxWidth: "100%" }}>
                  <span style={{ color: "var(--text-muted)" }}>Workspace</span>
                  <select
                    value={newSessionWorkspace ?? newSessionCwd ?? ""}
                    onChange={(e) => onNewSessionWorkspaceChange?.(e.target.value || null)}
                    title={newSessionWorkspace ?? newSessionCwd ?? undefined}
                    style={{ ...NEW_SESSION_SELECT_STYLE, maxWidth: "min(52vw, 360px)", minWidth: 0 }}
                  >
                    {workspaceOptions.map((p) => (
                      <option key={p.key} value={p.root}>
                        {workspaceLabel(p.root)}
                      </option>
                    ))}
                  </select>
                </span>
              )}
              {/* Extension pickers (branch/worktree pickers etc.): slot rendering wraps no
                  box (renders a fragment, the picker itself is a flex child), keeping the
                  flexWrap layout intact; the intent bar wraps to the next line via
                  flexBasis:100%. extra only feeds data {cwd,isMobile} (slot extra red
                  line); all writes live in newSessionPreparers. */}
              {hasNewSessionSelectors && (
                <ExtSlot name="newSessionSelectors" extra={{ cwd: newSessionCwd, isMobile }} />
              )}
              {(backendOptions.length > 0 || backendExtraOptions.length > 0) && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, maxWidth: "100%" }}>
                  <span style={{ color: "var(--text-muted)" }}>Backend</span>
                  <select
                    value={sessionBackend ?? ""}
                    onChange={(e) => {
                      const raw = e.target.value;
                      // Extension entry (e.g. "Manage ACP Agents…"): not a backend option —
                      // after running its action, reset the dropdown; the current backend
                      // selection is unchanged.
                      if (raw.startsWith(BACKEND_EXT_OPTION_PREFIX)) {
                        e.target.value = sessionBackend ?? "";
                        backendExtraOptions.find((it) => `${BACKEND_EXT_OPTION_PREFIX}${it.id}` === raw)?.meta?.onClick?.();
                        return;
                      }
                      const v = raw || null;
                      setSessionBackend(v);
                      try {
                        if (v) localStorage.setItem(LAST_BACKEND_KEY, v);
                        else localStorage.removeItem(LAST_BACKEND_KEY);
                      } catch {}
                    }}
                    style={NEW_SESSION_SELECT_STYLE}
                  >
                    <option value="">Pi (local)</option>
                    {backendOptions.map((b) => (
                      <option key={b.type} value={b.type}>
                        {b.label}
                      </option>
                    ))}
                    {/* Backend management entries are an extension point: each backend
                        extension contributes its own entries as the dropdown's last items
                        via the newSessionBackendOptions slot (e.g. the ACP agent
                        extension's agent management); core knows nothing about specific
                        backends. */}
                    {backendExtraOptions.map((item) => (
                      <option key={item.id} value={`${BACKEND_EXT_OPTION_PREFIX}${item.id}`}>
                        {item.meta?.label ?? item.id}
                      </option>
                    ))}
                  </select>
                </span>
              )}
              {sessionBackend && (
                <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
                  session runs via: {sessionBackend}
                </span>
              )}
            </div>
          </div>
        )}
        {/* Extension widgets appear in only two places: the desktop bottom status shelf
            (ExtensionStatusBar below) and the mobile ⓘ/+ InfoSheet (ChatInput). They used
            to render another copy above/below the input per placement, duplicating the
            status shelf (the same widget twice, one above and one below) — since collapsed;
            placement only survives as the direction icon on the status shelf trigger. */}
        {chatInputElement}
        {/* Mobile: the status shelf as a whole is not persistent (the input bar is the
            bottom-most persistent element); changes go through a toast, details live in
            ChatInput's ⓘ sheet. Desktop keeps the status shelf.
            docs/pi-web-mobile-input-wechat-plan.md §6 */}
        {isMobile
          ? <ExtensionStatusToast statuses={extensionStatuses} />
          : <ExtensionStatusBar statuses={extensionStatuses} widgets={extensionWidgets} onCommand={handleSend} commandsDisabled={sessionBusy} />}
      </div>
      {/* New-session welcome-page widget zone · bottom (the old filler spot below the
          composer; returns an equivalent filler div when nothing is visible, so layout
          stays byte-identical) + the customize panel singleton (portal to body). */}
      {isEmptyNew && (
        <NewSessionWidgetZone
          area="bottom"
          cwd={newSessionCwd}
          onEdit={() => setNswCustomizeOpen(true)}
        />
      )}
      {isEmptyNew && nswCustomizeOpen && (
        <NewSessionWidgetsCustomize onClose={() => setNswCustomizeOpen(false)} />
      )}
    </div>
  );
}

// A one-line notice is exactly as tall as its entrance animation pins it, and
// its line sits dead centre: the two 1px borders, a 21px line box (14px at
// line-height 1.5) and this padding twice add up to 60px. Letting the card's
// min-height take the leftover instead leaves the top-aligned text 4.5px above
// the centre, since the rest of the leftover stays under it.
const NOTICE_MIN_HEIGHT_PX = 60;
const NOTICE_LINE_BOX_PX = 21;
const NOTICE_TEXT_PADDING_Y_PX = (NOTICE_MIN_HEIGHT_PX - 2 - NOTICE_LINE_BOX_PX) / 2;
// Toast 整体高度上限；文本区高度上限 = 整体上限 - 上下边框（全局 box-sizing: border-box，
// 文本区的 max-height 已包含它自己的上下 padding，不能再减一次）
const NOTICE_MAX_HEIGHT_PX = 500;
const NOTICE_TEXT_MAX_HEIGHT_PX = NOTICE_MAX_HEIGHT_PX - 2;

function NoticeShelf({ notices, floating = false, align = "left", onPauseChange }: { notices: NoticeItem[]; floating?: boolean; align?: "left" | "right"; onPauseChange?: (id: string | null) => void }) {
  if (notices.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "right" ? "flex-end" : "stretch",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "#ef4444"
          : notice.type === "warning"
            ? "#d97706"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            onMouseEnter={() => onPauseChange?.(notice.id)}
            onMouseLeave={(event) => {
              if (!event.currentTarget.contains(document.activeElement)) onPauseChange?.(null);
            }}
            onFocus={() => onPauseChange?.(notice.id)}
            onBlur={(event) => {
              if (!event.currentTarget.matches(":hover")) onPauseChange?.(null);
            }}
            style={{
              display: "flex",
              // Top-align children so the type dot sits by the first line on multi-line toasts
              alignItems: "flex-start",
              gap: 10,
              minHeight: NOTICE_MIN_HEIGHT_PX,
              height: "auto",
              // Overall height cap: overflow is handled by inner scrolling in the text
              // area (see the span's overflowY below); the container itself stays hidden,
              // keeping the dot pinned at the top instead of scrolling with the text
              maxHeight: NOTICE_MAX_HEIGHT_PX,
              // The floating wrapper is pointerEvents:"none" (click-through by design),
              // so the toast itself must opt back into interactivity or hover events never reach it
              pointerEvents: "auto",
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: 14,
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              fontSize: 14,
              lineHeight: 1.5,
              transformOrigin: "top right",
              // Use backwards fill for the entrance animation so height styles return to
              // inline styles once it finishes; otherwise the keyframe's fixed 60px would
              // stick around in fill mode and permanently clamp the expanded toast
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out backwards",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
                // Align with the optical center of the first text line: the text's
                // vertical padding + (21px line box - 7px dot) / 2
                marginTop: NOTICE_TEXT_PADDING_Y_PX + 7,
              }}
            />
            {/* Full text by default: pre-line preserves \n (nowrap/normal collapse
                newlines into spaces) and long lines wrap instead of truncating;
                content taller than the cap scrolls inside the text area */}
            <span
              tabIndex={0}
              style={{ padding: `${NOTICE_TEXT_PADDING_Y_PX}px 0`, minWidth: 0, maxWidth: "100%", maxHeight: NOTICE_TEXT_MAX_HEIGHT_PX, overflowY: "auto", scrollbarWidth: "thin", whiteSpace: "pre-line", wordBreak: "break-word" }}
            >
              {splitNoticeText(notice.message).map((part, partIndex) => part.kind === "art" ? (
                // A terminal QR code or bar (#755): every space kept, rows touching, and a
                // font stack whose first font has the blocks too (the bundled Noto subset
                // has none, so spaces and blocks would come from fonts of different widths).
                <span
                  key={partIndex}
                  style={{
                    display: "inline-block",
                    verticalAlign: "top",
                    maxWidth: "100%",
                    overflowX: "auto",
                    whiteSpace: "pre",
                    fontFamily: "Menlo, Consolas, 'DejaVu Sans Mono', monospace",
                    lineHeight: 1,
                    color: "var(--text)",
                  }}
                >
                  {part.text}
                </span>
              ) : part.text)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function getExtensionDialogSummary(request: ExtensionDialogRequest): string | undefined {
  if (request.method === "select" && request.options.length > 0) return request.options[0];
  if (request.method === "confirm") {
    const firstLine = request.message.split("\n").find((line) => line.trim());
    return firstLine?.trim();
  }
  return undefined;
}

/** "+N more": requests of the same kind queued behind the one on screen, each shown once that one closes. */
function ExtensionWaitingCount({ count }: { count: number }) {
  const { t } = useI18n();
  if (count <= 0) return null;
  return (
    <span style={{ fontSize: 11, fontWeight: 650, color: "var(--accent)", whiteSpace: "nowrap", flexShrink: 0 }}>
      {t("chat.extensionMoreWaiting", { count })}
    </span>
  );
}

/** Corner brackets pointing outward; when expanded they point inward (restore). */
function ExtensionSizeIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {expanded
        ? <path d="M3.5 1v2.5H1M6.5 1v2.5H9M6.5 9v-2.5H9M3.5 9v-2.5H1" />
        : <path d="M1 3.5V1h2.5M6.5 1H9v2.5M9 6.5V9H6.5M3.5 9H1V6.5" />}
    </svg>
  );
}

function ExtensionDialog({
  request,
  waitingCount,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  /** Further dialogs queued behind this one; each opens after this one is answered. */
  waitingCount: number;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");
  const [collapsed, setCollapsed] = useState(false);
  // Dialogs open at the historical width and grow only when their own content cannot
  // fit (a code block or table that would scroll sideways), so no extension has to ask
  // for room. The maximize button is the user's own override for this dialog (#947).
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [fitWidth, setFitWidth] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const toggleFull = useCallback(() => setFull((prev) => !prev), []);
  const [now, setNow] = useState(() => Date.now());
  const focusFirstOption = useCallback((element: HTMLDivElement | null) => element?.focus(), []);
  const summary = getExtensionDialogSummary(request);
  const remainingSeconds = request.expiresAt === undefined
    ? null
    : Math.max(0, Math.ceil((request.expiresAt - now) / 1000));

  useLayoutEffect(() => {
    if (collapsed) return;
    const dialog = dialogRef.current;
    const body = bodyRef.current;
    if (!dialog || !body) return;
    let disposed = false;
    const fit = () => {
      if (disposed) return;
      const blocks = body.querySelectorAll<HTMLElement>("pre, .markdown-table-wrap");
      if (blocks.length === 0) return;
      const needed = fitExtensionDialogWidth(
        dialog.offsetWidth,
        Array.from(blocks, (block) => block.scrollWidth - block.clientWidth),
      );
      // Only ever grow: shrinking again would make the dialog jump while it is read.
      if (needed !== null) setFitWidth((prev) => (prev !== null && prev >= needed ? prev : needed));
    };
    fit();
    // Highlighted code replaces its plain fallback after the first paint, and a web
    // font can change glyph widths once it arrives.
    const mutations = new MutationObserver(fit);
    mutations.observe(body, { childList: true, subtree: true, characterData: true });
    void document.fonts?.ready.then(fit);
    return () => {
      disposed = true;
      mutations.disconnect();
    };
  }, [collapsed]);

  useEffect(() => {
    if (request.expiresAt === undefined) return;
    // The server closes expired requests via extension_ui_closed.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.expiresAt]);

  const countdown = remainingSeconds !== null && (
    <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>
      {t("chat.extensionExpiresIn", { seconds: remainingSeconds })}
    </span>
  );

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        onRespond(request, { cancelled: true });
      }}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: collapsed ? "flex-start" : "center",
        justifyContent: "center",
        padding: 20,
        pointerEvents: "none",
      }}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "min(560px, 100%)",
            width: "100%",
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 650, color: "var(--accent)", flexShrink: 0 }}>
            {t("chat.extensionPending")}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {request.title}
          </span>
          {summary && (
            <span style={{ fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%", flexShrink: 1 }}>
              {summary}
            </span>
          )}
          <ExtensionWaitingCount count={waitingCount} />
          {countdown}
          <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
            {t("chat.extensionExpand")}
          </span>
        </button>
      ) : (
      <div
        ref={dialogRef}
        role="dialog"
        aria-label={request.title}
        style={{
          pointerEvents: "auto",
          // "Full" fills the content region above the composer: the overlay is inset:0 with
          // 20px padding, so 100% keeps that breathing room without covering the input.
          width: full ? "100%" : `min(${fitWidth ?? EXTENSION_DIALOG_BASE_WIDTH}px, 100%)`,
          maxHeight: full ? "100%" : "min(760px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ flexShrink: 1, minHeight: 0, display: "flex", alignItems: "flex-start", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--border)", maxHeight: "50vh", overflowY: "auto" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Pi's TUI shows the title verbatim, newlines included; select/input have no
                separate message field, so extensions put multi-line text here. */}
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{request.title}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
              <span>{t("chat.extensionRequest")}</span>
              <ExtensionWaitingCount count={waitingCount} />
              {countdown}
            </div>
          </div>
          <button
            type="button"
            onClick={toggleFull}
            title={full ? t("chat.extensionRestoreSize") : t("chat.extensionMaximize")}
            aria-label={full ? t("chat.extensionRestoreSize") : t("chat.extensionMaximize")}
            style={{
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <ExtensionSizeIcon expanded={full} />
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-expanded={true}
            title={t("chat.extensionCollapse")}
            aria-label={t("chat.extensionCollapse")}
            style={{
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="2 3.5 5 6.5 8 3.5" />
            </svg>
          </button>
        </div>

        <div
          ref={bodyRef}
          style={{
            padding: 14,
            flex: "1 1 auto", minHeight: 0, overflowY: "auto",
          }}
        >
          {request.method === "confirm" && (
            <MarkdownBody>{request.message}</MarkdownBody>
          )}
          {request.method === "select" && (
            <div
              onKeyDown={(event) => {
                if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-extension-option]"));
                const index = buttons.indexOf(event.target as HTMLElement);
                if (index < 0) return;
                event.preventDefault();
                const next = event.key === "Home" ? 0
                  : event.key === "End" ? buttons.length - 1
                  : (index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
                buttons[next].focus({ preventScroll: true });
                buttons[next].scrollIntoView({ block: "nearest" });
              }}
              style={{ display: "grid", gap: 8 }}
            >
              {request.options.map((option, index) => (
                <div
                  key={option}
                  role="button"
                  tabIndex={0}
                  data-extension-option
                  aria-label={option}
                  ref={index === 0 ? focusFirstOption : undefined}
                  onClick={() => onRespond(request, { value: option })}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onRespond(request, { value: option });
                  }}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                    overflowWrap: "anywhere",
                    // Match the scroller's padding so keyboard navigation never parks the
                    // option flush against the edge, where whole-pixel scroll snapping and
                    // overflow clipping cut off its focus ring.
                    scrollMargin: 14,
                  }}
                >
                  <div inert>
                    <MarkdownBody>{option}</MarkdownBody>
                  </div>
                </div>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) submitValue();
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 13,
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.nativeEvent.isComposing) submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div style={{ flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            autoFocus={request.method === "confirm" || (request.method === "select" && request.options.length === 0)}
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
             {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                cursor: "pointer",
              }}
            >
               {t("chat.confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                cursor: "pointer",
              }}
            >
               {t("chat.submit")}
            </button>
          ) : null}
        </div>
      </div>
      )}
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function ExtensionCustomPanel({
  request,
  waitingCount,
  onInput,
}: {
  request: ExtensionCustomRequest;
  /** Further custom panels queued behind this one; each opens after this one closes. */
  waitingCount: number;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const displayLines = normalizeCustomPanelLines(request.lines);
  const summary = displayLines.find((line) => line.trim())?.trim();

  useEffect(() => {
    if (!collapsed) inputRef.current?.focus();
  }, [collapsed]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: collapsed ? "flex-start" : "center",
        justifyContent: "center",
        padding: 20,
        pointerEvents: "none",
      }}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "min(920px, 100%)",
            width: "100%",
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 650, color: "var(--accent)", flexShrink: 0 }}>
            {t("chat.extensionPending")}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {t("chat.extensionPanel")}
          </span>
          {summary && (
            <span style={{ fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%", flexShrink: 1 }}>
              {summary}
            </span>
          )}
          <ExtensionWaitingCount count={waitingCount} />
          <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
            {t("chat.extensionExpand")}
          </span>
        </button>
      ) : (
      <div
        role="dialog"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          pointerEvents: "auto",
          position: "relative",
          // The extension already wrapped its lines to the width it asked for; show them
          // whole when that is wider than the usual 920px instead of scrolling sideways.
          width: "max-content",
          minWidth: "min(920px, 100%)",
          maxWidth: "100%",
          maxHeight: "min(760px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ExtensionWaitingCount count={waitingCount} />
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-expanded={true}
              title={t("chat.extensionCollapse")}
              aria-label={t("chat.extensionCollapse")}
              style={{
                display: "grid",
                placeItems: "center",
                width: 28,
                height: 28,
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
            <button
              onClick={() => onInput(request, "\x03")}
              style={{
                padding: "5px 9px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
               {t("chat.close")}
            </button>
          </div>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            minHeight: 0,
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          <AnsiText text={displayLines.join("\n")} />
        </pre>
      </div>
      )}
    </div>
  );
}

/**
 * Throttled render container for the streaming message: while streaming,
 * streamState.streamingMessage is a fresh object every frame (rAF flush); rendering it
 * directly breaks MessageView's memo every frame → the whole message tree reconciles
 * every frame. This throttles: the new object is handed to MessageView at most every
 * 200ms; intermediate frames reuse the old reference (memo hit, zero reconciliation).
 * Aligned with MarkdownBody's throttled parsing (200ms) — the text tail lags at most
 * one throttle window, visually imperceptible. When streaming ends (isStreaming=false)
 * the component unmounts and the message moves into the history list for full rendering.
 */
function StreamingMessageView({ message, modelNames }: {
  message: AgentMessage;
  modelNames?: Record<string, string>;
}) {
  const { t } = useI18n();
  const [renderMsg, setRenderMsg] = useState<AgentMessage | null>(message);
  const lastTs = useRef(0);
  const streamStartRef = useRef<number | null>(null);
  const prevTokensRef = useRef(0);
  useEffect(() => {
    const now = performance.now();
    if (now - lastTs.current >= 200) {
      lastTs.current = now;
      setRenderMsg(message);
    } else {
      const t = setTimeout(() => {
        lastTs.current = performance.now();
        setRenderMsg(message);
      }, 200 - (now - lastTs.current));
      return () => clearTimeout(t);
    }
  }, [message]);
  if (!renderMsg) return null;
  const content = streamingTextOf(renderMsg);
  // Lightweight speed indicator: estimated token count + t/s badge (mirrors the fully
  // rendered AssistantMessageView's styling/thresholds). The full character scan happens
  // once per throttled render (≥200ms apart), a negligible cost.
  let tokens = 0;
  if (renderMsg.role === "assistant") {
    for (const b of ((renderMsg as AssistantMessage).content ?? []) as AssistantContentBlock[]) {
      if (b.type === "text") tokens += estimateTokens(b.text);
      else if (b.type === "thinking") tokens += estimateTokens(b.thinking);
      else if (b.type === "toolCall") tokens += estimateTokens(b.rawInput ?? JSON.stringify(b.input ?? {}) ?? "");
    }
    tokens = Math.round(tokens);
  }
  // Timing baseline: on first tokens, or when the token count drops (within one agent
  // run, message_start replaces streamingMessage wholesale and the component doesn't
  // unmount) → reset the baseline so later messages don't dilute the t/s.
  if (tokens > 0 && (streamStartRef.current === null || tokens < prevTokensRef.current)) {
    // eslint-disable-next-line react-hooks/purity -- streaming timing baseline, not a pure render-derived value
    streamStartRef.current = Date.now();
  }
  prevTokensRef.current = tokens;
  let tps: number | null = null;
  if (tokens > 0 && streamStartRef.current !== null) {
    // eslint-disable-next-line react-hooks/purity -- same as above: reads the timing baseline during render
    const elapsed = (Date.now() - streamStartRef.current) / 1000;
    if (elapsed > 0.5) tps = tokens / elapsed;
  }
  // While streaming, render lightweight plain text (no markdown parsing): react-markdown
  // costs 100ms+ per parse of a few thousand lines of incremental text, whereas a
  // pre-wrap text node update is ~1ms. After streaming ends (streamingMessage cleared),
  // the message renders as rich text through the full MessageView; streaming-phase cost
  // stays negligible.
  return (
    <div>
      {tokens > 0 && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
          {renderMsg.role === "assistant" && (renderMsg as AssistantMessage).provider ? (
            <span>{modelNames?.[`${(renderMsg as AssistantMessage).provider}:${(renderMsg as AssistantMessage).model}`] ?? modelNames?.[(renderMsg as AssistantMessage).model] ?? (renderMsg as AssistantMessage).model}</span>
          ) : null}
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--text)" }} title={t("i18n.estimatedTokens")}>
            <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, fontWeight: 400 }}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
              </svg>
              {tokens}
            </span>
            {tps !== null && (() => {
              const bg = tps >= 50 ? "#53b3cb" : tps >= 30 ? "#9bc53d" : tps >= 15 ? "#f9c22e" : "#e01a4f";
              return (
                <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: bg, color: "#fff", fontSize: 11, fontWeight: 400 }}>
                  {tps.toFixed(1)} t/s
                </span>
              );
            })()}
          </span>
        </div>
      )}
      <StreamingText content={content} />
    </div>
  );
}

/** Lightweight streaming text extraction: AssistantMessage.content is a block array
 *  (text/thinking/toolCall); lightweight mode concatenates only text blocks — thinking/
 *  tool-call progress is not shown live (keeps zero parsing). Once complete, the message
 *  enters the history list and renders through the full MessageView with all blocks
 *  visible. */
function streamingTextOf(msg: AgentMessage): string {
  if (!("content" in msg)) return "";
  if (typeof msg.content === "string") return msg.content;
  let out = "";
  for (const b of msg.content) {
    if (b.type === "text") out += b.text;
  }
  return out;
}

/** Lightweight streaming text rendering: a single pre-wrap node, zero markdown parsing, diffing only the text as deltas arrive. */
function StreamingText({ content }: { content: string }) {
  return (
    <div className="streaming-plain" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      {content}
    </div>
  );
}

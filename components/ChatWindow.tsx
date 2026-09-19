"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, BlockingExtensionUiRequest, CustomMessage, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolResultMessage, UserMessage } from "@/lib/types";
import type { AttachedFile } from "@/hooks/useAgentSession";
import { normalizeCustomPanelLines } from "@/lib/ansi";
import { apiUrl, withBasePath } from "@/lib/base-path";
import { useMoneySynced } from "@/lib/money";
import { dedupeFetch } from "@/lib/dedupe-fetch";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { countToolCallBlocks, getAssistantErrorMessage, getDisplayableAssistantBlocks, isMessageGroupAnchor, splitFinalAssistantBlocks } from "@/lib/message-display";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import { buildQuotedSelection } from "@/lib/quoted-selection";
import { MessageView, estimateTokens } from "./MessageView";
import { SessionRequestCardHost } from "./SessionRequestSlot";
import { MarkdownBody } from "./MarkdownBody";
import { ChatInput, type AttachedImage, type ChatInputHandle } from "./ChatInput";
import { QueueRecoveryDialog } from "./QueueRecoveryDialog";
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
import { useAgentSession, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile, useIsCompact } from "@/hooks/useIsMobile";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { AppUpdateResponse } from "@/lib/api-types";
import type { ToolEntry } from "@/lib/tool-presets";
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

// 首屏渲染量：一次挂载满页。主流做法是虚拟化 + overscan（视口可见 ×2-3）；
// 窄屏视口约 6-10 条，30 条 ≈ 3-4 屏含缓冲（原 50 条偏高，已降）。

interface Props {
  session: SessionInfo | null;
  searchTarget?: { sessionId: string; entryId: string; blockIndex?: number } | null;
  onSearchTargetHandled?: (target: { sessionId: string; entryId: string }) => void;
  initialScrollPosition?: ChatScrollPosition | null;
  onScrollPositionChange?: (sessionId: string, position: ChatScrollPosition) => void;
  sessionRunning?: boolean;
  newSessionCwd: string | null;
  /** 新会话页工作区选择（AppShell 暂存的目标 cwd；null = 使用当前工作区）。
   *  选择不立即切换应用工作区——会话创建成功后 AppShell 才切入（见 handleSessionCreated）。 */
  newSessionWorkspace?: string | null;
  /** 新会话页工作区下拉候选（最近项目 + 当前 cwd；AppShell 供）。 */
  workspaceOptions?: Array<{ key: string; root: string }>;
  onNewSessionWorkspaceChange?: (cwd: string | null) => void;
  newSessionDraftKey: string | null;
  onAgentEnd?: () => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string) => void;
  /** 外部会话占位/别名 id 被服务端解析成真实复合 id（如 zcode:new-* → zcode:sess_*）。 */
  onSessionIdCanonicalized?: (previousId: string, canonicalId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  onSystemInfoLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  /** Register the stats refresher so AppShell can pull fresh stats (incl.
   *  contextUsage for idle sessions) when the session panel opens. */
  onSessionStatsRefresherRegister?: (fn: (() => void) | null) => void;
  /** 压缩控制注册（AppShell 会话信息面板三态压缩按钮）：compact 为 undefined（无会话 /
   *  sessionCap("compact") 不通过）时面板按钮隐藏，与 ChatInput 同规则。 */
  onCompactControlsRegister?: (controls: CompactControls | null) => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  /** 当前展示模型变化（AppShell 会话信息「剩余额度」区块据此置顶当前 provider）。 */
  onDisplayModelChange?: (model: { provider: string; modelId: string } | null) => void;
  onOpenFile?: (filePath: string) => void;
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

function phaseLabel(phase: AgentPhase, t: (key: string, params?: Record<string, string | number>) => string): string | null {
  if (phase?.kind === "running_tools") {
    const latest = phase.tools[phase.tools.length - 1];
    if (latest?.progress) {
      return `${t("chat.runningNamedTool", { name: latest.name })} ${latest.progress}`;
    }
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return t("chat.runningTool");
    if (names.length === 1) return t("chat.runningNamedTool", { name: names[0] });
    if (names.length <= 3) return t("chat.runningTools", { names: names.join(", ") });
    return t("chat.runningToolsMore", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  }
  if (phase?.kind === "waiting_model") return t("chat.waitingModel");
  if (phase?.kind === "running_command") return t("chat.runningCommand");
  if (phase?.kind === "compacting") return t("chat.compacting");
  return null;
}

/** 轮次读秒徽标（对齐 zcode desktop「工作中 (x分y秒)」）：纯本地 UI 时钟每秒自刷新，
 *  起点 = 本轮 agent_start（useAgentSession.runStartedAtRef）；仅显示逻辑，无任何状态轮询/请求。 */
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
/** 新会话页 Backend 下拉里扩展条目（newSessionBackendOptions）的 option value 前缀。
 *  选中即执行条目动作（如打开 ACP agent 管理），不改变当前 backend 选择。 */
const BACKEND_EXT_OPTION_PREFIX = "__ext_opt__:";
/** 新会话页 Workspace / Backend 两枚下拉的统一外观。 */
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
/** 草稿静默恢复等待输入框就绪的最大帧数（≈5s @60fps）；超时放行对话框手动处理，避免草稿被永久隐藏。 */
function NewSessionUpdateLink({
  label,
}: {
  label: (version: string) => string;
}) {
  const [update, setUpdate] = useState<AppUpdateResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(apiUrl("/api/app-update"), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<AppUpdateResponse>;
      })
      .then((result) => {
        if (result?.updateAvailable && result.latestVersion && result.releaseUrl) {
          setUpdate(result);
        }
      })
      .catch(() => {
        // Update checks are best-effort and must not interrupt a new session.
      });
    return () => controller.abort();
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

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
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
 * 权限卡入参摘要（权限 UI 契约，agent 规范 §6.1）：优选 command/path/url 等关键字段
 * 拼单行可读摘要；对象入参完整 JSON 折叠进「详情」。
 */

export function ChatWindow({ session, searchTarget, onSearchTargetHandled, initialScrollPosition, onScrollPositionChange, sessionRunning, newSessionCwd, newSessionWorkspace = null, workspaceOptions = [], onNewSessionWorkspaceChange, newSessionDraftKey, onAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked, onSessionIdCanonicalized, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsChange, onSessionStatsPanelOpen, onSessionStatsRefresherRegister, onCompactControlsRegister, onContextUsageChange, onDisplayModelChange, onOpenFile, onExportQueue, onOpenSession, onAskInNewChat, quoteSelectionEnabled = false, initialPrompt, onInitialPromptConsumed, soundEnabled = true, onSoundToggle, playDoneSound = () => {}, unlockAudio }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const isCompact = useIsCompact();

  // ── 会话后端选择（多 agent 前端）───────────────────────────────────────
  // 仅 isNew 欢迎页展示；选项来自 /api/session-backends（扩展注册的后端自动出现）。
  // null = 本地 pi（默认，不出现在列表里也无需请求）。
  // 上次选的后端记进 localStorage，下次新建会话自动预选同一 backend。
  const [backendOptions, setBackendOptions] = useState<Array<{ type: string; label: string; agentKey?: string }>>([]);
  // 新会话页 Backend 下拉内的扩展条目（newSessionBackendOptions）：如 ACP agent 管理入口。
  // 声明式静态条目 meta.onClick 由宿主转发器物化后回调；无 onClick 的条目不渲染（下拉里不可点）。
  const backendExtraOptions = useExtSlotItems("newSessionBackendOptions")
    .filter((it) => typeof it.meta?.onClick === "function");
  // 新会话欢迎页扩展选择器（newSessionSelectors，Workspace×Backend 之间渲染）与
  // 创建前 preparer 管道（newSessionPreparers，发送首条消息时在 ensureNewSession 内依序
  // await——worktree 创建/checkout 等全部写操作都发生在那一刻，选择阶段零副作用）。
  const hasNewSessionSelectors = useExtSlotItems("newSessionSelectors").some(hasExtRender);
  const newSessionPreparers: NewSessionPreparer[] = useExtSlotItems("newSessionPreparers")
    .filter((it) => typeof it.meta?.prepare === "function")
    .map((it) => ({ id: it.id, prepare: it.meta!.prepare as NewSessionPreparer["prepare"] }));
  // 新会话欢迎页小组件区（newSessionWidgets，顶部/底部两个渲染点）+ 自定义面板开关。
  // Zone 内部消费插槽与偏好（lib/new-session-widgets.ts），这里只持面板显隐。
  const [nswCustomizeOpen, setNswCustomizeOpen] = useState(false);
  // 工作区路径展示：home 目录缩写为 ~（被动订阅，不主动发请求——别的消费面拉到时自动缩短）。
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
  const soundedExtensionDialogIdRef = useRef<string | null>(null);
  const wrappedOnAgentEnd = useCallback(() => {
    if (completionNotificationsEnabled && soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.();
  }, [completionNotificationsEnabled, onAgentEnd]);

  // 稳定化 onEditContent 引用，配合 React.memo 防止历史消息重渲染
  const handleEditContent = useCallback((message: UserMessage) => {
    chatInputRef?.current?.replaceMessage(message);
  }, [chatInputRef]);

  // Spacer heights measured/derived below (bottom composer + prompt anchor).
  // Reflected up-front so they can be passed into useAgentSession for
  // step-follow geometry.
  const [bottomComposerHeight, setBottomComposerHeight] = useState(0);
  const bottomComposerHeightRef = useRef(0);
  const promptAnchorSpacerHeightRef = useRef(0); // 恒 0：step-follow 由 smartFollowStep 全权负责
  // 底部「step 余地」bottomEyeRoom：渲染期派生（见 scrollViewportH 声明处），不再走 effect+state。
  const initialScrollPositionRef = useRef(searchTarget ? null : initialScrollPosition ?? null);
  const [pendingScrollRestore, setPendingScrollRestore] = useState<Extract<ChatScrollPosition, { atBottom: false }> | null>(() => {
    const position = initialScrollPositionRef.current;
    return position && !position.atBottom ? position : null;
  });
  const [restoreAnchorReady, setRestoreAnchorReady] = useState(false);

  const {
    loading, error, messages, activeToolResults, entryIds, historyCursor, hasEarlierMessages, streamState,
    agentRunning, bashRunning, pendingBash, aborting, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    modelsRefreshing, modelsRefreshable, refreshModels,
    followPaused,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, compactQueued, cancelCompactQueue, modelSwitchPending, displayModel: displayModelValue, sessionStats, modelSwitching,
    slashCommands, slashCommandsLoading, queuedMessages, sessionTasks,
    pendingRecovery, recoveryIsImport, resolveRecovery, exportQueueData, importQueueData, stageImport, moveQueuedMessage, convertQueuedMessage, recallQueuedMessage, requeueAt, removeQueuedMessage, queueTrash, restoreQueueItem, purgeQueueTrash, trashComposerInput, restoreComposerTrash,
    notices, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput, setNoticePaused,
    switchPermissionMode, sessionCapabilities, backendSource, backendUsage,
    sessionRequest, respondToSessionRequest,
    isAutoModelSelection,
    isAutoThinkingSelection,
    agentPhase,
    runStartedAtRef,
    isNew,
    sessionIdRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef,
    handleSend, handleAbort, handleFork, handleForkNew, handleNavigate, handleEditFromStartSend, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    refreshSessionStats,
    handleRecallQueue, handleContinueQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadSlashCommands, scrollToBottom, scrollUserMsgToTop,
    loadContext, activeLeafId, scrollToMessage, reloadCurrentSession,
  } = useAgentSession({
    session, sessionRunning, newSessionCwd, newSessionDraftKey, newSessionBackend: sessionBackend, newSessionPreparers, onAgentEnd: wrappedOnAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked, onSessionIdCanonicalized,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsPanelOpen,
    promptAnchorSpacerHeightRef,
    bottomComposerHeightRef,
    deferInitialScroll: Boolean(pendingScrollRestore),
  });

  // 汇率：悬浮条真的有 USD cost 要显示时才订阅/拉取（用到才拉 /api/fx）。
  useMoneySynced((backendUsage?.costUsd ?? 0) > 0);

  // ── Stop 等待状态：点击后立即反馈（zcode session/stop 曾最长挂 23s，后端已改 fire-and-forget）。
  // 「停止中」由 useAgentSession 持有并在当前 turn 收口（agent_end / 完全 settle / bash 停止）时
  // 自动复位——不复位绑定 agentRunning：abort 后队列续轮会立即重新置 running（停止只停当前
  // 消息、队列下一条继续跑），若等「完全空闲」才复位会一直卡「停止中」（2026-09 实测）。 ──
  const handleAbortRequest = useCallback(() => {
    void handleAbort(); // handleAbort 内部已置 aborting=true 且吞错记日志，不抛
  }, [handleAbort]);

  // ── capability-aware 控件门控 ──────────────────────────────────────
  // 后端会话按 capabilities 隐藏不支持的功能；本地会话（无 capabilities）全通。
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

  // 压缩控制注册：仿 onSessionStatsRefresherRegister 先例反向注册给 AppShell（会话信息面板按钮），
  // state 实时跟随 isCompacting / compactQueued 变化。
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
  // 停止中状态复位已下沉到 useAgentSession（agent_end / settle / bash 收口时复位），
  // 见 handleAbort 与各收口点——此处不再依赖 sessionBusy（队列续轮时它恒为 true）。

  // ── 已停止会话的手动刷新（2026-09-15）：消息流最底部一行低调「刷新」入口。
  // 场景：会话已停止但可能被外部推进（zcode 桌面端/CLI 在 pi-web 之外续写同一
  // 会话；handle 复用后内存历史旧）——用户点一下即重新拉取消息 + 状态对齐源。 ──
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
    window.getSelection()?.removeAllRanges();
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

  // ──「编辑从此处」待发送标记（纯前端，发送才生效）──────────────────────────
  // 点击：预填输入框 + 高亮消息 + 按钮变「取消」；原位不动、无任何后端操作。
  // 取消 / 切走 / 刷新：自动还原（state 随组件卸载消失；suppressDraft 保证不落草稿）。
  // 发送：handleSendWrapped 里先 navigate_tree 回退（首条消息 → 根重建），再正常发送。
  const [editFromHerePending, setEditFromHerePending] = useState<{
    entryId: string;
    /** 回退目标：常规 = 上一条 assistant entryId；首条消息 = 消息自身 entryId */
    targetId: string;
    /** 回退后加载的 leaf（首条消息 = null） */
    leafId: string | null;
  } | null>(null);
  const editFromHerePendingRef = useRef(editFromHerePending);
  editFromHerePendingRef.current = editFromHerePending;

  // 分支导航（BranchNavigator/上下文链接）改变视图位置 → 待发送的「编辑从此处」标记失效，
  // 自动取消（否则发送时会强行回退到标记位置、覆盖用户刚导航到的分支）。
  // 发送路径不受影响：handleSendWrapped 在回退前已清 pending，这里 setState(null) 幂等。
  useEffect(() => {
    setEditFromHerePending(null);
  }, [activeLeafId]);

  // 标记（点击「编辑从此处」）：输入框非空且无标记时不覆盖（与 replaceMessage 的 canRestore 约定一致）；
  // 已有标记时先清旧预填再标记新的（避免 composer 残留上一目标文本导致 replaceMessage 静默失效）
  // 前置门（ai变更处置）：编辑从此处 = 回退到该分支点重发 → 扩展（如 aiti-git-trace 回撤三选项）
  // 先让用户决定是否回滚该区间文件变更；取消则中止标记（fork 新会话不动原会话，不触发门）。
  const handleEditFromHereMark = useCallback(async (entryId: string, message: UserMessage, branchPointId: string | null) => {
    // 免打扰预检在门之前：输入框非空且无标记时本就静默中止——先弹回撤门会让用户白答一次。
    const hasPending = editFromHerePendingRef.current != null;
    if (!hasPending && chatInputRef?.current?.hasInput?.()) return;
    const sid = sessionIdRef.current;
    if (sid) {
      // 被裁轮次集合 = 被编辑消息 M 及之后全部用户消息 entryId（按会话顺序）——
      // 扩展据此精确圈定回滚区间（含被编辑轮），而非仅 entryId 之后的 op。
      // 从 entryIds 找 M 的位置，收集其后 role==="user" 的 entryId。
      let cutUserEntryIds: string[] = [];
      const mi = entryIds.indexOf(entryId);
      if (mi >= 0) {
        for (let i = mi; i < messages.length; i++) {
          if (messages[i]?.role === "user" && entryIds[i]) cutUserEntryIds.push(entryIds[i]);
        }
      }
      const allowed = await runSessionForkGates({ sessionId: sid, entryId, position: "before", cutUserEntryIds });
      if (!allowed) return;
      // 回撤门是非模态浮层：等待期间用户可能已手动输入——复检防预填覆盖（canRestore 约定）。
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

  // 取消：还原高亮 + 清空预填输入框（clearInput 同时清掉草稿）
  const handleCancelEditFromHere = useCallback(() => {
    setEditFromHerePending(null);
    chatInputRef?.current?.clearInput?.();
  }, [chatInputRef]);

  // 发送：pending 时先回退会话（真正生效点），再发送编辑后的消息。
  // bash 命令（! 前缀）不触发回退——用户此时只是想跑 shell，标记保留待下次发送。
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
  /** 「继续」按钮：AI 完全停止（无 streaming）时出现——点击快速发送“继续”消息，触发 agent 继续运行。
   *  仅在 agent 空闲时可见（ChatInput 只在非 streaming 分支渲染）。
   *  队列里有未投递消息（如重启后恢复了队列但没继续）时改为投递队列（runAgentContinue 路径），
   *  队列为空才发送普通的“继续”。 */
  const handleContinue = useCallback(() => {
    const queued = (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0);
    if (queued > 0) {
      void handleContinueQueue();
      return;
    }
    void handleSend(t("chat.continue"));
  }, [handleSend, handleContinueQueue, queuedMessages, t]);

  // 底部「step 余地」：agent 运行时撑 padding（ch-120-composerH），让 smartFollowStep 的
  // 「最后消息底钉 120px」不超过 maxScrollTop（19031a2 删 spacer 后丢失 → step 被 clamp 贴底）。
  // ch 随 AI 窗/窗口变化 ⇒ ResizeObserver 跟踪；容器可能延迟挂载（空会话首屏无容器）⇒
  // callback ref 转发 scrollContainerRef 并触发 scReady，保证容器出现后 RO 重新挂载。
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
  // 底部「step 余地」：agent 运行时撑 padding（ch-120-composerH），让 smartFollowStep 的
  // 「最后消息底钉 120px」不超过 maxScrollTop（19031a2 删 spacer 后丢失 → step 被 clamp 贴底）。
  // 必须渲染期派生（不能用 effect+state）：handleSend 同一 commit 里乐观置 agentRunning +
  // 追加用户消息，发送跳转（scrollUserMsgToTop）在该 commit 的 layout 阶段读 maxScrollTop；
  // 若垫高晚一拍（旧 effect 版），maxScrollTop 不含 padding → target 被 clamp 到当前位置 =
  // no-op，新消息留在视口下方且后续 step 被 2s 按压守卫压住 → 「发送后视图不动」（step-follow
  // 失效根因）。派生值与 agentRunning 同 commit 生效，跳转天然拿到含垫高的 maxScrollTop。
  // 防循环：padding 不改变 flex 定高的 clientHeight（RO 读它，值不变则 setState bail）。
  const bottomEyeRoom = agentRunning
    ? Math.max(0, scrollViewportH - 120 - bottomComposerHeight)
    : 0;

  /** Draft storage key for the active session (matches ChatInput's draftKey).
   *  New sessions MUST use newSessionDraftKey（含每次新建唯一的 draftId）而不是
   *  `new:<cwd>`：共享 cwd 级 key 会让上一个新建会话未发送的残留（哪怕一个 @）
   *  在之后每次新建都被静默恢复回来，且 promoteNewSession 的 rekey 永远对不上号。 */
  const draftKey = session?.id ?? newSessionDraftKey ?? undefined;

  // 草稿簇外迁（defork P2）：草稿扫描/静默恢复/对话框合成全部由 aiti-draft-keeper
  // 经 composer 契约接管；core 不再持有 draft-store，仅做服务端队列恢复 + ext 路由。
  // 恢复项 = 服务端队列恢复 + 扩展提供者（keeper）的草稿项。
  const extRecoveryItems = useRecoveryProviderItems() as PendingRecoveryItem[];
  const recoveryItems = [
    ...pendingRecovery,
    ...extRecoveryItems,
  ];

  // 恢复对话框决议：ext: 前缀项路由回提供者（keeper 自决还原/排队/丢弃），
  // 服务端项走 resolveRecovery；continueRun 对纯草稿项触发 handleContinueQueue。
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

  useEffect(() => {
    if (
      !completionNotificationsEnabled
      || !extensionDialog
      || soundedExtensionDialogIdRef.current === extensionDialog.id
    ) return;
    soundedExtensionDialogIdRef.current = extensionDialog.id;
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
  const sentinelRef = useRef<HTMLDivElement>(null);
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
          const context = await loadContext(sessionId, activeLeafId, before, { signal: controller.signal });
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
  }, [activeLeafId, loadContext, loading, pendingScrollRestore, scrollToBottom, searchTarget, session?.id]);

  useLayoutEffect(() => {
    const position = pendingScrollRestore;
    const content = messageContentRef.current;
    if (!position || !content || searchTarget) return;
    const element = Array.from(content.children).find((candidate) => (
      candidate instanceof HTMLElement && candidate.dataset.entryId === position.anchorEntryId
    ));
    if (element instanceof HTMLElement) {
      scrollToMessage(element, position.anchorOffset);
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
        const context = await loadContext(searchTarget.sessionId, activeLeafId, history.historyCursor, { tail: 200, signal: controller.signal });
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
  }, [searchTarget, loading, activeLeafId, sessionBusy, loadContext, onSearchTargetHandled, scrollContainerRef]);

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
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        // No older history loaded yet: fetch the previous page from the server
        // and prepend it (loadContext handles prepend + scroll anchoring).
        // Skip while a page is already loading or nothing older exists.
        if (loadingOlderRef.current) return;
        if (!hasEarlierMessages) return;
        const oldestId = historyCursor;
        if (!oldestId) return;
        const sid = session?.id ?? sessionIdRef.current;
        if (!sid) return;
        loadingOlderRef.current = true;
        prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
        void loadContext(sid, activeLeafId, oldestId).finally(() => {
          loadingOlderRef.current = false;
        });
      },
      { root: container, threshold: 0, rootMargin: "0px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [historyCursor, hasEarlierMessages, session, activeLeafId, loadContext, sessionIdRef, scrollContainerRef]);

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

  const onDrop = useCallback((files: File[]) => {
    chatInputRef?.current?.addImages(files);
  }, [chatInputRef]);

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

  // 发现可用后端（仅新会话欢迎页；扩展注册的后端自动出现，无后端时选择器不渲染）。
  useEffect(() => {
    if (!isNew || backendOptions.length > 0) return;
    let cancelled = false;
    // dedupeFetch：StrictMode 双 effect / 重挂共享同一次请求（后端清单稳定，微缓存 2.5s）。
    dedupeFetch(apiUrl("/api/session-backends"))
      .then((r) => (r.ok ? r.json() : { providers: [] }))
      .then((d: { providers?: Array<{ type: string; label: string; agentKey?: string }> }) => {
        if (cancelled) return;
        setBackendOptions(d.providers ?? []);
        // 记忆的后端已不存在（扩展卸载/改名）则回退本地 pi
        setSessionBackend((cur) => (cur && (d.providers ?? []).some((p) => p.type === cur) ? cur : null));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isNew, backendOptions.length]);
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
      // RO 回调传入 borderBoxSize（layout 后触发，读取免费）；仅在初始/无参时读 rect
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

  // Step-follow 由 useAgentSession 的 smartFollowStep 全权负责（useEffect [streamState]
  // → 内容增长超出视口时 scrollTo 回 120px 处）。此处不再撑 promptAnchorSpacer：
  // 该 spacer 算法与内容位置无关（差值恒定），流式期间恒定撑高视口下方 3/4 为空白，
  // 且与 smartFollowStep 的 target 计算冲突（实测 spacer 457px 恒定 + step 稀疏 + 结束骤变）。
  // spacer 恒 0 → smartFollowStep 每屏正常 step，最后消息持续钉在视口顶部 1/4。

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
      // fork 新会话仅本地 pi 会话可用（sessionCapabilities 非空 = 外部后端，handle-adapter
      // 无 fork_branch）；新草稿会话无可复制对话同样不接。
      onForkNew={isNew || sessionCapabilities ? undefined : handleForkNew}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onQueueFollowUp={handleFollowUp}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      onQueueSteerSend={handleSteer}
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
      // aiti-ctx-meter 接缝：完整上下文快照 + 会话面板入口（docs/aiti-ctx-meter-plan.md §4.1）
      contextUsage={contextUsage}
      onSessionStatsPanelOpen={onSessionStatsPanelOpen}
      onCompact={session || isNew
        ? (sessionCap("compact") ? handleCompact : undefined)
        : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
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

      {recoveryItems.length > 0 && !recoveryDismissed && (
        <QueueRecoveryDialog
          items={recoveryItems}
          sessionId={session?.id ?? sessionIdRef.current ?? undefined}
          onResolve={handleResolveRecovery}
          onExport={exportQueueData}
          onImport={importQueueData}
          onDismiss={() => setRecoveryDismissed(true)}
          mode={recoveryIsImport ? "import" : "recovery"}
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

      {/* 会话请求卡接管缝（agent 能力 UI 去核化）：扩展路由优先（aiti-session-cards /
        aiti-zcode-agent client），未命中落 core 极简兜底卡（capability 不裸奔）。
        方案 docs/pi-web-agent-capability-ui-ext-plan.md §2.1。 */}
      {sessionRequest && (
        <SessionRequestCardHost
          request={sessionRequest}
          respond={(answer) => respondToSessionRequest(sessionRequest.requestId, answer)}
          backendSource={backendSource}
          currentSession={session ? { id: session.id, cwd: session.cwd, name: session.name, firstMessage: session.firstMessage } : null}
        />
      )}

      {/* 新会话欢迎页小组件区·顶部（newSessionWidgets；仅 isEmptyNew 渲染，空态零占位）。
          Zone 自带限高滚动（TOP_ZONE_MAX_HEIGHT），shrink-0 不挤压消息区/composer。
          extra 只喂数据 {cwd,isMobile,area}；面板 state 在本组件（nswCustomizeOpen）。 */}
      {isEmptyNew && (
        <NewSessionWidgetZone
          area="top"
          cwd={newSessionCwd}
          onEdit={() => setNswCustomizeOpen(true)}
        />
      )}

      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {extensionDialog && (
          <ExtensionDialog key={extensionDialog.id} request={extensionDialog} onRespond={respondToExtensionUi} />
        )}
        {extensionCustomUi && (
          <ExtensionCustomPanel key={extensionCustomUi.id} request={extensionCustomUi} onInput={sendExtensionCustomInput} />
        )}
        {!isEmptyNew && (<>
      <div ref={handleScrollBoxRef} data-chat-scroll className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-width:none]" style={{ paddingBottom: bottomEyeRoom, visibility: pendingScrollRestore ? "hidden" : undefined }}>
          <div style={{ minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div ref={messageContentRef} onPointerUp={captureQuotedSelection} style={{ width: "100%", minWidth: 0, maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
            {(() => {
              let lastUserIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") { lastUserIdx = i; break; }
              }
              // Anchor for live-tail detection: the last user message, or a
              // compaction summary when compaction has replaced it mid-turn.
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

              const renderMessage = (idx: number, options: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean; writtenFiles?: WrittenFile[]; turnAssistantEntryIds?: string[]; suppressMessageFooter?: boolean } = {}): ReactNode => {
                const msg = options.messageOverride ?? messages[idx];
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
                    onOpenSession={onOpenSession}
                    entryId={entryIds[idx]}
                    searchBlock={entryIds[idx] === pendingSearchScroll?.entryId ? searchBlock : undefined}
                    onFork={isNew || !sessionCap("fork") ? undefined : handleFork}
                    forking={forkingEntryId === entryIds[idx]}
                    onNavigate={isNew ? undefined : handleNavigate}
                    prevAssistantEntryId={isNew ? undefined : prevAssistantEntryId}
                    onEditFromHere={sessionBusy || isNew || !(sessionCap("navigateTree") || sessionCap("fork")) ? undefined : handleEditFromHereMark}
                    editingFromStart={editFromHerePending?.entryId === entryIds[idx]}
                    onCancelEditFromStart={handleCancelEditFromHere}
                    showTimestamp={showTimestamp}
                    prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                    writtenFiles={options.writtenFiles}
                    turnAssistantEntryIds={options.turnAssistantEntryIds}
                    suppressMessageFooter={options.suppressMessageFooter}
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
                if (!isMessageGroupAnchor(msg)) {
                  rendered.push(renderMessage(idx));
                  idx += 1;
                  continue;
                }

                const userIdx = idx;
                let endIdx = userIdx + 1;
                while (endIdx < messages.length && !isMessageGroupAnchor(messages[endIdx])) endIdx += 1;

                const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);

                if (finalAssistantIdx === -1) {
                  for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                  }
                  idx = endIdx;
                  continue;
                }

                const isLiveTail = (sessionBusy || streamState.isStreaming) && endIdx === messages.length && userIdx === lastAnchorIdx;
                if (isLiveTail) {
                  for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                  }
                  idx = endIdx;
                  continue;
                }

                rendered.push(renderMessage(userIdx));

                const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
                const finalSplit = splitFinalAssistantBlocks(finalAssistant);
                const finalAnswerMessage = finalSplit.answerBlocks.length > 0 || getAssistantErrorMessage(finalAssistant)
                  ? withAssistantBlocks(finalAssistant, finalSplit.answerBlocks)
                  : null;

                const finalProcessEnd = finalAssistant.content.indexOf(finalSplit.answerBlocks[0]);
                // Keep the original prefix so deferred thinking retains its stored block indices.
                const finalProcessBlocks = finalAssistant.content.slice(0, finalProcessEnd < 0 ? undefined : finalProcessEnd);

                const processViews: ReactNode[] = [];
                let processToolCount = 0;
                let processRefIdx: number | undefined;
                let revealProcess = false;

                for (let processIdx = userIdx + 1; processIdx <= finalAssistantIdx; processIdx++) {
                  const processMessage = messages[processIdx];
                  if (processMessage.role === "custom") {
                    revealProcess ||= Boolean(pendingSearchScroll && pendingSearchScroll.entryId === entryIds[processIdx]);
                    processViews.push(renderMessage(processIdx, { attachRef: false, keyPrefix: "process" }));
                    continue;
                  }
                  if (processMessage.role !== "assistant") continue;
                  const message = processIdx === finalAssistantIdx
                    ? withAssistantBlocks(processMessage, finalProcessBlocks, { omitUsage: Boolean(finalAnswerMessage) })
                    : processMessage;
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
                    // 整轮变更文件已由最终回答处的 turn 级 footer 聚合（assistantEntryIds），
                    // 过程消息的消息级 footer 在此关闭，避免展开分组时同一文件出现两次。
                    // 仅当该轮确有最终回答时抑制——中断轮（无 answer blocks）没有最终回答
                    // 渲染点，过程消息的消息级 footer 是唯一展示位，必须保留。
                    suppressMessageFooter: Boolean(finalAnswerMessage),
                  }));
                }

                if (processViews.length > 0) {
                  rendered.push(
                    <div
                      key={`process-group-${entryIds[userIdx] ?? userIdx}`}
                      ref={processRefIdx === undefined ? undefined : (el) => { messageRefs.current[processRefIdx] = el; }}
                    >
                      <ProcessDetailsGroup messageCount={processViews.length} toolCallCount={processToolCount} defaultExpanded={!finalAnswerMessage} reveal={revealProcess} t={t}>
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
                  const writtenFiles = extractTurnWrittenFiles(turnContent, toolResultsMap, messageCwd);
                  rendered.push(renderMessage(finalAssistantIdx, {
                    messageOverride: finalAnswerMessage,
                    writtenFiles,
                    turnAssistantEntryIds,
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
                     <div ref={sentinelRef} className="py-3 text-center text-xs text-text-muted">
                       {t("chat.loadEarlier")}
                    </div>
                  )}
                  {rendered.slice(startIndex)}
                </>
              );
            })()}
            {streamState.isStreaming && hasStreamingContent && streamState.streamingMessage && (
              <MessageView message={streamState.streamingMessage as AgentMessage} toolResults={toolResultsMap} isStreaming modelNames={modelNames} cwd={messageCwd} onOpenFile={onOpenFile} onOpenSession={onOpenSession} />
            )}

            {agentRunning && !hasStreamingContent && agentPhase && (
              <div className="break-words py-2 text-[13px] text-text-muted">
                <span className="animate-[pulse_1.5s_infinite]">
                  {phaseLabel(agentPhase, t)}
                  {runStartedAtRef.current !== null && <ElapsedBadge startedAt={runStartedAtRef.current} />}
                </span>
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
                onOpenSession={onOpenSession}
              />
            )}

            {/* 已停止会话：消息流最底部一行低调「刷新」入口（外部推进/内存历史旧时手动对齐）。
                所有 agent 通用；运行时/新会话不显示（新会话刷新会破坏草稿语义）。 */}
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

            {/* 底部输入区高度占位（保持尾钉）；step-follow spacer 已移除（恒 0） */}
            <div aria-hidden="true" style={{ height: bottomComposerHeight }} />

            <div ref={messagesEndRef} />
            </div>
          </div>
        </div>

        {/* 消息滚动导航条已抽离为扩展（aiti-msg-nav 注册到 chatOverlay 插槽）；
            消息锚点横幅（aiti-msg-anchor）同插槽。currentSession 透传会话标题：
            name + firstMessage（无 name 时与左侧 session 列表一致取第一条用户输入）。
            extra.revealHistory：aiti-msg-nav「到最早/上一条」跳转目标在渲染窗口外时
            一次性全量展开，与 ChatMinimap 的 onRevealHistory 同源。 */}
        <ExtSlot
          name="chatOverlay"
          currentSession={session ? { id: session.id, cwd: session.cwd, name: session.name, firstMessage: session.firstMessage } : null}
          extra={{ agentRunning, isMobile, revealHistory: revealHistoryForMinimap,
            /* 用量徽标接缝（P3 去核化）：数据仍在 core（get_usage 协议），展示归 aiti-provider-usage。
               isEmptyNew 语义保留——新建空会话不透传（与原 core 徽标渲染条件一致）。 */
            backendUsage: isEmptyNew ? null : backendUsage, backendSource }}
        />

        {isMobile || isCompact ? null : (
          <ChatMinimap
            messages={messages}
            streamingMessage={streamState.streamingMessage}
            scrollContainer={scrollContainerRef}
            messageRefs={messageRefs}
            onRevealHistory={revealHistoryForMinimap}
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
            zIndex: 130,
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
          {onAskInNewChat && quotedSelection.sourceEntryId && !sessionBusy && (
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
        {isEmptyNew && (
          <div className="mb-3 w-full" style={{ paddingLeft: 16, paddingRight: isMobile ? 16 : 52 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto", fontFamily: "var(--font-mono)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 7 : 10, minWidth: 0, flex: 1, lineHeight: 1.4, overflow: "hidden" }}>
                <Image src={withBasePath("/icons/apple-touch-icon.png")} width={32} height={32} alt="" priority style={{ flexShrink: 0 }} />
                <span style={{ fontSize: 22, color: "var(--text)", fontWeight: 700, flexShrink: 0, whiteSpace: "nowrap" }}>Pi Web</span>
                <NewSessionUpdateLink label={(version) => t("appUpdate.releaseNotes", { version })} />
              </div>
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
              {/* 工作区选择（Backend 之前）：默认当前 cwd；选择只暂存目标，不立即切换工作区——
                  发送创建会话成功后由 AppShell 切入目标工作区并打开新会话。 */}
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
              {/* 扩展选择器（分支/Worktree picker 等）：插槽渲染不包盒子（fragment 直出，
                  picker 自身是 flex 子项），flexWrap 布局不变；意图条经 flexBasis:100% 折行到本行下方。
                  extra 只喂数据 {cwd,isMobile}（插槽 extra 红线）；写操作全在 newSessionPreparers。 */}
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
                      // 扩展条目（如「Manage ACP Agents…」）：不是后端选项——执行动作后
                      // 把下拉复位，当前 backend 选择不变。
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
                    {/* 后端管理入口是扩展点：各后端扩展经 newSessionBackendOptions 插槽
                        将自己的入口作为下拉最后若干项（如 aiti-acp-agent 的 agent 管理），
                        core 不感知任何具体后端。 */}
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
        {/* 扩展 widget 只在两处出现：桌面底部状态架（下方 ExtensionStatusBar）、
            小屏 ⓘ/＋ InfoSheet（ChatInput）。原先按 placement 又在输入框上/下各渲染一份，
            与状态架重复（同一 widget 出现两次、位置一上一下）——已收敛，placement 仅保留
            在状态架 trigger 的方向图标上。 */}
        {chatInputElement}
        {/* 小屏：状态架整架不常驻（输入条=最底常驻元素），变化走 toast；详情收进
            ChatInput 的 ⓘ sheet。桌面状态架照旧。docs/pi-web-mobile-input-wechat-plan.md §六 */}
        {isMobile
          ? <ExtensionStatusToast statuses={extensionStatuses} />
          : <ExtensionStatusBar statuses={extensionStatuses} widgets={extensionWidgets} />}
      </div>
      {/* 新会话欢迎页小组件区·底部（composer 下方原 filler 位；无可见条目时返回等价
          filler div，布局逐字节不变）+ 自定义面板单例（portal 到 body）。 */}
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

// Toast 整体高度上限；文本区高度上限 = 整体上限 - 上下 padding(14*2) - 上下边框(1*2)
const NOTICE_MAX_HEIGHT_PX = 500;
const NOTICE_TEXT_MAX_HEIGHT_PX = NOTICE_MAX_HEIGHT_PX - 30;

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
              minHeight: 60,
              height: "auto",
              // 整体高度上限：超出后由文本区内部滚动承担（见下方 span 的 overflowY），
              // 容器自身保持 hidden，小圆点固定在顶部不随文本滚动
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
                // Align with the optical center of the first text line: 14px vertical
                // padding + (21px line box - 7px dot) / 2
                marginTop: 21,
              }}
            />
            {/* Full text by default: pre-line preserves \n (nowrap/normal collapse
                newlines into spaces) and long lines wrap instead of truncating;
                content taller than the cap scrolls inside the text area */}
            <span
              tabIndex={0}
              style={{ padding: "14px 0", minWidth: 0, maxWidth: "100%", maxHeight: NOTICE_TEXT_MAX_HEIGHT_PX, overflowY: "auto", scrollbarWidth: "thin", whiteSpace: "pre-line", wordBreak: "break-word" }}
            >
              {notice.message}
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

function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const focusFirstOption = useCallback((element: HTMLDivElement | null) => element?.focus(), []);
  const summary = getExtensionDialogSummary(request);
  const remainingSeconds = request.expiresAt === undefined
    ? null
    : Math.max(0, Math.ceil((request.expiresAt - now) / 1000));

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
          {countdown}
          <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
            {t("chat.extensionExpand")}
          </span>
        </button>
      ) : (
      <div
        role="dialog"
        aria-label={request.title}
        style={{
          pointerEvents: "auto",
          width: "min(560px, 100%)",
          maxHeight: "min(760px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ flexShrink: 0, display: "flex", alignItems: "flex-start", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--border)", maxHeight: "50%", overflowY: "auto" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Pi's TUI shows the title verbatim, newlines included; select/input have no
                separate message field, so extensions put multi-line text here. */}
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{request.title}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
              <span>{t("chat.extensionRequest")}</span>
              {countdown}
            </div>
          </div>
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
  onInput,
}: {
  request: ExtensionCustomRequest;
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
          width: "min(920px, 100%)",
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
 * 流式消息节流渲染容器：流式期间 streamState.streamingMessage 每帧（rAF flush）都是新对象，
 * 直接渲染会让 MessageView（memo）每帧被打破 → 整棵消息树每帧协调。
 * 这里节流：至少 200ms 才把新对象交给 MessageView，中间帧复用旧引用（memo 命中，零协调）。
 * 与 MarkdownBody 的节流解析（200ms）对齐——文本尾部最多滞后一个节流窗口，视觉无感。
 * 流式结束（isStreaming=false）时组件卸载，消息移入历史列表走完整渲染。
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
  // 轻量流速指示：估算 token 数 + t/s 徽标（对齐完整渲染 AssistantMessageView 的样式/阈值）。
  // 只在节流后的渲染（≥200ms 一次）里做一次全量字符扫描，成本可忽略。
  let tokens = 0;
  if (renderMsg.role === "assistant") {
    for (const b of ((renderMsg as AssistantMessage).content ?? []) as AssistantContentBlock[]) {
      if (b.type === "text") tokens += estimateTokens(b.text);
      else if (b.type === "thinking") tokens += estimateTokens(b.thinking);
      else if (b.type === "toolCall") tokens += estimateTokens(b.rawInput ?? JSON.stringify(b.input ?? {}) ?? "");
    }
    tokens = Math.round(tokens);
  }
  // 计时基线：首次出现 token，或 token 数回落（同一 agent 运行内 message_start 用新消息
  // 整体替换 streamingMessage、组件不卸载）→ 重置基线，避免后续消息的 t/s 被稀释。
  if (tokens > 0 && (streamStartRef.current === null || tokens < prevTokensRef.current)) {
    // eslint-disable-next-line react-hooks/purity -- 流式计时基线，非纯渲染派生值
    streamStartRef.current = Date.now();
  }
  prevTokensRef.current = tokens;
  let tps: number | null = null;
  if (tokens > 0 && streamStartRef.current !== null) {
    // eslint-disable-next-line react-hooks/purity -- 同上：渲染期读取计时基线
    const elapsed = (Date.now() - streamStartRef.current) / 1000;
    if (elapsed > 0.5) tps = tokens / elapsed;
  }
  // 流式期间走轻量文本渲染（不解析 markdown）：react-markdown 对几千行增量文本每次解析
  // 成本 100ms+，纯文本 pre-wrap 一次文本节点更新 ~1ms。结束（streamingMessage 置空）后
  // 该消息以完整 MessageView 渲染富文本，流式期成本可忽略。
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

/** 流式轻量文本提取：AssistantMessage.content 是块数组（text/thinking/toolCall），
 *  轻量模式只拼 text 块——thinking/工具调用过程不实时展示（保持零解析），
 *  消息完成后进入历史列表走完整 MessageView，所有块完整可见。 */
function streamingTextOf(msg: AgentMessage): string {
  if (!("content" in msg)) return "";
  if (typeof msg.content === "string") return msg.content;
  let out = "";
  for (const b of msg.content) {
    if (b.type === "text") out += b.text;
  }
  return out;
}

/** 流式期间轻量文本渲染：pre-wrap 单节点，零 markdown 解析，随增量只 diff 文本。 */
function StreamingText({ content }: { content: string }) {
  return (
    <div className="streaming-plain" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      {content}
    </div>
  );
}

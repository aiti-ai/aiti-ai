"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, BlockingExtensionUiRequest, CustomMessage, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolResultMessage, UserMessage } from "@/lib/types";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";
import { apiUrl } from "@/lib/base-path";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { countToolCallBlocks, getAssistantErrorMessage, getDisplayableAssistantBlocks, splitFinalAssistantBlocks } from "@/lib/message-display";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import { MessageView, estimateTokens } from "./MessageView";
import { ChatInput, type AttachedImage, type ChatInputHandle } from "./ChatInput";
import { QueueRecoveryDialog } from "./QueueRecoveryDialog";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { ExtSlot } from "./ExtSlots";
import type { PendingRecoveryItem, QueueEntry } from "@/lib/queue-store";
import { useRecoveryProviderItems, routeRecoveryResolve } from "@/lib/composer/recovery";
import { hasComposerEnhancement, subscribeComposerEnhancers, getComposerEnhancersVersion } from "@/lib/composer/bus";
import { clearDraft, DRAFT_KEY_PREFIX, listDraftSlots, removeDraftSlot, type DraftSlotInfo } from "@/lib/draft-store";
import { ExtensionStatusBar } from "./ExtensionStatusBar";
import { useI18n } from "@/hooks/useI18n";
import { useAgentSession, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
import { ExtensionWidgets } from "./ExtensionWidgets";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile, useIsCompact } from "@/hooks/useIsMobile";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { AppUpdateResponse } from "@/lib/api-types";
import {
  captureScrollDistance,
  getNextVisibleCount,
  getVisibleRenderWindow,
  restoreScrollTop,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";

// 首屏渲染量：一次挂载满页。主流做法是虚拟化 + overscan（视口可见 ×2-3）；
// 窄屏视口约 6-10 条，30 条 ≈ 3-4 屏含缓冲（原 50 条偏高，已降）。

interface Props {
  session: SessionInfo | null;
  sessionRunning?: boolean;
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  onAgentEnd?: () => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemPromptLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  /** Register the stats refresher so AppShell can pull fresh stats (incl.
   *  contextUsage for idle sessions) when the session panel opens. */
  onSessionStatsRefresherRegister?: (fn: (() => void) | null) => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string) => void;
  /** Expose the queue-export resolver to the parent (AppShell export dialog). */
  onExportQueue?: (resolver: () => Promise<{ live: QueueEntry[]; recovery: QueueEntry[] } | null>) => void;
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
  return null;
}

const CHAT_MINIMAP_WIDTH = 36;
const CHAT_COLUMN_PADDING = 16;
const CHAT_INPUT_RIGHT_PADDING = CHAT_COLUMN_PADDING + CHAT_MINIMAP_WIDTH;
/** 草稿静默恢复等待输入框就绪的最大帧数（≈5s @60fps）；超时放行对话框手动处理，避免草稿被永久隐藏。 */
const MAX_DRAFT_RESTORE_READY_FRAMES = 300;
/** 别的标签页在这个时限内还在写入的草稿槽位视为「活人在用」，不在本页弹恢复框（见 readDrafts）。 */
const LIVE_FOREIGN_SLOT_MS = 60_000;

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

function countToolCalls(messages: AgentMessage[], indices: number[]): number {
  let count = 0;
  for (const idx of indices) {
    const msg = messages[idx];
    if (msg?.role !== "assistant") continue;
    count += countToolCallBlocks(getDisplayableAssistantBlocks(msg as AssistantMessage));
  }
  return count;
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  }
  return message.role === "custom";
}

// A user message normally anchors a turn (user prompt → process → final
// answer), and the process messages in between get folded into a collapsed
// ProcessDetailsGroup. When compaction fires mid-turn, pi drops the original
// user prompt and inserts a compaction summary (role "custom", customType
// "compaction") in its place; the agent then keeps producing tool calls and a
// final answer with no user message left to anchor them. Treat a compaction
// summary as an anchor too, otherwise every post-compaction message renders
// standalone and never collapses.
function isGroupAnchor(message: AgentMessage): boolean {
  if (message.role === "user") return true;
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
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

function ProcessDetailsGroup({ messageCount, toolCallCount, defaultExpanded = false, children, t }: { messageCount: number; toolCallCount: number; defaultExpanded?: boolean; children: ReactNode; t: (key: string, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const parts = [t("chat.processDetails"), `${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`];
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={expanded}
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
      {expanded && (
        <div style={{ marginTop: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function ChatWindow({ session, sessionRunning, newSessionCwd, newSessionDraftKey, onAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemPromptLoaderChange, onSessionStatsChange, onSessionStatsPanelOpen, onSessionStatsRefresherRegister, onContextUsageChange, onOpenFile, onExportQueue, soundEnabled = true, onSoundToggle, playDoneSound = () => {}, unlockAudio }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const isCompact = useIsCompact();

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
    if (soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.();
  }, [onAgentEnd]);

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
  // 底部「step 余地」state：agent 运行时撑 padding，见下方 useEffect（在 useAgentSession 之后）
  const [bottomEyeRoom, setBottomEyeRoom] = useState(0);

  const {
    loading, error, messages, entryIds, streamState,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, compactQueued, cancelCompactQueue, modelSwitchPending, displayModel: displayModelValue, sessionStats, modelSwitching,
    slashCommands, slashCommandsLoading, queuedMessages,
    pendingRecovery, recoveryIsImport, resolveRecovery, exportQueueData, importQueueData, stageImport, moveQueuedMessage, convertQueuedMessage, recallQueuedMessage, requeueAt, removeQueuedMessage, queueTrash, restoreQueueItem, purgeQueueTrash,
    notices, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection,
    agentPhase,
    isNew,
    sessionIdRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef,
    handleSend, handleAbort, handleFork, handleNavigate, handleEditFromStartSend, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    refreshSessionStats,
    handleRecallQueue, handleContinueQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadSlashCommands, scrollToBottom,
    activeLeafId,
  } = useAgentSession({
    session, sessionRunning, newSessionCwd, newSessionDraftKey, onAgentEnd: wrappedOnAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemPromptLoaderChange, onSessionStatsPanelOpen,
    promptAnchorSpacerHeightRef,
    bottomComposerHeightRef,
  });
  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor");
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor");

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
  const sessionBusy = agentRunning || bashRunning;

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
  const handleEditFromHereMark = useCallback((entryId: string, message: UserMessage, branchPointId: string | null) => {
    const hasPending = editFromHerePendingRef.current != null;
    if (!hasPending && chatInputRef?.current?.hasInput?.()) return;
    if (hasPending) chatInputRef?.current?.clearInput?.();
    setEditFromHerePending({
      entryId,
      targetId: branchPointId ?? entryId,
      leafId: branchPointId,
    });
    handleEditContent(message);
  }, [chatInputRef, handleEditContent]);

  // 取消：还原高亮 + 清空预填输入框（clearInput 同时清掉草稿）
  const handleCancelEditFromHere = useCallback(() => {
    setEditFromHerePending(null);
    chatInputRef?.current?.clearInput?.();
  }, [chatInputRef]);

  // 发送：pending 时先回退会话（真正生效点），再发送编辑后的消息。
  // bash 命令（! 前缀）不触发回退——用户此时只是想跑 shell，标记保留待下次发送。
  const handleSendWrapped = useCallback(async (message: string, images?: AttachedImage[]) => {
    const pending = editFromHerePendingRef.current;
    if (pending) {
      if (message.trim().startsWith("!")) {
        await handleSend(message, images);
        return;
      }
      setEditFromHerePending(null);
      await handleEditFromStartSend(pending.targetId, pending.leafId, message, images);
      return;
    }
    await handleSend(message, images);
  }, [handleEditFromStartSend, handleSend]);
  const [recoveryDismissed, setRecoveryDismissed] = useState(false);
  // 草稿静默恢复状态：true 时不弹恢复对话框；自动恢复失败会回退 false 放行对话框手动处理。
  const [silentDraftRestore, setSilentDraftRestore] = useState(false);
  // 已尝试自动恢复的草稿 slot 集合（去重；恢复后即被消费，失败后也不无限重试）。
  const autoRestoredDraftRef = useRef<Set<string>>(new Set());

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
  useEffect(() => {
    if (!agentRunning) {
      if (bottomEyeRoom !== 0) setBottomEyeRoom(0);
      return;
    }
    const room = Math.max(0, scrollViewportH - 120 - (bottomComposerHeightRef.current || 0));
    if (room !== bottomEyeRoom) setBottomEyeRoom(room);
    // 依赖省略 bottomEyeRoom（读它仅用于“值不变则跳过 set”，避免 padding→RO→重算循环）；
    // 用 sc.clientHeight（含 padding、稳定）而非 contentRect 也是防循环的关键。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentRunning, scrollViewportH, scReady, bottomComposerHeight, loading, error]);

  /** Draft storage key for the active session (matches ChatInput's draftKey).
   *  New sessions MUST use newSessionDraftKey（含每次新建唯一的 draftId）而不是
   *  `new:<cwd>`：共享 cwd 级 key 会让上一个新建会话未发送的残留（哪怕一个 @）
   *  在之后每次新建都被静默恢复回来，且 promoteNewSession 的 rekey 永远对不上号。 */
  const draftKey = session?.id ?? newSessionDraftKey ?? undefined;

  // Unsent input drafts (crash-loss recovery) — surfaced as items in the
  // queue-recovery dialog. Each open tab has its own `crashrestore-…` slot, so
  // tabs never clobber each other; `listDraftSlots()` loads them ALL for this
  // session (closed tabs, other tabs, and this tab's own leftover).
  // Client-side only: they live in localStorage (survive refresh + browser
  // close); the server never sees them.
  const [pendingDrafts, setPendingDrafts] = useState<DraftSlotInfo[]>([]);
  // 草稿簇外迁（defork P2）：扩展接管时 core 停用内置扫描/静默恢复——恢复项与
  // 恢复动作全部让位给 aiti-draft-keeper，避免对话框重复与双重恢复
  const enhancersVersion = useSyncExternalStore(subscribeComposerEnhancers, getComposerEnhancersVersion, () => 0);
  const draftsExternallyOwned = enhancersVersion > 0 && hasComposerEnhancement("aiti-draft-keeper");
  const liveSlotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setPendingDrafts([]);
    if (!draftKey || draftsExternallyOwned) return;
    const readDrafts = () => {
      const slots = listDraftSlots(draftKey).filter((slot) => {
        // Foreign / closed-tab slots are recoverable; this tab's own slot only
        // when the input box is empty — otherwise it IS the live input the
        // user is typing in right now.
        if (!slot.own) return true;
        return !chatInputRef?.current?.hasInput?.();
      });
      // Foreign slots written within the live window belong to a tab that is
      // ACTIVELY typing — surfacing them here would pop the recovery dialog
      // over this view mid-typing. They surface once writing stops: each new
      // write re-triggers via storage event (rescheduling the one-shot re-read
      // below); when the freshest slot leaves the window the timer fires.
      const now = Date.now();
      setPendingDrafts(slots.filter((slot) => slot.own || now - slot.ts >= LIVE_FOREIGN_SLOT_MS));
      if (liveSlotTimerRef.current) {
        clearTimeout(liveSlotTimerRef.current);
        liveSlotTimerRef.current = null;
      }
      const freshForeign = slots.filter((slot) => !slot.own && now - slot.ts < LIVE_FOREIGN_SLOT_MS);
      if (freshForeign.length > 0) {
        const wait = Math.min(...freshForeign.map((slot) => LIVE_FOREIGN_SLOT_MS - (now - slot.ts)));
        liveSlotTimerRef.current = setTimeout(readDrafts, wait + 250);
      }
    };
    readDrafts();
    // Another tab wrote/cleared a draft: keep this tab's dialog in sync.
    const onStorage = (e: StorageEvent) => {
      if (typeof e.key === "string" && e.key.startsWith(DRAFT_KEY_PREFIX)) readDrafts();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      if (liveSlotTimerRef.current) clearTimeout(liveSlotTimerRef.current);
    };
  }, [draftKey, chatInputRef, draftsExternallyOwned]);

  // Compose the dialog list: server-side queue recovery + the client drafts.
  const draftRecoveryItems: PendingRecoveryItem[] = pendingDrafts.map((slot) => ({
    id: `draft:${slot.slotKey}`,
    kind: "followUp",
    text: slot.draft.value || "",
    hasImages: slot.draft.images.length > 0,
    queuedAt: 0, // drafts carry no timestamp; the dialog hides it for origin=draft
    origin: "draft",
  }));
  // 扩展恢复项（composer 契约：草稿簇等把残留输入并入恢复对话框）
  const extRecoveryItems = useRecoveryProviderItems() as PendingRecoveryItem[];
  const recoveryItems = [
    ...pendingRecovery,
    ...draftRecoveryItems,
    ...extRecoveryItems,
  ];

  // 草稿静默恢复条件：只有客户端草稿待恢复（无服务端队列需要用户决策）、且输入框为空时，
  // 不弹恢复对话框，直接把草稿恢复到输入框（等价于在对话框里点「保留/重新入队」）。
  // 服务端队列消息（重启后存活）仍需用户决定，保留弹窗。
  const hasServerRecovery = pendingRecovery.length > 0;
  const onlyDraftRecovery = draftRecoveryItems.length > 0 && !hasServerRecovery;
  const autoRestoreDrafts = onlyDraftRecovery && !(chatInputRef?.current?.hasInput?.());

  // Queue-recovery resolution with draft items handled client-side (the server
  // knows nothing about drafts): keep = restore into the input box (foreign
  // slots are consumed; the own slot becomes the live input), discard = wipe
  // the slot. Server-side items are passed through unchanged.
  const handleResolveRecovery = useCallback(async (
    keep: string[],
    discard: string[],
    continueRun: boolean,
  ): Promise<PendingRecoveryItem[]> => {
    // 扩展提供者的项（"ext:…" 前缀）路由回提供者自决；余下按 core 逻辑处理
    ({ kept: keep, discarded: discard } = routeRecoveryResolve(keep, discard));
    const slotById = new Map(pendingDrafts.map((slot) => [`draft:${slot.slotKey}`, slot]));
    const isDraftId = (id: string) => slotById.has(id);
    const draftKept = keep.filter(isDraftId).map((id) => slotById.get(id)!);
    const draftDiscarded = discard.filter(isDraftId).map((id) => slotById.get(id)!);
    const serverKeep = keep.filter((id) => !isDraftId(id));
    const serverDiscard = discard.filter((id) => !isDraftId(id));

    if (draftKept.length > 0) {
      // One input box holds one message: when the box is EMPTY the FIRST draft
      // is restored into it for editing/sending and any further drafts become
      // follow-ups. When the user already typed something, NOTHING overwrites
      // the box — all kept drafts are queued as follow-up messages instead
      // (visible in the queued banner, recallable there too).
      const boxEmpty = !(chatInputRef?.current?.hasInput?.());
      const first = boxEmpty ? draftKept[0] : undefined;
      const rest = boxEmpty ? draftKept.slice(1) : draftKept;
      if (first) chatInputRef?.current?.restoreDraft(first.draft);
      rest.forEach((slot) => {
        const images = slot.draft.images.map((img) => ({
          data: img.data,
          mimeType: img.mimeType,
          previewUrl: `data:${img.mimeType};base64,${img.data}`,
        }));
        // 恢复为 follow-up 前先跑扩展聊天钩子（[元素N]/[回答N]/[错误N] → 真实内容，与输入框发送一致）
        const restoredText = chatInputRef?.current?.runChatHooks?.(slot.draft.value) ?? slot.draft.value;
        void handleFollowUp(restoredText, images.length > 0 ? images : undefined);
      });
      const consumedKeys = new Set(draftKept.map((slot) => slot.slotKey));
      draftKept.forEach((slot) => {
        // The own slot restored into the input stays as the live input;
        // everything else (foreign slots, follow-up-dispatched own slot) is
        // consumed.
        if (slot === first && slot.own) return;
        if (slot.own && draftKey) clearDraft(draftKey);
        else removeDraftSlot(slot.slotKey);
      });
      setPendingDrafts((prev) => prev.filter((slot) => !consumedKeys.has(slot.slotKey)));
    }
    if (draftDiscarded.length > 0) {
      const discardedKeys = new Set(draftDiscarded.map((slot) => slot.slotKey));
      draftDiscarded.forEach((slot) => {
        if (slot.own && draftKey) clearDraft(draftKey);
        else removeDraftSlot(slot.slotKey);
      });
      setPendingDrafts((prev) => prev.filter((slot) => !discardedKeys.has(slot.slotKey)));
    }
    if (serverKeep.length === 0 && serverDiscard.length === 0) return pendingRecovery;
    // continueRun only makes sense when actual queued messages are re-queued.
    return resolveRecovery(serverKeep, serverDiscard, continueRun && serverKeep.length > 0);
  }, [draftKey, pendingDrafts, pendingRecovery, resolveRecovery, chatInputRef, handleFollowUp]);

  // 草稿静默恢复：条件满足时不弹恢复对话框，直接把草稿全部恢复到输入框/队列（keep-all）。
  // 注意：恢复依赖 chatInputRef.current（ChatInput 挂载后才就绪）——若尚未就绪则逐帧重试，
  // 草稿绝不先于恢复成功被消费，避免「输入框没拿到文字、草稿却没了」的丢稿。
  useEffect(() => {
    if (!autoRestoreDrafts) return;
    const keys = pendingDrafts.map((slot) => `draft:${slot.slotKey}`);
    if (keys.every((k) => autoRestoredDraftRef.current.has(k))) return;
    setSilentDraftRestore(true); // 先隐藏对话框，避免恢复完成前闪烁
    let cancelled = false;
    let readyFrames = 0;
    const attemptRestore = () => {
      if (cancelled) return;
      const input = chatInputRef?.current;
      if (!input?.restoreDraft) {
        // 输入框还没就绪：下一帧再试（不消费草稿）。迟迟不就绪（如会话加载失败、
        // 无输入框）则放行对话框手动处理，避免草稿被永久隐藏。
        if (++readyFrames > MAX_DRAFT_RESTORE_READY_FRAMES) {
          setSilentDraftRestore(false);
          return;
        }
        requestAnimationFrame(attemptRestore);
        return;
      }
      // 落地前最后一道检查：用户抢在恢复前已经开打了——绝不覆盖新输入。
      // 本批草稿标记为已自动处理（不再重试），放行对话框由用户手动决定去留。
      if (input.hasInput?.()) {
        autoRestoredDraftRef.current = new Set(keys);
        setSilentDraftRestore(false);
        return;
      }
      autoRestoredDraftRef.current = new Set(keys);
      handleResolveRecovery(keys, [], false).catch(() => {
        // 自动恢复失败：放行对话框由用户手动处理（本批草稿不再自动重试）。
        setSilentDraftRestore(false);
      });
    };
    attemptRestore();
    return () => {
      cancelled = true;
    };
  }, [autoRestoreDrafts, pendingDrafts, chatInputRef, handleResolveRecovery]);

  // Reset dismissal whenever the session or its pending list changes identity.
  useEffect(() => {
    setRecoveryDismissed(false);
    setSilentDraftRestore(false);
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
    if (!extensionDialog || soundedExtensionDialogIdRef.current === extensionDialog.id) return;
    soundedExtensionDialogIdRef.current = extensionDialog.id;
    playDoneSoundRef.current();
  }, [extensionDialog]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
  }, [sessionBusy, handleAbort]);

  // --- Scroll-to-earliest / scroll-to-latest floating buttons ---



  // --- Lazy-load historical messages ---
  // Only render the last N messages initially. When the user scrolls to the
  // top, load another page while keeping the scroll position stable.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);

  // IntersectionObserver on the sentinel div at the top of the message list.
  // When it becomes visible, load the next page of older messages.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          // Save distance from top before prepending to restore scroll later
          prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
          setVisibleCount((prev) => getNextVisibleCount(prev));
        }
      },
      { root: container, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, messages.length, scrollContainerRef]);

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

  const onDrop = useCallback((files: File[]) => {
    chatInputRef?.current?.addImages(files);
  }, [chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
  // Stable Map identity: `messages` doesn't change during streaming updates
  // (the streaming message lives in streamState), so memoized MessageViews
  // skip re-rendering on every message_update event. An inline `new Map()`
  // here used to defeat MessageView's memo() on each streamed chunk.
  const toolResultsMap = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        map.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
      }
    }
    return map;
  }, [messages]);
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
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
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
      onModelChange={handleModelChange}
      modelSwitching={modelSwitching}
      onCompact={session || isNew ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      compactQueued={compactQueued}
      modelSwitchPending={modelSwitchPending}
      onCancelCompactQueue={cancelCompactQueue}
      toolPreset={toolPreset}
      onToolPresetChange={session || isNew ? handleToolPresetChange : undefined}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
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
    />
  );

const messageListEl = useMemo(() => {
  // 最近一次压缩摘要在 rendered 数组中的位置（-1 = 本会话没有压缩）。
  // 全父链上下文里摘要可能埋在历史深处，分页窗口只渲染最近 30 条时
  // 打开会话看不到「对话已压缩」卡片——窗口起点前移到摘要处保证可见。
  let lastCompactionRenderIdx = -1;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
  if (messages[i].role === "user") { lastUserIdx = i; break; }
  }
  // Anchor for live-tail detection: the last user message, or a
  // compaction summary when compaction has replaced it mid-turn.
  // Computed independently from lastUserIdx (which is kept for the
  // scroll-to-user ref) because a compaction summary can sit after
  // the last user message and anchor the still-streaming segment.
  let lastAnchorIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
  if (isGroupAnchor(messages[i])) { lastAnchorIdx = i; break; }
  }

  const visibleRefIndexByMessage = new Map<number, number>();
  let refIdx = 0;
  messages.forEach((msg, idx) => {
  if (msg.role === "user" || msg.role === "assistant") {
  visibleRefIndexByMessage.set(idx, refIdx++);
  }
  });

  const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
  messageRefs.current[refIndex] = el;
  if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
  };

  const renderMessage = (idx: number, options: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean; writtenFiles?: WrittenFile[] } = {}): ReactNode => {
  const msg = options.messageOverride ?? messages[idx];
  let prevAssistantEntryId: string | undefined;
  // 连续用户消息也支持「从此处编辑」：回溯到最近一条 assistant 回复作为分支点
  if (msg.role === "user" && idx > 0) {
  for (let j = idx - 1; j >= 0; j--) {
  if (messages[j].role === "assistant") {
  prevAssistantEntryId = entryIds[j];
  break;
  }
  }
  }
  const isVisible = msg.role === "user" || msg.role === "assistant";
  const currentRefIdx = visibleRefIndexByMessage.get(idx);
  const keyPrefix = options.keyPrefix ?? "message";
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
  key={`${keyPrefix}-view-${entryIds[idx] ?? idx}`}
  message={msg}
  toolResults={toolResultsMap}
  modelNames={modelNames}
  cwd={messageCwd}
  onOpenFile={onOpenFile}
  entryId={entryIds[idx]}
  onFork={isNew ? undefined : handleFork}
  forking={forkingEntryId === entryIds[idx]}
  onNavigate={isNew ? undefined : handleNavigate}
  prevAssistantEntryId={isNew ? undefined : prevAssistantEntryId}
  onEditFromHere={isNew ? undefined : handleEditFromHereMark}
  editingFromStart={editFromHerePending?.entryId === entryIds[idx]}
  onCancelEditFromStart={handleCancelEditFromHere}
  showTimestamp={showTimestamp}
  prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
  sessionId={session?.id ?? sessionIdRef.current ?? undefined}
  writtenFiles={options.writtenFiles}
  />
  );
  if (!isVisible || options.attachRef === false || currentRefIdx === undefined) return view;
  return (
  <div key={`${keyPrefix}-${entryIds[idx] ?? idx}`} ref={attachVisibleRef(idx, currentRefIdx)} data-chat-msg-role={msg.role}>
  {view}
  </div>
  );
  };

  const rendered: ReactNode[] = [];
  // 压缩摘要本体暂存：不渲染在原位（会被压缩前后的几十条工具过程消息淹没），
  // 推迟到下一个 user 回合开头再放出来——仍在消息流里，但紧跟对话回合开头、
  // 不会被折叠组包围（「暂缓一个节点放出来」）。
  let pendingCompaction: ReactNode | null = null;
  const flushPendingCompaction = () => {
  if (pendingCompaction === null) return;
  lastCompactionRenderIdx = rendered.length;
  rendered.push(pendingCompaction);
  pendingCompaction = null;
  };
  for (let idx = 0; idx < messages.length;) {
  const msg = messages[idx];
  if (!isGroupAnchor(msg)) {
  rendered.push(renderMessage(idx));
  idx += 1;
  continue;
  }

  const userIdx = idx;
  const isCompactionAnchor = msg.role === "custom" && (msg as CustomMessage).customType === "compaction";
  if (isCompactionAnchor) {
  // 摘要本体不在此渲染：暂存，等下一个 user 回合开头再放出来
  pendingCompaction = renderMessage(userIdx);
  } else {
  // user 回合开头：先把推迟的摘要放出来，再渲染用户消息
  flushPendingCompaction();
  }
  let endIdx = userIdx + 1;
  while (endIdx < messages.length && !isGroupAnchor(messages[endIdx])) endIdx += 1;

  const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);

  if (finalAssistantIdx === -1) {
  for (let renderIdx = userIdx + (isCompactionAnchor ? 1 : 0); renderIdx < endIdx; renderIdx++) {
  rendered.push(renderMessage(renderIdx));
  }
  idx = endIdx;
  continue;
  }

  const isLiveTail = (sessionBusy || streamState.isStreaming) && endIdx === messages.length && userIdx === lastAnchorIdx;
  if (isLiveTail) {
  for (let renderIdx = userIdx + (isCompactionAnchor ? 1 : 0); renderIdx < endIdx; renderIdx++) {
  rendered.push(renderMessage(renderIdx));
  }
  idx = endIdx;
  continue;
  }

  if (!isCompactionAnchor) rendered.push(renderMessage(userIdx));

  const processIndices: number[] = [];
  for (let processIdx = userIdx + 1; processIdx < finalAssistantIdx; processIdx++) {
  processIndices.push(processIdx);
  }
  const visibleProcessIndices = processIndices.filter((processIdx) => hasDisplayableProcessMessage(messages[processIdx]));
  const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
  const finalSplit = splitFinalAssistantBlocks(finalAssistant);
  const finalProcessMessage = finalSplit.processBlocks.length > 0
  ? withAssistantBlocks(finalAssistant, finalSplit.processBlocks, { omitUsage: true })
  : null;
  const finalAnswerMessage = finalSplit.answerBlocks.length > 0 || getAssistantErrorMessage(finalAssistant)
  ? withAssistantBlocks(finalAssistant, finalSplit.answerBlocks)
  : null;

  const processCount = visibleProcessIndices.length + (finalProcessMessage ? 1 : 0);
  if (processCount > 0) {
  const processRefIdx = visibleProcessIndices
  .map((processIdx) => visibleRefIndexByMessage.get(processIdx))
  .find((value): value is number => typeof value === "number")
  ?? (finalAnswerMessage ? undefined : visibleRefIndexByMessage.get(finalAssistantIdx));
  const processGroup = (
  <ProcessDetailsGroup
  messageCount={processCount}
  defaultExpanded={!finalAnswerMessage}
  t={t}
  toolCallCount={countToolCalls(messages, visibleProcessIndices) + countToolCallBlocks(finalSplit.processBlocks)}
  >
  {visibleProcessIndices.map((processIdx) => renderMessage(processIdx, { attachRef: false, keyPrefix: "process" }))}
  {finalProcessMessage && renderMessage(finalAssistantIdx, { attachRef: false, keyPrefix: "process-final", messageOverride: finalProcessMessage, showTimestamp: false })}
  </ProcessDetailsGroup>
  );
  rendered.push(
  <div
  key={`process-group-${userIdx}-${finalAssistantIdx}`}
  ref={processRefIdx === undefined ? undefined : (el) => { messageRefs.current[processRefIdx] = el; }}
  >
  {processGroup}
  </div>,
  );
  }

  if (finalAnswerMessage) {
  // Each tool call is stored as its own assistant entry, so the
  // final answer alone carries no record of what the turn wrote.
  // Gather the turn's assistant blocks and derive the file list
  // from the write/edit calls among them.
  const turnContent: AssistantContentBlock[] = [];
  for (let i = userIdx + 1; i <= finalAssistantIdx; i++) {
  const m = messages[i];
  if (m?.role === "assistant") {
  for (const b of (m as AssistantMessage).content ?? []) turnContent.push(b);
  }
  }
  const writtenFiles = extractTurnWrittenFiles(turnContent, toolResultsMap, messageCwd);
  rendered.push(renderMessage(finalAssistantIdx, { messageOverride: finalAnswerMessage, writtenFiles }));
  }
  for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
  rendered.push(renderMessage(renderIdx));
  }
  idx = endIdx;
  }
  // 摘要之后没有下一个 user 回合（如压缩刚发生、agent 仍在工作中）：放列表末尾
  flushPendingCompaction();
  const { startIndex: baseStartIndex } = getVisibleRenderWindow(rendered.length, visibleCount);
  // 保证最近一次压缩摘要进入首屏渲染窗口：摘要已推迟到下一个 user 回合开头渲染，
  // 窗口起点前移到该摘要实际渲染位置（摘要之后的渲染量通常就是 kept 段 + 新消息，
  // 分页优化前本来就是全量渲染，无新增压力）；摘要之前的翻页行为不变。
  const effectiveStartIndex = lastCompactionRenderIdx !== -1 && lastCompactionRenderIdx < baseStartIndex
  ? lastCompactionRenderIdx
  : baseStartIndex;
  const hasMore = effectiveStartIndex > 0;
  return (
  <>
  {hasMore && (
  <div ref={sentinelRef} className="py-3 text-center text-xs text-text-muted">
  {t("chat.loadEarlier", { count: effectiveStartIndex })}
  </div>
  )}
  {rendered.slice(effectiveStartIndex)}
  </>
  );
  }, [messages, visibleCount, toolResultsMap, modelNames, messageCwd, onOpenFile, handleFork, handleNavigate, handleEditFromHereMark, editFromHerePending, handleCancelEditFromHere, entryIds, streamState.isStreaming, sessionBusy, isNew, bashRunning, t, forkingEntryId, lastUserMsgRef, messageRefs, session?.id, sessionIdRef]);
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
      className="relative flex h-full min-w-0 flex-col overflow-hidden"
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

      {extensionDialog && (
        <ExtensionDialog
          request={extensionDialog}
          onRespond={respondToExtensionUi}
        />
      )}

      {extensionCustomUi && (
        <ExtensionCustomPanel
          request={extensionCustomUi}
          onInput={sendExtensionCustomInput}
        />
      )}

      {recoveryItems.length > 0 && !recoveryDismissed && !(silentDraftRestore && recoveryItems.every((i) => i.origin === "draft")) && (
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
          justifyContent: "center",
          padding: `0 ${CHAT_COLUMN_PADDING}px`,
          pointerEvents: "none",
        }}
      >
        <NoticeShelf notices={notices} floating />
      </div>

      {isEmptyNew ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className="w-full max-w-[820px]">
            <div
              className="mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginLeft: 16,
                marginRight: isMobile || isCompact ? 16 : 52,
                fontFamily: "var(--font-mono)",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: isMobile ? 7 : 10, minWidth: 0, flex: 1, lineHeight: 1.4, overflow: "hidden" }}>
                <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: 0, color: "var(--text)", flexShrink: 0, whiteSpace: "nowrap" }}>π</span>
                <span style={{ fontSize: 22, color: "var(--text)", fontWeight: 700, letterSpacing: 0, flexShrink: 0, whiteSpace: "nowrap" }}>Pi Web</span>
                <NewSessionUpdateLink label={(version) => t("appUpdate.releaseNotes", { version })} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  web <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  pi <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}</span>
                </span>
              </div>
            </div>
            <NoticeShelf notices={notices} align="right" />
            <ExtensionWidgets widgets={aboveEditorWidgets} />
            {chatInputElement}
            <ExtensionWidgets widgets={belowEditorWidgets} />
            <ExtensionStatusBar statuses={extensionStatuses} widgets={extensionWidgets} />
          </div>
        </div>
      ) : (
      <>
      <div className="relative flex min-w-0 flex-1 overflow-hidden">
        <div ref={handleScrollBoxRef} data-chat-scroll className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-width:none]" style={{ paddingBottom: bottomEyeRoom }}>
          <div style={{ minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div style={{ width: "100%", minWidth: 0, maxWidth: 820, margin: "0 auto" }}>

            {messageListEl}
            {streamState.isStreaming && hasStreamingContent && streamState.streamingMessage && (
              <StreamingMessageView message={streamState.streamingMessage as AgentMessage} modelNames={modelNames} />
            )}

            {agentRunning && !hasStreamingContent && agentPhase && (
              <div className="break-words py-2 text-[13px] text-text-muted">
                <span className="animate-[pulse_1.5s_infinite]">{phaseLabel(agentPhase, t)}</span>
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
              />
            )}

            {/* 底部输入区高度占位（保持尾钉）；step-follow spacer 已移除（恒 0） */}
            <div aria-hidden="true" style={{ height: bottomComposerHeight }} />

            <div ref={messagesEndRef} />
            </div>
          </div>
        </div>

        {/* 消息滚动导航条已抽离为扩展（aiti-msg-nav 注册到 chatOverlay 插槽）；
            消息锚点横幅（aiti-msg-anchor）同插槽。currentSession 透传会话标题：
            name + firstMessage（无 name 时与左侧 session 列表一致取第一条用户输入）。 */}
        <ExtSlot
          name="chatOverlay"
          currentSession={session ? { id: session.id, cwd: session.cwd, name: session.name, firstMessage: session.firstMessage } : null}
          extra={{ agentRunning, isMobile }}
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
      </div>

      <div ref={bottomComposerRef} className="relative">
        <div
          style={{
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            paddingRight: isMobile || isCompact ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <ExtensionWidgets widgets={aboveEditorWidgets} />
          </div>
        </div>
        {chatInputElement}
        <div
          style={{
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            paddingRight: isMobile || isCompact ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <ExtensionWidgets widgets={belowEditorWidgets} />
          </div>
        </div>
        <ExtensionStatusBar statuses={extensionStatuses} widgets={extensionWidgets} />
      </div>
      </>
      )}
    </div>
  );
}

function NoticeShelf({ notices, floating = false, align = "left" }: { notices: NoticeItem[]; floating?: boolean; align?: "left" | "right" }) {
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
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minHeight: 60,
              height: 60,
              maxHeight: 60,
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
              fontSize: 18,
              lineHeight: 1.45,
              transformOrigin: "top center",
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
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
              }}
            />
            <span style={{ padding: "14px 0", minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
  }, [request]);

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 100%)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{request.title}</div>
          <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{t("chat.extensionRequest")}</div>
        </div>

        <div style={{ padding: 14 }}>
          {request.method === "confirm" && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{request.message}</div>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 8 }}>
              {request.options.map((option) => (
                <button
                  key={option}
                  onClick={() => onRespond(request, { value: option })}
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
                  }}
                >
                  {option}
                </button>
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
                if (e.key === "Enter") submitValue();
                if (e.key === "Escape") onRespond(request, { cancelled: true });
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
                if (e.key === "Escape") onRespond(request, { cancelled: true });
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
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

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
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
                color: "#fff",
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
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.submit")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) => (
    Object.keys(segment.style).length > 0
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

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
  const displayLines = normalizeCustomPanelLines(request.lines);

  useEffect(() => {
    inputRef.current?.focus();
  }, [request.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
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
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, 100vh - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
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
    streamStartRef.current = Date.now();
  }
  prevTokensRef.current = tokens;
  let tps: number | null = null;
  if (tokens > 0 && streamStartRef.current !== null) {
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

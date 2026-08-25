"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, useReducer } from "react";
import { apiUrl } from "@/lib/base-path";

import type {
  AgentMessage,
  BlockingExtensionUiRequest,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
  UserMessage,
} from "@/lib/types";
import { isBlockingExtensionUiRequest } from "@/lib/browser-notifications";
import { normalizeToolCalls } from "@/lib/normalize";
import { isPromptRejectedError, sendAgentCommand } from "@/lib/agent-client";
import type { ChatDraftImage } from "@/lib/draft-store";
import { clearDraft, rekeyDraft, restoreDraftSubmission } from "@/lib/draft-store";
import type { PendingRecoveryItem, QueueEntry, QueueEntryInput, QueueTrashItem } from "@/lib/queue-store";
import { getPreferredToolPreset, setPreferredToolPreset } from "@/lib/tool-preset-preference";
import { getToolNamesForPreset, type ToolEntry, type ToolPreset } from "@/lib/tool-presets";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { userMessageKey } from "@/lib/prompt-recovery";
import { AgentEventConnection } from "@/lib/agent-event-connection";
import { getToolExecutionProgress } from "@/lib/tool-execution-progress";
import {
  INITIAL_STREAMING_STATE,
  streamReducer,
  type ClientAssistantMessageEvent,
  type StreamAction,
} from "@/lib/streaming-message";

export interface SessionData {
  sessionId: string;
  filePath: string;
  totalActiveMs: number;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

type AgentStateResponse = {
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
  pendingRecovery?: PendingRecoveryItem[] | null;
  queueTrash?: QueueTrashItem[] | null;
  /** 后端会话能力声明（capability-aware 控件渲染） */
  capabilities?: Record<string, boolean>;
  /** 后端来源标签（如 "aiti-claude-code-agent/claude-code"） */
  backendSource?: string;
};

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}

type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "mark_oldest_exiting" }
  | { type: "remove"; id: string };

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string; progress?: string }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  sessionRunning?: boolean;
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  /** Session backend for NEW sessions (providerType from /api/session-backends). null/undefined = local pi. */
  newSessionBackend?: string | null;
  onAgentEnd?: () => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  /** Registers an action that lazily starts the session and returns its system prompt. */
  onSystemPromptLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsPanelOpen?: () => void;
  setToolPreset?: (preset: ToolPreset) => void;
  /** Live heights of the prompt-anchor spacer and bottom composer spacer
   *  (owned by ChatWindow). Step-follow geometry needs them to know where the
   *  last message actually ends. */
  promptAnchorSpacerHeightRef?: React.MutableRefObject<number>;
  bottomComposerHeightRef?: React.MutableRefObject<number>;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
// Time window after a scroll interaction during which auto-follow pauses.
// Short enough that a fast agent can't stream more than ~a screen of output
// while the view is frozen; the walked-away distance guard (not this timer)
// protects the "reading history" case indefinitely.
const USER_SCROLL_INTENT_MS = 2_000;
// Keys that signal the user is actively reading/scrolling the transcript.
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);
// Distance from the bottom of the scroll container within which live-follow
// scrolling is active. Larger values make follow more lenient; smaller values
// require the user to stay closer to the bottom.
const SCROLL_BOTTOM_THRESHOLD = 150;
// Keys that scroll the list UP — a definitive "user is leaving the tail"
// signal (same filtering rules as SCROLL_KEYS).
const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const EVENT_STREAM_IDLE_GRACE_MS = 30_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const BASH_STATE_RECONCILE_MS = 1_000;
const EVENT_STREAM_READY_TIMEOUT_MS = 60_000;
const EVENT_STREAM_RECONNECT_DELAY_MS = 1_000;
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;
function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  replaceMessage: (message: UserMessage) => void;
  prependText: (text: string) => void;
  appendText: (text: string) => void;
  addImages: (files: File[]) => void;
  expandQueue?: () => void;
  rekeyDraft: (previousKey: string, nextKey: string) => void;
  restoreSubmission: (text: string, images?: Array<{ data: string; mimeType: string }>, targetDraftKey?: string) => void;
}

export interface AttachedFile {
  data: string;   // base64, no prefix
  mimeType: string;
  filename: string;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string };
type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  thinkingLevelPins?: Record<string, string>;
  modelError?: string;
  modelScopeWarnings?: string[];
};

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, sessionRunning, newSessionCwd, newSessionDraftKey, onAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSystemPromptLoaderChange, onSessionStatsPanelOpen,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;

  // New-session backend (providerType)：ref 镜像保证 ensureNewSession 回调稳定。
  const newSessionBackendRef = useRef<string | null | undefined>(opts.newSessionBackend);
  newSessionBackendRef.current = opts.newSessionBackend;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [streamState, dispatch] = useReducer(streamReducer, INITIAL_STREAMING_STATE);
  // 流式 delta 微批次：SSE 每个 token/块到达即 dispatch 会让 React 同帧重渲染 N 次
  // （跨事件批处理不合并），每帧全树 render + commit 是流式期间布局风暴的源头之一。
  // 入队后每帧 flush 一次（delta-batch），后台标签 rAF 暂停时队列保序等待。
  const pendingDeltasRef = useRef<ClientAssistantMessageEvent[]>([]);
  const pendingDeltasFrameRef = useRef<number | null>(null);
  const lastFlushTsRef = useRef(0);
  const DELTA_BATCH_MAX = 50; // 单批上限：后台长流式累积的队列一次 flush 太多会单帧长任务
  const DELTA_FLUSH_INTERVAL_MS = 50; // flush 最小间隔：rAF 每帧触发但间隔 <50ms 不 flush——
  // 文本流 20fps 已足够平滑，React 渲染次数 60fps→20fps（-2/3），流式期主线程压力大降。
  const flushPendingDeltas = useCallback(() => {
    if (pendingDeltasFrameRef.current !== null) {
      cancelAnimationFrame(pendingDeltasFrameRef.current);
      pendingDeltasFrameRef.current = null;
    }
    const all = pendingDeltasRef.current;
    if (all.length === 0) return;
    pendingDeltasRef.current = [];
    // 有内容事件（非纯 toolcall 元数据）→ 清等待模型态（每帧一次，替代每事件调用）
    if (all.some((d) => d.type !== "toolcall_start" && d.type !== "toolcall_delta")) {
      setAgentPhase(null);
    }
    // 分批：单批 ≤50（reducer 循环应用成本受控），多批仍同帧（React 自动批处理）
    for (let i = 0; i < all.length; i += DELTA_BATCH_MAX) {
      const batch = all.slice(i, i + DELTA_BATCH_MAX);
      if (batch.length === 1) dispatch({ type: "delta", event: batch[0] });
      else dispatch({ type: "delta-batch", events: batch });
    }
  }, []);
  // 每帧检查最小间隔：满足 50ms（或积压超量）才 flush，否则推迟下一帧再查（保序）。
  // 注意“延迟帧”也必须再查间隔而不能无条件 flush——否则节流退化为“仅推迟一帧”，
  // 60fps 下实际 ~30fps（33ms），达不到 20fps（50ms）目标，主线程压力仍然偏高。
  // 推迟链不会 starve：时间流逝后间隔必然满足；积压阈值（DELTA_BATCH_MAX*2）兜底。
  const scheduleDeltaFlush = useCallback(() => {
    if (pendingDeltasFrameRef.current !== null) return;
    pendingDeltasFrameRef.current = requestAnimationFrame(() => {
      pendingDeltasFrameRef.current = null;
      const now = performance.now();
      if (now - lastFlushTsRef.current >= DELTA_FLUSH_INTERVAL_MS || pendingDeltasRef.current.length >= DELTA_BATCH_MAX * 2) {
        lastFlushTsRef.current = now;
        flushPendingDeltas();
      } else {
        scheduleDeltaFlush();
      }
    });
  }, [flushPendingDeltas]);
  const enqueueDelta = useCallback((delta: ClientAssistantMessageEvent) => {
    pendingDeltasRef.current.push(delta);
    scheduleDeltaFlush();
  }, [scheduleDeltaFlush]);
  // 保序：snapshot/start/end 会重置或替换 streamingMessage，先同步 flush 队列
  // 再进 reducer（同一调度周期内保持 delta → 边界事件的顺序）。
  const dispatchStream = useCallback((action: StreamAction) => {
    if (action.type === "start" || action.type === "snapshot" || action.type === "end") flushPendingDeltas();
    dispatch(action);
  }, [flushPendingDeltas]);
  useEffect(() => () => {
    // 卸载时丢弃未 flush 的 delta（rAF 已取消，避免卸载后 dispatch）
    if (pendingDeltasFrameRef.current !== null) {
      cancelAnimationFrame(pendingDeltasFrameRef.current);
      pendingDeltasFrameRef.current = null;
    }
    pendingDeltasRef.current = [];
  }, []);
  const [agentRunning, setAgentRunning] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelScopeWarnings, setModelScopeWarnings] = useState<string[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  /** A model switch was made while the agent was running — applies next turn.
   *  Stores the target model; switching back to the current run's model cancels. */
  const [modelSwitchPending, setModelSwitchPending] = useState<{ provider: string; modelId: string } | null>(null);
  /** Model the current agent run started with (agent_start / running transition). */
  const agentRunModelRef = useRef<{ provider: string; modelId: string } | null>(null);
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [toolPreset, setToolPreset] = useState<ToolPreset>("default");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  /** Manual compaction queued while the agent was running; fires on next idle. */
  const [compactQueued, setCompactQueued] = useState(false);
  const pendingCompactRef = useRef(false);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [promptAnchorActive, setPromptAnchorActive] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  /** 后端会话的工具授权请求（permission_request 事件；一次一个，队列简化为覆盖） */
  const [permissionRequest, setPermissionRequest] = useState<{
    requestId: string;
    toolName?: string;
    input?: unknown;
  } | null>(null);
  const permissionRespondingRef = useRef(false);
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  /** 后端会话能力（从 state 端点透传；本地会话无此状态） */
  const [sessionCapabilities, setSessionCapabilities] = useState<Record<string, boolean> | null>(null);
  /** 后端会话最近一轮用量（get_usage 能力时从 API 拉取） */
  const [backendUsage, setBackendUsage] = useState<{ inputTokens?: number; outputTokens?: number; costUsd?: number } | null>(null);
  const [backendSource, setBackendSource] = useState<string | undefined>(undefined);
  const [pendingRecovery, setPendingRecovery] = useState<PendingRecoveryItem[]>([]);
  const [queueTrash, setQueueTrash] = useState<QueueTrashItem[]>([]);
  /** True when the current pending-recovery list came from an import (not a
   *  crash recovery) — drives the dialog's copy. Resets when the list empties. */
  const [recoveryIsImport, setRecoveryIsImport] = useState(false);

  const eventConnectionRef = useRef<AgentEventConnection | null>(null);
  const eventStreamGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventStreamGraceGenerationRef = useRef(0);
  const eventStreamGraceActiveRef = useRef(false);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const sessionPropIdRef = useRef<string | null>(session?.id ?? null);
  const sessionRunningRef = useRef(Boolean(sessionRunning));
  const agentRunningRef = useRef(false);
  const isCompactingRef = useRef(false);
  const sdkAgentActiveRef = useRef(false);
  const rpcPromptPendingRef = useRef(false);
  const notifiedPromptRunIdRef = useRef(-1);
  const bashRunningRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const initialScrollDoneRef = useRef(false);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const completionScrollAllowedRef = useRef(true);
  const isNearBottomRef = useRef(true);
  const previousScrollTopRef = useRef(0);
  const liveFollowFrameRef = useRef<number | null>(null);
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<void> | undefined>(undefined);
  const userScrollIntentUntilRef = useRef(0);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  // True once the user ACTUALLY scrolled up during this run (wheel/touch/keys)
  // — the only thing that should stop step-follow. Content growing below the
  // fold (tool results, images, code blocks) never moves scrollTop, so it can
  // never set this; a purely positional heuristic cannot tell the two apart.
  // Cleared when the user returns to the tail (near-bottom) or on a new run.
  const userScrolledAwayRef = useRef(false);
  // Last observed scrollTop — lets the scroll handler see direction (a real
  // decrease outside the programmatic window = user scrolling up).
  const lastScrollTopRef = useRef(0);
  // True while the user holds a pointer/finger down (touch, mouse press,
  // drag). Auto-following pauses for the whole hold — no scrolling until the
  // pointer is released.
  const userPointerDownRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  const newSessionModelOverrideRef = useRef<SelectedModel | null>(null);
  const thinkingLevelOverrideRef = useRef<Exclude<ThinkingLevelOption, "auto"> | null>(null);
  const promptRunIdRef = useRef(0);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);
  const modelSwitchPendingRef = useRef(false);
  const messagesRef = useRef(messages);
  const draftKeyAliasesRef = useRef(new Map<string, string>());
  const sessionHookMountedRef = useRef(true);

  sessionPropIdRef.current = session?.id ?? null;
  sessionRunningRef.current = Boolean(sessionRunning);

  if (!eventConnectionRef.current) {
    eventConnectionRef.current = new AgentEventConnection({
      createSource: (sid) => new EventSource(apiUrl(`/api/agent/${encodeURIComponent(sid)}/events`)),
      onEvent: (event) => handleAgentEventRef.current?.(event as AgentEvent),
      shouldMaintain: (sid) => (
        sessionHookMountedRef.current
        && sessionIdRef.current === sid
        && (
          agentRunningRef.current
          || eventStreamGraceActiveRef.current
          || (sessionPropIdRef.current === sid && sessionRunningRef.current)
        )
      ),
      readinessTimeoutMs: EVENT_STREAM_READY_TIMEOUT_MS,
      reconnectDelayMs: EVENT_STREAM_RECONNECT_DELAY_MS,
      onUnexpectedError: (error) => {
        console.error("Failed to maintain the agent event stream:", error);
      },
    });
  }

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useLayoutEffect(() => {
    if (!isNew || sessionIdRef.current) return;
    setToolPresetState(getPreferredToolPreset());
  }, [isNew, setToolPresetState]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    // Landing at the tail re-arms auto-follow for subsequent output.
    userScrolledAwayRef.current = false;
    const container = scrollContainerRef.current;
    messagesEndRef.current?.scrollIntoView({ behavior });
    if (container) previousScrollTopRef.current = container.scrollTop;
  }, []);

  // Step-follow (always on): instead of scrolling to the bottom on every
  // streaming event, only scroll when new output pushes the last message
  // past a small keep-out zone — then step it back to the top 1/4 of the
  // viewport so the lower 3/4 refills with output before the next step.
  const smartFollowStep = useCallback(() => {
    if (Date.now() < userScrollIntentUntilRef.current) return;
    // While the user holds a pointer/finger down, pause all follow processing
    // — the view must not move under their finger. Resumes on release.
    if (userPointerDownRef.current) return;
    const container = scrollContainerRef.current;
    const end = messagesEndRef.current;
    if (!container || !end) return;
    const endTop = end.getBoundingClientRect().top - container.getBoundingClientRect().top;
    // The bottom-composer spacer sits between the last message and the
    // sentinel; back it out so we measure the last message's real bottom.
    const spacerH = (opts.promptAnchorSpacerHeightRef?.current ?? 0)
      + (opts.bottomComposerHeightRef?.current ?? 0);
    const lastMsgBottom = endTop - spacerH;
    // Walked-away guard: only an actual UPWARD user scroll stops following.
    // Streaming can push the tail far below the fold between evaluations (a
    // tall tool result, an image loading) — that is NOT the user leaving, but
    // the old position heuristic read it as such and froze follow mid-stream.
    // We instead track real user scrolls (wheel/key events plus non-
    // programmatic scrollTop decreases — content growth never fires scroll
    // events). Returning to the tail re-arms follow automatically.
    if (userScrolledAwayRef.current) return;
    // Step when the output has filled the chat down to ~1 line (16px) from
    // the viewport bottom. The old 40px keep-out read as "4-5 lines short of
    // the bottom" on small screens, so the view rolled back before the
    // output reached the bottom edge.
    if (lastMsgBottom > container.clientHeight - 16) {
      const lastMsgAbs =
        end.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - spacerH;
      // Land the last message 120px below the top of the viewport: a little
      // history stays visible above, the lower area refills with output
      // before the next step.
      const target = Math.max(0, lastMsgAbs - 120);
      ignoreProgrammaticScrollUntilRef.current = Date.now() + 1200;
      container.scrollTo({ top: target, behavior: "instant" });
    }
  }, [opts.promptAnchorSpacerHeightRef, opts.bottomComposerHeightRef, scrollContainerRef, messagesEndRef]);

  // T-5: rAF-coalesced step-follow. Streaming drives the follow effect via
  // streamState, whose reference changes on EVERY delta — without coalescing,
  // each delta runs smartFollowStep() synchronously, which reads two
  // getBoundingClientRect() and scrolls → a forced layout per delta. Trace
  // (2026-08-17 multi-op) showed scrollToBottom/smartFollowStep burning ~600ms
  // in forced reflow during streaming. Batching to one check per animation
  // frame caps the work while keeping the step latency well under a frame.
  const scheduleFollowStep = useCallback(() => {
    if (liveFollowFrameRef.current !== null) return;
    liveFollowFrameRef.current = requestAnimationFrame(() => {
      liveFollowFrameRef.current = null;
      smartFollowStep();
    });
  }, [smartFollowStep]);

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;
  const composerDraftKey = session?.id ?? newSessionDraftKey ?? undefined;

  const resolveComposerDraftKey = useCallback((key: string | undefined) => {
    if (!key) return undefined;
    let resolved = key;
    const visited = new Set<string>();
    while (!visited.has(resolved)) {
      visited.add(resolved);
      const next = draftKeyAliasesRef.current.get(resolved);
      if (!next) break;
      resolved = next;
    }
    return resolved;
  }, []);

  const restoreSubmission = useCallback((
    text: string,
    images: AttachedImage[] | undefined,
    targetDraftKey: string | undefined,
  ) => {
    const draftImages = images?.map(({ data, mimeType }) => ({ data, mimeType }));
    const destinationDraftKey = resolveComposerDraftKey(targetDraftKey);
    if (
      !sessionHookMountedRef.current
      && !newSessionPromotedRef.current
      && targetDraftKey === newSessionDraftKey
    ) return;
    const input = opts.chatInputRef?.current;
    if (input) {
      input.restoreSubmission(text, draftImages, destinationDraftKey);
    } else if (destinationDraftKey) {
      restoreDraftSubmission(destinationDraftKey, text, draftImages);
    }
  }, [newSessionDraftKey, opts.chatInputRef, resolveComposerDraftKey]);

  const sessionStats = useMemo(() => {
    if (sessionStatsOverride) {
      return { ...sessionStatsOverride, totalActiveMs: data?.totalActiveMs };
    }
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    let toolCalls = 0;
    for (const msg of messages) {
      if (msg.role === "user") userMessages += 1;
      if (msg.role === "toolResult") toolResults += 1;
      if (msg.role !== "assistant") continue;
      assistantMessages += 1;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      toolCalls += (msg as import("@/lib/types").AssistantMessage).content.filter((c) => c.type === "toolCall").length;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (tokens.total === 0 && messages.length === 0) return null;
    return {
      sessionFile: data?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens,
      cost,
      totalActiveMs: data?.totalActiveMs,
      ...(contextUsage ? { contextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, contextUsage, data?.filePath, data?.totalActiveMs, session?.id, session?.name]);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    let messagesLoaded = false;
    try {
      if (showLoading) setLoading(true);
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      const res = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sid)}?${params}`));
      if (res.status === 404) {
        if (showLoading) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          setError(null);
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData;
      if (sessionIdRef.current !== sid) return null;
      const persistedMessages = d.context.messages;
      setData(d);
      setActiveLeafId(d.leafId);
      setMessages(persistedMessages);
      setEntryIds(d.context.entryIds ?? []);
      setCurrentModelOverride((current) => modelSwitchPendingRef.current ? current : null);
      setError(null);
      if (d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }

      messagesLoaded = true;
      if (showLoading) setLoading(false);
      if (!includeState) return null;

      try {
        const stateRes = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sid)}/state`));
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse };
        if (sessionIdRef.current !== sid) return null;

        const liveState = agentState.state;
        if (liveState) {
          if (liveState.capabilities !== undefined) setSessionCapabilities(liveState.capabilities);
          if (liveState.backendSource !== undefined) setBackendSource(liveState.backendSource);
          if (liveState.contextUsage !== undefined) setContextUsage(liveState.contextUsage ?? null);
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
          if (liveState.thinkingLevel !== undefined) setThinkingLevel((liveState.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
          if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
          if (liveState.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(liveState.queuedMessages));
          if (liveState.pendingRecovery !== undefined) setPendingRecovery(liveState.pendingRecovery ?? []);
          if (liveState.queueTrash !== undefined) setQueueTrash(liveState.queueTrash ?? []);
        } else if (!agentState.running) {
          setQueuedMessages({ steering: [], followUp: [] });
          setQueueTrash([]);
        }
        return agentState;
      } catch (e) {
        console.error("Failed to load agent state:", e);
        return null;
      }
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      if (showLoading && !messagesLoaded) setLoading(false);
    }
  }, []);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    try {
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      if (leafId) params.set("leafId", leafId);
      const url = apiUrl(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { context: { messages: AgentMessage[]; entryIds: string[] } };
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
    } catch (e) {
      console.error("Failed to load context:", e);
    }
  }, []);

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (tools) {
        const { getPresetFromTools } = await import("@/lib/tool-presets");
        setToolPresetState(getPresetFromTools(tools));
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
  }, [setToolPresetState]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)") => {
    const sid = sessionIdRef.current;
    if (!isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    const provisionalDraftKey = newSessionDraftKey;
    if (!provisionalDraftKey) return;
    if (provisionalDraftKey !== sid) {
      draftKeyAliasesRef.current.set(provisionalDraftKey, sid);
      const input = opts.chatInputRef?.current;
      if (input) input.rekeyDraft(provisionalDraftKey, sid);
      else rekeyDraft(provisionalDraftKey, sid);
    }
    onSessionCreated?.({
      id: sid,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
      transient: true,
    }, provisionalDraftKey);
  }, [isNew, newSessionCwd, newSessionDraftKey, onSessionCreated, opts.chatInputRef]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = (async () => {
      // Only send explicit user overrides. The server resolves the current
      // enabledModels scope atomically with AgentSession construction.
      const selectedModel = newSessionModelOverrideRef.current;
      const selectedThinkingLevel = thinkingLevelOverrideRef.current;
      if (selectedModel) setPendingModel(selectedModel);
      const toolNames = getToolNamesForPreset(toolPreset);
      const backend = newSessionBackendRef.current;
      const res = await fetch(apiUrl("/api/agent/new"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: newSessionCwd,
          type: "ensure_session",
          toolNames,
          ...(backend ? { providerType: backend } : {}),
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(selectedThinkingLevel
            ? { thinkingLevel: selectedThinkingLevel }
            : {}),
        }),
      });
      const result = await res.json().catch(() => ({})) as {
        sessionId?: string;
        error?: string;
        model?: SelectedModel | null;
        thinkingLevel?: ThinkingLevelOption;
      };
      if (!res.ok || !result.sessionId) {
        throw new Error(result.error ?? `HTTP ${res.status}`);
      }
      const realId = result.sessionId;
      sessionIdRef.current = realId;
      if (result.model && newSessionModelOverrideRef.current === selectedModel) {
        setPendingModel(result.model);
        if (!selectedModel) setNewSessionDefaultModel(result.model);
      }
      if (
        result.thinkingLevel
        && thinkingLevelOverrideRef.current === selectedThinkingLevel
      ) {
        setThinkingLevel(result.thinkingLevel);
      }
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [isNew, newSessionCwd, toolPreset]);

  // Opening the System panel is also allowed to initialize an otherwise dormant
  // session. This is deliberately a non-prompt command: it creates no message
  // or model run, but lets users inspect the exact prompt before sending one.
  const loadSystemPrompt = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) return;

    const state = await sendAgentCommand<AgentStateResponse>(sid, { type: "get_state" });
    if (!sessionHookMountedRef.current || sessionIdRef.current !== sid) return;
    setSystemPrompt(state.systemPrompt ?? "");
  }, [ensureNewSession]);

  const loadSlashCommands = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
      const commands = data?.commands ?? [];
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      setSlashCommandsLoading(false);
    }
  }, [ensureNewSession]);

  const cancelEventStreamGrace = useCallback(() => {
    eventStreamGraceGenerationRef.current += 1;
    eventStreamGraceActiveRef.current = false;
    if (eventStreamGraceTimerRef.current) {
      clearTimeout(eventStreamGraceTimerRef.current);
      eventStreamGraceTimerRef.current = null;
    }
  }, []);

  const closeEvents = useCallback(() => {
    eventConnectionRef.current?.close();
  }, []);

  const ensureEventsConnected = useCallback((sid: string) => (
    eventConnectionRef.current!.ensureConnected(sid)
  ), []);

  const maintainEventsConnected = useCallback((sid: string) => {
    eventConnectionRef.current!.maintain(sid);
  }, []);

  // A different browser can start this session after it was opened here.
  // The sidebar's lightweight running-state poll gives us a cheap signal to
  // attach to the existing SSE stream without adding another synchronization
  // protocol to the chat.
  useEffect(() => {
    if (!session?.id || !sessionRunning) return;
    maintainEventsConnected(session.id);
    return () => {
      if (
        sessionIdRef.current === session.id
        && !agentRunningRef.current
        && !eventStreamGraceActiveRef.current
        && (sessionPropIdRef.current !== session.id || !sessionRunningRef.current)
      ) {
        eventConnectionRef.current?.close();
      }
    };
  }, [maintainEventsConnected, session?.id, sessionRunning]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    setExtensionDialog((current) => current?.id === request.id ? null : current);
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
    } catch (e) {
      console.error("Failed to send extension UI response:", e);
    }
  }, []);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      });
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, []);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
      },
    });
  }, []);

  const handleExtensionUiRequest = useCallback((request: ExtensionUiRequest) => {
    if (isBlockingExtensionUiRequest(request)) onAttentionNeeded?.(request);

    switch (request.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
        setExtensionDialog(request);
        break;
      case "notify": {
        addNotice({
          id: request.id,
          message: request.message,
          type: request.notifyType ?? "info",
        });
        break;
      }
      case "setStatus":
        setExtensionStatuses((prev) => {
          const rest = prev.filter((item) => item.key !== request.statusKey);
          return request.statusText !== undefined
            ? [...rest, { key: request.statusKey, text: request.statusText }]
            : rest;
        });
        break;
      case "setWidget":
        setExtensionWidgets((prev) => {
          const rest = prev.filter((item) => item.key !== request.widgetKey);
          return request.widgetLines
            ? [...rest, {
                key: request.widgetKey,
                lines: request.widgetLines,
                placement: request.widgetPlacement ?? "aboveEditor",
              }]
            : rest;
        });
        break;
      case "setTitle":
        if (request.title) document.title = request.title;
        break;
      case "set_editor_text":
        opts.chatInputRef?.current?.insertText(request.text);
        break;
      case "custom":
        setExtensionCustomUi((current) => {
          if (request.closed) return current?.id === request.id ? null : current;
          return request;
        });
        break;
    }
  }, [addNotice, onAttentionNeeded, opts.chatInputRef]);

  const settleUiStage = useCallback(() => {
    const wasRunning = agentRunningRef.current;
    agentRunningRef.current = false;
    setAgentRunning(false);
    setAgentPhase(null);
    setRetryInfo(null);
    dispatchStream({ type: "end" });
    return wasRunning;
  }, [dispatchStream]);

  const notifyPromptStage = useCallback((runId: number) => {
    if (notifiedPromptRunIdRef.current === runId) return false;
    notifiedPromptRunIdRef.current = runId;
    onAgentEnd?.();
    return true;
  }, [onAgentEnd]);

  const scheduleEventStreamClose = useCallback((sid: string) => {
    cancelEventStreamGrace();
    eventStreamGraceActiveRef.current = true;
    const generation = eventStreamGraceGenerationRef.current;

    const checkServerIdle = async () => {
      if (
        generation !== eventStreamGraceGenerationRef.current
        || sessionIdRef.current !== sid
        || !eventStreamGraceActiveRef.current
      ) return;

      try {
        const res = await fetch(apiUrl(`/api/agent/${encodeURIComponent(sid)}`));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;

        const state = data.state;
        const promptActive = Boolean(data.running && state && (state.isStreaming || state.isPromptRunning));
        if (promptActive) {
          eventStreamGraceActiveRef.current = false;
          eventStreamGraceTimerRef.current = null;
          sdkAgentActiveRef.current = Boolean(state?.isStreaming);
          rpcPromptPendingRef.current = Boolean(state?.isPromptRunning);
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase(state?.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
          return;
        }

        if (data.running && state?.isCompacting) {
          setIsCompacting(true);
          eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
          return;
        }

        eventStreamGraceActiveRef.current = false;
        eventStreamGraceTimerRef.current = null;
        closeEvents();
      } catch {
        // Keep the stream alive while state cannot be verified.
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;
        eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
      }
    };

    eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), EVENT_STREAM_IDLE_GRACE_MS);
  }, [cancelEventStreamGrace, closeEvents]);

  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId = promptRunIdRef.current) => {
    // Bail out before loadSession too: a stale finish for a previous run
    // must not overwrite the messages of the run currently streaming.
    if (promptRunIdRef.current !== runId) return;
    try {
      if (sid) await loadSession(sid);
    } finally {
      if (promptRunIdRef.current !== runId) return;
      const promptWasPending = rpcPromptPendingRef.current;
      const agentWasActive = sdkAgentActiveRef.current;
      rpcPromptPendingRef.current = false;
      sdkAgentActiveRef.current = false;
      optimisticUserMessageKeyRef.current = null;
      const wasRunning = settleUiStage();
      if (promptWasPending) {
        notifyPromptStage(runId);
      } else if (agentWasActive && wasRunning) {
        onAgentEnd?.();
      }
      if (sid) scheduleEventStreamClose(sid);
    }
  }, [loadSession, notifyPromptStage, onAgentEnd, scheduleEventStreamClose, settleUiStage]);

  const waitForPromptSettlement = useCallback(async (sid: string, runId?: number) => {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      try {
        const res = await fetch(apiUrl(`/api/agent/${encodeURIComponent(sid)}`));
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          const state = data.state;
          if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning)) {
            await finishPromptWithoutStream(sid, runId);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [finishPromptWithoutStream]);

  const waitForBashSettlement = useCallback(async (sid: string) => {
    const recoveryId = bashRecoveryIdRef.current + 1;
    bashRecoveryIdRef.current = recoveryId;

    while (
      bashRunningRef.current
      && bashRecoveryIdRef.current === recoveryId
      && sessionIdRef.current === sid
    ) {
      await delay(BASH_STATE_RECONCILE_MS);
      try {
        const res = await fetch(apiUrl(`/api/agent/${encodeURIComponent(sid)}`));
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setPendingBash(null);
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession]);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same settlement path used by non-streaming prompts.
  const reconcileAgentState = useCallback(async (sid: string) => {
    if (!agentRunningRef.current || sessionIdRef.current !== sid) return;
    const runId = promptRunIdRef.current;
    try {
      const res = await fetch(apiUrl(`/api/agent/${encodeURIComponent(sid)}`));
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (sessionIdRef.current !== sid || promptRunIdRef.current !== runId) return;
      const state = data.state;
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      setIsCompacting(state?.isCompacting ?? false);
      setQueuedMessages(normalizeQueuedMessages(state?.queuedMessages));
      setPendingRecovery(state?.pendingRecovery ?? []);
      setQueueTrash(state?.queueTrash ?? []);
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting);
      if (busy) {
        sdkAgentActiveRef.current = Boolean(state.isStreaming);
        rpcPromptPendingRef.current = Boolean(state.isPromptRunning);
        return;
      }
      if (!agentRunningRef.current) return;
      if (state) {
        if (state.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
        if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
        if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
        if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
      }
      await finishPromptWithoutStream(sid, runId);
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [finishPromptWithoutStream]);

  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = setInterval(reconcile, AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, reconcileAgentState]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  useEffect(() => {
    isCompactingRef.current = isCompacting;
  }, [isCompacting]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "connected": {
        dispatchStream({ type: "end" });
        if (event.isStreaming === true) {
          cancelEventStreamGrace();
          sdkAgentActiveRef.current = true;
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase({ kind: "waiting_model" });
        }
        break;
      }
      case "agent_start":
        cancelEventStreamGrace();
        sdkAgentActiveRef.current = true;
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatchStream({ type: "start" });
        break;
      case "agent_end":
        // One logical prompt can emit multiple agent_end events before retrying,
        // compacting, or continuing messages queued by extension handlers.
        // Keep the stream open until prompt_done/agent_settled and the idle grace.
        if (!agentRunningRef.current) break;
        setAgentPhase(null);
        setRetryInfo(null);
        dispatchStream({ type: "end" });
        if (sessionIdRef.current) {
          loadSession(sessionIdRef.current);
          fetch(apiUrl(`/api/agent/${encodeURIComponent(sessionIdRef.current)}`))
            .then((r) => r.json())
            .then((d: { state?: AgentStateResponse }) => {
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
              if (d.state?.extensionStatuses !== undefined) setExtensionStatuses(d.state.extensionStatuses ?? []);
              if (d.state?.extensionWidgets !== undefined) setExtensionWidgets(d.state.extensionWidgets ?? []);
              // Aborted turns can leave messages queued in pi (delivered with the
              // next turn); dead wrapper (no state) means the queue is gone.
              setQueuedMessages(normalizeQueuedMessages(d.state?.queuedMessages));
              setPendingRecovery(d.state?.pendingRecovery ?? []);
              setQueueTrash(d.state?.queueTrash ?? []);
            })
            .catch(() => {});
        }
        break;
      case "agent_settled": {
        const agentWasActive = sdkAgentActiveRef.current;
        sdkAgentActiveRef.current = false;
        if (!agentWasActive || rpcPromptPendingRef.current) break;

        const sid = sessionIdRef.current;
        // 后端会话：拉取本轮用量
        if (sid && backendSource && sessionCapabilities?.getUsage) {
          void sendAgentCommand(sid, { type: "get_usage" })
            .then((r) => {
              const d = r as { usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number } };
              if (d?.usage) setBackendUsage(d.usage);
            })
            .catch(() => {});
        }
        const wasRunning = settleUiStage();
        setIsCompacting(false);
        if (sid) {
          void loadSession(sid);
          scheduleEventStreamClose(sid);
        }
        if (wasRunning) onAgentEnd?.();
        break;
      }
      case "prompt_done":
        {
          const runId = promptRunIdRef.current;
          const promptWasPending = rpcPromptPendingRef.current;
          rpcPromptPendingRef.current = false;
          optimisticUserMessageKeyRef.current = null;
          const firstNotification = notifyPromptStage(runId);
          if (!promptWasPending && !firstNotification) break;

          const sid = sessionIdRef.current;
          if (sid) void loadSession(sid);
          // An extension-injected agent may already have started before the
          // command's prompt_done. Keep that active stage visible and let its
          // agent_settled event perform the next completion transition.
          if (!sdkAgentActiveRef.current) {
            settleUiStage();
            if (sid) scheduleEventStreamClose(sid);
          }
        }
        break;
      case "prompt_error":
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? "Command failed" });
        break;
      case "extension_error":
        addNotice({
          type: "error",
          message: (event.error as string | undefined) ?? "Extension command failed",
        });
        break;
      case "message_start":
      case "message_update": {
        // Ignore streaming events arriving after this run already finished
        // (e.g. SSE data buffered while the tab was frozen, flushed after
        // reconcile) — they would resurrect a ghost streaming bubble.
        if (!agentRunningRef.current) break;
        if (event.type === "message_start") {
          const msg = event.message as AgentMessage | undefined;
          if (msg?.role === "user") break;
          if (msg?.role === "assistant") {
            dispatchStream({ type: "snapshot", message: msg });
            if (msg.content.length > 0) setAgentPhase(null);
          } else if (msg) {
            setAgentPhase(null);
          }
        } else {
          const delta = event.assistantMessageEvent as ClientAssistantMessageEvent | undefined;
          if (delta) {
            enqueueDelta(delta);
          }
        }
        // Step-follow 触发统一由下方 useEffect [streamState] → scheduleFollowStep 承担
        // （passive effect，paint 后读布局免费；delta-batch 合并后每帧最多一次）。
        // 此处不再 rAF 读 rect：rAF 在渲染管线前执行，React 的 delta-batch commit
        // 可能尚未落到 DOM，读到旧布局 → step 到过期位置 → 原地抖动（实测）。
        break;
      }
      case "message_end": {
        // Same late-event guard: after reconcile finished this run,
        // loadSession already loaded this message from the session file —
        // appending it again would duplicate it.
        if (!agentRunningRef.current) break;
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role === "user") {
          // Delivered steering/follow-up messages surface here as user
          // messages. The run's initial prompt also emits one, but handleSend
          // already appended it optimistically. Consume only the still-adjacent
          // optimistic bubble; later same-text queue deliveries must render.
          const delivered = normalizeToolCalls(completed);
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
              return optimisticKey === deliveredKey
                ? prev
                : [...prev.slice(0, -1), delivered];
            }
            return [...prev, delivered];
          });
        } else if (completed) {
          // If this assistant reply was actually produced by the model the user
          // switched to mid-run, the switch has now taken effect — clear the
          // "applies next turn" hint. (The assistant message carries the real
          // model/provider that generated it.)
          if (completed.role === "assistant") {
            const msgModel = (completed as unknown as { model?: string; provider?: string }).model;
            const msgProvider = (completed as unknown as { model?: string; provider?: string }).provider;
            if (msgModel && msgProvider) {
              setModelSwitchPending((prev) =>
                prev && prev.modelId === msgModel && prev.provider === msgProvider
                  ? null
                  : prev,
              );
            }
          }
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        dispatchStream({ type: "end" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_update": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        const progress = getToolExecutionProgress(event.partialResult);
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          const existing = tools.find((tool) => tool.id === id);
          const updated = {
            id,
            name: name || existing?.name || "tool",
            progress: progress ?? existing?.progress,
          };
          return {
            kind: "running_tools",
            tools: [...tools.filter((tool) => tool.id !== id), updated],
          };
        });
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "queue_update":
        setQueuedMessages({
          steering: [...((event.steering as string[] | undefined) ?? [])],
          followUp: [...((event.followUp as string[] | undefined) ?? [])],
        });
        break;
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          if (sessionIdRef.current) loadSession(sessionIdRef.current);
        }
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
      case "permission_request":
        setPermissionRequest({
          requestId: String(event.requestId ?? ""),
          toolName: typeof event.toolName === "string" ? event.toolName : undefined,
          input: event.input,
        });
        addNotice({ type: "error", message: "工具需要授权：" + (typeof event.toolName === "string" ? event.toolName : "unknown") });
        break;
      case "permission_expired":
        setPermissionRequest(null);
        break;
    }
  }, [addNotice, cancelEventStreamGrace, dispatchStream, enqueueDelta, handleExtensionUiRequest, loadSession, notifyPromptStage, onAgentEnd, scheduleEventStreamClose, settleUiStage]);
  handleAgentEventRef.current = handleAgentEvent;

  const switchPermissionMode = useCallback(async (mode: string): Promise<boolean> => {
    const sid = sessionIdRef.current ?? session?.id;
    if (!sid) return false;
    try {
      await sendAgentCommand(sid, { type: "set_permission_mode", mode });
      return true;
    } catch (e) {
      console.error("Failed to switch permission mode:", e);
      return false;
    }
  }, [sessionIdRef, session?.id]);

  const respondToPermission = useCallback(async (behavior: "allow" | "deny") => {
    const req = permissionRequest;
    if (!req || permissionRespondingRef.current) return;
    permissionRespondingRef.current = true;
    try {
      await sendAgentCommand(sessionIdRef.current ?? session?.id ?? "", {
        type: "permission_response",
        requestId: req.requestId,
        behavior,
        message: behavior === "deny" ? "denied in web ui" : undefined,
      });
      setPermissionRequest(null);
    } catch (e) {
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      permissionRespondingRef.current = false;
    }
  }, [permissionRequest, session?.id]);

  const handleSend = useCallback(async (message: string, images?: AttachedImage[], files?: AttachedFile[]) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return;
    if (agentRunningRef.current || bashRunningRef.current) {
      restoreSubmission(message, images, composerDraftKey);
      return;
    }
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    // ── /relay <target-id> <message> ────────────────────────────────────────
    // agent-to-agent 中继：把消息投递给目标 live 会话，回收回复并注入当前对话。
    if (trimmedMessage.startsWith("/relay ")) {
      const rest = trimmedMessage.slice(7);
      const spaceIdx = rest.indexOf(" ");
      const targetId = spaceIdx > 0 ? rest.slice(0, spaceIdx) : "";
      const relayMsg = spaceIdx > 0 ? rest.slice(spaceIdx + 1).trim() : "";
      if (!targetId || !relayMsg) {
        addNotice({ type: "error", message: "用法: /relay <session-id> <message>（目标必须是存活的 backend 会话）" });
        return;
      }

      // 显示用户消息 + relay 状态
      const relayUserMsg: AgentMessage = { role: "user", content: trimmedMessage, timestamp: Date.now() };
      setMessages((prev) => [...prev, relayUserMsg]);
      setAgentRunning(true);
      dispatchStream({ type: "start" });

      void (async () => {
        try {
          const res = await fetch(apiUrl("/api/relay"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: targetId, message: relayMsg }),
          });
          const d = await res.json() as { ok?: boolean; reply?: string; error?: string };
          if (d.ok && d.reply) {
            setMessages((prev) => [...prev, {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: `[relay → ${targetId}] ${d.reply}` }],
              model: "relay",
              provider: "relay",
            } as AgentMessage]);
          } else {
            addNotice({ type: "error", message: `Relay failed: ${d.error ?? "unknown"}` });
          }
        } catch (e) {
          addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
        } finally {
          setAgentRunning(false);
          dispatchStream({ type: "end" });
        }
      })();
      return;
    }

    const isBashCommand = !images?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) {
        restoreSubmission(message, images, composerDraftKey);
        return;
      }
      await executeBashRef.current?.(bashCmd, isExcluded);
      return;
    }

    // Compaction is in progress: pi rejects prompts until it finishes. Queue
    // the message as a follow-up (no optimistic chat bubble — it lives in the
    // queue panel) and it is delivered automatically once compaction
    // completes. Slash extension commands are still executed immediately.
    if (isCompactingRef.current) {
      const sid = sessionIdRef.current;
      if (!sid) return;
      // Open SSE first so the queue_update (and the flush-run events after
      // compaction) reach us; best-effort if the stream cannot connect.
      try {
        await ensureEventsConnected(sid);
      } catch {
        // The command below still queues the message.
      }
      const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
      try {
        await sendAgentCommand(sid, {
          type: "prompt",
          message: trimmedMessage,
          streamingBehavior: "followUp",
          ...(piImages?.length ? { images: piImages } : {}),
        });
      } catch (e) {
        console.error("Failed to queue prompt during compaction:", e);
        addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    const promptRunId = promptRunIdRef.current + 1;
    cancelEventStreamGrace();
    rpcPromptPendingRef.current = true;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    promptRunIdRef.current = promptRunId;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatchStream({ type: "start" });
    pendingScrollToUserRef.current = true;
    setPromptAnchorActive(true);

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    let sentSessionId: string | null = null;
    let promptRequestStarted = false;

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        const sid = existingSid ?? await ensureNewSession();

        if (!sid) throw new Error("Unable to create a session for the prompt");
        sentSessionId = sid;
        if (selectedModel) {
          setPendingModel(selectedModel);
          if (existingSid) {
            await sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
          }
        }
        await ensureEventsConnected(sid);
        promptRequestStarted = true;
        await sendAgentCommand(sid, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
          ...(files?.length ? { files: files.map((f) => ({ data: f.data, mimeType: f.mimeType, filename: f.filename })) } : {}),
        });
        promoteNewSession(1, message);
      } else if (session) {
        sentSessionId = session.id;
        await ensureEventsConnected(session.id);
        promptRequestStarted = true;
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
          ...(files?.length ? { files: files.map((f) => ({ data: f.data, mimeType: f.mimeType, filename: f.filename })) } : {}),
        });
      } else {
        throw new Error("No active session for the prompt");
      }
      if (isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
    } catch (e) {
      console.error("Failed to send message:", e);
      const definitivelyRejected = !promptRequestStarted || isPromptRejectedError(e);
      // A transport/proxy failure after dispatch is ambiguous: the server may
      // have accepted the prompt before the response was lost. Keep SSE alive
      // until server state confirms the run is idle.
      if (!definitivelyRejected && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
        return;
      }
      rpcPromptPendingRef.current = false;
      setMessages((prev) => {
        const optimisticIndex = prev.lastIndexOf(userMsg);
        return optimisticIndex === -1
          ? prev
          : [...prev.slice(0, optimisticIndex), ...prev.slice(optimisticIndex + 1)];
      });
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      restoreSubmission(message, images, composerDraftKey);
      optimisticUserMessageKeyRef.current = null;
      // Rejection only describes this submission. Another tab or an event we
      // missed may still have a real run active for the same session, so keep
      // its SSE connection until server state says the wrapper is idle.
      if (sentSessionId) {
        void reconcileAgentState(sentSessionId);
        return;
      }
      agentRunningRef.current = false;
      closeEvents();
      setAgentRunning(false);
      setAgentPhase(null);
      dispatchStream({ type: "end" });
    }
  }, [isNew, newSessionCwd, newSessionModel, session, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, addNotice, cancelEventStreamGrace, closeEvents, composerDraftKey, reconcileAgentState, restoreSubmission, dispatchStream]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (agentRunningRef.current || bashRunningRef.current) return;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    setPendingBash({ command, excludeFromContext });
    setBashRunning(true);
    try {
      const sid = sessionIdRef.current ?? session?.id ?? await ensureNewSession();
      if (!sid) throw new Error("Unable to create a session for the shell command");
      await sendAgentCommand(sid, {
        type: "bash",
        command,
        excludeFromContext,
      });
      await loadSession(sid);
      promoteNewSession(1, inputText);
    } catch (e) {
      console.error("Failed to execute shell command:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      restoreSubmission(inputText, undefined, composerDraftKey);
    } finally {
      bashRunningRef.current = false;
      setPendingBash(null);
      setBashRunning(false);
    }
  }, [addNotice, composerDraftKey, ensureNewSession, loadSession, promoteNewSession, restoreSubmission, session]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (bashRunningRef.current) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" });
      } catch (e) {
        console.error("Failed to abort bash:", e);
      }
      return;
    }
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, []);

  const handleFork = useCallback(async (entryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }).catch(() => {});
    setActiveLeafId(entryId);
    await loadContext(sid, entryId);
  }, [loadContext]);

  /** 「编辑从此处」发送时执行：先把会话回退到分支点（首条消息 → 根重建），再发送编辑后的消息。
   *  点击标记阶段纯前端（预填+高亮），这里才是真正生效的点（原位不动直到发送）。
   *  @param targetId 回退目标：常规 = 上一条 assistant 的 entryId；首条消息 = 消息自身 entryId（parentId → 根）
   *  @param leafId  回退后加载的 leaf（首条消息 = null → 空历史） */
  const handleEditFromStartSend = useCallback(async (
    targetId: string,
    leafId: string | null,
    message: string,
    images?: AttachedImage[],
  ) => {
    const sid = sessionIdRef.current;
    if (sid) {
      try {
        await sendAgentCommand(sid, { type: "navigate_tree", targetId });
      } catch (e) {
        // 回退失败继续发送会把消息发到错误分支（用户以为已回退）——
        // 中止本次发送并提示，pending 标记与输入内容保留，用户可重试。
        console.error("Edit-from-here: navigate failed:", e);
        addNotice({ type: "error", message: "编辑从此处：会话回退失败，请重试" });
        return;
      }
      setActiveLeafId(leafId);
      await loadContext(sid, leafId);
    }
    await handleSend(message, images);
  }, [handleSend, loadContext, addNotice]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (bashRunningRef.current) return;
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
    if (leafId) {
      sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId }).catch(() => {});
    }
  }, [loadContext]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      const selectedModel = { provider, modelId };
      newSessionModelOverrideRef.current = selectedModel;
      setNewSessionModel(selectedModel);
      setPendingModel(selectedModel);
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid || modelSwitchPendingRef.current) return;
    const target = { provider, modelId };
    const previousOverride = currentModelOverride;
    modelSwitchPendingRef.current = true;
    setCurrentModelOverride(target);
    setModelSwitching(true);
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      setCurrentModelOverride({ provider, modelId });
      // Switching mid-run only takes effect next turn (the in-flight request
      // still uses the old model). Surface this so the user isn't confused by
      // the model name updating immediately. Switching back to the model the
      // current run is using cancels the pending switch instead.
      if (agentRunning) {
        const runModel = agentRunModelRef.current;
        if (runModel && runModel.provider === provider && runModel.modelId === modelId) {
          setModelSwitchPending(null);
        } else {
          setModelSwitchPending({ provider, modelId });
        }
      }
      // Pi persists model_change synchronously. Reload the canonical session so
      // the model, thinking level, and active leaf all advance together.
      modelSwitchPendingRef.current = false;
      await loadSession(sid);
    } catch (e) {
      console.error("Failed to set model:", e);
      modelSwitchPendingRef.current = false;
      setCurrentModelOverride(previousOverride);
      addNotice({
        type: "error",
        message: `Failed to switch model: ${e instanceof Error ? e.message : String(e)}`,
      });
      // A failed response can still follow a server-side write (for example, a
      // dropped connection), so let the session file settle the displayed model.
      await loadSession(sid);
    } finally {
      modelSwitchPendingRef.current = false;
      setModelSwitching(false);
    }
  }, [addNotice, agentRunning, currentModelOverride, isNew, loadSession, setNewSessionModel]);

  const runCompactNow = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      // No showLoading: flipping `loading` unmounts the whole chat (including
      // ChatInput) and silently discards the message the user is typing.
      // isCompacting already gives the in-flight feedback; refresh in place.
      await loadSession(sid);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      setIsCompacting(false);
    }
  }, [loadSession]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    // Agent running (streaming OR executing a tool call): compacting now
    // would race the active agent loop (both rewrite context + session file).
    // Queue it for the next idle window.
    if (agentRunning) {
      pendingCompactRef.current = true;
      setCompactQueued(true);
      setCompactError(null);
      return;
    }
    await runCompactNow();
  }, [isCompacting, agentRunning, runCompactNow]);

  // Record the model the current run started with, then clear the "applies
  // next turn" hint once the agent finishes the run.
  useEffect(() => {
    if (agentRunning) {
      if (currentModel) {
        agentRunModelRef.current = { provider: currentModel.provider, modelId: currentModel.modelId };
      }
    } else {
      agentRunModelRef.current = null;
      setModelSwitchPending(null);
    }
    // Intentionally only reacts to agentRunning: currentModel may change mid-run
    // when the user switches, which must NOT overwrite the run's start model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentRunning]);

  // Drain a queued compaction as soon as the agent is truly idle (covers SSE
  // events, reconcile, and visibility/online recovery — all paths that clear
  // isStreaming). prompt_done alone is not enough: retries, auto-compaction,
  // and queued follow-ups can extend a logical run.
  useEffect(() => {
    if (pendingCompactRef.current && !agentRunning && !isCompacting) {
      pendingCompactRef.current = false;
      setCompactQueued(false);
      void runCompactNow();
    }
  }, [agentRunning, isCompacting, runCompactNow]);

  const cancelCompactQueue = useCallback(() => {
    pendingCompactRef.current = false;
    setCompactQueued(false);
  }, []);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    // ── 后端会话（attach/spawn/extension）：模型清单来自 list_models 能力，
    //    而非本地 /api/models。切换复用现有 set_model 命令（adapter 映射）。
    if (!isNew && session?.agent && sessionIdRef.current) {
      try {
        const d = await sendAgentCommand<{ models?: Array<{ id: string; provider: string; label?: string }> }>(
          sessionIdRef.current,
          { type: "list_models" },
        );
        const list = (d.models ?? []).map((m) => ({ id: m.id, name: m.label ?? m.id, provider: m.provider }));
        setModelList(list);
        setModelNames(Object.fromEntries(list.map((m) => [m.id, m.name])));
        setModelError(null);
        setModelScopeWarnings([]);
        return;
      } catch {
        // 后端不支持 listModels → 落回本地清单（多半也为空，选择器自然禁用）
      }
    }
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    const modelsUrl = modelCwd ? apiUrl(`/api/models?cwd=${encodeURIComponent(modelCwd)}`) : apiUrl("/api/models");
    const res = await fetch(modelsUrl, signal ? { signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json() as ModelsResponse;
    setModelNames(d.models);
    setModelError(d.modelError ?? null);
    setModelScopeWarnings(d.modelScopeWarnings ?? []);
    setModelThinkingLevels(d.thinkingLevels ?? {});
    setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
    const nextModelList = d.modelList ?? [];
    setModelList(nextModelList);
    if (isNew && !sessionIdRef.current) {
      const match = d.defaultModel
        ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
        : undefined;
      const displayModel = match ?? nextModelList[0];
      setNewSessionDefaultModel(displayModel ? { provider: displayModel.provider, modelId: displayModel.id } : null);
      // An `enabledModels` pattern may pin a thinking level (`anthropic/*:high`).
      // Like pi, apply it to the model a new session starts with.
      const pinned = displayModel && d.thinkingLevelPins?.[`${displayModel.provider}/${displayModel.id}`];
      if (thinkingLevelOverrideRef.current === null) {
        setThinkingLevel((pinned as ThinkingLevelOption | undefined) ?? "auto");
      }
    }
  }, [isNew, newSessionCwd, session?.cwd, session?.agent]);

  /**
   * Pull fresh session stats (incl. contextUsage) from the agent process.
   * POST /api/agent/[id] spins up the wrapper on demand, so this works even
   * for idle sessions where /state returned no contextUsage on load — that's
   * exactly the case where the topbar/panel would otherwise show no context %.
   * The override self-clears when messages or contextUsage change (effect below).
   */
  const refreshSessionStats = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
      if (!stats || sessionIdRef.current !== sid) return;
      setSessionStatsOverride(stats);
      if (stats.contextUsage) setContextUsage(stats.contextUsage);
    } catch {
      // Panel falls back to the locally computed stats; don't surface an error.
    }
  }, []);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    const sid = sessionIdRef.current ?? await ensureNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (result.action !== "openSessionStats") {
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting) return complete({ handled: true, error: "No active session to compact" });
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          });
          setCompactResult(readCompactResult(result, "manual"));
          // Same as runCompactNow: showLoading would unmount ChatInput and
          // lose the in-progress draft. Refresh in place instead.
          if (await loadSession(sid)) promoteNewSession();
          return complete({ handled: true, message: "Compacted context" });
        }

        case "reload": {
          if (!sid) return complete({ handled: true, error: "No active session to reload" });
          await sendAgentCommand(sid, { type: "reload" });
          await Promise.all([
            loadSession(sid, false, true),
            loadTools(sid),
            loadSlashCommands(),
            loadModels(),
          ]);
          return complete({ handled: true, message: "Reloaded session resources" });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: "No active session to name" });
          if (!args) return complete({ handled: true, error: "Usage: /name <name>" });
          await sendAgentCommand(sid, { type: "set_session_name", name: args });
          if (await loadSession(sid)) promoteNewSession();
          return complete({ handled: true, message: `Session renamed to ${args}` });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          await refreshSessionStats();
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") setIsCompacting(false);
    }
  }, [addNotice, ensureNewSession, isCompacting, loadModels, loadSession, loadSlashCommands, loadTools, promoteNewSession, onSessionStatsPanelOpen, refreshSessionStats]);

  // Let AgentSession.prompt decide atomically whether to queue against the
  // current run or start a new turn if it settled while the request was in
  // flight. Direct steer/followUp calls can strand a message in an idle queue.
  const sendStreamingPrompt = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    const sid = sessionIdRef.current;
    const restore = () => restoreSubmission(message, images, composerDraftKey);
    if (!sid) {
      restore();
      addNotice({ type: "error", message: "No active session for the queued message" });
      return;
    }
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "prompt",
        message,
        streamingBehavior: behavior,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to submit streaming prompt:", e);
      // A transport failure after dispatch is ambiguous: the server may have
      // accepted the queued prompt before the response was lost. Restoring in
      // that case would invite a duplicate turn.
      if (isPromptRejectedError(e)) restore();
      addNotice({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [addNotice, composerDraftKey, restoreSubmission]);

  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    await sendStreamingPrompt(message, "steer", images);
  }, [sendStreamingPrompt]);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    await sendStreamingPrompt(message, behavior, images);
  }, [sendStreamingPrompt]);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    await sendStreamingPrompt(message, "followUp", images);
  }, [sendStreamingPrompt]);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleRecallQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[] }>(sid, { type: "clear_queue" });
      // clearQueue also emits an empty queue_update, but that only reaches us
      // while SSE is connected — clear locally so idle recalls update the UI.
      setQueuedMessages({ steering: [], followUp: [] });
      const texts = [...(result?.steering ?? []), ...(result?.followUp ?? [])];
      if (texts.length > 0) {
        opts.chatInputRef?.current?.prependText(texts.join("\n\n"));
      }
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      addNotice({ type: "error", message: "Failed to recall queued messages" });
    }
  }, [opts.chatInputRef, addNotice]);

  /** Pick up a run that was started server-side (queue delivery, recovery
   * continue) — possibly before any SSE was connected (e.g. right after a
   * restart) — so streaming, agent_end refresh, and settlement all work. */
  const adoptRemoteRun = useCallback(async (sid: string) => {
    try {
      const stateRes = await fetch(apiUrl(`/api/agent/${encodeURIComponent(sid)}`));
      if (stateRes.ok) {
        const agentState = await stateRes.json() as { running?: boolean; state?: AgentStateResponse };
        const st = agentState.state;
        if (agentState.running && st && (st.isStreaming || st.isPromptRunning)) {
          sdkAgentActiveRef.current = Boolean(st.isStreaming);
          rpcPromptPendingRef.current = Boolean(st.isPromptRunning);
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase(st.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
          dispatchStream({ type: "start" });
          // ensureConnected is a no-op when a live SSE stream for this
          // session is already open, so restored-queue events are not lost.
          void ensureEventsConnected(sid);
          if (!st.isStreaming && st.isPromptRunning) {
            void waitForPromptSettlement(sid);
          }
        }
      }
    } catch { /* non-critical */ }
    // Refresh the message list shortly after the run starts so the restored
    // messages show up in the chat even if the SSE stream was not delivering
    // events reliably.
    try {
      await new Promise((r) => setTimeout(r, 800));
      if (sessionIdRef.current === sid) await loadSession(sid);
    } catch { /* non-critical */ }
  }, [ensureEventsConnected, waitForPromptSettlement, loadSession, dispatchStream]);

  /**
   * Decide what to do with pending recovery items: keep (re-queue, optionally
   * continuing the transcript) and/or discard. Returns the remaining items.
   */
  // Reset the import flag once the recovery list is fully drained so the
  // next crash recovery shows recovery copy again.
  useEffect(() => {
    if (pendingRecovery.length === 0) setRecoveryIsImport(false);
  }, [pendingRecovery.length]);
  const resolveRecovery = useCallback(async (
    keep: string[],
    discard: string[],
    continueRun = false,
  ): Promise<PendingRecoveryItem[]> => {
    const sid = sessionIdRef.current;
    if (!sid) return pendingRecovery;
    try {
      const result = await sendAgentCommand<{ remaining?: PendingRecoveryItem[] }>(sid, {
        type: "resolve_recovery",
        keep,
        discard,
        continueRun,
      });
      const remaining = result?.remaining ?? [];
      setPendingRecovery(remaining);
      // Re-queued entries may not be reflected locally if the queue_update SSE
      // was missed (or the SSE connection was not yet up) — refresh the live
      // queue from state so the restored messages show up immediately, and
      // auto-expand the queue panel (it collapses automatically when there
      // are >3 entries).
      void (async () => {
        try {
          const stateRes = await fetch(apiUrl(`/api/agent/${encodeURIComponent(sid)}`));
          if (!stateRes.ok) return;
          const agentState = await stateRes.json() as { running?: boolean; state?: AgentStateResponse };
          if (agentState.state?.queuedMessages !== undefined) {
            setQueuedMessages(normalizeQueuedMessages(agentState.state.queuedMessages));
          }
        } catch { /* non-critical */ }
      })();
      opts.chatInputRef?.current?.expandQueue?.();
      if (continueRun && keep.length > 0) {
        // The run was started server-side, possibly before any SSE was
        // connected (e.g. right after a restart) — pick it up so streaming,
        // agent_end refresh, and settlement all work as usual.
        void adoptRemoteRun(sid);
      }
      return remaining;
    } catch (e) {
      console.error("Failed to resolve queued message recovery:", e);
      addNotice({ type: "error", message: "Failed to resolve queued message recovery" });
      return pendingRecovery;
    }
  }, [pendingRecovery, addNotice, adoptRemoteRun, opts.chatInputRef]);

  /** Deliver the queued messages now — the 「继续」 button on an idle queue
   * (e.g. queue recovered after a restart but only re-queued, never
   * continued). Server-side this is the same runAgentContinue path as
   * recovery's "re-queue & continue". Returns true when a run was started. */
  const handleContinueQueue = useCallback(async (): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    try {
      const result = await sendAgentCommand<{ started?: boolean; empty?: boolean }>(sid, {
        type: "continue_queue",
      });
      if (!result?.started) return false;
      await adoptRemoteRun(sid);
      return true;
    } catch (e) {
      console.error("Failed to continue queue:", e);
      addNotice({ type: "error", message: "Failed to continue queue" });
      return false;
    }
  }, [adoptRemoteRun, addNotice]);

  /** Fetch the full live queue + recovery entries (with images) for export. */
  const exportQueueData = useCallback(async (): Promise<{ live: QueueEntry[]; recovery: QueueEntry[] } | null> => {
    const sid = sessionIdRef.current;
    if (!sid) return null;
    try {
      return await sendAgentCommand<{ live: QueueEntry[]; recovery: QueueEntry[] }>(sid, { type: "export_queue" });
    } catch (e) {
      console.error("Failed to export queue:", e);
      addNotice({ type: "error", message: "Failed to export queue" });
      return null;
    }
  }, [addNotice]);

  /** Re-queue entries parsed from an exported .json file. Returns count. */
  const importQueueData = useCallback(async (entries: QueueEntryInput[]): Promise<number | null> => {
    let sid = sessionIdRef.current;
    if (!sid) {
      sid = await ensureNewSession();
      if (!sid) return null;
    }
    try {
      const result = await sendAgentCommand<{ imported?: number; steering?: string[]; followUp?: string[] }>(sid, {
        type: "import_queue",
        entries,
      });
      // Keep the UI in sync with the freshly imported queue (SSE is idle here,
      // so the banner would otherwise stay hidden until a reload).
      if (result) setQueuedMessages(normalizeQueuedMessages(result));
      return result?.imported ?? 0;
    } catch (e) {
      console.error("Failed to import queue:", e);
      addNotice({ type: "error", message: "Failed to import queue" });
      return null;
    }
  }, [addNotice, ensureNewSession]);

  /** Stage imported entries as pending recovery so the recovery dialog pops
   *  up and the user chooses re-queue / re-queue & continue / discard. */
  const stageImport = useCallback(async (entries: QueueEntryInput[]): Promise<number | null> => {
    let sid = sessionIdRef.current;
    // A brand-new session has no id yet — create it first so the imported
    // queue can be staged against a real session (otherwise nothing happens
    // and the dialog never pops up).
    if (!sid) {
      sid = await ensureNewSession();
      if (!sid) return null;
    }
    try {
      const result = await sendAgentCommand<{ staged?: number; pendingRecovery?: PendingRecoveryItem[] }>(sid, {
        type: "stage_recovery",
        entries,
      });
      if (result?.pendingRecovery) setPendingRecovery(result.pendingRecovery);
      if ((result?.staged ?? 0) > 0) setRecoveryIsImport(true);
      return result?.staged ?? 0;
    } catch (e) {
      console.error("Failed to stage import:", e);
      addNotice({ type: "error", message: "Failed to stage imported queue" });
      return null;
    }
  }, [addNotice, ensureNewSession]);

  /** Move a queued message within its queue (clear + re-enqueue server-side). */
  const moveQueuedMessage = useCallback(async (
    kind: "steer" | "followUp",
    fromIndex: number,
    toIndex: number,
  ): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    try {
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[] }>(sid, {
        type: "move_queue",
        kind,
        fromIndex,
        toIndex,
      });
      if (result) setQueuedMessages(normalizeQueuedMessages(result));
      return true;
    } catch (e) {
      console.error("Failed to move queued message:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : "Failed to move queued message" });
      return false;
    }
  }, [addNotice]);

  /** Change a queued message's kind (steer ↔ followUp) without dispatching it. */
  const convertQueuedMessage = useCallback(async (
    kind: "steer" | "followUp",
    index: number,
    targetKind: "steer" | "followUp",
  ): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    try {
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[] }>(sid, {
        type: "convert_queue_item",
        kind,
        index,
        targetKind,
      });
      if (result) setQueuedMessages(normalizeQueuedMessages(result));
      return true;
    } catch (e) {
      console.error("Failed to convert queued message:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : "Failed to convert queued message" });
      return false;
    }
  }, [addNotice]);

  /** Pull one queued message out (clear + re-enqueue the rest); returns its text + images. */
  const recallQueuedMessage = useCallback(async (
    kind: "steer" | "followUp",
    index: number,
  ): Promise<{ text: string; images?: ChatDraftImage[] } | null> => {
    const sid = sessionIdRef.current;
    if (!sid) return null;
    try {
      const result = await sendAgentCommand<{ entry?: { text: string; images?: Array<{ type: "image"; data: string; mimeType: string }> }; steering?: string[]; followUp?: string[] }>(sid, {
        type: "recall_queue_item",
        kind,
        index,
      });
      if (result && (result.steering !== undefined || result.followUp !== undefined)) {
        setQueuedMessages(normalizeQueuedMessages(result));
      }
      if (!result?.entry) return null;
      return {
        text: result.entry.text,
        images: result.entry.images?.map((img) => ({
          data: img.data,
          mimeType: img.mimeType,
        })),
      };
    } catch (e) {
      console.error("Failed to recall queued message:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : "Failed to recall queued message" });
      return null;
    }
  }, [addNotice]);

  /** Insert an edited message back into the queue at its original position. */
  const requeueAt = useCallback(async (
    kind: "steer" | "followUp",
    index: number,
    text: string,
    images?: ChatDraftImage[],
  ): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    try {
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[] }>(sid, {
        type: "requeue_at",
        kind,
        index,
        text,
        images: images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
      });
      if (result) setQueuedMessages(normalizeQueuedMessages(result));
      return true;
    } catch (e) {
      console.error("Failed to requeue message:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : "Failed to requeue message" });
      return false;
    }
  }, [addNotice]);

  /**
   * Remove a single queued message (clear + re-enqueue the rest). Soft delete
   * by default: the entry moves to the trash and the returned view lets the UI
   * offer an undo toast. `permanent` skips the trash (used when the entry was
   * consumed by being dispatched, e.g. steer-send).
   */
  const removeQueuedMessage = useCallback(async (
    kind: "steer" | "followUp",
    index: number,
    opts?: { permanent?: boolean },
  ): Promise<QueueTrashItem | null> => {
    const sid = sessionIdRef.current;
    if (!sid) return null;
    try {
      const result = await sendAgentCommand<{ removed?: QueueTrashItem; steering?: string[]; followUp?: string[] }>(sid, {
        type: "remove_queue_item",
        kind,
        index,
        ...(opts?.permanent ? { permanent: true } : {}),
      });
      if (result && (result.steering !== undefined || result.followUp !== undefined)) {
        setQueuedMessages(normalizeQueuedMessages(result));
      }
      return result?.removed ?? null;
    } catch (e) {
      console.error("Failed to remove queued message:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : "Failed to remove queued message" });
      return null;
    }
  }, [addNotice]);

  /**
   * Restore a soft-deleted entry from the trash back into the live queue.
   * Optional `index` places it within its kind (undo toast); otherwise it
   * appends to its kind (trash bin).
   */
  const restoreQueueItem = useCallback(async (id: string, index?: number): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    try {
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[]; queueTrash?: QueueTrashItem[] }>(sid, {
        type: "restore_trash_item",
        id,
        ...(index !== undefined ? { index } : {}),
      });
      if (result) {
        setQueuedMessages(normalizeQueuedMessages(result));
        if (result.queueTrash !== undefined) setQueueTrash(result.queueTrash);
      }
      return true;
    } catch (e) {
      console.error("Failed to restore queued message:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : "Failed to restore message" });
      return false;
    }
  }, [addNotice]);

  /**
   * Permanently delete entries from the trash (no undo from here on). Omitting
   * ids empties the whole trash; the UI confirms before calling.
   */
  const purgeQueueTrash = useCallback(async (ids?: string[]): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    try {
      const result = await sendAgentCommand<{ queueTrash?: QueueTrashItem[] }>(sid, {
        type: "purge_trash",
        ...(ids && ids.length > 0 ? { ids } : {}),
      });
      if (result?.queueTrash !== undefined) setQueueTrash(result.queueTrash);
      return true;
    } catch (e) {
      console.error("Failed to purge trash:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : "Failed to clear trash" });
      return false;
    }
  }, [addNotice]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (isNew && !sessionIdRef.current) {
      thinkingLevelOverrideRef.current = level === "auto" ? null : level;
    }
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, [isNew]);

  const handleToolPresetChange = useCallback(async (preset: ToolPreset) => {
    const toolNames = getToolNamesForPreset(preset);
    setPreferredToolPreset(preset);
    setToolPresetState(preset);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames });
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [setToolPresetState]);

  const scrollUserMsgToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const targetTop = Math.min(Math.max(0, elAbsTop - 16), maxScrollTop);

    if (liveFollowFrameRef.current !== null) {
      cancelAnimationFrame(liveFollowFrameRef.current);
      liveFollowFrameRef.current = null;
    }
    // A smooth scroll reports its position after the first streaming event can
    // arrive, so update the tail state before the browser emits that event.
    isNearBottomRef.current = targetTop >= maxScrollTop - SCROLL_BOTTOM_THRESHOLD;
    // Landing near the tail re-arms follow; scrolling to a user message high
    // up keeps the walked-away state (the user just jumped away from the tail).
    if (isNearBottomRef.current) userScrolledAwayRef.current = false;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    container.scrollTo({ top: targetTop, behavior: "smooth" });
  }, []);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
      // Up-direction keys are a definitive "user is leaving the tail" signal.
      if (SCROLL_UP_KEYS.has(event.key)) userScrolledAwayRef.current = true;
    } else if (event instanceof WheelEvent && event.deltaY < 0) {
      // Wheel-up likewise: no programmatic scroll ever emits wheel events, so
      // this can't be content growth or our own step scrolling.
      userScrolledAwayRef.current = true;
    }
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const handleScrollPositionChange = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      const { scrollTop, clientHeight, scrollHeight } = container;
      const prevScrollTop = lastScrollTopRef.current;
      lastScrollTopRef.current = scrollTop;
      isNearBottomRef.current = scrollTop + clientHeight >= scrollHeight - SCROLL_BOTTOM_THRESHOLD;
      if (isNearBottomRef.current) {
        // Back at the tail: re-arm auto-follow for the rest of this run.
        userScrolledAwayRef.current = false;
      } else if (
        agentRunningRef.current &&
        scrollTop < prevScrollTop - 1 &&
        Date.now() >= ignoreProgrammaticScrollUntilRef.current
      ) {
        // scrollTop decreased by user agency (touch drag, momentum tail,
        // missed wheel edge): content growing BELOW the fold never moves
        // scrollTop, and programmatic scrolls are filtered by the ignore
        // window, so this is the user reading history.
        userScrolledAwayRef.current = true;
      }
      if (!isNearBottomRef.current && liveFollowFrameRef.current !== null) {
        cancelAnimationFrame(liveFollowFrameRef.current);
        liveFollowFrameRef.current = null;
      }
    }
  }, []);

  // Load session on mount
  useEffect(() => {
    sessionHookMountedRef.current = true;
    if (session) {
      sessionIdRef.current = session.id;
      loadSession(session.id, true, true).then((agentState) => {
        if (agentState?.running) {
          loadTools(session.id);
          if (agentState.state?.isStreaming || agentState.state?.isPromptRunning) {
            sdkAgentActiveRef.current = Boolean(agentState.state.isStreaming);
            rpcPromptPendingRef.current = Boolean(agentState.state.isPromptRunning);
            agentRunningRef.current = true;
            setAgentRunning(true);
            setAgentPhase(agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
            dispatchStream({ type: "start" });
            void maintainEventsConnected(session.id);
            if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
              void waitForPromptSettlement(session.id);
            }
          }
          if (agentState.state?.isBashRunning) {
            bashRunningRef.current = true;
            setBashRunning(true);
            void waitForBashSettlement(session.id);
          }
        }
        if (agentState?.state) {
          if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
          if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
          if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
          if (agentState.state.thinkingLevel !== undefined) setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (agentState.state.extensionStatuses !== undefined) setExtensionStatuses(agentState.state.extensionStatuses ?? []);
          if (agentState.state.extensionWidgets !== undefined) setExtensionWidgets(agentState.state.extensionWidgets ?? []);
          if (agentState.state.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(agentState.state.queuedMessages));
          if (agentState.state.pendingRecovery !== undefined) setPendingRecovery(agentState.state.pendingRecovery ?? []);
          if (agentState.state.queueTrash !== undefined) setQueueTrash(agentState.state.queueTrash ?? []);
        }
        // After a restart there may be no wrapper yet; fetch the sidecar-based
        // recovery list directly (no AgentSession is created for this read).
        void fetch(apiUrl(`/api/sessions/${encodeURIComponent(session.id)}/queue-recovery`))
          .then((res) => (res.ok ? res.json() : null))
          .then((data: { items?: PendingRecoveryItem[] } | null) => {
            if (data?.items && sessionIdRef.current === session.id) {
              setPendingRecovery(data.items);
            }
          })
          .catch(() => { /* non-critical */ });
      });
    }
    return () => {
      sessionHookMountedRef.current = false;
      const abandonedDraftKey = isNew ? newSessionDraftKey : null;
      if (abandonedDraftKey) {
        queueMicrotask(() => {
          if (!sessionHookMountedRef.current && !newSessionPromotedRef.current) {
            clearDraft(abandonedDraftKey);
          }
        });
      }
      if (liveFollowFrameRef.current !== null) {
        cancelAnimationFrame(liveFollowFrameRef.current);
        liveFollowFrameRef.current = null;
      }
      bashRecoveryIdRef.current += 1;
      cancelEventStreamGrace();
      closeEvents();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    onSystemPromptLoaderChange?.(loadSystemPrompt);
    return () => onSystemPromptLoaderChange?.(null);
  }, [loadSystemPrompt, onSystemPromptLoaderChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  useEffect(() => {
    const setPointerDown = () => { userPointerDownRef.current = true; };
    const setPointerUp = () => { userPointerDownRef.current = false; };
    window.addEventListener("keydown", markUserScrollIntent);
    // Any press also opens the scroll-intent reserve window (10s); the hold
    // flag additionally freezes auto-follow for the whole press.
    window.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
    window.addEventListener("pointerdown", setPointerDown, { passive: true });
    window.addEventListener("pointerup", setPointerUp, { passive: true });
    window.addEventListener("pointercancel", setPointerUp, { passive: true });
    // Alt-tab / app switch can drop the pointerup — release the hold so
    // following doesn't stay frozen.
    window.addEventListener("blur", setPointerUp);
    return () => {
      window.removeEventListener("keydown", markUserScrollIntent);
      window.removeEventListener("pointerdown", markUserScrollIntent);
      window.removeEventListener("pointerdown", setPointerDown);
      window.removeEventListener("pointerup", setPointerUp);
      window.removeEventListener("pointercancel", setPointerUp);
      window.removeEventListener("blur", setPointerUp);
    };
  }, [markUserScrollIntent]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    previousScrollTopRef.current = container.scrollTop;
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [messages.length, loading, handleScrollPositionChange]);

  useEffect(() => {
    if (!agentRunning) setPromptAnchorActive(false);
    // A new run re-arms auto-follow: whatever the user did while reading the
    // previous answer, a fresh prompt starts following from the current
    // position (send paths also scroll to the tail / user message).
    else userScrolledAwayRef.current = false;
  }, [agentRunning]);

  useLayoutEffect(() => {
    if (messages.length > 0) {
      if (pendingScrollToUserRef.current) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
        scrollUserMsgToTop();
      } else if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        scrollToBottom("instant");
      } else if (!agentRunningRef.current && !userPointerDownRef.current && (completionScrollAllowedRef.current || isNearBottomRef.current)) {
        scrollToBottom("smooth");
      }
    }
  }, [messages.length, agentRunning, scrollToBottom, scrollUserMsgToTop]);

  // Step-follow 检查信号：流式 delta（streamState 每帧引用变）+ 完整消息渲染
  // （messages 引用变：message_end 提交 / reconcile 加载 tool result / 上下文加载）。
  // 之前只依赖 streamState 且带 `!isStreaming` 门控：tool result、完整消息等非流式
  // 渲染推高最后消息时无人检查 → 视口不动，直到下一轮流式才补跟（瞬时大跳）。
  // 注意：此处用 useEffect（passive，paint 后执行）而非 useLayoutEffect——passive
  // 阶段读布局免费（无 pending DOM 写），不会强制同步布局；delta-batch 已把
  // streamingMessage 更新合并到每帧一次，effect 每帧最多跑一次，无布局风暴。
  // messages 引用只在消息级变化（非每 chunk），额外触发频次低，无布局压力。
  useEffect(() => {
    // 发送/跳转滚动期间不 follow（原 message_update live-follow 同款抑制）
    if (pendingScrollToUserRef.current) return;
    // agent 空闲时收尾滚动由 messages/length 的 useLayoutEffect → scrollToBottom
    // 负责（平滑滚到底）；这里不 step，避免与滚底竞争（也避免打开旧会话时
    // 初始加载被误 step 到 120px 处）。
    if (!agentRunningRef.current) return;
    scheduleFollowStep();
  }, [streamState, messages, scheduleFollowStep]);

  // The queue banner / input area sits BELOW the scroll container in a flex
  // column. When the queue grows (or shrinks), the container's clientHeight
  // changes without any message event — the last message can end up hidden
  // behind the queue banner. Re-run the step-follow check on size changes so
  // follow re-aims at the new (smaller) viewport.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => scheduleFollowStep());
    ro.observe(container);
    return () => ro.disconnect();
  }, [scheduleFollowStep, scrollContainerRef]);

  // Load model list
  useEffect(() => {
    const controller = new AbortController();
    loadModels(controller.signal).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
    });
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  useEffect(() => {
    if (noticeState.visible.length === 0) return;
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, NOTICE_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [noticeState.visible]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  return {
    // State
    data, loading, error, activeLeafId, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, compactQueued, cancelCompactQueue, modelSwitchPending, currentModel, displayModel, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    pendingRecovery, recoveryIsImport, resolveRecovery, exportQueueData, importQueueData, stageImport,
    queueTrash, restoreQueueItem, purgeQueueTrash,
    moveQueuedMessage, convertQueuedMessage, recallQueuedMessage, requeueAt, removeQueuedMessage,
    notices: noticeState.visible, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    permissionRequest, respondToPermission, switchPermissionMode, sessionCapabilities, backendSource, backendUsage,
    isAutoModelSelection: isNew && newSessionModel === null,
    agentPhase,
    isNew,
    promptAnchorActive,
    // Refs
    sessionIdRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleEditFromStartSend, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleContinueQueue,
    handleBuiltinSlashCommand,
    refreshSessionStats,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, loadSlashCommands, setActiveLeafId, setData, setMessages,
    scrollToBottom, scrollUserMsgToTop,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  };
}

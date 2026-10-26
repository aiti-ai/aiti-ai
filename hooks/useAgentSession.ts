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
  ToolResultMessage,
  UserMessage,
} from "@/lib/types";
import { isBlockingExtensionUiRequest } from "@/lib/browser-notifications";
import { normalizeToolCalls } from "@/lib/normalize";
import { agentStatusUrl, describeAgentCommandError, isPromptRejectedError, sendAgentCommand } from "@/lib/agent-client";
import type { ChatDraftImage } from "@/lib/composer/draft-api";
import { applyDraftIntent } from "@/lib/composer/draft-api";
import type { PendingRecoveryItem, QueueEntry, QueueEntryInput, QueueTrashItem } from "@/lib/queue-store";
import { readCachedModels, writeCachedModels } from "@/lib/models-client-cache";
import {
  deleteSessionViewSnapshot,
  getSessionViewSnapshot,
  setSessionViewSnapshot,
} from "@/lib/session-view-cache";
import { getDraft } from "@/lib/draft-store";
import { getPreferredToolPreset, setPreferredToolPreset } from "@/lib/tool-preset-preference";
import { CONFIGURED_TOOL_PRESET, getPresetFromToolNames, getToolNamesForPreset, type ToolEntry, type ToolPreset } from "@/lib/tool-presets";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { mergeSessionStats, type SessionFileStats } from "@/lib/session-stats";
import { userMessageKey } from "@/lib/prompt-recovery";
import type { SessionRequestAnswer, SessionRequestPayload } from "@/lib/ext/types";
import { runNewSessionPreparers, type NewSessionPreparer } from "@/hooks/new-session-preparers";
import { useI18n } from "@/hooks/useI18n";
import { carryMessageKeys, messageRenderKeys } from "@/lib/message-keys";
import {
  AgentEventConnection,
  canReleaseHiddenEventStream,
  SESSION_LEASE_TIMEOUT_MS,
  sessionLeaseShowsActivity,
  type SessionLeaseReply,
} from "@/lib/agent-event-connection";
import { HIDDEN_PAGE_GRACE_MS } from "@/hooks/usePageHidden";
import { AGENT_EVENT_HEARTBEAT_MS, isNestedToolExecutionEvent, isSystemMessageEvent } from "@/lib/agent-event-wire";
import { getToolExecutionProgress } from "@/lib/tool-execution-progress";
import { CODEMODE_TOOL_NAME, getCodemodeProgress } from "@/lib/codemode-view";
import { updateExtensionWidgets } from "@/lib/extension-widgets";
import { bareMcpOpensSettings } from "@/lib/mcp-command";
import type { SettingsSection } from "@/lib/settings-navigation";
import {
  enqueueExtensionUiRequest,
  removeExtensionUiRequest,
  retainExtensionUiRequests,
  upsertExtensionUiRequest,
} from "@/lib/extension-ui-queue";
import {
  shouldShowScrollToLatest,
} from "@/lib/chat-lazy-load";
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
  toolNames?: string[];
  /** Opaque freshness token for the session view cache (summary tree reads). */
  snapshotRevision?: string | null;
  /** "summary" when `tree` carries the body-free navigation format. */
  treeFormat?: "summary";
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    oldestEntryId: string | null;
    hasMore: boolean;
    turnsBefore: number;
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
  /** Cumulative usage over ALL session-file entries (incl. compacted history). */
  stats?: SessionFileStats;
  /** True when GET ?force=1 dropped a stale live wrapper and rebuilt from disk. */
  wrapperRebuilt?: boolean;
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

/** Task entry (read-only mirror of the agent working plan; wire-shaped like zcode TodoWrite, shared by task_update/get_state). */
type SessionTask = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: string;
};

/** Defensively normalize the task_update payload (untrusted backend surface: invalid entries are dropped). */
function normalizeTasks(raw: unknown): SessionTask[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionTask[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.content !== "string" || !o.content) continue;
    if (o.status !== "pending" && o.status !== "in_progress" && o.status !== "completed") continue;
    out.push({
      content: o.content,
      status: o.status,
      ...(typeof o.priority === "string" && o.priority ? { priority: o.priority } : {}),
    });
  }
  return out;
}

type AgentStateResponse = {
  model?: { provider: string; id: string };
  sessionId?: string;
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  /** Active time over the live wrapper's entries (the snapshot carries the same field). */
  totalActiveMs?: number;
  systemPrompt?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  /** Authoritative busy flag (delivered via the server's get_state / connected frames; same criteria as the sidebar running set):
   *  covers busy states beyond isStreaming (manual compaction aborts the current run first, queued follow-up dispatch, etc.). */
  isRunning?: boolean;
  isPromptRunning?: boolean;
  /** Run start time (epoch ms): recorded by the external backend handle; authoritative value for restoring the elapsed-time origin after reopening the page. */
  runStartedAt?: number;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  autoCompactionEnabled?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  /** Monotonic queue revision rev carried by ext-agent backends (queue_update events and get_state snapshots share the same axis);
   *  local pi sessions lack this field (the guard automatically degrades to the original behavior). */
  queuedMessages?: { steering?: string[]; followUp?: string[]; rev?: number } | null;
  /** Task-list snapshot (same source as task_update events; materialized via get_state, seeds restored after page refresh) */
  tasks?: SessionTask[] | null;
  pendingRecovery?: PendingRecoveryItem[] | null;
  queueTrash?: QueueTrashItem[] | null;
  /** Backend session capability declaration (capability-aware control rendering) */
  capabilities?: Record<string, boolean>;
  /** Backend source label (e.g. "claude-code-agent/claude-code") */
  backendSource?: string;
};

/** Session "busy" decision (server-authoritative criteria first): used uniformly by open-session adoption / reconciliation / the guard poll.
 *  isRunning covers busy states beyond isStreaming (manual compaction, promptRunning, etc.);
 *  falls back to the original three flags when older servers lack the field — never misreads idle because a field is missing. */
function stateIsActive(state?: AgentStateResponse | null): boolean {
  if (!state) return false;
  return Boolean(state.isRunning || state.isStreaming || state.isPromptRunning || state.isCompacting);
}

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
  /** Parallel attachment flags (index-aligned with steering/followUp, optional / backward-compatible): used for queue-row attachment icons. */
  steeringHasImages?: boolean[];
  followUpHasImages?: boolean[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[]; steeringHasImages?: boolean[]; followUpHasImages?: boolean[] } | null): QueuedMessages {
  return {
    steering: q?.steering ?? [],
    followUp: q?.followUp ?? [],
    ...(Array.isArray(q?.steeringHasImages) ? { steeringHasImages: q.steeringHasImages } : {}),
    ...(Array.isArray(q?.followUpHasImages) ? { followUpHasImages: q.followUpHasImages } : {}),
  };
}

/** queue_update reports plain text only (pi protocol limitation): align the stale local attachment-flag arrays with the new text lengths.
 *  Same length → keep as-is (most fresh values were just written from the queue RPC response); shorter → FIFO head consumed, keep the tail;
 *  longer → flags for newly enqueued tail entries are unknown → pad with false. */
function alignQueueAttachmentFlags(prev: boolean[] | undefined, nextLen: number): boolean[] {
  const p = prev ?? [];
  if (p.length === nextLen) return p;
  if (p.length > nextLen) return p.slice(p.length - nextLen);
  return [...p, ...Array<boolean>(nextLen - p.length).fill(false)];
}

/** Fallback origin for the run elapsed timer: the latest user message's timestamp (= when that prompt was sent).
 *  On page reopen / reconnect the agent_start event is already missed — the origin must not be "the moment the page
 *  opened" (the old behavior restarted the timer from zero on every open); count from after that message was sent.
 *  Returns null when no usable timestamp exists. */
function deriveRunStartedAt(messages: AgentMessage[]): number | null {
  let userIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { userIndex = i; break; }
  }
  if (userIndex === -1) return null;
  const promptTimestamp = messages[userIndex].timestamp;
  if (typeof promptTimestamp === "number" && promptTimestamp > 0) return promptTimestamp;
  // Replayed user messages from external backends may lack a timestamp (liveHistory shapes such as codebuddy):
  // fall back to the first timestamped message after it (the earliest known activity moment of that run).
  for (let i = userIndex + 1; i < messages.length; i++) {
    const timestamp = messages[i].timestamp;
    if (typeof timestamp === "number" && timestamp > 0) return timestamp;
  }
  return null;
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
  | { kind: "compacting" }
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
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" | "openSettings" };

/** How a run ended, for the completion sound and notifications. */
export interface AgentEndInfo {
  /** The run was stopped (Esc, Stop, another client's abort), not finished: nothing to announce. */
  aborted: boolean;
}

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  sessionRunning?: boolean;
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  /** Session backend for NEW sessions (providerType from /api/session-backends). null/undefined = local pi. */
  newSessionBackend?: string | null;
  /** Preparer pipeline run before new-session creation (extensions register via the newSessionPreparers surface; ChatWindow collects and passes them through).
   *  ensureNewSession awaits them in order before the POST: {cwd} rewrites the target directory (that is how the branch/worktree picker
   *  reuses/creates a worktree), {abort} cancels creation (throw → the existing notice channel). */
  newSessionPreparers?: NewSessionPreparer[];
  /** A run ended; `aborted` when it was stopped rather than finished (pi's `agent_settled.aborted`). */
  onAgentEnd?: (end: AgentEndInfo) => void;
  /** A top-level tool call finished; the files it touched may have changed. */
  onToolEnd?: (toolName: string) => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string) => void;
  /** External-session placeholder/alias ids resolved by the server into the real composite id (e.g. zcode:new-* → zcode:sess_*) —
   *  the client migrates its selection and URL accordingly so the sidebar does not show duplicate rows for one backend session. An in-flight chat is not reset. */
  onSessionIdCanonicalized?: (previousId: string, canonicalId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void, locked: boolean) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  /** Registers an action that lazily starts the session and loads its prompt and tools. */
  onSystemInfoLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsPanelOpen?: () => void;
  /** Opens Settings on a section; a bare `/mcp` the built-in MCP extension owns opens Settings › MCP. */
  onOpenSettings?: (section: SettingsSection) => void;
  setToolPreset?: (preset: ToolPreset) => void;
  /** Live heights of the prompt-anchor spacer and bottom composer spacer
   *  (owned by ChatWindow). Step-follow geometry needs them to know where the
   *  last message actually ends. */
  promptAnchorSpacerHeightRef?: React.MutableRefObject<number>;
  bottomComposerHeightRef?: React.MutableRefObject<number>;
  deferInitialScroll?: boolean;
  /** A fresh composer's model and reasoning picks to start with: the composer it replaces had them. */
  initialNewSessionChoices?: NewSessionChoices | null;
  /** A fresh composer reports its own model and reasoning picks, on mount and as they change. */
  onNewSessionChoicesChange?: (choices: NewSessionChoices) => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ConcreteThinkingLevel = Exclude<ThinkingLevelOption, "auto">;

/**
 * What a fresh composer was told to use instead of the automatic choice. The
 * bar above it moves the composer to another folder by remounting it; these
 * go along with the draft. (The tool preset needs no carrying: a pick is the
 * browser's preference, which every fresh composer starts from.)
 */
export interface NewSessionChoices {
  model: { provider: string; modelId: string } | null;
  thinkingLevel: ConcreteThinkingLevel | null;
}

function asConcreteThinkingLevel(value?: string | null): ConcreteThinkingLevel | null {
  if (!value || value === "auto") return null;
  return value as ConcreteThinkingLevel;
}

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
// Viewports where the on-screen keyboard eats the chat: the app's own
// phone/tablet breakpoints plus any touch-primary device. On these screens the
// keyboard is up while the user composes, so every passive scroll (stream
// step-follow, tail re-pin after the composer grew, completion scroll) moves
// the transcript under their thumbs — it interrupts typing. Active composing
// freezes those paths. Focus alone is NOT enough: phones keep the keyboard open
// after a send and that run must still follow, so the guard is refreshed by
// each edit event and expires on its own. Desktop windows with a mouse are
// excluded: there the composer never moves, so live-follow stays useful.
const CHAT_EDIT_FREEZE_QUERY = "(max-width: 959px), (pointer: coarse)";
// How long one edit keystroke holds the freeze. Long enough to cover the gaps
// between words (IME candidate picking included), short enough that pausing to
// read the streaming answer hands the view back by itself.
const COMPOSING_ACTIVE_MS = 5_000;
// Edit signals. `input`/`beforeinput` are the only ones some soft keyboards
// fire (iOS is not reliable at emitting keydown while composing).
const COMPOSING_EVENTS = ["beforeinput", "input", "keydown", "compositionstart"] as const;

function isEditFreezeViewport(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(CHAT_EDIT_FREEZE_QUERY).matches;
}

function isEditableNode(node: EventTarget | null): boolean {
  return node instanceof Element
    && Boolean(node.closest("input:not([type='button']):not([type='submit']):not([type='checkbox']), textarea, select, [contenteditable='true'], [role='textbox']"));
}

// Session id -> user entry being edited. ChatWindow remounts per session, so a
// pending edit lives here as long as that session's in-memory draft does.
const pendingHistoryEdits = new Map<string, string>();

const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const EVENT_STREAM_IDLE_GRACE_MS = 30_000;
const AGENT_STATE_RECONCILE_MS = 15_000; // Reconciliation fallback while running: foreground ticks only (background tabs reconcile on visibility/online return)
// While the SSE channel is active (business events + perceivable 30s heartbeats), defer real state reconciliation
// until this silence threshold — agent_end and friends arrive over the SSE primary channel and polling only
// backstops dropped events; after consecutive heartbeat loss / half-open dead links / connection errors it
// automatically returns to the AGENT_STATE_RECONCILE_MS baseline, with no switch required.
const SSE_ACTIVITY_IDLE_RECONCILE_MS = 120_000;
const BASH_STATE_RECONCILE_MS = 1_000;
const EVENT_STREAM_READY_TIMEOUT_MS = 60_000;
const EVENT_STREAM_RECONNECT_DELAY_MS = 1_000;
const SESSION_LEASE_RENEW_INTERVAL_MS = 30_000;
// A ready stream silent for two and a half heartbeats is dead (AgentEventConnection reconnects).
const EVENT_STREAM_STALE_MS = AGENT_EVENT_HEARTBEAT_MS * 2.5;
// This page's id for the lease that keeps its selected session alive (holdSessionLivenessLease()).
let pageLeaseHolder: string | null = null;
type SessionLeaseOutcome = SessionLeaseReply | "unanswered" | null;
function sessionLeaseUrl(sid: string): string {
  pageLeaseHolder ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `/api/agent/${encodeURIComponent(sid)}/lease?holder=${pageLeaseHolder}`;
}
// Retry temporary model-list failures without requiring a page refresh.
const MODELS_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
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
type ModelEntry = { id: string; name: string; provider: string; avail?: "ok" | "rl" | "err" | "unprobed"; providerRL?: boolean };
type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  defaultThinkingLevel?: string | null;
  savedDefaultThinkingLevel?: string | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  thinkingLevelPins?: Record<string, string>;
  modelError?: string;
  modelScopeWarnings?: string[];
};

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

/** Coalesce concurrent load windows of POST /api/models (same cwd shares one request; successful results are micro-cached for 2.5s).
 *  Same idea as dedupeFetch, except the body is a POST cwd and the cache key is per-cwd. */
const modelsShared = new Map<string, { at: number; promise: Promise<ModelsResponse> }>();
const MODELS_SHARED_TTL_MS = 2_500;
function fetchModelsShared(cwd: string): Promise<ModelsResponse> {
  const key = cwd || "";
  const hit = modelsShared.get(key);
  if (hit && Date.now() - hit.at < MODELS_SHARED_TTL_MS) return hit.promise;
  const promise = fetch(apiUrl("/api/models"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(key ? { cwd: key } : {}),
  }).then(async (res) => {
    if (!res.ok) {
      let detail = "";
      try {
        const body: unknown = await res.json();
        if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
          detail = body.error;
        }
      } catch {
        // Non-JSON error responses fall back to the HTTP status.
      }
      throw new Error(detail || `Failed to load models (HTTP ${res.status})`);
    }
    return await res.json() as ModelsResponse;
  }).catch((e) => {
    if (modelsShared.get(key)?.promise === promise) modelsShared.delete(key);
    throw e;
  });
  modelsShared.set(key, { at: Date.now(), promise });
  return promise;
}

/**
 * Prefetch the model list (AppShell calls this before the real cwd is ready,
 * warming up "recently used cwds"): hits/shares modelsShared (loadModels for
 * the same cwd reuses the in-flight request) and on success writes the client
 * cache — ChatWindow's mount-time cache replay no longer waits for another
 * network round trip. Best-effort: silent on failure (loadModels owns retry
 * and error surfacing for the real load).
 */
export function prefetchModels(cwd: string): void {
  if (!cwd) return;
  void fetchModelsShared(cwd)
    .then((d) => writeCachedModels(cwd, d))
    .catch(() => {});
}

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, newSessionDraftKey, onAgentEnd, onToolEnd, onAttentionNeeded, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsPanelOpen,
    newSessionBackend,
    onOpenSettings,
  } = opts;

  const { t } = useI18n();

  const isNew = session === null && newSessionCwd !== null;
  const initialChoices = isNew ? opts.initialNewSessionChoices ?? null : null;

  // New-session backend (providerType): mirrored in a ref so the ensureNewSession callback stays stable.
  const newSessionBackendRef = useRef<string | null | undefined>(opts.newSessionBackend);
  newSessionBackendRef.current = opts.newSessionBackend;

  // New-session preparer pipeline (branch/worktree intents etc.), mirrored in a ref (slot item identities change on
  // every store bump; the ref is what keeps the callback stable); the resolved cwd records the pipeline-rewritten
  // target directory for promoteNewSession to report via onSessionCreated (AppShell switches the active workspace
  // to the worktree path based on session.cwd).
  const newSessionPreparersRef = useRef<NewSessionPreparer[] | undefined>(opts.newSessionPreparers);
  newSessionPreparersRef.current = opts.newSessionPreparers;
  const newSessionResolvedCwdRef = useRef<string | null>(null);

  // Canonical-id callback: mirrored in a ref so loadSession dependencies stay stable.
  const onSessionIdCanonicalizedRef = useRef(opts.onSessionIdCanonicalized);
  onSessionIdCanonicalizedRef.current = opts.onSessionIdCanonicalized;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [activeToolResults, setActiveToolResults] = useState<Map<string, ToolResultMessage>>(new Map());
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [hasEarlierMessages, setHasEarlierMessages] = useState(false);
  const [earlierTurnCount, setEarlierTurnCount] = useState(0);
  const [streamState, dispatch] = useReducer(streamReducer, INITIAL_STREAMING_STATE);
  // Streaming delta micro-batching: dispatching on every SSE token/chunk makes React re-render N times within one
  // frame (cross-event batching does not coalesce), and a full-tree render + commit per frame is one source of the
  // layout storm during streaming. Enqueue deltas, then flush once per frame (delta-batch); in background tabs,
  // where rAF pauses, the queue waits in order.
  const pendingDeltasRef = useRef<ClientAssistantMessageEvent[]>([]);
  const pendingDeltasFrameRef = useRef<number | null>(null);
  const lastFlushTsRef = useRef(0);
  const DELTA_BATCH_MAX = 50; // Per-batch cap: flushing a long background-stream backlog all at once would be one long task in a single frame
  const DELTA_FLUSH_INTERVAL_MS = 50; // Min flush interval: rAF fires every frame but skips flushing when <50ms since the last —
  // 20fps is smooth enough for a text stream and cuts React renders 60fps → 20fps (-2/3), sharply lowering main-thread pressure while streaming.
  const flushPendingDeltas = useCallback(() => {
    if (pendingDeltasFrameRef.current !== null) {
      cancelAnimationFrame(pendingDeltasFrameRef.current);
      pendingDeltasFrameRef.current = null;
    }
    const all = pendingDeltasRef.current;
    if (all.length === 0) return;
    pendingDeltasRef.current = [];
    // A content event arrived (not pure toolcall metadata) → clear the waiting-for-model phase (once per frame instead of once per event)
    if (all.some((d) => d.type !== "toolcall_start" && d.type !== "toolcall_delta")) {
      setAgentPhase(null);
    }
    // Split into batches: ≤50 per batch (keeps reducer loop cost bounded); multiple batches still land in the same frame (React auto-batching)
    for (let i = 0; i < all.length; i += DELTA_BATCH_MAX) {
      const batch = all.slice(i, i + DELTA_BATCH_MAX);
      if (batch.length === 1) dispatch({ type: "delta", event: batch[0] });
      else dispatch({ type: "delta-batch", events: batch });
    }
  }, []);
  // Check the min interval every frame: flush only once 50ms has elapsed (or the backlog overflows), otherwise defer
  // to the next frame and check again (order preserved). Note a "deferred frame" must re-check the interval rather
  // than flush unconditionally — otherwise the throttle degrades to "defer by one frame", effectively ~30fps (33ms)
  // at 60fps instead of the 20fps (50ms) target, leaving main-thread pressure high.
  // The deferral chain cannot starve: elapsed time eventually satisfies the interval, and the backlog threshold
  // (DELTA_BATCH_MAX*2) backstops it.
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
  // Order preservation: snapshot/start/end reset or replace streamingMessage, so flush the queue synchronously
  // first, then enter the reducer (keeps the delta → boundary-event order within one scheduling cycle).
  const dispatchStream = useCallback((action: StreamAction) => {
    if (action.type === "start" || action.type === "snapshot" || action.type === "end") flushPendingDeltas();
    dispatch(action);
  }, [flushPendingDeltas]);
  useEffect(() => () => {
    // Discard unflushed deltas on unmount (the rAF is canceled to avoid dispatching after unmount)
    if (pendingDeltasFrameRef.current !== null) {
      cancelAnimationFrame(pendingDeltasFrameRef.current);
      pendingDeltasFrameRef.current = null;
    }
    pendingDeltasRef.current = [];
  }, []);
  const [agentRunning, setAgentRunning] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  /** "Stopping" wait state: set when stop is clicked, cleared once the current turn truly settles (agent_end / full
   *  settle / bash stop). Clearing is not tied to agentRunning — after an abort, queued follow-ups re-set
   *  agentRunning to true immediately, and clearing only on "fully idle" would deadlock the stopping state
   *  (observed 2026-09: stuck on "stopping" and never recovering). */
  const [aborting, setAborting] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelScopeWarnings, setModelScopeWarnings] = useState<string[]>([]);
  /** Manual model-catalog refresh in progress (new-session page "refresh model list"; drives the button's disabled/spinner state). */
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  /** Whether the current new-session page backend supports refresh (provider.refreshModels contract → the route's refreshable flag). */
  const [modelsRefreshable, setModelsRefreshable] = useState(false);
  /** Refresh cooldown timestamp (coalesces rapid clicks within 5s). */
  const modelsRefreshAtRef = useRef(0);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  /** A model switch was made while the agent was running — applies next turn.
   *  Stores the target model; switching back to the current run's model cancels. */
  const [modelSwitchPending, setModelSwitchPending] = useState<{ provider: string; modelId: string } | null>(null);
  /** Model the current agent run started with (agent_start / running transition). */
  const agentRunModelRef = useRef<{ provider: string; modelId: string } | null>(null);
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(() => initialChoices?.model ?? null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [toolPreset, setToolPreset] = useState<ToolPreset>(CONFIGURED_TOOL_PRESET);
  const [newSessionThinkingLevel, setNewSessionThinkingLevel] = useState<ConcreteThinkingLevel | null>(() => initialChoices?.thinkingLevel ?? null);
  const [newSessionDefaultThinkingLevel, setNewSessionDefaultThinkingLevel] = useState<ConcreteThinkingLevel | null>(null);
  const [savedDefaultThinkingLevel, setSavedDefaultThinkingLevel] = useState<ConcreteThinkingLevel | null>(null);
  const [currentThinkingOverride, setCurrentThinkingOverride] = useState<ConcreteThinkingLevel | null>(null);
  const [liveThinkingLevel, setLiveThinkingLevel] = useState<ConcreteThinkingLevel | null>(null);
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  // Active time read from the live state, with the session it belongs to: the
  // panel's snapshot is older than the transcript on screen, and this is what
  // keeps the value current while a run appends entries (#1334).
  const [liveTotalActiveMs, setLiveTotalActiveMs] = useState<{ sessionId: string; value: number } | null>(null);
  const contextUsageRequestIdRef = useRef(0);
  // Highest request id whose reply was applied. A reply applies only when it
  // is newer, so a failed newer read never discards an older good one.
  const contextUsageAppliedIdRef = useRef(0);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [liveModel, setLiveModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [autoCompactionEnabled, setAutoCompactionEnabled] = useState(true);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  /** Manual compaction queued while the agent was running; fires on next idle. */
  const [compactQueued, setCompactQueued] = useState(false);
  const pendingCompactRef = useRef(false);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [promptAnchorActive, setPromptAnchorActive] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  // Queued extension dialogs/custom panels by request id (upstream): the head
  // of each queue renders; the derived singles keep the fork's return contract.
  // Backend-session interaction primitives (permission / interaction /
  // provider-headers) stay last-write-wins — a backend surfaces one at a time.
  const [extensionDialogs, setExtensionDialogs] = useState<ExtensionUiDialogRequest[]>([]);
  const [extensionCustomUis, setExtensionCustomUis] = useState<ExtensionUiCustomRequest[]>([]);
  /** Backend session tool-permission request (permission_request event; one at a time, simplified to last-write-wins) */
  const [permissionRequest, setPermissionRequest] = useState<{
    requestId: string;
    toolName?: string;
    input?: unknown;
    /** Host-provided option list (ACP etc.: optionId/kind/name) — when present, buttons are generated from options (incl. "always allow"); otherwise the default is Allow/Deny. */
    options?: Array<{ optionId?: string; kind?: string; name?: string }>;
  } | null>(null);
  const permissionRespondingRef = useRef(false);
  /**
   * Backend session interaction-primitive request (interaction_request event;
   * one at a time, later arrivals overwrite earlier ones).
   * plan_approval = plan-approval card (zcode ExitPlanMode); ask_user =
   * question-options card (zcode AskUserQuestion); open_url = OAuth login card
   * (omp login, one-way, no answer needed).
   */
  const [interactionRequest, setInteractionRequest] = useState<{
    requestId: string;
    kind: "plan_approval" | "ask_user" | "permission" | "open_url" | "generic";
    toolName?: string;
    prompt?: string;
    plan?: string;
    url?: string;
    launchUrl?: string;
    questions?: Array<{
      header?: string;
      question: string;
      multiSelect?: boolean;
      options: Array<{ label: string; description?: string }>;
    }>;
    input?: unknown;
  } | null>(null);
  const interactionRespondingRef = useRef(false);
  /**
   * start-plan captcha-solving request (zcode plan channel;
   * provider_runtime_headers_request event, one at a time).
   * captchaConfig = the official AliyunCaptcha SDK init triple (fetched by the
   * backend from the server's client/configs).
   */
  const [providerHeadersRequest, setProviderHeadersRequest] = useState<{
    requestId: string;
    providerId: string;
    modelRef?: string;
    reason: "model-request" | "captcha-retry";
    captchaConfig: { sceneId: string; prefix: string; region: string };
  } | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  /** Queue revision cursor (ext-agent rev; root fix 2026-09-18 for "queued entries don't show until a manual refresh"):
   *  queue_update events and async get_state/queueManage snapshots carry rev on the same axis, and a late stale
   *  snapshot overwriting live state had no self-healing (reconciliation is skipped while SSE is active) — before
   *  applying, rev may only move forward, never backward. */
  const queueRevRef = useRef(0);
  /** Single entry point for applying state snapshots (every get_state-shaped queuedMessages application goes through it):
   *  a snapshot carrying rev ≤ the applied version is a stale snapshot racing live events → drop it;
   *  no rev (local pi session / older backend) → apply unconditionally, as before. */
  const applyQueuedSnapshot = useCallback((q: AgentStateResponse["queuedMessages"]) => {
    const rev = q?.rev;
    if (typeof rev === "number") {
      if (rev <= queueRevRef.current) return;
      queueRevRef.current = rev;
    }
    setQueuedMessages(normalizeQueuedMessages(q));
  }, []);
  /** Task list (agent working plan; task_update events + get_state seed, reset with liveState on session switch). */
  const [sessionTasks, setSessionTasks] = useState<SessionTask[]>([]);
  /** Backend session capabilities (passed through from the state endpoint; local sessions have none) */
  const [sessionCapabilities, setSessionCapabilities] = useState<Record<string, boolean> | null>(null);
  /** Backend session's latest-run usage (fetched from the API when the get_usage capability exists) */
  const [backendUsage, setBackendUsage] = useState<{ inputTokens?: number; outputTokens?: number; costUsd?: number; credits?: { remaining?: number; usedPercent?: number; unit?: string }; quotaExceeded?: boolean; buckets?: Array<{ name: string; remaining?: number; total?: number }> } | null>(null);
  const [backendSource, setBackendSource] = useState<string | undefined>(undefined);
  const [pendingRecovery, setPendingRecovery] = useState<PendingRecoveryItem[]>([]);
  const [queueTrash, setQueueTrash] = useState<QueueTrashItem[]>([]);
  /** True when the current pending-recovery list came from an import (not a
   *  crash recovery) — drives the dialog's copy. Resets when the list empties. */
  const [recoveryIsImport, setRecoveryIsImport] = useState(false);

  const eventConnectionRef = useRef<AgentEventConnection | null>(null);
  /** Mirror of the connection-pool starvation state (anti-deadlock): the yield gate inside shouldMaintain; see the piwe-conn-starve listener */
  const connStarvedRef = useRef(false);
  const eventStreamGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventStreamGraceGenerationRef = useRef(0);
  const eventStreamGraceActiveRef = useRef(false);
  // True while a hidden page has let go of the selected session's idle stream
  // (HTTP/1.1 allows a browser six connections per origin, shared by its tabs).
  const eventStreamReleasedRef = useRef(false);
  // Moves on each time a released stream is opened again, so the release
  // effect arms its grace anew for a page still hidden.
  const [eventStreamReattachCount, setEventStreamReattachCount] = useState(0);
  // The lease request in flight: the renewal tick and the release check share it.
  const leaseRequestRef = useRef<{ sid: string; promise: Promise<SessionLeaseOutcome> } | null>(null);
  const reattachEventStreamRef = useRef<(sid: string) => void>(() => {});
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const sessionPropIdRef = useRef<string | null>(session?.id ?? null);
  // False while the session carries no tool selection of its own, so its loadout
  // follows settings.json defaultTools and the picker must say so rather than
  // labelling it with whichever preset the resolved tools happen to match.
  const sessionToolsPinnedRef = useRef(false);
  const agentRunningRef = useRef(false);
  // Current run start (epoch ms): reset on agent_start, cleared on agent_settled — the origin of the phase-label elapsed timer (same semantics as zcode desktop's "working (xm ys)")
  const runStartedAtRef = useRef<number | null>(null);
  const isCompactingRef = useRef(false);
  const sdkAgentActiveRef = useRef(false);
  const rpcPromptPendingRef = useRef(false);
  const notifiedPromptRunIdRef = useRef(-1);
  const bashRunningRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  // Last SSE channel activity time (maintained by the event-connection layer's onActivity/onTrouble):
  // onActivity refreshes it (any data, incl. the 30s heartbeat); onTrouble zeroes it (connection error → next tick reconciles immediately).
  const lastSseActivityRef = useRef(0);
  // Indirection for reconcileAgentState: the connection-layer closure is created once during render and cannot capture later useCallback versions.
  const reconcileNowRef = useRef<() => void>(() => {});
  // Throttle stamp for immediate reconciliation: the disconnect retry loop (~1s per failed attempt) fires onTrouble repeatedly; cap the storm.
  const lastReconcileAtRef = useRef(0);
  const initialScrollDoneRef = useRef(Boolean(opts.deferInitialScroll));
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
  // Reactive mirror of userScrolledAwayRef, consumed by the small-screen
  // "following/paused" placeholder (ChatInput followStreaming prop).
  // setUserScrolledAway is the only writer — the ref keeps serving the
  // synchronous read path (smartFollowStep reads it every frame), while a
  // same-value state set bails out in React and causes no extra render.
  const [followPaused, setFollowPaused] = useState(false);
  const setUserScrolledAway = useCallback((v: boolean) => {
    userScrolledAwayRef.current = v;
    setFollowPaused(v);
  }, []);
  // Last observed scrollTop — lets the scroll handler see direction (a real
  // decrease outside the programmatic window = user scrolling up).
  const lastScrollTopRef = useRef(0);
  // True while the user holds a pointer/finger down (touch, mouse press,
  // drag). Auto-following pauses for the whole hold — no scrolling until the
  // pointer is released.
  const userPointerDownRef = useRef(false);
  // True while a text field holds focus, and until when the last edit keystroke
  // keeps passive chat scrolling frozen — see CHAT_EDIT_FREEZE_QUERY.
  const editingRef = useRef(false);
  const composingUntilRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const handleNavigateRef = useRef<((entryId: string) => Promise<boolean>) | undefined>(undefined);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  // The command list as last loaded, and the get_commands request under way, if
  // any. A bare /mcp reads them to tell whose /mcp it is (handleBuiltinSlashCommand).
  // The generation moves on with every request and every clear, and only a request
  // still current writes its answer: one that set_tools outdated (or a newer request)
  // would otherwise put back the list of a session that is no longer there.
  const slashCommandsRef = useRef<SlashCommandInfo[]>([]);
  const slashCommandsLoadRef = useRef<Promise<SlashCommandInfo[] | null> | null>(null);
  const slashCommandsGenerationRef = useRef(0);
  const newSessionPromotedRef = useRef(false);
  const newSessionModelOverrideRef = useRef<SelectedModel | null>(initialChoices?.model ?? null);
  const thinkingLevelOverrideRef = useRef<ConcreteThinkingLevel | null>(initialChoices?.thinkingLevel ?? null);
  const thinkingLevelPinsRef = useRef<Record<string, string>>({});
  const defaultThinkingLevelRef = useRef<ConcreteThinkingLevel | null>(null);
  const promptRunIdRef = useRef(0);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);
  const modelSwitchPendingRef = useRef(false);
  const draftKeyAliasesRef = useRef(new Map<string, string>());
  const messagesRef = useRef(messages);
  const sessionHookMountedRef = useRef(true);
  // In-flight session reads, keyed by session id (or force:<id> for fresh reads).
  const loadFlightsRef = useRef(new Map<string, Promise<unknown>>());
  // Latest settled view state, readable from the unmount cleanup without
  // re-subscribing it. Assigned every render like sessionPropIdRef below.
  const dataRef = useRef<SessionData | null>(null);
  const entryIdsRef = useRef<string[]>([]);
  const activeLeafIdRef = useRef<string | null>(null);
  const historyCursorRef = useRef<string | null>(null);
  const hasEarlierMessagesRef = useRef(false);
  const earlierTurnCountRef = useRef(0);

  sessionPropIdRef.current = session?.id ?? null;
  dataRef.current = data;
  messagesRef.current = messages;
  entryIdsRef.current = entryIds;
  activeLeafIdRef.current = activeLeafId;
  historyCursorRef.current = historyCursor;
  hasEarlierMessagesRef.current = hasEarlierMessages;
  earlierTurnCountRef.current = earlierTurnCount;

  if (!eventConnectionRef.current) {
    eventConnectionRef.current = new AgentEventConnection({
      createSource: (sid) => new EventSource(apiUrl(`/api/agent/${encodeURIComponent(sid)}/events`)),
      onEvent: (event) => handleAgentEventRef.current?.(event as AgentEvent),
      shouldMaintain: (sid) => (
        sessionHookMountedRef.current
        && sessionIdRef.current === sid
        && !connStarvedRef.current
        && (
          agentRunningRef.current
          || eventStreamGraceActiveRef.current
          || (sessionPropIdRef.current === sid && !eventStreamReleasedRef.current)
        )
      ),
      readinessTimeoutMs: EVENT_STREAM_READY_TIMEOUT_MS,
      reconnectDelayMs: EVENT_STREAM_RECONNECT_DELAY_MS,
      onActivity: () => { lastSseActivityRef.current = Date.now(); },
      onTrouble: () => {
        // Connection error: the dropped-events window is open and reconciliation should happen ASAP, but the
        // disconnect retry loop fires this callback repeatedly — throttle immediate reconciliation to at least one
        // baseline interval apart, with the 15s tick as the backstop; zeroing the activity stamp returns later
        // ticks to the short-interval baseline. reconcile returns on its own when the agent is not running.
        lastSseActivityRef.current = 0;
        const now = Date.now();
        if (now - lastReconcileAtRef.current >= AGENT_STATE_RECONCILE_MS) {
          lastReconcileAtRef.current = now;
          reconcileNowRef.current?.();
        }
      },
      staleAfterMs: EVENT_STREAM_STALE_MS,
      onUnexpectedError: (error) => {
        console.error("Failed to maintain the agent event stream:", error);
      },
    });
  }

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;
  const existingSessionId = session?.id;

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  /** Adopt the origin of this run's elapsed timer: keep the known value (a replayed agent_start must not reset it
   *  to zero); if unknown, prefer the server's state.runStartedAt (recorded by the external backend handle at this
   *  run's agent_start), then recover from loaded messages (the latest user message's timestamp), and only fall
   *  back to the current time as a last resort. */
  const adoptRunStartedAt = useCallback((serverStartedAt?: number) => {
    if (runStartedAtRef.current !== null) return;
    runStartedAtRef.current =
      (typeof serverStartedAt === "number" && serverStartedAt > 0 ? serverStartedAt : null)
      ?? deriveRunStartedAt(messagesRef.current)
      ?? Date.now();
  }, []);

  useLayoutEffect(() => {
    if (!existingSessionId && (!isNew || sessionIdRef.current)) return;
    setToolPresetState(getPreferredToolPreset());
  }, [existingSessionId, isNew, setToolPresetState]);

  const onNewSessionChoicesChange = opts.onNewSessionChoicesChange;
  useEffect(() => {
    if (isNew) onNewSessionChoicesChange?.({ model: newSessionModel, thinkingLevel: newSessionThinkingLevel });
  }, [isNew, newSessionModel, newSessionThinkingLevel, onNewSessionChoicesChange]);

  // Passive chat scrolling must stop while the user composes on a small screen
  // (keyboard up): see CHAT_EDIT_FREEZE_QUERY. Explicit, user-triggered jumps
  // (send / tap navigation / first paint) pass `force`.
  const isChatScrollFrozen = useCallback(
    () => isEditFreezeViewport() && editingRef.current && Date.now() < composingUntilRef.current,
    [],
  );

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth", opts?: { force?: boolean }) => {
    if (!opts?.force && isChatScrollFrozen()) return;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    // Landing at the tail re-arms auto-follow for subsequent output.
    setUserScrolledAway(false);
    const container = scrollContainerRef.current;
    if (!container) return;
    // Container-local scroll instead of messagesEndRef.scrollIntoView():
    // scrollIntoView walks up every ancestor scroller (html/body are overflow:
    // hidden but still programmatically scrollable), and with the soft keyboard
    // up that drags the whole page — input and all — out from under the user.
    const end = messagesEndRef.current;
    const target = end
      ? end.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      : container.scrollHeight;
    container.scrollTo({ top: Math.max(0, target), behavior });
    previousScrollTopRef.current = container.scrollTop;
  }, [isChatScrollFrozen, messagesEndRef, scrollContainerRef, setUserScrolledAway]);

  // Step-follow (always on): instead of scrolling to the bottom on every
  // streaming event, only scroll when new output pushes the last message
  // past a small keep-out zone — then step it back to the top 1/4 of the
  // viewport so the lower 3/4 refills with output before the next step.
  const smartFollowStep = useCallback(() => {
    if (Date.now() < userScrollIntentUntilRef.current) return;
    // While the user holds a pointer/finger down, pause all follow processing
    // — the view must not move under their finger. Resumes on release.
    if (userPointerDownRef.current) return;
    // Composing with the keyboard up on a small screen: streaming must not roll
    // the transcript under the user's thumbs. Resumes when the edit window
    // expires (they paused to read) or on blur — both queue a catch-up step.
    if (isChatScrollFrozen()) return;
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
  }, [isChatScrollFrozen, opts.promptAnchorSpacerHeightRef, opts.bottomComposerHeightRef, scrollContainerRef, messagesEndRef]);

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

  const currentModel = currentModelOverride ?? liveModel ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew
    ? (newSessionModel ?? newSessionDefaultModel)
    : currentModel ?? (data?.context.messages.length === 0 ? newSessionDefaultModel : null);
  const contextThinkingLevel = asConcreteThinkingLevel(
    data?.context.thinkingLevel && data.context.thinkingLevel !== "off"
      ? data.context.thinkingLevel
      : null,
  );
  const currentThinkingLevel = currentThinkingOverride ?? liveThinkingLevel ?? contextThinkingLevel;
  const displayThinkingLevel = isNew
    ? (newSessionThinkingLevel ?? newSessionDefaultThinkingLevel)
    : currentThinkingLevel ?? (data?.context.messages.length === 0 ? newSessionDefaultThinkingLevel : null);
  const composerDraftKey = session?.id ?? newSessionDraftKey ?? undefined;

  const syncLiveModel = useCallback((state?: AgentStateResponse) => {
    setLiveModel(state?.model
      ? { provider: state.model.provider, modelId: state.model.id }
      : null);
    if (state?.thinkingLevel !== undefined) {
      setLiveThinkingLevel(asConcreteThinkingLevel(state.thinkingLevel));
    }
  }, []);

  // Upstream draft-key alias resolution (provisional → real sid). The local promote redirect is handled by the
  // draft-keeper extension's contract; this map is kept to align with the upstream code shape (fewer merge conflicts).
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
    // Unmounted and not-yet-promoted new-session page: drop it (no composer to write into, no draft to restore)
    if (
      !sessionHookMountedRef.current
      && !newSessionPromotedRef.current
      && targetDraftKey === newSessionDraftKey
    ) return;
    // No key (empty state without a cwd): nowhere to persist a draft; guard against an empty string creating junk slots
    const intentKey = targetDraftKey ?? composerDraftKey;
    if (!intentKey) return;
    // Alias (provisional→sid) resolution belongs to the draft keeper; when the target is the current composer, the keeper writes it back into the input
    applyDraftIntent({ type: "rejected", key: intentKey, text, images: draftImages });
  }, [composerDraftKey, newSessionDraftKey]);

  // Editing a past message only prefills the composer; the branch moves when it is sent,
  // so cancelling or reloading never hides the rest of the conversation.
  const [editEntryId, setEditEntryId] = useState(() => {
    const sid = session?.id;
    if (sid && !getDraft(sid)) pendingHistoryEdits.delete(sid);
    return (sid && pendingHistoryEdits.get(sid)) || null;
  });
  const setEdit = useCallback((entryId: string | null) => {
    if (!session?.id) return;
    if (entryId) pendingHistoryEdits.set(session.id, entryId);
    else pendingHistoryEdits.delete(session.id);
    setEditEntryId(entryId);
  }, [session?.id]);
  const handleEditContent = useCallback((message: UserMessage, entryId: string) => {
    if (!session?.id) return;
    opts.chatInputRef?.current?.replaceMessage(message);
    setEdit(entryId);
  }, [opts.chatInputRef, session?.id, setEdit]);
  const cancelEdit = useCallback(() => setEdit(null), [setEdit]);

  const sessionStats = useMemo(() => {
    // Active time is a monotone sum over the session's entries, so of the two
    // readings the larger one is the newer one: the live state leads while a run
    // appends entries behind the panel's snapshot, and the snapshot leads after
    // a compaction or a reload, which install a newer one without reading the
    // state (#1334).
    const snapshotActiveMs = data?.totalActiveMs;
    const liveActiveMs = liveTotalActiveMs && liveTotalActiveMs.sessionId === data?.sessionId
      ? liveTotalActiveMs.value
      : undefined;
    const totalActiveMs = snapshotActiveMs === undefined && liveActiveMs === undefined
      ? undefined
      : Math.max(snapshotActiveMs ?? 0, liveActiveMs ?? 0);
    if (sessionStatsOverride) {
      return {
        ...sessionStatsOverride,
        totalActiveMs,
        ...(contextUsage ? { contextUsage } : {}),
      };
    }
    const fileStats = data?.stats;
    const stats = mergeSessionStats(fileStats, data?.context.messages ?? [], messages);
    if (stats.tokens.total === 0 && messages.length === 0 && !fileStats) return null;
    return {
      sessionFile: data?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      ...stats,
      totalActiveMs,
      ...(contextUsage ? { contextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, contextUsage, liveTotalActiveMs, data?.sessionId, data?.context.messages, data?.filePath, data?.totalActiveMs, data?.stats, session?.id, session?.name]);

  const applyLiveUsage = useCallback((state: AgentStateResponse | undefined, sid: string, runId: number, requestId: number) => {
    if (!sessionHookMountedRef.current || sessionIdRef.current !== sid
      || promptRunIdRef.current !== runId || requestId <= contextUsageAppliedIdRef.current) return;
    contextUsageAppliedIdRef.current = requestId;
    if (state?.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
    if (typeof state?.totalActiveMs === "number") setLiveTotalActiveMs({ sessionId: sid, value: state.totalActiveMs });
  }, []);

  const refreshContextUsage = useCallback(async (sid: string) => {
    const runId = promptRunIdRef.current;
    const requestId = ++contextUsageRequestIdRef.current;
    try {
      const res = await fetch(agentStatusUrl(sid));
      if (!res.ok) return;
      const data = await res.json() as { state?: AgentStateResponse };
      applyLiveUsage(data.state, sid, runId, requestId);
    } catch {
      // A later message or the running-state poll retries the usage read.
    }
  }, [applyLiveUsage]);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false, options?: { force?: boolean; fresh?: boolean }) => {
    // Single-flight: concurrent reads for the same session (mount + SSE settle +
    // reconcile) share one request unless the caller forces a fresh read.
    // ?fresh=1 (wrapper reclaim + disk re-read) bypasses the join exactly like
    // ?force=1: it must observe post-reload reality, not an older flight.
    const bypass = Boolean(options?.force || options?.fresh);
    const flightKey = bypass ? `force:${sid}` : sid;
    const inflight = bypass ? undefined : loadFlightsRef.current.get(flightKey);
    if (inflight) return await inflight;
    const flight = (async (): Promise<unknown> => {
      let messagesLoaded = false;
      try {
        if (showLoading) setLoading(true);
        const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1", tree: "summary" });
        // ?fresh=1: the server reclaims the idle wrapper and re-reads from disk (aligns with external progress; see reloadCurrentSession)
        if (options?.fresh) params.set("fresh", "1");
        // ?force=1: the server checks whether the disk is ahead of the in-memory index (another pi process appended); if so it evicts and rebuilds
      if (options?.force) params.set("force", "1");
      const res = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sid)}?${params}`));
      if (res.status === 404) {
        if (showLoading) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          setEntryIds([]);
          setHistoryCursor(null);
          setHasEarlierMessages(false);
          setEarlierTurnCount(0);
          setError(null);
        }
        deleteSessionViewSnapshot(sid);
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData;
      if (sessionIdRef.current !== sid) return null;
      // Placeholder/alias id canonicalization: when the server resolves new-*/aliases into the real composite id,
      // the client migrates its selection and URL accordingly (an in-flight chat is not reset; dual registration
      // keeps old-id requests hitting).
      if (d.sessionId && d.sessionId !== sid) {
        try { onSessionIdCanonicalizedRef.current?.((sid), d.sessionId); } catch { /* callback errors must not block loading */ }
      }
      // Freshness check: when the disk snapshot is unchanged (same opaque
      // revision), keep any history the user already paged in instead of
      // collapsing back to the fresh 50-entry window. The state hooks then
      // only need the server's tree/leaf/stats — never a history reset.
      const cached = getSessionViewSnapshot(sid);
      const revisionUnchanged = Boolean(
        d.snapshotRevision
        && cached?.revision === d.snapshotRevision
        && cached.entryIds.length >= (d.context.entryIds ?? []).length,
      );
      const persistedMessages = revisionUnchanged ? messagesRef.current : d.context.messages;
      setData(revisionUnchanged
        ? {
            ...d,
            context: {
              ...d.context,
              messages: messagesRef.current,
              entryIds: entryIdsRef.current,
              oldestEntryId: historyCursorRef.current,
              hasMore: hasEarlierMessagesRef.current,
              turnsBefore: earlierTurnCountRef.current,
            },
          }
        : d);
      setActiveLeafId(d.leafId);
      if (revisionUnchanged) {
        // Refresh the cached snapshot with the newest leaf/tree/stats while
        // preserving the wider loaded window.
        setSessionViewSnapshot({
          sessionId: sid,
          revision: d.snapshotRevision!,
          messages: messagesRef.current,
          entryIds: entryIdsRef.current,
          leafId: d.leafId,
          oldestEntryId: historyCursorRef.current,
          hasMore: hasEarlierMessagesRef.current,
          turnsBefore: earlierTurnCountRef.current,
          summaryTree: d.tree,
          thinkingLevel: d.context.thinkingLevel,
          model: d.context.model,
          stats: d.stats,
          totalActiveMs: d.totalActiveMs,
          loadedEntryIds: entryIdsRef.current,
        });
      } else {
        setMessages(persistedMessages);
        // Mirror synchronously (don't wait for useEffect): the running adoption later in this same flow (the mount
        // agentState.then, state fetches) must immediately use this message batch to derive the elapsed-time origin.
        messagesRef.current = persistedMessages;
        setEntryIds(d.context.entryIds ?? []);
        setHistoryCursor(d.context.oldestEntryId);
        setHasEarlierMessages(d.context.hasMore);
        setEarlierTurnCount(d.context.turnsBefore ?? 0);
      }
      // Tool-preset state is independent of the view cache: it must be applied
      // on every read, cached window or not (#700).
      sessionToolsPinnedRef.current = d.toolNames !== undefined;
      setToolPresetState(d.toolNames !== undefined ? getPresetFromToolNames(d.toolNames) : CONFIGURED_TOOL_PRESET);
      setCurrentModelOverride((current) => modelSwitchPendingRef.current ? current : null);
      setCurrentThinkingOverride(null);
      setError(null);
      if (d.treeFormat === "summary" && d.snapshotRevision) {
        setSessionViewSnapshot({
          sessionId: sid,
          revision: d.snapshotRevision,
          messages: persistedMessages,
          entryIds: d.context.entryIds ?? [],
          leafId: d.leafId,
          oldestEntryId: d.context.oldestEntryId,
          hasMore: d.context.hasMore,
          turnsBefore: d.context.turnsBefore ?? 0,
          summaryTree: d.tree,
          thinkingLevel: d.context.thinkingLevel,
          model: d.context.model,
          stats: d.stats,
          totalActiveMs: d.totalActiveMs,
          loadedEntryIds: d.context.entryIds ?? [],
        });
      }
      if (d.wrapperRebuilt) {
        eventConnectionRef.current?.close();
        eventConnectionRef.current?.maintain(sid);
      }
      if (!includeState && d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setLiveThinkingLevel(asConcreteThinkingLevel(d.context.thinkingLevel));
      }

      messagesLoaded = true;
      if (showLoading) setLoading(false);
      if (!includeState) return null;

      try {
        const runId = promptRunIdRef.current;
        const usageRequestId = ++contextUsageRequestIdRef.current;
        const stateRes = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sid)}/state`));
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse };
        if (sessionIdRef.current !== sid) return null;

        const liveState = agentState.state;
        syncLiveModel(liveState);
        if (liveState) {
          if (liveState.capabilities !== undefined) setSessionCapabilities(liveState.capabilities);
          if (liveState.backendSource !== undefined) setBackendSource(liveState.backendSource);
          applyLiveUsage(liveState, sid, runId, usageRequestId);
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
          if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
          if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
          // Rev-guarded snapshot (fork): a late/stale snapshot must never roll
          // the live queue back — applyQueuedSnapshot only moves rev forward.
          if (liveState.queuedMessages !== undefined) applyQueuedSnapshot(liveState.queuedMessages);
          if (liveState.tasks !== undefined) setSessionTasks(normalizeTasks(liveState.tasks));
          if (liveState.pendingRecovery !== undefined) setPendingRecovery(liveState.pendingRecovery ?? []);
          if (liveState.queueTrash !== undefined) setQueueTrash(liveState.queueTrash ?? []);
          if (liveState.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(liveState.autoCompactionEnabled ?? true);
        } else if (!agentState.running) {
          setQueuedMessages({ steering: [], followUp: [] });
          // Dormancy fallback: the state route brings back the latest task snapshot via the extension's sessionDormantState service (empty if none)
          setSessionTasks(normalizeTasks(agentState.state?.tasks));
          setQueueTrash([]);
        }
        return agentState;
      } catch (e) {
        console.error("Failed to load agent state:", e);
        return null;
      }
    } catch (e) {
      setError(String(e));
      return "error";
    } finally {
      if (showLoading && !messagesLoaded) setLoading(false);
    }
    })();
    if (!bypass) loadFlightsRef.current.set(flightKey, flight);
    flight.finally(() => {
      if (loadFlightsRef.current.get(flightKey) === flight) loadFlightsRef.current.delete(flightKey);
    });
    return await flight;
  }, [applyLiveUsage, applyQueuedSnapshot, setToolPresetState, syncLiveModel]);

  /** User-initiated refresh of the current session (2026-09-15): re-fetch the full messages + state (includeState)
   *  from the server. For scenarios where "a stopped session may have advanced externally" (the zcode desktop/CLI
   *  continued the same session outside this web UI, or the handle was reused and its in-memory history is stale) —
   *  one refresh realigns with the source; no session rebuild needed.
   *  fresh=1 makes the server reclaim this instance's idle wrapper and re-read from disk; the old SSE stream is
   *  bound to the old wrapper and must be dropped and reconnected, otherwise the new wrapper's events are never
   *  received (sending a message shows no streaming). */
  const reloadCurrentSession = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    eventConnectionRef.current?.close();
    try {
      await loadSession(sid, false, true, { fresh: true });
    } finally {
      // Silently skipped when shouldMaintain is false (starvation yield / not the current session), matching the existing maintenance semantics
      eventConnectionRef.current?.maintain(sid);
    }
  }, [loadSession]);

  const loadContext = useCallback(async (sid: string, leafId: string | null, before?: string | null, options?: { tail?: number; signal?: AbortSignal }) => {
    try {
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      if (leafId) params.set("leafId", leafId);
      // Page upward: ask the server for the `tail` ancestors preceding `before`,
      // then prepend them. Omitting `before` fetches the most-recent `tail`.
      if (before) params.set("before", before);
      if (options?.tail) params.set("tail", String(options.tail));
      const url = apiUrl(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`);
      const res = await fetch(url, { signal: options?.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { context: SessionData["context"] };
      if (sessionIdRef.current !== sid || options?.signal?.aborted || !sessionHookMountedRef.current) return;
      setHistoryCursor(d.context.oldestEntryId);
      setHasEarlierMessages(d.context.hasMore);
      setEarlierTurnCount(d.context.turnsBefore ?? 0);
      setData((prev) => {
        if (!prev || prev.sessionId !== sid) return prev;
        const context = before ? {
          ...prev.context,
          messages: [...d.context.messages, ...prev.context.messages],
          entryIds: [...d.context.entryIds, ...prev.context.entryIds],
          oldestEntryId: d.context.oldestEntryId,
          hasMore: d.context.hasMore,
          turnsBefore: d.context.turnsBefore,
        } : d.context;
        return { ...prev, context };
      });
      if (before) {
        // Older page: prepend so scroll position stays anchored.
        setMessages((prev) => [...d.context.messages, ...prev]);
        setEntryIds((prev) => [...d.context.entryIds, ...prev]);
      } else {
        setMessages(d.context.messages);
        setEntryIds(d.context.entryIds ?? []);
      }
      return d.context;
    } catch (e) {
      if (!options?.signal?.aborted) console.error("Failed to load context:", e);
    }
  }, []);

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (!tools || !sessionHookMountedRef.current || sessionIdRef.current !== sid) return null;
      const { getPresetFromTools } = await import("@/lib/tool-presets");
      setToolPresetState(sessionToolsPinnedRef.current ? getPresetFromTools(tools) : CONFIGURED_TOOL_PRESET);
      onSystemToolsChange?.(tools);
      return tools;
    } catch (e) {
      console.error("Failed to load tools:", e);
      return null;
    }
  }, [onSystemToolsChange, setToolPresetState]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)") => {
    const sid = sessionIdRef.current;
    if (!isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    const provisionalDraftKey = newSessionDraftKey;
    if (!provisionalDraftKey) return;
    if (provisionalDraftKey !== sid) {
      draftKeyAliasesRef.current.set(provisionalDraftKey, sid);
      // Single write entry: invalidate the provisional draft, and new input during the promote window (before the
      // React key prop flips) is redirected by the draft keeper into the sid slot — the "sent message left behind"
      // race is eliminated inside the state machine.
      applyDraftIntent({ type: "sessionCreated", provisionalKey: provisionalDraftKey, sessionId: sid });
    }
    onSessionCreated?.({
      id: sid,
      path: "",
      // Target cwd after the preparer pipeline rewrote it (e.g. the worktree path chosen by the branch/worktree
      // picker); falls back to the original newSessionCwd when untouched. AppShell's handleSessionCreated switches
      // the active workspace accordingly.
      cwd: newSessionResolvedCwdRef.current ?? newSessionCwd,
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
      // New-session preparer pipeline (branch/worktree picker and other extensions): awaited in order before the
      // POST — {cwd} rewrites the target directory in a chain; {abort} cancels creation (throw → handleSend catch →
      // the existing notice channel; restoreSubmission keeps the draft, which also covers missing-directory copy
      // such as "worktree deleted mid-flight"). The resolved cwd is stored in the ref before the POST so
      // promoteNewSession can report the real creation location on success.
      const prepared = await runNewSessionPreparers(newSessionPreparersRef.current, newSessionCwd);
      newSessionResolvedCwdRef.current = prepared.cwd;
      // Only send explicit user overrides. The server resolves the current
      // enabledModels scope atomically with AgentSession construction.
      const selectedModel = newSessionModelOverrideRef.current;
      const selectedThinkingLevel = thinkingLevelOverrideRef.current;
      if (selectedModel) setPendingModel(selectedModel);
      // Undefined means the user never overrode the loadout: omit the field entirely
      // so pi resolves settings.json defaultTools instead of being pinned to ours (#700).
      const toolNames = getToolNamesForPreset(toolPreset);
      sessionToolsPinnedRef.current = toolNames !== undefined;
      const backend = newSessionBackendRef.current;
      const res = await fetch(apiUrl("/api/agent/new"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: prepared.cwd,
          type: "ensure_session",
          ...(toolNames !== undefined ? { toolNames } : {}),
          ...(backend ? { providerType: backend } : {}),
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(selectedThinkingLevel
            ? { thinkingLevel: selectedThinkingLevel }
            : {}),
        }),
      });
      if (!res.ok) {
        // The server's reason (a project folder that no longer exists, a model Chat only
        // cannot load) beats a bare status (#1061).
        const body = await res.json().catch(() => null) as { error?: unknown } | null;
        const raw = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
        // Directory missing (session directory moved/deleted, external-session placeholder path, etc.): give an actionable hint instead of a bare HTTP code
        const missing = /Directory does not exist:\s*(.+)$/i.exec(raw);
        throw new Error(missing
          ? t("session.cwdMissing", { path: missing[1].trim() })
          : raw);
      }
      const result = await res.json() as {
        sessionId: string;
        model?: SelectedModel | null;
        thinkingLevel?: ThinkingLevelOption;
      };
      const realId = result.sessionId;
      sessionIdRef.current = realId;
      // New session = new handle = new rev axis: reset the cursor (otherwise the previous session's large rev would block the new session's queue updates)
      queueRevRef.current = 0;
      if (result.model && newSessionModelOverrideRef.current === selectedModel) {
        setPendingModel(result.model);
        if (!selectedModel) setNewSessionDefaultModel(result.model);
      }
      if (
        result.thinkingLevel
        && thinkingLevelOverrideRef.current === selectedThinkingLevel
      ) {
        setLiveThinkingLevel(asConcreteThinkingLevel(result.thinkingLevel));
        if (!selectedThinkingLevel) {
          setNewSessionDefaultThinkingLevel(asConcreteThinkingLevel(result.thinkingLevel));
        }
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

  // Opening the System or Tools panel may initialize an otherwise dormant
  // session. This is deliberately a non-prompt command: it creates no message
  // or model run, but lets users inspect the exact prompt before sending one.
  const loadSystemInfo = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) return;

    const [state] = await Promise.all([
      sendAgentCommand<AgentStateResponse>(sid, { type: "get_state" }),
      loadTools(sid),
    ]);
    if (!sessionHookMountedRef.current || sessionIdRef.current !== sid) return;
    syncLiveModel(state);
    setSystemPrompt(state.systemPrompt ?? "");
  }, [ensureNewSession, loadTools, syncLiveModel]);

  const replaceSlashCommands = useCallback((commands: SlashCommandInfo[]) => {
    slashCommandsRef.current = commands;
    setSlashCommands(commands);
  }, []);

  // The session's tools changed (set_tools may have rebuilt it as Chat only): forget the
  // list and the request under way, so the next reader asks the session as it is now.
  const clearSlashCommands = useCallback(() => {
    slashCommandsGenerationRef.current += 1;
    slashCommandsLoadRef.current = null;
    replaceSlashCommands([]);
  }, [replaceSlashCommands]);

  // Null when get_commands failed, which an empty list (a Chat-only session's) must not be mistaken for.
  const requestSlashCommands = useCallback((): Promise<SlashCommandInfo[] | null> => {
    const generation = ++slashCommandsGenerationRef.current;
    const current = () => slashCommandsGenerationRef.current === generation;
    const load = (async () => {
      const sid = sessionIdRef.current ?? await ensureNewSession();
      if (!sid) {
        if (current()) replaceSlashCommands([]);
        return [] as SlashCommandInfo[];
      }
      setSlashCommandsLoading(true);
      try {
        const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
        const commands = data?.commands ?? [];
        if (current()) replaceSlashCommands(commands);
        return commands;
      } catch (e) {
        console.error("Failed to load slash commands:", e);
        if (current()) replaceSlashCommands([]);
        return null;
      } finally {
        // A newer request under way keeps the palette's "Loading" until it answers.
        if (current() || !slashCommandsLoadRef.current) setSlashCommandsLoading(false);
      }
    })();
    slashCommandsLoadRef.current = load;
    const settle = () => {
      if (slashCommandsLoadRef.current === load) slashCommandsLoadRef.current = null;
    };
    load.then(settle, settle);
    return load;
  }, [ensureNewSession, replaceSlashCommands]);

  const loadSlashCommands = useCallback(async () => (await requestSlashCommands()) ?? [], [requestSlashCommands]);

  // The list a bare /mcp is decided by: the request under way (the palette starts
  // one as "/mcp" is typed, often still unanswered at Enter), else the list already
  // loaded, else a new request. Null when it cannot be read: guessing would either
  // swallow another extension's /mcp or send one Settings should have taken.
  const slashCommandsForMcp = useCallback(async (): Promise<SlashCommandInfo[] | null> => {
    const pending = slashCommandsLoadRef.current;
    const known = slashCommandsRef.current;
    if (!pending && known.length > 0) return known;
    const loaded = await (pending ?? requestSlashCommands()).catch(() => null);
    return loaded ?? (known.length > 0 ? known : null);
  }, [requestSlashCommands]);

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

  // Connection-pool starvation yield (anti-deadlock, lib/conn-guard): in a starved scenario long-lived connections
  // exhaust the browser's same-host sockets and even chat fetches cannot go out — so proactively drop this SSE to
  // yield (the starved gate in shouldMaintain also blocks reconnection), and maintain() rebuilds it after recovery.
  // Uses the window "piwe-conn-starve" broadcast protocol (same channel as the running broker / bridge client).
  // Event-driven, zero polling.
  useEffect(() => {
    const handler = (ev: Event) => {
      const starved = Boolean((ev as CustomEvent<{ starved?: boolean }>).detail?.starved);
      connStarvedRef.current = starved;
      if (starved) {
        eventConnectionRef.current?.close();
      } else {
        const sid = sessionIdRef.current;
        if (sid) eventConnectionRef.current?.maintain(sid);
      }
    };
    window.addEventListener("piwe-conn-starve", handler);
    return () => window.removeEventListener("piwe-conn-starve", handler);
  }, []);

  // A different browser can start this session after it was opened here.
  // The sidebar's lightweight running-state poll gives us a cheap signal to
  // attach to the existing SSE stream without adding another synchronization
  // protocol to the chat.
  // Keep the selected session warm even while its agent is idle. The SSE lease
  // is renewed separately below and expires if the browser disappears.
  useEffect(() => {
    const sid = session?.id;
    if (!sid) return;
    // React Strict Mode re-runs every effect after a simulated unmount, in
    // declaration order. The mount-only effect below flips this ref to false
    // in its cleanup and only restores it when it re-runs *after* this one,
    // so without re-asserting it here shouldMaintain() refuses the connection
    // and the selected session never opens its event stream.
    sessionHookMountedRef.current = true;
    eventStreamReleasedRef.current = false;
    maintainEventsConnected(sid);
    return () => {
      if (sessionIdRef.current === sid) eventConnectionRef.current?.close();
    };
  }, [maintainEventsConnected, session?.id]);


  // One lease request (holdSessionLivenessLease()): it keeps the session alive
  // and reports what is under way there (SessionLeaseReply). A reply that does
  // not come within SESSION_LEASE_TIMEOUT_MS, or no network, is "unanswered";
  // an error reply is null.
  const requestLease = useCallback((sid: string): Promise<SessionLeaseOutcome> => {
    const pending = leaseRequestRef.current;
    if (pending?.sid === sid) return pending.promise;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SESSION_LEASE_TIMEOUT_MS);
    const request: { sid: string; promise: Promise<SessionLeaseOutcome> } = { sid, promise: Promise.resolve(null) };
    request.promise = (async (): Promise<SessionLeaseOutcome> => {
      try {
        const response = await fetch(sessionLeaseUrl(sid), { method: "POST", cache: "no-store", signal: controller.signal });
        return response.ok ? await response.json() as SessionLeaseReply : null;
      } catch (error) {
        // Timed out (queued behind open streams) or no network. A body that is no
        // JSON counts as an error reply.
        return controller.signal.aborted || error instanceof TypeError ? "unanswered" : null;
      } finally {
        clearTimeout(timeout);
        if (leaseRequestRef.current === request) leaseRequestRef.current = null;
      }
    })();
    leaseRequestRef.current = request;
    return request.promise;
  }, []);

  // Fork: the 30s lease renewal loop, now driving upstream's single-flight
  // requestLease() (one shared in-flight request for the interval tick, the
  // visibility bounce and the hidden-page release check). The endpoint renews
  // the per-page holder lease and reports what is under way; a keep-alive miss
  // lets the server reap the wrapper and the next reconcile reconnects.
  useEffect(() => {
    const sid = session?.id;
    if (!sid) return;

    const interval = setInterval(() => void requestLease(sid), SESSION_LEASE_RENEW_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void requestLease(sid);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [requestLease, session?.id]);

  // A page hidden for HIDDEN_PAGE_GRACE_MS lets go of the selected session's
  // stream while nothing needs it (#1283): each one holds a browser connection,
  // and over HTTP/1.1 a few background tabs exhaust the six per origin, so every
  // other request (Settings, message sync) queues in the browser until a tab
  // closes. A run, a `!` command, a compaction or an open extension dialog in the
  // page keeps it without asking. Otherwise the grace ends with a lease request,
  // and the stream closes only if its reply shows nothing under way
  // (canReleaseHiddenEventStream(): a run another tab started, an extension
  // dialog, a subagent whose end starts a turn here); the check repeats each
  // grace while hidden. A run that settles while hidden starts the grace again,
  // which also covers extension follow-ups right after prompt_done.
  const eventStreamIdle = !agentRunning && !bashRunning && !isCompacting
    && extensionDialogs.length === 0 && extensionCustomUis.length === 0;
  useEffect(() => {
    const sid = session?.id;
    if (!sid || !eventStreamIdle) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const releasable = () => (
      !disposed
      && document.visibilityState === "hidden"
      && !eventStreamReleasedRef.current
      && sessionIdRef.current === sid
      && sessionPropIdRef.current === sid
      && !agentRunningRef.current
      && !bashRunningRef.current
    );
    const check = async () => {
      timer = null;
      if (!releasable()) return;
      const reply = await requestLease(sid);
      if (!releasable()) return;
      if (!canReleaseHiddenEventStream(reply)) {
        arm();
        return;
      }
      eventStreamReleasedRef.current = true;
      closeEvents();
    };
    const arm = () => {
      timer ??= setTimeout(() => void check(), HIDDEN_PAGE_GRACE_MS);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        arm();
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    if (document.visibilityState === "hidden") arm();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [closeEvents, eventStreamIdle, eventStreamReattachCount, requestLease, session?.id]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    setExtensionDialogs((queue) => removeExtensionUiRequest(queue, request.id));
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
        setExtensionDialogs((queue) => enqueueExtensionUiRequest(queue, request));
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
        setExtensionWidgets((prev) => updateExtensionWidgets(
          prev,
          request.widgetKey,
          request.widgetLines,
          request.widgetPlacement,
        ));
        break;
      case "setTitle":
        if (request.title) document.title = request.title;
        break;
      case "set_editor_text":
        opts.chatInputRef?.current?.insertText(request.text);
        break;
      case "custom":
        setExtensionCustomUis((queue) => request.closed
          ? removeExtensionUiRequest(queue, request.id)
          : upsertExtensionUiRequest(queue, request));
        break;
    }
  }, [addNotice, onAttentionNeeded, opts.chatInputRef]);

  const settleUiStage = useCallback(() => {
    const wasRunning = agentRunningRef.current;
    agentRunningRef.current = false;
    // On full settlement (agent_settled / prompt_done / session_backend_dead / reconnect idle correction), also
    // clear the "stopping" wait state — even if a queued follow-up immediately re-sets running, it should no
    // longer show as stopping.
    setAborting(false);
    // Clear the elapsed-time origin on settlement: prevents the next send's ??= from reusing the previous run's
    // origin (and covers settlement paths without agent_settled) — the next run restarts from the message
    // timestamp / send moment.
    runStartedAtRef.current = null;
    setAgentRunning(false);
    setAgentPhase(null);
    setRetryInfo(null);
    setActiveToolResults(new Map());
    dispatchStream({ type: "end" });
    return wasRunning;
  }, [dispatchStream]);

  const notifyPromptStage = useCallback((runId: number, aborted = false) => {
    if (notifiedPromptRunIdRef.current === runId) return false;
    notifiedPromptRunIdRef.current = runId;
    onAgentEnd?.({ aborted });
    return true;
  }, [onAgentEnd]);

  const scheduleEventStreamClose = useCallback((sid: string) => {
    if (sessionPropIdRef.current === sid) {
      cancelEventStreamGrace();
      return;
    }
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
        const res = await fetch(agentStatusUrl(sid));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;

        const state = data.state;
        syncLiveModel(state);
        const promptActive = Boolean(data.running && state && (state.isStreaming || state.isPromptRunning));
        if (promptActive) {
          eventStreamGraceActiveRef.current = false;
          eventStreamGraceTimerRef.current = null;
          sdkAgentActiveRef.current = Boolean(state?.isStreaming);
          rpcPromptPendingRef.current = Boolean(state?.isPromptRunning);
          agentRunningRef.current = true;
          adoptRunStartedAt(state?.runStartedAt);
          setAgentRunning(true);
          setAgentPhase(state?.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
          return;
        }

        if (data.running && state?.isCompacting) {
          setIsCompacting(true);
          // Compaction is busy too: keep/restore the running display during the guard (a manual compact aborted the run first and agent_settled already settled it)
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase({ kind: "compacting" });
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
  }, [adoptRunStartedAt, cancelEventStreamGrace, closeEvents, syncLiveModel]);

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
        onAgentEnd?.({ aborted: false });
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
        const res = await fetch(agentStatusUrl(sid));
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          const state = data.state;
          syncLiveModel(state);
          if (!data.running || !state || !stateIsActive(state)) {
            await finishPromptWithoutStream(sid, runId);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [finishPromptWithoutStream, syncLiveModel]);

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
        const res = await fetch(agentStatusUrl(sid));
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        syncLiveModel(data.state);
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setAborting(false);
        setPendingBash(null);
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession, syncLiveModel]);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same settlement path used by non-streaming prompts.
  const reconcileAgentState = useCallback(async (sid: string) => {
    if (!agentRunningRef.current || sessionIdRef.current !== sid) return;
    const runId = promptRunIdRef.current;
    const usageRequestId = ++contextUsageRequestIdRef.current;
    try {
      const res = await fetch(agentStatusUrl(sid));
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (sessionIdRef.current !== sid || promptRunIdRef.current !== runId) return;
      const state = data.state;
      applyLiveUsage(state, sid, runId, usageRequestId);
      syncLiveModel(state);
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      setIsCompacting(state?.isCompacting ?? false);
      applyQueuedSnapshot(state?.queuedMessages);
      setPendingRecovery(state?.pendingRecovery ?? []);
      setQueueTrash(state?.queueTrash ?? []);
      setAutoCompactionEnabled(state?.autoCompactionEnabled ?? true);
      // Fork: authoritative busy criteria — isRunning covers busy states beyond
      // isStreaming (compaction aborts, queued dispatch); stateIsActive falls
      // back to the raw flags when older servers lack the field.
      const busy = data.running && !!state && stateIsActive(state);
      if (busy) {
        sdkAgentActiveRef.current = Boolean(state.isStreaming);
        rpcPromptPendingRef.current = Boolean(state.isPromptRunning);
        return;
      }
      if (!agentRunningRef.current) return;
      if (state) {
        if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
        if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
        // The poll leaves the prompt out: read the one the run ended with once, as agent_end does.
        fetch(`/api/agent/${encodeURIComponent(sid)}`)
          .then((r) => r.ok ? r.json() : null)
          .then((d: { state?: AgentStateResponse } | null) => {
            if (!d || !sessionHookMountedRef.current || sessionIdRef.current !== sid) return;
            if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
          })
          .catch(() => {});
      }
      await finishPromptWithoutStream(sid, runId);
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [applyLiveUsage, applyQueuedSnapshot, finishPromptWithoutStream, syncLiveModel]);

  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      // Skip ticks in background tabs: SSE is the primary channel and returning to the foreground / network
      // recovery already triggers immediate reconciliation; periodic polling of hidden pages is pure waste
      // (each response carries the full state).
      if (document.visibilityState !== "visible") return;
      if (!sid) return;
      // Smart throttling: skip this round while the SSE channel is active (business events + 30s heartbeats keep
      // arriving, so the activity stamp stays fresh) — events ride the primary channel and reconciliation only
      // backstops dropped events, so 15s polling is unnecessary. Only silence beyond the max interval (consecutive
      // heartbeat loss / half-open dead link — a reliable verdict) or a connection error (onTrouble zeroed the
      // stamp + immediate reconcile) actually hits the server; a zero activity stamp (connection never established /
      // first tick) keeps the baseline frequency.
      if (Date.now() - lastSseActivityRef.current < SSE_ACTIVITY_IDLE_RECONCILE_MS) return;
      lastReconcileAtRef.current = Date.now();
      void reconcileAgentState(sid);
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

  // The connection layer's onTrouble needs the latest reconcileAgentState (its closure is created once during render).
  reconcileNowRef.current = () => {
    const sid = sessionIdRef.current;
    if (sid) void reconcileAgentState(sid);
  };

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  useEffect(() => {
    isCompactingRef.current = isCompacting;
  }, [isCompacting]);

  // Alias/placeholder id → canonical id migration (single write entry): update sessionIdRef + dispatch
  // canonicalized (AppShell migrates the selected id/URL in place; the sessions dock immediately drops the old
  // id's draft row). Consumed via three paths: session_backend_ready (one-shot rebind event), the connected
  // frame's canonicalSessionId (streams that connect/reconnect after missing the rebind — the norm across SSE
  // maintenance gaps / post-restart reconnects), and the agent_end state poll (backstop when both earlier paths
  // are missed). The server still serves the old id via dual registration, so migration never interrupts the stream.
  const canonicalizeSessionId = useCallback((canonicalId: unknown): void => {
    if (typeof canonicalId !== "string" || !canonicalId) return;
    const currentSid = sessionIdRef.current;
    if (!currentSid || canonicalId === currentSid) return;
    sessionIdRef.current = canonicalId;
    try { onSessionIdCanonicalizedRef.current?.(currentSid, canonicalId); } catch { /* callback errors must not block the event stream */ }
  }, []);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    // Subagent lifecycle signal: broadcast to the extension client (Fleet panel refresh + sidebar tree refresh).
    // Sources: subagent tool execution (delegation start) + upstream subagent-* custom messages (background start/finish notices).
    try {
      const t = event.type;
      if (t === "tool_execution_start" && (event as { toolName?: string }).toolName === "subagent") {
        window.dispatchEvent(new CustomEvent("aiti-subagents:activity", { detail: { phase: "spawn" } }));
      } else if (t === "message_end") {
        const m = (event as { message?: { role?: string; customType?: string } }).message;
        const ct = m?.customType ?? "";
        if (m?.role === "custom" && typeof ct === "string" && ct.startsWith("subagent")) {
          window.dispatchEvent(new CustomEvent("aiti-subagents:activity", { detail: { phase: ct } }));
        }
      }
    } catch { /* broadcast failure must not affect the main flow */ }
    switch (event.type) {
      case "connected": {
        dispatchStream({ type: "end" });
        // The server resolved the alias/placeholder id to the rebound handle (canonicalSessionId ≠ requested id):
        // migrate immediately — later events on this stream are delivered as usual (same server handle), and the
        // next maintain uses the canonical id.
        canonicalizeSessionId((event as { canonicalSessionId?: unknown }).canonicalSessionId);
        if (Array.isArray(event.pendingExtensionUiIds)) {
          // The server replays what it still holds right after this event.
          const pending = new Set(event.pendingExtensionUiIds as string[]);
          setExtensionDialogs((queue) => retainExtensionUiRequests(queue, pending));
          setExtensionCustomUis((queue) => retainExtensionUiRequests(queue, pending));
        }
        // isRunning = the server's authoritative busy flag (same criteria as the sidebar running set): covers busy
        // states such as manual compaction where isStreaming=false — trusting isStreaming alone would keep showing
        // idle after reconnects / fresh page opens.
        const streamActive = event.isStreaming === true;
        const runActive = streamActive || (event as { isRunning?: boolean }).isRunning === true;
        if (runActive) {
          cancelEventStreamGrace();
          sdkAgentActiveRef.current = streamActive;
          agentRunningRef.current = true;
          adoptRunStartedAt();
          setAgentRunning(true);
          setAgentPhase(streamActive ? { kind: "waiting_model" } : { kind: "compacting" });
        } else if (
          event.isStreaming === false
          && (event as { isRunning?: boolean }).isRunning === false
          && agentRunningRef.current
          // Idle-correction guard (2026-09-14): while a prompt has been sent but not yet acknowledged / an
          // optimistic bubble is unconsumed, the server's isRunning=false is the normal "backend has not accepted
          // the prompt yet" window (pi forks a child process with a slow cold start; for spawn sessions the
          // connected frame from ensureEventsConnected arrives before the prompt). Settling here would wrongly
          // clear agentRunning → "running" not shown long after send; the optimistic bubble would also be appended
          // twice at message_end once optimisticUserMessageKeyRef is cleared.
          // Guard: a pending prompt / unconsumed optimistic bubble locally → skip the correction and let
          // agent_start take over naturally; reconnects of genuinely idle sessions still correct normally.
          && !rpcPromptPendingRef.current
          && !optimisticUserMessageKeyRef.current
        ) {
          // Server-authoritative idle while the local UI still shows "running": correct a lost agent_settled /
          // compaction_end on (re)connect (the settlement frame was missed during an SSE disconnect window → the
          // running state would freeze until the next refresh).
          sdkAgentActiveRef.current = false;
          rpcPromptPendingRef.current = false;
          optimisticUserMessageKeyRef.current = null;
          setIsCompacting(false);
          bashRunningRef.current = false;
          setBashRunning(false);
          settleUiStage();
        }
        // Resync after frames lost in a disconnect window: connected means (re)connected, and queue_update frames
        // may have been lost meanwhile (extension hot reload / nginx jitter / wake from sleep) — unconditionally
        // fetch one queue snapshot; the rev guard guarantees in-flight late frames cannot roll back this result
        // (local pi sessions have no rev, equivalent to the old behavior).
        {
          const connectedSid = sessionIdRef.current;
          if (connectedSid) {
            void fetch(apiUrl(`/api/agent/${encodeURIComponent(connectedSid)}?light=1`))
              .then((r) => (r.ok ? r.json() : null))
              .then((d: { state?: AgentStateResponse } | null) => {
                if (d?.state && sessionIdRef.current === connectedSid) applyQueuedSnapshot(d.state.queuedMessages);
              })
              .catch(() => { /* reconnect snapshot failure is non-blocking: the 15s reconcile backstops */ });
          }
        }
        // Opening the stream is what resumes an idle-reaped session, so the
        // mount's state read may have found no runtime and no usage to show.
        if (sessionIdRef.current) void refreshContextUsage(sessionIdRef.current);
        break;
      }
      case "session_backend_dead": {
        // The spawn/attach backend child process exited (crash / killed / explicit dispose). The frontend must
        // settle agentRunning — otherwise "running" hangs forever (observed: after a pi-forked child exited, the UI
        // kept showing running while the server had long gone idle). loadSession refreshes the session's true state.
        const wasRunning = settleUiStage();
        const sid = sessionIdRef.current;
        if (sid) void loadSession(sid);
        if (wasRunning) onAgentEnd?.({ aborted: true });
        break;
      }
      case "session_backend_ready": {
        // External backend lazy-init rebinds the real composite id (zcode:new-* → zcode:sess_*, already dual-
        // registered server-side via putHandleAt): migrate the selected id + URL in real time on rebind (the
        // in-place migration does not bump sessionKey, so an in-flight chat/SSE stays up), and dispatch the
        // canonicalized event so the sessions dock immediately drops the placeholder id's draft row — otherwise the
        // duplicate row for the same session only converges after the pendingDrafts 10min TTL or the next
        // loadSession canonicalization.
        canonicalizeSessionId(event.id);
        break;
      }
      case "agent_start":
        cancelEventStreamGrace();
        sdkAgentActiveRef.current = true;
        agentRunningRef.current = true;
        // Adopt the earliest origin for this run — an SSE reconnect replays the buffered agent_start (mandatory
        // after a new session's rebind), and an unconditional reset would zero the elapsed timer mid-run; settled
        // already set it to null, so the next run naturally starts fresh.
        adoptRunStartedAt();
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        // A retry's wait is over once its run starts, as pi's TUI shows it: the
        // successful auto_retry_end comes only with the retry's first complete
        // reply, which can stream for minutes.
        setRetryInfo(null);
        dispatchStream({ type: "start" });
        break;
      case "model_select": {
        // External backend model awareness: when the handle detects a model change (CLI switch / fallback / init
        // report) it broadcasts pi's native ModelSelectEvent shape
        // {model:{id,provider}, previousModel?, source} — echoed immediately, not waiting for the post-agent_end
        // loadSession. When it matches a pending next-turn switch target, the "applies next turn" hint is cleared too.
        const ms = (event as { model?: { id?: unknown; provider?: unknown } }).model;
        if (
          ms && typeof ms.id === "string" && ms.id && typeof ms.provider === "string" && ms.provider
          && sessionIdRef.current
        ) {
          setCurrentModelOverride({ provider: ms.provider, modelId: ms.id });
          setModelSwitchPending((pending) =>
            pending && pending.provider === ms.provider && pending.modelId === ms.id ? null : pending);
        }
        break;
      }
      case "agent_end":
        // Clear "stopping" as soon as the current turn ends (naturally or via user stop) — do not wait for the
        // agent to be fully idle. After an abort, queued follow-ups immediately send agent_start (agentRunning
        // re-set to true); waiting for sessionBusy to go false would keep "stopping" stuck until the queue drains
        // (root cause of that bug).
        setAborting(false);
        // One logical prompt can emit multiple agent_end events before retrying,
        // compacting, or continuing messages queued by extension handlers.
        // Keep the stream open until prompt_done/agent_settled and the idle grace.
        if (!agentRunningRef.current) break;
        setAgentPhase(null);
        setRetryInfo(null);
        dispatchStream({ type: "end" });
        if (sessionIdRef.current) {
          const sid = sessionIdRef.current;
          const runId = promptRunIdRef.current;
          const usageRequestId = ++contextUsageRequestIdRef.current;
          loadSession(sid);
          fetch(apiUrl(`/api/agent/${encodeURIComponent(sid)}`))
            .then((r) => r.ok ? r.json() : null)
            .then((d: { state?: AgentStateResponse } | null) => {
              if (!d || !sessionHookMountedRef.current || sessionIdRef.current !== sid || promptRunIdRef.current !== runId) return;
              // Backstop alias/placeholder id migration: state.sessionId is the backend handle's canonical id —
              // tabs that missed both the connected frame (canonicalSessionId) and the rebind event converge here.
              canonicalizeSessionId(d.state?.sessionId);
              // External backends such as spawn have no prompt_done event: after agent_end, align rpcPromptPending
              // with the server-authoritative isPromptRunning so a stale true doesn't block the immediately
              // following agent_settled settlement (root cause of pi fork "reply finished but still shows running",
              // 2026-09-14).
              if (d.state?.isPromptRunning !== undefined) {
                rpcPromptPendingRef.current = Boolean(d.state.isPromptRunning);
              }
              syncLiveModel(d.state);
              applyLiveUsage(d.state, sid, runId, usageRequestId);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
              if (d.state?.extensionStatuses !== undefined) setExtensionStatuses(d.state.extensionStatuses ?? []);
              if (d.state?.extensionWidgets !== undefined) setExtensionWidgets(d.state.extensionWidgets ?? []);
              // Aborted turns can leave messages queued in pi (delivered with the
              // next turn); dead wrapper (no state) means the queue is gone.
              applyQueuedSnapshot(d.state?.queuedMessages);
              setPendingRecovery(d.state?.pendingRecovery ?? []);
              setQueueTrash(d.state?.queueTrash ?? []);
            })
            .catch(() => {});
        }
        break;
      case "agent_settled": {
        const agentWasActive = sdkAgentActiveRef.current;
        sdkAgentActiveRef.current = false;
        runStartedAtRef.current = null;
        // agentRunningRef also counts as valid running evidence: external backends (zcode etc.) emit agent_start
        // upon acceptance, the page's event stream attaches after that frame, and on connected replay isStreaming
        // is still false → sdkAgentActive stays false, but the send path already optimistically set agentRunningRef
        // — settled must still finish normally, otherwise the spinner hangs forever (observed 2026-09-10: zcode
        // stop/natural end both stuck on "waiting for model").
        if ((!agentWasActive && !agentRunningRef.current) || rpcPromptPendingRef.current) {
          // Guard backstop (2026-09-14): external backends such as spawn have no prompt_done event →
          // rpcPromptPending may be stuck at true, and agent_settled is a one-shot event — if the guard blocks it
          // and no later trigger arrives, the frontend never settles (observed with pi fork "reply finished but
          // still shows running"). Verify the server's authoritative isPromptRunning in the background: if idle,
          // clear the stale flag and run the settlement; if a prompt is genuinely still running (true multi-turn),
          // respect the guard.
          const settledSid = sessionIdRef.current;
          if (settledSid && rpcPromptPendingRef.current && agentRunningRef.current) {
            void fetch(apiUrl(`/api/agent/${encodeURIComponent(settledSid)}`))
              .then((r) => r.json())
              .then((d: { state?: AgentStateResponse }) => {
                if (d.state?.isPromptRunning) return;
                if (!rpcPromptPendingRef.current || !agentRunningRef.current) return;
                rpcPromptPendingRef.current = false;
                const wasRunning = settleUiStage();
                void loadSession(settledSid);
                if (wasRunning) onAgentEnd?.({ aborted: false });
              })
              .catch(() => {});
          }
          break;
        }

        const sid = sessionIdRef.current;
        // Backend session: fetch this run's usage
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
        if (wasRunning) onAgentEnd?.({ aborted: event.aborted === true });
        break;
      }
      case "prompt_done":
        {
          const runId = promptRunIdRef.current;
          const promptWasPending = rpcPromptPendingRef.current;
          rpcPromptPendingRef.current = false;
          optimisticUserMessageKeyRef.current = null;
          const firstNotification = notifyPromptStage(runId, event.aborted === true);
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
        // Transcript system messages (prompt and tool loadout) are filtered
        // server-side; keep them out of the chat should one arrive.
        if (isSystemMessageEvent(event)) break;
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
        // Step-follow triggering is handled uniformly by the useEffect [streamState] → scheduleFollowStep below
        // (passive effect, reads layout for free after paint; at most once per frame after delta-batch coalescing).
        // No rAF rect read here anymore: rAF runs before the render pipeline, and React's delta-batch commit may
        // not have landed in the DOM yet, so a stale layout gets read → step to an outdated position → jitter in
        // place (observed).
        break;
      }
      case "message_end": {
        // Same late-event guard: after reconcile finished this run,
        // loadSession already loaded this message from the session file —
        // appending it again would duplicate it.
        if (!agentRunningRef.current) break;
        if (isSystemMessageEvent(event)) break;
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
            // Idempotent backstop: optimisticKey may have been cleared early — by the connected-frame idle
            // correction on a new session's first send (the SSE connected frame arrives before the prompt, server
            // isRunning=false → the settlement branch clears the key; observed as the first message's user bubble
            // rendering twice) and by settlement paths such as finishPromptWithoutStream. The optimistic bubble is
            // still at the list tail then: if the last message is a user message with the same key, it is the
            // bubble for this delivery — skip outright, never append a second identical user message.
            if (last?.role === "user" && userMessageKey(last) === deliveredKey) {
              return prev;
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
          if (completed.role === "assistant") {
            const sid = sessionIdRef.current;
            if (sid) void refreshContextUsage(sid);
          }
        }
        dispatchStream({ type: "end" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        // A call a tool made itself (a codemode script's) belongs to its
        // parent's card; listed here it would show as a top-level running tool,
        // and a call cut off by its script can end after the parent did.
        if (isNestedToolExecutionEvent(event)) break;
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
        if (isNestedToolExecutionEvent(event)) break;
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        const partialResult = event.partialResult as Partial<ToolResultMessage> | undefined;
        const content = partialResult?.content;
        // Live output for shells; for codemode, the calls its script has made so far.
        if ((name === "bash" || name === "powershell" || name === CODEMODE_TOOL_NAME) && Array.isArray(content)) {
          setActiveToolResults((prev) => {
            const next = new Map(prev);
            next.set(id, {
              role: "toolResult",
              toolCallId: id,
              toolName: name,
              content,
              isError: partialResult?.isError,
              details: partialResult?.details,
            });
            return next;
          });
        }
        const progress = name === CODEMODE_TOOL_NAME
          ? getCodemodeProgress(event.partialResult)
          : getToolExecutionProgress(event.partialResult);
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
        if (isNestedToolExecutionEvent(event)) break;
        const id = event.toolCallId as string;
        onToolEnd?.(event.toolName as string);
        setActiveToolResults((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "queue_update": {
        // rev guard: late/duplicate frames (reconcile races, SSE replays) must not roll back applied state;
        // no rev (local pi session) keeps the original behavior.
        const qRev = typeof event.rev === "number" ? event.rev : null;
        if (qRev !== null) {
          if (qRev <= queueRevRef.current) break;
          queueRevRef.current = qRev;
        }
        setQueuedMessages((prev) => {
          const steering = [...((event.steering as string[] | undefined) ?? [])];
          const followUp = [...((event.followUp as string[] | undefined) ?? [])];
          return {
            steering,
            followUp,
            // pi reports text only: align the attachment flags against the local stale values (fresh values are written from the queue RPC response).
            steeringHasImages: alignQueueAttachmentFlags(prev.steeringHasImages, steering.length),
            followUpHasImages: alignQueueAttachmentFlags(prev.followUpHasImages, followUp.length),
          };
        });
        break;
      }
      case "task_update":
        setSessionTasks(normalizeTasks(event.todos));
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
        // Compaction is "busy" too: a manual compact aborts the current run first (agent_settled already settled
        // it); without setting this, the chat window shows idle during compaction (no Stop/running label),
        // inconsistent with the sidebar's running set.
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "compacting" });
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
        // Busy-state settlement: compaction ended and there is no active run / pending prompt (manual compaction
        // is outside the run loop and emits no agent_settled afterwards). Not settling would leave the running
        // state stuck forever; a queued follow-up's agent_start re-sets it if present. Not triggered on
        // auto_compaction_end while the run is still active.
        if (!sdkAgentActiveRef.current && !rpcPromptPendingRef.current) {
          settleUiStage();
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
          ...(Array.isArray(event.options) && event.options.length
            ? { options: (event.options as Array<{ optionId?: string; kind?: string; name?: string }>)
              .filter((o) => o && typeof o === "object") }
            : {}),
        });
        addNotice({ type: "error", message: t("session.toolAuth", { tool: typeof event.toolName === "string" ? event.toolName : "unknown" }) });
        break;
      case "permission_expired":
        setPermissionRequest(null);
        break;
      case "interaction_request":
        // Interaction primitives (zcode plan approval / question asking; one at a time, later arrivals overwrite the older pending one)
        setInteractionRequest({
          requestId: String(event.requestId ?? ""),
          kind: event.kind === "plan_approval" || event.kind === "ask_user" || event.kind === "permission" || event.kind === "open_url" || event.kind === "generic"
            ? event.kind
            : "generic",
          toolName: typeof event.toolName === "string" ? event.toolName : undefined,
          prompt: typeof event.prompt === "string" ? event.prompt : undefined,
          plan: typeof event.plan === "string" ? event.plan : undefined,
          url: typeof event.url === "string" ? event.url : undefined,
          launchUrl: typeof event.launchUrl === "string" ? event.launchUrl : undefined,
          questions: Array.isArray(event.questions)
            ? (event.questions as Array<Record<string, unknown>>).flatMap((q) => {
              if (!q || typeof q.question !== "string") return [];
              return [{
                header: typeof q.header === "string" ? q.header : undefined,
                question: q.question,
                multiSelect: q.multiSelect === true,
                options: Array.isArray(q.options)
                  ? (q.options as Array<Record<string, unknown>>).flatMap((o) =>
                    o && typeof o.label === "string" ? [{ label: o.label, description: typeof o.description === "string" ? o.description : undefined }] : [])
                  : [],
              }];
            })
            : undefined,
          input: event.input,
        });
        break;
      case "interaction_expired":
        // Invalidated in sync (the backend already resolved/cleaned it up, or the turn settled); clear the card if it is the one currently shown
        setInteractionRequest((current) => current?.requestId === String(event.requestId ?? "") ? null : current);
        break;
      case "provider_runtime_headers_request":
        // start-plan captcha bridge (zcode plan channel): one at a time, later arrivals overwrite
        setProviderHeadersRequest({
          requestId: String(event.requestId ?? ""),
          providerId: String(event.providerId ?? ""),
          ...(typeof event.modelRef === "string" ? { modelRef: event.modelRef } : {}),
          reason: event.reason === "captcha-retry" ? "captcha-retry" : "model-request",
          captchaConfig: (event.captchaConfig && typeof event.captchaConfig === "object"
            ? {
              sceneId: String((event.captchaConfig as Record<string, unknown>).sceneId ?? ""),
              prefix: String((event.captchaConfig as Record<string, unknown>).prefix ?? ""),
              region: String((event.captchaConfig as Record<string, unknown>).region ?? "cn"),
            }
            : { sceneId: "", prefix: "", region: "cn" }),
        });
        break;
      case "provider_headers_expired":
        setProviderHeadersRequest((current) => current?.requestId === String(event.requestId ?? "") ? null : current);
        break;
      case "extension_ui_closed":
        setExtensionDialogs((queue) => removeExtensionUiRequest(queue, event.id as string));
        break;
    }
  }, [addNotice, adoptRunStartedAt, applyLiveUsage, applyQueuedSnapshot, canonicalizeSessionId, cancelEventStreamGrace, dispatchStream, enqueueDelta, handleExtensionUiRequest, loadSession, notifyPromptStage, onAgentEnd, onToolEnd, refreshContextUsage, scheduleEventStreamClose, scrollToBottom, settleUiStage, syncLiveModel]);
  handleAgentEventRef.current = handleAgentEvent;

  const respondToInteraction = useCallback(async (requestId: string, answer: {
    action: "accept" | "decline";
    answers?: Record<string, string | string[]>;
    message?: string;
  }): Promise<boolean> => {
    if (interactionRespondingRef.current) return false;
    interactionRespondingRef.current = true;
    try {
      await sendAgentCommand(sessionIdRef.current ?? session?.id ?? "", {
        type: "respond_interaction",
        requestId,
        action: answer.action,
        ...(answer.answers ? { answers: answer.answers } : {}),
        ...(answer.message ? { message: answer.message } : {}),
      });
      // Clear the card locally right away (other clients sync via the interaction_expired broadcast frame)
      setInteractionRequest((current) => current?.requestId === requestId ? null : current);
      return true;
    } catch (e) {
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      interactionRespondingRef.current = false;
    }
  }, [sessionIdRef, session?.id]);

  /**
   * Answer the start-plan captcha request (respond_provider_headers command →
   * zcode handle.respondProviderHeaders): success carries captchaVerifyParam;
   * cancel/failure carries cancel/error. Clears the card locally right away
   * (other clients sync via the expired frame).
   */
  const respondToProviderHeaders = useCallback(async (requestId: string, answer: {
    captchaVerifyParam?: string;
    region?: string;
    error?: string;
    cancel?: boolean;
  }): Promise<boolean> => {
    try {
      await sendAgentCommand(sessionIdRef.current ?? session?.id ?? "", {
        type: "respond_provider_headers",
        requestId,
        ...(answer.captchaVerifyParam ? { captchaVerifyParam: answer.captchaVerifyParam } : {}),
        ...(answer.region ? { region: answer.region } : {}),
        ...(answer.error ? { error: answer.error } : {}),
        ...(answer.cancel ? { cancel: true } : {}),
      });
      setProviderHeadersRequest((current) => current?.requestId === requestId ? null : current);
      return true;
    } catch (e) {
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }, [sessionIdRef, session?.id, addNotice]);

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

  const respondToPermission = useCallback(async (behavior: "allow" | "deny", optionId?: string) => {
    const req = permissionRequest;
    if (!req || permissionRespondingRef.current) return;
    permissionRespondingRef.current = true;
    try {
      await sendAgentCommand(sessionIdRef.current ?? session?.id ?? "", {
        type: "permission_response",
        requestId: req.requestId,
        behavior,
        ...(optionId ? { optionId } : {}),
        message: behavior === "deny" ? "denied in web ui" : undefined,
      });
      setPermissionRequest(null);
    } catch (e) {
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      permissionRespondingRef.current = false;
    }
  }, [permissionRequest, session?.id]);

  /**
   * Unified view of session requests (routing data source for the
   * session-request-card slot; agent-capability UI de-coring plan §2.3): the
   * three protocol families are normalized into a single request (at most one
   * pending at any moment; "later arrivals overwrite" is already guaranteed by
   * each family's state). kind = the extension routing key
   * (interaction:<form> / permission / provider_headers).
   */
  const sessionRequest = useMemo<SessionRequestPayload | null>(() => {
    if (interactionRequest) {
      return {
        requestId: interactionRequest.requestId,
        kind: `interaction:${interactionRequest.kind}`,
        family: "interaction",
        capability: "respondInteraction",
        toolName: interactionRequest.toolName,
        prompt: interactionRequest.prompt,
        plan: interactionRequest.plan,
        url: interactionRequest.url,
        launchUrl: interactionRequest.launchUrl,
        questions: interactionRequest.questions,
        input: interactionRequest.input,
      };
    }
    if (permissionRequest) {
      return {
        requestId: permissionRequest.requestId,
        kind: "permission",
        family: "permission",
        capability: "respondPermission",
        toolName: permissionRequest.toolName,
        input: permissionRequest.input,
        options: permissionRequest.options,
      };
    }
    if (providerHeadersRequest) {
      return {
        requestId: providerHeadersRequest.requestId,
        kind: "provider_headers",
        family: "provider_headers",
        capability: "respondProviderHeaders",
        providerId: providerHeadersRequest.providerId,
        modelRef: providerHeadersRequest.modelRef,
        reason: providerHeadersRequest.reason,
        captchaConfig: providerHeadersRequest.captchaConfig,
      };
    }
    return null;
  }, [interactionRequest, permissionRequest, providerHeadersRequest]);

  /**
   * Unified answer dispatch (shared entry for the extension card and the
   * host's fallback card): routes to the matching protocol command based on
   * the currently pending family. A requestId that does not match the current
   * family (expired/racy) → idempotently returns false.
   */
  const respondToSessionRequest = useCallback(async (requestId: string, answer: SessionRequestAnswer): Promise<boolean> => {
    if (interactionRequest && interactionRequest.requestId === requestId) {
      return respondToInteraction(requestId, { action: answer.action, answers: answer.answers, message: answer.message });
    }
    if (providerHeadersRequest && providerHeadersRequest.requestId === requestId) {
      if (answer.error) return respondToProviderHeaders(requestId, { error: answer.error });
      if (answer.action === "decline") return respondToProviderHeaders(requestId, { cancel: true });
      return respondToProviderHeaders(requestId, answer.captchaVerifyParam
        ? { captchaVerifyParam: answer.captchaVerifyParam, ...(answer.region ? { region: answer.region } : {}) }
        : { cancel: true });
    }
    if (permissionRequest && permissionRequest.requestId === requestId) {
      await respondToPermission(answer.action === "accept" ? "allow" : "deny", answer.optionId);
      return true;
    }
    return false;
  }, [interactionRequest, providerHeadersRequest, permissionRequest, respondToInteraction, respondToProviderHeaders, respondToPermission]);

  const handleSend = useCallback(async (message: string, images?: AttachedImage[], files?: AttachedFile[]) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return;
    if (agentRunningRef.current || bashRunningRef.current) {
      restoreSubmission(message, images, composerDraftKey);
      return;
    }
    if (editEntryId) {
      // Navigate and prompt are two RPCs: a prompt rejected after navigating
      // keeps the new leaf until the server can apply both atomically.
      const entryId = editEntryId;
      setEdit(null);
      if (!(await handleNavigateRef.current?.(entryId))) {
        setEdit(entryId);
        restoreSubmission(message, images, composerDraftKey);
        return;
      }
    }
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    // ── /relay <target-id> <message> ────────────────────────────────────────
    // Agent-to-agent relay: deliver the message to the target live session,
    // collect the reply, and inject it into the current conversation.
    if (trimmedMessage.startsWith("/relay ")) {
      const rest = trimmedMessage.slice(7);
      const spaceIdx = rest.indexOf(" ");
      const targetId = spaceIdx > 0 ? rest.slice(0, spaceIdx) : "";
      const relayMsg = spaceIdx > 0 ? rest.slice(spaceIdx + 1).trim() : "";
      if (!targetId || !relayMsg) {
        addNotice({ type: "error", message: t("session.relayUsage") });
        return;
      }

      // Show the user message + relay status
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
    // ??=: steer/follow-up sends during a run must not reset this run's elapsed-time origin (on an idle new run the ref is null and a fresh origin starts as usual)
    runStartedAtRef.current ??= Date.now();
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
        // Switching sessions unmounts this composer and closes its stream. The
        // prompt still goes out, so the new session runs and gets its sidebar
        // row instead of losing the submitted text (#1146).
        if (sessionHookMountedRef.current) {
          await ensureEventsConnected(sid).catch((error) => {
            if (sessionHookMountedRef.current) throw error;
          });
        }
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
  }, [isNew, newSessionCwd, newSessionModel, session, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, addNotice, cancelEventStreamGrace, closeEvents, composerDraftKey, reconcileAgentState, restoreSubmission, dispatchStream, editEntryId, setEdit]);

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
      // After bash finishes (including an abort via abort_bash), clear the "stopping" wait state if it is active.
      setAborting(false);
    }
  }, [addNotice, composerDraftKey, ensureNewSession, loadSession, promoteNewSession, restoreSubmission, session]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    // Enter the "stopping" wait state on click (button turns into an hourglass + disabled, preventing double clicks).
    setAborting(true);
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
    // Note: forking a new session has nothing to do with ai-change disposal — it no longer goes through
    // runSessionForkGates. ai-change disposal/revert choices are only triggered by "edit from here" (see
    // ChatWindow.handleEditFromHereMark).
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
      // Silent failures made "a fork rejected mid-run" look like a hang (unclickable button) — surface a notice.
      const msg = e instanceof Error ? e.message : String(e);
      addNotice({ type: "error", message: t("session.forkFailed", { error: msg }) });
    } finally {
      setForkingEntryId(null);
    }
  }, [addNotice, onSessionForked, t]);

  /** Fork a new session (composer "new session" button, silent and in the
   *  background): copy the branch from the current leaf (full context, also
   *  usable while running — fork_branch neither replaces nor closes the source
   *  session), then start the new session in the background with the input as
   *  its first user message. Does not switch the current selection — the user
   *  stays in the original session; the new session enters the sidebar via the
   *  running broadcast. Returns false = not created (nothing to copy / backend
   *  unsupported); the notice has already been surfaced. */
  const handleForkNew = useCallback(async (message: string, images?: AttachedImage[]): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    let newSessionId: string | undefined;
    try {
      // No entryId passed → the server uses the current leaf (full context).
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork_branch",
      });
      const { cancelled, newSessionId: created } = result ?? {};
      if (cancelled || !created) {
        addNotice({ type: "error", message: t("session.forkNoHistory") });
        return false;
      }
      newSessionId = created;
    } catch (e) {
      console.error("Fork new session failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      addNotice({ type: "error", message: `Failed to fork session: ${msg}` });
      return false;
    }
    // Silent background start: deliver the first prompt to the new session (the /api/agent route cold-starts the
    // wrapper from the session file) without switching the current selection. Wait for acceptance (forking a new
    // session is heavy: extension loading / agent process, acceptance window capped at 10s) — the button's busy
    // state covers up to this point; the first toast pops only on success, an error toast on failure.
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(newSessionId, {
        type: "prompt",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Fork new session: background start failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      addNotice({ type: "error", message: t("session.forkStartFailed", { error: msg }) });
      return false;
    }
    addNotice({ type: "success", message: t("session.forkBackgroundOk") });
    return true;
  }, [addNotice, t]);

  const handleNavigate = useCallback(async (entryId: string): Promise<boolean> => {
    if (bashRunningRef.current) return false;
    const sid = sessionIdRef.current;
    if (!sid) return false;
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean }>(sid, {
        type: "navigate_tree",
        targetId: entryId,
      });
      if (result?.cancelled || sessionIdRef.current !== sid) return false;
      await loadSession(sid);
      return sessionIdRef.current === sid;
    } catch (e) {
      console.error("Failed to navigate:", e);
      return false;
    }
  }, [loadSession]);
  handleNavigateRef.current = handleNavigate;

  /** Runs when "edit from here" is sent: first rewind the session to the branch point (first message → rebuild
   *  from root), then send the edited message. The click-to-mark stage is purely frontend (prefill + highlight);
   *  this is where it actually takes effect (nothing moves in place until sent).
   *  @param targetId rewind target: normally the previous assistant message's entryId; for the first message, the
   *  message's own entryId (parentId → root)
   *  @param leafId  leaf loaded after the rewind (first message = null → empty history) */
  const handleEditFromStartSend = useCallback(async (
    targetId: string,
    leafId: string | null,
    message: string,
    images?: AttachedImage[],
  ) => {
    const sid = sessionIdRef.current;
    if (sid) {
      // External backend fork semantics (zcode): there is no session tree to rewind, so use session/fork — the
      // handle rebinds to the forked child session and continues in place (reset), with the child's history =
      // everything before the branch point + zcode's own checkpoint file rollback. Empty leafId = rebuild from
      // root (editing the first message; the backend discards the old channel and creates a fresh session next
      // turn). navigate_tree only works on pi session trees; other external backends (no fork, no tree) hide the
      // button, so this is unreachable.
      const extFork = sessionCapabilities != null && !sessionCapabilities.navigateTree && !!sessionCapabilities.fork;
      if (extFork) {
        try {
          await sendAgentCommand(sid, { type: "fork", entryId: leafId ?? "", reset: true });
        } catch (e) {
          // Sending after a failed fork would append the message to the tail of the un-rewound full history (the
          // user believes it was rewound) — abort this send and notify; the pending mark and input are kept for a retry.
          console.error("Edit-from-here: fork failed:", e);
          addNotice({ type: "error", message: t("session.editHereFailed", { error: describeAgentCommandError(e) }) });
          return;
        }
        await loadContext(sid, null);
        await handleSend(message, images);
        return;
      }
      try {
        await sendAgentCommand(sid, { type: "navigate_tree", targetId });
      } catch (e) {
        // Sending after a failed rewind would post the message to the wrong branch (the user believes it was
        // rewound) — abort this send and notify; the pending mark and input are kept for a retry.
        console.error("Edit-from-here: navigate failed:", e);
        addNotice({ type: "error", message: t("session.editHereRollbackFailed") });
        return;
      }
      setActiveLeafId(leafId);
      await loadContext(sid, leafId);
    }
    await handleSend(message, images);
  }, [handleSend, loadContext, addNotice, sessionCapabilities]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    // pi refuses navigate_tree mid-run: it moves the one leaf the running agent
    // appends to. Switching only the view would render the live run under
    // another branch, so the switch waits for the run like the server does.
    if (bashRunningRef.current || agentRunningRef.current || isCompacting) return;
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
    if (leafId) {
      sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId }).catch(() => {});
    }
  }, [isCompacting, loadContext]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      const selectedModel = { provider, modelId };
      newSessionModelOverrideRef.current = selectedModel;
      setNewSessionModel(selectedModel);
      setPendingModel(selectedModel);
      if (thinkingLevelOverrideRef.current === null) {
        const pinned = thinkingLevelPinsRef.current[`${provider}/${modelId}`];
        setNewSessionDefaultThinkingLevel(
          asConcreteThinkingLevel(pinned) ?? defaultThinkingLevelRef.current,
        );
      }
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
      const selected = await sendAgentCommand<{ provider: string; id: string }>(sid, { type: "set_model", provider, modelId });
      setLiveModel({ provider: selected.provider, modelId: selected.id });
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
      await loadSession(sid, false, true);
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

  // The banner otherwise stays until the next compaction, e.g. "Nothing to compact".
  const dismissCompactError = useCallback(() => setCompactError(null), []);

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

  /** /api/models response → component state (cache replay and network results share the same mapping). */
  const applyModelsResponse = useCallback((d: ModelsResponse) => {
    setModelNames(d.models);
    setModelError(d.modelError ?? null);
    setModelScopeWarnings(d.modelScopeWarnings ?? []);
    setModelThinkingLevels(d.thinkingLevels ?? {});
    setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
    const nextModelList = d.modelList ?? [];
    setModelList(nextModelList);
    const displayDefaultModel = d.defaultModel
      ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
      : undefined;
    setNewSessionDefaultModel(displayDefaultModel
      ? { provider: displayDefaultModel.provider, modelId: displayDefaultModel.id }
      : null);
    thinkingLevelPinsRef.current = d.thinkingLevelPins ?? {};
    defaultThinkingLevelRef.current = asConcreteThinkingLevel(d.defaultThinkingLevel);
    setSavedDefaultThinkingLevel(asConcreteThinkingLevel(d.savedDefaultThinkingLevel));
    if (isNew && !sessionIdRef.current) {
      // A picked model this folder does not offer (one carried over from the
      // composer this one replaced, or since scoped out) goes back to automatic.
      // An empty list offers nothing to compare with (a failed load answers
      // with one): the pick stays.
      const picked = newSessionModelOverrideRef.current;
      const kept = picked && (nextModelList.length === 0
        || nextModelList.some((m) => m.provider === picked.provider && m.id === picked.modelId));
      if (picked && !kept) {
        newSessionModelOverrideRef.current = null;
        setNewSessionModel(null);
      }
      // The first listed model is not necessarily the runtime's automatic choice.
      // An `enabledModels` pattern may pin a thinking level (`anthropic/*:high`).
      // Like pi, apply it to the model a new session starts with.
      const startModel = kept ? picked : displayDefaultModel && { provider: displayDefaultModel.provider, modelId: displayDefaultModel.id };
      const pinned = startModel && d.thinkingLevelPins?.[`${startModel.provider}/${startModel.modelId}`];
      if (thinkingLevelOverrideRef.current === null) {
        setNewSessionDefaultThinkingLevel(
          asConcreteThinkingLevel(pinned) ?? defaultThinkingLevelRef.current,
        );
      }
    }
  }, [isNew]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    // ── New-session page + backend selected: the model catalog comes from the provider's static listModels
    //    (available without a session). Missing static catalog (models:null) or failure → keep the local list as
    //    fallback. (Forced refresh uses refreshModels' separate path: the route's &refresh=1; not coupled to this
    //    function.)
    if (isNew && newSessionBackend && !sessionIdRef.current) {
      try {
        const res = await fetch(
          apiUrl(`/api/session-backends?provider=${encodeURIComponent(newSessionBackend)}`),
          signal ? { signal } : undefined,
        );
        const d = await res.json() as { models?: Array<{ id: string; provider: string; label?: string }> | null; refreshable?: boolean };
        setModelsRefreshable(Boolean(d.refreshable));
        if (d.models && d.models.length > 0) {
          const list = d.models.map((m) => ({ id: m.id, name: m.label ?? m.id, provider: m.provider }));
          setModelList(list);
          setModelNames(Object.fromEntries(list.map((m) => [m.id, m.name])));
          setModelError(null);
          setModelScopeWarnings([]);
          setNewSessionDefaultModel({ provider: list[0].provider, modelId: list[0].id });
          return;
        }
      } catch { /* network failure → fall back to the local list */ }
    }
    // ── Backend sessions (attach/spawn/extension): the model list comes from the list_models capability, not the
    //    local /api/models. Switching reuses the existing set_model command (adapter mapping).
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
        // Backend does not support listModels → fall back to the local list (usually empty too, so the picker disables naturally)
      }
    }
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    // Replay the local cache first (stale-while-revalidate): on slow networks / cold starts, issuing and receiving
    // the request is often dragged out over seconds by the main thread and the network round trip; model names and
    // the default model should not wait for the network before showing. The network result overwrites on arrival;
    // on failure the cache stays visible (no more blank state).
    const cachedModels = readCachedModels<ModelsResponse>(modelCwd);
    if (cachedModels) applyModelsResponse(cachedModels);
    let d: ModelsResponse;
    try {
      // Coalesce load windows: concurrent/same-second duplicate mounts for the same cwd (StrictMode double
      // effects, session window remounts) share one POST; a caller's own abort only affects that caller's result
      // and does not tear down the shared request (the trigger's unmount must not fail another caller still
      // waiting for the model list).
      d = await fetchModelsShared(modelCwd);
      signal?.throwIfAborted();
    } catch (e) {
      if (!signal?.aborted && !(e instanceof DOMException && e.name === "AbortError")) {
        setModelError(e instanceof Error ? e.message : String(e));
      }
      throw e;
    }
    applyModelsResponse(d);
    writeCachedModels(modelCwd, d);
  }, [isNew, newSessionCwd, session?.cwd, session?.agent, newSessionBackend, applyModelsResponse]);

  /**
   * Manually refresh the model catalog (new-session page + a selected backend
   * that supports refresh): the route's ?refresh=1 makes the provider's
   * refreshModels do a forced real probe. A 5s cooldown coalesces rapid
   * clicks; only the catalog is replaced and no local fallback is written
   * (refresh semantics); failures surface via notice and leave the current
   * list untouched.
   */
  const refreshModels = useCallback(async () => {
    if (!isNew || sessionIdRef.current || !newSessionBackend || modelsRefreshing) return;
    const now = Date.now();
    if (now - modelsRefreshAtRef.current < 5000) return;
    modelsRefreshAtRef.current = now;
    setModelsRefreshing(true);
    try {
      const res = await fetch(apiUrl(`/api/session-backends?provider=${encodeURIComponent(newSessionBackend)}&refresh=1`));
      const d = await res.json() as {
        models?: Array<{ id: string; provider: string; label?: string }> | null;
        refreshable?: boolean;
        error?: string;
      };
      if (!res.ok || !d.models || d.models.length === 0) {
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      const list = d.models.map((m) => ({ id: m.id, name: m.label ?? m.id, provider: m.provider }));
      setModelList(list);
      setModelNames(Object.fromEntries(list.map((m) => [m.id, m.name])));
      setModelsRefreshable(Boolean(d.refreshable));
      setModelError(null);
      setModelScopeWarnings([]);
      setNewSessionDefaultModel({ provider: list[0].provider, modelId: list[0].id });
    } catch (e) {
      addNotice({ type: "error", message: t("session.modelRefreshFailed", { error: e instanceof Error ? e.message : String(e) }) });
    } finally {
      setModelsRefreshing(false);
    }
  }, [isNew, newSessionBackend, modelsRefreshing, addNotice]);

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

  // Picking a model or reasoning level is session-scoped, as in the TUI. The
  // selectors' star is the explicit Ctrl+S equivalent: it saves the global
  // default new sessions start with and also selects it for this chat.
  const saveDefaultPreferences = useCallback(async (
    edit: { provider: string; modelId: string } | { thinkingLevel: ConcreteThinkingLevel },
  ) => {
    const cwd = newSessionCwd ?? session?.cwd;
    const res = await fetch("/api/models/default", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(cwd ? { cwd } : {}), ...edit }),
    });
    if (res.ok) return;
    let detail = "";
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string") detail = body.error;
    } catch {
      // Non-JSON error responses fall back to the HTTP status.
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }, [newSessionCwd, session?.cwd]);

  const reloadModelsQuietly = useCallback(() => {
    // The star already updated the marker; a failed refresh keeps the old list.
    loadModels().catch(() => {});
  }, [loadModels]);

  const handleSetDefaultModel = useCallback(async (provider: string, modelId: string) => {
    try {
      await saveDefaultPreferences({ provider, modelId });
    } catch (e) {
      addNotice({ type: "error", message: `Failed to save default model: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    addNotice({ type: "success", message: `Default model: ${provider}/${modelId}` });
    setNewSessionDefaultModel({ provider, modelId });
    if (displayModel?.provider !== provider || displayModel?.modelId !== modelId) {
      await handleModelChange(provider, modelId);
    }
    reloadModelsQuietly();
  }, [addNotice, displayModel, handleModelChange, reloadModelsQuietly, saveDefaultPreferences]);

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
      } else if (!result.action) {
        // A command that opens a panel says nothing: the panel is the answer.
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

        case "auto-compact": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          // Read the live wrapper (this POST starts it if idle) so the toggle
          // follows settings.json, not the React default of `true`.
          const liveState = await sendAgentCommand<AgentStateResponse>(sid, { type: "get_state" });
          const nextEnabled = !(liveState?.autoCompactionEnabled ?? true);
          await sendAgentCommand(sid, {
            type: "set_auto_compaction",
            enabled: nextEnabled,
          });
          setAutoCompactionEnabled(nextEnabled);
          return complete({
            handled: true,
            message: nextEnabled
              ? "Auto-compaction enabled"
              : "Auto-compaction disabled",
          });
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

        case "mcp": {
          // Only a bare /mcp, and only when pi's built-in MCP extension owns it or
          // nothing does (lib/mcp-command.ts): another extension's /mcp is sent as
          // before, and so is every subcommand, since `/mcp login`, `logout` and
          // `reconnect` act on this session's own connections. Returning before
          // onSend leaves no "/mcp" bubble and no sidebar row for a new chat; a
          // streaming run is not touched.
          if (args || !onOpenSettings) return { handled: false };
          const commands = await slashCommandsForMcp();
          if (!commands || !bareMcpOpensSettings(commands)) return { handled: false };
          onOpenSettings("mcp");
          return complete({ handled: true, action: "openSettings" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        case "clone": {
          if (!sid) return complete({ handled: true, error: "No active session to clone" });
          if (agentRunningRef.current || bashRunningRef.current) {
            return complete({ handled: true, error: "Cannot clone while the session is running" });
          }
          const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
            type: "clone",
            leafId: activeLeafId,
          });
          if (result?.cancelled || !result?.newSessionId) {
            return complete({ handled: true, error: "Cannot clone an empty or unsaved session" });
          }
          const completed = complete({ handled: true, message: "Cloned current session branch" });
          onSessionForked?.(result.newSessionId);
          return completed;
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") setIsCompacting(false);
    }
  }, [activeLeafId, addNotice, ensureNewSession, isCompacting, loadModels, loadSession, loadSlashCommands, loadTools, promoteNewSession, onOpenSettings, onSessionForked, onSessionStatsPanelOpen, refreshSessionStats, slashCommandsForMcp]);

  // Let AgentSession.prompt decide atomically whether to queue against the
  // current run or start a new turn if it settled while the request was in
  // flight. Direct steer/followUp calls can strand a message in an idle queue.
  const sendStreamingPrompt = useCallback(async (
    message: string,
    behaviorWanted: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    const sid = sessionIdRef.current;
    const restore = () => restoreSubmission(message, images, composerDraftKey);
    // A pending history edit must branch when sent, never join the current run.
    if (editEntryId) {
      restore();
      return;
    }
    if (!sid) {
      restore();
      addNotice({ type: "error", message: "No active session for the queued message" });
      return;
    }
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    // A backend that declares capabilities but no steer surface has no mid-run
    // injection channel: its routePrompt would enqueue the text anyway, so ask for
    // a follow-up explicitly instead of pretending to interrupt.
    const behavior: "steer" | "followUp" =
      behaviorWanted === "steer" && sessionCapabilities && !sessionCapabilities.steer ? "followUp" : behaviorWanted;
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
        // Transport failure / gateway 502 → the copy itself says the backend may be restarting, refresh the page later (normalized in describeAgentCommandError)
        message: describeAgentCommandError(e),
      });
    }
  }, [addNotice, composerDraftKey, editEntryId, restoreSubmission, sessionCapabilities]);

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
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[]; rev?: number }>(sid, { type: "clear_queue" });
      // clearQueue also emits an empty queue_update, but that only reaches us
      // while SSE is connected — clear locally so idle recalls update the UI.
      // Advance rev to the post-clear version in sync: in-flight stale snapshots must not resurrect cleared entries (ext-agent carries rev).
      if (typeof result?.rev === "number") queueRevRef.current = Math.max(queueRevRef.current, result.rev);
      setQueuedMessages({ steering: [], followUp: [] });
      let texts = [...(result?.steering ?? []), ...(result?.followUp ?? [])];
      if (texts.length === 0) {
        // Defensive fallback: the server cleared the queue but did not report the
        // cleared texts (older ext-agent backends) — use the locally known queue
        // so a "recall all" never silently drops messages.
        texts = [...queuedMessages.steering, ...queuedMessages.followUp];
      }
      if (texts.length > 0) {
        opts.chatInputRef?.current?.prependText(texts.join("\n\n"));
      }
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      addNotice({ type: "error", message: "Failed to recall queued messages" });
    }
  }, [opts.chatInputRef, addNotice, queuedMessages]);

  /** Pick up a run that was started server-side (queue delivery, recovery
   * continue) — possibly before any SSE was connected (e.g. right after a
   * restart) — so streaming, agent_end refresh, and settlement all work. */
  const adoptRemoteRun = useCallback(async (sid: string) => {
    try {
      const stateRes = await fetch(apiUrl(`/api/agent/${encodeURIComponent(sid)}`));
      if (stateRes.ok) {
        const agentState = await stateRes.json() as { running?: boolean; state?: AgentStateResponse };
        const st = agentState.state;
        if (agentState.running && st && stateIsActive(st)) {
          sdkAgentActiveRef.current = Boolean(st?.isStreaming);
          rpcPromptPendingRef.current = Boolean(st?.isPromptRunning);
          agentRunningRef.current = true;
          adoptRunStartedAt(st?.runStartedAt);
          setAgentRunning(true);
          setAgentPhase(st?.isStreaming ? { kind: "waiting_model" } : st?.isCompacting ? { kind: "compacting" } : { kind: "running_command" });
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
  }, [adoptRunStartedAt, ensureEventsConnected, waitForPromptSettlement, loadSession, dispatchStream]);

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
            applyQueuedSnapshot(agentState.state.queuedMessages);
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
  }, [applyQueuedSnapshot, pendingRecovery, addNotice, adoptRemoteRun, opts.chatInputRef]);

  /** Deliver the queued messages now — the "Continue" button on an idle queue
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
      const result = await sendAgentCommand<{ removed?: QueueTrashItem; steering?: string[]; followUp?: string[]; queueTrash?: QueueTrashItem[] }>(sid, {
        type: "remove_queue_item",
        kind,
        index,
        ...(opts?.permanent ? { permanent: true } : {}),
      });
      if (result && (result.steering !== undefined || result.followUp !== undefined)) {
        setQueuedMessages(normalizeQueuedMessages(result));
      }
      // The server returns the updated trash in the same response — refresh the trash badge immediately (after the
      // queue panel moved into the extension, the extension consumes this state; no longer waiting for SSE/refresh)
      if (result?.queueTrash !== undefined) setQueueTrash(result.queueTrash);
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

  /**
   * Dedicated to the composer's clear (×) action: write the cleared input
   * content (text + images) straight into the trash via trash_direct_add
   * (never touches the live queue / never dispatches); returns whether the
   * write succeeded. Silent on failure (clearing does not depend on it — the
   * in-memory 5s undo remains the immediate safety net).
   */
  const trashComposerInput = useCallback(async (
    text: string,
    images?: ChatDraftImage[],
  ): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    try {
      const result = await sendAgentCommand<{ queueTrash?: QueueTrashItem[] }>(sid, {
        type: "trash_direct_add",
        text,
        ...(images && images.length > 0
          ? { images: images.map((im) => ({ type: "image" as const, data: im.data, mimeType: im.mimeType })) }
          : {}),
      });
      if (result?.queueTrash !== undefined) setQueueTrash(result.queueTrash);
      return true;
    } catch (e) {
      console.error("Failed to write trash entry:", e);
      return false;
    }
  }, []);

  /**
   * Restore a composer (cleared input) entry from the trash: the server takes
   * it out directly and returns the full content (incl. image base64), and the
   * composer refills it for continued editing (not re-enqueued). This function
   * only fetches; ChatInput performs the refill.
   */
  const restoreComposerTrash = useCallback(async (
    id: string,
  ): Promise<{ text: string; images: ChatDraftImage[] } | null> => {
    const sid = sessionIdRef.current;
    if (!sid) return null;
    try {
      const result = await sendAgentCommand<{
        restoredComposer?: { text: string; images?: Array<{ type: "image"; data: string; mimeType: string }> };
        queueTrash?: QueueTrashItem[];
      }>(sid, {
        type: "restore_trash_item",
        id,
      });
      if (result?.queueTrash !== undefined) setQueueTrash(result.queueTrash);
      if (!result?.restoredComposer) return null;
      return {
        text: result.restoredComposer.text,
        images: (result.restoredComposer.images ?? []).map((im) => ({ data: im.data, mimeType: im.mimeType })),
      };
    } catch (e) {
      console.error("Failed to restore composer entry:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : "Failed to restore input" });
      return null;
    }
  }, [addNotice]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    if (level === "auto") {
      thinkingLevelOverrideRef.current = null;
      setNewSessionThinkingLevel(null);
      setCurrentThinkingOverride(null);
      return;
    }
    if (isNew) {
      thinkingLevelOverrideRef.current = level;
      setNewSessionThinkingLevel(level);
    } else {
      setCurrentThinkingOverride(level);
    }
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
      if (sessionHookMountedRef.current && sessionIdRef.current === sid) {
        setLiveThinkingLevel(level);
        setCurrentThinkingOverride(null);
      }
    } catch (e) {
      console.error("Failed to set thinking level:", e);
      setCurrentThinkingOverride(null);
    }
  }, [isNew]);

  const handleSetDefaultThinkingLevel = useCallback(async (level: ConcreteThinkingLevel) => {
    try {
      await saveDefaultPreferences({ thinkingLevel: level });
    } catch (e) {
      addNotice({ type: "error", message: `Failed to save default reasoning level: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    addNotice({ type: "success", message: `Default reasoning level: ${level}` });
    setSavedDefaultThinkingLevel(level);
    if (displayThinkingLevel !== level) await handleThinkingLevelChange(level);
    reloadModelsQuietly();
  }, [addNotice, displayThinkingLevel, handleThinkingLevelChange, reloadModelsQuietly, saveDefaultPreferences]);

  const handleToolPresetChange = useCallback(async (preset: ToolPreset) => {
    const toolNames = getToolNamesForPreset(preset);
    setPreferredToolPreset(preset);
    setToolPresetState(preset);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) {
      sessionToolsPinnedRef.current = toolNames !== undefined;
      return;
    }
    try {
      // Omitting toolNames retracts the session's pin so it follows the configured
      // defaults again; the server rebuilds the session to resolve them.
      const result = await sendAgentCommand<{ sessionId?: string; recreated?: boolean }>(sid, {
        type: "set_tools",
        ...(toolNames !== undefined ? { toolNames } : {}),
      });
      sessionToolsPinnedRef.current = toolNames !== undefined;
      const activeSessionId = result?.sessionId ?? sid;
      if (activeSessionId !== sid || result?.recreated) {
        cancelEventStreamGrace();
        closeEvents();
        // The old wrapper cancels its pending extension UI only after its stream has
        // closed, so those close events never arrive; drop the requests here instead
        // of leaving them queued in front of the new wrapper's.
        setExtensionDialogs([]);
        setExtensionCustomUis([]);
        sessionIdRef.current = activeSessionId;
        // Rebuild = new handle = new rev axis: reset the cursor
        queueRevRef.current = 0;
        if (result?.recreated && sessionPropIdRef.current === activeSessionId) {
          maintainEventsConnected(activeSessionId);
        }
      }
      clearSlashCommands();
      setExtensionStatuses([]);
      setExtensionWidgets([]);
      const [state] = await Promise.all([
        sendAgentCommand<AgentStateResponse>(activeSessionId, { type: "get_state" }),
        loadTools(activeSessionId),
      ]);
      if (sessionHookMountedRef.current && sessionIdRef.current === activeSessionId) {
        setSystemPrompt(state.systemPrompt ?? "");
        syncLiveModel(state);
      }
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [cancelEventStreamGrace, clearSlashCommands, closeEvents, loadTools, maintainEventsConnected, setToolPresetState, syncLiveModel]);

  const scrollToMessage = useCallback((element: HTMLElement, viewportOffset = 16) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (liveFollowFrameRef.current !== null) {
      cancelAnimationFrame(liveFollowFrameRef.current);
      liveFollowFrameRef.current = null;
    }
    initialScrollDoneRef.current = true;
    pendingScrollToUserRef.current = false;
    isNearBottomRef.current = false;
    setPromptAnchorActive(false);
    container.scrollTo({
      top: element.getBoundingClientRect().top
        - container.getBoundingClientRect().top
        + container.scrollTop
        - viewportOffset,
      behavior: "instant",
    });
    previousScrollTopRef.current = container.scrollTop;
  }, []);

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
    if (isNearBottomRef.current) setUserScrolledAway(false);
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    // Send/navigation jumps are explicit viewport changes: clear the 2s
    // press-guard window opened by pointerdown, otherwise the compensating
    // step right after the jump (when the streaming placeholder appears) is
    // silently skipped after a real click on send.
    userScrollIntentUntilRef.current = 0;
    // Send/jump is an explicit viewport change: also lift the input freeze —
    // after a send on mobile the keyboard stays open (focus remains in the
    // field), and this run's reply must still be followed; the next edit event
    // re-freezes.
    composingUntilRef.current = 0;
    editingRef.current = false;
    container.scrollTo({ top: targetTop, behavior: "smooth" });
  }, [setUserScrolledAway]);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
      // Up-direction keys are a definitive "user is leaving the tail" signal.
      if (SCROLL_UP_KEYS.has(event.key)) setUserScrolledAway(true);
    } else if (event instanceof WheelEvent && event.deltaY < 0) {
      // Wheel-up likewise: no programmatic scroll ever emits wheel events, so
      // this can't be content growth or our own step scrolling.
      setUserScrolledAway(true);
    }
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }, [setUserScrolledAway]);

  const handleScrollPositionChange = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      const { scrollTop, clientHeight, scrollHeight } = container;
      const prevScrollTop = lastScrollTopRef.current;
      lastScrollTopRef.current = scrollTop;
      isNearBottomRef.current = scrollTop + clientHeight >= scrollHeight - SCROLL_BOTTOM_THRESHOLD;
      if (isNearBottomRef.current) {
        // Back at the tail: re-arm auto-follow for the rest of this run.
        setUserScrolledAway(false);
      } else if (
        agentRunningRef.current &&
        scrollTop < prevScrollTop - 1 &&
        Date.now() >= ignoreProgrammaticScrollUntilRef.current
      ) {
        // scrollTop decreased by user agency (touch drag, momentum tail,
        // missed wheel edge): content growing BELOW the fold never moves
        // scrollTop, and programmatic scrolls are filtered by the ignore
        // window, so this is the user reading history.
        setUserScrolledAway(true);
      }
      // Upstream scroll-to-latest button visibility. The fork's ChatWindow drives
      // the step-follow toolbar from its own state, but keeping this state live
      // costs nothing and keeps the upstream consumer working.
      const shouldShow = shouldShowScrollToLatest(scrollTop, clientHeight, scrollHeight);
      setShowScrollToBottom((previous) => (previous === shouldShow ? previous : shouldShow));
      if (!isNearBottomRef.current && liveFollowFrameRef.current !== null) {
        cancelAnimationFrame(liveFollowFrameRef.current);
        liveFollowFrameRef.current = null;
      }
    }
  }, []);

  // What a session read with its state (`loadSession(…, includeState)`) says is
  // under way on the server: a run or command, a `!` command, a compaction. The
  // mount and a hidden page's return show it the same way.
  const applyLoadedAgentState = useCallback((sid: string, loadedAgentState: unknown) => {
    const agentState = loadedAgentState as { running: boolean; state?: AgentStateResponse } | null;
    if (agentState?.running) {
      // Do not auto-run loadTools (get_tools) here: when a session is opened or restored just for viewing,
      // loading should be triggered by real intent — the tool list is fetched via loadSystemInfo when the user
      // opens the system/tools panel (AppShell handleSystemInfoToggle). The preset state already has
      // loadSession's toolNames (setToolPresetState inside loadSession); no need to hit the runtime just for display.
      if (stateIsActive(agentState.state)) {
        const st = agentState.state!;
        sdkAgentActiveRef.current = Boolean(st.isStreaming);
        rpcPromptPendingRef.current = Boolean(st.isPromptRunning);
        agentRunningRef.current = true;
        adoptRunStartedAt(st.runStartedAt);
        setAgentRunning(true);
        // During compaction the run was already aborted (isStreaming=false) but the session is still busy — previously this was not adopted → opening the session showed idle
        setAgentPhase(st.isStreaming ? { kind: "waiting_model" } : st.isCompacting ? { kind: "compacting" } : { kind: "running_command" });
        dispatchStream({ type: "resume" });
        void maintainEventsConnected(sid);
        if (!st.isStreaming && st.isPromptRunning) {
          void waitForPromptSettlement(sid);
        }
      }
      if (agentState.state?.isBashRunning) {
        bashRunningRef.current = true;
        setBashRunning(true);
        void waitForBashSettlement(sid);
      }
    }
    if (agentState?.state) {
      if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
      if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
      if (agentState.state.extensionStatuses !== undefined) setExtensionStatuses(agentState.state.extensionStatuses ?? []);
      if (agentState.state.extensionWidgets !== undefined) setExtensionWidgets(agentState.state.extensionWidgets ?? []);
      if (agentState.state.queuedMessages !== undefined) applyQueuedSnapshot(agentState.state.queuedMessages);
      if (agentState.state.pendingRecovery !== undefined) setPendingRecovery(agentState.state.pendingRecovery ?? []);
      if (agentState.state.queueTrash !== undefined) setQueueTrash(agentState.state.queueTrash ?? []);
    }
  }, [adoptRunStartedAt, applyQueuedSnapshot, dispatchStream, maintainEventsConnected, waitForBashSettlement, waitForPromptSettlement]);

  // Open a released stream again and read what it missed (a run another tab, a
  // device or an extension started or finished, statuses), shown as the mount
  // shows it. `connected` resumes a streaming run and replays pending extension
  // dialogs, so their completion and attention notifications reach the page as
  // if it had never let go. Nothing is resent.
  reattachEventStreamRef.current = (sid: string) => {
    if (!eventStreamReleasedRef.current) return;
    eventStreamReleasedRef.current = false;
    setEventStreamReattachCount((count) => count + 1);
    if (!sessionHookMountedRef.current || sessionIdRef.current !== sid || sessionPropIdRef.current !== sid) return;
    maintainEventsConnected(sid);
    void loadSession(sid, false, true).then((loadedAgentState) => {
      if (!sessionHookMountedRef.current || sessionIdRef.current !== sid) return;
      applyLoadedAgentState(sid, loadedAgentState);
    });
  };

  // The page keeps its selected session alive with a lease of its own, renewed
  // every SESSION_LEASE_RENEW_INTERVAL_MS whether or not it holds the event
  // stream: a hidden page lets go of the stream (#1283), not of the session, so
  // the idle wrapper and an extension's timer in it live on. A released page
  // reads each reply and opens the stream again as soon as something is under
  // way (sessionLeaseShowsActivity()); one that comes back opens it at once. A
  // dead stream is the connection's heartbeat watchdog's to notice.
  useEffect(() => {
    const sid = session?.id;
    if (!sid) return;
    let disposed = false;
    const renew = async () => {
      const reply = await requestLease(sid);
      if (disposed || document.visibilityState !== "hidden") return;
      if (sessionLeaseShowsActivity(reply)) reattachEventStreamRef.current(sid);
    };
    void renew();
    const interval = setInterval(() => void renew(), SESSION_LEASE_RENEW_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      reattachEventStreamRef.current(sid);
      // A frozen background page renewed nothing; coming back renews at once.
      void renew();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [requestLease, session?.id]);

  // Load session on mount
  useEffect(() => {
    sessionHookMountedRef.current = true;
    // Usage reads started before a remount are stale.
    contextUsageAppliedIdRef.current = contextUsageRequestIdRef.current;
    if (session) {
      sessionIdRef.current = session.id;
      // Snapshot fast path: show the cached history window immediately, then
      // run the normal forced read in the background as the freshness check.
      // Only the settled history fields are restored — no streaming, queue, or
      // run state — and the background read remains authoritative.
      const cached = getSessionViewSnapshot(session.id);
      if (cached) {
        setData({
          sessionId: session.id,
          filePath: "",
          totalActiveMs: cached.totalActiveMs ?? 0,
          tree: cached.summaryTree as SessionData["tree"],
          leafId: cached.leafId,
          context: {
            messages: cached.messages,
            entryIds: cached.entryIds,
            oldestEntryId: cached.oldestEntryId,
            hasMore: cached.hasMore,
            turnsBefore: cached.turnsBefore,
            thinkingLevel: cached.thinkingLevel,
            model: cached.model,
          },
          stats: cached.stats as SessionData["stats"],
        });
        setActiveLeafId(cached.leafId);
        setMessages(cached.messages);
        setEntryIds(cached.entryIds);
        setHistoryCursor(cached.oldestEntryId);
        setHasEarlierMessages(cached.hasMore);
        setEarlierTurnCount(cached.turnsBefore);
        setError(null);
        setLoading(false);
      }
      loadSession(session.id, !cached, true, { force: true }).then((loadedAgentState) => {
        const agentState = loadedAgentState as { running: boolean; state?: AgentStateResponse } | null;
        if (agentState?.running) {
          // Do not auto-run loadTools (get_tools) here: when a session is opened or restored just for viewing,
          // loading should be triggered by real intent — the tool list is fetched via loadSystemInfo when the user
          // opens the system/tools panel (AppShell handleSystemInfoToggle). The preset state already has
          // loadSession's toolNames (setToolPresetState inside loadSession); no need to hit the runtime just for display.
          if (stateIsActive(agentState.state)) {
            const st = agentState.state!;
            sdkAgentActiveRef.current = Boolean(st.isStreaming);
            rpcPromptPendingRef.current = Boolean(st.isPromptRunning);
            agentRunningRef.current = true;
            adoptRunStartedAt(st.runStartedAt);
            setAgentRunning(true);
            // During compaction the run was already aborted (isStreaming=false) but the session is still busy — previously this was not adopted → opening the session showed idle
            setAgentPhase(st.isStreaming ? { kind: "waiting_model" } : st.isCompacting ? { kind: "compacting" } : { kind: "running_command" });
            dispatchStream({ type: "resume" });
            void maintainEventsConnected(session.id);
            if (!st.isStreaming && st.isPromptRunning) {
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
          if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
          if (agentState.state.extensionStatuses !== undefined) setExtensionStatuses(agentState.state.extensionStatuses ?? []);
          if (agentState.state.extensionWidgets !== undefined) setExtensionWidgets(agentState.state.extensionWidgets ?? []);
          if (agentState.state.queuedMessages !== undefined) applyQueuedSnapshot(agentState.state.queuedMessages);
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
      // Do not clear "abandoned" new-session drafts on unmount: the user may just be glancing at another session
      // (SPA switches unmount this hook too), and clearing would leave the keeper's scan with nothing to restore
      // on return — the "new session → type → switch away → switch back" draft would be lost. Draft lifecycle is
      // fully owned by the draft-keeper extension (flushAll to disk when switching away, scan restores on return,
      // the user emptying the input clears the slot via onChange). Upstream's draft-clearing-on-abandon is therefore
      // deliberately NOT ported: it would race the keeper's flush/restore cycle.
      // Persist the settled view of the outgoing session so switching back can
      // restore it instantly (upstream session view cache). Only when the
      // cached window still covers every entry the UI has loaded (paged-in
      // history included).
      {
        const sid = sessionIdRef.current;
        const currentData = dataRef.current;
        if (sid && currentData && currentData.sessionId === sid && currentData.snapshotRevision) {
          const existing = getSessionViewSnapshot(sid);
          const entryIds = entryIdsRef.current;
          const coverable = !existing || entryIds.every((id) => existing.entryIds.includes(id) || (existing.loadedEntryIds ?? []).includes(id));
          if (coverable) {
            setSessionViewSnapshot({
              sessionId: sid,
              revision: currentData.snapshotRevision,
              messages: messagesRef.current,
              entryIds: entryIdsRef.current,
              leafId: activeLeafIdRef.current,
              oldestEntryId: historyCursorRef.current,
              hasMore: hasEarlierMessagesRef.current,
              turnsBefore: earlierTurnCountRef.current,
              summaryTree: currentData.tree,
              thinkingLevel: currentData.context.thinkingLevel,
              model: currentData.context.model,
              stats: currentData.stats,
              totalActiveMs: currentData.totalActiveMs,
              loadedEntryIds: entryIdsRef.current,
            });
          } else {
            deleteSessionViewSnapshot(sid);
          }
        }
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
    onSystemInfoLoaderChange?.(loadSystemInfo);
    return () => onSystemInfoLoaderChange?.(null);
  }, [loadSystemInfo, onSystemInfoLoaderChange]);

  const branchSwitchLocked = agentRunning || bashRunning || isCompacting;
  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange, branchSwitchLocked);
  }, [data?.tree, activeLeafId, handleLeafChange, branchSwitchLocked, onBranchDataChange]);

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

  // Composing guard (small screens / touch): while the user is typing, the soft
  // keyboard is up and passive chat scrolling (stream step-follow, tail re-pin
  // after the composer grew, completion scroll) moves the transcript under
  // their thumbs — it interrupts typing. Each edit event refreshes a short
  // freeze window; it releases by itself when they pause to read, when focus
  // leaves the field, or when the view is explicitly jumped (send/navigation).
  useEffect(() => {
    const release = () => {
      const wasComposing = editingRef.current && Date.now() < composingUntilRef.current;
      editingRef.current = false;
      composingUntilRef.current = 0;
      // Hand the view back the moment the freeze lifts (event-driven, no poll):
      // mid-run → one follow step; finished → the usual guarded scroll-to-tail.
      if (!wasComposing || pendingScrollToUserRef.current) return;
      if (agentRunningRef.current) {
        scheduleFollowStep();
      } else if (!userPointerDownRef.current && (completionScrollAllowedRef.current || isNearBottomRef.current)) {
        scrollToBottom("smooth");
      }
    };
    let releaseTimer: number | null = null;
    const arm = (event: Event) => {
      if (!isEditFreezeViewport() || !isEditableNode(event.target)) return;
      editingRef.current = true;
      composingUntilRef.current = Date.now() + COMPOSING_ACTIVE_MS;
      if (releaseTimer !== null) window.clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(() => {
        releaseTimer = null;
        release();
      }, COMPOSING_ACTIVE_MS);
    };
    const onFocusOut = (event: FocusEvent) => {
      // Field → field (composer → extension input): keep the freeze armed.
      if (isEditableNode(event.relatedTarget)) return;
      if (releaseTimer !== null) {
        window.clearTimeout(releaseTimer);
        releaseTimer = null;
      }
      release();
    };
    for (const type of COMPOSING_EVENTS) {
      window.addEventListener(type, arm, { capture: true, passive: true });
    }
    window.addEventListener("focusout", onFocusOut, true);
    return () => {
      for (const type of COMPOSING_EVENTS) {
        window.removeEventListener(type, arm, true);
      }
      window.removeEventListener("focusout", onFocusOut, true);
      if (releaseTimer !== null) window.clearTimeout(releaseTimer);
    };
  }, [scheduleFollowStep, scrollToBottom]);

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
    else setUserScrolledAway(false);
  }, [agentRunning, setUserScrolledAway]);

  useLayoutEffect(() => {
    if (messages.length > 0) {
      if (pendingScrollToUserRef.current) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
        scrollUserMsgToTop();
      } else if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        // First paint of an opened session always lands at the tail even if a
        // composer autofocus already counts as "editing".
        scrollToBottom("instant", { force: true });
      } else if (!agentRunningRef.current && !userPointerDownRef.current && (completionScrollAllowedRef.current || isNearBottomRef.current)) {
        scrollToBottom("smooth");
      }
    }
  }, [messages.length, agentRunning, scrollToBottom, scrollUserMsgToTop]);

  // Step-follow trigger signals: streaming deltas (streamState changes reference every frame) + full message
  // renders (messages reference changes: message_end commit / reconcile loading a tool result / context load).
  // Previously only streamState was depended on, with a `!isStreaming` gate: non-streaming renders such as tool
  // results and full messages that grew the last message had no check → the viewport stayed put until the next
  // streaming round caught up (a sudden large jump). Note: this uses useEffect (passive, runs after paint)
  // rather than useLayoutEffect — in the passive phase reading layout is free (no pending DOM writes), so it
  // never forces a synchronous layout; delta-batching has already coalesced streamingMessage updates to once
  // per frame and this effect runs at most once per frame — no layout storm. The messages reference only
  // changes at message granularity (not per chunk), so the extra trigger frequency is low, with no layout pressure.
  useEffect(() => {
    // Do not follow while a send/jump scroll is in flight (same suppression as the old message_update live-follow)
    if (pendingScrollToUserRef.current) return;
    // While the agent is idle, the settling scroll is owned by the messages/length useLayoutEffect → scrollToBottom
    // (smooth scroll to the bottom); do not step here, to avoid racing the scroll-to-bottom (and to avoid stepping
    // a just-opened session's initial load to the 120px position).
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
    (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await loadModels(controller.signal);
          return;
        } catch (e) {
          if (controller.signal.aborted) return;
          if (e instanceof DOMException && e.name === "AbortError") return;
          if (attempt >= MODELS_RETRY_DELAYS_MS.length) return;
          await delay(MODELS_RETRY_DELAYS_MS[attempt]);
          if (controller.signal.aborted) return;
        }
      }
    })();
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  // Pause notice expiry while hovered or focused.
  // The remainingMs/startedAt/oldestId refs implement a true pause-and-resume instead of resetting the 5s timer.
  const [pausedNoticeId, setPausedNoticeId] = useState<string | null>(null);
  const noticeRemainingMsRef = useRef(NOTICE_VISIBLE_MS);
  const noticeTimerStartedAtRef = useRef<number | null>(null);
  const noticeOldestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (noticeState.visible.length === 0) {
      noticeOldestIdRef.current = null;
      return;
    }
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    // Oldest visible notice changed; restart the countdown
    if (noticeOldestIdRef.current !== oldest.id) {
      noticeOldestIdRef.current = oldest.id;
      noticeRemainingMsRef.current = NOTICE_VISIBLE_MS;
    }
    if (noticeState.visible.some((notice) => notice.id === pausedNoticeId)) return;
    noticeTimerStartedAtRef.current = Date.now();
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, noticeRemainingMsRef.current);
    return () => {
      clearTimeout(t);
      // Accrue the elapsed time so the countdown resumes from the remaining time
      if (noticeTimerStartedAtRef.current !== null) {
        noticeRemainingMsRef.current = Math.max(
          0,
          noticeRemainingMsRef.current - (Date.now() - noticeTimerStartedAtRef.current),
        );
        noticeTimerStartedAtRef.current = null;
      }
    };
  }, [noticeState.visible, pausedNoticeId]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  const thinkingLevel: ThinkingLevelOption = displayThinkingLevel ?? "auto";
  // The head of each queue is on screen; the rest wait behind it.
  const extensionDialog = extensionDialogs[0] ?? null;
  const waitingExtensionDialogCount = Math.max(0, extensionDialogs.length - 1);
  const extensionCustomUi = extensionCustomUis[0] ?? null;
  const waitingExtensionCustomUiCount = Math.max(0, extensionCustomUis.length - 1);

  return {
    // State
    data, loading, error, activeLeafId, messages, activeToolResults, entryIds, historyCursor, hasEarlierMessages, earlierTurnCount, streamState,
    agentRunning, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel,
    modelsRefreshing, modelsRefreshable, refreshModels,
    followPaused,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, compactQueued, cancelCompactQueue, modelSwitchPending, currentModel, displayModel, modelSwitching, sessionStats, autoCompactionEnabled,
    slashCommands, slashCommandsLoading, queuedMessages, sessionTasks,
    pendingRecovery, recoveryIsImport, resolveRecovery, exportQueueData, importQueueData, stageImport,
    queueTrash, restoreQueueItem, purgeQueueTrash, trashComposerInput, restoreComposerTrash,
    moveQueuedMessage, convertQueuedMessage, recallQueuedMessage, requeueAt, removeQueuedMessage,
    notices: noticeState.visible, extensionDialog, waitingExtensionDialogCount, extensionCustomUi, waitingExtensionCustomUiCount, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    permissionRequest, respondToPermission, switchPermissionMode, sessionCapabilities, backendSource, backendUsage,
    providerHeadersRequest, respondToProviderHeaders,
    interactionRequest, respondToInteraction,
    sessionRequest, respondToSessionRequest,
    isAutoModelSelection: isNew && newSessionModel === null,
    isAutoThinkingSelection: isNew && newSessionThinkingLevel === null,
    defaultModel: newSessionDefaultModel,
    savedDefaultThinkingLevel,
    agentPhase,
    isNew,
    editEntryId,
    promptAnchorActive,
    showScrollToBottom,
    // Refs
    sessionIdRef, messagesEndRef, scrollContainerRef, runStartedAtRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleForkNew, handleNavigate, handleEditFromStartSend, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    dismissCompactError,
    handleRecallQueue,
    handleContinueQueue,
    handleBuiltinSlashCommand,
    handleEditContent,
    // Present only while a history edit is pending.
    cancelEdit: editEntryId ? cancelEdit : undefined,
    addNotice,
    setNoticePaused: setPausedNoticeId,
    refreshSessionStats,
    handleToolPresetChange, handleThinkingLevelChange, handleSetDefaultModel, handleSetDefaultThinkingLevel, loadTools, loadSlashCommands, setActiveLeafId, setData, setMessages, loadContext,
    reloadCurrentSession,
    scrollToBottom, scrollUserMsgToTop, scrollToMessage,
    dispatch, setAgentRunning, setForkingEntryId,
    aborting,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  };
}

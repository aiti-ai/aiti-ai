import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createAgentSessionFromServices, createAgentSessionServices, getAgentDir, initTheme, SessionManager, SettingsManager, Theme, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { bundledPiPluginPaths } from "./pi-plugins.ts";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import type { JournalEntry } from "./running-journal.ts";
import { recordRunningEntries } from "./running-journal.ts";
import { deriveRunOutcome, type SessionLastRun } from "./run-outcome.ts";
import { existsSync, realpathSync, writeFileSync } from "fs";
import { resolve } from "path";
import { isDeepStrictEqual } from "util";
import { validateAgentImages } from "./image-attachments.ts";
import { EXTENSION_REPORTED_CODE } from "./agent-client.ts";
import { cwdMissingError } from "./missing-cwd.ts";
import {
  createQueueEntry,
  loadQueueFile,
  removeQueue,
  saveQueue,
  type PendingRecoveryItem,
  type QueueEntry,
  type QueueEntryInput,
  type QueueImage,
  type QueueKind,
  type QueueTrashItem,
} from "./queue-store.ts";
import { invalidateModelsCache } from "./models-cache.ts";
import { invalidateModelRuntimeWithExtensions } from "./model-runtime.ts";
import { hasLiveDetachedRuns } from "./subagent-detached.ts";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope.ts";
import { findDeferredModel, findDeferredStartupModel, rememberProviderModels } from "./deferred-provider-models.ts";
import { isBlockingExtensionUiRequest } from "./extension-ui-queue.ts";
import {
  createProjectCommandBashExtension,
  createProjectCommandBashOperations,
  preferUserBashExtension,
} from "./project-command-env.ts";
import { disableConflictingExtensions } from "./ext-conflicts.ts";
import { cacheSessionPath, catalogFirstMessage, getLatestModelChange, invalidateSessionListCache, readLatestSessionEntryId, resolveSessionPath } from "./session-reader.ts";
import { computeSessionStats } from "./session-stats.ts";
import { computeSessionTotalActiveMs, computeLiveSessionTotalActiveMs } from "./session-timing.ts";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust.ts";
import { notifySessionComplete } from "./web-push.ts";
import { notifySessionCreated } from "./session-created-notify.ts";
import { hasActiveSessionLivenessProvider } from "./session-liveness.ts";
import type { SlashCommandInfo, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "./pi-types.ts";
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  ExtensionWidgetItem,
  SessionEntry,
  SessionInfo,
  SessionMessageEntry,
  SubagentSessionStatus,
} from "./types.ts";
import { getRegistry as getExtRegistry } from "./ext/registry.ts";
import type { AgentSessionInfo } from "./ext/types.ts";
import { listProviders } from "./session/providers.ts";
import { BridgeOccupiedError } from "./session/types.ts";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS, type HeadlessCustomUiTui } from "./custom-ui-terminal.ts";
import { extensionUiTheme } from "./extension-ui-theme.ts";
import {
  createSubagentExtension,
  preferPiWebSubagentExtension,
} from "./subagent-extension.ts";
import {
  listSubagentProfiles,
  hasSubagentResourceSnapshot,
  readSubagentRun,
  readSubagentSessionResources,
  settleOrphanedSubagentStatus,
  subagentExtensionLoaderOptions,
  subagentToolOptions,
  SUBAGENT_CONTROL_TOOL_NAMES,
} from "./subagents.ts";
import {
  hasSideMetadata,
  readSideRelation,
  sideToolNames,
} from "./side-session.ts";
import { SIDE_SESSION_NAME, sideChatNameFrom } from "./session-family.ts";
import { createSubagentController, getLiveSubagentStatus, hasUnsettledSubagentRun } from "./subagent-runtime.ts";
import { isBuiltInSubagentsEnabled } from "./subagent-settings.ts";
import { resolveShellTools } from "./powershell-settings.ts";
import { CHAT_ONLY_RESOURCE_LOADER_OPTIONS, contextFilesSystemPrompt } from "./chat-only.ts";
import { createExactSystemPromptExtension } from "./exact-system-prompt.ts";
import { createPiWebBuiltinExtensions, createSubagentCodemodeExtension, createSubagentMcpExtensions } from "./builtin-extensions.ts";
import type { McpHost } from "./mcp-host.ts";
import { mcpPromptPreparation, type McpCommandCandidate } from "./mcp-command.ts";
import { createReadOnlyMcpPolicyExtension, createSubagentMcpPolicyExtension } from "./mcp-read-only-policy.ts";
import { createSubagentSkillsBinding } from "./subagent-skills.ts";
import { isNestedToolExecutionEvent } from "./agent-event-wire.ts";
import { collectStartupIssues, extensionErrorMessage, limitStartupNotices, type StartupIssue } from "./startup-issues.ts";
import { collectLiveAssistantNotices, readShowCacheMissNotices, withSessionPrices } from "./transcript-notices-server.ts";
import type { DebugMcpHost, DebugSessionLifecycle, DebugWrapperSnapshot } from "./debug-types.ts";
import {
  appendClearedSessionToolSelection,
  appendSessionToolSelection,
  readSessionToolSelection,
  validateSessionToolSelection,
} from "./session-tool-selection.ts";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

/**
 * A prompt parked while a manual compaction runs. pi's SDK refuses prompts then
 * ("Cannot submit a prompt while compaction is in progress"), so the wrapper
 * holds the submission and flushes it FIFO at compaction end, as pi's TUI
 * `compactionQueuedMessages` does (interactive-mode.js).
 */
type ParkedPrompt = {
  message: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  /** The composer's steer / followUp; undefined: sent as a fresh prompt, parked as steer (the TUI's Enter). */
  streamingBehavior?: "steer" | "followUp";
  /** Settles the admission's `pendingPromptCount` (idempotent): on delivery, recall, Stop or a failed send. */
  settle: () => void;
  /** A flush is waiting for its admission; it stays a queue row (Recall, Stop) until then. */
  delivering?: boolean;
};

/** What Recall and Stop hand back to the composer: the texts by queue, and the parked prompts' images. */
type RecalledPrompts = {
  steering: string[];
  followUp: string[];
  images?: Array<{ data: string; mimeType: string }>;
};
/** `sessionName`: the live session's own title (its newest `session_info`), read without a disk scan; `outcome`: the fork's run outcome for the completion push. */
type AgentRunCompleteListener = (sessionId: string, sessionName: string | undefined, outcome?: SessionLastRun) => void;

type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type CustomUiComponent = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
  invalidate?: () => void;
};

type ExtensionWidgetComponent = {
  render: (width: number) => unknown;
  dispose?: () => void;
};

type ExtensionWidgetFactory = (tui: HeadlessCustomUiTui, theme: Theme) => unknown;

type ActiveExtensionWidget = {
  key: string;
  component: ExtensionWidgetComponent;
  placement: "aboveEditor" | "belowEditor";
  generation: number;
  clearEmitted: boolean;
  rendered: boolean;
};

type ActiveCustomUi = {
  component: CustomUiComponent;
  width: number;
  resolve: (value: unknown) => void;
  settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

type ExtensionCommandContextActionsLike = {
  waitForIdle: () => Promise<void>;
  newSession: () => Promise<{ cancelled: boolean }>;
  fork: () => Promise<{ cancelled: boolean }>;
  navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
  switchSession: () => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

// `debugSnapshot` is optional: a host built before a hot reload lacks it.
type WrapperMcpHost = Pick<McpHost, "prepareForPrompt" | "dispose"> & Partial<Pick<McpHost, "debugSnapshot">>;

type AgentSessionWrapperOptions = {
  exactSystemPrompt?: () => string;
  chatOnly?: boolean;
  onAgentRunComplete?: AgentRunCompleteListener;
  suppressCompletionNotifications?: boolean;
  /** A subagent's wrapper: a run ended and nothing is left to do. */
  onDirectTurnSettled?: (aborted: boolean) => void;
  /** Connects the session's MCP servers before a prompt starts a run, and lets go of them when it closes (lib/mcp-host.ts). */
  mcpHost?: WrapperMcpHost;
  /** Chat only: the extension-provided model the session wanted, named when a prompt finds no model. */
  chatOnlyExtensionModel?: { provider: string; id: string };
  sideChat?: boolean;
  /**
   * The notices of what went wrong as the session started (lib/startup-issues.ts), told to every
   * stream it opens. Left out (a subagent, a side chat), the wrapper keeps none: its parent's page said them.
   */
  startupIssues?: readonly StartupIssue[];
};

/** Startup notices kept for later streams: the loader's (capped), the model, then session_start errors. */
const STARTUP_NOTICE_LIMIT = 20;

/**
 * Chat only loads no extensions, so a provider one registers is missing from its runtime (#804).
 * Said instead of "Model not found", or pi's "No API key found" for a session left without a model.
 */
function chatOnlyExtensionModelError(provider: string, modelId: string): Error {
  return new Error(
    `${provider}/${modelId} is provided by an extension, and Chat only loads no extensions. Choose another model or tool preset.`,
  );
}

export const MCP_WAIT_STOPPED_MESSAGE = "Stopped while MCP servers were connecting; the message was not sent.";

/** A running `!` command's output tail sent to the page (UTF-16 units), and how often (createBashOutputSnapshots). */
const BASH_OUTPUT_TAIL_CHARS = 16 * 1024;
const BASH_OUTPUT_INTERVAL_MS = 150;

const IDLE_RESET_EVENT_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "auto_compaction_end",
  "compaction_end",
]);

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Resolves the PI_WEB_IDLE_TIMEOUT_MS environment variable into a session idle
 * timeout in milliseconds. An unset/blank value returns the 10-minute default,
 * `0` disables idle shutdown, and positive values up to Node's timer limit
 * (2147483647 ms) are used as-is. Invalid or out-of-range values fall back to
 * the default with a console warning.
 * @param rawValue Value to parse; defaults to the environment variable.
 */
export function resolveSessionIdleTimeoutMs(
  rawValue: string | undefined = process.env.PI_WEB_IDLE_TIMEOUT_MS,
): number {
  if (rawValue !== undefined && rawValue.trim() !== "") {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2_147_483_647) return parsed;
    console.warn(`[pi-web] invalid PI_WEB_IDLE_TIMEOUT_MS "${rawValue}", falling back to 10 minutes`);
  }
  return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
}

/** Resolved once: the debug panel reads it rather than resolving the variable again, which warns. */
export const SESSION_IDLE_TIMEOUT_MS = resolveSessionIdleTimeoutMs();

const DEFAULT_SESSION_SHUTDOWN_DEADLINE_MS = 5_000;

/**
 * Resolves the PI_WEB_SHUTDOWN_DEADLINE_MS environment variable into the time
 * extensions get to handle `session_shutdown` before the wrapper disposes the
 * SDK session anyway. An unset/blank value returns the 5-second default, and
 * positive values up to Node's timer limit (2147483647 ms) are used as-is.
 * `0`, invalid and out-of-range values fall back to the default with a console
 * warning: shutdown always has a deadline.
 * @param rawValue Value to parse; defaults to the environment variable.
 */
export function resolveSessionShutdownDeadlineMs(
  rawValue: string | undefined = process.env.PI_WEB_SHUTDOWN_DEADLINE_MS,
): number {
  if (rawValue !== undefined && rawValue.trim() !== "") {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 2_147_483_647) return parsed;
    console.warn(`[pi-web] invalid PI_WEB_SHUTDOWN_DEADLINE_MS "${rawValue}", falling back to 5 seconds`);
  }
  return DEFAULT_SESSION_SHUTDOWN_DEADLINE_MS;
}

const SESSION_SHUTDOWN_DEADLINE_MS = resolveSessionShutdownDeadlineMs();

/** Bounds `set_model`'s offline provider refresh, as pi's model selector bounds its own. */
const MODEL_REFRESH_TIMEOUT_MS = 15_000;

const SESSION_REPLACEMENT_COMMAND_TYPES = new Set(["fork", "clone"]);
// pi writes a session file at the first user message, so a session with no
// conversation on disk has nothing to copy from yet.
const UNSAVED_SESSION_FORK_ERROR =
  "This session has not been saved yet. Send a message before forking it.";
const COMMANDS_ALLOWED_DURING_SESSION_REPLACEMENT = new Set([
  "get_state",
  "get_session_stats",
  "get_last_assistant_text",
  "get_tools",
  "get_commands",
  "extension_ui_response",
  "extension_ui_input",
]);

export interface RpcSessionStartOptions {
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  allowInitialModelFallback?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Skips the single-writer red-line master gate (the ownsFile bridge-occupancy check). Files forked out by subagents are always local — use this for them. */
  skipBridgeCheck?: boolean;
  /**
   * Subagent mode: after creation, inject the agent definition's systemPrompt
   * and narrow tools on demand (excludeTools).
   * A subagent session reuses the full session-creation flow
   * (persistence/indexing/stats/extension notifications), just carrying a
   * parent marker.
   */
  subagent?: {
    /** The subagent agent definition's system prompt (overrides the default systemPrompt) */
    systemPrompt?: string;
    /** Tool blocklist (default all on = inherit all system/extension tools) */
    excludeTools?: string[];
  };
  /**
   * Per-session force-enabled extension agent tools: at session creation these
   * extensions are let through **ignoring feature gating** entirely.
   * For "enable on demand" (e.g. AI-helper help points) — no dependence on
   * mutating global feature state (no races, no leftovers).
   */
  enableExtTools?: string[];
}

const CODING_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const THINKING_LEVEL_NAMES = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
// The SDK's DEFAULT_THINKING_LEVEL (dist/core/defaults.js), which it does not export.
const SDK_DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);

/**
 * Trash entry count cap: input-clear entries can carry image base64 (a
 * single image can reach several MB), so a cap is required to keep the
 * sidecar file from ballooning (synchronously writeFileSync-ing large files
 * would block the event loop — a server-side red line).
 * Past the cap the oldest entries are dropped (FIFO); also applies to
 * soft-deleted queue entries (global protection).
 */
const QUEUE_TRASH_MAX_ENTRIES = 30;

// Tools that belong to the session, not to a branch of it: the ones that reach other tools,
// and pi-web's subagent tools, which the built-in subagent setting switches on for the whole
// session. Navigation keeps them although the target branch was recorded without them.
const SESSION_TOOL_NAMES = new Set<string>(["codemode", "tool_search", ...SUBAGENT_CONTROL_TOOL_NAMES]);

/**
 * The active tools for a coding tool selection. The selection replaces only the coding
 * tools: every other tool named in `carry` that is still registered and not withdrawn stays
 * active, so a tool an extension, `tool_search`, or `defaultTools` activated survives, and a
 * tool one switched off stays off. Nothing else is added: pi itself activates the extension
 * tools it registers (all of them when it builds or reloads a session, then each new one), so
 * `carry` already holds them. An empty selection is Chat only.
 *
 * Order follows `carry`, the order the `pi` CLI declares for the same set: regrouping the
 * coding tools ahead rewrites the prompt's `<tools>` section and drops the provider's prompt
 * cache on every harness switch (#1405). Newly selected coding tools go at the end.
 */
export function resolveActiveToolNames(
  session: AgentSessionLike,
  requested: readonly string[],
  carry: readonly string[],
): string[] {
  if (requested.length === 0) return [];

  const codingToolNames = new Set(CODING_TOOL_NAMES);
  const registered = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
  const selectedToolNames = resolveShellTools(
    requested.filter((name) => codingToolNames.has(name)),
    session.settingsManager.getDefaultTools(),
  );
  const carriedToolNames = carry.filter((name) => {
    if (codingToolNames.has(name)) return selectedToolNames.includes(name);
    const tool = registered.get(name);
    return tool !== undefined && tool.exposure !== "hidden";
  });

  return [...new Set([...carriedToolNames, ...selectedToolNames])];
}

/** pi's "Cannot submit a prompt while compaction is in progress" rejection. */
function isCompactionInProgressError(error: unknown): boolean {
  return error instanceof Error && /compaction is in progress/i.test(error.message);
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

/** Why a wrapper is being torn down. "shutdown" = the session is truly over
 *  (DELETE route, global teardown); "idle" = 10-min idle GC (the file survives,
 *  a fresh wrapper is created on next access); "fork" = legacy value kept for
 *  compatibility — the old replacement-style fork/clone used to drop the
 *  wrapper in this scenario; since 2026-09-13 fork/clone no longer recycle
 *  the source wrapper (a running turn must not be interrupted), so nothing
 *  produces it today. Extension end-hooks receive this so they can tell
 *  "session gone" from "wrapper recycled". */
export type AgentWrapperEndReason = "shutdown" | "fork" | "idle";

export class AgentSessionWrapper {
  // A Set, not an array: an SSE stream unsubscribes from inside emit() when it
  // closes on session_shutdown, and splicing an array mid-iteration made the
  // next stream miss that same event.
  private listeners = new Set<EventListener>();
  private activeToolEvents = new Map<string, AgentEvent>();
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionUiAbortController = new AbortController();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private activeExtensionWidgets = new Map<string, ActiveExtensionWidget>();
  private extensionWidgetGenerations = new Map<string, number>();
  private extensionWidgetsResetting = false;
  private pendingPromptCount = 0;
  /** True while runAgentContinue is delivering a queued follow-up as a prompt. */
  private promptRunning = false;
  /** Prompts that reached send() and wait on the extensions or their admission, not counted yet. */
  private arrivingPromptCount = 0;
  // Prompts waiting for the running compaction to finish (ParkedPrompt above).
  private parkedDuringCompaction: ParkedPrompt[] = [];
  private activeMutatingCommands = 0;
  private sessionReplacement: "fork" | "clone" | null = null;
  private agentRunNeedsCompletion = false;
  // Whether the last run ended because it was stopped (pi 1.1's `agent_settled.aborted`), not finished.
  private lastRunAborted = false;
  private promptAdmissionTail: Promise<void> = Promise.resolve();
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private readonly exactSystemPrompt?: () => string;
  private readonly chatOnly: boolean;
  private readonly onAgentRunComplete?: AgentRunCompleteListener;
  private readonly onDirectTurnSettled?: (aborted: boolean) => void;
  private readonly suppressCompletionNotifications: boolean;
  private readonly mcpHost?: WrapperMcpHost;
  private readonly chatOnlyExtensionModel?: { provider: string; id: string };
  private readonly sideChat: boolean;
  private mcpHostDisposed = false;
  // The MCP wait of the prompt being admitted; Stop ends it.
  private mcpPromptWait: { controller: AbortController; done: Promise<void> } | null = null;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Queue persistence & crash recovery — see lib/queue-store.ts.
  // queueMirror mirrors pi's live steer/follow-up queue (with images).
  // queueRecovery holds sidecar entries orphaned by a previous wrapper
  // lifetime; they are surfaced to the UI and never auto-delivered.
  // queueTrash holds soft-deleted entries (recoverable from the trash bin
  // until the user purges them permanently).
  private queueMirror: QueueEntry[] = [];
  private queueRecovery: QueueEntry[] = [];
  private queueTrash: QueueEntry[] = [];
  private pendingQueueHints: Record<QueueKind, QueueImage[][]> = { steer: [], followUp: [], composer: [] };
  // Plan M: whether this run produced an assistant message carrying text.
  // agent_settled fires unconditionally (finally), while
  // getLastAssistantText() skips "aborted with no content" messages and falls
  // back to the previous turn's final answer — without this flag, a turn
  // aborted immediately would push the previous turn's answer to extensions
  // as this turn's answer.
  private runProducedAssistantText = false;
  private onDestroyCallback: ((reason: AgentWrapperEndReason) => void) | null = null;
  private agentSessionEndCallback: ((reason: AgentWrapperEndReason) => void) | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private sessionShutdownEmitted = false;
  private forceShutdownOnIdle = false;
  /** Stop's forced shutdown waits out a `!` command too (`abort_bash`); a run's Stop, only the run. */
  private forceShutdownCoversShell = false;
  // What went wrong as the session started, told to each stream under the same ids (the page
  // shows each once); null on a subagent's or side chat's wrapper.
  private readonly startupNotices: AgentEvent[] | null;
  /** A `!` command waiting on its `user_bash` handlers, before pi counts it as running. */
  private userBashPending = false;
  // The armed idle timer is the forced cleanup Stop scheduled.
  private forcedIdleTimerArmed = false;
  private _alive = true;
  /** Plan M: whether extension session hooks have been dispatched (filter marker for reload re-attachment; subagent wrappers do not dispatch). */
  private agentSessionHooksDispatched = false;
  private resolveDisposed: () => void = () => {};
  private readonly disposed = new Promise<void>((resolve) => { this.resolveDisposed = resolve; });
  // Set when shutdown() starts. The SDK session stays usable until destroy(),
  // but lookups must treat the wrapper as gone from this point on.
  private closing = false;
  // Bookkeeping for the debug panel (getDebugSnapshot()): times and type names only, written
  // beside the code they describe and read nowhere else.
  private readonly createdAt = Date.now();
  private startedAt: number | null = null;
  private closingAt: number | null = null;
  // When the armed idle timer fires; idleTimer itself is never set back to null.
  private idleDeadlineAt: number | null = null;
  private idleLastResetAt: number | null = null;
  private lastEventType: string | null = null;
  private lastEventAt: number | null = null;
  private lastCommandType: string | null = null;
  private lastCommandAt: number | null = null;

  constructor(
    public readonly inner: AgentSessionLike,
    options: AgentSessionWrapperOptions = {},
  ) {
    this.exactSystemPrompt = options.exactSystemPrompt;
    this.chatOnly = options.chatOnly ?? false;
    this.onAgentRunComplete = options.onAgentRunComplete;
    this.onDirectTurnSettled = options.onDirectTurnSettled;
    this.suppressCompletionNotifications = options.suppressCompletionNotifications ?? false;
    this.mcpHost = options.mcpHost;
    this.chatOnlyExtensionModel = options.chatOnlyExtensionModel;
    this.sideChat = options.sideChat === true;
    this.startupNotices = options.startupIssues ? [] : null;
    for (const issue of options.startupIssues ?? []) this.notifyIssue(issue);
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  get cwd(): string {
    return this.inner.sessionManager.getCwd();
  }

  get streamingMessage() {
    return this.inner.agent.state?.streamingMessage;
  }

  get isStreaming(): boolean {
    return this.inner.isStreaming;
  }

  /**
   * False from the moment shutdown() or destroy() begins, not only once the SDK
   * session is disposed: extensions may take up to the shutdown deadline to
   * handle session_shutdown, and a prompt routed here meanwhile would be lost.
   */
  isAlive(): boolean {
    return this._alive && !this.closing;
  }

  /**
   * A running `!` command's output for the page, as pi's TUI draws it while it runs:
   * the tail (`BASH_OUTPUT_TAIL_CHARS`) at most every `BASH_OUTPUT_INTERVAL_MS`, as
   * `bash_output` snapshots a later one replaces, never pi's per-chunk deltas, which a
   * command printing megabytes would pile up in a slow stream.
   */
  private createBashOutputSnapshots(command: string): { onChunk: (chunk: string) => void; stop: () => void } {
    let tail = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    return {
      onChunk: (chunk) => {
        tail = (tail + chunk).slice(-BASH_OUTPUT_TAIL_CHARS);
        // A cut through a surrogate pair would start the tail with half a character.
        if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          this.emit({ type: "bash_output", command, output: tail } as unknown as AgentEvent);
        }, BASH_OUTPUT_INTERVAL_MS);
      },
      stop: () => {
        if (timer) clearTimeout(timer);
        timer = null;
      },
    };
  }

  /** A `!` command is under way: its `user_bash` handlers, or pi running it. */
  private get shellRunning(): boolean {
    return this.inner.isBashRunning || this.userBashPending;
  }

  isRunning(): boolean {
    return this._alive && (this.pendingPromptCount > 0 || this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.shellRunning);
  }

  /** This run's final state (last assistant message, judged in memory) —
   * agent_settled text gating and completion-notice routing share the same
   * rule (lib/run-outcome.ts, same source as the file-based derivation).
   * AgentSessionLike does not declare messages; narrowed locally here (the
   * underlying SDK has that getter). */
  private lastRunOutcome(): SessionLastRun | undefined {
    const messages = (this.inner as {
      messages?: Array<{ role?: string; stopReason?: string; errorMessage?: string; timestamp?: number }>;
    }).messages;
    return deriveRunOutcome(messages, new Date().toISOString());
  }

  /**
   * True while an extension's blocking dialog is unanswered: select, confirm,
   * input, editor, or a custom overlay still open. The run is parked on a promise
   * only the user can settle, so the sidebar shows awaiting input rather than the
   * running spinner. Never true for an idle session: a custom overlay that
   * outlives its turn is not a parked run.
   */
  isAwaitingInput(): boolean {
    if (!this.isRunning()) return false;
    for (const request of this.pendingUiRequests.values()) {
      if (isBlockingExtensionUiRequest(request as unknown as ExtensionUiRequest)) return true;
    }
    return false;
  }

  /**
   * A page that has this session selected renews it (POST /api/agent/[id]/lease): the idle
   * countdown starts over at the full timeout, so a closed tab's session is reaped one idle
   * timeout after its last renewal. Not a command: lastCommand and the mutating count stay as
   * they are. A closing wrapper gets no new timer, and resetIdleTimer() leaves Stop's forced
   * deadline where it is.
   */
  renewIdleTimer(): void {
    if (!this.isAlive()) return;
    this.resetIdleTimer();
  }

  /**
   * Drop this idle wrapper when the on-disk JSONL has an entry the in-memory
   * index never saw (another pi process appended). Rechecks isRunning() so a
   * prompt that started during the probe cannot be disposed.
   */
  evictIfDiskAhead(): boolean {
    if (!this.isAlive() || this.isRunning()) return false;
    const diskLatestId = readLatestSessionEntryId(this.sessionFile);
    if (!diskLatestId || this.inner.sessionManager.getEntry(diskLatestId)) return false;
    if (this.isRunning()) return false;
    this.destroy();
    invalidateSessionListCache();
    return true;
  }

  isChatOnly(): boolean {
    return this.chatOnly;
  }

  hasSuppressedCompletionNotifications(): boolean {
    return this.suppressCompletionNotifications;
  }

  /**
   * What the debug panel shows of this wrapper: its fields and the SDK's plain getters, as
   * counts, flags and times. Never send(): that moves the idle timer, waits for extensions and
   * renders the system prompt.
   */
  getDebugSnapshot(): DebugWrapperSnapshot {
    const inner = this.inner;
    return {
      sessionId: this.sessionId,
      state: this.isAlive() ? "alive" : "closing",
      stale: false,
      subagent: this.suppressCompletionNotifications,
      chatOnly: this.chatOnly,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      closingAt: this.closingAt,
      extensions: this.extensionBindingError !== null
        ? "failed"
        : this.extensionsBound
          ? "bound"
          : this.extensionBindingPromise ? "binding" : "none",
      run: {
        running: this.isRunning(),
        streaming: inner.isStreaming === true,
        promptRunning: this.pendingPromptCount > 0,
        // The running prompt holds one count until its run ends; a queued steer or follow-up
        // drops its own at once and reads in queuedMessages instead.
        pendingPrompts: Math.max(0, this.pendingPromptCount - 1),
        bashRunning: inner.isBashRunning === true,
        compacting: inner.isCompacting === true,
        retrying: inner.isRetrying === true,
        queuedMessages: typeof inner.pendingMessageCount === "number" ? inner.pendingMessageCount : 0,
        waitingForMcp: this.mcpPromptWait !== null,
        runningTools: this.activeToolEvents.size,
        mutatingCommands: this.activeMutatingCommands,
        replacement: this.sessionReplacement,
      },
      idle: {
        timeoutMs: SESSION_IDLE_TIMEOUT_MS,
        nextCheckAt: this.idleDeadlineAt,
        lastResetAt: this.idleLastResetAt,
        forcedByStop: this.forceShutdownOnIdle && this.idleDeadlineAt !== null,
      },
      awaitingInput: this.isAwaitingInput(),
      pendingUiRequests: this.pendingUiRequests.size,
      customUis: this.activeCustomUis.size,
      eventListeners: this.listeners.size,
      lastEvent: this.lastEventType !== null && this.lastEventAt !== null
        ? { type: this.lastEventType, at: this.lastEventAt }
        : null,
      lastCommand: this.lastCommandType !== null && this.lastCommandAt !== null
        ? { type: this.lastCommandType, at: this.lastCommandAt }
        : null,
    };
  }

  /** The MCP host's state for the debug panel; null without a host (Chat only, MCP unavailable). */
  getMcpDebugSnapshot(): DebugMcpHost | null {
    return this.mcpHost?.debugSnapshot?.() ?? null;
  }

  start(): void {
    this.startedAt = Date.now();
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      this.lastEventType = typeof event.type === "string" ? event.type : null;
      this.lastEventAt = Date.now();
      if (event.type === "agent_start") {
        this.agentRunNeedsCompletion = true;
        this.lastRunAborted = false;
      }
      if (event.type === "agent_settled") this.lastRunAborted = event.aborted === true;
      if (event.type === "agent_end") {
        invalidateSessionListCache();
        // Every tool call of the run has finished; nothing is left to replay.
        this.activeToolEvents.clear();
      }
      if (event.type === "queue_update") {
        this.reconcileQueue(
          (event as { steering?: string[] }).steering,
          (event as { followUp?: string[] }).followUp,
        );
      }
      // A name from setSessionName(), an extension's included: a title generated
      // in the background lands after the run's agent_end, a command's with no
      // run at all, and the sidebar would keep the old one (#1237).
      if (event.type === "session_info_changed") invalidateSessionListCache();
      this.trackActiveToolEvent(event);
      // Plan M: record whether this run produced an assistant message carrying
      // text (see the field comment). Event-driven (not
      // prompt-command-driven) — extension-initiated runs go through the same
      // subscription.
      if (event.type === "message_end") {
        const m = (event as { message?: { role?: string; content?: Array<{ type?: string; text?: string }> } }).message;
        if (m?.role === "assistant" && (m.content ?? []).some((c) => c.type === "text" && (c.text ?? "").trim().length > 0)) {
          this.runProducedAssistantText = true;
        }
      }
      // Plan M: an agent turn finished → dispatch the final answer to
      // extensions (e.g. the devtools extension relaying it back to its AI
      // window). Dispatch only if this turn actually produced assistant text;
      // zero-output turns (immediate abort, error with no output) must not
      // push the previous turn's answer as this turn's.
      if (event.type === "agent_settled") {
        const produced = this.runProducedAssistantText;
        this.runProducedAssistantText = false;
        // A run whose last assistant message ended in "error" (API failure
        // mid-stream, retries exhausted, …) did not produce a usable answer —
        // its partial stream text must not be dispatched as the final one.
        // "aborted" partial text stays dispatchable: the user chose to stop,
        // and the text shown so far is what the agent actually said. Settled
        // fires only after the whole loop (retries included), so a pending
        // retry never races this check.
        const failed = this.lastRunOutcome()?.status === "failed";
        const text = produced && !failed ? this.inner.getLastAssistantText() ?? "" : "";
        if (text) {
          try { getExtRegistry().dispatchAgentSettled(this.sessionId, text); } catch (e) { console.error("[pi-web] agent_settled dispatch failed:", e instanceof Error ? e.message : e); }
        }
      }
      if (event.type === "compaction_end") {
        // Prompts submitted while compaction was running were queued as
        // follow-ups (pi rejects prompts during compaction). Compaction is
        // over — kick off a run so they are delivered instead of sitting in
        // the queue. When compaction ran inside an active run loop
        // (auto-compaction), runAgentContinue's guards skip this and pi
        // continues on its own (it already checks hasQueuedMessages()).
        void this.runAgentContinue();
      }
      if (IDLE_RESET_EVENT_TYPES.has(event.type)) this.resetIdleTimer();
      if (event.type === "compaction_end") {
        // Prompts parked while compaction ran go out now, FIFO, whatever its outcome (as the TUI).
        this.flushParkedPrompts();
      }
      this.emit(
        event.type === "message_end" ? this.withTranscriptNotices(event)
          : event.type === "agent_settled" ? this.withSubagentsActive(event)
            : event,
      );
      if (event.type === "agent_settled") this.notifyAgentRunCompleteIfIdle();
    });
    this.resetIdleTimer();
  }

  // ==========================================================================
  // Queue persistence & crash recovery
  //
  // pi keeps its steering/follow-up queues in memory only. We mirror every
  // queue mutation to a per-session sidecar file so that after a server
  // restart the messages can be offered for manual recovery instead of being
  // lost. Recovery is NEVER automatic: sidecar entries are surfaced to the UI
  // (pendingRecovery) and the user decides to re-queue, discard, or export.
  // ==========================================================================

  /**
   * Load entries the sidecar inherited from a previous process (or a previous
   * wrapper lifetime after the 10-minute idle timeout).
   */
  loadQueueRecovery(): void {
    const file = this.sessionFile;
    if (!file) return;
    const { entries, trash } = loadQueueFile(file);
    // Trash is independent of pi's live queue — always restore it so entries
    // soft-deleted before a restart (or a hot reload) stay recoverable.
    this.queueTrash = trash;
    // Defensive consistency check: pi's steering/follow-up queues live in the
    // same process as this wrapper, and a brand-new AgentSession always starts
    // with empty queues. If pi already has queued messages here, the queue
    // survived (hot reload reused the runtime, future architecture change, …)
    // and the sidecar is just an older mirror. In that case skip recovery and
    // resync the mirror from pi instead of offering duplicate entries.
    const liveSteering = this.inner.getSteeringMessages();
    const liveFollowUp = this.inner.getFollowUpMessages();
    if (liveSteering.length > 0 || liveFollowUp.length > 0) {
      this.queueRecovery = [];
      this.reconcileQueue([...liveSteering], [...liveFollowUp]);
      return;
    }
    if (entries.length > 0) {
      this.queueRecovery = entries;
      console.log(
        `[pi-web] ${entries.length} queued message(s) pending recovery for session ${this.sessionId}`,
      );
    }
  }

  private getSidecarEntries(): QueueEntry[] {
    return [...this.queueRecovery, ...this.queueMirror];
  }

  private persistQueue(): void {
    const file = this.sessionFile;
    if (!file) return;
    const entries = this.getSidecarEntries();
    if (entries.length === 0 && this.queueTrash.length === 0) {
      removeQueue(file);
      return;
    }
    saveQueue(file, entries, this.queueTrash);
  }

  private getQueueTrashView(): QueueTrashItem[] {
    return this.queueTrash.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      text: entry.text,
      hasImages: Boolean(entry.images?.length),
      queuedAt: entry.queuedAt,
    }));
  }

  /** Parallel queue attachment markers (same indexes as the steering/followUp
   *  arrays): used for queue-row attachment icons.
   *  pi's queue_update/queue reads report text only; attachments live solely
   *  in the local queueMirror — when the text projection reads pi's live
   *  queue, attachment markers come from the mirror (lengths can briefly
   *  mismatch in a race; the frontend reads by index and treats out-of-range
   *  as false, which is safe). */
  private getQueueAttachmentView(): { steeringHasImages: boolean[]; followUpHasImages: boolean[] } {
    return {
      steeringHasImages: this.queueMirror.filter((e) => e.kind === "steer").map((e) => Boolean(e.images?.length)),
      followUpHasImages: this.queueMirror.filter((e) => e.kind === "followUp").map((e) => Boolean(e.images?.length)),
    };
  }

  private getPendingRecoveryView(): PendingRecoveryItem[] {
    return this.queueRecovery.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      text: entry.text,
      hasImages: Boolean(entry.images?.length),
      queuedAt: entry.queuedAt,
    }));
  }

  /**
   * Record an incoming queueable message so its image attachments survive
   * mirroring. pi reports queued messages by text only and template expansion
   * may rewrite the text, so hints are consumed FIFO per kind.
   */
  private hintQueueImages(kind: QueueKind, images: QueueImage[] | undefined): void {
    this.pendingQueueHints[kind].push(images && images.length > 0 ? images : []);
  }

  /**
   * True when the text is a registered extension command (`/name ...`). Used
   * to route slash commands during compaction: extension commands execute
   * immediately via prompt(), everything else is queued as a follow-up.
   */
  private isRegisteredExtensionCommand(text: string): boolean {
    if (!text.startsWith("/")) return false;
    const name = text.slice(1).split(/\s/)[0];
    try {
      return this.inner.extensionRunner.getRegisteredCommands().some((c) => c.invocationName === name);
    } catch {
      return false;
    }
  }

  /**
   * Sync the mirror with pi's authoritative queue (text-only). Bare entries pi
   * reports that we have never mirrored consume image hints FIFO.
   */
  private reconcileQueue(steering: string[] | undefined, followUp: string[] | undefined): void {
    const rebuild = (kind: QueueKind, texts: string[] | undefined): QueueEntry[] => {
      if (!texts) return this.queueMirror.filter((entry) => entry.kind === kind);
      const used = new Set<QueueEntry>();
      return texts.map((text) => {
        const match = this.queueMirror.find(
          (entry) => entry.kind === kind && entry.text === text && !used.has(entry),
        );
        if (match) {
          used.add(match);
          return match;
        }
        const entry = createQueueEntry(kind, text, this.pendingQueueHints[kind].shift());
        used.add(entry);
        return entry;
      });
    };
    this.queueMirror = [
      ...rebuild("steer", steering),
      ...rebuild("followUp", followUp),
    ];
    this.persistQueue();
  }

  /** Re-queue a recovered or imported entry into the live queue. */
  private async requeueEntry(entry: QueueEntry): Promise<void> {
    this.hintQueueImages(entry.kind, entry.images);
    try {
      if (entry.kind === "steer") {
        await this.inner.steer(entry.text, entry.images);
      } else {
        await this.inner.followUp(entry.text, entry.images);
      }
    } catch (error) {
      console.error(
        `[pi-web] requeueEntry failed kind=${entry.kind} text=${JSON.stringify(entry.text?.slice(0, 80))}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Ensure the entry is present in the mirror (queue_update may race). Called
   * after requeue/import so the sidecar is never missing a re-queued message.
   */
  private ensureMirrored(entry: QueueEntry): void {
    const existing = this.queueMirror.find(
      (e) => e.kind === entry.kind && e.text === entry.text,
    );
    if (existing) return;
    this.queueMirror.push({ ...entry });
    // No queue_update consumed the image hint (yet) — drop the one we pushed in
    // requeueEntry so it cannot attach to an unrelated future entry.
    this.pendingQueueHints[entry.kind].pop();
  }

  /**
   * Kick off processing of the live queue when the agent is idle.
   *
   * Used by two triggers: (1) the recovery dialog's "re-queue & continue"
   * and (2) the compaction_end listener — prompts submitted while compaction
   * ran were queued as follow-ups and must be delivered now that compaction
   * finished (pi rejects prompts during compaction, so the message would
   * otherwise sit idle forever after a manual compaction).
   *
   * Re-queuing/import only enqueues entries into pi's steer/followUp queues
   * (exactly like the steer/followUp commands do) — it never starts a run.
   * When the user asks to "re-queue & continue" we need to start a run so
   * pi's own agent loop drains the queue.
   *
   * pi's agent loop (agent-loop runLoop) checks getFollowUpMessages() after
   * every turn and its PendingMessageQueue drains one-at-a-time by default,
   * so queued entries run sequentially after the first prompt finishes. We
   * only fire ONE prompt with the first queued entry; the rest are re-queued
   * into pi and pi processes them in order. queue_update events fire as each
   * entry is drained so the frontend count ticks down.
   */
  private async runAgentContinue(): Promise<void> {
    if (this.inner.isStreaming || this.inner.isBashRunning || this.promptRunning) return;
    // pi rejects prompt() while compaction runs. If a caller races in during
    // compaction, leave the queue alone — the compaction_end listener calls
    // this again once pi can accept prompts.
    if (this.inner.isCompacting) return;
    const all = [...this.queueMirror];
    if (all.length === 0) return;
    const first = all[0];
    const rest = all.slice(1);
    // Send the first entry as a prompt, then re-queue the rest into pi's
    // followUp/steer queues. pi's queue mode is one-at-a-time, so its agent
    // loop drains the remaining entries one by one after the first turn —
    // exactly the "run one, queue the rest, pi continues them" behavior the
    // user expects. queue_update events fire as each entry is drained so the
    // frontend count ticks down.
    // IMPORTANT: await each steer/followUp call — they are async internally
    // (they emit queue_update) and prompt(first) below must see the rest
    // already in pi's queue, otherwise the agent loop drains nothing and the
    // remainder never runs.
    this.inner.clearQueue();
    this.pendingQueueHints = { steer: [], followUp: [], composer: [] };
    for (const e of rest) {
      this.hintQueueImages(e.kind, e.images);
      if (e.kind === "steer") {
        await this.inner.steer(e.text, e.images?.length ? e.images : undefined);
      } else {
        await this.inner.followUp(e.text, e.images?.length ? e.images : undefined);
      }
    }
    this.queueMirror = [...rest];
    this.persistQueue();
    this.promptRunning = true;
    notifyRunningChange();
    void this.bootstrapQueuedRun(first);
  }

  private async bootstrapQueuedRun(first: QueueEntry): Promise<void> {
    // Send the first queued entry as a prompt. pi's _runAgentPrompt then runs
    // `while (_handlePostAgentRun()) continue();` which drains any remaining
    // followUp/steer entries from pi's queue automatically — same as a normal
    // prompt that had messages queued during it. We do NOT iterate ourselves.
    try {
      await this.inner.prompt(
        first.text,
        first.images?.length ? { images: first.images } : undefined,
      );
    } catch (error: unknown) {
      this.promptRunning = false;
      this.resetIdleTimer();
      invalidateSessionListCache();
      // Restore the failed entry to the mirror so the user can retry instead
      // of losing it.
      this.queueMirror = [first, ...this.queueMirror];
      this.persistQueue();
      this.emit({
        type: "prompt_error",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.emit({ type: "prompt_done" });
      notifyRunningChange();
      return;
    }
    this.promptRunning = false;
    this.resetIdleTimer();
    this.emit({ type: "prompt_done" });
    notifyRunningChange();
  }

  private forceEmptySystemPrompt = false;

  setForceEmptySystemPrompt(force: boolean): void {
    this.forceEmptySystemPrompt = force;
    this.applyForcedEmptySystemPrompt();
  }

  private applyForcedEmptySystemPrompt(): void {
    const agentState = this.inner.agent.state;
    if (this.forceEmptySystemPrompt && agentState) {
      // SDK 1.1.0: state.systemPrompt is a read-only getter replaying the leading
      // system message — rewrite that message's content (the messages array is live).
      const lead = agentState.messages?.[0] as { role: string; content: unknown } | undefined;
      if (lead && lead.role === "system") lead.content = "";
    }
  }

  /**
   * An assistant `message_end` with the notices pi's TUI shows under
   * `showCacheMissNotices` (#1265), as `transcriptNotices` beside the message.
   * The message itself is left alone: pi writes that object to the file.
   */
  private withTranscriptNotices(event: AgentEvent): AgentEvent {
    const message = event.message as { role?: unknown } | undefined;
    if (this.listeners.size === 0 || message?.role !== "assistant") return event;
    try {
      const manager = this.inner.sessionManager;
      if (!readShowCacheMissNotices(manager.getCwd())) return event;
      const entries = manager.getEntries() as unknown as SessionEntry[];
      const notices = collectLiveAssistantNotices(
        entries,
        manager.getBranch() as unknown as SessionEntry[],
        message,
        withSessionPrices(entries, this.inner.modelRuntime),
      );
      return notices.length > 0 ? { ...event, transcriptNotices: notices } : event;
    } catch (error) {
      console.warn("[pi-web] transcript notices failed:", error instanceof Error ? error.message : error);
      return event;
    }
  }

  /**
   * Keep the latest start or update of each running tool call for onEvent() to
   * replay. Calls a tool makes itself (a codemode script's, which carry
   * `parentToolCallId`) are left out: a reconnecting client would show each as a
   * top-level tool, and the parent's own update already reports them. A nested
   * end can still arrive after its parent's, and is ignored like the rest.
   */
  private trackActiveToolEvent(event: AgentEvent): void {
    const toolCallId = event.toolCallId;
    if (typeof toolCallId !== "string" || isNestedToolExecutionEvent(event)) return;
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
      this.activeToolEvents.set(toolCallId, event);
    } else if (event.type === "tool_execution_end") {
      this.activeToolEvents.delete(toolCallId);
      const nestedPrefix = `${toolCallId}/`;
      for (const id of this.activeToolEvents.keys()) {
        if (id.startsWith(nestedPrefix)) this.activeToolEvents.delete(id);
      }
    }
  }

  private notifyAgentRunCompleteIfIdle(): void {
    if (!this.agentRunNeedsCompletion || this.isRunning()) return;
    this.agentRunNeedsCompletion = false;
    try {
      this.onDirectTurnSettled?.(this.lastRunAborted);
    } catch (error) {
      console.error("[pi-web] could not settle the subagent turn:", error instanceof Error ? error.message : error);
    }
    // A stopped run did not finish a task, as pi's own status reporting has it: nothing to announce.
    if (this.suppressCompletionNotifications || this.lastRunAborted) return;
    // A subagent of this session is still at work: each report starts a run here, and the run
    // after the last one is the end of the task (#1434).
    if (hasUnsettledSubagentRun(this.sessionId)) return;
    try {
      this.onAgentRunComplete?.(this.sessionId, this.inner.sessionManager.getSessionName(), this.lastRunOutcome());
    } catch (error) {
      console.error("[pi-web] completion listener failed:", error instanceof Error ? error.message : error);
    }
  }

  /**
   * `prompt_done`, saying `aborted` when the prompt's run was stopped rather than finished, and
   * `subagentsActive` while a subagent under this session can still start another run here.
   */
  private promptDoneEvent(): AgentEvent {
    return this.withSubagentsActive({ type: "prompt_done", ...(this.lastRunAborted ? { aborted: true } : {}) });
  }

  /** The end of a run of this session's, marked when its subagents keep the task going: no chime yet. */
  private withSubagentsActive(event: AgentEvent): AgentEvent {
    return hasUnsettledSubagentRun(this.sessionId) ? { ...event, subagentsActive: true } : event;
  }

  /** Parked prompts as queue rows: a plain one is a steer, as the TUI parks Enter during compaction. */
  private parkedQueueMessages(entries: readonly ParkedPrompt[]): { steering: string[]; followUp: string[] } {
    const steering: string[] = [];
    const followUp: string[] = [];
    for (const entry of entries) {
      (entry.streamingBehavior === "followUp" ? followUp : steering).push(entry.message);
    }
    return { steering, followUp };
  }

  /** pi's own queue plus the prompts parked during compaction, as the TUI's `getAllQueuedMessages()`. */
  private mergedQueuedMessages(): { steering: string[]; followUp: string[] } {
    const parked = this.parkedQueueMessages(this.parkedDuringCompaction);
    return {
      steering: [...this.inner.getSteeringMessages(), ...parked.steering],
      followUp: [...this.inner.getFollowUpMessages(), ...parked.followUp],
    };
  }

  private emitQueueUpdate(): void {
    this.emit({ type: "queue_update", ...this.mergedQueuedMessages() });
  }

  private parkDuringCompaction(entry: ParkedPrompt): void {
    this.parkedDuringCompaction.push(entry);
    this.emitQueueUpdate();
  }

  /**
   * Take every parked prompt back (Recall, Stop), those a flush has not handed to
   * the SDK yet included: their admissions settle, the texts and images return to
   * the composer.
   */
  private recallParkedPrompts(): RecalledPrompts {
    const parked = this.parkedDuringCompaction;
    if (parked.length === 0) return { steering: [], followUp: [] };
    this.parkedDuringCompaction = [];
    for (const entry of parked) entry.settle();
    this.emitQueueUpdate();
    // A plain prompt's client waits for prompt_done; nothing ran.
    if (parked.some((entry) => entry.streamingBehavior === undefined)) this.emit({ type: "prompt_done", aborted: true });
    const images = parked.flatMap((entry) => entry.images ?? []).map(({ data, mimeType }) => ({ data, mimeType }));
    return { ...this.parkedQueueMessages(parked), ...(images.length ? { images } : {}) };
  }

  /**
   * Deliver the prompts parked while compaction ran, FIFO: pi's TUI
   * `flushCompactionQueue()` in the wrapper. Each goes through the prompt
   * admission chain like any prompt, so the SDK decides start-or-join for one
   * submission at a time and a prompt sent after compaction_end queues behind
   * them. Each carries a `streamingBehavior` (a plain one as steer), so the
   * first starts a run when idle and the rest join it. An entry stays listed
   * until its delivery holds admission, so Recall and Stop still take it back.
   */
  private flushParkedPrompts(): void {
    for (const entry of this.parkedDuringCompaction) {
      if (entry.delivering) continue;
      entry.delivering = true;
      void this.deliverParkedPrompt(entry);
    }
  }

  private async deliverParkedPrompt(entry: ParkedPrompt): Promise<void> {
    const releaseAdmission = await this.acquirePromptAdmission();
    entry.delivering = false;
    const index = this.parkedDuringCompaction.indexOf(entry);
    if (index === -1) {
      // Recalled (Recall, Stop) while it waited.
      releaseAdmission();
      return;
    }
    this.parkedDuringCompaction.splice(index, 1);
    this.emitQueueUpdate();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseAdmission();
    };
    let disposition: "handled" | "queued" | "started" | undefined;
    let failure: unknown;
    try {
      await this.inner.prompt(entry.message, {
        ...(entry.images?.length ? { images: entry.images } : {}),
        source: "rpc",
        streamingBehavior: entry.streamingBehavior ?? "steer",
        preflightResult: (result) => {
          disposition = result;
          release();
        },
      });
    } catch (error) {
      failure = error;
    }
    release();
    if (failure !== undefined && disposition === undefined && isCompactionInProgressError(failure)) {
      // Another compaction started first: wait for that one's end.
      this.parkDuringCompaction(entry);
      return;
    }
    entry.settle();
    if (failure !== undefined) {
      // Refused unsent: keep it as a queue row for Recall or the next compaction end, as the TUI's restoreQueue().
      if (disposition === undefined) this.parkDuringCompaction(entry);
      this.emit({
        type: "prompt_error",
        errorMessage: failure instanceof Error ? failure.message : String(failure),
      });
    }
    // The client of a plain prompt waits for prompt_done; the delivery that started
    // the run sends it when that run ends, one that joined a run rides that run's.
    if (disposition === "started" || (disposition !== "queued" && entry.streamingBehavior === undefined)) {
      this.emit(this.promptDoneEvent());
    }
  }

  beginExtensionBinding(options?: { forceEmptySystemPrompt?: boolean }): void {
    if (options?.forceEmptySystemPrompt) this.setForceEmptySystemPrompt(true);
    void this.ensureExtensionsBound().catch((err) => {
      console.error("[pi-web] failed to dispatch session_start to extensions:", err instanceof Error ? err.message : err);
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForExtensionsBound();
  }

  /**
   * A subagent run prompts the SDK session directly (`lib/subagent-runtime.ts`), past `send()`:
   * connect the session's MCP servers first, as a sent prompt does, once session_start has bound
   * the host. Stop (`abort`) ends the wait as it ends a sent prompt's, and so does `signal`.
   * Resolves whether the run may start.
   */
  async prepareMcpForRun(signal: AbortSignal): Promise<boolean> {
    const mcpHost = this.mcpHost;
    if (!mcpHost || this.inner.isStreaming) return !signal.aborted;
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (signal.aborted) stop();
    signal.addEventListener("abort", stop, { once: true });
    // Registered before the binding is awaited, so a Stop meanwhile already ends it.
    const waited = (async () => {
      await this.waitForExtensionsBound();
      if (!controller.signal.aborted) await mcpHost.prepareForPrompt(controller.signal);
    })().catch((error: unknown) => {
      console.error("[pi-web] MCP servers could not be prepared:", error instanceof Error ? error.message : error);
    });
    const wait = { controller, done: waited };
    this.mcpPromptWait = wait;
    try {
      await waited;
    } finally {
      signal.removeEventListener("abort", stop);
      if (this.mcpPromptWait === wait) this.mcpPromptWait = null;
    }
    return !controller.signal.aborted;
  }

  private ensureExtensionsBound(): Promise<void> {
    if (this.extensionsBound) return Promise.resolve();
    if (this.extensionBindingPromise) return this.extensionBindingPromise;

    this.extensionBindingError = null;
    this.extensionBindingPromise = (async () => {
      if (!this._alive) return;
      const uiContext = this.createExtensionUiContext();
      if (typeof this.inner.bindExtensions === "function") {
        const bindExtensions = this.inner.bindExtensions as (bindings: {
          uiContext?: ExtensionUiContextLike;
          mode?: "rpc";
          commandContextActions?: ExtensionCommandContextActionsLike;
          shutdownHandler?: () => void;
          onError?: (error: { extensionPath: string; event: string; error: string }) => void;
        }) => Promise<void>;
        await bindExtensions.call(this.inner, {
          uiContext,
          mode: "rpc",
          commandContextActions: this.createExtensionCommandContextActions(),
          shutdownHandler: () => this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "notify",
            notifyType: "warning",
            message: "Extension requested shutdown, but shutdown is not supported in Pi Web.",
          } as ExtensionUiRequest as AgentEvent),
          onError: (error) => this.emit({
            type: "extension_error",
            extensionPath: error.extensionPath,
            event: error.event,
            error: error.error,
          }),
        });
      } else {
        this.inner.extensionRunner.setUIContext?.(uiContext, "rpc");
      }
      this.extensionsBound = true;
      console.log(`[pi-web] session_start dispatched to extensions for session ${this.inner.sessionId}`);
    })().catch((err) => {
      this.extensionBindingError = err;
      throw err;
    });

    return this.extensionBindingPromise;
  }

  private async waitForExtensionsBound(): Promise<void> {
    try {
      if (this.extensionBindingPromise) await this.extensionBindingPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.extensionBindingError) {
      throw this.extensionBindingError instanceof Error
        ? this.extensionBindingError
        : new Error(String(this.extensionBindingError));
    }
  }

  /** The session's extension commands as pi looks them up: by invocation name, with the extension's path. */
  private extensionCommandCandidates(): McpCommandCandidate[] {
    try {
      return this.inner.extensionRunner.getRegisteredCommands().map((command) => ({
        name: command.invocationName,
        sourceInfo: command.sourceInfo,
      }));
    } catch {
      // Unreadable: treat the prompt as one that may start a run, as before.
      return [];
    }
  }

  private shouldWaitForExtensions(type: string): boolean {
    return type === "prompt"
      || type === "steer"
      || type === "follow_up"
      || type === "get_commands"
      || type === "get_state";
  }

  private async withFinalIdleReset<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.resetIdleTimer();
    }
  }

  /** Apply a coding tool selection; `carry` defaults to the tools active now. */
  setActiveToolSelection(toolNames: string[], carry: readonly string[] = this.inner.getActiveToolNames()): void {
    this.inner.setActiveToolsByName(resolveActiveToolNames(this.inner, toolNames, carry));
  }

  /**
   * pi restores the target branch's loadout from its transcript when it navigates the tree,
   * which can bring back coding tools the pinned preset leaves out and drop codemode, so a
   * normal session applies its selection again when the set changed, and otherwise keeps the
   * order the prompt was in. Chat only declares no tools, and a subagent's tools are fixed by
   * its profile; both keep what pi restored.
   */
  private async navigateTreeKeepingToolSelection(
    targetId: string,
    options: { summarize?: boolean },
  ): Promise<{ cancelled: boolean }> {
    const activeBefore = this.inner.getActiveToolNames();
    const result = await this.inner.navigateTree(targetId, options);
    if (result.cancelled || this.chatOnly) return { cancelled: result.cancelled };

    const entries = this.inner.sessionManager.getEntries() as unknown as SessionEntry[];
    if (!readSubagentSessionResources(entries)) {
      const activeAfter = this.inner.getActiveToolNames();
      const isToolChanged = activeBefore.length !== activeAfter.length
        || activeBefore.some((name) => !activeAfter.includes(name));
      if (isToolChanged) {
        this.setActiveToolSelection(
          readSessionToolSelection(entries) ?? activeAfter,
          [...activeAfter, ...activeBefore.filter((name) => SESSION_TOOL_NAMES.has(name))],
        );
      }
    }
    return { cancelled: false };
  }

  /** A copy of a side chat would be read as one, or show its parent's history as a new session. */
  private refuseForkOfSideChat(): void {
    if (hasSideMetadata(this.inner.sessionManager.getEntries() as unknown as SessionEntry[])) {
      throw new Error("A side chat cannot be forked");
    }
  }

  /** The first prompt names a side chat that still has the name it started with. */
  private nameSideChat(message: unknown): void {
    if (this.inner.sessionManager.getSessionName() !== SIDE_SESSION_NAME || typeof message !== "string") return;
    const name = sideChatNameFrom(message);
    if (!name) return;
    this.inner.setSessionName(name);
    invalidateSessionListCache();
  }

  // public: acceptance-style sends (lib/agent-command-accept) re-emit prompt_error here for failures arriving after the 202
  emit(event: AgentEvent): void {
    // A session_start handler that throws as the session starts is one of its startup issues, as
    // pi's TUI shows it then: every stream the page opens hears it, not only one open at that moment.
    if (event.type === "extension_error" && event.event === "session_start" && this.startupNotices && !this.extensionsBound) {
      const message = extensionErrorMessage(event.extensionPath, String(event.error));
      console.warn(`[pi-web] session ${this.sessionId}: ${message}`);
      this.notifyIssue({ type: "error", message });
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(
          `[pi-web] failed to deliver ${event.type} event:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  private async acquirePromptAdmission(): Promise<() => void> {
    const previous = this.promptAdmissionTail;
    let release!: () => void;
    this.promptAdmissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  /**
   * Stop's forced shutdown is for what it stopped: the run (a pending prompt, streaming,
   * compacting), with `abort_bash` the `!` command too. Once that is idle, a healthy command
   * beside it keeps the normal idle timer, which leases move.
   */
  private releaseForcedShutdownOnceStopped(): void {
    const stoppedWorkRunning = this.pendingPromptCount > 0 || this.inner.isStreaming || this.inner.isCompacting
      || (this.forceShutdownCoversShell && this.shellRunning);
    if (this._alive && stoppedWorkRunning) return;
    this.forceShutdownOnIdle = false;
    this.forceShutdownCoversShell = false;
  }

  private resetIdleTimer(): void {
    if (!this._alive) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleDeadlineAt = null;
      return;
    }
    this.releaseForcedShutdownOnceStopped();
    // A stuck user reloads, reopens the session or presses Stop again, and
    // each of those commands lands here. Moving the forced deadline for them
    // would keep a run that Stop cannot unwind alive indefinitely.
    if (this.forceShutdownOnIdle && this.forcedIdleTimerArmed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // A resolved timeout of 0 disables idle shutdown, but a run that Stop could
    // not unwind is still reaped after the default delay; otherwise it stays
    // running until the server restarts (#656).
    const timeoutMs = SESSION_IDLE_TIMEOUT_MS
      || (this.forceShutdownOnIdle ? DEFAULT_SESSION_IDLE_TIMEOUT_MS : 0);
    this.forcedIdleTimerArmed = timeoutMs !== 0 && this.forceShutdownOnIdle;
    this.idleLastResetAt = Date.now();
    if (timeoutMs === 0) {
      this.idleDeadlineAt = null;
      return;
    }
    this.idleDeadlineAt = this.idleLastResetAt + timeoutMs;
    this.idleTimer = setTimeout(() => {
      this.idleDeadlineAt = null;
      if (!this.forceShutdownOnIdle && (this.isRunning() || hasActiveSessionLivenessProvider({
        sessionId: this.sessionId,
        sessionFile: this.sessionFile || undefined,
      }))) {
        this.resetIdleTimer();
        return;
      }
      // Upstream pi-subagents detached-run liveness: when the parent session
      // is idle but a background subagent is still running, the wrapper must
      // not be recycled — the completion watcher / wait subscriptions die
      // with the wrapper and the subagent would "never report back" (the
      // upstream extension-api.md host warning). On liveness-check errors,
      // conservatively keep it alive.
      // Without a sessionManager (no session) do not be conservative —
      // otherwise a purely idle session would never be recycled.
      let hasDetached = false;
      const detachedSessionFile = this.inner.sessionManager?.getSessionFile?.() ?? "";
      const detachedSessionId = this.inner.sessionManager?.getSessionId?.() ?? "";
      if (detachedSessionFile || detachedSessionId) {
        try {
          hasDetached = hasLiveDetachedRuns(detachedSessionFile, detachedSessionId);
        } catch { /* conservatively keep alive */ hasDetached = true; }
      }
      if (hasDetached) {
        this.resetIdleTimer();
        return;
      }
      void this.shutdown("idle").catch((error) => {
        console.error("[pi-web] failed to shut down idle session:", error instanceof Error ? error.message : error);
      });
    }, timeoutMs);
  }

  private persistBashOnlySession(): void {
    const manager = this.inner.sessionManager;
    const sessionFile = manager.getSessionFile();
    if (!sessionFile || existsSync(sessionFile)) return;

    const header = manager.getHeader();
    if (!header) return;

    const content = [header, ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
    writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx" });

    // Pi delays the first flush until a user or assistant message exists.
    // A leading shell command is neither, so mark this SDK manager as
    // flushed after writing its own generated entries.
    (manager as unknown as { flushed: boolean }).flushed = true;
    cacheSessionPath(this.inner.sessionId, sessionFile);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    // Replay pending events: a single listener throwing must not break the
    // "pushed ⇒ returns an off function" pairing (the old implementation left
    // the caller without an unsubscribe function on throw → the listener
    // leaked forever; reload re-attachment would amplify it into one copy per
    // reload). Same single-point isolation as emit()'s main dispatch loop.
    for (const event of this.pendingUiRequests.values()) {
      try { listener(event); } catch (e) { console.error("[pi-web] failed to replay pending UI request:", e instanceof Error ? e.message : e); }
    }
    for (const event of this.activeToolEvents.values()) {
      try { listener(event); } catch (e) { console.error("[pi-web] failed to replay active tool event:", e instanceof Error ? e.message : e); }
    }
    for (const event of this.startupNotices ?? []) {
      try { listener(event); } catch (e) { console.error("[pi-web] failed to replay startup notice:", e instanceof Error ? e.message : e); }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Plan M: builds the extension-side session info (steer / subscribeEvent /
   * abortBash / getModel).
   * The session-creation point and the re-attachment after a registry reload
   * (reattachAgentSessions) share this one builder to avoid drift. Note
   * subscribeEvent attaches a new listener on every call — for repeated
   * dispatches, the registry's subscription-epoch ledger reclaims old
   * subscriptions first (see lib/ext/registry.ts dispatchAgentSession).
   */
  toAgentSessionInfo(): AgentSessionInfo {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      // In-process event tap: includes tool_execution_update live bash output
      // (the agent-events SSE outlet filters that type, so the browser never
      // sees it; extensions get the full stream here).
      subscribeEvent: (listener) => this.onEvent((event) => listener(event)),
      // Aborts only the current bash command, not the whole turn (the agent continues after receiving the error result).
      abortBash: () => this.inner.abortBash(),
      // The model currently in use by this session (read live; runtime monitors — e.g. the model-check extension's mass-429 block marking — use it to attribute the model).
      getModel: () => {
        const m = this.inner.model;
        return m && m.provider && m.id ? { provider: m.provider, modelId: m.id } : null;
      },
      // steer: enters pi's steering queue, consumed at the next turn boundary;
      // if the turn ends right after enqueueing but before that boundary (the
      // loop's final hasQueuedMessages check already ran), nothing consumes
      // the queue — so check once more after enqueueing: if no longer running,
      // send continue_queue to actually get going (during compaction
      // continue_queue reports started:false; delivery is handled by the
      // compaction_end listener). Guard against an already-destroyed wrapper:
      // the sink is unregistered in onAgentSessionEnd, but in-flight calls
      // may still arrive.
      steer: async (t) => {
        if (!this.isAlive()) return;
        await this.send({ type: "steer", message: t });
        if (!this.isRunning()) await this.send({ type: "continue_queue" });
      },
    };
  }

  /** Plan M: whether extension session hooks have been dispatched (filter marker for reload re-attachment; subagent wrappers do not dispatch). */
  hasAgentSessionHooks(): boolean {
    return this.agentSessionHooksDispatched;
  }

  /** Plan M: marks the hooks as dispatched (called at the creation point; re-attachment only targets wrappers marked this way). */
  markAgentSessionHooksDispatched(): void {
    this.agentSessionHooksDispatched = true;
  }

  onDestroy(cb: (reason: AgentWrapperEndReason) => void): void {
    this.onDestroyCallback = cb;
  }

  /**
   * Plan M 扩展事件分发专用槽（与 onDestroy 守卫单槽分离）：onDestroy 是
   * 单槽语义（后注册覆盖先注册），Plan M 的 session-end 分发若挤占它会把
   * registerRpcWrapper 的代际守卫覆盖掉（旧 wrapper 替换后仍会注销继任者）。
   */
  onAgentSessionEndDispatch(cb: (reason: AgentWrapperEndReason) => void): void {
    this.agentSessionEndCallback = cb;
  }

  /**
   * After navigate/branch, explicitly land the currently effective
   * model/thinking onto the new chain (appended only when it differs from
   * what the new chain already records).
   * Background: set_model's model_change append lands on the branch
   * containing "the leaf at the moment of the switch"; when a later "edit
   * from here" / branch navigation branches back to an earlier node, the new
   * chain's ancestors lack that model_change → the frontend, displaying "the
   * last model_change on the leaf path", would regress to the old model
   * while the engine's in-memory state keeps the new one (display ≠ runtime).
   * Writing it back keeps the tree self-consistent and the read side needs
   * no guessing. Written only on difference, to avoid piling redundant
   * records on every branch switch.
   */
  private syncSessionSettingsAfterBranch(): void {
    try {
      const sm = this.inner.sessionManager;
      const leafId = sm.getLeafId();
      const branch = leafId ? sm.getBranch(leafId) : sm.getBranch();
      let lastModel: { provider: string; modelId: string } | undefined;
      let lastThinking: string | undefined;
      for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i] as { type?: string; provider?: string; modelId?: string; thinkingLevel?: string };
        if (!lastModel && e.type === "model_change") lastModel = { provider: e.provider ?? "", modelId: e.modelId ?? "" };
        if (lastThinking === undefined && e.type === "thinking_level_change") lastThinking = e.thinkingLevel;
        if (lastModel && lastThinking !== undefined) break;
      }
      const model = this.inner.model;
      if (model && (!lastModel || lastModel.provider !== model.provider || lastModel.modelId !== model.id)) {
        sm.appendModelChange(model.provider, model.id);
      }
      const thinking = this.inner.agent.state?.thinkingLevel;
      if (thinking && thinking !== lastThinking) {
        sm.appendThinkingLevelChange(thinking);
      }
      invalidateSessionListCache();
    } catch (e) {
      // A failed write-back does not block the navigate result (engine state is already in place; only the display layer may regress to the old record).
      console.error("navigate_tree: sync model/thinking after branch failed:", e);
    }
  }

  /**
   * Resolves `true` once the SDK session is disposed, or `false` after `timeoutMs`:
   * shutdown() waits for extension binding without a deadline.
   */
  waitUntilDisposed(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    return Promise.race([this.disposed.then(() => true), timedOut]).finally(() => clearTimeout(timer));
  }

  private async withSessionReplacement<T>(
    replacement: "fork" | "clone",
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.sessionReplacement) throw new Error("Session is already being copied");
    this.sessionReplacement = replacement;
    try {
      return await operation();
    } finally {
      if (this._alive) this.sessionReplacement = null;
    }
  }

  private isSessionRunningForReplacement(): boolean {
    return this.shellRunning
      || this.inner.isStreaming
      || this.inner.isCompacting
      || this.pendingPromptCount > 0;
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    const type = command.type as string;
    // A status read (the chat's reconciliation, every few seconds while it runs) would hide the
    // last command that did something; it never resets the idle timer either.
    if (type !== "get_state") {
      this.lastCommandType = typeof type === "string" ? type : null;
      this.lastCommandAt = Date.now();
    }
    const allowedDuringReplacement = COMMANDS_ALLOWED_DURING_SESSION_REPLACEMENT.has(type);
    if (this.sessionReplacement && !allowedDuringReplacement) {
      throw new Error("Session is being copied to a new session");
    }
    if (SESSION_REPLACEMENT_COMMAND_TYPES.has(type) && this.activeMutatingCommands > 0) {
      throw new Error(`Cannot ${type} while another session command is running`);
    }

    const tracksMutation = !allowedDuringReplacement;
    if (tracksMutation) this.activeMutatingCommands += 1;
    // A prompt counts from its arrival: a `!` sent right after it must not start
    // while it waits on the extensions or its admission, and then refuse it.
    let arrivingPrompt = type === "prompt";
    if (arrivingPrompt) this.arrivingPromptCount += 1;
    const promptCounted = () => {
      if (!arrivingPrompt) return;
      arrivingPrompt = false;
      this.arrivingPromptCount -= 1;
    };

    try {
      // Status reconciliation must not postpone forced cleanup after Stop.
      if (type !== "get_state") this.resetIdleTimer();
      if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();
      if (this.sessionReplacement && !allowedDuringReplacement) {
        throw new Error("Session is being copied to a new session");
      }

      if (type === "prompt" || type === "steer" || type === "follow_up") {
        const imageError = validateAgentImages(command.images);
        if (imageError) throw new Error(imageError);
      }
      // A session whose folder was deleted outside pi-web stays readable, but a
      // run there would reach the model only for its tools to fail (and `write`
      // to recreate the folder). The pi CLI does not resume such a session
      // either; refuse as /api/agent/new does. (A `!` command already refuses.)
      // Typed, so the route names the folder for the composer (#1422).
      if (type === "prompt" && !existsSync(this.cwd)) {
        throw cwdMissingError(this.cwd);
      }

      switch (type) {
      case "prompt": {
        // Serialize only admission. Once the preceding prompt has either
        // passed or failed preflight, the SDK can atomically decide whether
        // this submission starts a run or joins its streaming queue.
        const releaseAdmission = await this.acquirePromptAdmission();
        try {
          // A steer or follow-up joins the run beside a `!` command, as pi's TUI
          // queues it; only a prompt that would start a run waits for the command.
          if (this.shellRunning && !(command.streamingBehavior && this.inner.isStreaming)) {
            throw new Error("Cannot send a prompt while a shell command is running");
          }
          if (this.sideChat) this.nameSideChat(command.message);
          const model = this.inner.model;
          if (this.chatOnlyExtensionModel && !(model && this.inner.modelRuntime.getModel(model.provider, model.id))) {
            throw chatOnlyExtensionModelError(this.chatOnlyExtensionModel.provider, this.chatOnlyExtensionModel.id);
          }
          this.renewExtensionUiStop();
          const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
          const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
          const text = command.message as string;

          // pi rejects prompts while a manual compaction runs: the preflight
          // refusal below parks the submission and flushes it at compaction end
          // (the TUI's compactionQueuedMessages). Extension commands still go
          // through inner.prompt() so they execute immediately, matching pi's
          // own behavior during compaction.

          const queuesMessage = Boolean(streamingBehavior) && this.inner.isStreaming;
          if (queuesMessage) {
            // Record image attachments so they survive queue mirroring.
            this.hintQueueImages(streamingBehavior === "followUp" ? "followUp" : "steer", promptImages);
          }

          let preflightAccepted = false;
          let preflightSettled = false;
          let promptSettled = false;
          // A prompt parked behind compaction is answered with `{ queued: true }`:
          // the message is not a sent one yet.
          let parked = false;
          let acceptPreflight!: () => void;
          let rejectPreflight!: (error: unknown) => void;
          const preflight = new Promise<void>((resolve, reject) => {
            // Acceptance owes no completion: only a run does, and its agent_start says so.
            // An extension command pi handles, or input an extension swallows, starts
            // none, and a run the command starts itself may begin after this (#1345).
            acceptPreflight = () => {
              preflightAccepted = true;
              if (preflightSettled) return;
              preflightSettled = true;
              resolve();
            };
            rejectPreflight = (error) => {
              if (preflightSettled) return;
              preflightSettled = true;
              reject(error);
            };
          });
          const finishPrompt = () => {
            if (promptSettled) return;
            promptSettled = true;
            this.pendingPromptCount = Math.max(0, this.pendingPromptCount - 1);
            this.resetIdleTimer();
            this.notifyAgentRunCompleteIfIdle();
            // Running state changed (possibly running → idle): broadcast to SSE so the sidebar running marker clears.
            notifyRunningChange();
          };

          this.pendingPromptCount += 1;
          // Execution starts (isRunning flips true): broadcast before the MCP prepare wait below (can take seconds).
          notifyRunningChange();
          promptCounted();
          // A prompt that may start a run first connects the session's MCP servers and
          // waits for the ones still connecting. The SDK runs before_agent_start before a
          // run has an abort signal, so Stop is honoured here: it ends the wait, and the
          // message is rejected unsent, which returns it to the composer. pi runs an
          // extension command before anything else and starts no run for it: another
          // extension's command skips this, and the built-in `/mcp`, which acts on the
          // registered servers, registers them without waiting (`mcpPromptPreparation()`).
          const mcpPreparation = this.mcpHost && !this.inner.isStreaming
            ? mcpPromptPreparation(typeof command.message === "string" ? command.message : "", this.extensionCommandCandidates())
            : "none";
          if (this.mcpHost && mcpPreparation !== "none") {
            const controller = new AbortController();
            const waited = this.mcpHost.prepareForPrompt(controller.signal, { wait: mcpPreparation === "wait" })
              .catch((error: unknown) => {
                console.error("[pi-web] MCP servers could not be prepared:", error instanceof Error ? error.message : error);
              })
              .then(() => {
                if (!controller.signal.aborted) return;
                finishPrompt();
                throw new Error(MCP_WAIT_STOPPED_MESSAGE);
              });
            const wait = { controller, done: waited.then(() => undefined, () => undefined) };
            this.mcpPromptWait = wait;
            try {
              await waited;
            } finally {
              if (this.mcpPromptWait === wait) this.mcpPromptWait = null;
            }
          }
          // Execution starts (isRunning flips true): broadcast the running set so the sidebar shows the running marker right away.
          notifyRunningChange();
          // A new prompt, not one queued into a run: what an earlier run's Stop said is over.
          // Not at acceptance: pi accepts a command that awaits a run of its own after that
          // run settled, and the run's Stop must still keep its push and chime away.
          if (!streamingBehavior) this.lastRunAborted = false;
          let prompt: Promise<void>;
          try {
            prompt = this.inner.prompt(command.message as string, {
              ...(promptImages?.length ? { images: promptImages } : {}),
              ...(streamingBehavior ? { streamingBehavior } : {}),
              source: "rpc",
              // Match pi's RPC contract: acknowledge only after synchronous prompt
              // validation and extension preflight have accepted the submission.
              // Every disposition (handled, queued, started) is an acceptance; a
              // rejected prompt never calls this and rejects `prompt` instead.
              preflightResult: () => acceptPreflight(),
            });
          } catch (error) {
            finishPrompt();
            throw error;
          }

          void prompt.then(() => {
            // Compatibility fallback if a future SDK resolves without invoking
            // the internal callback. This waits for the run, but never acks early.
            acceptPreflight();
            finishPrompt();
            if (!streamingBehavior) this.emit(this.promptDoneEvent());
          }, (error) => {
            // pi's SDK refuses prompts while a manual compaction runs. Park the
            // submission and flush it at compaction end (the TUI's
            // compactionQueuedMessages). An extension command typed meanwhile
            // still runs: the SDK executes commands before it refuses. The parked
            // prompt keeps this admission's count outstanding until it settles,
            // so the wrapper cannot idle out from under it.
            if (!preflightAccepted && isCompactionInProgressError(error)) {
              this.parkDuringCompaction({
                message: command.message as string,
                images: promptImages,
                streamingBehavior,
                settle: finishPrompt,
              });
              parked = true;
              acceptPreflight();
              // The refusal can land after that compaction's end already flushed.
              if (!this.inner.isCompacting) this.flushParkedPrompts();
              return;
            }
            rejectPreflight(error);
            finishPrompt();
            invalidateSessionListCache();
            // A preflight rejection is returned by the POST itself. Only an
            // unexpected failure after acceptance needs the asynchronous event.
            if (preflightAccepted) {
              this.emit({
                type: "prompt_error",
                errorMessage: error instanceof Error ? error.message : String(error),
              });
              if (!streamingBehavior) this.emit(this.promptDoneEvent());
            }
          }).catch((error) => {
            console.error(
              "[pi-web] prompt completion handler failed:",
              error instanceof Error ? error.message : error,
            );
          });

          await preflight;
          return parked ? { queued: true } : null;
        } finally {
          releaseAdmission();
        }
      }

      case "abort": {
        this.forceShutdownOnIdle = true;
        // Arm the forced cleanup now: the reset above ran before this flag,
        // and the final reset only runs once the SDK run has unwound.
        this.resetIdleTimer();
        // Stop must unwind extension commands that have not started the agent yet.
        this.extensionUiAbortController.abort(new DOMException("Extension UI cancelled by Stop", "AbortError"));
        // A prompt still waiting for MCP servers is withdrawn before it starts a run.
        if (this.mcpPromptWait) {
          const wait = this.mcpPromptWait;
          wait.controller.abort();
          await wait.done;
        }
        // Stop ends the compaction, whose end would send the parked prompts:
        // they go back to the composer instead, as the TUI's abort restores
        // queued messages to the editor.
        const recalled = this.recallParkedPrompts();
        try {
          await this.withFinalIdleReset(() => this.inner.abort());
          return recalled.steering.length || recalled.followUp.length ? recalled : null;
        } finally {
          this.releaseForcedShutdownOnceStopped();
        }
      }

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          // Authoritative busy field: same semantics as /api/agent/running's
          // wrapper.isRunning() (covers compaction/promptRunning/bash and
          // other busy states beyond isStreaming) — the frontend's "restore
          // running state on open" uses it, avoiding the left side lit while
          // the right side shows idle during manual-compaction /
          // queue-continuation windows (fixed 2026-09-14).
          isRunning: this.isRunning(),
          isPromptRunning: this.pendingPromptCount > 0,
          isBashRunning: this.shellRunning,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: this.inner.pendingMessageCount,
          queuedMessages: {
            steering: [
              ...this.queueMirror.filter((e) => e.kind === "steer").map((e) => e.text),
              ...this.parkedDuringCompaction.filter((e) => e.streamingBehavior !== "followUp").map((e) => e.message),
            ],
            followUp: [
              ...this.queueMirror.filter((e) => e.kind === "followUp").map((e) => e.text),
              ...this.parkedDuringCompaction.filter((e) => e.streamingBehavior === "followUp").map((e) => e.message),
            ],
            // Parallel attachment markers (same indexes as steering/followUp):
            // for queue-row icons — pi's queue_update reports text only; the
            // real attachment info lives only in the local queueMirror and is
            // delivered with the state projection. Parked prompts carry their
            // own images.
            steeringHasImages: [
              ...this.queueMirror.filter((e) => e.kind === "steer").map((e) => Boolean(e.images?.length)),
              ...this.parkedDuringCompaction.filter((e) => e.streamingBehavior !== "followUp").map((e) => Boolean(e.images?.length)),
            ],
            followUpHasImages: [
              ...this.queueMirror.filter((e) => e.kind === "followUp").map((e) => Boolean(e.images?.length)),
              ...this.parkedDuringCompaction.filter((e) => e.streamingBehavior === "followUp").map((e) => Boolean(e.images?.length)),
            ],
          },
          pendingRecovery: this.getPendingRecoveryView(),
          queueTrash: this.getQueueTrashView(),
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          // Computed from the live entries on every read, like `GET /api/sessions/[id]`
          // does for a snapshot: the SDK's stats carry no active time, and a panel that
          // kept a snapshot while messages streamed in showed the pre-gap value for the
          // rest of the run, however long it lasted (#1334).
          totalActiveMs: computeLiveSessionTotalActiveMs(this.inner.sessionManager),
          // An exact prompt is projected onto each run by the inline extension. Every other
          // session reports `agent.state.systemPrompt`, which replays the transcript: that is
          // what the model actually saw, including sections a `before_agent_start` handler
          // changed for the run. It stays empty until the first run persists a system message,
          // so a session that has not sent anything yet falls back to the session getter, which
          // renders the prompt from the current options. The getter alone would drop those
          // per-run changes again once the run ends.
          systemPrompt: this.exactSystemPrompt?.() ?? (this.inner.agent.state?.systemPrompt || this.inner.systemPrompt || ""),
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        // As pi's /model, which refreshes before listing: re-read models.json even for a known id,
        // so reselecting a model applies a saved edit of it (#1273). Like the TUI, a failed or
        // timed-out refresh leaves the cached definitions in use.
        await this.inner.modelRuntime.refresh({
          allowNetwork: false,
          providers: [provider],
          signal: AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS),
        }).catch(() => undefined);
        const model = this.inner.modelRuntime.getModel(provider, modelId);
        if (!model) {
          throw this.chatOnly && findDeferredModel(this.inner.modelRuntime as ModelRuntime, provider, modelId)
            ? chatOnlyExtensionModelError(provider, modelId)
            : new Error(`Model not found: ${provider}/${modelId}`);
        }
        const previous = this.inner.model;
        // Reselecting an unchanged model writes nothing.
        if (isDeepStrictEqual(previous, model)) return { id: model.id, provider: model.provider };
        const sameId = previous?.provider === model.provider && previous.id === model.id;
        const thinkingLevel = this.inner.agent.state?.thinkingLevel;
        await this.inner.setModel(model);
        // A reselect to apply an edit is not a new model choice: keep the level (clamped by the SDK).
        if (sameId && thinkingLevel) this.inner.setThinkingLevel(thinkingLevel);
        invalidateModelsCache();
        invalidateSessionListCache();
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        // Cross-instance single-writer fallback: another pi-web instance
        // (prod/dev dual-open) may be streaming to the same file from a child
        // process; its in-memory running state is invisible to this instance
        // (an orphan run) → copy the content and continue appending from the
        // current position (the file only grows; only fully parsed lines are
        // kept) — treated as acceptable fork behavior.
        // The isSessionRunningForReplacement() check was removed: that guard
        // was added in an earlier merge; the user explicitly confirmed that
        // forking while running is perfectly fine — the fork only needs to
        // copy up to the current position.
        // await assertSessionFileQuiescent(this.inner.sessionFile ?? "");  removed; no longer blocks a running fork.
        // A running fork must also **not interrupt the in-flight turn**:
        // completion no longer takes the replacement-style teardown (the old
        // implementation's replacement shutdown would destroy →
        // inner.dispose(), killing the running run; the user explicitly
        // required that forking a new branch must not stop the source
        // session). Aligned with fork_branch's "no replacement, no closing of
        // the source session"; idle wrappers are left to the existing idle GC
        // (10 minutes), with no replacement-style cleanup.
        // Upstream's while-running guards (shellRunning / keepSource +
        // shutdownAfterSessionReplacement) are superseded by that local
        // decision: a fork is allowed while running and never shuts down the
        // source session.
        this.refuseForkOfSideChat();
        const entryId = command.entryId as string;
        // pi's fork asks `session_before_fork` handlers first: one may cancel it, or
        // ask (a dialog in the page) whether to restore the code to that point. Not
        // under the copy's lock below: a dialog waits on the user, and Stop or a steer
        // for a running source must still go through meanwhile.
        if (this.inner.sessionManager.getEntry(entryId) && await this.forkCancelledByExtension(entryId, "before")) {
          return { cancelled: true };
        }
        return this.withSessionReplacement("fork", async () => {
          const sessionManager = this.inner.sessionManager;
          const currentSessionFile = this.inner.sessionFile;

          if (!sessionManager.isPersisted()) return { cancelled: true };
          if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

          const entry = sessionManager.getEntry(entryId);
          if (!entry) throw new Error("Invalid entry ID for forking");

          const sessionDir = sessionManager.getSessionDir();
          let newSessionFile: string;
          let forkedManager: SessionManager;

          if (!entry.parentId) {
            // Fork before the first message: create an empty session linked to this one
            forkedManager = SessionManager.create(sessionManager.getCwd(), sessionDir, {
              parentSession: currentSessionFile,
            });
            newSessionFile = forkedManager.getSessionFile() as string;
          } else {
            // Fork after some history: copy path up to (but not including) the fork point
            if (!existsSync(currentSessionFile)) throw new Error(UNSAVED_SESSION_FORK_ERROR);
            forkedManager = SessionManager.open(currentSessionFile, sessionDir);
            const forkedPath = forkedManager.createBranchedSession(entry.parentId);
            if (!forkedPath) throw new Error("Failed to create forked session");
            newSessionFile = forkedPath;
          }

          // The branch file may not be on disk yet due to the no-assistant
          // guard — in that case write it out manually from the in-memory
          // header/entries (wx guards against concurrent duplicate creation);
          // newSessionId comes from the creator instance, consistent with the
          // file header.
          if (!existsSync(newSessionFile)) {
            const header = forkedManager.getHeader();
            if (!header) throw new Error("Forked session is missing a session header");
            const content = [header, ...forkedManager.getEntries()]
              .map((forkedEntry) => JSON.stringify(forkedEntry))
              .join("\n") + "\n";
            writeFileSync(newSessionFile, content, { encoding: "utf8", flag: "wx" });
          }

          const newSessionId = forkedManager.getSessionId();
          cacheSessionPath(newSessionId, newSessionFile);
          invalidateSessionListCache();
          // Unified creator-side notification (the helper goes through
          // publishPageEventToBus for a wide publish): a fork does not
          // necessarily switch away (the branch file has been manually
          // written to disk; the follow-up fetch chain promotes it shortly).
          notifySessionCreated(newSessionId, sessionManager.getCwd(), "fork");
          // Do not shut down the source session (see the case header comment): a fork only reads the source file + writes the new branch; the source session keeps running.
          return { cancelled: false, newSessionId };
        });
      }

      case "fork_branch": {
        // Background fork (the composer "new session" button / reference in a new conversation): copies a
        // branch file from the given entry (when omitted = the current leaf, full context). **Never replaces
        // or closes the source session** — also allowed while running (the user explicitly required "ignore
        // running state"; fork_branch only reads the source file + writes the new branch, and the source
        // session keeps running). The old isSessionRunningForReplacement() guard was removed: it was
        // over-defensive for replacement-style forks (fork/clone shut down the source wrapper); branch
        // copying has no such semantics — a torn tail line is skipped outright by loadEntries and
        // createBranchedSession only takes fully parsed entries, so there is no "copying half a JSONL line"
        // risk. Upstream's new shellRunning guard is superseded by the same decision (see case "fork").
        this.refuseForkOfSideChat();
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;
        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");
        // Source file not on disk yet (sessions with no assistant message
        // defer file creation per the SDK contract) — there is no disk state
        // to copy, so return cancelled rather than erroring (the frontend
        // shows "no full conversation to copy yet").
        if (!existsSync(currentSessionFile)) return { cancelled: true };
        const entryId = typeof command.entryId === "string" && command.entryId
          ? command.entryId
          : sessionManager.getLeafId();
        if (!entryId) return { cancelled: true };
        if (!sessionManager.getEntry(entryId)) throw new Error("Invalid entry ID for forking");
        if (!existsSync(currentSessionFile)) throw new Error(UNSAVED_SESSION_FORK_ERROR);

        const sessionDir = sessionManager.getSessionDir();
        const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
        const forkedPath = sourceManager.createBranchedSession(entryId);
        if (!forkedPath) throw new Error("Failed to create forked session");

        // The branch file may not be on disk yet due to the no-assistant guard
        // (deferred to the first _persist) — a background fork needs the file
        // to exist immediately (the caller cold-starts a new session by id
        // right away; a missing file would generate a different id and
        // mismatch the return value). Write it out manually from the creator's
        // in-memory header/entries (wx guards against concurrent duplicate
        // creation); newSessionId comes from the creator instance, consistent
        // with the file header (same fallback as case "fork").
        if (!existsSync(forkedPath)) {
          const header = sourceManager.getHeader();
          if (!header) throw new Error("Forked session is missing a session header");
          const content = [header, ...sourceManager.getEntries()]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n";
          writeFileSync(forkedPath, content, { encoding: "utf8", flag: "wx" });
        }

        const newSessionId = sourceManager.getSessionId();
        cacheSessionPath(newSessionId, forkedPath);
        invalidateSessionListCache();
        // Immediately visible in the sidebar: this path does not switch the
        // current session (a silent background fork) and no host refreshKey
        // drives it; the unified creator-side notification (the helper goes
        // through publishPageEventToBus for a wide publish) → session-manager
        // records a pendingDraft draft row (the file is on disk; the
        // follow-up fetch chain promotes it shortly).
        notifySessionCreated(newSessionId, sessionManager.getCwd(), "fork_branch");
        return { cancelled: false, newSessionId };
      }

      case "clone": {
        // Like fork, clone supports running-state operation. createBranchedSession takes entries from the in-memory byId Map bounded by leafId (only fully parsed JSON objects), so there is no "copying half a JSONL line" risk.
        // Removed isSessionRunningForReplacement() and assertSessionFileQuiescent() (over-defense introduced in an earlier merge that would always reject while running).
        this.refuseForkOfSideChat();
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;
        const leafId = typeof command.leafId === "string" ? command.leafId : sessionManager.getLeafId();
        const branchHasAssistant = leafId && sessionManager.getBranch(leafId).some(
          (entry) => entry.type === "message" && entry.message.role === "assistant",
        );

        if (!sessionManager.isPersisted() || !leafId || !branchHasAssistant) return { cancelled: true };
        if (!currentSessionFile || !existsSync(currentSessionFile)) return { cancelled: true };

        // pi's /clone asks the fork's handlers too, at the leaf (`position: "at"`), and
        // likewise outside the copy's lock. `byExtension` tells the composer this refusal
        // from the one above, which it reports as an empty or unsaved session.
        if (await this.forkCancelledByExtension(leafId, "at")) return { cancelled: true, byExtension: true };

        return this.withSessionReplacement("clone", async () => {
          const sessionDir = sessionManager.getSessionDir();
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const clonedPath = sourceManager.createBranchedSession(leafId);
          if (!clonedPath || !existsSync(clonedPath)) throw new Error("Failed to clone current session branch");

          const newSessionId = SessionManager.open(clonedPath, sessionDir).getSessionId();
          cacheSessionPath(newSessionId, clonedPath);
          invalidateSessionListCache();
          // Unified creator-side notification: the caller usually switches
          // away on clone (driven by refreshKey), but the same notification
          // guarantees non-switching paths (scripts/extension direct calls)
          // are immediately visible too.
          notifySessionCreated(newSessionId, sessionManager.getCwd(), "clone");
          // Do not shut down the source session (same as fork, decided
          // 2026-09-13): a running clone must not interrupt the in-flight
          // turn; the source wrapper keeps running / is left to the idle GC
          // when idle, with no replacement-style teardown.
          return { cancelled: false, newSessionId };
        });
      }

      case "navigate_tree": {
        // Allow navigate while running: like fork, it does not interrupt the agent.
        // (Upstream's isBashRunning/shellRunning guard is superseded by the local
        // decision that navigate must not be blocked on a running session.)
        // pi's navigateTree() asks `session_before_tree` handlers first: an earlier Stop
        // must not close their dialog before it shows. A Stop while it waits still lets the
        // move through (pi moves inside navigateTree() right after the hook); the page shows
        // Stop then only when a prompt was sent while the dialog waited.
        this.renewExtensionUiStop();
        const result = await this.navigateTreeKeepingToolSelection(command.targetId as string, {});
        // After a branch, explicitly land the currently effective model/thinking onto the new chain (shared by "edit from here" / branch navigation).
        if (!result.cancelled) this.syncSessionSettingsAfterBranch();
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        invalidateSessionListCache();
        return null;
      }

      case "compact": {
        // `session_before_compact` handlers may ask too: an earlier Stop must not close their dialog.
        this.renewExtensionUiStop();
        try {
          return await this.withFinalIdleReset(() =>
            this.inner.compact(command.customInstructions as string | undefined)
          );
        } finally {
          invalidateSessionListCache();
        }
      }

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        this.inner.setSessionName(name);
        invalidateSessionListCache();
        return null;
      }

      case "get_session_stats": {
        return {
          ...this.inner.getSessionStats(),
          sessionName: this.inner.sessionManager.getSessionName(),
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "clear_queue": {
        // Full clear only: pi has no single-item dequeue, and clear+requeue
        // races against the agent loop pulling messages mid-flight. This is a
        // user-initiated destructive action, so it is a SOFT delete: the
        // cleared entries move to the trash and stay recoverable until the
        // user purges them. Prompts parked during compaction come back too,
        // as the TUI's clearAllQueues().
        if (this.queueMirror.length > 0) {
          this.queueTrash.push(...this.queueMirror);
        }
        this.queueMirror = [];
        this.pendingQueueHints = { steer: [], followUp: [], composer: [] };
        this.persistQueue();
        const cleared = this.inner.clearQueue();
        if (this.parkedDuringCompaction.length === 0) return cleared;
        const recalled = this.recallParkedPrompts();
        return {
          steering: [...cleared.steering, ...recalled.steering],
          followUp: [...cleared.followUp, ...recalled.followUp],
          ...(recalled.images ? { images: recalled.images } : {}),
        };
      }

      case "move_queue": {
        // pi has no reorder/single-dequeue API, so reordering is implemented
        // as clear-all + re-enqueue in the target order. Like pi's own
        // clearQueue(), this is allowed while the agent runs: the loop only
        // pulls entries between turns, and clear+requeue within one request is
        // atomic enough that the queue is repopulated before the next pull.
        const kind = command.kind as QueueKind | undefined;
        if (kind !== "steer" && kind !== "followUp") {
          throw new Error("move_queue requires kind \"steer\" or \"followUp\"");
        }
        const fromIndex = Number(command.fromIndex);
        const toIndex = Number(command.toIndex);
        if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) {
          throw new Error("move_queue requires integer indexes");
        }
        const steeringEntries = this.queueMirror.filter((e) => e.kind === "steer");
        const followUpEntries = this.queueMirror.filter((e) => e.kind === "followUp");
        const moving = kind === "steer" ? steeringEntries : followUpEntries;
        if (fromIndex < 0 || fromIndex >= moving.length || toIndex < 0 || toIndex >= moving.length) {
          throw new Error("move_queue index out of range");
        }
        const [entry] = moving.splice(fromIndex, 1);
        moving.splice(toIndex, 0, entry);
        const newSteering = kind === "steer" ? moving : steeringEntries;
        const newFollowUp = kind === "followUp" ? moving : followUpEntries;
        // Clear the live pi queue entirely, then re-enqueue both queues in the
        // new order. Image hints are pushed per entry FIFO so reconcileQueue
        // can reattach them after each queue_update event.
        this.inner.clearQueue();
        this.pendingQueueHints = { steer: [], followUp: [], composer: [] };
        for (const e of newSteering) {
          this.hintQueueImages("steer", e.images);
          await this.inner.steer(e.text, e.images?.length ? e.images : undefined);
        }
        for (const e of newFollowUp) {
          this.hintQueueImages("followUp", e.images);
          await this.inner.followUp(e.text, e.images?.length ? e.images : undefined);
        }
        this.queueMirror = [...newSteering, ...newFollowUp];
        this.persistQueue();
        return { ...this.getQueueAttachmentView(), steering: [...this.inner.getSteeringMessages()], followUp: [...this.inner.getFollowUpMessages()] };
      }

      case "convert_queue_item": {
        // Change one queued entry's kind (steer ↔ followUp) WITHOUT dispatching
        // it — e.g. a steer sent by mistake becomes a plain follow-up that
        // waits for the next turn. Same clear-all + re-enqueue strategy as
        // move_queue, so ordering and image hints survive. Unlike the
        // steer-send action (which consumes the entry), the converted entry
        // stays queued under its new kind.
        const kind = command.kind as QueueKind | undefined;
        if (kind !== "steer" && kind !== "followUp") {
          throw new Error("convert_queue_item requires kind \"steer\" or \"followUp\"");
        }
        const index = Number(command.index);
        if (!Number.isInteger(index)) {
          throw new Error("convert_queue_item requires integer index");
        }
        const targetKind = command.targetKind as QueueKind | undefined;
        if (targetKind !== "steer" && targetKind !== "followUp") {
          throw new Error("convert_queue_item requires targetKind \"steer\" or \"followUp\"");
        }
        if (targetKind === kind) {
          throw new Error("convert_queue_item requires a targetKind different from kind");
        }
        const steeringEntries = this.queueMirror.filter((e) => e.kind === "steer");
        const followUpEntries = this.queueMirror.filter((e) => e.kind === "followUp");
        const entries = kind === "steer" ? steeringEntries : followUpEntries;
        if (index < 0 || index >= entries.length) {
          throw new Error("convert_queue_item index out of range");
        }
        const [converted] = entries.splice(index, 1);
        converted.kind = targetKind;
        (targetKind === "steer" ? steeringEntries : followUpEntries).push(converted);
        const newSteering = kind === "steer" ? entries : steeringEntries;
        const newFollowUp = kind === "followUp" ? entries : followUpEntries;
        // Clear the live pi queue entirely, then re-enqueue both queues in the
        // new order. Image hints are pushed per entry FIFO so reconcileQueue
        // can reattach them after each queue_update event.
        this.inner.clearQueue();
        this.pendingQueueHints = { steer: [], followUp: [], composer: [] };
        for (const e of newSteering) {
          this.hintQueueImages("steer", e.images);
          await this.inner.steer(e.text, e.images?.length ? e.images : undefined);
        }
        for (const e of newFollowUp) {
          this.hintQueueImages("followUp", e.images);
          await this.inner.followUp(e.text, e.images?.length ? e.images : undefined);
        }
        this.queueMirror = [...newSteering, ...newFollowUp];
        this.persistQueue();
        return { ...this.getQueueAttachmentView(), steering: [...this.inner.getSteeringMessages()], followUp: [...this.inner.getFollowUpMessages()] };
      }

      case "recall_queue_item": {
        // pi has no single-item dequeue — same clear-all + re-enqueue strategy
        // as move_queue, minus the recalled entry. Allowed while running, like
        // pi's own clearQueue().
        const kind = command.kind as QueueKind | undefined;
        if (kind !== "steer" && kind !== "followUp") {
          throw new Error("recall_queue_item requires kind \"steer\" or \"followUp\"");
        }
        const index = Number(command.index);
        if (!Number.isInteger(index)) {
          throw new Error("recall_queue_item requires an integer index");
        }
        const steeringEntries = this.queueMirror.filter((e) => e.kind === "steer");
        const followUpEntries = this.queueMirror.filter((e) => e.kind === "followUp");
        const entries = kind === "steer" ? steeringEntries : followUpEntries;
        if (index < 0 || index >= entries.length) {
          throw new Error("recall_queue_item index out of range");
        }
        const [removed] = entries.splice(index, 1);
        const newSteering = kind === "steer" ? entries : steeringEntries;
        const newFollowUp = kind === "followUp" ? entries : followUpEntries;
        this.inner.clearQueue();
        this.pendingQueueHints = { steer: [], followUp: [], composer: [] };
        for (const e of newSteering) {
          this.hintQueueImages("steer", e.images);
          await this.inner.steer(e.text, e.images?.length ? e.images : undefined);
        }
        for (const e of newFollowUp) {
          this.hintQueueImages("followUp", e.images);
          await this.inner.followUp(e.text, e.images?.length ? e.images : undefined);
        }
        this.queueMirror = [...newSteering, ...newFollowUp];
        this.persistQueue();
        return {
          entry: { text: removed.text, images: removed.images ?? [] },
          steering: [...this.inner.getSteeringMessages()],
          followUp: [...this.inner.getFollowUpMessages()],
          ...this.getQueueAttachmentView(),
        };
      }

      case "requeue_at": {
        // Put an edited message back into the queue at its original position.
        // Same clear-all + re-enqueue strategy; the edited entry is inserted at
        // the given index. Allowed while running, like pi's own clearQueue().
        const kind = command.kind as QueueKind | undefined;
        if (kind !== "steer" && kind !== "followUp") {
          throw new Error("requeue_at requires kind \"steer\" or \"followUp\"");
        }
        const index = Number(command.index);
        if (!Number.isInteger(index)) {
          throw new Error("requeue_at requires an integer index");
        }
        const text = command.text as string | undefined;
        if (typeof text !== "string" || !text.trim()) {
          throw new Error("requeue_at requires text");
        }
        const rawImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const steeringEntries = this.queueMirror.filter((e) => e.kind === "steer");
        const followUpEntries = this.queueMirror.filter((e) => e.kind === "followUp");
        const entries = kind === "steer" ? steeringEntries : followUpEntries;
        if (index < 0 || index > entries.length) {
          throw new Error("requeue_at index out of range");
        }
        const edited = createQueueEntry(kind, text, rawImages);
        entries.splice(index, 0, edited);
        const newSteering = kind === "steer" ? entries : steeringEntries;
        const newFollowUp = kind === "followUp" ? entries : followUpEntries;
        this.inner.clearQueue();
        this.pendingQueueHints = { steer: [], followUp: [], composer: [] };
        for (const e of newSteering) {
          this.hintQueueImages("steer", e.images);
          await this.inner.steer(e.text, e.images?.length ? e.images : undefined);
        }
        for (const e of newFollowUp) {
          this.hintQueueImages("followUp", e.images);
          await this.inner.followUp(e.text, e.images?.length ? e.images : undefined);
        }
        this.queueMirror = [...newSteering, ...newFollowUp];
        this.persistQueue();
        return {
          steering: [...this.inner.getSteeringMessages()],
          followUp: [...this.inner.getFollowUpMessages()],
          ...this.getQueueAttachmentView(),
        };
      }

      case "remove_queue_item": {
        // pi has no single-dequeue API either; drop the entry from the mirror
        // and rebuild the live queue via clear-all + re-enqueue (same strategy
        // as move_queue). Deletion is SOFT by default: the entry moves to the
        // trash so a mistake can be undone. permanent=true (used when an entry
        // was consumed by being dispatched, e.g. steer-send) drops it for real.
        const kind = command.kind as QueueKind | undefined;
        if (kind !== "steer" && kind !== "followUp") {
          throw new Error("remove_queue_item requires kind \"steer\" or \"followUp\"");
        }
        const index = Number(command.index);
        if (!Number.isInteger(index)) {
          throw new Error("remove_queue_item requires integer index");
        }
        const steeringEntries = this.queueMirror.filter((e) => e.kind === "steer");
        const followUpEntries = this.queueMirror.filter((e) => e.kind === "followUp");
        const entries = kind === "steer" ? steeringEntries : followUpEntries;
        const permanent = command.permanent === true;
        if (index < 0 || index >= entries.length) {
          // Idempotent consumption: after the target entry was consumed by
          // dispatch (e.g. taken away by steer-send), a late/concurrent remove
          // arriving with a stale index is a benign no-op — the target state
          // (the entry no longer in the queue) already holds. Throwing here
          // would race the consumption path and surface a false error in the
          // client (observed on mac 2026-09-10).
          // Non-permanent (user-initiated delete) still errors strictly,
          // keeping the logic-defect tripwire.
          if (permanent) {
            return {
              queueTrash: this.getQueueTrashView(),
              steering: [...this.inner.getSteeringMessages()],
              followUp: [...this.inner.getFollowUpMessages()],
              ...this.getQueueAttachmentView(),
            };
          }
          throw new Error("remove_queue_item index out of range");
        }
        const [removed] = entries.splice(index, 1);
        if (!permanent) {
          this.queueTrash.push(removed);
          if (this.queueTrash.length > QUEUE_TRASH_MAX_ENTRIES) {
            this.queueTrash.splice(0, this.queueTrash.length - QUEUE_TRASH_MAX_ENTRIES);
          }
        }
        const newSteering = kind === "steer" ? entries : steeringEntries;
        const newFollowUp = kind === "followUp" ? entries : followUpEntries;
        this.inner.clearQueue();
        this.pendingQueueHints = { steer: [], followUp: [], composer: [] };
        for (const e of newSteering) {
          this.hintQueueImages("steer", e.images);
          await this.inner.steer(e.text, e.images?.length ? e.images : undefined);
        }
        for (const e of newFollowUp) {
          this.hintQueueImages("followUp", e.images);
          await this.inner.followUp(e.text, e.images?.length ? e.images : undefined);
        }
        this.queueMirror = [...newSteering, ...newFollowUp];
        this.persistQueue();
        return {
          removed: {
            id: removed.id,
            kind: removed.kind,
            text: removed.text,
            hasImages: Boolean(removed.images?.length),
            queuedAt: removed.queuedAt,
          },
          queueTrash: this.getQueueTrashView(),
          steering: [...this.inner.getSteeringMessages()],
          followUp: [...this.inner.getFollowUpMessages()],
          ...this.getQueueAttachmentView(),
        };
      }

      case "trash_direct_add": {
        // Dedicated to the composer's × clear button: writes the cleared input
        // content (text + images) straight into the trash.
        // Bypasses all live-queue mechanics — no enqueue, no dispatch, no
        // image hints, no clear-and-rebuild (fully isolated from
        // remove_queue_item's soft-delete path). The entry's kind is
        // "composer"; on restore it refills the composer for continued
        // editing (see restore_trash_item's composer branch).
        const text = typeof command.text === "string" ? command.text : "";
        const rawImages = Array.isArray(command.images) ? command.images : [];
        const images = rawImages
          .filter((im): im is QueueImage => Boolean(im) && typeof im === "object"
            && (im as QueueImage).type === "image"
            && typeof (im as QueueImage).data === "string"
            && typeof (im as QueueImage).mimeType === "string")
          .slice(0, 4);
        if (!text && images.length === 0) {
          throw new Error("trash_direct_add requires text or images");
        }
        const entry = createQueueEntry("composer", text, images.length > 0 ? images : undefined);
        this.queueTrash.push(entry);
        if (this.queueTrash.length > QUEUE_TRASH_MAX_ENTRIES) {
          this.queueTrash.splice(0, this.queueTrash.length - QUEUE_TRASH_MAX_ENTRIES);
        }
        this.persistQueue();
        return {
          entry: {
            id: entry.id,
            kind: entry.kind,
            text: entry.text,
            hasImages: Boolean(entry.images?.length),
            queuedAt: entry.queuedAt,
          },
          queueTrash: this.getQueueTrashView(),
        };
      }

      case "restore_trash_item": {
        // Undo / trash-bin restore: move one soft-deleted entry back into the
        // live queue. Same clear-all + re-enqueue strategy as move_queue.
        // Optional index places it within its kind (used by the undo toast,
        // where the queue hasn't changed yet); default appends to its kind.
        const id = command.id as string | undefined;
        if (typeof id !== "string" || !id) {
          throw new Error("restore_trash_item requires id");
        }
        const trashIdx = this.queueTrash.findIndex((e) => e.id === id);
        if (trashIdx < 0) {
          throw new Error("restore_trash_item entry not found in trash");
        }
        const [entry] = this.queueTrash.splice(trashIdx, 1);

        // composer entries (cleared input content): do not enter the live
        // queue; take them straight out of the trash and return the full
        // content (including image base64) for the frontend to refill the
        // composer for continued editing.
        if (entry.kind === "composer") {
          this.persistQueue();
          return {
            restoredComposer: {
              id: entry.id,
              kind: entry.kind,
              text: entry.text,
              images: entry.images ?? [],
              queuedAt: entry.queuedAt,
            },
            queueTrash: this.getQueueTrashView(),
          };
        }
        const rawIndex = command.index === undefined ? null : Number(command.index);
        if (rawIndex !== null && !Number.isInteger(rawIndex)) {
          throw new Error("restore_trash_item requires an integer index");
        }
        const steeringEntries = this.queueMirror.filter((e) => e.kind === "steer");
        const followUpEntries = this.queueMirror.filter((e) => e.kind === "followUp");
        const entries = entry.kind === "steer" ? steeringEntries : followUpEntries;
        if (rawIndex !== null && rawIndex >= 0 && rawIndex <= entries.length) {
          entries.splice(rawIndex, 0, entry);
        } else {
          // Original slot is gone (queue changed while trashed) — append.
          entries.push(entry);
        }
        const newSteering = entry.kind === "steer" ? entries : steeringEntries;
        const newFollowUp = entry.kind === "followUp" ? entries : followUpEntries;
        this.inner.clearQueue();
        this.pendingQueueHints = { steer: [], followUp: [], composer: [] };
        for (const e of newSteering) {
          this.hintQueueImages("steer", e.images);
          await this.inner.steer(e.text, e.images?.length ? e.images : undefined);
        }
        for (const e of newFollowUp) {
          this.hintQueueImages("followUp", e.images);
          await this.inner.followUp(e.text, e.images?.length ? e.images : undefined);
        }
        this.queueMirror = [...newSteering, ...newFollowUp];
        this.persistQueue();
        return {
          steering: [...this.inner.getSteeringMessages()],
          followUp: [...this.inner.getFollowUpMessages()],
          ...this.getQueueAttachmentView(),
          queueTrash: this.getQueueTrashView(),
        };
      }

      case "purge_trash": {
        // Permanent delete — no undo from here on. ids optional: omit to empty
        // the whole trash, pass ids to purge a selection. Confirmation lives in
        // the UI; the server just does what it's told.
        const ids = command.ids as string[] | undefined;
        if (Array.isArray(ids) && ids.length > 0) {
          const idSet = new Set(ids);
          this.queueTrash = this.queueTrash.filter((e) => !idSet.has(e.id));
        } else {
          this.queueTrash = [];
        }
        this.persistQueue();
        return { queueTrash: this.getQueueTrashView() };
      }

      case "resolve_recovery": {
        const keptIds = new Set((command.keep as string[] | undefined) ?? []);
        const discardIds = new Set((command.discard as string[] | undefined) ?? []);
        const continueRun = command.continueRun === true;
        let keptCount = 0;
        const failedIds = new Set<string>();
        const failedTexts: string[] = [];
        for (const entry of this.queueRecovery) {
          if (!keptIds.has(entry.id)) continue;
          try {
            await this.requeueEntry(entry);
            this.ensureMirrored(entry);
            keptCount += 1;
          } catch (error) {
            failedIds.add(entry.id);
            failedTexts.push(entry.text?.slice(0, 60) ?? entry.id);
            console.error(`[pi-web] resolve_recovery: keeping entry failed (${entry.kind}):`, error);
          }
        }
        // Successful keeps and discards leave recovery; failed keeps stay in
        // recovery so the user can retry or export them instead of losing them.
        const remaining = this.queueRecovery.filter(
          (entry) =>
            !(keptIds.has(entry.id) && !failedIds.has(entry.id))
            && !discardIds.has(entry.id),
        );
        const resolved = this.queueRecovery.length - remaining.length;
        this.queueRecovery = remaining;
        this.persistQueue();
        if (continueRun && keptCount > 0) {
          void this.runAgentContinue().catch((error) => {
            console.error("[pi-web] runAgentContinue failed:", error);
            this.emit({ type: "prompt_error", errorMessage: error instanceof Error ? error.message : String(error) });
          });
        }
        if (failedIds.size > 0) {
          console.error(`[pi-web] resolve_recovery: kept=${keptCount} failed=${failedIds.size} keptInRecovery=${remaining.length} texts=${JSON.stringify(failedTexts)}`);
        }
        return {
          resolved,
          kept: keptCount,
          remaining: this.getPendingRecoveryView(),
          failed: failedTexts,
        };
      }

      case "export_queue": {
        return {
          live: this.queueMirror.map((entry) => ({ ...entry })),
          recovery: this.queueRecovery.map((entry) => ({ ...entry })),
        };
      }

      case "import_queue": {
        const rawEntries = command.entries as QueueEntryInput[] | undefined;
        if (!Array.isArray(rawEntries)) throw new Error("import_queue requires entries[]");
        let imported = 0;
        for (const input of rawEntries) {
          if (
            (input.kind !== "steer" && input.kind !== "followUp")
            || typeof input.text !== "string"
          ) {
            continue;
          }
          const entry = createQueueEntry(input.kind, input.text, input.images);
          await this.requeueEntry(entry);
          this.ensureMirrored(entry);
          imported += 1;
        }
        this.persistQueue();
        // Return the mirror view (not pi's live arrays) so the frontend sees
        // every imported entry even when the agent is mid-run and has already
        // drained some/all of pi's followUpMessages. The mirror is kept in
        // sync with pi via queue_update events from the agent loop.
        return {
          imported,
          steering: this.queueMirror.filter((e) => e.kind === "steer").map((e) => e.text),
          followUp: this.queueMirror.filter((e) => e.kind === "followUp").map((e) => e.text),
          ...this.getQueueAttachmentView(),
        };
      }

      case "stage_recovery": {
        // Stage imported entries as pending recovery (NOT into the live pi
        // queue) so the QueueRecoveryDialog pops up and the user can choose:
        // re-queue / re-queue & continue / discard — same flow as crash
        // recovery. Lets the user decide whether to run an imported queue
        // instead of auto-executing it.
        const rawEntries = command.entries as QueueEntryInput[] | undefined;
        if (!Array.isArray(rawEntries)) throw new Error("stage_recovery requires entries[]");
        let staged = 0;
        for (const input of rawEntries) {
          if (
            (input.kind !== "steer" && input.kind !== "followUp")
            || typeof input.text !== "string"
          ) {
            continue;
          }
          const entry = createQueueEntry(input.kind, input.text, input.images);
          this.queueRecovery.push(entry);
          staged += 1;
        }
        this.persistQueue();
        return {
          staged,
          pendingRecovery: this.getPendingRecoveryView(),
        };
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        this.hintQueueImages("steer", steerImages);
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        this.hintQueueImages("followUp", followImages);
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "continue_queue": {
        // Deliver the live queue when the agent is completely idle — the same
        // runAgentContinue path as recovery's "re-queue & continue" and the
        // compaction_end listener. Covers the "queue recovered after a
        // restart but only re-queued, no continue" case, imports, etc.
        if (this.queueMirror.length === 0) return { started: false, empty: true };
        // During compaction pi rejects prompt(); runAgentContinue would no-op
        // (its own isCompacting guard) and the compaction_end listener delivers
        // the queue anyway. Report accurately instead of a phantom "started".
        if (this.inner.isStreaming || this.inner.isBashRunning || this.promptRunning || this.inner.isCompacting) {
          return { started: false };
        }
        void this.runAgentContinue();
        return { started: true };
      }

      case "get_tools": {
        // A hidden tool is withdrawn: pi ignores it when setting the active tools.
        const all: ToolInfo[] = this.inner.getAllTools().filter((t) => t.exposure !== "hidden");
        const active = new Set<string>(this.inner.getActiveToolNames());
        // The definition's description is not always what the model gets: `prepareLoadout`
        // hooks rewrite the declared ones (codemode lists its nested tools and the MCP types).
        const declared = new Map((this.inner.agent.state?.tools ?? []).map((t) => [t.name, t.description]));
        // Active and callable, but requests leave the declaration out: codemode's "only" mode
        // does this to active `direct` tools. The set is private to pi 0.99's AgentSession.
        const hiddenDeclarations: unknown = Reflect.get(this.inner, "_hiddenDeclarations");
        const hidden = hiddenDeclarations instanceof Set ? hiddenDeclarations : new Set<unknown>();
        return all.map((t) => ({
          ...t,
          description: declared.get(t.name) ?? t.description,
          active: active.has(t.name),
          declarationHidden: hidden.has(t.name),
        }));
      }

      case "get_commands": {
        const commands: SlashCommandInfo[] = [];
        for (const registered of this.inner.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: registered.invocationName,
            description: registered.description,
            source: "extension",
            sourceInfo: registered.sourceInfo,
          });
        }
        for (const template of this.inner.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt",
            sourceInfo: template.sourceInfo,
          });
        }
        for (const skill of this.inner.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
            sourceInfo: skill.sourceInfo,
          });
        }
        return { commands };
      }

      case "set_tools": {
        const toolNames = command.toolNames as string[];
        this.setActiveToolSelection(toolNames);
        return null;
      }

      case "reload": {
        // A reload invalidates the extension ctx the running turn still holds,
        // and the turn dies at its next extension hook (#1172). pi refuses too.
        if (this.isSessionRunningForReplacement()) {
          throw new Error("Wait for the current response to finish before reloading.");
        }
        this.renewExtensionUiStop();
        const activeToolNames = this.inner.getActiveToolNames();
        await this.waitForExtensionsBound();
        this.extensionStatuses.clear();
        this.resetExtensionWidgetsForReload();
        this.syncProjectTrust();
        await this.inner.reload();
        this.reportReloadIssues();
        // pi rebuilds from the tools active before, then extensions adjust them as they start
        // again; carry that result so a tool one switched off during reload stays off.
        this.setActiveToolSelection(activeToolNames);
        if (typeof this.inner.bindExtensions !== "function") {
          this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
        }
        invalidateModelsCache();
        // /reload is how an edited extension is picked up; the provider lists' runtime follows.
        invalidateModelRuntimeWithExtensions();
        return { success: true };
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        this.resolveExtensionUiResponse(command as ExtensionUiResponse);
        return null;
      }

      case "extension_ui_input": {
        this.handleExtensionUiInput(command.id as string, command.data as string);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      case "bash": {
        // Beside a run it may go, as in pi's TUI: pi holds its result until the run
        // ends (recordBashResult), so a tool call never loses its result's place.
        // A prompt on its way to a run (arrived, admitted, not streaming yet), or a
        // compaction, still refuses it.
        if ((this.pendingPromptCount + this.arrivingPromptCount > 0 && !this.inner.isStreaming) || this.inner.isCompacting || this.shellRunning) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        const bashCommand = command.command as string;
        const excludeFromContext = command.excludeFromContext === true;
        // pi counts a command as running only once executeBash starts; the hook comes first.
        this.userBashPending = true;
        // A bash run flips isRunning to true: broadcast before starting so the sidebar shows the running badge immediately.
        notifyRunningChange();
        const liveOutput = this.createBashOutputSnapshots(bashCommand);
        try {
          // pi's TUI and RPC mode ask `user_bash` handlers first: one may run the
          // command itself (a sandbox, a remote host) or hand over how to. A handler
          // that throws has been reported by the runner and runs nothing, as there.
          const hooked = await this.inner.extensionRunner.emitUserBash?.({
            type: "user_bash",
            command: bashCommand,
            excludeFromContext,
            cwd: this.inner.sessionManager.getCwd(),
          }).catch((error: unknown) => {
            // The runner's extension_error is the notice, as pi's TUI shows it once.
            throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: EXTENSION_REPORTED_CODE });
          });
          let result;
          if (hooked?.result) {
            this.inner.recordBashResult?.(bashCommand, hooked.result, { excludeFromContext });
            result = hooked.result;
          } else {
            result = await this.inner.executeBash(bashCommand, liveOutput.onChunk, {
              excludeFromContext,
              // An extension's operations get what pi gives them: no `env` (its
              // executor's own, a sandbox's). Wrapping them would hand the host's
              // environment and agent bin directory into that sandbox.
              operations: hooked?.operations ?? createProjectCommandBashOperations({
                shellPath: this.inner.settingsManager.getShellPath(),
              }),
            });
          }
          this.persistBashOnlySession();
          return result;
        } finally {
          this.userBashPending = false;
          liveOutput.stop();
          // A run that ended while the command went on reports its end now (isRunning() held it).
          this.notifyAgentRunCompleteIfIdle();
          this.resetIdleTimer();
          invalidateSessionListCache();
          // bash finished (isRunning may drop back): broadcast so the sidebar running marker clears.
          notifyRunningChange();
        }
      }

      case "abort_bash": {
        this.forceShutdownOnIdle = true;
        this.forceShutdownCoversShell = true;
        this.resetIdleTimer();
        this.inner.abortBash();
        return null;
      }

        default:
          throw new Error(`Unsupported command: ${type}`);
      }
    } finally {
      promptCounted();
      if (tracksMutation) this.activeMutatingCommands = Math.max(0, this.activeMutatingCommands - 1);
    }
  }

  /**
   * Once, as closing starts and before extensions hear session_shutdown: the
   * MCP host's own handler runs after every other extension's, and one that
   * never returns would leave its records behind (lib/mcp-host.ts).
   */
  private disposeMcpHost(): void {
    if (this.mcpHostDisposed) return;
    this.mcpHostDisposed = true;
    try {
      this.mcpHost?.dispose();
    } catch (error) {
      console.error("[pi-web] MCP host dispose failed:", error instanceof Error ? error.message : error);
    }
  }

  destroy(reason: AgentWrapperEndReason = "shutdown"): void {
    if (!this._alive) return;
    this._alive = false;
    this.closingAt ??= Date.now();
    this.disposeMcpHost();
    // Tell attached SSE listeners to drop this instance so the browser
    // EventSource errors and reconnects instead of staying OPEN on a dead wrapper.
    this.emit({ type: "session_shutdown" });
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleDeadlineAt = null;
    if (this.inner.isBashRunning) this.inner.abortBash();
    this.unsubscribe?.();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();
    this.activeToolEvents.clear();
    this.clearExtensionWidgets(false);

    const finishDispose = () => {
      try {
        this.inner.dispose();
      } finally {
        // Here rather than in the registry's onDestroy callback, which a replacement swaps out.
        recordSessionClosed(this);
        this.resolveDisposed();
        try {
          this.onDestroyCallback?.(reason);
        } finally {
          try {
            this.agentSessionEndCallback?.(reason);
          } catch (e) {
            console.error("[pi-web] agent session end dispatch failed:", e instanceof Error ? e.message : e);
          }
          notifyRunningChange();
        }
      }
    };

    // Always emit session_shutdown before dispose, even when callers skip
    // shutdown() (process exit, direct destroy). Await when possible so
    // extension MCP children can reap before the runner is invalidated.
    if (this.sessionShutdownEmitted) {
      finishDispose();
      return;
    }

    this.sessionShutdownEmitted = true;
    const emit = this.inner.extensionRunner?.emit;
    if (typeof emit !== "function") {
      finishDispose();
      return;
    }

    void this.emitSessionShutdown(emit)
      .catch((error) => {
        console.error(
          "[pi-web] session_shutdown before dispose failed:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(finishDispose);
  }

  async shutdown(reason: AgentWrapperEndReason = "shutdown"): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this._alive) return;
    // Closing starts before the first await, so a request that arrives while
    // extensions shut down starts a fresh wrapper instead of prompting this one.
    this.closing = true;
    this.closingAt ??= Date.now();

    this.shutdownPromise = (async () => {
      try {
        try {
          await this.waitForExtensionsBound();
        } catch (error) {
          console.error(
            "[pi-web] extension binding failed before session shutdown:",
            error instanceof Error ? error.message : error,
          );
        }
        // After binding, so the host's session_start has run and finds nothing to record later.
        this.disposeMcpHost();
        if (!this.sessionShutdownEmitted) {
          this.sessionShutdownEmitted = true;
          const emit = this.inner.extensionRunner?.emit;
          if (typeof emit === "function") await this.emitSessionShutdown(emit);
        }
      } finally {
        this.destroy(reason);
      }
    })();
    return this.shutdownPromise;
  }

  /**
   * Gives extensions at most SESSION_SHUTDOWN_DEADLINE_MS to handle
   * session_shutdown, then returns so the SDK session is disposed and
   * unregistered anyway. Closing an MCP connection has no upper bound: it waits
   * for a token refresh in flight and for a stdio child whose daemonized
   * grandchild may never close stdout.
   */
  private async emitSessionShutdown(
    emit: NonNullable<AgentSessionLike["extensionRunner"]["emit"]>,
  ): Promise<void> {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      deadlineTimer = setTimeout(() => resolve("timeout"), SESSION_SHUTDOWN_DEADLINE_MS);
      // A quitting process must not wait for an extension's cleanup.
      deadlineTimer.unref?.();
    });
    // A synchronous throw becomes a rejection, and a rejection that arrives
    // after the deadline is still handled by the race below.
    const handled = (async () => {
      await emit.call(this.inner.extensionRunner, { type: "session_shutdown", reason: "quit" });
      return "handled" as const;
    })();
    try {
      if (await Promise.race([handled, deadline]) === "timeout") {
        console.warn(
          `[pi-web] extensions did not finish session_shutdown for session ${this.sessionId} within ${SESSION_SHUTDOWN_DEADLINE_MS} ms; disposing it anyway`,
        );
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse): void {
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) return;
    pending.resolve(response);
  }

  private getExtensionStatuses(): Array<{ key: string; text: string }> {
    return Array.from(this.extensionStatuses, ([key, text]) => ({ key, text }));
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values());
  }

  /** Skips re-pushing when a widget's content + placement are unchanged —
   *  upstream TUI animation/polling (a frame every 0.5–1s) calls
   *  requestRender repeatedly with content usually identical to the last;
   *  the old implementation emitted every time, dragging the frontend into
   *  pointless refreshes. */
  private isExtensionWidgetUnchanged(
    key: string,
    lines: readonly string[],
    placement: "aboveEditor" | "belowEditor",
  ): boolean {
    const previous = this.extensionWidgets.get(key);
    return previous !== undefined
      && previous.placement === placement
      && previous.lines.length === lines.length
      && previous.lines.every((line, index) => line === lines[index]);
  }

  private nextExtensionWidgetGeneration(key: string): number {
    const generation = (this.extensionWidgetGenerations.get(key) ?? 0) + 1;
    this.extensionWidgetGenerations.set(key, generation);
    return generation;
  }

  private disposeExtensionWidgetComponent(component: unknown): void {
    if (!component || (typeof component !== "object" && typeof component !== "function")) return;
    const dispose = (component as { dispose?: unknown }).dispose;
    if (typeof dispose !== "function") return;
    try {
      dispose.call(component);
    } catch {
      // Ignore dispose errors from extension widgets.
    }
  }

  private emitExtensionWidgetClear(key: string): void {
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: key,
      widgetLines: undefined,
      widgetPlacement: undefined,
    } as ExtensionUiRequest as AgentEvent);
  }

  private clearExtensionWidget(key: string, emitClear = true): number {
    const generation = this.nextExtensionWidgetGeneration(key);

    const active = this.activeExtensionWidgets.get(key);
    this.activeExtensionWidgets.delete(key);
    this.extensionWidgets.delete(key);
    if (active) this.disposeExtensionWidgetComponent(active.component);
    if (this.extensionWidgetGenerations.get(key) !== generation) return generation;
    if (emitClear) this.emitExtensionWidgetClear(key);
    return generation;
  }

  private clearExtensionWidgets(emitClear: boolean): void {
    const keys = new Set([
      ...this.extensionWidgets.keys(),
      ...this.activeExtensionWidgets.keys(),
    ]);
    for (const key of keys) this.clearExtensionWidget(key, emitClear);
  }

  private resetExtensionWidgetsForReload(): void {
    this.extensionWidgetsResetting = true;
    try {
      const factoryKeys = [...this.activeExtensionWidgets.keys()];
      for (const key of factoryKeys) this.clearExtensionWidget(key);
      // Keep the existing array-widget reload behavior: snapshots are reset and
      // the next extension session_start repopulates them.
      this.extensionWidgets.clear();
    } finally {
      this.extensionWidgetsResetting = false;
    }
  }

  private emitExtensionWidgetError(key: string, error: unknown): void {
    this.emit({
      type: "extension_error",
      extensionPath: `extension-widget:${key}`,
      event: "setWidget",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private failExtensionWidget(
    key: string,
    generation: number,
    error: unknown,
    clearEmitted: boolean,
    component?: unknown,
  ): void {
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.disposeExtensionWidgetComponent(component);
      return;
    }

    const active = this.activeExtensionWidgets.get(key);
    let shouldEmitClear = !clearEmitted;
    if (active?.generation === generation) {
      shouldEmitClear = active.rendered || !active.clearEmitted;
      this.activeExtensionWidgets.delete(key);
      this.disposeExtensionWidgetComponent(active.component);
    } else {
      this.disposeExtensionWidgetComponent(component);
    }
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.emitExtensionWidgetError(key, error);
      return;
    }
    this.extensionWidgets.delete(key);
    if (shouldEmitClear) this.emitExtensionWidgetClear(key);
    this.emitExtensionWidgetError(key, error);
  }

  private renderExtensionWidget(active: ActiveExtensionWidget): void {
    if (
      this.activeExtensionWidgets.get(active.key) !== active
      || this.extensionWidgetGenerations.get(active.key) !== active.generation
    ) return;

    let lines: unknown;
    try {
      lines = active.component.render(DEFAULT_CUSTOM_UI_COLUMNS);
    } catch (error) {
      this.failExtensionWidget(active.key, active.generation, error, active.clearEmitted);
      return;
    }
    if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
      this.failExtensionWidget(
        active.key,
        active.generation,
        new Error("Extension widget render must return string[]"),
        active.clearEmitted,
      );
      return;
    }
    if (
      this.activeExtensionWidgets.get(active.key) !== active
      || this.extensionWidgetGenerations.get(active.key) !== active.generation
    ) return;

    const widgetLines = lines as string[];
    if (active.rendered && this.isExtensionWidgetUnchanged(active.key, widgetLines, active.placement)) {
      return;
    }
    this.extensionWidgets.set(active.key, {
      key: active.key,
      lines: widgetLines,
      placement: active.placement,
    });
    active.rendered = true;
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: active.key,
      widgetLines,
      widgetPlacement: active.placement,
    } as ExtensionUiRequest as AgentEvent);
  }

  private setExtensionWidgetFactory(
    key: string,
    factory: ExtensionWidgetFactory,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void {
    const hadPrevious = this.extensionWidgets.has(key) || this.activeExtensionWidgets.has(key);
    const generation = this.clearExtensionWidget(key, hadPrevious);
    if (this.extensionWidgetGenerations.get(key) !== generation) return;
    const tui = createHeadlessCustomUiTui(() => {
      const active = this.activeExtensionWidgets.get(key);
      if (active?.generation === generation) this.renderExtensionWidget(active);
    }, DEFAULT_CUSTOM_UI_COLUMNS);

    let component: unknown;
    try {
      component = factory(tui, extensionUiTheme());
    } catch (error) {
      this.failExtensionWidget(key, generation, error, hadPrevious);
      return;
    }
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.disposeExtensionWidgetComponent(component);
      return;
    }
    if (
      !component
      || (typeof component !== "object" && typeof component !== "function")
      || typeof (component as { render?: unknown }).render !== "function"
    ) {
      this.failExtensionWidget(
        key,
        generation,
        new Error("Extension widget factory must return a component with render(width)"),
        hadPrevious,
        component,
      );
      return;
    }

    const active: ActiveExtensionWidget = {
      key,
      component: component as ExtensionWidgetComponent,
      placement: options?.placement ?? "aboveEditor",
      generation,
      clearEmitted: hadPrevious,
      rendered: false,
    };
    this.activeExtensionWidgets.set(key, active);
    this.renderExtensionWidget(active);
  }

  private getCustomUiWidth(options: unknown): number {
    if (!options || typeof options !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
    const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
    if (!resolved || typeof resolved !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const width = (resolved as { width?: unknown }).width;
    return typeof width === "number" && Number.isFinite(width)
      ? Math.max(40, Math.min(140, Math.round(width)))
      : 92;
  }

  private emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
    let lines: string[];
    try {
      lines = custom.component.render(custom.width);
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    const event = {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
    } as ExtensionUiRequest as AgentEvent;
    this.pendingUiRequests.set(id, event);
    this.emit(event);
  }

  private closeCustomUi(id: string, value: unknown): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || custom.settled) return;
    custom.settled = true;
    this.activeCustomUis.delete(id);
    this.pendingUiRequests.delete(id);
    try {
      custom.component.dispose?.();
    } catch {
      // Ignore dispose errors from extension UI components.
    }
    this.emit({
      type: "extension_ui_request",
      id,
      method: "custom",
      lines: [],
      closed: true,
    } as ExtensionUiRequest as AgentEvent);
    custom.resolve(value);
  }

  private handleExtensionUiInput(id: string, data: string): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || typeof data !== "string") return;
    try {
      custom.component.handleInput?.(data);
      if (this.activeCustomUis.has(id)) this.emitCustomUiRender(id, custom);
    } catch (error) {
      this.closeCustomUi(id, undefined);
      this.emit({
        type: "extension_error",
        extensionPath: `custom-ui:${id}`,
        event: "custom_ui_input",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestExtensionCustomUi<T>(
    factory: unknown,
    options?: unknown,
  ): Promise<T> {
    if (typeof factory !== "function") return Promise.resolve(undefined as T);

    const stopSignal = this.extensionUiAbortController.signal;
    if (stopSignal.aborted) return Promise.reject(stopSignal.reason);

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve, reject) => {
      let completed = false;
      const tui = createHeadlessCustomUiTui(
        () => {
          const custom = this.activeCustomUis.get(id);
          if (custom) this.emitCustomUiRender(id, custom);
        },
        width,
      );
      const finish = (value: T) => {
        if (completed) return;
        completed = true;
        stopSignal.removeEventListener("abort", onStop);
        if (stopSignal.aborted) reject(stopSignal.reason);
        else resolve(value);
      };
      const done = (value: T) => {
        if (this.activeCustomUis.has(id)) {
          this.closeCustomUi(id, value);
        } else {
          finish(value);
        }
      };
      const onStop = () => done(undefined as T);
      stopSignal.addEventListener("abort", onStop, { once: true });

      Promise.resolve()
        .then(() => completed ? undefined : factory(tui, extensionUiTheme(), CUSTOM_UI_KEYBINDINGS, done))
        .then((component) => {
          if (completed) {
            try {
              (component as CustomUiComponent | undefined)?.dispose?.();
            } catch {
              // Ignore dispose errors from a component completed before mounting.
            }
            return;
          }
          if (!component || typeof component !== "object" || typeof (component as CustomUiComponent).render !== "function") {
            finish(undefined as T);
            return;
          }
          const custom: ActiveCustomUi = {
            component: component as CustomUiComponent,
            width,
            resolve: (value) => finish(value as T),
            settled: false,
          };
          this.activeCustomUis.set(id, custom);
          this.emitCustomUiRender(id, custom);
        })
        .catch((error) => {
          if (completed) return;
          this.emit({
            type: "extension_error",
            extensionPath: `custom-ui:${id}`,
            event: "custom_ui",
            error: error instanceof Error ? error.message : String(error),
          });
          finish(undefined as T);
        });
    });
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(defaultValue);
    const stopSignal = this.extensionUiAbortController.signal;
    if (stopSignal.aborted) return Promise.reject(stopSignal.reason);
    const abortSignal = signal ? AbortSignal.any([signal, stopSignal]) : stopSignal;

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        abortSignal.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(id);
        this.pendingUiResponses.delete(id);
        this.emit({ type: "extension_ui_closed", id });
      };
      const settle = (value: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (stopSignal.aborted) reject(stopSignal.reason);
        else resolve(value);
      };
      const onAbort = () => settle(defaultValue);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      abortSignal.addEventListener("abort", onAbort, { once: true });

      this.pendingUiRequests.set(id, fullRequest as AgentEvent);
      this.pendingUiResponses.set(id, {
        resolve: (response) => settle(parseResponse(response)),
        cancel: () => settle(defaultValue),
      });
      this.emit(fullRequest as AgentEvent);
    });
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      select: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      confirm: (title, message, opts) => this.requestExtensionUi(
        { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        (response) => "confirmed" in response ? response.confirmed : false,
        opts?.timeout,
        opts?.signal,
      ),
      input: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      editor: (title, prefill, opts) => this.requestExtensionUi(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        } as ExtensionUiRequest as AgentEvent);
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        if (text === undefined) this.extensionStatuses.delete(key);
        else this.extensionStatuses.set(key, text);
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options) => {
        if (!this._alive || this.extensionWidgetsResetting) return;
        if (typeof content === "function") {
          this.setExtensionWidgetFactory(
            key,
            content as unknown as ExtensionWidgetFactory,
            options,
          );
          return;
        }
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.clearExtensionWidget(key);
          return;
        }
        const generation = this.activeExtensionWidgets.has(key)
          ? this.clearExtensionWidget(key)
          : this.nextExtensionWidgetGeneration(key);
        if (this.extensionWidgetGenerations.get(key) !== generation) return;
        const placement = options?.placement ?? "aboveEditor";
        if (this.isExtensionWidgetUnchanged(key, content, placement)) return;
        this.extensionWidgets.set(key, {
          key,
          lines: content,
          placement,
        });
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest as AgentEvent);
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as ExtensionUiRequest as AgentEvent);
      },
      custom: <T = unknown>(factory: unknown, options?: unknown) => this.requestExtensionCustomUi<T>(factory, options),
      // pi's RPC mode has no paste and sends set_editor_text; its TUI inserts at the
      // caret. The page is the TUI's editor here, so it gets an event of its own.
      pasteToEditor: (text) => {
        this.emit({ type: "editor_paste", text });
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return extensionUiTheme(); },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in Pi Web extension UI yet" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  private createExtensionCommandContextActions(): ExtensionCommandContextActionsLike {
    return {
      waitForIdle: async () => {
        const agent = this.inner.agent as { waitForIdle?: () => Promise<void> };
        await agent.waitForIdle?.();
      },
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async (targetId, options) => {
        const result = await this.navigateTreeKeepingToolSelection(targetId, { summarize: options?.summarize });
        // Same semantics as the navigate_tree command: after a branch, land the current model/thinking onto the new chain to prevent display regression.
        if (!result.cancelled) this.syncSessionSettingsAfterBranch();
        return { cancelled: result.cancelled };
      },
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        // As pi's TUI: a command runs inside its own prompt, so the pending
        // prompt does not count; only a streaming or compacting turn does.
        const busy = this.inner.isStreaming
          ? "Wait for the current response to finish before reloading."
          : this.inner.isCompacting
            ? "Wait for compaction to finish before reloading."
            : null;
        if (busy) {
          this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "notify",
            notifyType: "warning",
            message: busy,
          } as ExtensionUiRequest as AgentEvent);
          return;
        }
        this.extensionStatuses.clear();
        this.resetExtensionWidgetsForReload();
        this.syncProjectTrust();
        await this.inner.reload({
          beforeSessionStart: () => {
            this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
          },
        });
        this.reportReloadIssues();
        // As the `reload` command: the provider lists' runtime follows.
        invalidateModelRuntimeWithExtensions();
      },
    };
  }

  /** A startup issue found once the wrapper exists (the model it could not restore); none for a subagent or side chat. */
  addStartupIssue(issue: StartupIssue): void {
    if (this.startupNotices) this.notifyIssue(issue);
  }

  /** Tells the streams open now; a session's own wrapper keeps the notice for the ones opened later. */
  private notifyIssue(issue: StartupIssue): void {
    const notice = {
      type: "extension_ui_request",
      id: randomUUID(),
      method: "notify",
      notifyType: issue.type,
      message: issue.message,
    } as ExtensionUiRequest as AgentEvent;
    if (this.startupNotices && this.startupNotices.length < STARTUP_NOTICE_LIMIT) this.startupNotices.push(notice);
    this.emit(notice);
  }

  /**
   * pi's TUI lists `[Extension issues]` again after `/reload`: an edited extension that broke says
   * so to every stream on the session, and they replace the startup notices later streams get.
   */
  private reportReloadIssues(): void {
    let issues: StartupIssue[];
    try {
      issues = collectStartupIssues({ extensions: this.inner.resourceLoader?.getExtensions?.() });
    } catch {
      return; // The reload itself went through; its report is best effort.
    }
    for (const issue of issues) console.warn(`[pi-web] session ${this.sessionId} reload: ${issue.message}`);
    if (this.startupNotices) this.startupNotices.length = 0;
    for (const issue of limitStartupNotices(issues)) this.notifyIssue(issue);
  }

  /**
   * The Stop signal extension dialogs answer to, renewed when an earlier Stop left it aborted
   * (Stop rejects every dialog shown under it). A `session_before_*` hook needs it renewed too:
   * pi's runner logs a handler that throws and goes on as if it had not answered, so a guard's
   * "Fork anyway?" would never show and the fork would go through.
   */
  private renewExtensionUiStop(): AbortSignal {
    if (this.extensionUiAbortController.signal.aborted) {
      this.extensionUiAbortController = new AbortController();
    }
    return this.extensionUiAbortController.signal;
  }

  /**
   * As AgentSessionRuntime.emitBeforeFork(): only when a handler listens, and true on `{ cancel: true }`.
   * A Stop while it runs counts as a cancel: it closes the handler's dialog, which pi's TUI answers
   * with `undefined` and a guard reads as no.
   */
  private async forkCancelledByExtension(entryId: string, position: "before" | "at"): Promise<boolean> {
    const stopSignal = this.renewExtensionUiStop();
    // Bound first, as pi forks only a bound session: before that a handler sees no UI
    // (`ctx.hasUI` false) and takes its non-interactive branch. A binding that failed
    // leaves no handler to ask; the copy goes on.
    try {
      await this.waitForExtensionsBound();
    } catch {
      return false;
    }
    const runner = this.inner.extensionRunner;
    if (!runner.emit || !runner.hasHandlers?.("session_before_fork")) return false;
    const result = await runner.emit({ type: "session_before_fork", entryId, position });
    return (result as { cancel?: unknown } | undefined)?.cancel === true || stopSignal.aborted;
  }

  private syncProjectTrust(): void {
    const status = getProjectTrustStatus(this.cwd, getAgentDir());
    this.inner.settingsManager.setProjectTrusted(status.trusted);
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piRunningListeners: Set<(ids: string[]) => void> | undefined;
  var __piRunningSnapshot: string | undefined;
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  /** Debug panel: the id a `__new__…`/`__recreate__…` start registered its wrapper under, while its lock is held. */
  var __piStartRegisteredIds: Map<string, string> | undefined;
  var __piStartingSessionCwds: Map<string, number> | undefined;
  var __piStartingSessionIds: Set<string> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const destroy = () => globalThis.__piSessions?.forEach((session) => typeof session.destroy === "function" && session.destroy());
    const shutdown = () => {
      const sessions = Array.from(globalThis.__piSessions?.values() ?? []);
      void Promise.allSettled(sessions.map((session) => session.shutdown()));
    };
    // Node cannot await work from an exit handler; direct destruction starts
    // extension cleanup synchronously as a final best effort.
    process.once("exit", destroy);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  return globalThis.__piSessions;
}

/**
 * Each session id's wrapper starts and last close, for the debug panel: a wrapper reaped and
 * rebuilt reads apart from one that stayed up. On globalThis, as the registry, so a hot reload
 * keeps it; bounded, oldest first, never dropping an id that still has a wrapper.
 */
const SESSION_LIFECYCLE_KEY = Symbol.for("pi-web:session-lifecycle");
const SESSION_LIFECYCLE_LIMIT = 1000;

function readSessionLifecycles(): Map<string, DebugSessionLifecycle> | null {
  const existing = (globalThis as Record<PropertyKey, unknown>)[SESSION_LIFECYCLE_KEY];
  return existing instanceof Map ? existing as Map<string, DebugSessionLifecycle> : null;
}

// Bookkeeping only: a failure here must never keep a wrapper from starting.
function recordSessionStart(sessionId: string): void {
  try {
    let lifecycles = readSessionLifecycles();
    if (!lifecycles) {
      lifecycles = new Map();
      (globalThis as Record<PropertyKey, unknown>)[SESSION_LIFECYCLE_KEY] = lifecycles;
    }
    const now = Date.now();
    const previous = lifecycles.get(sessionId);
    lifecycles.delete(sessionId);
    lifecycles.set(sessionId, {
      starts: (typeof previous?.starts === "number" ? previous.starts : 0) + 1,
      firstStartedAt: typeof previous?.firstStartedAt === "number" ? previous.firstStartedAt : now,
      lastStartedAt: now,
      lastClosedAt: typeof previous?.lastClosedAt === "number" ? previous.lastClosedAt : null,
    });
    const sessions = globalThis.__piSessions;
    for (const id of lifecycles.keys()) {
      if (lifecycles.size <= SESSION_LIFECYCLE_LIMIT) break;
      if (id !== sessionId && !sessions?.has(id)) lifecycles.delete(id);
    }
  } catch {
    // The panel shows no history for this id.
  }
}

// Called from finishDispose(): it must never throw past resolveDisposed().
function recordSessionClosed(wrapper: { readonly sessionId: string }): void {
  try {
    const lifecycle = readSessionLifecycles()?.get(wrapper.sessionId);
    if (lifecycle) lifecycle.lastClosedAt = Date.now();
  } catch {
    // The panel shows no close time for this id.
  }
}

function registerRpcWrapper(wrapper: AgentSessionWrapper): void {
  const registry = getRegistry();
  const sessionId = wrapper.sessionId;
  if (wrapper.sessionFile) cacheSessionPath(sessionId, wrapper.sessionFile);
  // A closing wrapper reports itself dead while extensions shut down, so the
  // next request registers a replacement under the same id. Finishing later,
  // the closing wrapper must not unregister that replacement.
  wrapper.onDestroy(() => {
    if (registry.get(sessionId) === wrapper) registry.delete(sessionId);
  });
  // A wrapper registered before a hot reload still unregisters by id alone.
  const previous = registry.get(sessionId);
  if (previous && previous !== wrapper && typeof previous.onDestroy === "function") {
    previous.onDestroy(() => {});
  }
  recordSessionStart(sessionId);
  registry.set(sessionId, wrapper);
  wrapper.start();
  if (!wrapper.isChatOnly()) wrapper.beginExtensionBinding();
}

const SUBAGENT_CONTROLLER = createSubagentController({
  getSession: (sessionId) => getRegistry().get(sessionId),
  registerSession: (inner, options) => {
    const wrapper = new AgentSessionWrapper(inner, {
      ...(options?.exactSystemPrompt !== undefined
        ? { exactSystemPrompt: options.exactSystemPrompt }
        : {}),
      chatOnly: options?.chatOnly,
      suppressCompletionNotifications: true,
      onDirectTurnSettled: (aborted) => SUBAGENT_CONTROLLER.settleDirectTurn(inner.sessionId, aborted),
      ...(options?.mcpHost ? { mcpHost: options.mcpHost } : {}),
    });
    registerRpcWrapper(wrapper);
    return wrapper;
  },
  reopenSession: async (sessionId, sessionFile) =>
    (await startRpcSession(sessionId, sessionFile, undefined)).session,
  resolveSessionPath,
  invalidateSessionList: invalidateSessionListCache,
  isBuiltInSubagentsEnabled,
});

export function getSubagentRun(sessionId: string) {
  return SUBAGENT_CONTROLLER.get(sessionId);
}

export function steerSubagent(sessionId: string, message: string) {
  return SUBAGENT_CONTROLLER.steer(sessionId, message);
}

export function abortSubagent(sessionId: string) {
  return SUBAGENT_CONTROLLER.abort(sessionId);
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

// Bookkeeping for getRpcStartingSessionIds() only: a failure here must never fail a start.
function recordStartRegisteredId(startKey: string, realSessionId: string): void {
  try {
    if (startKey === realSessionId) return;
    if (!(globalThis.__piStartRegisteredIds instanceof Map)) globalThis.__piStartRegisteredIds = new Map();
    globalThis.__piStartRegisteredIds.set(startKey, realSessionId);
  } catch {
    // The panel counts this start as starting until its lock goes.
  }
}

function forgetStartRegisteredId(startKey: string): void {
  try {
    const registered = globalThis.__piStartRegisteredIds;
    if (registered instanceof Map) registered.delete(startKey);
  } catch {
    // Nothing reads a key whose lock is gone.
  }
}

const CLOSING_SESSION_WAIT_MARGIN_MS = 1_000;
const closingSessionWaits = new WeakMap<AgentSessionWrapper, { done: boolean; promise: Promise<void> }>();

/**
 * The wait for a wrapper of `sessionId` that is shutting down, or null when there is none
 * left to wait for. Until it is disposed the closing wrapper still owns the session: an
 * extension's session_shutdown may append to the file, which a replacement opened earlier
 * would branch away from, and dispose() releases provider resources (a Codex websocket) by
 * session id, which the replacement shares. The wait is bounded so a shutdown stuck in
 * extension binding cannot keep the session from starting again. One wait per closing
 * wrapper: its bound runs from the first caller and later callers share it, so a
 * shutdown still binding extensions can be overtaken.
 */
function closingRpcSessionWait(sessionId: string): Promise<void> | null {
  const closing = getRegistry().get(sessionId);
  // A wrapper from before a hot reload may lack waitUntilDisposed.
  if (!closing || closing.isAlive() || typeof closing.waitUntilDisposed !== "function") return null;
  let wait = closingSessionWaits.get(closing);
  if (!wait) {
    const entry = { done: false, promise: Promise.resolve() };
    entry.promise = closing.waitUntilDisposed(SESSION_SHUTDOWN_DEADLINE_MS + CLOSING_SESSION_WAIT_MARGIN_MS)
      .then((disposed) => {
        if (!disposed) console.warn(`[pi-web] session ${sessionId} is still shutting down; starting it again anyway`);
      })
      .finally(() => { entry.done = true; });
    closingSessionWaits.set(closing, entry);
    wait = entry;
  }
  return wait.done ? null : wait.promise;
}

function normalizeRpcCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

function getStartingSessionCwds(): Map<string, number> {
  if (!globalThis.__piStartingSessionCwds) globalThis.__piStartingSessionCwds = new Map();
  return globalThis.__piStartingSessionCwds;
}

/**
 * The set of starting session ids: the wrapper is not yet registered in the
 * registry, but an old session's resume startup has begun.
 * getRunningRpcSessionIds merges it → the SSE running frame reaches the
 * frontend the instant startup begins (the sidebar tree lights up "running"
 * immediately); the outcome (success/failure) removes it and broadcasts in
 * startRpcSession's finally. Carried on globalThis: dev HMR swapping module
 * instances must not lose the set.
 */
function getStartingSessionIds(): Set<string> {
  if (!globalThis.__piStartingSessionIds) globalThis.__piStartingSessionIds = new Set();
  return globalThis.__piStartingSessionIds;
}

function trackStartingSession(cwd: string): () => void {
  const startingCwds = getStartingSessionCwds();
  const key = normalizeRpcCwd(cwd);
  startingCwds.set(key, (startingCwds.get(key) ?? 0) + 1);
  return () => {
    const remaining = (startingCwds.get(key) ?? 1) - 1;
    if (remaining > 0) startingCwds.set(key, remaining);
    else startingCwds.delete(key);
  };
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

/**
 * The sidebar's rename (#1388). A session a wrapper holds is renamed through
 * `AgentSession.setSessionName()`, as pi's `/name`, so the `session_info` entry hangs off the live
 * leaf and extensions get `session_info_changed`; appended to the file from outside, it was a dead
 * branch the running session never saw. Like the `set_session_name` command it does not wait for
 * session_start: handlers are registered at load, and a session_start that never settles (an
 * unanswered dialog) must not hold the rename. A start in flight is awaited (its `SessionManager`
 * has already read the file), as is a wrapper shutting down (its extensions may still append from
 * its leaf). With no wrapper and no start, `writeToDisk` runs synchronously right after that check,
 * so nothing can open the file between the two. Resolves what `writeToDisk` returns, or true.
 */
export async function renameRpcSession(sessionId: string, name: string, writeToDisk: () => boolean): Promise<boolean> {
  for (;;) {
    const wrapper = getRegistry().get(sessionId);
    if (wrapper?.isAlive()) {
      wrapper.inner.setSessionName(name);
      invalidateSessionListCache();
      return true;
    }
    const pending = getLocks().get(sessionId) ?? closingRpcSessionWait(sessionId);
    if (!pending) return writeToDisk();
    await pending.catch(() => undefined);
  }
}

export interface SetRpcSessionToolsResult {
  session: AgentSessionWrapper;
  sessionId: string;
  recreated: boolean;
}

/**
 * Persist a normal session's tool selection and rebuild when resource policy changes.
 * An undefined requestedToolNames returns the session to pi's configured defaults:
 * the pin is retracted and the session is rebuilt, because the loadout that
 * settings.json defaultTools resolves to is only known once pi builds the session.
 */
export async function setRpcSessionTools(
  sessionId: string,
  sessionFile: string | undefined,
  requestedToolNames: unknown,
): Promise<SetRpcSessionToolsResult> {
  const toolNames = requestedToolNames === undefined
    ? undefined
    : validateSessionToolSelection(requestedToolNames);
  const existing = getRpcSession(sessionId);

  if (!existing?.isAlive()) {
    if (!sessionFile) throw new Error("Session not found");
    // A wrapper still closing, or a start already under way, owns the file: wait for it and
    // apply the selection to whatever it left, or a start that opened the file first would
    // come up without the selection while this call reported success.
    const pending = closingRpcSessionWait(sessionId) ?? getLocks().get(sessionId);
    if (pending) {
      await pending.catch(() => undefined);
      return setRpcSessionTools(sessionId, sessionFile, requestedToolNames);
    }
    const manager = SessionManager.open(sessionFile, undefined);
    if (readSubagentSessionResources(manager.getEntries() as unknown as SessionEntry[])) {
      throw new Error("Subagent tool selection is fixed by its profile");
    }
    if (hasSideMetadata(manager.getEntries() as unknown as SessionEntry[])) {
      throw new Error("Side chat tools are fixed when it is forked");
    }
    if (toolNames === undefined) appendClearedSessionToolSelection(manager);
    else appendSessionToolSelection(manager, toolNames);
    invalidateSessionListCache();
    const started = await startRpcSession(sessionId, sessionFile, undefined);
    return { session: started.session, sessionId: started.realSessionId, recreated: false };
  }

  if (existing.isRunning()) throw new Error("Cannot change tools while the session is running");
  if (readSubagentSessionResources(existing.inner.sessionManager.getEntries() as unknown as SessionEntry[])) {
    throw new Error("Subagent tool selection is fixed by its profile");
  }
  if (hasSideMetadata(existing.inner.sessionManager.getEntries() as unknown as SessionEntry[])) {
    throw new Error("Side chat tools are fixed when it is forked");
  }

  const hasCurrentResourcePolicy = typeof existing.isChatOnly === "function"
    && typeof existing.setActiveToolSelection === "function";
  const crossesChatOnlyBoundary = toolNames === undefined
    || !hasCurrentResourcePolicy
    || existing.isChatOnly() !== (toolNames.length === 0);
  if (toolNames === undefined) appendClearedSessionToolSelection(existing.inner.sessionManager);
  else appendSessionToolSelection(existing.inner.sessionManager, toolNames);
  invalidateSessionListCache();

  if (toolNames !== undefined && !crossesChatOnlyBoundary) {
    existing.setActiveToolSelection(toolNames);
    return { session: existing, sessionId, recreated: false };
  }

  const persistedFile = existing.sessionFile && existsSync(existing.sessionFile)
    ? existing.sessionFile
    : undefined;
  const sessionCwd = existing.cwd;
  const model = existing.inner.model;
  const currentThinkingLevel = existing.inner.agent.state?.thinkingLevel;
  await existing.shutdown();

  if (persistedFile) {
    const started = await startRpcSession(sessionId, persistedFile, undefined);
    return { session: started.session, sessionId: started.realSessionId, recreated: true };
  }

  const started = await startRpcSession(`__recreate__${randomUUID()}`, "", sessionCwd, {
    ...(toolNames !== undefined ? { toolNames } : {}),
    ...(model ? { initialModel: { provider: model.provider, modelId: model.id } } : {}),
    allowInitialModelFallback: true,
    ...(currentThinkingLevel && THINKING_LEVEL_NAMES.has(currentThinkingLevel as ThinkingLevel)
      ? { thinkingLevel: currentThinkingLevel as ThinkingLevel }
      : {}),
  });
  return { session: started.session, sessionId: started.realSessionId, recreated: true };
}

function runtimeMessageText(entry: SessionMessageEntry): string {
  if (entry.message.role === "bashExecution") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join(" ");
}

function runtimeMessageActivityMs(entry: SessionMessageEntry): number | undefined {
  if (entry.message.role !== "user" && entry.message.role !== "assistant") return undefined;
  if (typeof entry.message.timestamp === "number") return entry.message.timestamp;
  const timestamp = new Date(entry.timestamp).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * A subagent's status as the session list and viewer show it. Only this process can finish a
 * run, so a running wrapper or the live run map decides; a persisted `running` / `queued` with
 * neither was left by a process that stopped mid-run and reads as `interrupted`, as
 * `get_subagent_result` reports it. Applied per response, never to the cached scan.
 */
export function subagentDisplayStatus(sessionId: string, persisted: SubagentSessionStatus): SubagentSessionStatus {
  if (getRegistry().get(sessionId)?.isRunning()) return "running";
  return getLiveSubagentStatus(sessionId) ?? settleOrphanedSubagentStatus(persisted);
}

export function withSubagentDisplayStatus(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.map((session) => {
    const relation = session.relation;
    if (relation?.kind !== "subagent") return session;
    const status = subagentDisplayStatus(session.id, relation.status);
    return status === relation.status ? session : { ...session, relation: { ...relation, status } };
  });
}

/**
 * Return live sessions that should be visible in the session list. Pi delays
 * the first JSONL flush until an assistant message exists, so an accepted new
 * prompt must temporarily be described from its in-memory SessionManager.
 */
export function getRpcSessionInfos(options: { includeTransient?: boolean } = {}): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (const session of getRegistry().values()) {
    if (typeof session.isAlive !== "function" || !session.isAlive()) continue;

    const manager = session.inner?.sessionManager;
    if (!manager) continue;
    const header = manager.getHeader();
    const entries = manager.getEntries() as unknown as Array<
      { type: string; timestamp: string } | SessionMessageEntry
    >;
    const messages = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
    const firstUserMessage = messages.find((entry) => entry.message.role === "user");
    const sessionFile = manager.getSessionFile() ?? session.sessionFile;
    const persisted = Boolean(sessionFile && existsSync(sessionFile));
    const subagent = readSubagentRun(entries as unknown as SessionEntry[], header?.id ?? session.sessionId, sessionFile ?? "");
    const side = subagent ? null : readSideRelation(entries as unknown as SessionEntry[]);

    // An ensure_session call creates an idle, empty runtime while the composer
    // loads commands. Do not leak it into history before a prompt is accepted.
    if (!persisted && !options.includeTransient && (!session.isRunning() || !firstUserMessage)) continue;

    const created = header?.timestamp
      ?? entries[0]?.timestamp
      ?? new Date().toISOString();
    const headerTimestamp = new Date(created).getTime();
    let lastActivityMs = Number.isNaN(headerTimestamp) ? Date.now() : headerTimestamp;
    for (const message of messages) {
      const activityMs = runtimeMessageActivityMs(message);
      if (activityMs !== undefined) lastActivityMs = Math.max(lastActivityMs, activityMs);
    }

    sessions.push({
      path: sessionFile ?? "",
      id: header?.id ?? session.sessionId,
      cwd: header?.cwd ?? session.cwd,
      name: manager.getSessionName(),
      created,
      modified: new Date(lastActivityMs).toISOString(),
      messageCount: messages.length,
      firstMessage: catalogFirstMessage(firstUserMessage ? runtimeMessageText(firstUserMessage) || "(no messages)" : "(no messages)"),
      ...(subagent ? {
        parentSessionId: subagent.parentSessionId,
        relation: {
          kind: "subagent" as const,
          parentSessionId: subagent.parentSessionId,
          profile: subagent.profile,
          description: subagent.description,
          status: session.isRunning() ? "running" as const : subagent.status,
        },
      } : side ? {
        parentSessionId: side.parentSessionId,
        relation: { kind: "side" as const, ...side },
      } : {}),
      transient: !persisted,
    });
  }
  return sessions;
}

export function hasBusyRpcSessionForCwd(cwd: string): boolean {
  const targetCwd = normalizeRpcCwd(cwd);
  if (getStartingSessionCwds().has(targetCwd)) return true;
  return Array.from(getRegistry().values()).some(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd && typeof session.isRunning === "function" && session.isRunning(),
  );
}

export async function destroyRpcSessionsForCwd(cwd: string): Promise<number> {
  const targetCwd = normalizeRpcCwd(cwd);
  const sessions = Array.from(getRegistry().values()).filter(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd,
  );
  await Promise.all(sessions.map((session) => session.shutdown()));
  return sessions.length;
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (typeof session.isRunning === "function" && session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  // Starting (not yet registered) old sessions: the wrapper is not in the
  // registry yet but startup has begun — count them in the running set (the
  // sidebar tree lights up immediately; see startRpcSession's pre-broadcast).
  for (const id of getStartingSessionIds()) ids.add(id);
  return [...ids];
}

/**
 * Attached (alive) rpc session ids — includes idle sessions. Guards for
 * disk-mutating operations (archive/move/delete) must use this, not the
 * running-only list: an idle-but-open session keeps its SessionManager in
 * memory and will silently recreate its JSONL on the next turn after the
 * file is moved away (archived snapshot + resurrected live file, both stale).
 */
export function getAliveRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    // duck-typing tolerance: the registry may hold non-standard handles (e.g.
    // the upstream #440 test mock carries only isRunning/shutdown); real
    // wrappers with isAlive keep the original semantics, otherwise degrade to
    // an isRunning probe.
    const alive = typeof session.isAlive === "function"
      ? session.isAlive()
      : typeof (session as { isRunning?: unknown }).isRunning === "function"
        && (session as { isRunning: () => boolean }).isRunning();
    if (alive) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

/**
 * The running sessions parked on an extension's dialog, a subset of
 * getRunningRpcSessionIds(): same poll, so the sidebar can tell a run that needs
 * a person from one that is still working.
 */
export function getAwaitingInputRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isAwaitingInput()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

/**
 * Actively releases an "alive but not running" rpc session.
 *
 * Called when the user explicitly archives/deletes: the conversation ended
 * long ago and only the handle remains attached (idle-but-open); demanding
 * the user close the page first is unreasonable — this clears the handle on
 * the user's behalf (shutdown flushes to disk), making the subsequent disk
 * operation safe. Sessions truly running are left untouched.
 *
 * Returns a verdict for the caller on whether to proceed with disk changes:
 *  - "stopped":     shutdown finished and the wrapper left the registry; safe to archive/delete
 *  - "running":     truly running (isRunning); untouched — the caller must refuse the operation
 *  - "not-alive":   the session is no longer in the registry (never a guard target)
 *  - "missing":     not this process's rpc session (held externally, e.g. a TUI bridge); the caller decides
 *  - "still-alive": still alive after shutdown (rare: destroy stuck); the caller should conservatively skip
 */
export async function stopIdleRpcSession(
  sessionId: string,
): Promise<"stopped" | "running" | "not-alive" | "missing" | "still-alive"> {
  const wrapper = getRpcSession(sessionId);
  if (!wrapper) return "missing";
  if (!wrapper.isAlive()) return "not-alive";
  if (wrapper.isRunning()) return "running";
  try {
    await wrapper.shutdown("shutdown");
  } catch (error) {
    console.error("[pi-web] stopIdleRpcSession shutdown failed:", error instanceof Error ? error.message : error);
  }
  return wrapper.isAlive() ? "still-alive" : "stopped";
}

/** One registered wrapper as the debug panel reads it (lib/debug-snapshot.ts). */
export interface RpcSessionDebugEntry {
  snapshot: DebugWrapperSnapshot;
  /** Matches liveness providers registered by file; never sent to the browser. */
  sessionFile: string | null;
  /** The MCP host's state; read for the session the panel shows only. */
  readMcp(): DebugMcpHost | null;
}

type MaybeStaleWrapper = Partial<Pick<AgentSessionWrapper, "isAlive" | "isRunning" | "getDebugSnapshot" | "getMcpDebugSnapshot">>;

/** A wrapper built before a hot reload has no getDebugSnapshot(): only state and running are known. */
function staleWrapperSnapshot(sessionId: string, wrapper: MaybeStaleWrapper): DebugWrapperSnapshot {
  let alive = false;
  let running = false;
  try { alive = typeof wrapper.isAlive === "function" && wrapper.isAlive() === true; } catch { /* unknown: closing */ }
  try { running = typeof wrapper.isRunning === "function" && wrapper.isRunning() === true; } catch { /* unknown: idle */ }
  return {
    sessionId,
    state: alive ? "alive" : "closing",
    stale: true,
    subagent: false,
    chatOnly: false,
    createdAt: null,
    startedAt: null,
    closingAt: null,
    extensions: "none",
    run: {
      running,
      streaming: false,
      promptRunning: false,
      pendingPrompts: 0,
      bashRunning: false,
      compacting: false,
      retrying: false,
      queuedMessages: 0,
      waitingForMcp: false,
      runningTools: 0,
      mutatingCommands: 0,
      replacement: null,
    },
    idle: { timeoutMs: SESSION_IDLE_TIMEOUT_MS, nextCheckAt: null, lastResetAt: null, forcedByStop: false },
    awaitingInput: false,
    pendingUiRequests: 0,
    customUis: 0,
    eventListeners: 0,
    lastEvent: null,
    lastCommand: null,
  };
}

/**
 * Every registered wrapper, closing ones included, for the debug panel. Reads the registry
 * global itself (getRegistry() installs process handlers) and only reads each wrapper: one
 * that fails to describe itself is listed as stale rather than failing the rest.
 */
export function getRpcSessionDebugSnapshots(): RpcSessionDebugEntry[] {
  const registry = globalThis.__piSessions;
  if (!(registry instanceof Map)) return [];
  const entries: RpcSessionDebugEntry[] = [];
  for (const [key, session] of registry) {
    const wrapper = session as MaybeStaleWrapper & { readonly sessionFile?: unknown };
    let snapshot: DebugWrapperSnapshot;
    try {
      snapshot = typeof wrapper.getDebugSnapshot === "function"
        ? wrapper.getDebugSnapshot()
        : staleWrapperSnapshot(key, wrapper);
    } catch {
      snapshot = staleWrapperSnapshot(key, wrapper);
    }
    if (!snapshot.sessionId) snapshot = { ...snapshot, sessionId: key };
    let sessionFile: string | null = null;
    try {
      sessionFile = typeof wrapper.sessionFile === "string" && wrapper.sessionFile ? wrapper.sessionFile : null;
    } catch { /* matched by id only */ }
    entries.push({
      snapshot,
      sessionFile,
      readMcp: () => typeof wrapper.getMcpDebugSnapshot === "function" ? wrapper.getMcpDebugSnapshot() : null,
    });
  }
  return entries;
}

/** The start and close history of a session id; null when no wrapper was started for it. */
export function getRpcSessionLifecycle(sessionId: string): DebugSessionLifecycle | null {
  const lifecycle = readSessionLifecycles()?.get(sessionId);
  if (!lifecycle || typeof lifecycle.starts !== "number") return null;
  return {
    starts: lifecycle.starts,
    firstStartedAt: lifecycle.firstStartedAt,
    lastStartedAt: lifecycle.lastStartedAt,
    lastClosedAt: lifecycle.lastClosedAt ?? null,
  };
}

/**
 * The startRpcSession() calls under way with no alive wrapper yet: a lock outlives the
 * wrapper's registration while a deferred model is switched to. `__new__…` and
 * `__recreate__…` keys name a start whose id pi has not chosen yet; once its wrapper is
 * registered, the key is looked up under that id.
 */
export function getRpcStartingSessionIds(): string[] {
  const locks = globalThis.__piStartLocks;
  if (!(locks instanceof Map)) return [];
  const sessions = globalThis.__piSessions;
  const registered = globalThis.__piStartRegisteredIds;
  const ids: string[] = [];
  for (const key of locks.keys()) {
    const registeredId = registered instanceof Map ? registered.get(key) : undefined;
    const id = typeof registeredId === "string" && registeredId ? registeredId : key;
    const wrapper = sessions instanceof Map ? sessions.get(id) as MaybeStaleWrapper | undefined : undefined;
    let alive = false;
    try { alive = typeof wrapper?.isAlive === "function" && wrapper.isAlive() === true; } catch { /* starting */ }
    if (!alive) ids.push(key);
  }
  return ids;
}

export function getCompletionNotificationSuppressedRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning() && session.hasSuppressedCompletionNotifications()) {
      ids.add(session.sessionId || sessionId);
    }
  }
  return [...ids];
}

/**
 * Offline session stats (2026-09-15): a read-only answer when no wrapper
 * exists — aggregates directly from the session file and never starts a
 * runtime. Serves the lazy get_session_stats: opening a session page / stats
 * panel is often just a glance; it should not cold-start a full agent (with
 * extensions/MCP/child processes), nor should this instance fabricate a
 * stale in-memory wrapper masking other ends' progress. Same semantics as
 * the online version (computeSessionStats), only missing the runtime-only
 * contextUsage. Session-file opening is consolidated in this module (do not
 * repeat SessionManager.open in other routes — avoids divergent read opens).
 */
export function getOfflineSessionStats(sessionId: string, sessionFile: string): Record<string, unknown> {
  const sm = SessionManager.open(sessionFile);
  const entries = sm.getEntries();
  return {
    ...computeSessionStats(entries as unknown as SessionEntry[]),
    sessionId,
    sessionFile,
    sessionName: sm.getSessionName(),
    totalActiveMs: computeSessionTotalActiveMs(entries),
  };
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * New sessions resolve enabledModels before construction so the initial model,
 * thinking pin, and SDK scopedModels share one settings snapshot.
 * Pass options.toolNames to pre-configure active tools (empty = all disabled).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: RpcSessionStartOptions = {},
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const { toolNames, initialModel, allowInitialModelFallback, thinkingLevel } = options;
  // Brand-new creation (empty sessionFile = the SessionManager.create branch)
  // vs opening/resuming an existing session.
  // Only the former broadcasts sm:session-created after a successful startup
  // (cross-tab sidebar lists gain the row immediately).
  const isNewSession = !sessionFile;

  // ── Single-writer red-line master gate: a session file claimed by a TUI
  //    bridge never gets a local runtime ──
  // Every caller that creates sessions through here (queue-recovery,
  // context, auto-name, etc.) is protected by this gate; routes that need
  // bridged behavior should attachIfBridged before calling.
  // Files forked out by subagents are brand-new local files (the parent
  // marker is only a header reference) and belong to no bridge session —
  // callers pass skipBridgeCheck to skip explicitly.
  if (!options.skipBridgeCheck) {
    for (const p of listProviders()) {
      if (!p.ownsFile) continue;
      try {
        if (sessionFile && (await p.ownsFile(sessionFile))) {
          throw new BridgeOccupiedError(
            sessionFile,
            `claimed by backend "${p.type}"`,
          );
        }
      } catch (e) {
        if (e instanceof BridgeOccupiedError) throw e;
        console.error(`[rpc] ${p.type}.ownsFile failed:`, e instanceof Error ? e.message : e);
      }
    }
  }

  const requestedToolNames = options.toolNames === undefined
    ? undefined
    : validateSessionToolSelection(options.toolNames);
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const closingWait = closingRpcSessionWait(sessionId);
  if (closingWait) {
    // Concurrent starts share this lock, then the one start that follows it.
    const waiting: Promise<{ session: AgentSessionWrapper; realSessionId: string }> = closingWait.then(() => {
      if (locks.get(sessionId) === waiting) locks.delete(sessionId);
      return startRpcSession(sessionId, sessionFile, cwd, options);
    });
    locks.set(sessionId, waiting);
    return waiting;
  }

  // ── Pre-broadcast running (old sessions light up "running" the moment
  //    startup begins, 2026-09-12) ──
  // startRpcSession's startup is heavy async work (createAgentSessionServices
  // extension loading + createAgentSessionFromServices agent process/history/
  // MCP startup; seconds to tens of seconds for an old session). Previously
  // the running broadcast only happened after startup finished and a prompt
  // was submitted (notifyRunningChange lives in the prompt branch) → the
  // sidebar tree's "running" spinner stayed dark for a long time (user
  // report: "after restarting, sending a message to an old session took ages
  // to reflect"). Here the sessionId enters the starting set and broadcasts
  // at the very start: getRunningRpcSessionIds merges the starting set → the
  // SSE running frame reaches the frontend immediately; the startup outcome
  // (success: wrapper registered and takes over; failure: startup throws) is
  // finalized by the IIFE's finally below, which broadcasts the exit
  // (snapshot dedup prevents duplicate broadcasts on the success path).
  // New sessions (empty sessionFile) do not broadcast here: their sessionId
  // is a one-shot __new__ placeholder key and the list row is not on disk
  // yet; they go through the existing sm:session-created + pendingDraft
  // draft-row channel.
  if (!isNewSession) {
    getStartingSessionIds().add(sessionId);
    notifyRunningChange();
  }

  let sessionManager: SessionManager;
  if (sessionFile) {
    sessionManager = SessionManager.open(sessionFile, undefined);
  } else {
    if (!cwd) throw new Error("cwd is required for a new session");
    // Pre-generate the session id instead of letting pi assign one AFTER the
    // AgentSession exists. Extension-facing hooks (collectAgentTools →
    // agentTools, dispatchAgentSession) need one consistent id, but for new
    // sessions the caller passes a one-time key (`__new__<uuid>`) that pi
    // never adopts — the id only becomes real after createAgentSessionFromServices.
    // Pre-generating it here means every hook sees the same id before and
    // after creation. randomUUID (v4) is fine: file names sort by their
    // timestamp prefix; the id is only a same-timestamp tiebreaker.
    sessionManager = SessionManager.create(cwd, undefined, { id: randomUUID() });
  }
  // The file's header id is authoritative for every hook below (the caller's
  // key may be a temp `__new__…` key), so read the id back from the manager.
  const sessionManagerId = sessionManager.getSessionId();
  const sessionCwd = sessionManager.getCwd();
  const sessionEntries = sessionManager.getEntries() as unknown as SessionEntry[];
  const hasPersistedSubagentSnapshot = sessionFile && hasSubagentResourceSnapshot(sessionEntries);
  const subagentResources = sessionFile
    ? readSubagentSessionResources(sessionEntries)
    : null;
  if (hasPersistedSubagentSnapshot && !subagentResources) {
    throw new Error("Invalid subagent resource snapshot");
  }
  const persistedToolNames = subagentResources
    ? undefined
    : readSessionToolSelection(sessionEntries);
  const pinnedToolNames = subagentResources?.tools ?? persistedToolNames ?? requestedToolNames;
  if (!subagentResources && persistedToolNames === undefined && requestedToolNames !== undefined) {
    appendSessionToolSelection(sessionManager, requestedToolNames);
  }
  const subagentLoadsResources = Boolean(
    subagentResources?.loadExtensions || subagentResources?.loadSkills || subagentResources?.codemode || subagentResources?.mcp,
  );
  const chatOnly = pinnedToolNames?.length === 0 && !subagentLoadsResources;
  // A side chat (ADR 0007) starts as a normal session, or as Chat only, with fewer tools.
  const isSideChat = hasSideMetadata(sessionEntries);
  if (isSideChat && !readSideRelation(sessionEntries)) throw new Error("Invalid side chat metadata");
  const sideChatTools = isSideChat && !chatOnly;
  const selectedToolNames = sideChatTools
    ? sideToolNames(pinnedToolNames, sessionManager.getBranch().flatMap((entry) => (
        entry.type === "message" && entry.message.role === "system" ? [entry.message] : []
      )))
    : pinnedToolNames;
  const finishStartingSession = trackStartingSession(sessionCwd);
  // New-session draft-row pre-broadcast (2026-09-12): sm:session-created used
  // to publish only after startup completed (the IIFE tail) — the sidebar
  // tree's draft row waited for the whole startup (extensions/agent process/
  // history loading; seconds to tens of seconds). sessionManagerId is
  // available synchronously once pre-generated by SessionManager.create
  // (= inner.sessionId after startup; see the Pre-generate comment above), so
  // broadcasting at the very start → the frontend records the pendingDraft
  // draft row immediately (the new session appears in the sidebar tree at
  // once), then promotes once the jsonl lands and the list refreshes. The
  // original IIFE-tail broadcast stays as a fallback for the SSE-not-yet-
  // connected window (the frontend's onSessionCreatedFrame is idempotent;
  // duplicate frames are harmless).
  if (isNewSession) {
    notifySessionCreated(sessionManagerId, sessionCwd, "start");
  }
  const starting = (async () => {
    // Some extensions access the SDK's global theme even outside the terminal UI.
    if (!chatOnly) initTheme();
    const agentDir = getAgentDir();

    // Determine which tools to pass based on requested toolNames.
    // Since v0.68.0, session creation expects string[] tool names instead of Tool[] instances.
    // A subagent's tools come from its snapshot (subagentToolOptions() below).
    let toolsOption: string[] | undefined;
    if (!subagentResources && selectedToolNames !== undefined) {
      // toolNames === [] -> "all off" (an empty allow-list disables every tool).
      // Otherwise DO NOT pass a builtin-only allow-list: passing CODING_TOOL_NAMES
      // set allowedToolNames to coding builtins only, which filtered every
      // extension/package-provided tool (e.g. subagents, web access) out of the
      // tool registry — so they were unavailable in Pi Web sessions even though the
      // `pi` CLI keeps them. Leaving the allow-list unset lets the SDK register all
      // tools (and activate extension tools); we narrow the ACTIVE set below.
      toolsOption = selectedToolNames.length === 0 ? [] : undefined;
    }

    // Build services first so extension-registered providers are available
    // before the SDK restores the saved model from the session file.
    // Gate untrusted project extensions so opening a repository does not run
    // its .pi/extensions code automatically (see lib/project-trust.ts, #236).
    const trustReloadOptions = subagentResources
      ? subagentLoadsResources
        ? projectTrustReloadOptions(sessionCwd, agentDir)
        : undefined
      : chatOnly
        ? undefined
        : projectTrustReloadOptions(sessionCwd, agentDir);
    const settingsManager = SettingsManager.create(sessionCwd, agentDir);
    // Here the allow-list is the point: extensions stay loaded, their tools and what
    // the parent did not have stay out of the registry.
    if (sideChatTools) toolsOption = resolveShellTools(selectedToolNames ?? [], settingsManager.getDefaultTools());
    // Chat-only sessions and subagents that replace Pi's prompt send an exact
    // system prompt. The prompt is resolved at prompt time through this inline
    // extension: it may read the session's context files, which exist only
    // after the session is created, so the getter is filled in below.
    const exactSystemPromptRef: { current?: () => string } = {};
    const exactSystemPromptExtension = createExactSystemPromptExtension(() => exactSystemPromptRef.current?.());
    // codemode, tool-search, and mcp, as the pi CLI loads them, and the host that decides
    // which MCP servers the session connects (ADR 0006).
    const builtins = subagentResources || chatOnly || sideChatTools
      ? undefined
      : await createPiWebBuiltinExtensions({ agentDir });
    const subagentCodemode = subagentResources?.codemode
      ? await createSubagentCodemodeExtension({
          agentDir,
          cwd: sessionCwd,
          projectTrusted: () => settingsManager.isProjectTrusted(),
        })
      : undefined;
    const subagentMcp = subagentResources?.mcp
      ? await createSubagentMcpExtensions({
          agentDir,
          cwd: sessionCwd,
          projectTrusted: () => settingsManager.isProjectTrusted(),
          codemode: subagentResources.codemode === true,
        })
      : undefined;
    const skillsBinding = subagentResources ? createSubagentSkillsBinding({
      loadSkills: subagentResources.loadSkills,
      skills: subagentResources.skills,
      exactSystemPrompt: subagentResources.exactSystemPrompt
        ?? (chatOnly ? subagentResources.appendSystemPrompt[0] ?? "" : undefined),
    }) : undefined;
    const subagentExtensionFactories = [
      ...(subagentCodemode ? [subagentCodemode] : []),
      ...(subagentMcp && subagentResources
        ? [...subagentMcp.extensions, createSubagentMcpPolicyExtension(() => subagentResources)]
        : []),
      ...(skillsBinding?.loaderOptions.extensionFactories ?? []),
    ];
    const services = await createAgentSessionServices({
      cwd: sessionCwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: subagentResources
        ? {
            ...subagentExtensionLoaderOptions(subagentResources),
            ...skillsBinding!.loaderOptions,
            ...(subagentExtensionFactories.length > 0 ? { extensionFactories: subagentExtensionFactories } : {}),
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            ...(chatOnly
              ? {
                  systemPrompt: " ",
                  systemPromptOverride: () => undefined,
                }
              : {}),
            appendSystemPrompt: subagentResources.appendSystemPrompt,
          }
        : chatOnly
          ? { ...CHAT_ONLY_RESOURCE_LOADER_OPTIONS, extensionFactories: [exactSystemPromptExtension] }
        : {
            additionalExtensionPaths: bundledPiPluginPaths(),
            extensionFactories: [
              ...(builtins?.extensions ?? []),
              createReadOnlyMcpPolicyExtension(),
              createProjectCommandBashExtension({
                cwd: sessionCwd,
                settings: settingsManager,
              }),
              createSubagentExtension(
                SUBAGENT_CONTROLLER.extensionRuntime,
                () => listSubagentProfiles(sessionCwd),
                isBuiltInSubagentsEnabled,
              ),
            ],
            // [fork] Conflict-plugin mechanism: packages declared in pi-web
            // extension manifests' conflicts (e.g. the original pi-subagents)
            // are disabled entirely when assembling the SDK load result
            // (duplicate tool registration conflicts).
            extensionsOverride: (base) => preferUserBashExtension(preferPiWebSubagentExtension(disableConflictingExtensions(base, globalThis.__piWebExt))),
            // ^ registry 可缺席（测试/未 bootstrap）：conflicts 探测对 undefined 优雅降级为不裁剪
          },
      ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
    });
    if (subagentResources?.codemode
      && !services.resourceLoader.getExtensions().extensions.some((extension) => extension.tools.has("codemode"))) {
      throw new Error("Code mode is unavailable: builtin:codemode was not registered");
    }
    // Plan M: collect extension-injected agent tools (in-process direct, zero config).
    // Use the manager's real id (see above): for new sessions the caller's
    // key is a temp `__new__…` value the extensions would otherwise snapshot
    // into tool-closure identities (agentKey) that never match the id later
    // used by dispatchAgentSession/onAgentSettled.
    const extAgentTools: ToolDefinition[] = (() => {
      try { return getExtRegistry().collectAgentToolsWith({ sessionId: sessionManagerId, cwd: sessionCwd }, options.enableExtTools); } catch (e) { console.error("[pi-web] collectAgentTools failed:", e instanceof Error ? e.message : e); return []; }
    })();
    const enabledModels = services.settingsManager.getEnabledModels();
    const scope = await resolveVisibleModels(services.modelRuntime, enabledModels);
    // A provider an extension registers only at session_start (lib/deferred-provider-models.ts)
    // has no model in this runtime yet: build on the default, switch once extensions are bound.
    const deferredInitialModel = initialModel && !services.modelRuntime.getModel(initialModel.provider, initialModel.modelId)
      ? findDeferredModel(services.modelRuntime, initialModel.provider, initialModel.modelId)
      : undefined;
    // Chat only loads no extensions, so that switch never comes: refuse the model the browser chose.
    if (chatOnly && deferredInitialModel && !allowInitialModelFallback) {
      throw chatOnlyExtensionModelError(deferredInitialModel.provider, deferredInitialModel.id);
    }
    // A model outside `enabledModels` is a valid explicit choice, as pi's --model with --models.
    const availableModels = await services.modelRuntime.getAvailable();
    const effectiveInitialModel = initialModel && !deferredInitialModel && (
      !allowInitialModelFallback
      || availableModels.some((model) => model.provider === initialModel.provider && model.id === initialModel.modelId)
    )
      ? initialModel
      : undefined;
    const defaultProvider = services.settingsManager.getDefaultProvider();
    const defaultModelId = services.settingsManager.getDefaultModel();
    const defaultModel = defaultProvider && defaultModelId
      ? { provider: defaultProvider, modelId: defaultModelId }
      : undefined;
    const branch = sessionManager.getBranch();
    // System messages carry the prompt and tool loadout, not a conversation.
    const hasExistingMessages = branch.some((entry) => entry.type === "message" && entry.message.role !== "system");
    const savedModel = hasExistingMessages
      ? getLatestModelChange(branch as unknown as SessionEntry[])
      : null;
    const restoredModel = savedModel
      ? services.modelRuntime.getModel(savedModel.provider, savedModel.modelId)
      : undefined;
    const initial = hasExistingMessages ? null : selectInitialModelScope(scope, {
        ...(effectiveInitialModel ? { requestedModel: effectiveInitialModel } : {}),
        ...(defaultModel ? { defaultModel } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        availableModels,
      });
    const startupModel = restoredModel && services.modelRuntime.hasConfiguredAuth(restoredModel.provider)
      ? restoredModel
      : initial?.model;
    // A registered default the session starts on is in scope with deferred models counted too
    // (globs and exact entries only gain matches), unless the scope fell back to every model.
    const startsOnDefault = Boolean(initial?.model && defaultModel
      && initial.model.provider === defaultModel.provider && initial.model.id === defaultModel.modelId
      && (scope.scopedModels.length > 0 || !enabledModels?.some((pattern) => pattern.trim())));
    // pi's pick with deferred providers counted in, as /api/models shows it (#1240): a deferred
    // model asked for gets its enabledModels pin; with no usable model asked for, the browser shows
    // that pick and sends none, so a deferred pick is switched to as well.
    const deferredStartup = !hasExistingMessages && !chatOnly && (deferredInitialModel || (!effectiveInitialModel && !startsOnDefault))
      ? await findDeferredStartupModel(services.modelRuntime, enabledModels, deferredInitialModel
        ? { requestedModel: { provider: deferredInitialModel.provider, modelId: deferredInitialModel.id } }
        : defaultModel ? { defaultModel } : {})
      : undefined;
    const deferredModel = hasExistingMessages
      ? savedModel && !restoredModel
        ? findDeferredModel(services.modelRuntime, savedModel.provider, savedModel.modelId)
        : undefined
      : deferredInitialModel ?? deferredStartup?.model;
    // set_model applies the model's modelThinkingLevels entry, else defaultThinkingLevel, else keeps
    // the current level: the stand-in model's (clamped, or its own pin). Apply what pi's
    // createAgentSession gives this model at startup instead: a resumed session's last saved level,
    // else the default; a new one's requested level, else the model's enabledModels pin, its
    // modelThinkingLevels entry, else the default.
    const deferredThinkingLevel = !deferredModel
      ? undefined
      : hasExistingMessages
        ? (branch.findLast((entry) => entry.type === "thinking_level_change")?.thinkingLevel as ThinkingLevel | undefined)
          ?? services.settingsManager.getDefaultThinkingLevel()
          ?? SDK_DEFAULT_THINKING_LEVEL
        : thinkingLevel
          ?? deferredStartup?.thinkingLevelPin
          ?? services.settingsManager.getModelThinkingLevel(deferredModel.provider, deferredModel.id)
          ?? services.settingsManager.getDefaultThinkingLevel()
          ?? SDK_DEFAULT_THINKING_LEVEL;
    // The extension's model a Chat-only session wanted (saved, chosen or default); a prompt names
    // it when the session ended up with no model at all.
    const chatOnlyExtensionModel = chatOnly
      ? deferredModel ?? (!hasExistingMessages && defaultProvider && defaultModelId
        ? findDeferredModel(services.modelRuntime, defaultProvider, defaultModelId)
        : undefined)
      : undefined;
    const { session: inner, modelFallbackMessage } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(startupModel ? { model: startupModel } : {}),
      ...(initial?.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),
      ...(scope.scopedModels.length > 0 ? { scopedModels: [...scope.scopedModels] } : {}),
      ...(subagentResources
        ? subagentToolOptions(subagentResources)
        : toolsOption !== undefined ? { tools: toolsOption } : {}),
      ...(options.subagent?.excludeTools?.length ? { excludeTools: options.subagent.excludeTools } : {}),
      // Plan M: extension-injected agent tools (in-process direct, zero config)
      ...(extAgentTools.length > 0 ? { customTools: extAgentTools } : {}),
    });

    // A pinned selection replaces only the coding tools of the SDK's initial loadout, which
    // already holds the extension tools pi activates on registration and whatever
    // `defaultTools` names (such as `+codemode`), so installed extensions stay usable in
    // Pi Web just like in the `pi` CLI.
    if (!subagentResources && !chatOnly) {
      const initialToolNames = inner.getActiveToolNames();
      inner.setActiveToolsByName(
        resolveActiveToolNames(inner, selectedToolNames ?? initialToolNames, initialToolNames),
      );
    }

    skillsBinding?.setActiveToolsGetter(() => inner.getActiveToolNames());
    const exactSystemPrompt = subagentResources
      ? skillsBinding!.getExactSystemPrompt
      : chatOnly
        ? () => contextFilesSystemPrompt(inner.resourceLoader.getAgentsFiles().agentsFiles)
        : undefined;
    exactSystemPromptRef.current = exactSystemPrompt;
    const mcpHost = builtins?.mcpHost ?? subagentMcp?.mcpHost;
    const startupIssues = collectStartupIssues({
      diagnostics: services.diagnostics,
      extensions: services.resourceLoader.getExtensions(),
    });
    for (const issue of startupIssues) console.warn(`[pi-web] session ${inner.sessionId}: ${issue.message}`);
    // pi's "Could not restore model X. Using Y" holds unless the deferred switch below reaches X.
    // Without any model (pi's placeholder) its text sends to /login, a TUI command, and the model
    // picker already says "No models".
    const builtOnModel = inner.model && services.modelRuntime.getModel(inner.model.provider, inner.model.id);
    const restoreFallback = builtOnModel ? modelFallbackMessage : undefined;
    let restoredDeferredModel = false;
    const wrapper = new AgentSessionWrapper(inner, {
      exactSystemPrompt,
      chatOnly,
      onAgentRunComplete: (completedSessionId, _sessionName, outcome) => {
        void notifySessionComplete(completedSessionId, outcome).catch((error) => {
          console.error("[pi-web] failed to send completion push:", error instanceof Error ? error.message : error);
        });
      },
      suppressCompletionNotifications: Boolean(subagentResources) || isSideChat,
      ...(subagentResources
        ? { onDirectTurnSettled: (aborted: boolean) => SUBAGENT_CONTROLLER.settleDirectTurn(inner.sessionId, aborted) }
        : {}),
      ...(mcpHost ? { mcpHost } : {}),
      ...(chatOnlyExtensionModel ? { chatOnlyExtensionModel } : {}),
      sideChat: isSideChat,
      // A subagent's or side chat's tab would say again what its parent's page said.
      ...(subagentResources || isSideChat ? {} : { startupIssues: limitStartupNotices(startupIssues) }),
    });
    // Subagent: inject the agent definition's systemPrompt (reorganized
    // context).
    // Must come after setActiveToolsByName — setActiveToolsByName rebuilds
    // systemPrompt (_systemPromptOverride ?? _baseSystemPrompt), so an
    // earlier injection would be overwritten.
    // Same mechanism as setForceEmptySystemPrompt (writes agent.state
    // directly).
    if (options.subagent?.systemPrompt && inner.agent?.state) {
      // SDK 1.1.0: read-only getter — rewrite the leading system message instead.
      const subLead = inner.agent.state.messages[0] as { role: string; content: unknown } | undefined;
      if (subLead && subLead.role === "system") subLead.content = options.subagent.systemPrompt;
    }
    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);
    // 代际守卫：本 wrapper 已被替换时不得注销继任者（registerRpcWrapper 的
    // onDestroy 守卫因单槽语义会被下面的分发注册覆盖——分发移到独立槽，守卫
    // 由 registerRpcWrapper 自己持有，不再在此重复）。
    wrapper.onAgentSessionEndDispatch((reason) => {
      // Plan M: notify extensions of session destruction. destroy ≠ the
      // session truly ending — a fork swapping wrappers and idle-GC recycling
      // both pass through here; pass the reason through as-is so extensions
      // can tell "session gone" from "wrapper recycled (the file remains and
      // will be rebuilt on next access)".
      try { getExtRegistry().dispatchAgentSessionEnd(realSessionId, reason); } catch { /* 已在外层兜底 */ }
    });
    // 注册注销守卫（同 registerRpcWrapper）：wrapper 被替换后不得注销继任者。
    wrapper.onDestroy(() => {
      if (registry.get(realSessionId) === wrapper) registry.delete(realSessionId);
    });
    const previousWrapper = registry.get(realSessionId);
    if (previousWrapper && previousWrapper !== wrapper && typeof previousWrapper.onDestroy === "function") {
      previousWrapper.onDestroy(() => {});
    }
    recordSessionStart(realSessionId);
    registry.set(realSessionId, wrapper);
    // When all tools are disabled, clear the system prompt entirely.
    // pi's buildSystemPrompt always produces a non-empty prompt even with no tools;
    // keep this forced after extension resource discovery and reloads as well.
    if (toolNames?.length === 0) {
      wrapper.setForceEmptySystemPrompt(true);
    }
    wrapper.loadQueueRecovery();
    wrapper.start();
    wrapper.beginExtensionBinding({ forceEmptySystemPrompt: toolNames?.length === 0 });
    // Registered after start(): the debug panel's starting-lock reads isAlive
    // through it, and a start whose wrapper is up must no longer count as starting.
    recordStartRegisteredId(sessionId, realSessionId);

    if (!chatOnly) {
      if (deferredModel) {
        try {
          await wrapper.waitUntilReady();
          await wrapper.send({ type: "set_model", provider: deferredModel.provider, modelId: deferredModel.id });
          restoredDeferredModel = true;
          if (deferredThinkingLevel) await wrapper.send({ type: "set_thinking_level", level: deferredThinkingLevel });
        } catch (error) {
          console.error(`[pi-web] could not switch to ${deferredModel.provider}/${deferredModel.id}:`, error instanceof Error ? error.message : error);
        }
      }
      // Bound extensions may have registered providers a later model listing will not see.
      void wrapper.waitUntilReady()
        .then(() => rememberProviderModels(inner.modelRuntime as ModelRuntime))
        .catch(() => undefined);
    }
    if (restoreFallback && !restoredDeferredModel) {
      console.warn(`[pi-web] session ${realSessionId}: ${restoreFallback}`);
      wrapper.addStartupIssue({ type: "warning", message: restoreFallback });
    }

    // Plan M: notify extensions of session startup (the devtools extension
    // registers agent identity + binds the push sink).
    // Session-info construction is centralized in
    // AgentSessionWrapper.toAgentSessionInfo (shared by re-attachment after a
    // registry reload); once marked, registry.reload includes this session in
    // the re-attach set.
    try {
      wrapper.markAgentSessionHooksDispatched();
      getExtRegistry().dispatchAgentSession(wrapper.toAgentSessionInfo());
    } catch (e) { console.error("[pi-web] agent session start dispatch failed:", e instanceof Error ? e.message : e); }

    // Brand-new session creation broadcast (generalized page-event frame, SSE
    // straight to all tabs): cross-tab sidebar lists (session-manager
    // dock/panel) rely on it to immediately show sessions created by other
    // tabs or server-side (AI-helper invokes / emergency AI / scheduled tasks
    // / the ACP bridge), no longer relying only on the running frame's
    // indirect nudge (within the jsonl-not-yet-on-disk + 5s scan-cache window
    // both frames come up empty → the new session would stay invisible for a
    // long time). The client session-manager records a pendingDraft draft row
    // on receiving the frame; its existing bounded follow-up fetch chain
    // promotes it to a real row once on disk.
    if (isNewSession) {
      // Startup-completion tail fallback broadcast (same helper as the early broadcast; the client's
      // onSessionCreatedFrame is idempotent): covers the window where SSE wasn't connected yet when
      // the early broadcast fired.
      notifySessionCreated(realSessionId, sessionCwd, "start");
    }
    return { session: wrapper, realSessionId };
  })().finally(() => {
    locks.delete(sessionId);
    forgetStartRegisteredId(sessionId);
    finishStartingSession();
    // Startup-outcome finalizing broadcast: on success the wrapper is
    // registered (isRunning takes over; snapshot dedup prevents a duplicate
    // broadcast); on failure the starting-set removal → the broadcast drops
    // the id from the running set and the sidebar spinner exits
    // ("fail-then-exit" semantics).
    if (getStartingSessionIds().delete(sessionId)) notifyRunningChange();
  });

  locks.set(sessionId, starting);
  return starting;
}

// ── Fork-local: running-state SSE primary channel infrastructure (upstream v0.8.11 removed this channel; our sidebar relies on it with slow polling as fallback, hence restored) ──
let lastRunningSnapshot = "";

function getRunningListeners(): Set<(ids: string[]) => void> {
  if (!globalThis.__piRunningListeners) globalThis.__piRunningListeners = new Set();
  return globalThis.__piRunningListeners;
}

/**
 * In-process local session factory (a globalThis seam, same pattern as
 * __piSubagentFactory).
 *
 * Extensions (loaded via jiti, unable to import "@/lib/rpc-manager") create/
 * open real pi sessions in this process via
 * `globalThis.__piLocalSessionFactory.start(...)`:
 * used by cc-connect bridging (the channels extension's ACP server → pi-web
 * sessions) and similar scenarios.
 * start's parameters and return value match startRpcSession — pass a one-shot
 * key (`__acp__<uuid>`) for new sessions, the real session id for reopening
 * (a registry hit reuses the wrapper already open in the UI).
 */
export function installLocalSessionFactory(): void {
  const g = globalThis as Record<string, unknown>;
  if (!g.__piLocalSessionFactory) g.__piLocalSessionFactory = { start: startRpcSession };
}

// Installed at module load (idempotent): loading this module in any realm
// sets globalThis.
// Do not rely on instrumentation.ts alone — under Next turbopack,
// instrumentation may run in a separate realm whose globalThis ≠ the main
// app realm; routes/extensions all load this module in the main realm, so
// setting it here guarantees the main realm has the seam too (extensions
// such as the channels ACP bridge create sessions through it).
installLocalSessionFactory();

/** Subscribe to running-session-id changes. Returns an unsubscribe function. */
export function subscribeRunningSessions(listener: (ids: string[]) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Waits for (and never starts) a session's rpc wrapper: lazy SSE (opening a
 * session page does not cold-start the runtime, 2026-09-15) suspends while
 * the wrapper does not exist; a real interaction (send/steer etc.) triggers
 * startRpcSession and the running broadcast then wakes and attaches it.
 * Event-driven (subscribeRunningSessions + notifyRunningChange), no polling.
 *
 * Returns an unsubscribe function that stops waiting; calls onReady exactly
 * once, synchronously, when the wrapper appears.
 */
export function waitForRpcSession(
  sessionId: string,
  onReady: (wrapper: AgentSessionWrapper) => void,
): () => void {
  let stopped = false;
  let unsubscribe: (() => void) | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe?.();
    unsubscribe = null;
  };
  const check = () => {
    if (stopped) return;
    const wrapper = getRpcSession(sessionId);
    if (!wrapper?.isAlive()) return;
    stop();
    onReady(wrapper);
  };
  unsubscribe = subscribeRunningSessions(() => check());
  // Closes the "first check → subscribe" window: the wrapper may already exist, or may have registered between the two steps.
  check();
  return stop;
}


/**
 * Recompute the running-session-id set and, if it changed since the last
 * notification, broadcast it to subscribers.
 */
export function notifyRunningChange(): void {
  const listeners = getRunningListeners();
  const ids = getRunningRpcSessionIds();
  if (listeners.size === 0) {
    // A future subscriber receives its own initial snapshot. Clear this one so
    // its first state transition cannot match stale state from an old listener.
    lastRunningSnapshot = "";
  } else {
    // The snapshot must distinguish "starting" from "registered" (2026-09-15):
    // judging by the id set alone, startup completion (starting removal +
    // wrapper registration) yields the same value and would be swallowed by
    // dedup — yet it is exactly the signal waitForRpcSession (lazy SSE
    // attachment) waits for.
    const snapshot = JSON.stringify({
      ids: [...ids].sort(),
      starting: [...getStartingSessionIds()].sort(),
    });
    if (snapshot !== lastRunningSnapshot) {
      lastRunningSnapshot = snapshot;
      for (const listener of listeners) {
        try { listener(ids); } catch { /* ignore listener errors */ }
      }
    }
  }
  // Restart-recovery P0: mirror the running set to disk (running-journal).
  // Reached only when the set truly changed (snapshot dedup); write failures
  // degrade silently. With no listeners the set may be unchanged — repeated
  // full writes are harmless.
  try {
    recordRunningEntries(collectRpcJournalEntries());
  } catch { /* the journal must never block the main path */ }
}

/** Currently running local sessions → journal snapshot (with sessionFile/cwd metadata). */
function collectRpcJournalEntries(): JournalEntry[] {
  const now = Date.now();
  const out: JournalEntry[] = [];
  for (const [key, session] of getRegistry()) {
    if (!session.isRunning()) continue;
    out.push({
      id: session.sessionId || key,
      sessionFile: session.sessionFile,
      cwd: session.cwd,
      kind: "local",
      updatedAt: now,
    });
  }
  return out;
}

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createAgentSessionFromServices, createAgentSessionServices, getAgentDir, initTheme, SessionManager, SettingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { bundledPiPluginPaths } from "./pi-plugins";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { existsSync, realpathSync, writeFileSync } from "fs";
import { resolve } from "path";
import { validateAgentImages } from "./image-attachments";
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
} from "./queue-store";
import { invalidateModelsCache } from "./models-cache";
import { hasLiveDetachedRuns } from "./subagent-detached";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import {
  createProjectCommandBashExtension,
  createProjectCommandBashOperations,
  preferUserBashExtension,
} from "./project-command-env";
import { disableConflictingExtensions } from "./ext-conflicts";
import { dropMcpAdapterForWebSessions } from "./web-mcp-policy";
import { cacheSessionPath, invalidateSessionListCache, resolveSessionPath } from "./session-reader";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { persistExplicitStartupPreferences } from "./startup-preferences";
import { notifySessionComplete } from "./web-push";
import type { SlashCommandInfo, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "./pi-types";
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  ExtensionWidgetItem,
  SessionEntry,
  SessionInfo,
  SessionMessageEntry,
} from "./types";
import { getRegistry as getExtRegistry } from "./ext/registry.ts";
import { listProviders } from "./session/providers.ts";
import { BridgeOccupiedError } from "./session/types.ts";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS, type HeadlessCustomUiTui } from "./custom-ui-terminal";
import {
  createSubagentExtension,
  preferPiWebSubagentExtension,
} from "./subagent-extension";
import {
  listSubagentProfiles,
  readSubagentRun,
  readSubagentSessionResources,
  SUBAGENT_CONTROL_TOOL_NAMES,
} from "./subagents";
import { createSubagentController } from "./subagent-runtime";
import { isBuiltInSubagentsEnabled } from "./subagent-settings";
import { resolveShellTools } from "./powershell-settings";
import { CHAT_ONLY_RESOURCE_LOADER_OPTIONS, contextFilesSystemPrompt } from "./chat-only";
import {
  appendSessionToolSelection,
  readSessionToolSelection,
  validateSessionToolSelection,
} from "./session-tool-selection";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;
type AgentRunCompleteListener = (sessionId: string) => void;

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

type AgentSessionWrapperOptions = {
  exactSystemPrompt?: () => string;
  chatOnly?: boolean;
  onAgentRunComplete?: AgentRunCompleteListener;
  suppressCompletionNotifications?: boolean;
};

const IDLE_RESET_EVENT_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "auto_compaction_end",
  "compaction_end",
]);

const SESSION_REPLACEMENT_COMMAND_TYPES = new Set(["fork", "clone"]);
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
  /** 跳过单写者红线总闸（ownsFile 桥占用检查）。子代理 fork 出的新文件必属本地，用它。 */
  skipBridgeCheck?: boolean;
  /**
   * 子代理模式：创建后注入 agent 定义 systemPrompt、按需收窄工具（excludeTools）。
   * 子代理 session 复用完整会话创建流程（落盘/索引/统计/扩展通知），仅带 parent 标记。
   */
  subagent?: {
    /** 子代理 agent 定义的系统提示词（覆盖默认 systemPrompt） */
    systemPrompt?: string;
    /** 工具黑名单（默认全开 = 继承全部系统/扩展工具） */
    excludeTools?: string[];
  };
}

const CODING_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const THINKING_LEVEL_NAMES = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Extensions require a complete Theme, while the web UI applies its own styling.
class PlainTextTheme extends Theme {
  constructor() {
    super(
      { thinkingXhigh: "", searchMatchText: "" } as ConstructorParameters<typeof Theme>[0],
      { selectedBg: "" } as ConstructorParameters<typeof Theme>[1],
      "truecolor",
    );
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
  override underline(text: string): string { return text; }
  override inverse(text: string): string { return text; }
  override strikethrough(text: string): string { return text; }
  override getFgAnsi(): string { return ""; }
  override getBgAnsi(): string { return ""; }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text;
  }
  override getBashModeBorderColor(): (text: string) => string { return (text) => text; }
}

const PLAIN_TEXT_THEME = new PlainTextTheme();
const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);

function withExtensionTools(session: AgentSessionLike, toolNames: string[]): string[] {
  if (toolNames.length === 0) return [];

  const codingToolNames = new Set(CODING_TOOL_NAMES);
  const selectedToolNames = resolveShellTools(toolNames, session.settingsManager.getDefaultTools());
  const extensionToolNames = session
    .getAllTools()
    .map((t) => t.name)
    .filter((name) => !codingToolNames.has(name));

  return [...new Set([...selectedToolNames, ...extensionToolNames])];
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

/** Why a wrapper is being torn down. "shutdown" = the session is truly over
 *  (DELETE route, global teardown); "fork" = the wrapper is discarded because
 *  the session was forked (the old file survives); "idle" = 10-min idle GC
 *  (the file survives, a fresh wrapper is created on next access). Extension
 *  end-hooks receive this so they can tell "session gone" from "wrapper
 *  recycled". */
export type AgentWrapperEndReason = "shutdown" | "fork" | "idle";

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private activeExtensionWidgets = new Map<string, ActiveExtensionWidget>();
  private extensionWidgetGenerations = new Map<string, number>();
  private extensionWidgetsResetting = false;
  private pendingPromptCount = 0;
  /** True while runAgentContinue is delivering a queued follow-up as a prompt. */
  private promptRunning = false;
  private activeMutatingCommands = 0;
  private sessionReplacement: "fork" | "clone" | null = null;
  private agentRunNeedsCompletion = false;
  private promptAdmissionTail: Promise<void> = Promise.resolve();
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private readonly exactSystemPrompt?: () => string;
  private readonly chatOnly: boolean;
  private readonly onAgentRunComplete?: AgentRunCompleteListener;
  private readonly suppressCompletionNotifications: boolean;
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
  private pendingQueueHints: Record<QueueKind, QueueImage[][]> = { steer: [], followUp: [] };
  // 方案 M：本轮 run 是否产出过带文本的 assistant 消息。agent_settled 无条件发射
  // （finally），而 getLastAssistantText() 会跳过「aborted 且无内容」的消息并
  // 回退到上一轮的最终回答——不设此标记，立即 abort 的轮次会把上一轮回答当
  // 本轮答案推给扩展。
  private runProducedAssistantText = false;
  private onDestroyCallback: ((reason: AgentWrapperEndReason) => void) | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private sessionShutdownEmitted = false;
  private forceShutdownOnIdle = false;
  private _alive = true;

  constructor(
    public readonly inner: AgentSessionLike,
    options: AgentSessionWrapperOptions = {},
  ) {
    this.exactSystemPrompt = options.exactSystemPrompt;
    this.chatOnly = options.chatOnly ?? false;
    this.onAgentRunComplete = options.onAgentRunComplete;
    this.suppressCompletionNotifications = options.suppressCompletionNotifications ?? false;
    this.installExactSystemPromptContinuation();
    this.applyExactSystemPrompt();
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

  isAlive(): boolean {
    return this._alive;
  }

  isRunning(): boolean {
    return this._alive && (this.pendingPromptCount > 0 || this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning);
  }

  /** 方案 M：最后一条 assistant 消息的 stopReason（无 assistant 消息时 undefined）。
 * AgentSessionLike 未声明 messages，这里局部窄化读取（底层 SDK 有该 getter）。 */
  private lastAssistantStopReason(): string | undefined {
    const messages = (this.inner as { messages?: Array<{ role?: string; stopReason?: string }> }).messages;
    if (!messages) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "assistant") return m.stopReason;
    }
    return undefined;
  }

  isChatOnly(): boolean {
    return this.chatOnly;
  }

  hasSuppressedCompletionNotifications(): boolean {
    return this.suppressCompletionNotifications;
  }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      if (event.type === "agent_start") this.agentRunNeedsCompletion = true;
      if (event.type === "agent_end") {
        invalidateSessionListCache();
      }
      if (event.type === "queue_update") {
        this.reconcileQueue(
          (event as { steering?: string[] }).steering,
          (event as { followUp?: string[] }).followUp,
        );
      }
      // 方案 M：记录本轮 run 是否产出过带文本的 assistant 消息（见字段注释）。
      // Event-driven（非 prompt-command-driven）——扩展注入的 run 也走同一订阅。
      if (event.type === "message_end") {
        const m = (event as { message?: { role?: string; content?: Array<{ type?: string; text?: string }> } }).message;
        if (m?.role === "assistant" && (m.content ?? []).some((c) => c.type === "text" && (c.text ?? "").trim().length > 0)) {
          this.runProducedAssistantText = true;
        }
      }
      // 方案 M：agent 一轮执行完 → 把最终回答分发给扩展（如 aiti-devtools 回桥显 AI 窗）。
      // 只有本轮真的产出过 assistant 文本才分发；零产出的轮次（立即 abort、无输出
      // 即错）不把上一轮的回答当本轮答案推出去。
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
        const failed = this.lastAssistantStopReason() === "error";
        const text = produced && !failed ? this.inner.getLastAssistantText() ?? "" : "";
        if (text) {
          try { getExtRegistry().dispatchAgentSettled(this.sessionId, text); } catch (e) { console.error("[pi-web] agent_settled 分发失败:", e instanceof Error ? e.message : e); }
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
      this.emit(event);
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
    this.pendingQueueHints = { steer: [], followUp: [] };
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
    if (this.forceEmptySystemPrompt && this.inner.agent.state) {
      this.inner.agent.state.systemPrompt = "";
    }
  }

  private notifyAgentRunCompleteIfIdle(): void {
    if (!this.agentRunNeedsCompletion || this.isRunning()) return;
    this.agentRunNeedsCompletion = false;
    if (this.suppressCompletionNotifications) return;
    try {
      this.onAgentRunComplete?.(this.sessionId);
    } catch (error) {
      console.error("[pi-web] completion listener failed:", error instanceof Error ? error.message : error);
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

  private ensureExtensionsBound(): Promise<void> {
    if (this.extensionsBound) {
      this.applyExactSystemPrompt();
      return Promise.resolve();
    }
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
      this.applyExactSystemPrompt();
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

  private applyExactSystemPrompt(): void {
    if (!this.exactSystemPrompt || !this.inner.agent.state) return;
    this.inner.agent.state.systemPrompt = this.exactSystemPrompt();
  }

  private installExactSystemPromptContinuation(): void {
    if (!this.exactSystemPrompt) return;
    const previous = this.inner.agent.prepareNextTurnWithContext;
    this.inner.agent.prepareNextTurnWithContext = async (turn, signal) => {
      const prepared = await previous?.(turn, signal);
      return {
        ...prepared,
        context: {
          ...(prepared?.context ?? turn.context),
          systemPrompt: this.exactSystemPrompt!(),
        },
      };
    };
  }

  setActiveToolSelection(toolNames: string[]): void {
    this.inner.setActiveToolsByName(withExtensionTools(this.inner, toolNames));
    this.applyExactSystemPrompt();
  }

  private emit(event: AgentEvent): void {
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

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this._alive) return;
    if (!this.isRunning()) this.forceShutdownOnIdle = false;
    this.idleTimer = setTimeout(() => {
      if (this.isRunning() && !this.forceShutdownOnIdle) {
        this.resetIdleTimer();
        return;
      }
      // 上游 pi-subagents detached run 判活：父会话 idle 但后台子代理仍在跑时
      // 不得回收——completion watcher / wait 订阅随 wrapper 销毁，子代理会
      // "永不回话"（上游 extension-api.md 宿主警告）。判活异常时保守续命。
      let hasDetached = true;
      try {
        hasDetached = hasLiveDetachedRuns(
          this.inner.sessionManager.getSessionFile?.() ?? "",
          this.inner.sessionManager.getSessionId?.() ?? "",
        );
      } catch { /* 保守续命 */ }
      if (hasDetached) {
        this.resetIdleTimer();
        return;
      }
      void this.shutdown("idle").catch((error) => {
        console.error("[pi-web] failed to shut down idle session:", error instanceof Error ? error.message : error);
      });
    }, 10 * 60 * 1000);
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

    // Pi normally delays the first flush until an assistant message exists.
    // A leading shell command has no assistant message, so mark this SDK
    // manager as flushed after writing its own generated entries.
    (manager as unknown as { flushed: boolean }).flushed = true;
    cacheSessionPath(this.inner.sessionId, sessionFile);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    for (const event of this.pendingUiRequests.values()) listener(event);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: (reason: AgentWrapperEndReason) => void): void {
    this.onDestroyCallback = cb;
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
    return this.inner.isBashRunning
      || this.inner.isStreaming
      || this.inner.isCompacting
      || this.pendingPromptCount > 0;
  }

  private async shutdownAfterSessionReplacement(replacement: "fork" | "clone"): Promise<void> {
    try {
      await this.shutdown();
    } catch (error) {
      console.error(
        `[pi-web] ${replacement} succeeded, but source session shutdown failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    const type = command.type as string;
    const allowedDuringReplacement = COMMANDS_ALLOWED_DURING_SESSION_REPLACEMENT.has(type);
    if (this.sessionReplacement && !allowedDuringReplacement) {
      throw new Error("Session is being copied to a new session");
    }
    if (SESSION_REPLACEMENT_COMMAND_TYPES.has(type) && this.activeMutatingCommands > 0) {
      throw new Error(`Cannot ${type} while another session command is running`);
    }

    const tracksMutation = !allowedDuringReplacement;
    if (tracksMutation) this.activeMutatingCommands += 1;

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

      switch (type) {
      case "prompt": {
        // Serialize only admission. Once the preceding prompt has either
        // passed or failed preflight, the SDK can atomically decide whether
        // this submission starts a run or joins its streaming queue.
        const releaseAdmission = await this.acquirePromptAdmission();
        try {
          if (this.inner.isBashRunning) {
            throw new Error("Cannot send a prompt while a shell command is running");
          }
          const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
          const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
          const text = command.message as string;

          // pi rejects plain prompts while compaction runs. Queue the message as
          // a follow-up so it is delivered once compaction finishes (the
          // compaction_end listener kicks off delivery via runAgentContinue).
          // Extension commands still go through inner.prompt() so they execute
          // immediately, matching pi's own behavior during compaction.
          const queueAsFollowUp = this.inner.isCompacting && !this.isRegisteredExtensionCommand(text);
          if (queueAsFollowUp) {
            // Record image attachments so they survive queue mirroring.
            this.hintQueueImages("followUp", promptImages);
            this.pendingPromptCount += 1;
            notifyRunningChange();
            void this.inner.followUp(text, promptImages?.length ? promptImages : undefined)
              .catch((error) => {
                invalidateSessionListCache();
                this.emit({
                  type: "prompt_error",
                  errorMessage: error instanceof Error ? error.message : String(error),
                });
              })
              .finally(() => {
                this.pendingPromptCount = Math.max(0, this.pendingPromptCount - 1);
                this.resetIdleTimer();
                notifyRunningChange();
              });
            return null;
          }

          const queuesMessage = Boolean(streamingBehavior) && this.inner.isStreaming;
          if (queuesMessage) {
            // Record image attachments so they survive queue mirroring.
            this.hintQueueImages(streamingBehavior === "followUp" ? "followUp" : "steer", promptImages);
          }

          let preflightAccepted = false;
          let preflightSettled = false;
          let promptSettled = false;
          let acceptPreflight!: () => void;
          let rejectPreflight!: (error: unknown) => void;
          const preflight = new Promise<void>((resolve, reject) => {
            acceptPreflight = () => {
              preflightAccepted = true;
              this.agentRunNeedsCompletion = true;
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
            // 运行状态变了（可能从 running → idle）：广播给 SSE，侧栏运行中标志才消失。
            notifyRunningChange();
          };

          this.pendingPromptCount += 1;
          // 开始执行（isRunning 变 true）：广播 running set，侧栏立即显示运行中标志。
          notifyRunningChange();
          let prompt: Promise<void>;
          try {
            prompt = this.inner.prompt(command.message as string, {
              ...(promptImages?.length ? { images: promptImages } : {}),
              ...(streamingBehavior ? { streamingBehavior } : {}),
              source: "rpc",
              // Match pi's RPC contract: acknowledge only after synchronous prompt
              // validation and extension preflight have accepted the submission.
              preflightResult: (success) => {
                if (success) {
                  this.applyExactSystemPrompt();
                  acceptPreflight();
                }
              },
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
            if (!streamingBehavior) this.emit({ type: "prompt_done" });
          }, (error) => {
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
              if (!streamingBehavior) this.emit({ type: "prompt_done" });
            }
          }).catch((error) => {
            console.error(
              "[pi-web] prompt completion handler failed:",
              error instanceof Error ? error.message : error,
            );
          });

          await preflight;
          return null;
        } finally {
          releaseAdmission();
        }
      }

      case "abort":
        this.forceShutdownOnIdle = true;
        try {
          await this.withFinalIdleReset(() => this.inner.abort());
          return null;
        } finally {
          if (!this.isRunning()) this.forceShutdownOnIdle = false;
        }

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.pendingPromptCount > 0,
          isBashRunning: this.inner.isBashRunning,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: this.inner.pendingMessageCount,
          queuedMessages: {
            steering: this.queueMirror.filter((e) => e.kind === "steer").map((e) => e.text),
            followUp: this.queueMirror.filter((e) => e.kind === "followUp").map((e) => e.text),
          },
          pendingRecovery: this.getPendingRecoveryView(),
          queueTrash: this.getQueueTrashView(),
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        let model = this.inner.modelRuntime.getModel(provider, modelId);
        if (!model) {
          await this.inner.modelRuntime.refresh({ allowNetwork: false });
          model = this.inner.modelRuntime.getModel(provider, modelId);
        }
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        invalidateModelsCache();
        invalidateSessionListCache();
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        if (this.isSessionRunningForReplacement()) {
          throw new Error("Cannot fork while the session is running");
        }
        return this.withSessionReplacement("fork", async () => {
          const entryId = command.entryId as string;
          const sessionManager = this.inner.sessionManager;
          const currentSessionFile = this.inner.sessionFile;

          if (!sessionManager.isPersisted()) return { cancelled: true };
          if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

          const entry = sessionManager.getEntry(entryId);
          if (!entry) throw new Error("Invalid entry ID for forking");

          const sessionDir = sessionManager.getSessionDir();
          let newSessionFile: string;

          if (!entry.parentId) {
            // Fork before the first message: create an empty session linked to this one
            const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
            newManager.newSession({ parentSession: currentSessionFile });
            newSessionFile = newManager.getSessionFile() as string;
          } else {
            // Fork after some history: copy path up to (but not including) the fork point
            const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
            const forkedPath = sourceManager.createBranchedSession(entry.parentId);
            if (!forkedPath) throw new Error("Failed to create forked session");
            newSessionFile = forkedPath;
          }

          // 分支文件在「无 assistant 消息」时不会被写盘（_persist 的 no-assistant guard）：
          // 不写则新会话无法被 resolveSessionPath 找到 → 发送时报 “Session not found”。
          // 这里强制写出 header-only 文件；并对齐 flushed 标志，后续消息走安全追加。
          const forkedManager = SessionManager.open(newSessionFile, sessionDir);
          const forkedEntries = forkedManager.getEntries() as { type?: string; message?: { role?: string } }[];
          if (!forkedEntries.some((e) => e.type === "message" && e.message?.role === "assistant")) {
            (forkedManager as unknown as { _rewriteFile(): void })._rewriteFile();
            (forkedManager as unknown as { flushed: boolean }).flushed = true;
          }

          const newSessionId = forkedManager.getSessionId();
          cacheSessionPath(newSessionId, newSessionFile);
          invalidateSessionListCache();
          await this.shutdownAfterSessionReplacement("fork");
          return { cancelled: false, newSessionId };
        });
      }

      case "clone": {
        if (this.isSessionRunningForReplacement()) {
          throw new Error("Cannot clone while the session is running");
        }
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;
        const leafId = typeof command.leafId === "string" ? command.leafId : sessionManager.getLeafId();
        const branchHasAssistant = leafId && sessionManager.getBranch(leafId).some(
          (entry) => entry.type === "message" && entry.message.role === "assistant",
        );

        if (!sessionManager.isPersisted() || !leafId || !branchHasAssistant) return { cancelled: true };
        if (!currentSessionFile || !existsSync(currentSessionFile)) return { cancelled: true };

        return this.withSessionReplacement("clone", async () => {
          const sessionDir = sessionManager.getSessionDir();
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const clonedPath = sourceManager.createBranchedSession(leafId);
          if (!clonedPath || !existsSync(clonedPath)) throw new Error("Failed to clone current session branch");

          const newSessionId = SessionManager.open(clonedPath, sessionDir).getSessionId();
          cacheSessionPath(newSessionId, clonedPath);
          invalidateSessionListCache();
          await this.shutdownAfterSessionReplacement("clone");
          return { cancelled: false, newSessionId };
        });
      }

      case "navigate_tree": {
        // 允许运行中 navigate：与 fork 一样不中断 agent。
        const result = await this.inner.navigateTree(command.targetId as string, {});
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
        // user purges them.
        if (this.queueMirror.length > 0) {
          this.queueTrash.push(...this.queueMirror);
        }
        this.queueMirror = [];
        this.pendingQueueHints = { steer: [], followUp: [] };
        this.persistQueue();
        return this.inner.clearQueue();
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
        this.pendingQueueHints = { steer: [], followUp: [] };
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
        return { steering: [...this.inner.getSteeringMessages()], followUp: [...this.inner.getFollowUpMessages()] };
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
        this.pendingQueueHints = { steer: [], followUp: [] };
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
        return { steering: [...this.inner.getSteeringMessages()], followUp: [...this.inner.getFollowUpMessages()] };
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
        this.pendingQueueHints = { steer: [], followUp: [] };
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
        this.pendingQueueHints = { steer: [], followUp: [] };
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
        if (index < 0 || index >= entries.length) {
          throw new Error("remove_queue_item index out of range");
        }
        const permanent = command.permanent === true;
        const [removed] = entries.splice(index, 1);
        if (!permanent) this.queueTrash.push(removed);
        const newSteering = kind === "steer" ? entries : steeringEntries;
        const newFollowUp = kind === "followUp" ? entries : followUpEntries;
        this.inner.clearQueue();
        this.pendingQueueHints = { steer: [], followUp: [] };
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
        this.pendingQueueHints = { steer: [], followUp: [] };
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
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          ...t,
          active: active.has(t.name),
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
        const activeToolNames = this.inner.getActiveToolNames();
        await this.waitForExtensionsBound();
        this.extensionStatuses.clear();
        this.resetExtensionWidgetsForReload();
        this.syncProjectTrust();
        await this.inner.reload();
        this.setActiveToolSelection(activeToolNames);
        if (typeof this.inner.bindExtensions !== "function") {
          this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
        }
        this.applyExactSystemPrompt();
        invalidateModelsCache();
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
        if (this.pendingPromptCount > 0 || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        // bash 运行会让 isRunning 变 true：开始前广播，侧栏立即显示运行中标志。
        notifyRunningChange();
        const execution = this.inner.executeBash(
          command.command as string,
          undefined,
          {
            excludeFromContext: command.excludeFromContext as boolean | undefined,
            operations: createProjectCommandBashOperations({
              shellPath: this.inner.settingsManager.getShellPath(),
            }),
          },
        );
        try {
          const result = await execution;
          this.persistBashOnlySession();
          return result;
        } finally {
          this.resetIdleTimer();
          invalidateSessionListCache();
          // bash 结束（isRunning 可能回落）：广播，侧栏运行中标志才消失。
          notifyRunningChange();
        }
      }

      case "abort_bash": {
        this.forceShutdownOnIdle = true;
        this.inner.abortBash();
        return null;
      }

        default:
          throw new Error(`Unsupported command: ${type}`);
      }
    } finally {
      if (tracksMutation) this.activeMutatingCommands = Math.max(0, this.activeMutatingCommands - 1);
    }
  }

  destroy(reason: AgentWrapperEndReason = "shutdown"): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.inner.isBashRunning) this.inner.abortBash();
    this.unsubscribe?.();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();
    this.clearExtensionWidgets(false);

    const finishDispose = () => {
      try {
        this.inner.dispose();
      } finally {
        try {
          this.onDestroyCallback?.(reason);
        } finally {
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

    void (async () => emit.call(
      this.inner.extensionRunner,
      { type: "session_shutdown", reason: "quit" },
    ))()
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
        if (!this.sessionShutdownEmitted) {
          this.sessionShutdownEmitted = true;
          await this.inner.extensionRunner.emit?.({ type: "session_shutdown", reason: "quit" });
        }
      } finally {
        this.destroy(reason);
      }
    })();
    return this.shutdownPromise;
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
      component = factory(tui, PLAIN_TEXT_THEME);
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

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve) => {
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
        resolve(value);
      };
      const done = (value: T) => {
        if (this.activeCustomUis.has(id)) {
          this.closeCustomUi(id, value);
        } else {
          finish(value);
        }
      };

      Promise.resolve()
        .then(() => factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done))
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

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(id);
        this.pendingUiResponses.delete(id);
      };
      const settle = (value: T) => {
        cleanup();
        resolve(value);
      };
      const onAbort = () => settle(defaultValue);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      signal?.addEventListener("abort", onAbort, { once: true });

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
        this.extensionWidgets.set(key, {
          key,
          lines: content,
          placement: options?.placement ?? "aboveEditor",
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
      pasteToEditor: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
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
      get theme() { return PLAIN_TEXT_THEME; },
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
        const result = await this.inner.navigateTree(targetId, { summarize: options?.summarize });
        return { cancelled: result.cancelled };
      },
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        this.extensionStatuses.clear();
        this.resetExtensionWidgetsForReload();
        this.syncProjectTrust();
        await this.inner.reload({
          beforeSessionStart: () => {
            this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
          },
        });
        this.applyExactSystemPrompt();
      },
    };
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
  var __piStartingSessionCwds: Map<string, number> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const destroy = () => globalThis.__piSessions?.forEach((session) => session.destroy());
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

function registerRpcWrapper(wrapper: AgentSessionWrapper): void {
  const registry = getRegistry();
  const sessionId = wrapper.sessionId;
  if (wrapper.sessionFile) cacheSessionPath(sessionId, wrapper.sessionFile);
  wrapper.onDestroy(() => registry.delete(sessionId));
  registry.set(sessionId, wrapper);
  wrapper.start();
  if (!wrapper.isChatOnly()) wrapper.beginExtensionBinding();
}

const SUBAGENT_CONTROLLER = createSubagentController({
  getSession: (sessionId) => getRegistry().get(sessionId),
  registerSession: (inner, options) => {
    const wrapper = new AgentSessionWrapper(inner, {
      ...(options?.exactSystemPrompt !== undefined
        ? { exactSystemPrompt: () => options.exactSystemPrompt! }
        : {}),
      chatOnly: options?.chatOnly,
      suppressCompletionNotifications: true,
    });
    registerRpcWrapper(wrapper);
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

export interface SetRpcSessionToolsResult {
  session: AgentSessionWrapper;
  sessionId: string;
  recreated: boolean;
}

/** Persist a normal session's tool selection and rebuild when resource policy changes. */
export async function setRpcSessionTools(
  sessionId: string,
  sessionFile: string | undefined,
  requestedToolNames: unknown,
): Promise<SetRpcSessionToolsResult> {
  const toolNames = validateSessionToolSelection(requestedToolNames);
  const existing = getRpcSession(sessionId);

  if (!existing?.isAlive()) {
    if (!sessionFile) throw new Error("Session not found");
    const manager = SessionManager.open(sessionFile, undefined);
    if (readSubagentSessionResources(manager.getEntries() as unknown as SessionEntry[])) {
      throw new Error("Subagent tool selection is fixed by its profile");
    }
    appendSessionToolSelection(manager, toolNames);
    invalidateSessionListCache();
    const started = await startRpcSession(sessionId, sessionFile, undefined);
    return { session: started.session, sessionId: started.realSessionId, recreated: false };
  }

  if (existing.isRunning()) throw new Error("Cannot change tools while the session is running");
  if (readSubagentSessionResources(existing.inner.sessionManager.getEntries() as unknown as SessionEntry[])) {
    throw new Error("Subagent tool selection is fixed by its profile");
  }

  const hasCurrentResourcePolicy = typeof existing.isChatOnly === "function"
    && typeof existing.setActiveToolSelection === "function";
  const crossesChatOnlyBoundary = !hasCurrentResourcePolicy
    || existing.isChatOnly() !== (toolNames.length === 0);
  appendSessionToolSelection(existing.inner.sessionManager, toolNames);
  invalidateSessionListCache();

  if (!crossesChatOnlyBoundary) {
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
    toolNames,
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
 * Return live sessions that should be visible in the session list. Pi delays
 * the first JSONL flush until an assistant message exists, so an accepted new
 * prompt must temporarily be described from its in-memory SessionManager.
 */
export function getRpcSessionInfos(): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (const session of getRegistry().values()) {
    if (!session.isAlive()) continue;

    const manager = session.inner.sessionManager;
    const header = manager.getHeader();
    const entries = manager.getEntries() as unknown as Array<
      { type: string; timestamp: string } | SessionMessageEntry
    >;
    const messages = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
    const firstUserMessage = messages.find((entry) => entry.message.role === "user");
    const sessionFile = manager.getSessionFile() ?? session.sessionFile;
    const persisted = Boolean(sessionFile && existsSync(sessionFile));
    const subagent = readSubagentRun(entries as unknown as SessionEntry[], header?.id ?? session.sessionId, sessionFile ?? "");

    // An ensure_session call creates an idle, empty runtime while the composer
    // loads commands. Do not leak it into history before a prompt is accepted.
    if (!persisted && (!session.isRunning() || !firstUserMessage)) continue;

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
      firstMessage: firstUserMessage ? runtimeMessageText(firstUserMessage) || "(no messages)" : "(no messages)",
      ...(subagent ? {
        parentSessionId: subagent.parentSessionId,
        relation: {
          kind: "subagent" as const,
          parentSessionId: subagent.parentSessionId,
          profile: subagent.profile,
          description: subagent.description,
          status: session.isRunning() ? "running" as const : subagent.status,
        },
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
    (session) => normalizeRpcCwd(session.cwd) === targetCwd && session.isRunning(),
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
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
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

  // ── 单写者红线总闸：被 TUI 桥认领的会话文件，绝不本地起 runtime ──
  // 所有经此创建会话的调用方（含 queue-recovery/context/auto-name 等）
  // 都被这一道闸保护；需要桥行为的路由应在调用前先 attachIfBridged。
  // 子代理 fork 出的文件是全新本地文件（parent 标记只是 header 引用），
  // 不属于任何桥会话——由调用方传 skipBridgeCheck 显式跳过。
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
  const subagentResources = sessionFile
    ? readSubagentSessionResources(
        sessionManager.getEntries() as unknown as SessionEntry[],
      )
    : null;
  const persistedToolNames = subagentResources
    ? undefined
    : readSessionToolSelection(sessionManager.getEntries() as unknown as SessionEntry[]);
  const selectedToolNames = subagentResources?.tools ?? persistedToolNames ?? requestedToolNames;
  if (!subagentResources && persistedToolNames === undefined && requestedToolNames !== undefined) {
    appendSessionToolSelection(sessionManager, requestedToolNames);
  }
  const subagentLoadsResources = Boolean(
    subagentResources?.loadExtensions || subagentResources?.loadSkills,
  );
  const chatOnly = selectedToolNames?.length === 0 && !subagentLoadsResources;
  const finishStartingSession = trackStartingSession(sessionCwd);
  const starting = (async () => {
    // Some extensions access the SDK's global theme even outside the terminal UI.
    if (!chatOnly) initTheme();
    const agentDir = getAgentDir();

    // Determine which tools to pass based on requested toolNames.
    // Since v0.68.0, session creation expects string[] tool names instead of Tool[] instances.
    let toolsOption: string[] | undefined = subagentResources?.tools;
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
    const services = await createAgentSessionServices({
      cwd: sessionCwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: subagentResources
        ? {
            noExtensions: !subagentResources.loadExtensions,
            noSkills: !subagentResources.loadSkills,
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
          ? CHAT_ONLY_RESOURCE_LOADER_OPTIONS
        : {
            additionalExtensionPaths: bundledPiPluginPaths(),
            extensionFactories: [
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
            // [aiti] 冲突插件机制：pi-web 扩展清单 conflicts 声明的包（如原版
            // pi-subagents）在组装 SDK 加载结果时整个禁用（同名工具双注册冲突）。
            // dropMcpAdapterForWebSessions 放最前：Web 会话默认不加载 MCP 适配器
            // （shared-global mcp.json 的 12 个 server 在会话创建路径逐个拉起，
            // 冷启动分钟级 → fork/新会话"卡死"；PI_WEB_LOAD_MCP=1 恢复旧行为）。
            extensionsOverride: (base) => dropMcpAdapterForWebSessions(preferUserBashExtension(preferPiWebSubagentExtension(disableConflictingExtensions(base, getExtRegistry())))),
          },
      ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
    });
    // 方案 M：收集扩展注入的 agent 工具（进程内直连，零配置）。
    // Use the manager's real id (see above): for new sessions the caller's
    // key is a temp `__new__…` value the extensions would otherwise snapshot
    // into tool-closure identities (agentKey) that never match the id later
    // used by dispatchAgentSession/onAgentSettled.
    const extAgentTools: ToolDefinition[] = (() => {
      try { return getExtRegistry().collectAgentTools({ sessionId: sessionManagerId, cwd: sessionCwd }); } catch (e) { console.error("[pi-web] collectAgentTools 失败:", e instanceof Error ? e.message : e); return []; }
    })();
    const scope = await resolveVisibleModels(
      services.modelRuntime,
      services.settingsManager.getEnabledModels(),
    );
    const effectiveInitialModel = initialModel && (
      !allowInitialModelFallback
      || scope.visible.some((model) => model.provider === initialModel.provider && model.id === initialModel.modelId)
    )
      ? initialModel
      : undefined;
    const defaultProvider = services.settingsManager.getDefaultProvider();
    const defaultModelId = services.settingsManager.getDefaultModel();
    const hasExistingMessages = sessionManager.getBranch().some((entry) => entry.type === "message");
    const initial = hasExistingMessages
      ? { scopedModels: [...scope.scopedModels] }
      : selectInitialModelScope(scope, {
        ...(effectiveInitialModel ? { requestedModel: effectiveInitialModel } : {}),
        ...(defaultProvider && defaultModelId
          ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
          : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      });
    const { session: inner } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(initial.model ? { model: initial.model } : {}),
      ...(initial.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),
      ...(initial.scopedModels.length > 0 ? { scopedModels: initial.scopedModels } : {}),
      ...(toolsOption !== undefined ? { tools: toolsOption } : {}),
      ...(options.subagent?.excludeTools?.length ? { excludeTools: options.subagent.excludeTools } : {}),
      // 方案 M：扩展注入的 agent 工具（进程内直连，零配置）
      ...(extAgentTools.length > 0 ? { customTools: extAgentTools } : {}),
      ...(subagentResources ? { excludeTools: [...SUBAGENT_CONTROL_TOOL_NAMES] } : {}),
    });

    const persistedPreferences = await persistExplicitStartupPreferences(
      services.settingsManager,
      {
        ...(effectiveInitialModel ? { model: effectiveInitialModel } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      },
      {
        ...(inner.model
          ? { model: { provider: inner.model.provider, modelId: inner.model.id } }
          : {}),
        thinkingLevel: inner.thinkingLevel,
        supportsThinking: inner.supportsThinking(),
      },
    );
    if (persistedPreferences.modelDefaultChanged) invalidateModelsCache();

    // If specific tool names were requested (non-empty), set the active tools to the
    // requested builtin coding tools PLUS all extension/package tools, so installed
    // extensions stay usable in Pi Web just like in the `pi` CLI.
    if (!subagentResources && !chatOnly) {
      inner.setActiveToolsByName(withExtensionTools(inner, selectedToolNames ?? inner.getActiveToolNames()));
    }

    const exactSystemPrompt = chatOnly
      ? subagentResources
        ? () => subagentResources.appendSystemPrompt[0] ?? ""
        : () => contextFilesSystemPrompt(inner.resourceLoader.getAgentsFiles().agentsFiles)
      : undefined;
    const wrapper = new AgentSessionWrapper(inner, {
      exactSystemPrompt,
      chatOnly,
      onAgentRunComplete: (completedSessionId) => {
        void notifySessionComplete(completedSessionId).catch((error) => {
          console.error("[pi-web] failed to send completion push:", error instanceof Error ? error.message : error);
        });
      },
      suppressCompletionNotifications: Boolean(subagentResources),
    });
    // 子代理：注入 agent 定义 systemPrompt（重新组织上下文）。
    // 必须在 setActiveToolsByName 之后——setActiveToolsByName 会 rebuild systemPrompt
    // （_systemPromptOverride ?? _baseSystemPrompt），先注入会被覆盖。
    // 同 setForceEmptySystemPrompt 机制（直接写 agent.state）。
    if (options.subagent?.systemPrompt && inner.agent?.state) {
      inner.agent.state.systemPrompt = options.subagent.systemPrompt;
    }
    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);
    wrapper.onDestroy((reason) => {
      registry.delete(realSessionId);
      // 方案 M：会话销毁通知扩展。destroy ≠ 会话真正结束——fork 换 wrapper、
      // idle GC 回收都会走到这里，把 reason 原样传给扩展，让它能区分
      // 「会话没了」和「wrapper 被回收（文件还在，下次访问会重建）」。
      try { getExtRegistry().dispatchAgentSessionEnd(realSessionId, reason); } catch (e) { console.error("[pi-web] agent 会话结束分发失败:", e instanceof Error ? e.message : e); }
    });
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

    // 方案 M：会话启动通知扩展（aiti-devtools 注册 agent 身份 + 绑定推送 sink）。
    // steer: enqueuing into pi's steering queue is picked up by the live agent
    // loop at the next turn boundary. But if the run ends between the enqueue
    // and that boundary (the loop's final hasQueuedMessages check already
    // passed), nothing ever drains the queue — so re-check AFTER the steer
    // and, if the agent is no longer running, follow up with continue_queue
    // (the same runAgentContinue path as recovery / compaction delivery) to
    // actually start the run. During compaction continue_queue reports
    // started:false and the compaction_end listener delivers instead.
    // Guard against a destroyed wrapper — the sink is unregistered in
    // onAgentSessionEnd but an in-flight call may still land afterwards.
    try {
      getExtRegistry().dispatchAgentSession({
        sessionId: realSessionId,
        cwd: sessionCwd,
        // 进程内事件直连：含 tool_execution_update 实时 bash 输出（agent events 的
        // SSE 出口会过滤该类型，浏览器看不到；扩展经此拿到全量）。
        subscribeEvent: (listener) => wrapper.onEvent((event) => listener(event)),
        // 只中止当前 bash 命令，不 abort 整个 turn（agent 收到错误结果后继续）。
        abortBash: () => wrapper.inner.abortBash(),
        // 当前会话正在使用的模型（实时读取；运行时监测（如 aiti-model-check 大量 429 阻断标记）用它归属模型）。
        getModel: () => {
          const m = wrapper.inner.model;
          return m && m.provider && m.id ? { provider: m.provider, modelId: m.id } : null;
        },
        steer: async (t) => {
          if (!wrapper.isAlive()) return;
          await wrapper.send({ type: "steer", message: t });
          if (!wrapper.isRunning()) await wrapper.send({ type: "continue_queue" });
        },
      });
    } catch (e) { console.error("[pi-web] agent 会话启动分发失败:", e instanceof Error ? e.message : e); }

    return { session: wrapper, realSessionId };
  })().finally(() => {
    locks.delete(sessionId);
    finishStartingSession();
  });

  locks.set(sessionId, starting);
  return starting;
}

// ── 我方：running 状态 SSE 主通道基础设施（上游 v0.8.11 删除了该通道，我方侧栏以其为主、慢轮询为兜底，故恢复）──
let lastRunningSnapshot = "";

function getRunningListeners(): Set<(ids: string[]) => void> {
  if (!globalThis.__piRunningListeners) globalThis.__piRunningListeners = new Set();
  return globalThis.__piRunningListeners;
}

/**
 * 进程内本地会话工厂（globalThis 缝，与 __piSubagentFactory 同模式）。
 *
 * 扩展（jiti 加载，无法 import "@/lib/rpc-manager"）经
 * `globalThis.__piLocalSessionFactory.start(...)` 在本进程内创建/打开真实 pi 会话：
 * cc-connect 桥接（aiti-channels ACP server → pi-web 会话）等场景用。
 * start 参数与返回值同 startRpcSession——新会话传一次性 key（`__acp__<uuid>`），
 * 重开已有会话传真实 session id（registry 命中时直接复用 UI 已打开的 wrapper）。
 */
export function installLocalSessionFactory(): void {
  const g = globalThis as Record<string, unknown>;
  if (!g.__piLocalSessionFactory) g.__piLocalSessionFactory = { start: startRpcSession };
}

// 模块加载即安装（幂等）：任何 realm 加载本模块都设 globalThis。
// 不只依赖 instrumentation.ts——Next turbopack 下 instrumentation 可能运行在
// 独立 realm，其 globalThis ≠ 主应用 realm；routes/扩展都在主 realm 加载本模块，
// 在此设能保证主 realm 也有此缝（aiti-channels ACP 桥等扩展经此创建会话）。
installLocalSessionFactory();

/** Subscribe to running-session-id changes. Returns an unsubscribe function. */
export function subscribeRunningSessions(listener: (ids: string[]) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}


/**
 * Recompute the running-session-id set and, if it changed since the last
 * notification, broadcast it to subscribers.
 */
export function notifyRunningChange(): void {
  const listeners = getRunningListeners();
  if (listeners.size === 0) {
    // A future subscriber receives its own initial snapshot. Clear this one so
    // its first state transition cannot match stale state from an old listener.
    lastRunningSnapshot = "";
    return;
  }
  const ids = getRunningRpcSessionIds();
  const snapshot = JSON.stringify([...ids].sort());
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of listeners) {
    try { listener(ids); } catch { /* ignore listener errors */ }
  }
}

/**
 * Session handle abstraction — the seam between pi-web's UI/API layer and
 * whatever actually drives an agent session.
 *
 * Design borrowed from two production multi-agent systems:
 *
 * - cc-connect (Go): minimal mandatory Agent/AgentSession interfaces plus a
 *   large set of OPTIONAL capability interfaces probed via type assertion at
 *   runtime. Proven across 16 agent backends (claude code, codex, gemini,
 *   cursor, kimi, pi, ...).
 *
 * - DSH (TypeScript): explicit `SubagentCapabilities` objects declared by each
 *   provider, with the "fail loud, no silent degradation" rule — a request
 *   needing an unsupported capability is rejected with a typed error rather
 *   than accepted-then-ignored.
 *
 * We take cc-connect's minimal core + capability breadth and express it in
 * DSH's declarative style: each SessionHandle publishes a `capabilities`
 * object up front. Callers check capabilities before calling; calling an
 * unsupported method throws {@link UnsupportedCapabilityError}. UI layers read
 * `capabilities` to hide or disable the corresponding controls.
 *
 * Layers:
 *
 *   Layer 3  API routes / React UI          — depends only on SessionHandle
 *   Layer 2  SessionHandle + Capabilities   — this file
 *   Layer 1  Providers (local/attach/spawn) — createSession() factories
 */

// ============================================================================
// Capabilities
// ============================================================================

/**
 * What a session backend can do, declared up front (DSH style).
 *
 * Every flag maps to one or more SessionHandle methods. A `false` flag means
 * the corresponding method throws {@link UnsupportedCapabilityError} and the
 * UI should hide/disable the control.
 *
 * Capability vocabulary follows cc-connect's optional-interface set where a
 * counterpart exists:
 *
 *   cc-connect interface        → capability flag
 *   ─────────────────────────────────────────────────
 *   ModelSwitcher               → setModel
 *   ReasoningEffortSwitcher     → setThinkingLevel
 *   ContextUsageReporter        → contextUsage
 *   ContextCompressor           → compact
 *   AgentSessionCanceller       → abort (always true in our core)
 *   HistoryProvider             → getMessages
 *   SessionDeleter              → deleteSession
 *   ToolAuthorizer              → setActiveTools
 *   CommandProvider/SkillProvider → getCommands
 */
export interface SessionCapabilities {
  /** Queue a steering message mid-run (pi: steering queue). */
  steer: boolean;
  /** Queue a follow-up message for after the current run. */
  followUp: boolean;
  /** Read the full message list / entries of the session. */
  getMessages: boolean;
  /** Report live context usage for the active model. */
  contextUsage: boolean;
  /** Switch the active model at runtime. */
  setModel: boolean;
  /** Switch thinking level (clamped to model capability). */
  setThinkingLevel: boolean;
  /** Fork the session from an entry into a new session file. */
  fork: boolean;
  /** Set the display name of the session. */
  renameSession: boolean;
  /** Compact (summarize) the conversation context. */
  compact: boolean;
  /** Execute a bash command inside the session context. */
  executeBash: boolean;
  /** List configured tools. */
  listTools: boolean;
  /** Enable/disable tools by name. */
  setActiveTools: boolean;
  /** Navigate the session tree to another entry. */
  navigateTree: boolean;
  /** Delete the session permanently. */
  deleteSession: boolean;
  /** List available slash commands (extension commands/templates/skills). */
  getCommands: boolean;

  // ---- Advanced capabilities (cc-connect parity) ──────────────────────────────────
  /** Respond to an agent tool-permission request (cc-connect RespondPermission; e.g. CC's can_use_tool). */
  respondPermission: boolean;
  /**
   * Respond to an agent interaction-primitive request (interaction_request events:
   * plan approval / question prompts). External backend adapters map their native
   * ask/approve protocols (e.g. ExitPlanMode / AskUserQuestion) onto the
   * interaction_request event plus this method; the frontend renders uniform
   * approval/question cards.
   */
  respondInteraction: boolean;
  /**
   * Respond to a start-plan captcha request (provider_runtime_headers_request event →
   * respond_provider_headers command; plan sign-up flow: the frontend runs the official
   * AliyunCaptcha SDK and returns captchaVerifyParam, and the backend re-upserts with
   * the headers attached).
   */
  respondProviderHeaders: boolean;
  /** Query account/model usage and cost (cc-connect UsageReporter). */
  getUsage: boolean;
  /** List models selectable on this backend (cc-connect AvailableModels; data source for the model picker). */
  listModels: boolean;
  /** Send file attachments alongside a message (block-level PDF/document support; plain images don't count — those go through images). */
  fileAttachments: boolean;
  /** Switch the permission mode at runtime (cc-connect ModeSwitcher; e.g. CC's set_permission_mode). */
  setPermissionMode: boolean;
  /**
   * Are steering entries manageable (recall/move/convert/clear)? True for the local
   * pi session and pi-protocol backends (their remote queue reinjects on change);
   * absent/false for CLI backends whose steer entries were already injected into the
   * peer process — the protocol can't take them back, so the queue panel shows those
   * rows read-only. Only meaningful together with `steer`.
   */
  steerQueueManage?: boolean;
}

/**
 * Convenience preset: everything supported. Local in-process sessions use this.
 */
export const FULL_CAPABILITIES: SessionCapabilities = {
  steer: true,
  followUp: true,
  getMessages: true,
  contextUsage: true,
  setModel: true,
  setThinkingLevel: true,
  fork: true,
  renameSession: true,
  compact: true,
  executeBash: true,
  listTools: true,
  setActiveTools: true,
  navigateTree: true,
  deleteSession: true,
  getCommands: true,
  respondPermission: false, // not applicable to local sessions (permissions go through the TUI/extension UI)
  respondInteraction: false, // not applicable to local sessions (interactions go through the TUI/extension UI)
  respondProviderHeaders: false, // not applicable to local sessions
  getUsage: false,
  listModels: true,
  fileAttachments: false,
  setPermissionMode: false,
  steerQueueManage: true,
};

/** Build a partial capability set with everything unspecified = false. */
export function capabilities(partial: Partial<SessionCapabilities>): SessionCapabilities {
  return { ...FULL_CAPABILITIES, ...partial };
}

// ============================================================================
// Core value types (transport-neutral)
// ============================================================================

/** Minimal model identity used across backends. */
export type HandleModel = {
  id: string;
  provider: string;
};

/** Image attachment for prompts. Base64-encoded data URLs payloads. */
export type HandleImage = {
  type: "image";
  data: string;
  mimeType: string;
};

export type PromptOptions = {
  images?: HandleImage[];
  /** File attachments (PDF/documents etc.). @capability fileAttachments */
  files?: HandleFileAttachment[];
  /** How to queue when streaming: interrupt vs wait. Requires steer/followUp capability. */
  streamingBehavior?: "steer" | "followUp";
};

/** Bash execution outcome, normalized across backends. */
export type HandleBashResult = {
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
};

/** Slash command info, normalized across backends. */
export type HandleCommandInfo = {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
};

/** The user's decision on a tool-permission request (mirrors cc-connect's PermissionResult). */
export type PermissionDecision = {
  behavior: "allow" | "deny";
  /** On allow, may carry corrected tool input arguments. */
  updatedInput?: Record<string, unknown>;
  /** Reason when denying. */
  message?: string;
  /**
   * Answer precisely against the host's option table (permission_request event
   * options[].optionId, e.g. ACP's allow_always = "always allow"). When optionId is
   * present the handle treats it as authoritative; behavior is only fallback semantics.
   */
  optionId?: string;
};

/**
 * Interaction-primitive request (the unified shape of handle events with
 * type="interaction_request").
 *
 * Interaction primitives: the agent pauses mid-turn to ask the user for a decision —
 *   - kind="plan_approval": plan approval (e.g. ExitPlanMode; plan = full plan text)
 *   - kind="ask_user": question prompts (e.g. AskUserQuestion; questions = questions + option groups)
 *   - kind="permission": tool permission (reserved; redundant alternate view of permission_request)
 *   - kind="open_url": OAuth login link (e.g. omp login; url/launchUrl fields, one-way, no answer expected)
 *   - kind="generic": anything else in free form (prompt + input only)
 * Backends map their native protocols onto this shape; the convention that consumers
 * ignore unknown kinds gracefully keeps older frontends safe.
 */
export type InteractionRequestEvent = {
  type: "interaction_request";
  /** Unique request id (addressing key for respondInteraction). */
  requestId: string;
  kind: "plan_approval" | "ask_user" | "permission" | "open_url" | "generic";
  /** Originating tool name (e.g. "ExitPlanMode" / "AskUserQuestion"). */
  toolName?: string;
  /** Request description (the agent's one-line rationale/context). */
  prompt?: string;
  /** plan_approval: full plan text (markdown). */
  plan?: string;
  /** open_url: full login/authorization URL (for opening in a browser). */
  url?: string;
  /** open_url: local short link (proxy/redirect wrapper for long OAuth URLs; prefer it for copy-paste). */
  launchUrl?: string;
  /** ask_user: question groups (question is the addressing key — answers are filled in by it). */
  questions?: Array<{
    header?: string;
    question: string;
    multiSelect?: boolean;
    options?: Array<{ label: string; description?: string }>;
  }>;
  /** Raw request payload (backend-defined; the frontend's generic card renders it as a fallback). */
  input?: unknown;
};

/** The user's answer to an interaction-primitive request (input to SessionHandle.respondInteraction). */
export type InteractionAnswer = {
  /** accept = approve/submit the selection; decline = reject. */
  action: "accept" | "decline";
  /** ask_user: answers keyed by question text; single-select = string (option label), multi-select = string array. */
  answers?: Record<string, string | string[]>;
  /** Feedback text when declining a plan_approval (backends should relay it to the agent as the rejection reason so the plan can be revised). */
  message?: string;
};

/**
 * File attachment (aligned with cc-connect Send's FileAttachment).
 * data is base64; backends map it to their protocol's attachment blocks by
 * mimeType (e.g. CC: image/* → image block, application/pdf etc. → document block).
 */
export type HandleFileAttachment = {
  /** Base64-encoded file content. */
  data: string;
  mimeType: string;
  filename?: string;
};

/** Selectable model (mirrors cc-connect's ModelOption: name+desc+alias). */
export type HandleModelOption = {
  id: string;
  provider: string;
  /** Display name (display_name; defaults to id). */
  label?: string;
  /** Short alias (e.g. "sonnet" → full id) for quick /model switching. */
  alias?: string;
};

/** Account-level quota bucket (main allowance / add-on packs / org packs etc.). */
export type UsageBucket = {
  name: string;
  total?: number;
  used?: number;
  remaining?: number;
  /** 0-100; used as-is when the backend provides it, otherwise the caller derives it from total/used. */
  usedPercent?: number;
  limitReached?: boolean;
};

/** Usage/cost snapshot (simplified cc-connect UsageReporter, normalized across backends). */
export type UsageReport = {
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  /** Current turn number (filled when the backend knows it). */
  numTurns?: number;
  /** Plan name ("free" | "pro" | ..., filled when the backend knows it). */
  plan?: string;
  /** Account-level quota buckets (aligned with qoder's user_quota/add_on_quota/org_resource_package). */
  buckets?: UsageBucket[];
  /** Credits balance (backends billed in credits; e.g. the qoder quota API). */
  credits?: { remaining?: number; used?: number; usedPercent?: number; unit?: string; expiresAt?: number };
  /** Whether the quota is exhausted. */
  quotaExceeded?: boolean;
};

// ============================================================================
// Errors (fail loud, DSH rule)
// ============================================================================

/** Thrown when calling a method whose capability flag is false. */
export class UnsupportedCapabilityError extends Error {
  readonly capability: string;
  readonly source: string;

  constructor(capability: string, source: string) {
    super(`Capability "${capability}" is not supported by session backend "${source}"`);
    this.name = "UnsupportedCapabilityError";
    this.capability = capability;
    this.source = source;
  }
}

/** The registry claims ownership but the backend is unreachable — callers must fail rather than fall back to opening locally (single-writer invariant). */
export class BridgeOccupiedError extends Error {
  readonly sessionFile: string;
  constructor(sessionFile: string, detail: string) {
    super(`Session is owned by another pi process (${detail}). Refusing to open locally.`);
    this.name = "BridgeOccupiedError";
    this.sessionFile = sessionFile;
  }
}

/** Thrown when the backend process/connection is gone. */
export class SessionDeadError extends Error {
  constructor(source: string, detail?: string) {
    super(detail ?? `Session backend "${source}" is no longer alive`);
    this.name = "SessionDeadError";
  }
}

// ============================================================================
// Events
// ============================================================================

/**
 * Transport-normalized agent event.
 *
 * Backends map their native event vocabulary onto `type` strings that the
 * frontend already understands (the same event names pi-web renders today:
 * message_start/update/end, tool_execution_*, agent_start/end/settled,
 * turn_start/end, model_select, ...). Backend-specific extras may add fields;
 * unknown types must be ignored gracefully by consumers.
 */
export type HandleEvent = {
  type: string;
  [key: string]: unknown;
};

export type HandleEventListener = (event: HandleEvent) => void;

// ============================================================================
// SessionHandle — the mandatory core (cc-connect minimalism)
// ============================================================================

/**
 * Uniform handle over one running agent session, regardless of backend.
 *
 * The four members prompt/abort/subscribe/dispose are MANDATORY — every
 * backend implements them (cc-connect's Send/Events/Close equivalent).
 * Everything else is gated by `capabilities`.
 */
export interface SessionHandle {
  /** Stable session identifier (backend-scoped). */
  readonly id: string;

  /**
   * Which backend created this handle: "local" | "attach" | "spawn" | ...
   * Used for UI badges and error messages.
   */
  readonly source: string;

  /** Declared capability set. Checked before calling optional methods. */
  readonly capabilities: SessionCapabilities;

  // ---- mandatory core ----------------------------------------------------

  /** Send a user message. Triggers a turn when idle; queues per opts when running. */
  prompt(text: string, options?: PromptOptions): Promise<void>;

  /** Optional raw command channel (attach/socket backends): send a JSONL command frame and resolve its response data. */
  send?(command: Record<string, unknown>): Promise<unknown>;

  /** Cancel the current run (or pending work). Never kills the session itself. */
  abort(): Promise<void>;

  /** Subscribe to normalized agent events. Returns unsubscribe function. */
  subscribe(listener: HandleEventListener): () => void;

  /** Release resources. Idempotent. Does NOT necessarily delete the session file. */
  dispose(): Promise<void>;

  // ---- state queries (cheap, always available in some form) ---------------

  /** Whether the underlying process/connection is alive. */
  alive(): boolean;

  /** Whether the agent is currently streaming/running a turn. */
  isRunning(): boolean;

  /** Current model, if known. */
  getModel(): HandleModel | undefined;

  /** Working directory of the session (backend-provided; empty string if unknown). */
  readonly cwd: string;

  /**
   * Last activity time (epoch ms). External agent sessions appear in the sidebar as
   * placeholder-file (uuid) rows; the placeholder file is a static anchor with no
   * conversation, so its `modified` freezes at creation time. After the conversation
   * continues the handle has activity but the placeholder row never updates on its
   * own — /api/sessions uses this method to overlay the live activity time from an
   * alive handle onto the placeholder row's modified. Returns undefined when not
   * implemented (behavior unchanged).
   */
  getLastActivity?(): number | undefined;

  // ---- optional operations (capability-gated) -----------------------------

  /** @capability steer */
  steer?(text: string): Promise<void>;
  /** @capability followUp */
  followUp?(text: string): Promise<void>;
  /** @capability getMessages */
  getMessages?(): Promise<unknown[]>;
  /** @capability contextUsage */
  getContextUsage?():
    | { percent: number | null; contextWindow: number; tokens: number | null }
    | undefined;
  /** @capability setModel */
  setModel?(model: HandleModel): Promise<boolean>;
  /** @capability setThinkingLevel */
  setThinkingLevel?(level: string): void;
  /** @capability fork */
  fork?(entryId: string, opts?: { reset?: boolean }): Promise<{ cancelled: boolean; newSessionFile?: string }>;
  /** @capability renameSession */
  setSessionName?(name: string): void;
  /** @capability compact */
  compact?(customInstructions?: string): Promise<unknown>;
  /** @capability executeBash */
  executeBash?(
    command: string,
    onChunk?: (chunk: string) => void,
  ): Promise<HandleBashResult>;
  /** @capability listTools */
  getAllTools?(): Promise<Array<{ name: string; description: string }>> | Array<{ name: string; description: string }>;
  /** @capability setActiveTools */
  setActiveTools?(names: string[]): void;
  /** @capability navigateTree */
  navigateTree?(
    targetId: string,
    options?: { summarize?: boolean },
  ): Promise<{ cancelled: boolean }>;
  /** @capability deleteSession */
  deleteSession?(): Promise<void>;
  /** @capability getCommands */
  getCommands?(): Promise<HandleCommandInfo[]>;
  /**
   * Backend-side queue management primitive (adapter for the queue keeper; local
   * sessions keep their own mirror in the wrapper and never take this path).
   * When unimplemented the adapter's queue command family stays a no-op
   * (backward compatible).
   * @capability queueManage
   */
  queueManage?(req: {
    action: "list" | "clear" | "move" | "convert" | "remove" | "recall" | "requeue";
    kind?: "steer" | "followUp";
    from?: number;
    to?: number;
    index?: number;
    targetKind?: "steer" | "followUp";
    text?: string;
  }): Promise<{
    steering: string[];
    followUp: string[];
    entry?: { text: string };
    removed?: { id: string; kind: string; text: string; hasImages: boolean; queuedAt: number };
  }>;
  /**
   * Task-list snapshot (read-only mirror of the agent session's working plan; the
   * real-data source for get_state, probed by method presence — same pattern as
   * queueManage. The protocol has no write methods → no mutation primitives).
   * @capability taskList
   */
  taskList?(): Promise<{
    todos: Array<{ content: string; status: "pending" | "in_progress" | "completed"; priority?: string }>;
  }>;
  /**
   * Respond to a pending tool-permission request (the request behind
   * type="permission_request" in the event stream).
   * @capability respondPermission
   */
  respondPermission?(requestId: string, decision: PermissionDecision): Promise<boolean>;
  /**
   * Respond to a pending interaction-primitive request (the request behind
   * type="interaction_request" in the event stream).
   * Returns false when the request is stale/no longer exists (timed out and
   * cleaned up, turn ended, etc.).
   * @capability respondInteraction
   */
  respondInteraction?(requestId: string, answer: InteractionAnswer): Promise<boolean>;
  /**
   * Respond to a start-plan captcha-solving request (event stream type=
   * "provider_runtime_headers_request"). On success carries captchaVerifyParam
   * (plus optional region); on cancel/failure carries cancel/error.
   * Returns false = the request is stale.
   * @capability respondProviderHeaders
   */
  respondProviderHeaders?(requestId: string, answer: {
    captchaVerifyParam?: string;
    region?: string;
    error?: string;
    cancel?: boolean;
  }): Promise<boolean>;
  /** Usage/cost snapshot of the most recent turn; credits-billed account backends (e.g. qoder) query an API and may return a Promise. @capability getUsage */
  getUsage?(): UsageReport | undefined | Promise<UsageReport | undefined>;
  /**
   * Session-cumulative usage (accumulated per turn while the handle's process is
   * alive; reset on process restart, not a persistent metric). The data source that
   * turns get_session_stats from hardcoded all-zeros into real totals for external
   * backends. When unimplemented the stats panel stays all zeros (behavior unchanged).
   */
  getUsageTotals?(): {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
    turns?: number;
  } | undefined;
  /** Models selectable on this backend. @capability listModels */
  getAvailableModels?(): Promise<HandleModelOption[]>;
  /**
   * Switch the permission mode at runtime (e.g. "default"/"acceptEdits"/"plan"/"bypassPermissions").
   * @capability setPermissionMode
   */
  setPermissionMode?(mode: string): Promise<boolean>;
}

// ============================================================================
// Capability-guard helper
// ============================================================================

/**
 * Guard for optional methods: throws the typed error when the capability is
 * absent. Implementations call this at the top of every optional method.
 *
 * ```ts
 * async setModel(model: HandleModel) {
 *   guard(this, "setModel");
 *   ...
 * }
 * ```
 */
export function guard(
  handle: Pick<SessionHandle, "source"> & { capabilities: SessionCapabilities },
  capability: keyof SessionCapabilities,
): void {
  if (!handle.capabilities[capability]) {
    throw new UnsupportedCapabilityError(capability, handle.source);
  }
}

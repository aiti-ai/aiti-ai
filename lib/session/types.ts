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

  // ---- cc-connect 对齐的进阶能力 ──────────────────────────────────
  /** 响应 agent 的工具授权请求（cc-connect RespondPermission；如 CC 的 can_use_tool）。 */
  respondPermission: boolean;
  /** 查询账号/模型用量与成本（cc-connect UsageReporter）。 */
  getUsage: boolean;
  /** 列出该后端可选模型（cc-connect AvailableModels；模型选择器数据源）。 */
  listModels: boolean;
  /** 随消息发送文件附件（PDF/document 块级支持；纯图片不算——那走 images）。 */
  fileAttachments: boolean;
  /** 运行时切换权限模式（cc-connect ModeSwitcher；如 CC 的 set_permission_mode）。 */
  setPermissionMode: boolean;
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
  respondPermission: false, // 本地会话无此概念（权限走 TUI/扩展 UI）
  getUsage: false,
  listModels: true,
  fileAttachments: false,
  setPermissionMode: false,
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
  /** 文件附件（PDF/文档等）。@capability fileAttachments */
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

/** 用户对工具授权请求的决定（cc-connect PermissionResult 同构）。 */
export type PermissionDecision = {
  behavior: "allow" | "deny";
  /** allow 时可回传修正后的工具入参。 */
  updatedInput?: Record<string, unknown>;
  /** deny 时的理由。 */
  message?: string;
};

/**
 * 文件附件（cc-connect Send 的 FileAttachment 对齐）。
 * data 为 base64；后端按 mimeType 映射为各自协议的附件块
 * （如 CC：image/* → image 块，application/pdf 等 → document 块）。
 */
export type HandleFileAttachment = {
  /** base64 编码的文件内容。 */
  data: string;
  mimeType: string;
  filename?: string;
};

/** 可选模型（cc-connect ModelOption 同构：name+desc+alias）。 */
export type HandleModelOption = {
  id: string;
  provider: string;
  /** 显示名（display_name；缺省用 id）。 */
  label?: string;
  /** 短别名（如 "sonnet" → 完整 id），供 /model 快捷切换。 */
  alias?: string;
};

/** 用量/成本快照（cc-connect UsageReporter 简化版，跨后端归一化）。 */
export type UsageReport = {
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  /** 当前轮次序号（后端有则填）。 */
  numTurns?: number;
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

/** 注册表声明占用但后端不可达——调用方必须报错而非回退本地打开（单写者红线）。 */
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
  fork?(entryId: string): Promise<{ cancelled: boolean; newSessionFile?: string }>;
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
   * 响应一个待决的工具授权请求（事件流里 type="permission_request" 的 request）。
   * @capability respondPermission
   */
  respondPermission?(requestId: string, decision: PermissionDecision): Promise<boolean>;
  /** 最近一轮的用量/成本快照。@capability getUsage */
  getUsage?(): UsageReport | undefined;
  /** 该后端可选的模型清单。@capability listModels */
  getAvailableModels?(): Promise<HandleModelOption[]>;
  /**
   * 运行时切换权限模式（如 "default"/"acceptEdits"/"plan"/"bypassPermissions"）。
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

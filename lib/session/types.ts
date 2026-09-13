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
  /**
   * 响应 agent 的交互元语请求（interaction_request 事件：plan 方案审批 / 问题询问）。
   * 外部后端适配器把自己的「询问/审批」反向协议（如 zcode ExitPlanMode·AskUserQuestion）
   * 映射为 interaction_request 事件 + 本方法，前端渲染统一的审批卡/问题卡。
   */
  respondInteraction: boolean;
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
  respondInteraction: false, // 本地会话无此概念（交互走 TUI/扩展 UI）
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
  /**
   * 按宿主选项表精确应答（permission_request 事件 options[].optionId，如 ACP 的
   * allow_always=「总是允许」）。有 optionId 时 handle 以它为准，behavior 仅作回退语义。
   */
  optionId?: string;
};

/**
 * 交互元语请求（handle 事件 type="interaction_request" 的统一形状）。
 *
 * pi-web 的交互元语：agent 在一轮执行中暂停下来向用户请求决策——
 *   - kind="plan_approval"：方案审批（如 zcode ExitPlanMode；plan 字段=方案全文）
 *   - kind="ask_user"：问题询问（如 zcode AskUserQuestion；questions=问题+选项组）
 *   - kind="permission"：工具授权（预留；与 permission_request 互为冗余视图）
 *   - kind="generic"：其他自由形态（仅 prompt + input）
 * 后端把自有协议映射到这里（未知类型优雅忽略的约定让旧前端安全）。
 */
export type InteractionRequestEvent = {
  type: "interaction_request";
  /** 请求唯一 id（respondInteraction 的寻址键）。 */
  requestId: string;
  kind: "plan_approval" | "ask_user" | "permission" | "generic";
  /** 来源工具名（如 "ExitPlanMode" / "AskUserQuestion"）。 */
  toolName?: string;
  /** 请求说明（agent 给出的一句话理由/上下文）。 */
  prompt?: string;
  /** plan_approval：方案全文（markdown）。 */
  plan?: string;
  /** ask_user：问题组（question 为寻址键——answers 按它回填）。 */
  questions?: Array<{
    header?: string;
    question: string;
    multiSelect?: boolean;
    options?: Array<{ label: string; description?: string }>;
  }>;
  /** 原始请求负载（后端自定义；前端 generic 卡兜底展示）。 */
  input?: unknown;
};

/** 用户对交互元语请求的回答（SessionHandle.respondInteraction 的入参）。 */
export type InteractionAnswer = {
  /** accept = 批准/提交所选；decline = 拒绝。 */
  action: "accept" | "decline";
  /** ask_user：按问题文本（question）回填答案；单选=字符串（option label），多选=字符串数组。 */
  answers?: Record<string, string | string[]>;
  /** plan_approval 拒绝时的反馈文本（后端应把它作为拒绝理由回给 agent 继续修改方案）。 */
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

/** 账号级配额桶（主窗口/附加包/组织包等）。 */
export type UsageBucket = {
  name: string;
  total?: number;
  used?: number;
  remaining?: number;
  /** 0-100；后端直接给就用，没有则由调用方从 total/used 算。 */
  usedPercent?: number;
  limitReached?: boolean;
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
  /** 套餐名（"free" | "pro" | ...，后端有则填）。 */
  plan?: string;
  /** 账号级配额桶（qoder user_quota/add_on_quota/org_resource_package 对齐）。 */
  buckets?: UsageBucket[];
  /** Credits 余额（按 credits 计费的后端；如 qoder quota API）。 */
  credits?: { remaining?: number; used?: number; usedPercent?: number; unit?: string; expiresAt?: number };
  /** 配额是否已耗尽。 */
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
   * 最后活动时间（epoch ms）。外部 agent 会话以占位文件（uuid）行展示在侧栏，
   * 占位文件是静态锚点、不含对话 → its `modified` 冻结在创建时间。续聊后 handle
   * 有活动但占位行不会自动更新——/api/sessions 靠本方法从存活 handle 取实时活动
   * 时间覆盖占位行 modified。未实现返回 undefined（行为不变）。
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
   * 后端侧队列管理原语（queue keeper 适配；本地会话由 wrapper 自持镜像不走此路径）。
   * 未实现时 adapter 的队列命令族维持 no-op（向后兼容）。
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
   * 响应一个待决的工具授权请求（事件流里 type="permission_request" 的 request）。
   * @capability respondPermission
   */
  respondPermission?(requestId: string, decision: PermissionDecision): Promise<boolean>;
  /**
   * 响应一个待决的交互元语请求（事件流里 type="interaction_request" 的 request）。
   * 返回 false 表示请求已失效/不存在（超时清理、轮次结束等）。
   * @capability respondInteraction
   */
  respondInteraction?(requestId: string, answer: InteractionAnswer): Promise<boolean>;
  /** 最近一轮的用量/成本快照；账号 credits 类后端（如 qoder）走 API，允许 Promise。@capability getUsage */
  getUsage?(): UsageReport | undefined | Promise<UsageReport | undefined>;
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

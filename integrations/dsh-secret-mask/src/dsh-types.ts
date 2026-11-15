/**
 * Minimal local declarations of the DSH (DeepSeek Harness) Cordis surface —
 * shapes aligned with the installed @deepseek-ai packages (dsh-agent
 * runtime-types, dsh-tools, dsh-commands, dsh-system-prompt, dsh-llm) so the
 * plugin compiles without importing peer types. Runtime dispatch is by event
 * string and structural shape only; peer packages stay external in the bundle.
 */

import type { SecretState as CoreSecretState } from "@aiti-ai/secret-mask-core";

// ---- cordis context surface (structural) ----

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface Disposer {
  (): void;
}

/** Everything the plugin touches on the Cordis context, structurally. */
export interface PluginContext {
  logger: Logger;
  on(event: string, handler: (...args: unknown[]) => unknown): Disposer;
  effect(dispose: () => void, label?: string): unknown;
  get(key: string): unknown;
}

export interface ToolsService {
  register(definition: ToolDefinition): Disposer;
  get(name: string, scope?: unknown): ToolDefinition | undefined;
  schemas(scope?: unknown): ToolSchema[];
}

export interface CommandsService {
  register(definition: CommandDefinition): Disposer;
}

export interface SystemPromptService {
  section(section: PromptSection): Disposer;
}

export type Ctx = PluginContext & {
  tools: ToolsService;
  commands: CommandsService;
  systemPrompt: SystemPromptService;
};

// ---- dsh-llm message shapes ----

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ContentBlock {
  type: string;
  [k: string]: unknown;
}

export interface Message {
  readonly id: string;
  readonly role: "system" | "user" | "assistant";
  readonly content: ContentBlock[];
  readonly source: { kind: string; plugin?: string } & Record<string, unknown>;
}

export interface UserMessage extends Message {
  readonly role: "user";
}

export interface GenerateOptions {
  provider: string;
  model: string;
  messages: Message[];
  system?: string;
  sessionId?: string;
  purpose?: "compaction" | "session-title";
  [k: string]: unknown;
}

// ---- dsh-agent events ----

export interface AgentLike {
  id: string;
  ctx?: Ctx & { tools: ToolsService };
}

export interface PreStepPayload {
  agent: AgentLike;
  messages: UserMessage[];
  turn: number;
  step: number;
  signal: AbortSignal;
}

export type PreStepDecision = { kind: "reject" } | { kind: "enter"; messages: UserMessage[] };

export interface SessionStartPayload {
  agent: AgentLike;
  source?: string;
}

// ---- dsh-tools execution shapes ----

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolOutputDeclaration {
  schema: unknown;
  render: (args: unknown, value: unknown) => ContentBlock[];
  presentationMeta?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: ToolOutputDeclaration;
  execute: (args: unknown, exec: ToolExecution) => Promise<unknown>;
  finalizeContent?: (exec: ToolExecution, result: unknown) => ContentBlock[];
  timeoutMs?: number;
  isConcurrencySafe?: (args: unknown) => boolean;
  [k: string]: unknown;
}

export interface ToolExecution {
  token: unknown;
  callId: string;
  name: string;
  arguments: unknown;
  signal: AbortSignal;
  agent?: AgentLike;
  parent?: unknown;
}

export interface ToolExecutionResult {
  isError: boolean;
  value?: unknown;
  content: ContentBlock[];
  meta?: unknown;
  additionalContexts?: UserMessage[];
  error?: { message: string; info?: unknown };
}

export type PostToolDecision =
  | { kind: "accept"; content?: ContentBlock[]; additionalContexts?: UserMessage[] }
  | { kind: "accept"; value: unknown; additionalContexts?: UserMessage[] }
  | { kind: "block"; feedback: ContentBlock[]; additionalContexts?: UserMessage[] };

// ---- dsh-commands ----

export interface CommandInvocation {
  commandId: string;
  agent: AgentLike;
  rawInput: string;
  attachments: readonly unknown[];
  signal: AbortSignal;
}

export type CommandResult = { readonly kind: "success"; readonly text?: string } | { readonly kind: "error"; readonly text: string };

export interface CommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string; readonly images?: boolean };
  readonly recordInput?: boolean;
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
}

// ---- dsh-system-prompt ----

export interface PromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string | ((context: { scope?: unknown; signal?: AbortSignal }) => string);
  readonly complete?: boolean;
}

// ---- plugin-side state ----

/** Session state = the shared core state + nothing DSH-specific. */
export type SessionState = CoreSecretState;

export interface PluginConfig {
  enabled: boolean;
  autoDetect: boolean;
  restoreToolArgs: boolean;
  audit: boolean;
  workspaceDir: string;
  /** Audit evidence file override (default ~/.dsh/secret-mask-audit.log). */
  auditPath?: string;
}

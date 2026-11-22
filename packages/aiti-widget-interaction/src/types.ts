/**
 * aiti-widget-interaction — shared request/response protocol.
 *
 * The host owns pending requests. A browser page is only a renderer: it receives
 * requests over SSE, answers over HTTP, and can reconnect after a refresh without
 * losing the host-side callback.
 */

export type InteractionKind = "confirm" | "choose" | "input" | "custom" | "notify" | "presence" | "pick_path";

export type InteractionStatus = "answered" | "cancelled" | "timeout" | "error";

export interface InteractionOption {
  id: string
  label: string
  description?: string
  disabled?: boolean;
}

export interface InteractionAction {
  id: string
  label: string
  kind?: "primary" | "secondary" | "danger" | "ghost";
  value?: unknown;
}

export interface InteractionInputSpec {
  placeholder?: string
  defaultValue?: string
  multiline?: boolean;
  secret?: boolean;
}

export interface InteractionPickSpec {
  mode?: "file" | "directory";
  multiple?: boolean;
  extensions?: string[];
}

export interface InteractionCustomSpec {
  /** A trusted loopback page. The page uses /client and answers with the same id. */
  pageUrl?: string
  data?: unknown;
}

export interface InteractionAgentInfo {
  agentId?: string
  sessionId?: string
  name?: string
}

export interface InteractionState {
  [key: string]: unknown;
}

export interface InteractionRequestInput {
  kind: InteractionKind;
  title?: string
  message?: string
  detail?: string
  options?: Array<string | InteractionOption>;
  actions?: InteractionAction[];
  input?: InteractionInputSpec;
  pick?: InteractionPickSpec;
  custom?: InteractionCustomSpec;
  /** 0 / undefined = wait indefinitely. */
  timeoutMs?: number;
  /** Keep the request pending after an answer; host can resolve it later. */
  keepOpen?: boolean;
  /** Host-owned arbitrary payload for custom renderers. */
  data?: unknown;
  /** Initial display state (custom renderers). */
  state?: InteractionState;
  agent?: InteractionAgentInfo;
}

export interface InteractionRequest extends Required<Pick<InteractionRequestInput, "kind">> {
  id: string
  version: 1;
  kind: InteractionKind;
  title: string
  message: string
  detail: string
  options: InteractionOption[];
  actions: InteractionAction[];
  input: InteractionInputSpec;
  pick: InteractionPickSpec;
  custom: InteractionCustomSpec;
  timeoutMs: number;
  keepOpen: boolean;
  data?: unknown;
  state: InteractionState;
  agent?: InteractionAgentInfo;
  createdAt: string
}

export interface InteractionAnswerInput {
  action?: string
  approved?: boolean;
  value?: unknown;
  comment?: string
  /** Keep the request pending and publish the answer as an update. */
  keepOpen?: boolean;
  state?: InteractionState;
  reason?: string
}

export interface InteractionResult {
  id: string
  status: InteractionStatus;
  action?: string
  approved?: boolean;
  value?: unknown;
  comment?: string
  reason?: string
  state?: InteractionState;
  tookMs: number;
  timeoutMs: number;
}

export interface PendingSnapshot {
  type: "snapshot";
  requests: InteractionRequest[];
}

export interface RequestEvent {
  type: "request";
  request: InteractionRequest;
}

export interface UpdateEvent {
  type: "update";
  id: string
  request: InteractionRequest;
  state: InteractionState;
}

export interface ResolvedEvent {
  type: "resolved";
  id: string
  result: InteractionResult;
}

export type InteractionBrokerEvent =
  | PendingSnapshot
  | RequestEvent
  | UpdateEvent
  | ResolvedEvent;

export type InteractionBrokerListener = (event: InteractionBrokerEvent) => void;

export interface InteractionAnswerOutcome {
  ok: boolean;
  error?: string
  code?: "not_found" | "not_pending" | "keep_open";
  keepOpen?: boolean;
  state?: InteractionState;
  result?: InteractionResult;
}

export interface OpenedInteraction {
  id: string
  request: InteractionRequest;
  result: Promise<InteractionResult>;
}

export interface InteractionBrokerOptions {
  /** Default timeout for requests that do not set timeoutMs (0 = no timeout). */
  timeoutMs?: number;
  idFactory?: () => string
  now?: () => number;
}

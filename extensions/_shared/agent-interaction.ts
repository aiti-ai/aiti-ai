/**
 * _shared/agent-interaction — unified semantics for session "requests needing a user answer" (kind arbitration + pending ledger + answer→wire protocol).
 *
 * Authoritative contract docs/pi-web-ext-agent-interaction-unify-plan.md §2/§3. All session backends (the CC family's
 * control_request/can_use_tool, ACP session/request_permission, zcode reverse requests, pi/omp fork-rpc)
 * convert their protocol's ask into the same `interaction_request` event, and answers come back through the same `respondInteraction`;
 * this layer handles semantic conversion and lifecycle, leaving each handle only "recognize the frame + write the bytes".
 *
 * Three non-negotiable behaviors (all incident/defect driven; see plan §0):
 * 1. `answers`/`approved`/`feedback` must be backfilled into the tool input params (CC's execute() reads the answers and
 *    the approval verdict from params), otherwise AskUserQuestion is fake support — the card is clickable but the answers go nowhere; plan rejection also loses the feedback channel.
 * 2. Pending asks land in a sidecar and can be replayed (**reusing the original requestId**): after the handle is rebuilt or the frontend refreshes,
 *    if the card is no longer clickable the CLI waits forever for an authorization no one answers (root cause of the qoder session hanging 5 hours).
 * 3. A missing options table / unknown optionId always fails closed — never just pick one and call it user consent.
 *
 * Tests: agent-interaction.test.mjs
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type InteractionKind = "tool_auth" | "ask_user" | "plan_approval" | "open_url" | "generic";
export type InteractionExpireReason = "turn_end" | "cancelled" | "dead";

export interface InteractionOption {
  optionId: string;
  kind?: string;
  name?: string;
}

export interface InteractionQuestionOption {
  label: string;
  description?: string;
}

export interface InteractionQuestion {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: InteractionQuestionOption[];
}

/** The unified ask event broadcast by the backend (the host passes it through verbatim to the frontend sessionRequestCard slot). */
export interface InteractionRequestEvent {
  type: "interaction_request";
  requestId: string;
  kind: InteractionKind;
  capability: "respondInteraction";
  toolName?: string;
  input?: unknown;
  questions?: InteractionQuestion[];
  options?: InteractionOption[];
  plan?: string;
  url?: string;
  launchUrl?: string;
  prompt?: string;
  reason?: string;
}

export interface InteractionExpiredEvent {
  type: "interaction_expired";
  requestId: string;
  reason: InteractionExpireReason;
}

/** The frontend answer (the host's respond_interaction command body). */
export interface InteractionAnswer {
  action: "accept" | "decline";
  answers?: Record<string, string | string[]>;
  message?: string;
  optionId?: string;
}

/** Ledger entry (sidecar persisted shape = event + persisted time). */
export interface PendingAsk {
  requestId: string;
  kind: InteractionKind;
  toolName?: string;
  input?: unknown;
  options?: InteractionOption[];
  askedAt: number;
}

export interface InteractionRecord {
  requestId: string;
  kind: InteractionKind;
  toolName?: string;
  input?: unknown;
  decision: "pending" | "allow" | "deny" | "cancelled";
  note?: string;
}

export interface InteractionLedger {
  /** Records a pending ask and broadcasts; a given requestId is reused (the answer must come back to the same id). */
  open(partial: Partial<InteractionRequestEvent> & { kind?: InteractionKind; requestId?: string }): string;
  /** Answer settlement: on hit returns the ledger entry and clears it; miss → null (duplicate answers idempotent). */
  settle(requestId: string, answer: InteractionAnswer): PendingAsk | null;
  pending(): PendingAsk[];
  /**
   * The pending broadcast frames (not sent): for subscriber replay — after a frontend refresh the card is gone while the CLI still waits,
   * so re-deliver with these frames (same requestId, idempotent, nothing new created).
   */
  replay(): InteractionRequestEvent[];
  /** Turn settlement / process death: one interaction_expired each + leave a trace + clear. */
  failPending(reason: InteractionExpireReason): number;
  /** Restores pending asks from the sidecar at startup, returning the recovered count (0 when there is no sidecar path). */
  load(): number;
}

// ── kind arbitration ──────────────────────────────────────────────────────

/** Strips the mcp__server__ prefix and normalizes case/separators for tool-name matching. */
function normalizeToolName(name?: string): string {
  if (!name) return "";
  let base = name;
  if (base.startsWith("mcp__")) {
    // the server name may contain underscores (mcp__my_server__AskUserQuestion) → take the part after the last separator
    const tail = base.lastIndexOf("__");
    base = tail > 5 ? base.slice(tail + 2) : base.slice(5);
  }
  return base.replace(/[^A-Za-z]/g, "").toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function isValidQuestions(value: unknown): value is InteractionQuestion[] {
  const arr = Array.isArray(value) ? value : null;
  if (!arr || arr.length === 0) return false;
  return arr.every((q) => {
    const item = asRecord(q);
    return !!item && typeof item.question === "string" && Array.isArray(item.options);
  });
}

/** The backend's explicit marker (zcode schema.interaction) takes priority, then the tool name. */
export function deriveAskKind(toolName?: string, input?: unknown): InteractionKind {
  const marked = asRecord(input)?.interaction;
  if (marked === "plan_approval") return "plan_approval";
  if (marked === "ask_user") return "ask_user";
  const name = normalizeToolName(toolName);
  if (name === "exitplanmode") return "plan_approval";
  if (name === "askuserquestion") return isValidQuestions(asRecord(input)?.questions) ? "ask_user" : "tool_auth";
  return "tool_auth";
}

// ── answers → each vendor's wire protocol ───────────────────────────────────────────────────

function denyMessage(answer: InteractionAnswer): string {
  return answer.message && answer.message.trim() ? answer.message : "denied by user";
}

/** The CC family's control_response.response (allow/deny + updatedInput backfill). */
export function toControlResponse(
  ask: { kind: InteractionKind; input?: unknown; options?: InteractionOption[] },
  answer: InteractionAnswer,
): Record<string, unknown> {
  if (answer.optionId && ask.options?.length) {
    const picked = ask.options.find((o) => o?.optionId === answer.optionId);
    if (!picked) return { behavior: "deny", message: `unknown optionId: ${answer.optionId}` };
    return normalizeOptionKind(picked) === "reject"
      ? { behavior: "deny", message: denyMessage(answer) }
      : { behavior: "allow" };
  }
  if (ask.kind === "plan_approval") {
    // a plan-approval rejection is **not** a permission denial: deny would only return "user denied authorization", losing the plan feedback channel (feedback)
    // and the "revise and continue" semantics. ExitPlanMode's execute reads params.approved/feedback.
    const base = asRecord(ask.input) ?? {};
    if (answer.action === "decline") {
      const feedback = answer.message && answer.message.trim() ? answer.message.trim() : undefined;
      return { behavior: "allow", updatedInput: { ...base, approved: false, ...(feedback ? { feedback } : {}) } };
    }
    return { behavior: "allow", updatedInput: { ...base, approved: true } };
  }
  if (answer.action === "decline") return { behavior: "deny", message: denyMessage(answer) };
  if (ask.kind === "ask_user") {
    // AskUserQuestion's execute reads from params.answers (key = question text); not backfilling = empty answers
    return { behavior: "allow", updatedInput: { ...(asRecord(ask.input) ?? {}), answers: answer.answers ?? {} } };
  }
  return { behavior: "allow" };
}

/** ACP family: the answer must land on a concrete optionId; if not found, do not answer (fail-closed). */
export function toAcpOptionId(options: InteractionOption[] | undefined, answer: InteractionAnswer): string | undefined {
  const list = (options ?? []).filter((o) => o && typeof o.optionId === "string");
  if (answer.optionId) return list.find((o) => o.optionId === answer.optionId)?.optionId;
  const want = answer.action === "decline" ? "reject" : "allow";
  return list.find((o) => normalizeOptionKind(o) === want)?.optionId;
}

function normalizeOptionKind(option: InteractionOption): "allow" | "reject" {
  const text = `${option.kind ?? ""} ${option.name ?? ""}`.toLowerCase();
  return /reject|deny|cancel|refuse/.test(text) ? "reject" : "allow";
}

// ── pending ledger ──────────────────────────────────────────────────────────

const ALLOWED_KINDS = new Set<InteractionKind>(["tool_auth", "ask_user", "plan_approval", "open_url", "generic"]);
const TEXT_FIELDS = ["plan", "url", "launchUrl", "prompt", "reason"] as const;

function sanitizeString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function sanitizeOptions(value: unknown): InteractionOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((o) => {
    const item = asRecord(o);
    return !!item && typeof item.optionId === "string";
  }) as InteractionOption[];
  return list.length ? list : undefined;
}

function sanitizeQuestions(value: unknown): InteractionQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((q) => {
    const item = asRecord(q);
    return !!item && typeof item.question === "string" && Array.isArray(item.options);
  }) as InteractionQuestion[];
  return list.length ? list : undefined;
}

/** Distrusts external input: sanitizes field by field and produces both the ledger entry and the broadcast event (the sidecar read-back goes through here too). */
function normalizeAsk(partial: Partial<InteractionRequestEvent> & { requestId?: string }, askedAt: number):
  { ask: PendingAsk; event: InteractionRequestEvent } {
  const requestId = sanitizeString(partial.requestId) ?? randomUUID();
  const kind = ALLOWED_KINDS.has(partial.kind as InteractionKind) ? partial.kind as InteractionKind : "tool_auth";
  const ask: PendingAsk = { requestId, kind, askedAt };
  const event: InteractionRequestEvent = { type: "interaction_request", requestId, kind, capability: "respondInteraction" };
  const toolName = sanitizeString(partial.toolName);
  if (toolName) { ask.toolName = toolName; event.toolName = toolName; }
  if (partial.input !== undefined) { ask.input = partial.input; event.input = partial.input; }
  const options = sanitizeOptions(partial.options);
  if (options) { ask.options = options; event.options = options; }
  const questions = sanitizeQuestions(partial.questions);
  if (questions) event.questions = questions;
  for (const key of TEXT_FIELDS) {
    const value = sanitizeString(partial[key]);
    if (value) event[key] = value;
  }
  return { ask, event };
}

/** Sidecar persisted shape = broadcast event + persisted time (the reconnect replay must send the original frame, not just half of it). */
type PersistedAsk = InteractionRequestEvent & { askedAt: number };

export function createInteractionLedger(opts: {
  emit(event: InteractionRequestEvent | InteractionExpiredEvent): void;
  /**
   * Sidecar file path (lazily fetched: at handle construction the session id is still the placeholder, see the same-shape comment in each vendor's queue sidecar).
   * Returning undefined = no persistence (the cross-rebuild re-delivery capability degrades automatically).
   */
  sidecarFile?: () => string | undefined;
  record?(note: InteractionRecord): void;
  now?: () => number;
}): InteractionLedger {
  const entries = new Map<string, { ask: PendingAsk; event: InteractionRequestEvent }>();
  const now = opts.now ?? (() => Date.now());

  const persist = (): void => {
    const path = opts.sidecarFile?.();
    if (!path) return;
    // atomic write order (windows-compat-lessons §0.5): write tmp first, then rename
    try {
      mkdirSync(dirname(path), { recursive: true });
      const rows: PersistedAsk[] = [...entries.values()].map(({ ask, event }) => ({ ...event, askedAt: ask.askedAt }));
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(rows), "utf8");
      renameSync(tmp, path);
    } catch {
      /* a sidecar failure must not kill the session: one fewer replay on rebuild */
    }
  };

  const note = (ask: PendingAsk, decision: InteractionRecord["decision"], msg?: string): void => {
    try {
      opts.record?.({ requestId: ask.requestId, kind: ask.kind, toolName: ask.toolName, input: ask.input, decision, note: msg });
    } catch {
      /* tracing is an accessory; it must not backfire on the answer chain */
    }
  };

  return {
    open: (partial) => {
      const { ask, event } = normalizeAsk(partial, now());
      entries.set(ask.requestId, { ask, event });
      note(ask, "pending");
      persist();
      opts.emit(event);
      return ask.requestId;
    },

    settle: (requestId, answer) => {
      const entry = entries.get(requestId);
      if (!entry) return null;
      note(entry.ask, answer.action === "accept" ? "allow" : "deny", answer.message);
      entries.delete(requestId);
      persist();
      return { ...entry.ask };
    },

    pending: () => [...entries.values()].map(({ ask }) => ({ ...ask })),

    replay: () => [...entries.values()].map(({ event }) => event),

    failPending: (reason) => {
      if (entries.size === 0) return 0;
      const list = [...entries.entries()];
      entries.clear();
      for (const [, { ask, event }] of list) {
        note(ask, "cancelled");
        opts.emit({ type: "interaction_expired", requestId: event.requestId, reason });
      }
      persist();
      return list.length;
    },

    load: () => {
      const path = opts.sidecarFile?.();
      if (!path) return 0;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return 0;
      }
      if (!Array.isArray(raw)) return 0;
      let count = 0;
      for (const item of raw) {
        const entry = asRecord(item);
        if (!entry || !sanitizeString(entry.requestId) || !ALLOWED_KINDS.has(entry.kind as InteractionKind)) continue;
        const { ask, event } = normalizeAsk(entry as Partial<InteractionRequestEvent>, Number(entry.askedAt) || now());
        entries.set(ask.requestId, { ask, event });
        count++;
      }
      return count;
    },
  };
}

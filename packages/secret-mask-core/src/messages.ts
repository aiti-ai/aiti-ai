/**
 * pi AgentMessage adapters (host-shape layer, shared by both pi packages).
 *
 * The engine itself is shape-agnostic; this module maps pi's message shapes
 * onto the shared span/deep-traversal primitives:
 *
 *  - `collectSpans` / `redactMessages` — the `context` hook (deep copied
 *    messages, in-place mutation; session transcript untouched).
 *  - `collectSystemSpans` — the `context_with_system` hook (system prompt
 *    sections, otherwise a detection blind spot: values in AGENTS.md reach
 *    the wire through the system segment).
 *  - `redactMessageDeep` — the `message_end` hook (returns a replacement
 *    message; pi persists that copy, so the session file stays value-free in
 *    vault/ephemeral landing modes). Role is preserved.
 *
 * Opaque provider fields (thinking signatures, thought signatures, text
 * signatures) are never touched: they are replayed verbatim by the provider.
 */

import { redactDeep, type Registry, type ScanMaxOptions } from "./mask.ts";
import { applyFixedRules, type CustomRule } from "./rules.ts";
import { redactTextSpans, type SpanRedactOptions } from "./spans.ts";

export interface TextSpan {
  get(): string;
  set(text: string): void;
}

export interface MessageRedactOptions extends ScanMaxOptions, Pick<SpanRedactOptions, "onDetected" | "weak"> {
  rules?: CustomRule[];
  /** Also redact tool-call arguments / tool-result details (message_end). */
  deep?: boolean;
}

/** Collect redactable text spans from one context message (structural typing). */
export function collectSpans(message: unknown): TextSpan[] {
  const spans: TextSpan[] = [];
  const m = message as Record<string, unknown> | null;
  if (!m || typeof m !== "object") return spans;
  const role = m.role as string | undefined;

  const blocksSpan = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return;
    for (const part of blocks) {
      const p = part as Record<string, unknown> | null;
      if (!p) continue;
      if (p.type === "text" && typeof p.text === "string") {
        spans.push({ get: () => p.text as string, set: (t) => (p.text = t) });
      } else if (p.type === "thinking" && typeof p.thinking === "string") {
        spans.push({ get: () => p.thinking as string, set: (t) => (p.thinking = t) });
      }
    }
  };

  const contentSpan = (holder: Record<string, unknown>): void => {
    if (typeof holder.content === "string") {
      spans.push({ get: () => holder.content as string, set: (t) => (holder.content = t) });
    } else {
      blocksSpan(holder.content);
    }
  };

  if (role === "user" || role === "custom" || role === "toolResult" || role === "assistant" || role === "system") {
    contentSpan(m);
  } else if (role === "bashExecution") {
    const holder = m as { command?: string; output?: string };
    if (typeof holder.command === "string") spans.push({ get: () => holder.command as string, set: (t) => (holder.command = t) });
    if (typeof holder.output === "string") spans.push({ get: () => holder.output as string, set: (t) => (holder.output = t) });
  } else if (role === "compactionSummary" || role === "branchSummary") {
    const holder = m as { summary?: string };
    if (typeof holder.summary === "string") spans.push({ get: () => holder.summary as string, set: (t) => (holder.summary = t) });
  }
  return spans;
}

/** Spans of a system message, including its prompt `sections` patches. */
export function collectSystemSpans(message: unknown): TextSpan[] {
  const spans = collectSpans(message);
  const m = message as Record<string, unknown> | null;
  if (!m || m.role !== "system") return spans;
  const sections = m.sections as Record<string, string | null> | undefined;
  if (sections && typeof sections === "object") {
    for (const key of Object.keys(sections)) {
      const value = sections[key];
      if (typeof value === "string") {
        spans.push({
          get: () => sections[key] as string,
          set: (t) => {
            sections[key] = t;
          },
        });
      }
    }
  }
  return spans;
}

/** Roles whose text was authored by the user (auto-detection applies). */
export function userAuthored(message: unknown): boolean {
  const role = (message as Record<string, unknown> | null)?.role;
  return role === "user" || role === "bashExecution";
}

export interface MessageRedactResult {
  changed: boolean;
  newEntries: number;
}

/**
 * Register new auto-detected secrets from user-authored text, then redact all
 * registered value forms across every collected span (the shared span loop).
 * Mutates the (deep copied) messages in place.
 */
export function redactMessages(
  messages: unknown[],
  registry: Registry,
  salt: string,
  opts: MessageRedactOptions = {},
): MessageRedactResult {
  let changed = false;
  let newEntries = 0;
  for (const message of messages) {
    const spans = collectSpans(message);
    if (spans.length === 0) continue;
    const res = redactTextSpans(spans, registry, salt, { ...opts, autoDetect: userAuthored(message) });
    if (res.changed) changed = true;
    newEntries += res.newEntries;
  }
  return { changed, newEntries };
}

/** Redact only system messages (the `context_with_system` complement). */
export function redactSystemMessages(
  messages: unknown[],
  registry: Registry,
  opts: MessageRedactOptions = {},
): MessageRedactResult {
  let changed = false;
  let newEntries = 0;
  for (const message of messages) {
    if ((message as { role?: string } | null)?.role !== "system") continue;
    const spans = collectSystemSpans(message);
    const res = redactTextSpans(spans, registry, "", { ...opts, autoDetect: false });
    if (res.changed) changed = true;
    newEntries += res.newEntries;
  }
  return { changed, newEntries };
}

/**
 * One message → redacted replacement copy (message_end). Returns the original
 * message when nothing matched. Only roles pi persists are handled; opaque
 * signatures are skipped by construction.
 */
export function redactMessageDeep(
  message: unknown,
  registry: Registry,
  opts: MessageRedactOptions = {},
): { message: unknown; count: number } {
  const spans = collectSpans(message);
  let count = 0;
  for (const span of spans) {
    const r = registry.redact(span.get());
    count += r.count;
  }
  const extra = opts.deep === false ? 0 : countDeepTargets(message, registry);
  if (count + extra === 0) return { message, count: 0 };

  const clone = structuredClone(message) as Record<string, unknown>;
  let wrote = 0;
  for (const span of collectSpans(clone)) {
    const r = registry.redact(span.get());
    if (r.count > 0) {
      span.set(r.text);
      wrote += r.count;
    }
  }
  if (opts.deep !== false) wrote += redactDeepTargets(clone, registry);
  return { message: clone, count: wrote };
}

// ---------------------------------------------------------------------------
// structured parts that are not plain content spans
// ---------------------------------------------------------------------------

function deepTargets(message: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];
  const role = message.role;
  if (role === "assistant" && Array.isArray(message.content)) {
    for (const part of message.content) {
      const p = part as Record<string, unknown> | null;
      if (p && p.type === "toolCall" && p.arguments && typeof p.arguments === "object") out.push(p.arguments);
    }
  }
  if (role === "toolResult") {
    for (const key of ["details", "structuredContent"]) {
      const v = message[key];
      if (v !== undefined && v !== null) out.push(v);
    }
    const nested = message.nestedCalls as { calls?: Array<Record<string, unknown>> } | undefined;
    if (nested?.calls) {
      for (const call of nested.calls) if (call.arguments && typeof call.arguments === "object") out.push(call.arguments);
    }
  }
  return out;
}

function countDeepTargets(message: unknown, registry: Registry): number {
  let count = 0;
  for (const target of deepTargets(message as Record<string, unknown>)) count += redactDeep(target, registry).count;
  return count;
}

function redactDeepTargets(message: Record<string, unknown>, registry: Registry): number {
  let count = 0;
  const role = message.role;
  if (role === "assistant" && Array.isArray(message.content)) {
    for (const part of message.content) {
      const p = part as Record<string, unknown> | null;
      if (p && p.type === "toolCall" && p.arguments && typeof p.arguments === "object") {
        const r = redactDeep(p.arguments, registry);
        if (r.count > 0) p.arguments = r.value;
        count += r.count;
      }
    }
  }
  if (role === "toolResult") {
    for (const key of ["details", "structuredContent"]) {
      const v = message[key];
      if (v === undefined || v === null) continue;
      const r = redactDeep(v, registry);
      if (r.count > 0) {
        message[key] = r.value;
        count += r.count;
      }
    }
    const nested = message.nestedCalls as { calls?: Array<Record<string, unknown>> } | undefined;
    if (nested?.calls) {
      for (const call of nested.calls) {
        if (!call.arguments || typeof call.arguments !== "object") continue;
        const r = redactDeep(call.arguments, registry);
        if (r.count > 0) call.arguments = r.value as Record<string, unknown>;
        count += r.count;
      }
    }
  }
  return count;
}

/** Apply fixed-mode custom rules to a message's content spans (one-way). */
export function applyFixedRulesToMessage(message: unknown, rules: CustomRule[]): number {
  if (!rules.some((r) => r.mode === "fixed")) return 0;
  let count = 0;
  for (const span of collectSpans(message)) {
    const r = applyFixedRules(span.get(), rules);
    if (r.count > 0) {
      span.set(r.text);
      count += r.count;
    }
  }
  return count;
}

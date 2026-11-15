/**
 * AgentMessage redaction for the `context` hook.
 *
 * Handles pi's message shapes without importing host types (structural
 * typing): user (string or text/image blocks), assistant text blocks
 * (thinking/toolCall untouched), toolResult text blocks, bashExecution
 * command+output, custom message content, compaction/branch summaries.
 *
 * Auto-detection (registering newly seen secret-shaped values) runs only on
 * text the user authored: user message content and bash commands. Tool output
 * and model text only get redaction of already-registered values.
 *
 * The hook receives a deep copy, so in-place edits never touch the session
 * transcript — redaction applies to what is sent to the model only.
 */

import type { Registry, ScanMaxOptions } from "./mask.ts";

export interface TextSpan {
  get(): string;
  set(text: string): void;
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
      if (p && p.type === "text" && typeof p.text === "string") {
        spans.push({ get: () => p.text as string, set: (t) => (p.text = t) });
      }
    }
  };

  if (role === "user") {
    if (typeof m.content === "string") {
      const holder = m as { content: string };
      spans.push({ get: () => holder.content, set: (t) => (holder.content = t) });
    } else {
      blocksSpan(m.content);
    }
  } else if (role === "assistant") {
    blocksSpan(m.content);
  } else if (role === "toolResult") {
    blocksSpan(m.content);
  } else if (role === "custom") {
    if (typeof m.content === "string") {
      const holder = m as { content: string };
      spans.push({ get: () => holder.content, set: (t) => (holder.content = t) });
    } else {
      blocksSpan(m.content);
    }
  } else if (role === "bashExecution") {
    const holder = m as { command: string; output: string };
    if (typeof holder.command === "string") spans.push({ get: () => holder.command, set: (t) => (holder.command = t) });
    if (typeof holder.output === "string") spans.push({ get: () => holder.output, set: (t) => (holder.output = t) });
  } else if (role === "compactionSummary" || role === "branchSummary") {
    const holder = m as { summary: string };
    if (typeof holder.summary === "string") spans.push({ get: () => holder.summary, set: (t) => (holder.summary = t) });
  }
  return spans;
}

/** Roles whose text was authored by the user (auto-detection applies). */
function userAuthored(message: unknown): boolean {
  const role = (message as Record<string, unknown> | null)?.role;
  return role === "user" || role === "bashExecution";
}

export interface MessageRedactResult {
  changed: boolean;
  newEntries: number;
}

/**
 * Register new auto-detected secrets from user-authored text, then redact all
 * registered value forms across every collected span. Mutates the (deep
 * copied) messages in place.
 */
export function redactMessages(
  messages: unknown[],
  registry: Registry,
  salt: string,
  opts: ScanMaxOptions = {},
): MessageRedactResult {
  let newEntries = 0;
  let changed = false;
  for (const message of messages) {
    const spans = collectSpans(message);
    if (spans.length === 0) continue;
    const detect = userAuthored(message);
    for (const span of spans) {
      const text = span.get();
      if (!text) continue;
      if (detect) newEntries += registry.autoRegister(text, salt, opts).length;
      const res = registry.redact(text);
      if (res.count > 0) {
        span.set(res.text);
        changed = true;
      }
    }
  }
  return { changed, newEntries };
}

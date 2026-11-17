/**
 * AgentMessage redaction for the `context` hook — pi's message-shape adapter.
 *
 * Maps pi's message shapes onto the shared engine's span contract
 * (@aiti-ai/secret-mask-core): user (string or text/image blocks), assistant
 * text blocks (thinking/toolCall untouched), toolResult text blocks,
 * bashExecution command+output, custom message content, compaction/branch
 * summaries. The hook receives a deep copy, so in-place span mutation never
 * touches the session transcript — redaction applies to what is sent to the
 * model only.
 */

import { redactTextSpans, type Registry, type ScanMaxOptions } from "@aiti-ai/secret-mask-core";

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
 * registered value forms across every collected span (the shared span loop).
 * Mutates the (deep copied) messages in place.
 */
export function redactMessages(
  messages: unknown[],
  registry: Registry,
  salt: string,
  opts: ScanMaxOptions = {},
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

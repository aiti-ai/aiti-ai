/**
 * DSH message adaptation: collect redactable text spans from one UserMessage
 * (text content blocks only; images and other block types are never scanned),
 * and rewrite messages immutably — DSH messages are frozen, so a changed
 * message must be rebuilt as `{ ...message, content: [newBlocks] }` before
 * entering a step (the aiti-devtools-dsh pre-step pattern).
 */

import { applyFixedRules, registerRuleMatches } from "@aiti-ai/secret-mask-core";
import type { ContentBlock, Message, SessionState, TextBlock, UserMessage } from "./dsh-types.ts";

export interface TextSpan {
  block: TextBlock;
}

export function isTextBlock(block: unknown): block is TextBlock {
  return (
    !!block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

/** All text blocks of one message (the only spans we ever read or rewrite). */
export function textBlocks(message: Message): TextBlock[] {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content.filter(isTextBlock);
}

export interface BlockRewrite {
  /** Same block reference when unchanged; a new block when rewritten. */
  block: TextBlock | ContentBlock;
  changed: boolean;
}

/** Apply fn to one text block; returns the original reference when fn leaves the text unchanged. */
export function rewriteTextBlock(block: ContentBlock, fn: (text: string) => string): BlockRewrite {
  if (!isTextBlock(block)) return { block, changed: false };
  const next = fn(block.text);
  if (next === block.text) return { block, changed: false };
  return { block: { ...block, text: next }, changed: true };
}

export interface MessageRedactResult {
  /** New message reference when any block changed; the original reference otherwise. */
  message: UserMessage;
  changed: boolean;
  /** Newly auto-registered entries (only produced for user-authored text). */
  newEntries: number;
}

/**
 * Auto-register secret-shaped values from user-authored text (source.kind ===
 * "user"; plugin-injected context is only redacted, never mined), then redact
 * every registered value form across the message's text blocks.
 */
export function redactUserMessage(
  message: UserMessage,
  st: SessionState,
  autoDetect: boolean,
): MessageRedactResult {
  let changed = false;
  let newEntries = 0;
  const userAuthored = (message.source as { kind?: string } | undefined)?.kind === "user";
  const content = message.content.map((block) => {
    if (!isTextBlock(block) || !block.text) return block;
    if (autoDetect && userAuthored) newEntries += st.registry.autoRegister(block.text, st.salt).length;
    const rules = st.rules ?? [];
    if (rules.length > 0) newEntries += registerRuleMatches(block.text, st.registry, rules, st.salt);
    const res = st.registry.redact(block.text);
    let text = res.text;
    let count = res.count;
    if (rules.length > 0) {
      const fixed = applyFixedRules(text, rules);
      text = fixed.text;
      count += fixed.count;
    }
    if (count === 0) return block;
    changed = true;
    return { ...block, text };
  });
  if (!changed) return { message, changed: false, newEntries };
  return { message: { ...message, content }, changed: true, newEntries };
}

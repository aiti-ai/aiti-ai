import type { AgentMessage, AssistantMessage, ToolCallContent } from "./types.ts";

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function streamingRawInput(block: Record<string, unknown>): string | undefined {
  if (typeof block.rawInput === "string") return block.rawInput;
  if (typeof block.partialJson === "string") return block.partialJson;
  if (typeof block.partialArgs === "string") return block.partialArgs;

  const customInput = isObject(block.customInput) ? block.customInput : null;
  const property = customInput && typeof customInput.property === "string"
    ? customInput.property
    : null;
  const args = isObject(block.arguments) ? block.arguments : null;
  return property && args && typeof args[property] === "string"
    ? args[property]
    : undefined;
}

function normalizeToolCallBlock(
  block: unknown,
  options: { includeStreamingRawInput?: boolean } = {},
): ToolCallContent | null {
  if (!isObject(block) || block.type !== "toolCall") return null;
  const normalized: ToolCallContent = {
    type: "toolCall",
    toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : (typeof block.id === "string" ? block.id : ""),
    toolName: typeof block.toolName === "string" ? block.toolName : (typeof block.name === "string" ? block.name : ""),
    input: typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)
      ? block.input as Record<string, unknown>
      : (typeof block.arguments === "object" && block.arguments !== null && !Array.isArray(block.arguments)
        ? block.arguments as Record<string, unknown>
        : {}),
  };
  const rawInput = options.includeStreamingRawInput ? streamingRawInput(block) : undefined;
  return rawInput === undefined ? normalized : { ...normalized, rawInput };
}

function normalizeAssistantToolCalls(
  msg: AgentMessage,
  options: { includeStreamingRawInput?: boolean } = {},
): AgentMessage {
  // Non-assistant roles (user, toolResult, bashExecution, custom) are returned
  // unchanged — only assistant messages go through tool-call field normalization.
  if (msg.role !== "assistant") return msg;
  const content = (msg as AssistantMessage).content;
  if (!Array.isArray(content)) return msg;
  const normalized = content.map((block) => {
    const result = normalizeToolCallBlock(block, options);
    return result ?? block;
  });
  return { ...msg, content: normalized } as AgentMessage;
}

export function normalizeToolCalls(msg: AgentMessage): AgentMessage {
  return normalizeAssistantToolCalls(msg);
}

/**
 * Synthesize `content` for wire frames that carry plain `text` instead of
 * content blocks (echo agents, minimal external backends: `{role, text, ts}`).
 * The render layer (turn-views, ChatWindow input history, MessageView) assumes
 * user content is string|blocks and assistant content is always an array with
 * model/provider — a missing `content` crashed the whole chat with
 * "Cannot read properties of undefined". User keeps the string form (allowed
 * by UserMessage); assistant gets a single text block + placeholder identity.
 */
function normalizeMissingContent(msg: AgentMessage): AgentMessage {
  // Wire frames from external backends are untyped ({role, text, ts}); go via
  // unknown — AgentMessage union members don't carry an index signature.
  const m = msg as unknown as Record<string, unknown>;
  if (m.content !== undefined && m.content !== null) return msg;
  if (typeof m.text !== "string") return msg;
  if (msg.role === "user") {
    return { ...msg, content: m.text } as AgentMessage;
  }
  if (msg.role === "assistant") {
    return {
      ...msg,
      content: [{ type: "text", text: m.text }],
      model: typeof m.model === "string" ? m.model : "(external)",
      provider: typeof m.provider === "string" ? m.provider : "(external)",
    } as AgentMessage;
  }
  return msg;
}

/**
 * Normalize raw SDK-shaped messages coming from non-file channels (bridged/
 * attach `get_messages`, provider handles) into pi-web render shape.
 *
 * Session-file reads already normalize server-side (session-reader
 * entryToUiMessage); the bridged paths historically served raw SDK messages,
 * whose toolCall blocks use {id,name,arguments} — ToolCallBlock then rendered
 * an empty name/preview and could not pair tool results ("command execution
 * message is empty").
 * Idempotent: already-normalized messages pass through unchanged.
 */
export function normalizeRawMessages(messages: unknown[]): AgentMessage[] {
  return (Array.isArray(messages) ? messages : []).map((m) =>
    normalizeToolCalls(normalizeMissingContent(m as AgentMessage)));
}

export function normalizeStreamingToolCalls(msg: AgentMessage): AgentMessage {
  return normalizeAssistantToolCalls(msg, { includeStreamingRawInput: true });
}

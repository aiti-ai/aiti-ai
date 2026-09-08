import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function getThinkingPreview(thinking: string): string {
  return thinking.trimStart().match(/^[^\r\n]{0,240}/u)?.[0].trimEnd() ?? "";
}

/** 流式折叠行跑马灯预览的字符上限（与 getThinkingPreview 的 240 同量级；截尾保留——最新内容在行尾） */
const THINKING_TAIL_PREVIEW_MAX = 240;

/** 流式折叠行跑马灯预览：取最后一个非空行（对齐 zcode reasoning roll）。
 *  只用于「流式期间 + 折叠态」——跑马灯跟随最新思考内容；历史折叠行仍用 getThinkingPreview（首行）。
 *  超长单行截尾保留（跑马灯 scrollLeft 跟右，用户看到的是行尾最新字符）。 */
export function getThinkingTailPreview(thinking: string): string {
  const lines = thinking.split(/\r\n|\r|\n/u);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line) return line.length > THINKING_TAIL_PREVIEW_MAX ? line.slice(-THINKING_TAIL_PREVIEW_MAX) : line;
  }
  return "";
}

export function isMessageGroupAnchor(message: { role?: AgentMessage["role"]; customType?: string }): boolean {
  return message.role === "user"
    || (message.role === "custom" && message.customType === "compaction");
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}

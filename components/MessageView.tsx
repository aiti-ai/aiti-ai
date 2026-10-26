"use client";

import { memo, useState, useRef, useEffect, useMemo } from "react";
import type { CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import { MarkdownBody } from "./MarkdownBody";
import { ImagePreview } from "./ImagePreview";
import { ThinkingIcon } from "./ThinkingIcon";
import { copyText } from "@/lib/clipboard";
import { apiUrl } from "@/lib/base-path";
import { fmtMoney, useMoneySynced } from "@/lib/money";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { parseCompactionSummary } from "@/lib/compaction-summary";
import { getAssistantErrorMessage, getThinkingPreview, getThinkingTailPreview, hasAssistantAnswer, isAssistantTruncated, isEmptyThinkingBlock, splitThinkingPieces } from "@/lib/message-display";
import { formatTurnDuration } from "@/lib/turn-duration";
import { diffGapLabel, parseUnifiedPatch, unifiedDiffLines, type SplitDiffCell, type SplitDiffFile, type SplitDiffGap, type UnifiedDiffLine } from "@/lib/patch";
import { applyPatchPreviewToFiles, applyPatchResultHasFailures, extractApplyPatchPaths, getApplyPatchFailurePaths, getApplyPatchInputText, parseApplyPatchInput } from "@/lib/apply-patch";
import { isApplyPatchToolName, isEditToolName, isWriteToolName } from "@/lib/tool-names";
import { isToolCallExpanded, setToolCallExpanded } from "@/lib/tool-call-expansion";
import { isThinkingExpandedByDefault, THINKING_EXPANDED_EVENT } from "@/lib/thinking-expansion-preference";
import { TurnWrittenFiles } from "./TurnWrittenFiles";
import { ExtSlot } from "./ExtSlots";
import type { WrittenFile } from "@/lib/turn-written-files";
import { skillExpansionToCommand } from "@/lib/slash-display";
import type { SubagentToolDetails } from "@/lib/subagent-extension";
import { CODEMODE_TOOL_NAME, codemodeCalls, codemodeScript, codemodeScriptPreview, stripCodemodeHeader } from "@/lib/codemode-view";
import { CodemodeCallList } from "./CodemodeToolView";
import { toolFieldsOfInput, type ToolField } from "@/lib/tool-fields";
import { mcpToolLabel, prettyMcpResultText } from "@/lib/mcp-tool-display";
import { streamRateKey, streamRateStart, streamTokensPerSecond, type StreamRateStart } from "@/lib/stream-token-rate";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
  BashExecutionMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
} from "@/lib/types";

type Translate = ReturnType<typeof useI18n>["t"];

// CJK chars ~1 token each (GLM/DeepSeek/GPT-o200k); other chars ~4 chars/token.
const CJK_PATTERN = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}\uac00-\ud7af]/u;
export function estimateTokens(text: string): number {
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    if (CJK_PATTERN.test(ch)) cjk++;
    else rest++;
  }
  return cjk + rest / 4;
}

interface TokenEstimateCacheEntry {
  text: string;
  tokens: number;
}

export function getTokenEstimateText(block: AssistantContentBlock): string | null {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return block.thinking;
  if (block.type === "toolCall") return block.rawInput ?? JSON.stringify(block.input ?? {}) ?? "";
  return null;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function estimateUpdatedTokens(previous: TokenEstimateCacheEntry | undefined, text: string): number {
  if (!previous || !text.startsWith(previous.text)) return estimateTokens(text);

  let baseTokens = previous.tokens;
  let suffixStart = previous.text.length;
  // A streamed delta can complete a surrogate pair that was counted as two
  // non-CJK code points in the previous update.
  if (
    suffixStart > 0
    && suffixStart < text.length
    && isHighSurrogate(previous.text.charCodeAt(suffixStart - 1))
    && isLowSurrogate(text.charCodeAt(suffixStart))
  ) {
    baseTokens -= 1 / 4;
    suffixStart--;
  }
  return baseTokens + estimateTokens(text.slice(suffixStart));
}

const MAX_THINKING_CACHE_ENTRIES = 100;
const thinkingContentCache = new Map<string, Promise<string>>();

// Messages larger than this skip markdown rendering entirely. react-markdown +
// KaTeX + syntax highlighting on multi-hundred-KB payloads (e.g. pasted HAR or
// log dumps) freezes the browser main thread.
const MAX_MARKDOWN_CHARS = 100_000;

function formatMessageBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} B`;
}

/**
 * MarkdownBody with an oversized-content guard: huge messages render as a
 * click-to-reveal plain-text <pre> instead of running the markdown pipeline.
 */
function SafeMarkdownBody({ children, className, ...props }: React.ComponentProps<typeof MarkdownBody>) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);

  if (children.length <= MAX_MARKDOWN_CHARS) {
    return <MarkdownBody className={className} {...props}>{children}</MarkdownBody>;
  }
  if (!showRaw) {
    return (
      <button
        onClick={() => setShowRaw(true)}
        style={{
          display: "block",
          width: "100%",
          margin: "4px 0",
          padding: "7px 10px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        ⚠ {t("i18n.largeMessageReveal", { size: formatMessageBytes(children.length) })}
      </button>
    );
  }
  return (
    <div className={className} style={{ maxHeight: 420, overflow: "auto", fontSize: "calc(12px + var(--chat-font-size-offset, 0px))", lineHeight: 1.5 }}>
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
        }}
      >
        {children}
      </pre>
    </div>
  );
}

// Cap the user "sent" bubble's height so an abnormally long message does not
// push the conversation off screen; overflow scrolls inside the bubble.
const USER_BUBBLE_MAX_HEIGHT = 300;

function loadThinkingContent(sessionId: string, entryId: string, blockIndex: number): Promise<string> {
  const key = `${sessionId}:${entryId}:${blockIndex}`;
  const cached = thinkingContentCache.get(key);
  if (cached) {
    thinkingContentCache.delete(key);
    thinkingContentCache.set(key, cached);
    return cached;
  }

  const request = fetch(
    // apiUrl: dev is deployed under the /dev/ basePath; hardcoding the root path would hit the prod instance (404 / cross-instance leakage)
    apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/thinking?blockIndex=${blockIndex}`),
  ).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { thinking?: unknown };
    if (typeof data.thinking !== "string") throw new Error("Invalid thinking response");
    return data.thinking;
  }).catch((error) => {
    thinkingContentCache.delete(key);
    throw error;
  });

  thinkingContentCache.set(key, request);
  if (thinkingContentCache.size > MAX_THINKING_CACHE_ENTRIES) {
    const oldestKey = thinkingContentCache.keys().next().value;
    if (oldestKey) thinkingContentCache.delete(oldestKey);
  }
  return request;
}

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  entryId?: string;
  searchBlock?: AssistantContentBlock;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => Promise<boolean>;
  prevAssistantEntryId?: string;
  /** Unified "edit from here" entry: frontend-only marking (prefill the input box + highlight + button flips to cancel); the actual rewind happens only when the message is sent */
  onEditFromHere?: (entryId: string, message: UserMessage, branchPointId: string | null) => void;
  /** Whether this message is currently in the pending "edit from here" state (highlight + button flipped to "Cancel") */
  editingFromStart?: boolean;
  /** Cancel the current "edit from here" mark (restore highlight, clear the prefilled input box) */
  onCancelEditFromStart?: () => void;
  onEditContent?: (message: UserMessage, entryId: string) => void;
  onCancelEdit?: () => void;
  isEditing?: boolean;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  /**
   * Files this turn wrote, derived by the caller from the whole turn's
   * successful write/edit tool calls. ChatWindow computes this because the
   * saved-message path splits tool calls into their own entries, leaving the
   * final answer text-only.
   */
  writtenFiles?: WrittenFile[];
  /**
   * Entry ids of every assistant message in this turn (final answer included).
   * Only provided at the turn-final-answer render point, alongside
   * `writtenFiles` — extensions use it to aggregate out-of-band per-entry data
   * (e.g. ledger rows from the git-trace extension) for the whole turn.
   */
  turnAssistantEntryIds?: string[];
  /**
   * Suppress the assistantMessageFooter extension slot at this render point —
   * set for process messages inside a grouped turn whose files the final
   * answer's turn-level footer already aggregates (avoids double display
   * when the group is expanded). The message-level fallback (own entryId
   * only) stays on everywhere else.
   */
  suppressMessageFooter?: boolean;
  onCompact?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
}

/**
 * Model display name: configured alias first, falling back to `<provider>/<model>`.
 *
 * provider / responseModel may be missing — external agents (e.g. ACP replay frames, error
 * messages) may carry a provider without a model. The previous implementation called
 * provider.toLowerCase() directly, so a single message missing its model crashed the whole page
 * render (escaping to global-error; see the 2026-09-12 incident). Here both always participate
 * in comparisons as empty strings, are only rendered when non-empty, and .toLowerCase() is never
 * called bare.
 */
export function getModelDisplayName(
  provider: string | undefined,
  responseModel: string | undefined,
  modelNames?: Record<string, string>,
): string {
  const providerText = provider ?? "";
  const responseText = responseModel ?? "";
  const normalizedProvider = providerText.toLowerCase();
  const normalizedResponse = responseText.toLowerCase();
  const configured = Object.entries(modelNames ?? {}).flatMap(([key, name]) => {
    const separator = key.indexOf(":");
    return separator > 0 && key.slice(0, separator).toLowerCase() === normalizedProvider
      ? [{ id: key.slice(separator + 1).toLowerCase(), name }]
      : [];
  });
  return configured.find((model) => model.id === normalizedResponse && model.id !== "")?.name
    ?? configured.find((model) => model.id !== "" && normalizedResponse.endsWith(`/${model.id}`))?.name
    ?? (normalizedResponse !== ""
      ? Object.entries(modelNames ?? {}).find(([key]) => key.toLowerCase() === normalizedResponse)?.[1]
      : undefined)
    ?? [providerText, responseText].filter(Boolean).join("/");
}

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

export function replaceUserMessageText(message: UserMessage, text: string): UserMessage {
  if (typeof message.content === "string") return { ...message, content: text };

  const content: Array<TextContent | ImageContent> = [];
  let replaced = false;
  for (const block of message.content) {
    if (block.type !== "text") {
      content.push(block);
      continue;
    }
    if (!replaced) {
      content.push({ ...block, text });
      replaced = true;
    }
  }
  if (!replaced) content.unshift({ type: "text", text });
  return { ...message, content };
}

function haveSameRelevantToolResults(
  message: AgentMessage,
  previous: Map<string, ToolResultMessage> | undefined,
  next: Map<string, ToolResultMessage> | undefined,
): boolean {
  if (previous === next || message.role !== "assistant") return true;
  for (const block of (message as AssistantMessage).content ?? []) {
    if (block.type === "toolCall" && previous?.get(block.toolCallId) !== next?.get(block.toolCallId)) {
      return false;
    }
  }
  return true;
}

export const MessageView = memo(function MessageView({ message, isStreaming, toolResults, modelNames, cwd, onOpenFile, onOpenSubagent, entryId, searchBlock, onFork, forking, onNavigate, prevAssistantEntryId, onEditFromHere, editingFromStart, onCancelEditFromStart, onEditContent, onCancelEdit, isEditing, showTimestamp, prevTimestamp, sessionId, writtenFiles, turnAssistantEntryIds, suppressMessageFooter, onCompact, isCompacting, compactError }: Props) {
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} cwd={cwd} onOpenFile={onOpenFile} entryId={entryId} onFork={onFork} forking={forking} onNavigate={onNavigate} prevAssistantEntryId={prevAssistantEntryId} onEditFromHere={onEditFromHere} editingFromStart={editingFromStart} onCancelEditFromStart={onCancelEditFromStart} onEditContent={onEditContent} onCancelEdit={onCancelEdit} isEditing={isEditing} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} sessionId={sessionId} entryId={entryId} searchBlock={searchBlock} writtenFiles={writtenFiles} turnAssistantEntryIds={turnAssistantEntryIds} suppressMessageFooter={suppressMessageFooter} onCompact={onCompact} isCompacting={isCompacting} compactError={compactError} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    if ((message as CustomMessage).customType === "compaction") {
      return <CompactionMessageView message={message as CustomMessage} />;
    }
    return <CustomMessageView message={message as CustomMessage} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (message.role === "bashExecution") {
    return <BashExecutionView message={message as BashExecutionMessage} sessionId={sessionId} />;
  }
  return null;
}, (prev, next) => {
  return prev.message === next.message
    && prev.isStreaming === next.isStreaming
    && haveSameRelevantToolResults(prev.message, prev.toolResults, next.toolResults)
    && prev.modelNames === next.modelNames
    && prev.cwd === next.cwd
    && prev.onOpenFile === next.onOpenFile
    && prev.onOpenSubagent === next.onOpenSubagent
    && prev.entryId === next.entryId
    && prev.searchBlock === next.searchBlock
    && prev.onFork === next.onFork
    && prev.forking === next.forking
    && prev.onNavigate === next.onNavigate
    && prev.prevAssistantEntryId === next.prevAssistantEntryId
    && prev.onEditFromHere === next.onEditFromHere
    && prev.editingFromStart === next.editingFromStart
    && prev.onCancelEditFromStart === next.onCancelEditFromStart
    && prev.onEditContent === next.onEditContent
    && prev.onCancelEdit === next.onCancelEdit
    && prev.isEditing === next.isEditing
    && prev.showTimestamp === next.showTimestamp
    && prev.prevTimestamp === next.prevTimestamp
    && prev.writtenFiles === next.writtenFiles
    && prev.turnAssistantEntryIds === next.turnAssistantEntryIds
    && prev.suppressMessageFooter === next.suppressMessageFooter
    && prev.sessionId === next.sessionId
    && prev.onCompact === next.onCompact
    && prev.isCompacting === next.isCompacting
    && prev.compactError === next.compactError;
});

function UserMessageView({ message, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditFromHere, editingFromStart, onCancelEditFromStart, onEditContent, onCancelEdit, isEditing }: {
  message: UserMessage;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => Promise<boolean>;
  prevAssistantEntryId?: string;
  onEditFromHere?: (entryId: string, message: UserMessage, branchPointId: string | null) => void;
  editingFromStart?: boolean;
  onCancelEditFromStart?: () => void;
  onEditContent?: (message: UserMessage, entryId: string) => void;
  onCancelEdit?: () => void;
  isEditing?: boolean;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Session files can hold `\r\n` or lone `\r` line endings (#680). Chrome renders
  // a lone `\r` as a space even in the pre-wrap command-args and raw-text views.
  // Copy uses this text too; the session file keeps the original endings.
  const content = (
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n")
  ).replace(/\r\n?/g, "\n");

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image");

  const commandText = skillExpansionToCommand(content);
  const commandSeparator = commandText?.search(/\s/) ?? -1;
  const commandName = commandText
    ? commandSeparator === -1 ? commandText : commandText.slice(0, commandSeparator)
    : "";
  const commandArgs = commandText && commandSeparator !== -1
    ? commandText.slice(commandSeparator + 1)
    : "";

  const time = formatTime(message.timestamp);
  const canFork = !!entryId && !!onFork;
  const copyTarget = commandText ?? content;
  const editTarget = commandText ? replaceUserMessageText(message, commandText) : message;

  const imageBlocksNode = imageBlocks.length > 0 && (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: content ? 8 : 0 }}>
      {imageBlocks.map((img, i) => {
        // lib/types.ts ImageContent uses {source:{type,data,media_type,url}}
        // pi-ai on-disk format uses flat {data, mimeType} — handle both
        const flat = img as unknown as { data?: string; mimeType?: string };
        const src = img.source
          ? img.source.type === "base64"
            ? `data:${img.source.media_type};base64,${img.source.data}`
            : img.source.url ?? ""
          : flat.data
            ? `data:${flat.mimeType};base64,${flat.data}`
            : "";
        return (
          <ImagePreview key={i} src={src}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt=""
              style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid rgba(59,130,246,0.15)" }}
            />
          </ImagePreview>
        );
      })}
    </div>
  );
  const canNavigate = !!prevAssistantEntryId && !!onNavigate;
  // Unified "edit from here" button: with a branch point (the previous assistant message) do a regular rewind; without one, the first message rebuilds from the root
  const canEditFromHere = !!onEditFromHere && !!entryId;
  const canEdit = !!entryId && !!onEditContent;
  const canCancelEdit = !!isEditing && !!onCancelEdit;

  const copyContent = () => {
    copyText(copyTarget).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      style={{ marginBottom: 16, display: "flex", flexDirection: "column", alignItems: "flex-end" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, maxWidth: "85%" }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: isEditing ? "color-mix(in srgb, var(--accent) 14%, var(--user-bg))" : "var(--user-bg)",
            border: isEditing ? "1px solid color-mix(in srgb, var(--accent) 62%, var(--user-bg))" : "1px solid rgba(59,130,246,0.2)",
            boxShadow: isEditing ? "0 0 0 2px color-mix(in srgb, var(--accent) 16%, transparent)" : undefined,
            borderRadius: 12,
            padding: "8px 12px",
            fontSize: "calc(14px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.6,
            color: "var(--text)",
            wordBreak: "break-word",
            maxHeight: USER_BUBBLE_MAX_HEIGHT,
            overflowY: "auto",
            // Pending "edit from here" mark: don't swap the border (avoids 1px layout shift), highlight with an outer boxShadow instead
            ...(editingFromStart ? { boxShadow: "0 0 0 1.5px var(--accent), 0 0 12px rgba(59,130,246,0.25)" } : {}),
          }}
        >
          {commandText ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
              {imageBlocksNode}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => setExpanded((prev) => !prev)}
                  title={expanded ? t("i18n.collapse") : t("i18n.expand")}
                  aria-expanded={expanded}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexShrink: 0,
                    padding: 0,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--accent)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "calc(13px + var(--chat-font-size-offset, 0px))",
                    textAlign: "left",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {commandName}
                  </span>
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: 0, opacity: 0.75, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {commandArgs && (
                  <span style={{
                    color: "var(--text)",
                    fontSize: "calc(14px + var(--chat-font-size-offset, 0px))",
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    minWidth: 0,
                    flex: 1,
                  }}>
                    {commandArgs}
                  </span>
                )}
              </div>
              {expanded && (
                <MarkdownBody className="markdown-user-message" keepLineBreaks cwd={cwd} onOpenFile={onOpenFile} messageRole="user">{content}</MarkdownBody>
              )}
            </div>
          ) : (
          <>
          {imageBlocksNode}
          {content && <SafeMarkdownBody className="markdown-user-message" keepLineBreaks cwd={cwd} onOpenFile={onOpenFile} messageRole="user">{content}</SafeMarkdownBody>}
          </>
          )}
        </div>

      </div>

      {/* Bottom row: action buttons + timestamp */}
      {(time || canFork || canEdit || true) && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 6, marginTop: 3,
        }}>
          <div style={{
            display: "flex", gap: 3,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? "auto" : "none",
            transition: "opacity 0.12s",
          }}>
            <button
              onClick={copyContent}
               title={t("i18n.copyMessage")}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 8px", height: 22,
                background: "none", border: "none",
                borderRadius: 5,
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11, fontWeight: 400,
                whiteSpace: "nowrap",
                transition: "color 0.12s",
              }}
              onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              {copied ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
               {copied ? t("i18n.copied") : t("i18n.copy")}
            </button>
          </div>
          {(canFork || canNavigate || canEditFromHere || canEdit || canCancelEdit) && (
            <div style={{
              display: "flex", gap: 3,
              opacity: (hovered || forking || canCancelEdit) ? 1 : 0,
              pointerEvents: (hovered || forking || canCancelEdit) ? "auto" : "none",
              transition: "opacity 0.12s",
            }}>
              {entryId && (
                <ExtSlot
                  name="userMessageActions"
                  currentSession={null}
                  extra={{ entryId }}
                />
              )}
              {canEditFromHere && (
                <button
                  onClick={() => {
                    if (editingFromStart) {
                      onCancelEditFromStart?.();
                    } else {
                      onEditFromHere!(entryId!, editTarget, canNavigate ? prevAssistantEntryId! : null);
                    }
                  }}
                  disabled={forking}
                  title={editingFromStart
                    ? t("i18n.editFromHereCancelTitle")
                    : (canNavigate ? t("i18n.editFromHereTitle") : t("i18n.editFromStartTitle"))}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: editingFromStart ? "var(--accent)" : "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 11, fontWeight: 400,
                    whiteSpace: "nowrap",
                    transition: "color 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { if (!editingFromStart) e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 10 20 15 15 20" />
                    <path d="M4 4v7a4 4 0 0 0 4 4h12" />
                  </svg>
                  {editingFromStart ? t("i18n.editFromHereCancel") : t("i18n.editFromHere")}
                </button>
              )}
              {canEdit && !canCancelEdit && (
                <button
                  onClick={() => onEditContent!(editTarget, entryId!)}
                  title={t("i18n.editFromHereTitle")}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 11, fontWeight: 400,
                    whiteSpace: "nowrap",
                    transition: "color 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 10 20 15 15 20" />
                    <path d="M4 4v7a4 4 0 0 0 4 4h12" />
                  </svg>
                  {t("i18n.editFromHere")}
                </button>
              )}
              {canCancelEdit && (
                <button
                  type="button"
                  onClick={onCancelEdit}
                  title={t("i18n.cancel")}
                  aria-label={t("i18n.cancel")}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: "var(--accent)",
                    cursor: "pointer",
                    fontSize: 11, fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                  {t("i18n.cancel")}
                </button>
              )}
              {canFork && (
                <button
                  onClick={() => { onFork!(entryId!); }}
                  disabled={forking}
                   title={forking ? t("i18n.creatingSession") : t("i18n.newSessionTitle")}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: forking ? "var(--accent)" : "var(--text-dim)",
                    cursor: forking ? "not-allowed" : "pointer",
                    fontSize: 11, fontWeight: 400,
                    whiteSpace: "nowrap",
                    transition: "color 0.12s",
                  }}
                  onMouseEnter={(e) => { if (!forking) e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { if (!forking) e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                   {forking ? t("i18n.creating") : t("i18n.newSession")}
                </button>
              )}
            </div>
          )}
          {time && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{time}</span>}
        </div>
      )}
    </div>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  modelNames,
  cwd,
  onOpenFile,
  onOpenSubagent,
  showTimestamp,
  prevTimestamp,
  sessionId,
  entryId,
  searchBlock,
  writtenFiles,
  turnAssistantEntryIds,
  suppressMessageFooter,
  onCompact,
  isCompacting,
  compactError,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  entryId?: string;
  searchBlock?: AssistantContentBlock;
  writtenFiles?: WrittenFile[];
  turnAssistantEntryIds?: string[];
  suppressMessageFooter?: boolean;
  onCompact?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
}) {
  const { t } = useI18n();
  // Only subscribe to exchange rates when this message actually carries a USD cost (fetch /api/fx only when used; cost-less messages add no page-open requests)
  useMoneySynced((message.usage?.cost?.total ?? 0) > 0);
  const time = showTimestamp ? formatTime(message.timestamp) : null;
  const blockItems = useMemo(() => (message.content ?? [])
    .map((block, originalIndex) => ({ block, originalIndex }))
    .filter(({ block }) => !isEmptyThinkingBlock(block, { isStreaming })), [message.content, isStreaming]);
  const blocks = useMemo(() => blockItems.map(({ block }) => block), [blockItems]);
  const providerError = getAssistantErrorMessage(message, { isStreaming });
  const truncated = isAssistantTruncated(message, { isStreaming });
  const unansweredTruncation = truncated && !hasAssistantAnswer(message);
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const streamStartRef = useRef<StreamRateStart | null>(null);
  const rateKey = streamRateKey(message);
  const streamRateKeyRef = useRef(rateKey);
  streamRateKeyRef.current = rateKey;
  const [tps, setTps] = useState<number | null>(null);
  const blockItemsRef = useRef(blockItems);
  blockItemsRef.current = blockItems;
  const tokenEstimateCacheRef = useRef<Map<number, TokenEstimateCacheEntry>>(new Map());
  const estimatedTokens = useMemo(() => {
    if (!isStreaming) {
      tokenEstimateCacheRef.current = new Map();
      return 0;
    }
    const nextCache = new Map<number, TokenEstimateCacheEntry>();
    let total = 0;
    for (const { block, originalIndex } of blockItems) {
      const text = getTokenEstimateText(block);
      if (text === null) continue;
      const tokens = estimateUpdatedTokens(tokenEstimateCacheRef.current.get(originalIndex), text);
      nextCache.set(originalIndex, { text, tokens });
      total += tokens;
    }
    tokenEstimateCacheRef.current = nextCache;
    return total;
  }, [blockItems, isStreaming]);
  const estimatedTokensRef = useRef(estimatedTokens);
  estimatedTokensRef.current = estimatedTokens;

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // Thinking duration of a completed message: the whole response's generation time, which pi
  // records since 1.1 (`durationMs`, from the request's start). Older messages only have
  // timestamps: the time since the previous message.
  const messageDurationMs = message.role === "assistant" ? recordedDurationMs(message.durationMs) : undefined;
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    const ms = messageDurationMs ?? (message.timestamp && prevTimestamp ? message.timestamp - prevTimestamp : undefined);
    if (ms === undefined) return undefined;
    const secs = Math.round(ms / 1000);
    return secs > 0 ? secs : undefined;
  }, [messageDurationMs, message.timestamp, prevTimestamp]);

  // Tool call durations in milliseconds: the execution time pi records on each result since 1.1,
  // as the pi CLI's "Took" shows it. An older result only has timestamps, the result's minus this
  // message's (when its request started), which counts the model's generation too.
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults) return map;
    for (const [callId, result] of toolResults) {
      const ms = recordedDurationMs(result.durationMs)
        ?? (result.timestamp && message.timestamp ? result.timestamp - message.timestamp : undefined);
      if (ms !== undefined && ms >= TOOL_DURATION_MIN_MS) map.set(callId, ms);
    }
    return map;
  }, [toolResults, message.timestamp]);

  const textContent = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const copyContent = () => {
    copyText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = new Date().getTime();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      streamStartRef.current = null;
      setTps(null);
      return;
    }
    const tick = () => {
      const items = blockItemsRef.current;
      const now = Date.now();

      // Record start time for each block the first time we see it
      items.forEach(({ originalIndex }) => {
        if (!blockStartTimesRef.current.has(originalIndex)) blockStartTimesRef.current.set(originalIndex, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < items.length - 1; i++) {
          const originalIndex = items[i].originalIndex;
          const nextOriginalIndex = items[i + 1].originalIndex;
          if (!next.has(originalIndex) && blockStartTimesRef.current.has(originalIndex)) {
            const start = blockStartTimesRef.current.get(originalIndex)!;
            const nextStart = blockStartTimesRef.current.get(nextOriginalIndex) ?? now;
            next.set(originalIndex, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      const tokens = estimatedTokensRef.current;
      if (tokens === 0) return;
      streamStartRef.current ??= streamRateStart(streamRateKeyRef.current, tokens, now);
      const rate = streamTokensPerSecond(streamStartRef.current, tokens, now);
      if (rate !== null) setTps(rate);
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  if (blocks.length === 0 && !isStreaming && !providerError && !truncated) return null;

  return (
    <div
      data-message-role="assistant"
      data-entry-id={entryId ?? undefined}
      style={{ marginBottom: 16 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Meta line: model + usage + hover actions + timestamp merged into one row (reduces per-message vertical height) */}
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          columnGap: 4,
          rowGap: 2,
        }}
      >
        {(message.provider || message.model) && (
          <span>{getModelDisplayName(message.provider, message.model, modelNames)}</span>
        )}
        {message.usage && !isStreaming && (() => {
          const usageStr = formatUsage(message.usage);
          return usageStr ? <span style={{ fontVariantNumeric: "tabular-nums" }}>{usageStr}</span> : null;
        })()}
        {isStreaming && (() => {
          const est = Math.round(estimatedTokens);
          return (
            <>

              {est > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)" }} title={t("i18n.estimatedTokens")}>
                  <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, fontWeight: 400 }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {est}
                  </span>
                  {tps !== null && (() => {
                    const bg = tps >= 50 ? "#53b3cb" : tps >= 30 ? "#9bc53d" : tps >= 15 ? "#f9c22e" : "#e01a4f";
                    return (
                      <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: bg, color: "#fff", fontSize: 11, fontWeight: 400 }}>
                        {tps.toFixed(1)} t/s
                      </span>
                    );
                  })()}
                </span>
              )}
            </>
          );
        })()}
        {textContent && !isStreaming && (
          <div
            style={{
              display: "flex", alignItems: "center", gap: 6, marginLeft: "auto",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.12s",
            }}
          >
            <button
              onClick={copyContent}
              title={t("i18n.copyMessage")}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "1px 6px", height: 18,
                background: "none", border: "none",
                borderRadius: 5,
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11, fontWeight: 400,
                whiteSpace: "nowrap",
                transition: "color 0.12s",
              }}
              onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              {copied ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
              {copied ? t("i18n.copied") : t("i18n.copy")}
            </button>
            <ExtSlot
              name="assistantMessageActions"
              currentSession={null}
              extra={{ entryId, sessionId, text: textContent }}
            />
          </div>
        )}
        {time && !isStreaming && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: (textContent && !isStreaming) ? 0 : "auto" }}>{time}</span>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {blockItems.map(({ block, originalIndex }) => (
          <BlockView key={`${entryId ?? "stream"}-${originalIndex}`} block={block} searchTarget={block === searchBlock} toolResults={toolResults} isStreaming={isStreaming} streamingDuration={streamingDurations.get(originalIndex) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)} toolCallDurations={toolCallDurations} cwd={cwd} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} sessionId={sessionId} entryId={entryId} blockIndex={originalIndex} />
        ))}
      </div>

      {providerError && (
        <div
          role="alert"
          style={{
            marginTop: blocks.length > 0 ? 8 : 0,
            padding: "7px 10px",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 6,
            background: "rgba(239,68,68,0.07)",
            color: "#ef4444",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          Error: {providerError}
        </div>
      )}

      {truncated && (
        <div
          role="alert"
          style={{
            marginTop: blocks.length > 0 || providerError ? 8 : 0,
            padding: "7px 10px",
            border: "1px solid rgba(234,179,8,0.3)",
            borderRadius: 6,
            background: "rgba(234,179,8,0.07)",
            color: "#ca8a04",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {t(unansweredTruncation ? "chat.truncatedWithoutAnswer" : "chat.truncatedByOutputLimit")}
          {unansweredTruncation && onCompact && (
            <button
              type="button"
              onClick={onCompact}
              disabled={isCompacting}
              style={{
                display: "block",
                marginTop: 8,
                padding: "3px 8px",
                border: "1px solid currentColor",
                borderRadius: 5,
                background: "transparent",
                color: "inherit",
                cursor: isCompacting ? "default" : "pointer",
                font: "inherit",
              }}
            >
              {t(isCompacting ? "chat.compacting" : "chat.compactContext")}
            </button>
          )}
          {unansweredTruncation && compactError && (
            <div style={{ marginTop: 8, color: "#ef4444", whiteSpace: "pre-wrap" }}>{compactError}</div>
          )}
        </div>
      )}

      {writtenFiles && writtenFiles.length > 0 && (
        <TurnWrittenFiles files={writtenFiles} onOpenFile={onOpenFile} />
      )}

      {/* Message-footer extension slot (the git-trace extension: trace capture, changed-file
          rows beyond the write/edit accounting). At the turn's final-answer render point ChatWindow
          passes the whole turn's assistantEntryIds + writtenFiles (the extension diffs to avoid
          duplicates); process messages inside a grouped turn are suppressed (their changes are
          already aggregated by the final answer's turn-level footer, preventing duplicates when
          the group expands); other assistant message render points only get their own entryId
          (message-level fallback). The streaming tail has no entryId and mounts nothing (the live
          trace ledger is not settled yet). */}
      {entryId && !suppressMessageFooter && (
        <ExtSlot
          name="assistantMessageFooter"
          currentSession={null}
          extra={{ entryId, sessionId, cwd, assistantEntryIds: turnAssistantEntryIds, writtenFiles: writtenFiles?.map((f) => f.filePath) }}
        />
      )}

    </div>
  );
}

function BlockView({ block, searchTarget, toolResults, isStreaming, streamingDuration, toolCallDurations, cwd, onOpenFile, onOpenSubagent, sessionId, entryId, blockIndex }: { block: AssistantContentBlock; searchTarget?: boolean; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; streamingDuration?: number; toolCallDurations?: Map<string, number>; cwd?: string; onOpenFile?: (filePath: string, page?: number) => void; onOpenSubagent?: (sessionId: string, label: string) => void; sessionId?: string; entryId?: string; blockIndex: number }) {
  if (block.type === "text") {
    return <div data-message-text data-search-target={searchTarget || undefined}><TextBlock block={block as TextContent} isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} /></div>;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration} isStreaming={isStreaming} sessionId={sessionId} entryId={entryId} blockIndex={blockIndex} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const duration = toolCallDurations?.get(tc.toolCallId);
    return <ToolCallBlock block={tc} result={result} duration={duration} onOpenSubagent={onOpenSubagent} />;
  }
  return null;
}

function TextBlock({ block, isStreaming, cwd, onOpenFile, sessionId }: { block: TextContent; isStreaming?: boolean; cwd?: string; onOpenFile?: (filePath: string, page?: number) => void; sessionId?: string }) {
  // sessionId passthrough: paragraph-click extension point info.sessionId (the message-smart extension relies on it to resolve cross-repo files via the git-trace extension's session-to-repo mapping)
  return <SafeMarkdownBody isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId}>{block.text}</SafeMarkdownBody>;
}

/** Marquee collapsed-row refresh throttle: update at most once per second (matching zcode
 *  reasoning's 1s cadence; no per-line animation — just swap the single row to the latest tail
 *  line and push scrollLeft to the far right) */
const THINKING_TAIL_THROTTLE_MS = 1000;
/** Left/right gradient fade mask for marquee overflow (matching zcode: 16px-wide transparent fade in/out; the mask uses the alpha channel, so the color just needs to be opaque) */
const THINKING_TAIL_FADE_MASK_STYLE: CSSProperties = {
  WebkitMaskImage: "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)",
  maskImage: "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)",
  WebkitMaskRepeat: "no-repeat",
  maskRepeat: "no-repeat",
  WebkitMaskSize: "100% 100%",
  maskSize: "100% 100%",
};

export function ThinkingBlock({ block, duration, isStreaming, sessionId, entryId, blockIndex }: {
  block: ThinkingContent;
  duration?: number;
  isStreaming?: boolean;
  sessionId?: string;
  entryId?: string;
  blockIndex: number;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(isThinkingExpandedByDefault);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  const preview = getThinkingPreview(block.thinking);

  // ── Streaming collapsed-row marquee (mirrors zcode reasoning roll) ──
  // Enabled only while "streaming + collapsed": the preview takes the last non-empty line (the
  // latest thinking), refreshed at most once per second (throttled, not a per-line animation).
  // Each refresh pushes scrollLeft to the far right so the newest content at the line end stays
  // visible; a left/right gradient mask is applied on overflow.
  // History/expanded states never enter this branch (empty tail, zero extra render cost).
  const tailActive = !!isStreaming && !expanded;
  const tail = useMemo(() => (tailActive ? getThinkingTailPreview(block.thinking) : ""), [tailActive, block.thinking]);
  const [tailShown, setTailShown] = useState(tail);
  const [tailOverflow, setTailOverflow] = useState(false);
  const tailWrapRef = useRef<HTMLSpanElement | null>(null);
  const tailTsRef = useRef(0);
  useEffect(() => {
    if (!tailActive) {
      setTailShown("");
      setTailOverflow(false);
      tailTsRef.current = 0;
      return;
    }
    if (tail === tailShown) return; // re-render inside the throttle window: content unchanged, skip the reflow
    const elapsed = performance.now() - tailTsRef.current;
    const flush = () => {
      tailTsRef.current = performance.now();
      setTailShown(tail);
    };
    if (elapsed >= THINKING_TAIL_THROTTLE_MS) {
      flush();
      return;
    }
    const timer = setTimeout(flush, THINKING_TAIL_THROTTLE_MS - elapsed);
    return () => clearTimeout(timer);
  }, [tailActive, tail, tailShown]);
  useEffect(() => {
    const el = tailWrapRef.current;
    if (!el || !tailShown) return;
    el.scrollLeft = el.scrollWidth; // marquee follow: always show the newest content (line end)
    setTailOverflow(el.scrollWidth > el.clientWidth + 1); // gradient mask only for overflowing rows (setState bails out when the value is unchanged)
  }, [tailShown]);

  // Keep already-mounted blocks in sync when the preference changes.
  useEffect(() => {
    const onChange = () => setExpanded(isThinkingExpandedByDefault());
    window.addEventListener(THINKING_EXPANDED_EVENT, onChange);
    return () => window.removeEventListener(THINKING_EXPANDED_EVENT, onChange);
  }, []);

  // Load deferred history content whenever the block is expanded.
  // loadThinkingContent() memoizes in-flight promises and drops failed ones
  // from its cache, so re-running this effect is cheap and a failed load can
  // be retried by collapsing and expanding the block again.
  useEffect(() => {
    if (!expanded || !block.deferred || content !== null) return;
    if (!sessionId || !entryId) {
      setError(tRef.current("i18n.thinkingUnavailable"));
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadThinkingContent(sessionId, entryId, blockIndex)
      .then((value) => {
        if (!cancelled) {
          setContent(value);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, block.deferred, content, sessionId, entryId, blockIndex]);

  return (
    <div style={{
      minWidth: 0,
      border: "1px solid var(--border)",
      borderRadius: 7,
      background: "var(--bg)",
      fontFamily: "var(--font-mono)",
      fontSize: "calc(11px + var(--chat-font-size-offset, 0px))",
      lineHeight: 1.4,
    }}>
      {/* ── Header row: the whole row is clickable (same as the ToolCallBlock header; no longer shrunk to a 14px icon squeezed next to the content) ── */}
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${t("i18n.thinking")}${preview ? `: ${preview}` : ""}`}
        title={t("i18n.thinking")}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          minWidth: 0,
          padding: "3px 10px",
          background: "transparent",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          font: "inherit",
          textAlign: "left",
        }}
      >
        <ThinkingIcon active={expanded} />
        {/* Collapsed = first-line preview; when expanded the content area is below, so the header row shows the label instead to avoid repeating the first line */}
        <span
          ref={tailActive ? tailWrapRef : undefined}
          style={{
            minWidth: 0,
            flex: 1,
            overflow: "hidden",
            // The tail branch doesn't use ellipsis: when scrollLeft is pushed right, the browser
            // paints the ellipsis at the left end of the scrolled-out content, stacking with the
            // gradient mask into a stray "…"; the marquee's truncation indicator is the left-end
            // gradient fade instead.
            textOverflow: tailActive ? "clip" : "ellipsis",
            whiteSpace: "nowrap",
            ...(tailActive && tailOverflow ? THINKING_TAIL_FADE_MASK_STYLE : null),
          }}
        >
          {expanded
            ? t("i18n.thinking")
            : tailActive && tailShown
              ? <ReactMarkdown allowedElements={[]} unwrapDisallowed skipHtml>{tailShown}</ReactMarkdown>
              : (preview ? <ReactMarkdown allowedElements={[]} unwrapDisallowed skipHtml>{preview}</ReactMarkdown> : "...")}
        </span>
        {duration !== undefined && (
          <span style={{ flexShrink: 0, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{duration}s</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>
      {expanded && (
        <div
          // Message-smart extension thinking-row click contract: mark data-thinking-content so
          // the thinking text is recognizable by the extension's click handler (the new thinking
          // UI doesn't go through MarkdownBody, so the host's paragraph-click broadcast can't
          // reach it → the extension implements its own pre-row click handling)
          data-thinking-content=""
          style={{
            minWidth: 0,
            padding: "4px 10px",
            borderTop: "1px solid var(--border)",
            color: error ? "#f87171" : "var(--text-muted)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
           {loading ? t("i18n.loadingThinking") : error ?? (block.deferred ? content : block.thinking)}
        </div>
      )}
    </div>
  );
}

function isSubagentToolDetails(value: unknown): value is SubagentToolDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as Partial<SubagentToolDetails>;
  return details.kind === "pi-web-subagent" && typeof details.sessionId === "string";
}

/** A duration pi recorded on a message, or undefined when there is none to trust. */
function recordedDurationMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Below this a tool card shows no time: it would read 0.0s on every quick read or search. */
const TOOL_DURATION_MIN_MS = 100;

/** A tool's run time as the pi CLI's "Took" writes it: 2.4s, then 3m 5s, then 1h 2m 5s. */
export function formatToolDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

function ToolCallBlock({ block, result, duration, onOpenSubagent }: { block: ToolCallContent; result?: ToolResultMessage; duration?: number; onOpenSubagent?: (sessionId: string, label: string) => void }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(() => isToolCallExpanded(block.toolCallId));
  const toggleExpanded = () => {
    const next = !expanded;
    setToolCallExpanded(block.toolCallId, next);
    setExpanded(next);
  };
  const writtenFileText = getWrittenFileText(block);
  const inputStr = writtenFileText ?? getToolCallInputText(block);
  const isStreamingInput = block.rawInput !== undefined;
  const isEditTool = isEditToolName(block.toolName);
  const resultDiff = result && !result.isError ? getResultDiff(result) : null;
  const patchFiles = getApplyPatchFiles(block, result);
  const patchLabel = isApplyPatchToolName(block.toolName)
    ? summarizeApplyPatchInput(block)
    : null;
  // A script and the calls it made, instead of the input JSON. Streamed input is
  // still incomplete JSON and keeps the generic view.
  const codemodeCode = block.toolName === CODEMODE_TOOL_NAME && !isStreamingInput ? codemodeScript(block.input) : null;
  const codemode = codemodeCode === null ? null : { code: codemodeCode, ...codemodeCalls(result?.details) };
  // A running script's progress snapshot has calls but no content yet.
  const codemodeRunning = codemode !== null && result !== undefined && result.content.length === 0;

  // Flat arguments as rows instead of a JSON blob, unless the card has a view of
  // its own (a write's file text, codemode, an applied patch). See `lib/tool-fields.ts`.
  const toolFields =
    !isStreamingInput && writtenFileText === null && codemode === null && patchFiles === null
      && !hasInteractionToolView(block.toolName, block.input)
      ? toolFieldsOfInput(block.input)
      : null;

  // `server/tool` instead of the registered `mcp__server__tool`, as pi's TUI shows it.
  const mcpLabel = mcpToolLabel(block.toolName, result?.details);

  // Result display
  const resultContent = result ? (codemode ? stripCodemodeHeader(result.content) : result.content) : [];
  const joinedResultText = result
    ? resultContent.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n")
    : null;
  const resultText = mcpLabel && joinedResultText !== null ? prettyMcpResultText(joinedResultText) : joinedResultText;
  const resultImages = getMessageImages(resultContent);
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = (result?.isError ?? false)
    || (isApplyPatchToolName(block.toolName) && applyPatchResultHasFailures(result?.details));
  const subagent = isSubagentToolDetails(result?.details) ? result.details : null;
  const codemodeCallCount = codemode ? codemode.calls.length + codemode.omitted : 0;

  return (
    <div
      style={{
        borderRadius: 7,
        overflow: "hidden",
        fontSize: 12,
        border: isError ? "1px solid rgba(248,113,113,0.45)" : "1px solid rgba(34,197,94,0.25)",
        background: isError ? "rgba(248,113,113,0.05)" : "rgba(34,197,94,0.04)",
      }}
    >
      {/* ── Tool call header ── */}
      <div style={{ display: "flex", alignItems: "stretch", minWidth: 0 }}>
        <button
          onClick={toggleExpanded}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            flex: 1,
            minWidth: 0,
            padding: "3px 10px",
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
            textAlign: "left",
          }}
        >
          <span
            title={mcpLabel ? block.toolName : undefined}
            style={{ color: isError ? "#f87171" : "#16a34a", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11, flexShrink: 0 }}
          >
            {mcpLabel ? (
              <>
                <span style={{ fontWeight: 500, opacity: 0.75 }}>{mcpLabel.server}/</span>
                {mcpLabel.tool}
              </>
            ) : block.toolName}
          </span>
          <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {isStreamingInput
              ? t("chat.generatingToolInput")
              : (patchLabel ?? (codemode ? codemodeScriptPreview(codemode.code) : getToolPreview(block, t)))}
          </span>
          {codemodeCallCount > 0 && (
            <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
              {codemodeCallCount === 1 ? t("codemode.callCountOne") : t("codemode.callCount", { count: codemodeCallCount })}
            </span>
          )}
          {duration !== undefined && (
            <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{formatToolDuration(duration)}</span>
          )}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>
        {subagent && onOpenSubagent && (
          <button
            type="button"
            onClick={() => onOpenSubagent(subagent.sessionId, subagent.description || subagent.profile)}
            title={t("subagent.openTab")}
            aria-label={t("subagent.openTab")}
            style={{ width: 32, display: "grid", placeItems: "center", border: "none", borderLeft: "1px solid var(--border)", background: "none", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" /></svg>
          </button>
        )}
      </div>

      {/* ── Expanded: input args (only when no richer view exists); a codemode script in place of its JSON ── */}
      {expanded && (isStreamingInput || !isEditTool) && !patchFiles && (
        toolFields ? (
          <div
            style={{
              padding: "6px 10px 8px",
              background: "var(--bg-subtle)",
              borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)",
            }}
          >
            <ToolFieldRows fields={toolFields} />
          </div>
        ) : (
          <pre
            style={{
              margin: 0,
              padding: "8px 10px",
              color: "var(--text-muted)",
              fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
              lineHeight: 1.5,
              overflow: "auto",
              background: "var(--bg-subtle)",
              borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {codemode ? codemode.code.replace(/\r/g, "").trimEnd() : inputStr}
          </pre>
        )
      )}
      {expanded && !isStreamingInput && !isEditTool && !codemode && hasInteractionToolView(block.toolName, block.input) && (
        <InteractionToolCallDetails toolName={block.toolName} input={block.input} fallback={inputStr} isError={isError} />
      )}

      {/* ── Expanded: the calls a codemode script made ── */}
      {expanded && codemode && (
        <CodemodeCallList calls={codemode.calls} omitted={codemode.omitted} isError={isError} />
      )}

      {/* ── Result images — always visible, independent of the collapsed details ── */}
      {resultImages.length > 0 && <ResultImages images={resultImages} isError={isError} />}

      {/* ── Expanded: applied-patch split diff ── */}
      {expanded && patchFiles && (
        <div style={{ borderTop: "1px solid rgba(34,197,94,0.15)", background: "var(--bg)" }}>
          <SplitFilesView files={patchFiles} />
        </div>
      )}

      {/* ── Paired result — only shown when expanded ── */}
      {expanded && result && patchFiles && isError && (
        <PairedResult
          text={resultText ?? ""}
          isEmpty={resultIsEmpty}
          isError={isError}
        />
      )}
      {expanded && result && !patchFiles && !codemodeRunning && (
        resultDiff ? (
          <PairedDiffResult
            diff={resultDiff}
          />
        ) : (!resultIsEmpty || resultImages.length === 0) && (
          <PairedResult
            text={resultText ?? ""}
            isEmpty={resultIsEmpty}
            isError={isError}
          />
        )
      )}
    </div>
  );
}

interface ResultDiff {
  text: string;
}

function PairedDiffResult({ diff }: {
  diff: ResultDiff;
}) {
  return (
    <div
      style={{
        borderTop: "1px solid rgba(34,197,94,0.15)",
        background: "var(--bg)",
      }}
    >
      <SplitPatchView text={diff.text} />
    </div>
  );
}

function SplitPatchView({ text }: { text: string }) {
  const files = useMemo(() => parseUnifiedPatch(text), [text]);
  if (!files) return <PatchTextView text={text} />;
  return <SplitFilesView files={files} />;
}

/** Two code columns side by side, or one column of patch lines. */
export type PatchDiffLayout = "split" | "stacked";

/**
 * The patch as the viewport can show it. Two columns need two code columns side
 * by side, which a phone does not have: there the same rows read as one column
 * — a removed line above the line that replaces it, each with its own number —
 * the way the file viewer's diff has always been drawn. See `unifiedDiffLines()`.
 */
function SplitFilesView({ files }: { files: SplitDiffFile[] }) {
  const layout: PatchDiffLayout = useIsMobile() ? "stacked" : "split";
  return <PatchDiffFiles files={files} layout={layout} />;
}

export function PatchDiffFiles({ files, layout }: { files: SplitDiffFile[]; layout: PatchDiffLayout }) {
  const { t } = useI18n();
  const showFileHeaders = files.length > 1;

  return (
    <div style={{ maxHeight: 560, overflowY: "auto", overflowX: "hidden", background: "var(--bg)" }}>
      {files.map((file, fileIndex) => (
        <div
          key={fileIndex}
          style={{
            minWidth: 0,
            borderTop: fileIndex === 0 ? "none" : "1px solid var(--border)",
            fontFamily: "var(--font-mono)",
            fontWeight: "var(--font-mono-weight)",
            fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.45,
          }}
        >
          {showFileHeaders && layout === "split" && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
              }}
            >
               <SplitDiffHeader title={file.oldPath || t("i18n.before")} side="left" />
               <SplitDiffHeader title={file.newPath || t("i18n.after")} side="right" />
            </div>
          )}

          {showFileHeaders && layout === "stacked" && stackedFilePath(file) && (
            <div
              title={stackedFilePath(file)}
              style={{
                position: "sticky",
                top: 0,
                zIndex: 1,
                padding: "5px 10px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {stackedFilePath(file)}
            </div>
          )}

          {layout === "split" && (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            {file.rows.map((row, rowIndex) => {
              if (row.type === "hunk") {
                return null;
              }
              if (row.type === "gap") {
                return <DiffGapRow key={rowIndex} gap={row} />;
              }

              return (
                <div key={rowIndex} style={{ display: "contents" }}>
                  <SplitDiffCellView cell={row.left} side="left" />
                  <SplitDiffCellView cell={row.right} side="right" />
                </div>
              );
            })}
          </div>
          )}

          {layout === "stacked" && unifiedDiffLines(file).map((line, lineIndex) => (
            line.type === "gap"
              ? <DiffGapRow key={lineIndex} gap={line} />
              : <StackedDiffLineView key={lineIndex} line={line} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Unchanged lines the patch leaves out between two hunks, across the whole width. */
function DiffGapRow({ gap }: { gap: SplitDiffGap }) {
  const { t } = useI18n();
  return (
    <div
      style={{
        gridColumn: "1 / -1",
        padding: "0 10px",
        color: "var(--text-dim)",
        background: "var(--bg-panel)",
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        userSelect: "none",
      }}
    >
      {gap.count === null ? "⋯" : `⋯ ${diffGapLabel(gap.count, t)}`}
    </div>
  );
}

/** The file a stacked section is named for: the new path, the one that survives, unless the file was deleted. */
function stackedFilePath(file: SplitDiffFile): string {
  if (file.newPath && file.newPath !== "/dev/null") return file.newPath;
  return file.oldPath || file.newPath || "";
}

function StackedDiffLineView({ line }: { line: UnifiedDiffLine }) {
  return (
    <SplitDiffCellView
      side="right"
      cell={{
        // One gutter, so a removed line keeps the old number and everything else the new one.
        lineNo: line.type === "removed" ? line.oldLineNo : line.newLineNo,
        text: line.text,
        type: line.type,
      }}
    />
  );
}

function SplitDiffHeader({ title, side }: { title: string; side: "left" | "right" }) {
  return (
    <div
      title={title}
      style={{
        padding: "5px 10px",
        color: "var(--text-dim)",
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {title}
    </div>
  );
}

function SplitDiffCellView({ cell, side }: { cell: SplitDiffCell; side: "left" | "right" }) {
  const bg =
    cell.type === "added"
      ? "rgba(34,197,94,0.12)"
      : cell.type === "removed"
      ? "rgba(248,113,113,0.13)"
      : cell.type === "empty"
      ? "var(--bg-subtle)"
      : "transparent";
  const marker =
    cell.type === "added" ? "+" : cell.type === "removed" ? "-" : " ";
  const markerColor =
    cell.type === "added" ? "#22c55e" : cell.type === "removed" ? "#f87171" : "var(--text-dim)";

  return (
    <div
      // Message-smart extension clicked-row quote contract: mark data-diff-line so the cell is
      // recognizable by the extension's click handler (SplitPatchView is a div/span grid, not a
      // <pre>; without this mark the pre-row click handler never sees it)
      data-diff-line=""
      style={{
        display: "flex",
        minWidth: 0,
        background: bg,
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
      }}
    >
      <span
        style={{
          width: 42,
          padding: "0 6px",
          textAlign: "right",
          color: "var(--text-dim)",
          userSelect: "none",
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {cell.lineNo ?? ""}
      </span>
      <span
        style={{
          width: 18,
          padding: "0 5px",
          color: markerColor,
          userSelect: "none",
          fontWeight: cell.type === "context" || cell.type === "empty" ? 400 : 700,
          flexShrink: 0,
        }}
      >
        {marker}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          padding: "0 10px 0 0",
          color: cell.type === "empty" ? "var(--text-dim)" : "var(--text)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {cell.text || "\u00a0"}
      </span>
    </div>
  );
}

function PatchTextView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);

  return (
    <div style={{ maxHeight: 520, overflowY: "auto", overflowX: "hidden", fontFamily: "var(--font-mono)", fontWeight: "var(--font-mono-weight)", fontSize: "calc(12px + var(--chat-font-size-offset, 0px))", lineHeight: 1.45, minWidth: 0 }}>
      {lines.map((line, i) => {
        const kind =
          line.startsWith("@@") ? "hunk" :
          line.startsWith("+") && !line.startsWith("+++") ? "added" :
          line.startsWith("-") && !line.startsWith("---") ? "removed" :
          "context";
        const bg =
          kind === "added" ? "rgba(34,197,94,0.12)" :
          kind === "removed" ? "rgba(248,113,113,0.13)" :
          kind === "hunk" ? "rgba(96,165,250,0.12)" :
          "transparent";
        const color =
          kind === "added" ? "#22c55e" :
          kind === "removed" ? "#f87171" :
          kind === "hunk" ? "var(--accent)" :
          "var(--text)";

        return (
          <div
            key={i}
            style={{
              display: "flex",
              background: bg,
              borderLeft: kind === "added"
                ? "3px solid #22c55e"
                : kind === "removed"
                ? "3px solid #f87171"
                : kind === "hunk"
                ? "3px solid var(--accent)"
                : "3px solid transparent",
            }}
          >
            <span
              style={{
                width: 48,
                padding: "0 8px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                borderRight: "1px solid var(--border)",
                textAlign: "right",
                userSelect: "none",
                flexShrink: 0,
              }}
            >
              {i + 1}
            </span>
            <span style={{ padding: "0 10px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color }}>
              {line || "\u00a0"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Split diff rows for an apply_patch-style tool call.
 *
 * Prefers parsing the V4A patch document from the call input. The extension's
 * applied result preview contains the complete old/new file with unchanged
 * lines, so it is only used as a fallback when the call input is unavailable.
 * A single call may contain several file operations — each becomes its own
 * file section.
 *
 * When the extension reports per-file failures on a normal result (`failures`
 * on `details.result`, not `isError`), the failed files did not land, so they
 * must not render as an applied diff. In that case the preview (which only
 * contains actually-applied files) is preferred, and the input parse excludes
 * the failed paths when no preview exists.
 */
function getApplyPatchFiles(block: ToolCallContent, result?: ToolResultMessage): SplitDiffFile[] | null {
  if (!isApplyPatchToolName(block.toolName)) return null;

  const details = result && !result.isError ? (result as ToolResultMessage & { details?: unknown }).details : undefined;

  if (isRecord(details) && applyPatchResultHasFailures(details)) {
    const fromPreview = applyPatchPreviewToFiles(details.preview);
    if (fromPreview) return fromPreview;

    const failedPaths = new Set(getApplyPatchFailurePaths(details));
    if (failedPaths.size > 0) {
      const fromInput = parseApplyPatchInput(getApplyPatchInputText(block.input, block.rawInput));
      if (fromInput) {
        const kept = fromInput.filter((file) => {
          // A failed path may be reported as either the move source or the destination; check both sides.
          const failed =
            (file.newPath !== undefined && failedPaths.has(file.newPath)) ||
            (file.oldPath !== undefined && failedPaths.has(file.oldPath));
          return !failed;
        });
        if (kept.length > 0) return kept;
      }
    }
    return null;
  }

  const fromInput = parseApplyPatchInput(getApplyPatchInputText(block.input, block.rawInput));
  if (fromInput) return fromInput;

  if (isRecord(details)) {
    const fromPreview = applyPatchPreviewToFiles(details.preview);
    if (fromPreview) return fromPreview;
  }

  return null;
}

/** Header label listing the files targeted by an apply_patch call. */
function summarizeApplyPatchInput(block: ToolCallContent): string | null {
  const paths = extractApplyPatchPaths(getApplyPatchInputText(block.input, block.rawInput));
  if (paths.length === 0) return null;
  return paths.join(", ").slice(0, 120);
}

function getResultDiff(result: ToolResultMessage): ResultDiff | null {
  const details = (result as ToolResultMessage & { details?: unknown }).details;
  if (!isRecord(details)) return null;

  const patch = typeof details.patch === "string" ? details.patch : null;
  if (patch) return { text: patch };

  const diff = typeof details.diff === "string" ? details.diff : null;
  if (diff) return { text: diff };

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ResultImages({ images, isError }: { images: ImageContent[]; isError: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        padding: "10px",
        background: "var(--bg)",
        borderTop: `1px solid ${isError ? "rgba(248,113,113,0.3)" : "rgba(34,197,94,0.15)"}`,
      }}
    >
      {images.map((image, index) => {
        const src = imageSource(image);
        if (!src) return null;
        return (
          <ImagePreview
            key={`${src}-${index}`}
            src={src}
            style={{ maxWidth: "100%" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt=""
              loading="lazy"
              style={{
                display: "block",
                maxWidth: "min(100%, 720px)",
                maxHeight: 520,
                borderRadius: 6,
                objectFit: "contain",
                border: "1px solid var(--border)",
              }}
            />
          </ImagePreview>
        );
      })}
    </div>
  );
}

function PairedResult({ text, isEmpty, isError }: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        borderTop: `1px solid ${isError ? "rgba(248,113,113,0.3)" : "rgba(34,197,94,0.15)"}`,
        background: isError ? "rgba(248,113,113,0.04)" : "var(--bg-subtle)",
      }}
    >
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          color: isError ? "#f87171" : (isEmpty ? "var(--text-dim)" : "var(--text-muted)"),
          fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
          lineHeight: 1.5,
          overflow: "auto",
          maxHeight: 400,
          background: "var(--bg)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          fontStyle: isEmpty ? "italic" : "normal",
          opacity: isEmpty ? 0.6 : 1,
        }}
      >
        {isEmpty ? t("i18n.noOutput") : text}
      </pre>
    </div>
  );
}

function CompactionMessageView({ message }: { message: CustomMessage }) {
  const { t } = useI18n();
  // Collapsed by default, as in pi's TUI: a summary can run to pages.
  const [expanded, setExpanded] = useState(false);
  const summary = getMessageText(message.content);
  const time = formatTime(message.timestamp);
  const tokensBefore = (message.details as { tokensBefore?: unknown } | undefined)?.tokensBefore;

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            compaction
          </span>
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        <div style={{ padding: "11px 13px 12px" }}>
          <button
            type="button"
            aria-expanded={expanded}
            title={expanded ? t("i18n.collapse") : t("i18n.expand")}
            onClick={() => setExpanded((v) => !v)}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              width: "100%",
              padding: 0,
              border: "none",
              background: "transparent",
              color: "var(--text)",
              cursor: "pointer",
              font: "inherit",
              textAlign: "left",
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, marginTop: 4, color: "var(--text-muted)", transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
              <polyline points="4 2.5 7.5 6 4 9.5" />
            </svg>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: "calc(15px + var(--chat-font-size-offset, 0px))", fontWeight: 700, lineHeight: 1.35 }}>
                {t("i18n.conversationCompacted")}
              </span>
              {typeof tokensBefore === "number" && Number.isFinite(tokensBefore) && (
                <span style={{ display: "block", marginTop: 3, color: "var(--text-muted)", fontSize: "calc(13px + var(--chat-font-size-offset, 0px))", lineHeight: 1.5 }}>
                  {t("i18n.compactedFromTokens", { tokens: tokensBefore.toLocaleString() })}
                </span>
              )}
            </span>
          </button>
          {expanded && <CompactionSummaryDetails summary={summary} />}
        </div>
      </div>
    </div>
  );
}

export function CompactionSummaryDetails({ summary }: { summary: string }) {
  const { t } = useI18n();
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary]);

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ marginBottom: 10, color: "var(--text)", fontSize: "calc(14px + var(--chat-font-size-offset, 0px))", lineHeight: 1.5 }}>
         {t("i18n.compactionDescription")}
      </div>
      {parsedSummary.body ? (
        <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
      ) : (
         <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("i18n.noSummary")}</span>
      )}
      <CompactionFileMetadata readFiles={parsedSummary.readFiles} modifiedFiles={parsedSummary.modifiedFiles} />
    </div>
  );
}

function CompactionFileMetadata({ readFiles, modifiedFiles }: { readFiles: string[]; modifiedFiles: string[] }) {
  const { t } = useI18n();
  const total = readFiles.length + modifiedFiles.length;
  if (total === 0) return null;

  const parts = [];
  if (readFiles.length > 0) parts.push(`${readFiles.length} read`);
  if (modifiedFiles.length > 0) parts.push(`${modifiedFiles.length} modified`);

  return (
    <details className="compaction-file-details">
       <summary>{t("i18n.fileContext", { details: parts.join(", ") })}</summary>
       {modifiedFiles.length > 0 && <CompactionFileList title={t("i18n.modifiedFiles")} files={modifiedFiles} />}
       {readFiles.length > 0 && <CompactionFileList title={t("i18n.readFiles")} files={readFiles} />}
    </details>
  );
}

function CompactionFileList({ title, files }: { title: string; files: string[] }) {
  return (
    <div className="compaction-file-section">
      <div className="compaction-file-title">{title}</div>
      <ul className="compaction-file-list">
        {files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </div>
  );
}

function CustomMessageView({ message, cwd, onOpenFile }: { message: CustomMessage; cwd?: string; onOpenFile?: (filePath: string, page?: number) => void }) {
  const { t } = useI18n();
  // Expanded by default: pi's TUI always draws a displayed custom message in full.
  const [contentExpanded, setContentExpanded] = useState(true);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = getMessageText(message.content);
  const images = getMessageImages(message.content);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const title = formatCustomType(message.customType);
  const time = formatTime(message.timestamp);

  const copyContent = () => {
    copyText(text || detailsText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: contentExpanded ? "1px solid var(--border)" : "none",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <button
            type="button"
            onClick={() => setContentExpanded((v) => !v)}
            aria-expanded={contentExpanded}
            title={contentExpanded ? t("i18n.collapse") : t("i18n.expand")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 0,
              flex: 1,
              padding: 0,
              border: "none",
              background: "none",
              color: "inherit",
              cursor: "pointer",
              fontSize: "inherit",
              textAlign: "left",
            }}
          >
            <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650, flexShrink: 0 }}>
              {title}
            </span>
            {!contentExpanded && text && (
              <span style={{ color: "var(--text-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {text.slice(0, 300).replace(/\s+/g, " ").trim()}
              </span>
            )}
            {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{time}</span>}
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, transform: contentExpanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
              <polyline points="2 3.5 5 6.5 8 3.5" />
            </svg>
          </button>
        </div>

        {contentExpanded && (
          <>
            <div style={{ padding: "6px 9px" }}>
              {images.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: text ? 8 : 0 }}>
                  {images.map((img, i) => {
                    const src = imageSource(img);
                    if (!src) return null;
                    return (
                      <ImagePreview key={i} src={src}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={src}
                          alt=""
                          style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
                        />
                      </ImagePreview>
                    );
                  })}
                </div>
              )}
              {text ? <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>{text}</MarkdownBody> : <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("i18n.noMessage")}</span>}
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 9px",
                borderTop: "1px solid var(--border)",
                background: "var(--bg-subtle)",
              }}
            >
              {text || detailsText ? (
                <button
                  onClick={copyContent}
                  style={{
                    padding: "3px 7px",
                    border: "none",
                    background: "none",
                    color: copied ? "var(--accent)" : "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                   {copied ? t("i18n.copied") : t("i18n.copy")}
                </button>
              ) : null}
              {hasDetails && (
                <button
                  onClick={() => setDetailsExpanded((v) => !v)}
                  style={{
                    marginLeft: "auto",
                    padding: "3px 7px",
                    border: "none",
                    background: "none",
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  {detailsExpanded ? t("i18n.hideDetails") : t("i18n.showDetails")}
                </button>
              )}
            </div>

            {hasDetails && detailsExpanded && (
              <pre
                style={{
                  margin: 0,
                  padding: "9px 10px",
                  borderTop: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text-muted)",
                  fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: 360,
                  overflow: "auto",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {detailsText}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function getMessageImages(content: CustomMessage["content"] | UserMessage["content"]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ImageContent => b.type === "image");
}

function imageSource(img: ImageContent): string {
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    return img.source.type === "base64"
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : img.source.url ?? "";
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getToolCallInputText(block: ToolCallContent): string {
  return block.rawInput ?? JSON.stringify(block.input, null, 2);
}

/**
 * Expanded body for interaction-primitive tools (adapted for zcode ExitPlanMode /
 * AskUserQuestion; identical shape for history replay):
 *   - ExitPlanMode: input.plan rendered as markdown (the full plan is readable, no longer buried
 *     in raw JSON)
 *   - AskUserQuestion: input.questions shown grouped by question with options (label + description)
 *   - other tools: JSON fallback (as-is)
 */
/** Fork interaction tools with a bespoke expanded view (upstream's flat-row table would
 *  downgrade them — ExitPlanMode's plan loses its markdown, AskUserQuestion its structure). */
function hasInteractionToolView(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "ExitPlanMode") return typeof input.plan === "string" && !!input.plan.trim();
  if (toolName === "AskUserQuestion") return Array.isArray(input.questions) && input.questions.length > 0;
  return false;
}

function InteractionToolCallDetails({ toolName, input, fallback, isError }: {
  toolName: string;
  input: Record<string, unknown>;
  fallback: string;
  isError: boolean;
}) {
  const { t } = useI18n();
  const preStyle: React.CSSProperties = {
    margin: 0,
    padding: "3px 10px",
    color: "var(--text-muted)",
    fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
    lineHeight: 1.4,
    overflow: "auto",
    background: "var(--bg-subtle)",
    borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  };

  if (toolName === "ExitPlanMode" && typeof input.plan === "string" && input.plan.trim()) {
    return (
      <div style={{ background: "var(--bg-subtle)", borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)", padding: "6px 12px" }}>
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 4, fontFamily: "var(--font-mono)" }}>PLAN</div>
        <SafeMarkdownBody className="text-[13px]">{input.plan}</SafeMarkdownBody>
      </div>
    );
  }

  if (toolName === "AskUserQuestion" && Array.isArray(input.questions) && input.questions.length > 0) {
    return (
      <div style={{ background: "var(--bg-subtle)", borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)", padding: "6px 12px" }}>
        {(input.questions as Array<Record<string, unknown>>).map((q, qi) => {
          if (!q || typeof q.question !== "string") return null;
          const options = Array.isArray(q.options) ? q.options as Array<Record<string, unknown>> : [];
          return (
            <div key={qi} style={{ marginBottom: options.length > 0 ? 8 : 0 }}>
              <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 4 }}>
                {typeof q.header === "string" && q.header && (
                  <span style={{ color: "var(--text-dim)", marginRight: 6 }}>[{q.header}]</span>
                )}
                {q.question}
                {q.multiSelect === true && <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: 6 }}>{t("chat.multiSelect")}</span>}
              </div>
              {options.map((o, oi) =>
                typeof o?.label === "string" ? (
                  <div key={oi} style={{ fontSize: 12, color: "var(--text-muted)", padding: "1px 0 1px 14px" }}>
                    <span style={{ marginRight: 6 }}>◯</span>
                    <span style={{ fontWeight: 600, color: "var(--text)" }}>{o.label}</span>
                    {typeof o.description === "string" && (
                      <span style={{ marginLeft: 8, fontSize: 11 }}>{o.description}</span>
                    )}
                  </div>
                ) : null,
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return <pre style={preStyle}>{fallback}</pre>;
}

const WRITE_VIEW_KEYS = new Set(["path", "file_path", "content"]);

// A write's file text in place of its JSON: the header already shows the path.
// Streamed input is still incomplete JSON, and any other argument (a mode, a
// title) would vanish from this view, so those calls, and an empty file, keep
// the generic view.
function getWrittenFileText(block: ToolCallContent): string | null {
  if (block.rawInput !== undefined || !isWriteToolName(block.toolName)) return null;
  const { content } = block.input;
  if (typeof content !== "string" || content === "") return null;
  return Object.keys(block.input).every((key) => WRITE_VIEW_KEYS.has(key)) ? content : null;
}

const TOOL_FIELD_LABEL: CSSProperties = {
  padding: "4px 12px 4px 0",
  color: "var(--text-dim)",
  fontSize: "calc(11px + var(--chat-font-size-offset, 0px))",
  whiteSpace: "nowrap",
  verticalAlign: "top",
};

const TOOL_FIELD_VALUE: CSSProperties = {
  padding: "4px 0",
  color: "var(--text-muted)",
  fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
  fontFamily: "var(--font-mono)",
  overflowWrap: "anywhere",
};

// A value with newlines of its own keeps them, scrolled in place.
const TOOL_FIELD_BLOCK: CSSProperties = {
  margin: 0,
  padding: "8px 10px",
  maxHeight: 260,
  overflow: "auto",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  font: "inherit",
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
};

function ToolFieldRows({ fields }: { fields: ToolField[] }) {
  return (
    <table style={{ borderCollapse: "collapse" }}>
      <tbody>
        {fields.map((field) => (
          <tr key={field.key}>
            <td style={TOOL_FIELD_LABEL}>{field.key}</td>
            <td style={TOOL_FIELD_VALUE}>
              {field.multiline ? <pre style={TOOL_FIELD_BLOCK}>{field.value}</pre> : field.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatCustomType(type: string): string {
  return type || "extension";
}


function getToolPreview(block: ToolCallContent, t: Translate): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if (block.toolName === "ExitPlanMode") return input.plan ? t("chat.submitPlan") : t("chat.exitPlan");
  if (block.toolName === "AskUserQuestion") {
    const qs = Array.isArray(input.questions) ? input.questions as Array<Record<string, unknown>> : [];
    const firstQ = qs.find((q) => typeof q?.question === "string")?.question as string | undefined;
    return firstQ ? firstQ.slice(0, 120) : t("chat.askUser");
  }
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

function formatUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}): string {
  const parts = [];
  if (usage.input) parts.push(`${usage.input.toLocaleString()} in`);
  if (usage.output) parts.push(`${usage.output.toLocaleString()} out`);
  if (usage.cacheRead) parts.push(`${usage.cacheRead.toLocaleString()} cache R`);
  if (usage.cacheWrite) parts.push(`${usage.cacheWrite.toLocaleString()} cache W`);
  if (usage.cost?.total) parts.push(fmtMoney(usage.cost.total, 4));
  return parts.join(" · ");
}

function BashExecutionView({ message, sessionId }: { message: BashExecutionMessage; sessionId?: string }) {
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const isPending = !message.output && message.exitCode === undefined && !message.cancelled;
  const isError = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
  // The path goes in the POST body, not the URL (keeps it out of access/proxy logs)
  const canFetchFullOutput = Boolean(sessionId && message.fullOutputPath);
  const showFullButton = message.truncated && canFetchFullOutput && fullOutput === null;
  const displayOutput = fullOutput ?? message.output;

  async function fetchFullOutput(download: boolean): Promise<Response | null> {
    if (!sessionId || !message.fullOutputPath) return null;
    setLoadingFull(true);
    try {
      return await fetch(apiUrl(`/api/agent/${encodeURIComponent(sessionId)}/bash-output`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: message.fullOutputPath, download }),
      });
    } finally {
      setLoadingFull(false);
    }
  }

  async function loadFullOutput() {
    if (!canFetchFullOutput) return;
    setFullError(null);
    try {
      const res = await fetchFullOutput(false);
      if (!res) return;
      const d = await res.json() as { success?: boolean; data?: { output?: string }; error?: string };
      if (d.success) {
        setFullOutput(d.data?.output ?? "");
      } else {
        setFullError(d.error ?? "failed");
      }
    } catch (e) {
      setFullError(String(e));
    }
  }

  async function downloadFullOutput() {
    if (!canFetchFullOutput || downloading) return;
    setFullError(null);
    setDownloading(true);
    try {
      const res = await fetchFullOutput(true);
      if (!res || !res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "bash-output.log";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setFullError(String(e));
    } finally {
      setDownloading(false);
    }
  }

  // Reuse the existing ToolCallBlock so user-run bash looks identical to an
  // agent-run bash tool call: same header, collapse behavior, result pane.
  // Synthesize an equivalent ToolCallContent + ToolResultMessage pair.
  const toolName = message.excludeFromContext ? "bash (local)" : "bash";
  const block: ToolCallContent = {
    type: "toolCall",
    toolCallId: `bash-${message.timestamp ?? ""}`,
    toolName,
    input: { command: message.command },
  };
  const result: ToolResultMessage | undefined = isPending
    ? undefined
    : {
        role: "toolResult",
        toolCallId: block.toolCallId,
        toolName,
        content: displayOutput ? [{ type: "text", text: displayOutput }] : [],
        isError,
        timestamp: message.timestamp,
      };

  return (
    <div style={{ margin: "6px 0" }}>
      <ToolCallBlock block={block} result={result} />
      {message.truncated && canFetchFullOutput && (
        <div style={{ padding: "4px 10px", fontSize: 11, marginTop: -1 }}>
          {showFullButton && (
            <button
              onClick={loadFullOutput}
              disabled={loadingFull}
              style={{ background: "none", border: "none", color: "var(--accent)", cursor: loadingFull ? "default" : "pointer", fontSize: 11, padding: 0, textDecoration: "underline" }}
            >
              {loadingFull ? "loading…" : "view full output"}
            </button>
          )}
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); void downloadFullOutput(); }}
            style={{ marginLeft: showFullButton ? 10 : 0, color: "var(--accent)", fontSize: 11, textDecoration: "underline", cursor: downloading ? "default" : "pointer" }}
          >
            {downloading ? "downloading…" : "download full output"}
          </a>
          {fullError && <span style={{ marginLeft: 6, color: "var(--text-dim)", fontSize: 11 }}>({fullError})</span>}
        </div>
      )}
    </div>
  );
}

"use client";

import React, { useRef, useState, useCallback, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, KeyboardEvent } from "react";
import type { BuiltinSlashCommandResult, CompactResultInfo, QueuedMessages, SlashCommandInfo } from "@/hooks/useAgentSession";
import type { QueueEntry, QueueEntryInput, QueueTrashItem } from "@/lib/queue-store";
import { downloadQueueExport, parseQueueImport } from "@/lib/queue-export";
import type { SkillsResponse } from "@/lib/api-types";
import type { TextContent, UserMessage } from "@/lib/types";
import {
  clearDraft,
  flushAllDrafts,
  getDraft,
  mergeRestoredSubmissionDraft,
  mergeRestoredSubmissionText,
  rekeyDraft as rekeyStoredDraft,
  setDraft,
  type ChatDraft,
  type ChatDraftImage,
} from "@/lib/draft-store";
import { apiUrl } from "@/lib/base-path";
import { useChatHooks, ExtSlot, registerChatSend } from "@/components/ExtSlots";

import {
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "@/lib/image-attachments";
import {
  buildEntriesFromFiles, buildAtInsertText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";
import type { ToolPreset } from "@/lib/tool-presets";

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

interface Props {
  onSend: (message: string, images?: AttachedImage[]) => void;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => void;
  /** Send a queued follow-up as a steer (interrupt now). Available even when idle. */
  onQueueSteerSend?: (message: string) => void;
  /** 显示「继续」按钮：AI 完全停止（无任何 streaming）且输入框为空时出现。 */
  canContinue?: boolean;
  /** 点「继续」：发送一条“继续”消息，触发 agent 继续运行。 */
  onContinue?: () => void;
  /** Convert a queued message's kind (steer ↔ follow-up) without dispatching it. */
  onConvertQueueItem?: (kind: "steer" | "followUp", index: number, targetKind: "steer" | "followUp") => Promise<boolean>;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => void;
  isStreaming: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string }[];
  modelError?: string | null;
  /** Diagnostics from resolving `enabledModels`, e.g. a pattern that matched nothing. */
  modelScopeWarnings?: string[];
  onModelChange?: (provider: string, modelId: string) => void;
  modelSwitching?: boolean;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  compactResult?: CompactResultInfo | null;
  /** Manual compaction was queued while the agent was running. */
  compactQueued?: boolean;
  onCancelCompactQueue?: () => void;
  /** A model switch was made mid-run; applies next turn. Switching back to the
   *  current run's model cancels it (null). */
  modelSwitchPending?: { provider: string; modelId: string } | null;
  toolPreset?: ToolPreset;
  onToolPresetChange?: (preset: ToolPreset) => void;
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  queuedMessages?: QueuedMessages | null;
  inputHistory?: string[];
  onRecallQueue?: () => void;
  /** Fetch full queue entries (live + recovery) for export. */
  onExportQueue?: () => Promise<{ live: QueueEntry[]; recovery: QueueEntry[] } | null>;
  /** Re-queue entries parsed from an imported .json file. Returns count. */
  onImportQueue?: (entries: QueueEntryInput[]) => Promise<number | null>;
  /** Stage imported entries as pending recovery (pops the recovery dialog). */
  onStageImport?: (entries: QueueEntryInput[]) => Promise<number | null>;
  /** Move a queued message within its queue (clear + re-enqueue). */
  onMoveQueue?: (kind: "steer" | "followUp", fromIndex: number, toIndex: number) => Promise<boolean>;
  /** Pull one queued message back to the input box; returns its text + images. */
  onRecallOne?: (kind: "steer" | "followUp", index: number) => Promise<{ text: string; images?: ChatDraftImage[] } | null>;
  /** Insert an edited message back into the queue at its original position. */
  onRequeueAt?: (kind: "steer" | "followUp", index: number, text: string, images?: ChatDraftImage[]) => Promise<boolean>;
  /**
   * Remove a single queued message (soft delete — entry moves to the trash).
   * Returns the removed entry view (null on failure) so the UI can offer an
   * undo toast. `permanent: true` skips the trash (dispatch paths).
   */
  onRemoveQueueItem?: (kind: "steer" | "followUp", index: number, opts?: { permanent?: boolean }) => Promise<QueueTrashItem | null>;
  /** Soft-deleted entries (recoverable from the trash bin). */
  queueTrash?: QueueTrashItem[] | null;
  /** Restore a trashed entry; optional index places it within its kind. */
  onRestoreQueueItem?: (id: string, index?: number) => Promise<boolean>;
  /** Permanently delete trash entries (omit ids to empty the whole trash). */
  onPurgeQueueTrash?: (ids?: string[]) => Promise<boolean>;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  onAudioUnlock?: () => void;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  replaceMessage: (message: UserMessage) => void;
  prependText: (text: string) => void;
  appendText: (text: string) => void;
  addImages: (files: File[]) => void;
  /** Restore an unsent draft (crash recovery) into the input box. */
  restoreDraft: (draft: ChatDraft) => void;
  /** 跑一遍扩展聊天钩子 preSend（[元素N]/[回答N]/[错误N] → 真实内容）；未注册钩子时原样返回。 */
  runChatHooks: (text: string) => string;
  /** True when the input box has text or images (used to tell a live draft from a recoverable one). */
  hasInput: () => boolean;
  /** Force the queue panel to expand (used after recovery/import resolution). */
  expandQueue: () => void;
  rekeyDraft: (previousKey: string, nextKey: string) => void;
  restoreSubmission: (text: string, images?: ChatDraftImage[], targetDraftKey?: string) => void;
}

const TOOL_PRESETS = ["off", "read-only", "default", "full"] as const;
type ToolPresetLabel = typeof TOOL_PRESETS[number];
const TOOL_PRESET_MAP: Record<ToolPresetLabel, ToolPreset> = {
  off: "none",
  "read-only": "read-only",
  default: "default",
  full: "full",
};
const COMPOSITION_END_ENTER_GRACE_MS = 100;
const MODEL_FILTER_THRESHOLD = 8;
const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const ANCHORED_MENU_GAP = 8;

export function getUpwardMenuMaxHeight(menuBottom: number, visibleTop: number, gap = ANCHORED_MENU_GAP): number {
  return Math.max(0, Math.floor(menuBottom - visibleTop - gap));
}

function getVisibleTopBoundary(element: HTMLElement): number {
  let visibleTop = window.visualViewport?.offsetTop ?? 0;

  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden" || overflowY === "clip") {
      visibleTop = Math.max(visibleTop, parent.getBoundingClientRect().top + parent.clientTop);
    }
  }

  return visibleTop;
}

function compareModelOptions(a: ModelOption, b: ModelOption): number {
  return MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId)
    || MODEL_OPTION_COLLATOR.compare(a.provider, b.provider)
    || MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId);
}

export function filterModelOptions(options: ModelOption[], query: string): ModelOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;

  return options.filter((option) => (
    `${option.name} ${option.modelId}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  ));
}

const THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LEVEL_DESC_KEYS: Record<typeof THINKING_LEVELS[number], string> = {
  auto: "chat.thinkingUseDefault", off: "chat.thinkingOff", minimal: "chat.thinkingMinimal", low: "chat.thinkingLow",
  medium: "chat.thinkingMedium", high: "chat.thinkingHigh", xhigh: "chat.thinkingXhigh", max: "chat.thinkingMax",
};

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return tokens.toLocaleString();
}

type SlashCommandPaletteItem = SlashCommandInfo | {
  name: string;
  description: string;
  source: "builtin";
};

type SlashCommandSource = SlashCommandPaletteItem["source"];

const BUILTIN_SLASH_COMMANDS: SlashCommandPaletteItem[] = [
  { name: "compact", description: "chat.commandCompact", source: "builtin" },
  { name: "reload", description: "chat.commandReload", source: "builtin" },
  { name: "name", description: "chat.commandName", source: "builtin" },
  { name: "session", description: "chat.commandSession", source: "builtin" },
  { name: "copy", description: "chat.commandCopy", source: "builtin" },
];

const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "prompt", "skill"];

const SLASH_SOURCE_GROUP_LABEL_KEYS: Record<SlashCommandSource, string> = {
  builtin: "chat.builtIn",
  extension: "chat.extensions",
  prompt: "chat.prompts",
  skill: "chat.skills",
};

const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
};

function slashMatchRank(command: SlashCommandPaletteItem, query: string, t: (key: string) => string): number {
  const name = command.name.toLowerCase();
  const description = getSlashDescription(command, t).toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

function getSlashDescription(command: SlashCommandPaletteItem, t: (key: string) => string): string {
  return command.source === "builtin" ? t(command.description) : command.description ?? "";
}

// Skill slash commands are named "skill:<skillName>"; look the skill up in the
// dormancy map fetched from /api/skills. Unknown skills are treated as active.
function isDormantSkillCommand(command: SlashCommandPaletteItem, dormancy: Record<string, boolean>): boolean {
  if (command.source !== "skill" || !command.name.startsWith("skill:")) return false;
  return dormancy[command.name.slice("skill:".length)] === true;
}

export function buildSlashCommandLayout(
  commands: SlashCommandPaletteItem[],
  dormancy: Record<string, boolean>,
) {
  let index = 0;
  const groups = SLASH_SOURCES
    .map((source) => {
      const sourceCommands = commands.filter((command) => command.source === source);
      const orderedCommands = source === "skill"
        ? [
            ...sourceCommands.filter((command) => !isDormantSkillCommand(command, dormancy)),
            ...sourceCommands.filter((command) => isDormantSkillCommand(command, dormancy)),
          ]
        : sourceCommands;
      return {
        source,
        items: orderedCommands.map((command) => ({ command, index: index++ })),
      };
    })
    .filter((group) => group.items.length > 0);

  return {
    commands: groups.flatMap((group) => group.items.map(({ command }) => command)),
    groups,
  };
}

function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return { data: image.data, mimeType: image.mimeType };
}

function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

function draftImagesToAttachedImages(images: ChatDraftImage[] | undefined): AttachedImage[] {
  return (images ?? [])
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(draftImageToAttachedImage);
}

export function canRestoreUserMessage(
  value: string,
  attachedImageCount: number,
  pendingImageCount: number,
): boolean {
  return !value.trim() && attachedImageCount === 0 && pendingImageCount === 0;
}

export function getUserMessageText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function getUserMessageDraftImages(message: UserMessage): ChatDraftImage[] {
  if (typeof message.content === "string") return [];
  return message.content.flatMap((block) => {
    if (block.type !== "image") return [];

    // Support both the current nested image format and older flat pi-ai entries.
    const flat = block as unknown as { data?: unknown; mimeType?: unknown };
    const data = block.source?.type === "base64" ? block.source.data : flat.data;
    const mimeType = block.source?.type === "base64" ? block.source.media_type : flat.mimeType;
    if (typeof data !== "string" || typeof mimeType !== "string") return [];

    const image = { data, mimeType };
    return isBase64ImageWithinLimits(image) ? [image] : [];
  });
}

function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

function QueuedMessageRow({ kind, text, index, total, onMove, onRecall, onRemove, onSteerSend, onConvertToFollowUp, onDragStart, onDragOver, onDrop, dragging, onTouchMoveTo }: {
  kind: "steer" | "follow-up";
  text: string;
  index: number;
  total: number;
  onMove?: (dir: -1 | 1) => void;
  onRecall?: () => void;
  onRemove?: () => void;
  /** Follow-up rows: dispatch this message as a steer (interrupt now). */
  onSteerSend?: () => void;
  /** Steer rows: convert this message to a follow-up (waits for the next turn). */
  onConvertToFollowUp?: () => void;
  onDragStart?: (index: number) => void;
  onDragOver?: (index: number) => void;
  onDrop?: (targetIndex: number) => void;
  dragging?: boolean;
  /** Touch drag on mobile: move this row to the given target index. */
  onTouchMoveTo?: (targetIndex: number) => void;
}) {
  const { t } = useI18n();
  const canUp = onMove && index > 0;
  const canDown = onMove && index < total - 1;
  // Disable the HTML5 drag source on coarse-pointer (touch) devices: they get
  // the dedicated touch-drag implementation below instead.
  const [isCoarsePointer, setIsCoarsePointer] = useState(false);
  useEffect(() => {
    setIsCoarsePointer(typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches);
  }, []);
  const iconBtn: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    padding: 0,
    border: "none",
    borderRadius: 5,
    background: "transparent",
    color: "var(--text-dim)",
    cursor: "pointer",
    flexShrink: 0,
  };
  // Touch drag state (mobile). touchOverEl is the row currently highlighted as
  // the drop target; styled via direct DOM writes to avoid per-frame re-renders.
  const touchDragRef = useRef<{ y: number; moved: boolean } | null>(null);
  const touchOverElRef = useRef<HTMLElement | null>(null);
  const clearTouchOver = () => {
    if (touchOverElRef.current) {
      touchOverElRef.current.style.background = "";
      touchOverElRef.current.style.borderRadius = "";
      touchOverElRef.current = null;
    }
  };
  const handleTouchStart = (e: React.TouchEvent) => {
    // Buttons are taps, not drags; stop propagation so the bottom-panel swipe
    // gesture (full → queueHidden → minimal) does not fight the row drag.
    if (e.target instanceof Element && e.target.closest("button")) return;
    e.stopPropagation();
    touchDragRef.current = { y: e.touches[0].clientY, moved: false };
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    const d = touchDragRef.current;
    if (!d) return;
    const t = e.touches[0];
    const dy = t.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(dy) < 8) return;
      d.moved = true;
      const el = e.currentTarget as HTMLElement;
      el.style.opacity = "0.45";
      el.style.background = "color-mix(in srgb, var(--accent) 8%, transparent)";
      el.style.borderRadius = "6px";
    }
    // No preventDefault here: React registers touchmove as a passive listener
    // (calling preventDefault would warn and be a no-op). Scrolling is already
    // prevented by touch-action: none on the row.
    e.stopPropagation();
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const row = el?.closest?.("[data-queue-row]");
    if (row && row !== e.currentTarget) {
      const target = row as HTMLElement;
      if (touchOverElRef.current !== target) {
        clearTouchOver();
        touchOverElRef.current = target;
        target.style.background = "color-mix(in srgb, var(--accent) 14%, transparent)";
        target.style.borderRadius = "6px";
      }
    } else if (touchOverElRef.current) {
      clearTouchOver();
    }
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    const d = touchDragRef.current;
    touchDragRef.current = null;
    const rowEl = e.currentTarget as HTMLElement;
    rowEl.style.opacity = "";
    rowEl.style.background = "";
    rowEl.style.borderRadius = "";
    clearTouchOver();
    if (!d?.moved) return;
    e.stopPropagation();
    const el = document.elementFromPoint(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    const row = el?.closest?.("[data-queue-row]") as HTMLElement | null;
    if (!row || row === e.currentTarget) return;
    const to = Number(row.dataset.queueIndex);
    if (!Number.isNaN(to) && to !== index && onTouchMoveTo) onTouchMoveTo(to);
  };
  return (
    <div
      title={text}
      data-queue-row="1"
      data-queue-kind={kind}
      data-queue-index={index}
      draggable={Boolean(onDragStart) && !isCoarsePointer}
      onDragStart={(e) => {
        onDragStart?.(index);
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", String(index)); } catch { /* ignore */ }
      }}
      onDragOver={(e) => {
        if (!onDragOver) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver(index);
      }}
      onDrop={(e) => {
        if (!onDrop) return;
        e.preventDefault();
        onDrop(index);
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "3px 10px",
        fontSize: 12,
        color: "var(--text-muted)",
        minWidth: 0,
        touchAction: "none",
        // Long-press must start the drag, not the browser's native text
        // selection / iOS callout (touchAction alone does not prevent it).
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        cursor: onDragStart && !isCoarsePointer ? "grab" : "default",
        ...(dragging
          ? { opacity: 0.45, background: "color-mix(in srgb, var(--accent) 8%, transparent)", borderRadius: 6 }
          : {}),
      }}
    >
      <span
        style={{
          flexShrink: 0,
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          padding: "1px 7px",
          borderRadius: 999,
          border: `1px solid ${kind === "steer" ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--border)"}`,
          color: kind === "steer" ? "var(--accent)" : "var(--text-dim)",
        }}
      >
        {kind}
      </span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{text}</span>
      {onMove && total > 1 && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
          <button
            title={t("chat.queueMoveUp")}
            aria-label="queueMoveUp"
            disabled={!canUp}
            onClick={() => onMove(-1)}
            style={{ ...iconBtn, cursor: canUp ? "pointer" : "default", opacity: canUp ? 1 : 0.3 }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <button
            title={t("chat.queueMoveDown")}
            aria-label="queueMoveDown"
            disabled={!canDown}
            onClick={() => onMove(1)}
            style={{ ...iconBtn, cursor: canDown ? "pointer" : "default", opacity: canDown ? 1 : 0.3 }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </span>
      )}
      {onSteerSend && kind === "follow-up" && (
        <button
          title={t("chat.queueSteerSend")}
          aria-label="queueSteerSend"
          onClick={onSteerSend}
          style={{ ...iconBtn, color: "rgba(180,130,0,1)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(234,179,8,0.12)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" /><polyline points="12 5 19 12 12 19" />
          </svg>
        </button>
      )}
      {onConvertToFollowUp && kind === "steer" && (
        <button
          title={t("chat.queueToFollowUp")}
          aria-label="queueToFollowUp"
          onClick={onConvertToFollowUp}
          style={{ ...iconBtn, color: "rgba(129,140,248,1)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(129,140,248,0.14)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="8 3 4 7 8 11" />
            <polyline points="16 13 20 17 16 21" />
            <line x1="4" y1="7" x2="20" y2="7" />
            <line x1="20" y1="17" x2="4" y2="17" />
          </svg>
        </button>
      )}
      {onRecall && (
        <button
          title={t("chat.queueRecallOne")}
          aria-label="queueRecallOne"
          onClick={onRecall}
          style={iconBtn}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 14 4 9 9 4" />
            <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
          </svg>
        </button>
      )}
      {onRemove && (
        <button
          title={t("chat.queueRemove")}
          aria-label="queueRemoveOne"
          onClick={onRemove}
          style={{ ...iconBtn, color: "var(--text-dim)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "#ef4444";
            e.currentTarget.style.background = "rgba(239,68,68,0.12)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--text-dim)";
            e.currentTarget.style.background = "transparent";
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** Windows-10 "show desktop"-style thin vertical bar cycling the bottom panel states.
 *  The visible line stays thin, but the tap target is 32px wide (mobile-friendly). */
function BottomModeBar({ mode, onClick, height = 32, tapWidth = 32, count, label }: {
  mode: "full" | "queueHidden" | "minimal";
  onClick: () => void;
  height?: number;
  tapWidth?: number;
  count?: number;
  label?: string;
}) {
  const { t } = useI18n();
  const defaultLabel = mode === "full" ? t("chat.minimizeQueue") : mode === "queueHidden" ? t("chat.minimizeInput") : t("chat.restoreBottom");
  const effectiveLabel = label ?? defaultLabel;
  return (
    <button
      type="button"
      onClick={onClick}
      title={effectiveLabel}
      aria-label={effectiveLabel}
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: tapWidth,
        height,
        padding: 0,
        background: "none",
        border: "none",
        borderRadius: 7,
        color: "var(--text-muted)",
        cursor: "pointer",
        transition: "background 0.12s, color 0.12s, box-shadow 0.12s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.boxShadow = "0 0 0 1px var(--border)";
        e.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "none";
        e.currentTarget.style.boxShadow = "none";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      {typeof count === "number" && count > 0 && (
        <span
          style={{
            flexShrink: 0,
            fontSize: 10.5,
            fontFamily: "var(--font-mono)",
            color: mode === "minimal" ? "var(--accent)" : "inherit",
            lineHeight: 1,
          }}
        >
          {count}
        </span>
      )}
      <svg width="2" height="16" viewBox="0 0 2 16" style={{ flexShrink: 0, borderRadius: 1 }}>
        <rect x="0" y="0" width="2" height="16" fill={mode === "minimal" ? "var(--accent)" : "currentColor"} />
      </svg>
    </button>
  );
}

function ModelNoticeBanner({ tone, title, body }: { tone: "error" | "warning"; title: string; body: string }) {
  const color = tone === "error" ? "239,68,68" : "234,179,8";
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        maxHeight: 120,
        marginBottom: 8,
        padding: "7px 10px",
        overflowY: "auto",
        border: `1px solid rgba(${color},0.3)`,
        borderRadius: 6,
        background: `rgba(${color},0.07)`,
        color: `rgb(${color})`,
        fontSize: 11,
        lineHeight: 1.45,
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      >
        <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{body}</div>
      </div>
    </div>
  );
}

export function ModelErrorBanner({ error }: { error?: string | null }) {
  if (!error) return null;
  return <ModelNoticeBanner tone="error" title="Model error" body={error} />;
}

/** Surfaces `enabledModels` patterns that matched nothing, so a typo is visible (#307). */
export function ModelScopeWarningBanner({ warnings }: { warnings?: string[] }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <ModelNoticeBanner
      tone="warning"
      title={warnings.length > 1 ? "Model scope warnings" : "Model scope warning"}
      body={warnings.join("\n")}
    />
  );
}

/** Compact icon-only action button for the streaming input row, with a
 *  hover/focus popover that carries the label + hint. Keeping the inline text
 *  out of the row prevents the two queue buttons from squeezing the textarea —
 *  the meaning lives in the popup ("\u7eaf\u5f39\u51fa\u7684\u6837\u5f0f"), the button itself stays a
 *  fixed square that never changes width. */
function StreamingActionButton({
  label, hint, disabled, onClick, bg, border, fg, children,
}: {
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
  bg: string;
  border: string;
  fg: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const active = !disabled;
  // 小屏触控目标统一调大 120%（30 → 36px），图标等比缩放。
  const size = isMobile ? 36 : 30;
  const iconScale = size / 30;
  return (
    <span
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: size, height: size, padding: 0,
          background: active ? bg : "none",
          border: `1px solid ${active ? border : "var(--border)"}`,
          borderRadius: Math.round(size * 0.27),
          color: active ? fg : "var(--text-dim)",
          cursor: active ? "pointer" : "not-allowed",
          transition: "background 0.12s",
        }}
      >
        <span style={{ display: "inline-flex", transform: `scale(${iconScale})` }}>{children}</span>
      </button>
      {open && (
        <span role="tooltip" style={{
          position: "absolute",
          bottom: "calc(100% + 6px)",
          right: 0,
          zIndex: 60,
          whiteSpace: "nowrap",
          padding: "4px 8px",
          fontSize: 11,
          fontWeight: 600,
          lineHeight: 1.4,
          color: "var(--text)",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
          pointerEvents: "none",
        }}>
          {label}
          {hint ? <span style={{ color: "var(--text-dim)", fontWeight: 500, marginLeft: 6 }}>{hint}</span> : null}
        </span>
      )}
    </span>
  );
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, onSteer, onFollowUp, onQueueSteerSend, canContinue, onContinue, onConvertQueueItem, isStreaming, model, isAutoModelSelection, modelNames, modelList, modelError, modelScopeWarnings, onModelChange, modelSwitching,
  onCompact, onAbortCompaction, isCompacting, compactError, compactResult, compactQueued, onCancelCompactQueue, modelSwitchPending, toolPreset, onToolPresetChange,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  retryInfo, queuedMessages, inputHistory = [], onRecallQueue,
  onExportQueue, onImportQueue, onStageImport, onMoveQueue, onRecallOne, onRequeueAt, onRemoveQueueItem,
  queueTrash, onRestoreQueueItem, onPurgeQueueTrash,
  slashCommands, slashCommandsLoading, onLoadSlashCommands,
  onBuiltinCommand,
  soundEnabled, onSoundToggle, onAudioUnlock,
  onPromptWithStreamingBehavior,
  draftKey,
  cwd,
}: Props, ref) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [value, setValue] = useState("");
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [controlsMenuOpen, setControlsMenuOpen] = useState(false);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const trimmedValue = value.trimStart();
  const bashMode = attachedImages.length === 0 && trimmedValue.startsWith("!");
  const bashExcluded = bashMode && trimmedValue.startsWith("!!");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashMenuMaxHeight, setSlashMenuMaxHeight] = useState<number | null>(null);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyActiveIndex, setHistoryActiveIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState<{ cwd: string; entries: FileIndexEntry[]; truncated: boolean } | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [atServerResult, setAtServerResult] = useState<{ cwd: string; query: string; matches: FileIndexEntry[] } | null>(null);
  const [skillDormancyState, setSkillDormancyState] = useState<{
    cwd: string;
    values: Record<string, boolean>;
  } | null>(null);
  const skillDormancy = cwd && skillDormancyState?.cwd === cwd
    ? skillDormancyState.values
    : {};

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatHooksRef = useRef<ReturnType<typeof useChatHooks>>([]);
  chatHooksRef.current = useChatHooks();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const toolDropdownRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const controlsMenuRef = useRef<HTMLDivElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queueImportFileRef = useRef<HTMLInputElement>(null);
  // Mobile-only: cycle the bottom panels (queue banner + input + toolbar) to
  // leave more room for the conversation during long runs. Persisted so the
  // choice survives reloads.
  //   full        → everything visible
  //   queueHidden → queue banner hidden, input + toolbar visible
  //   minimal     → only a slim capsule bar (with the cycle button) remains
  type BottomMode = "full" | "queueHidden" | "minimal";
  const [bottomMode, setBottomMode] = useState<BottomMode>(() => {
    if (typeof window === "undefined") return "full";
    try {
      const v = window.localStorage.getItem("pi-chat-bottom-mode");
      return v === "queueHidden" || v === "minimal" ? v : "full";
    } catch { return "full"; }
  });
  const bottomModeRef = useRef(bottomMode);
  useEffect(() => { bottomModeRef.current = bottomMode; }, [bottomMode]);
  // Mirrors the live queue count for cycleBottomMode (defined before queueCount).
  const queueCountRef = useRef(0);
  const cycleBottomMode = useCallback((dir: 1 | -1 = 1, wrap = true) => {
    const prev = bottomModeRef.current;
    // With no queued messages the "queue hidden" level is pointless, so both
    // swipes and click-cycles skip it: full ↔ minimal directly.
    const order: BottomMode[] = queueCountRef.current === 0
      ? ["full", "minimal"]
      : ["full", "queueHidden", "minimal"];
    const idx = order.indexOf(prev);
    // Swipe gestures must NOT wrap: swiping up from "full" (already fully
    // expanded) must stay at "full" instead of cycling to "minimal" (which
    // collapses the input area); same for swiping down from "minimal".
    const nextIdx = wrap
      ? (idx + dir + order.length) % order.length
      : Math.min(order.length - 1, Math.max(0, idx + dir));
    const next = order[nextIdx];
    try { window.localStorage.setItem("pi-chat-bottom-mode", next); } catch { /* ignore */ }
    if (next === "minimal") {
      setControlsMenuOpen(false);
      setModelDropdownOpen(false);
    }
    setBottomMode(next);
  }, []);

  // Swipe gestures on the bottom panels: swipe down collapses one level
  // (full → queueHidden → minimal), swipe up expands one level back.
  const SWIPE_THRESHOLD = 44;
  const touchStartRef = useRef<{ y: number; x: number; active: boolean } | null>(null);
  const [swipeHint, setSwipeHint] = useState<"up" | "down" | null>(null);
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!isMobile) return;
    // Text editing / scrolling inside the textarea takes priority.
    if (e.target instanceof Element && e.target.closest("textarea")) {
      touchStartRef.current = null;
      return;
    }
    const t = e.touches[0];
    touchStartRef.current = { y: t.clientY, x: t.clientX, active: true };
  }, [isMobile]);
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const s = touchStartRef.current;
    if (!s || !s.active || !isMobile) return;
    const t = e.touches[0];
    const dy = t.clientY - s.y;
    const dx = t.clientX - s.x;
    // Horizontal-dominant gesture: cancel (edge swipes / other horizontal UX).
    if (Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 24) {
      touchStartRef.current = null;
      setSwipeHint(null);
      return;
    }
    if (dy > SWIPE_THRESHOLD) setSwipeHint("down");
    else if (dy < -SWIPE_THRESHOLD) setSwipeHint("up");
    else setSwipeHint(null);
  }, [isMobile]);
  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    setSwipeHint(null);
    const s = touchStartRef.current;
    touchStartRef.current = null;
    if (!s || !s.active || !isMobile) return;
    const t = e.changedTouches[0];
    const dy = t.clientY - s.y;
    if (Math.abs(dy) < SWIPE_THRESHOLD) return;
    // Swipe down = collapse further (full→queueHidden→minimal), swipe up = expand back.
    // No wrapping: hitting either end keeps that state.
    cycleBottomMode(dy > 0 ? 1 : -1, false);
  }, [isMobile, cycleBottomMode]);
  // Queue area collapse: null = expanded by default; the user can collapse
  // it manually and that choice is respected — the queue is NEVER auto-hidden
  // (auto-hide made the panel disappear right after the user edited it).
  const [queueCollapsedUser, setQueueCollapsedUser] = useState<boolean | null>(null);
  const [queueNotice, setQueueNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const queueNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showQueueNotice = useCallback((text: string, ok: boolean) => {
    setQueueNotice({ text, ok });
    if (queueNoticeTimerRef.current) clearTimeout(queueNoticeTimerRef.current);
    queueNoticeTimerRef.current = setTimeout(() => setQueueNotice(null), 3000);
  }, []);
  const queueCount = (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0);
  const trashCount = queueTrash?.length ?? 0;
  const queueCollapsed = queueCollapsedUser ?? false;
  const toggleQueueCollapsed = useCallback(() => {
    setQueueCollapsedUser((prev) => !(prev ?? false));
  }, []);
  const handleMoveQueue = useCallback(async (kind: "steer" | "followUp", index: number, dir: -1 | 1) => {
    if (!onMoveQueue) return;
    await onMoveQueue(kind, index, index + dir);
  }, [onMoveQueue]);
  // Soft-deleted entry waiting for the undo toast (trash bin is the fallback
  // when the toast window passes or a newer delete replaces it).
  const [lastDeleted, setLastDeleted] = useState<QueueTrashItem & { kind: "steer" | "followUp"; index: number } | null>(null);
  const undoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [purgeConfirmId, setPurgeConfirmId] = useState<string | null>(null);
  const [purgeAllConfirm, setPurgeAllConfirm] = useState(false);
  const trashButtonRef = useRef<HTMLButtonElement>(null);
  const trashPanelRef = useRef<HTMLDivElement>(null);
  const handleRemoveQueueItem = useCallback(async (
    kind: "steer" | "followUp",
    index: number,
    opts?: { permanent?: boolean },
  ) => {
    if (!onRemoveQueueItem) return null;
    const removed = await onRemoveQueueItem(kind, index, opts);
    if (removed && !opts?.permanent) {
      setLastDeleted({ ...removed, kind, index });
      if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
      undoHideTimerRef.current = setTimeout(() => setLastDeleted(null), 8000);
    }
    return removed;
  }, [onRemoveQueueItem]);
  const handleUndoDelete = useCallback(async () => {
    const item = lastDeleted;
    if (!item || !onRestoreQueueItem) return;
    if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
    setLastDeleted(null);
    const ok = await onRestoreQueueItem(item.id, item.index);
    if (!ok) {
      // Restore failed — put the toast back so the user can retry (or fall
      // back to the trash bin, where the entry still sits).
      setLastDeleted(item);
      if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
      undoHideTimerRef.current = setTimeout(() => setLastDeleted(null), 8000);
    } else {
      setQueueCollapsedUser(null);
    }
  }, [lastDeleted, onRestoreQueueItem]);
  const handleRestoreTrashItem = useCallback(async (item: QueueTrashItem) => {
    if (!onRestoreQueueItem) return;
    const ok = await onRestoreQueueItem(item.id);
    if (ok) {
      // The restored entry is back in the live queue — drop any pending undo
      // toast that still points at it.
      setLastDeleted((cur) => (cur && cur.id === item.id ? null : cur));
      setQueueCollapsedUser(null);
      showQueueNotice(t("chat.queueTrashRestored", { count: "1" }), true);
    }
  }, [onRestoreQueueItem, showQueueNotice, t]);
  const handleRestoreAllTrash = useCallback(async () => {
    if (!onRestoreQueueItem) return;
    const items = queueTrash ?? [];
    let ok = true;
    for (const item of items) {
      const r = await onRestoreQueueItem(item.id);
      if (!r) ok = false;
    }
    if (ok && items.length > 0) {
      setLastDeleted(null);
      if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
      setQueueCollapsedUser(null);
      showQueueNotice(t("chat.queueTrashRestored", { count: String(items.length) }), true);
    }
  }, [onRestoreQueueItem, queueTrash, showQueueNotice, t]);
  const handlePurgeTrashItem = useCallback(async (id: string) => {
    if (!onPurgeQueueTrash) return;
    const ok = await onPurgeQueueTrash([id]);
    if (ok) {
      setLastDeleted((cur) => (cur && cur.id === id ? null : cur));
      showQueueNotice(t("chat.queueTrashPurged", { count: "1" }), true);
    }
    setPurgeConfirmId(null);
  }, [onPurgeQueueTrash, showQueueNotice, t]);
  const handlePurgeAllTrash = useCallback(async () => {
    if (!onPurgeQueueTrash) return;
    const count = trashCount;
    const ok = await onPurgeQueueTrash();
    if (ok) {
      setLastDeleted(null);
      if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
      showQueueNotice(t("chat.queueTrashPurged", { count: String(count) }), true);
      setTrashOpen(false);
    }
    setPurgeAllConfirm(false);
  }, [onPurgeQueueTrash, trashCount, showQueueNotice, t]);
  const resetTrashConfirms = useCallback(() => {
    setPurgeConfirmId(null);
    setPurgeAllConfirm(false);
  }, []);
  // The trash bin has no entry point once empty — auto-close the popover.
  useEffect(() => {
    if (trashCount === 0) {
      setTrashOpen(false);
      setPurgeConfirmId(null);
      setPurgeAllConfirm(false);
    }
  }, [trashCount]);
  // Entry pulled out for editing; sending re-inserts it at its original spot.
  const recalledRef = useRef<{ kind: "steer" | "followUp"; index: number; text: string; images?: ChatDraftImage[] } | null>(null);
  const [recalledVisible, setRecalledVisible] = useState(false);
  // When the input is crowded (small screens / lots of text), the
  // steer/followUp buttons collapse to icons so they don't push the textarea
  // or wrap awkwardly. Measured from the input row container.
  const [queueButtonsCollapsed, setQueueButtonsCollapsed] = useState(false);
  const [buttonsWrapped, setButtonsWrapped] = useState(false);
  const inputRowRef = useRef<HTMLDivElement>(null);
  const handleRecallOne = useCallback(async (kind: "steer" | "followUp", index: number) => {
    if (!onRecallOne) return;
    const entry = await onRecallOne(kind, index);
    if (!entry) return;
    recalledRef.current = { kind, index, text: entry.text, images: entry.images };
    setRecalledVisible(true);
    const ta = textareaRef.current;
    const current = ta ? ta.value : value;
    const combined = [entry.text, current].filter((t) => t.trim()).join("\n\n");
    setValue(combined);
    setAtQuery(null);
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      // Cursor lands at the END of the inserted (recalled) text, not the end
      // of the whole combined value (which sits below the user's existing
      // input when they already typed something).
      ta.setSelectionRange(entry.text.length, entry.text.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
    setQueueCollapsedUser(null);
  }, [onRecallOne, value]);
  const cancelRecall = useCallback(() => {
    recalledRef.current = null;
    setRecalledVisible(false);
  }, []);
  // Drag & drop reordering (desktop); up/down buttons remain for mobile.
  const dragFromRef = useRef<{ kind: "steer" | "followUp"; index: number } | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<{ kind: "steer" | "followUp"; index: number } | null>(null);
  const handleDragStart = useCallback((kind: "steer" | "followUp", index: number) => {
    dragFromRef.current = { kind, index };
  }, []);
  const handleDragOver = useCallback((kind: "steer" | "followUp", index: number) => {
    setDragOverIndex({ kind, index });
  }, []);
  const handleDrop = useCallback((kind: "steer" | "followUp", targetIndex: number) => {
    const from = dragFromRef.current;
    dragFromRef.current = null;
    setDragOverIndex(null);
    if (!from || from.kind !== kind || from.index === targetIndex || !onMoveQueue) return;
    void onMoveQueue(kind, from.index, targetIndex);
  }, [onMoveQueue]);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  const draftKeyRef = useRef(draftKey);
  const valueRef = useRef(value);
  const attachedImagesRef = useRef(attachedImages);
  // True once the user (or a draft restore) put content into the box — the
  // save effect must NOT touch the stored draft while the box is merely empty
  // on open (that draft may be awaiting recovery in the dialog).
  const draftEditedRef = useRef(false);  const pendingImageCountRef = useRef(0);
  valueRef.current = value;
  attachedImagesRef.current = attachedImages;
  queueCountRef.current = (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0);

  useImperativeHandle(ref, () => ({
    insertIfEmpty(text: string) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (current.trim()) return;
      valueRef.current = text;
      setValue(text);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    replaceMessage(message: UserMessage) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (!canRestoreUserMessage(current, attachedImagesRef.current.length, pendingImageCountRef.current)) return;

      const restoredText = getUserMessageText(message);
      const restoredImages = draftImagesToAttachedImages(getUserMessageDraftImages(message));
      valueRef.current = restoredText;
      attachedImagesRef.current = restoredImages;
      setValue(restoredText);
      setAtQuery(null);
      setHistoryMenuOpen(false);
      setAttachedImages((prev) => {
        prev.forEach(revokeImagePreview);
        return restoredImages;
      });
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    prependText(text: string) {
      if (!text.trim()) return;
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      // Mirrors the TUI's queue restore: queued text first, then whatever
      // the user already typed, separated by a blank line.
      const combined = [text, current].filter((t) => t.trim()).join("\n\n");
      valueRef.current = combined;
      setValue(combined);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        // Cursor lands at the END of the prepended text (not the end of the
        // whole combined value), so further typing continues the recalled
        // message instead of jumping below the user's existing input.
        ta.setSelectionRange(text.length, text.length);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    /** Append to the END of the input. Only a single newline separates the
     *  inserted text from whatever was already typed (no blank line); if the
     *  current value already ends with a newline (or is empty) nothing extra
     *  is added, so the quote starts on its own line without glueing to the
     *  previous input. Cursor lands at the tail of the combined value. */
    appendText(text: string) {
      if (!text.trim()) return;
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      const hasContent = current.trim().length > 0;
      const sep = hasContent && !current.endsWith("\n") ? "\n" : "";
      const combined = (hasContent ? current : "") + sep + text;
      setValue(combined);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(combined.length, combined.length);
        // Height recalculation (runs on its own via the [value] effect too;
        // doing it here keeps the box sized before the next paint).
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    rekeyDraft(previousKey: string, nextKey: string) {
      if (previousKey === nextKey) return;
      if (draftKeyRef.current !== previousKey) {
        rekeyStoredDraft(previousKey, nextKey);
        return;
      }

      const currentDraft = {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
      };
      const moved = rekeyStoredDraft(previousKey, nextKey, currentDraft) ?? { value: "", images: [] };
      const unchanged = moved.value === currentDraft.value
        && moved.images.length === currentDraft.images.length
        && moved.images.every((image, index) => (
          image.data === currentDraft.images[index]?.data
          && image.mimeType === currentDraft.images[index]?.mimeType
        ));
      draftKeyRef.current = nextKey;
      if (unchanged) return;

      const movedImages = draftImagesToAttachedImages(moved.images);
      valueRef.current = moved.value;
      attachedImagesRef.current = movedImages;
      setValue(moved.value);
      setAttachedImages((current) => {
        current.forEach(revokeImagePreview);
        return movedImages;
      });
      setAtQuery(null);
      setHistoryMenuOpen(false);
    },
    restoreSubmission(text: string, images?: ChatDraftImage[], targetDraftKey?: string) {
      if (!text.trim() && !images?.length) return;

      // clearInput is queued before the submission handler runs. Compose with
      // that queued state so a fast rejection cannot observe stale DOM text and
      // then get overwritten by the clear.
      const currentDraftKey = draftKeyRef.current;
      const destinationDraftKey = targetDraftKey ?? currentDraftKey;
      const targetsCurrentComposer = destinationDraftKey === currentDraftKey;
      const storedDraft = !targetsCurrentComposer && destinationDraftKey
        ? getDraft(destinationDraftKey)
        : null;
      const restoredDraft = mergeRestoredSubmissionDraft(
        text,
        images,
        targetsCurrentComposer ? valueRef.current : (storedDraft?.value ?? ""),
        targetsCurrentComposer
          ? attachedImagesRef.current.map(imageToDraftImage)
          : (storedDraft?.images ?? []),
      );
      // The first optimistic message switches ChatWindow out of its empty-state
      // layout and remounts this component. Persist synchronously so recovery is
      // not lost if this instance is the one being unmounted.
      if (destinationDraftKey) setDraft(destinationDraftKey, restoredDraft);
      if (!targetsCurrentComposer) return;
      const restoredImages = images?.length
        ? [
            ...draftImagesToAttachedImages(images).slice(
              0,
              Math.max(0, MAX_ATTACHED_IMAGES - attachedImagesRef.current.length),
            ),
            ...attachedImagesRef.current,
          ].slice(0, MAX_ATTACHED_IMAGES)
        : attachedImagesRef.current;
      // Session promotion can rekey this composer before React flushes the
      // functional updates below, so update the imperative snapshot first.
      valueRef.current = restoredDraft.value;
      attachedImagesRef.current = restoredImages;
      setValue((current) => {
        const restored = mergeRestoredSubmissionText(text, current);
        valueRef.current = restored;
        return restored;
      });
      setAtQuery(null);
      setHistoryMenuOpen(false);
      if (images?.length) {
        setAttachedImages((current) => {
          const available = Math.max(0, MAX_ATTACHED_IMAGES - current.length);
          const restored = draftImagesToAttachedImages(images)
            .slice(0, available);
          const next = restored.length > 0 ? [...restored, ...current] : current;
          attachedImagesRef.current = next;
          return next;
        });
      }
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((v) => v + (v ? " " : "") + text);
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const newVal = before + sep + text + after;
      valueRef.current = newVal;
      setValue(newVal);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        const pos = start + sep.length + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    addImages(files: File[]) {
      processImageFiles(files);
    },
    restoreDraft(draft: ChatDraft) {
      setValue(draft.value);
      setAtQuery(null);
      setHistoryMenuOpen(false);
      setAttachedImages((prev) => {
        prev.forEach(revokeImagePreview);
        return draftImagesToAttachedImages(draft.images);
      });
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    hasInput() {
      return Boolean(value.trim()) || attachedImagesRef.current.length > 0;
    },
    runChatHooks(text: string) {
      return applyChatHooks(text);
    },
    expandQueue() {
      setQueueCollapsedUser(false);
    },
  }));

  const processImageFiles = useCallback(async (files: File[]) => {
    const remaining = Math.max(
      0,
      MAX_ATTACHED_IMAGES - attachedImagesRef.current.length - pendingImageCountRef.current,
    );
    const imageFiles = files
      .filter((f) => f.type.startsWith("image/") && f.size <= MAX_ATTACHED_IMAGE_BYTES)
      .slice(0, remaining);
    if (!imageFiles.length) return;
    pendingImageCountRef.current += imageFiles.length;
    try {
      const newImages = await Promise.all(
        imageFiles.map(
          (file) =>
            new Promise<AttachedImage>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                const result = reader.result as string;
                // result is "data:<mime>;base64,<data>"
                const base64 = result.split(",")[1];
                resolve({ data: base64, mimeType: file.type, previewUrl: URL.createObjectURL(file) });
              };
              reader.onerror = reject;
              reader.readAsDataURL(file);
            })
        )
      );
      setAttachedImages((prev) => {
        const accepted = newImages.slice(0, Math.max(0, MAX_ATTACHED_IMAGES - prev.length));
        newImages.slice(accepted.length).forEach(revokeImagePreview);
        const next = [...prev, ...accepted];
        attachedImagesRef.current = next;
        return next;
      });
    } finally {
      pendingImageCountRef.current -= imageFiles.length;
    }
  }, []);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) revokeImagePreview(removed);
      attachedImagesRef.current = next;
      return next;
    });
  }, []);

  const clearImages = useCallback(() => {
    attachedImagesRef.current = [];
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return [];
    });
  }, []);

  const clearInput = useCallback(() => {
    valueRef.current = "";
    setValue("");
    setAtQuery(null);
    setHistoryMenuOpen(false);
    if (draftKey) clearDraft(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) clearDraft(draftKeyRef.current);
    clearImages();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [clearImages, draftKey]);

  useEffect(() => {
    if (!draftKey || draftKeyRef.current !== draftKey) return;
    if (!value.trim() && attachedImages.length === 0) {
      // Empty box: never wipe a stored draft on open — it may be awaiting
      // recovery. But a deliberate clear AFTER typing this mount removes it.
      if (draftEditedRef.current) clearDraft(draftKey);
      return;
    }
    draftEditedRef.current = true;
    setDraft(draftKey, {
      value,
      images: attachedImages.map(imageToDraftImage),
    });
  }, [attachedImages, draftKey, value]);

  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey) return;
    draftEditedRef.current = false;

    if (previousDraftKey) {
      setDraft(previousDraftKey, {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
      });
    }

    draftKeyRef.current = draftKey;
    // Drafts are never auto-restored: an unsent draft from a previous visit
    // surfaces in the queue-recovery dialog instead, where the user decides.
    setValue("");
    setAtQuery(null);
    setHistoryMenuOpen(false);
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return [];
    });
  }, [draftKey]);

  // SPA tab switches unmount this input; write whatever is still cached so a
  // later refresh of that tab does not miss the last edit.
  useEffect(() => {
    return () => {
      flushAllDrafts();
    };
  }, []);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    if (value) ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  const handleFocus = useCallback(() => {
    // Re-measure once the focus-driven layout settles. Focusing alone does not
    // fire onChange/onInput, so a height computed at an earlier width (mobile
    // keyboard opening, buttons wrapping onto their own row) stays stale
    // until the next keystroke — e.g. after pasting text and tapping back in.
    requestAnimationFrame(resizeTextarea);
  }, [resizeTextarea]);

  // Collapse the Send button label when the input row gets crowded (narrow
  // viewport or long text); the streaming steer/follow-up buttons are now
  // fixed-size icon-only popovers, so they never squeeze the textarea.
  useEffect(() => {
    const el = inputRowRef.current;
    const ta = textareaRef.current;
    if (!el || !ta) return;
    const measure = () => {
      const rowWidth = el.clientWidth;
      // Measure on a detached clone at the FULL row width so results do not
      // depend on the textarea's current width — otherwise toggling flex-basis
      // changes the width, which changes scrollHeight/scrollWidth, which can
      // flip the flags forever (page jumping, especially on narrow screens
      // with long unbroken strings).
      const clone = ta.cloneNode(true) as HTMLTextAreaElement;
      clone.style.position = "absolute";
      clone.style.visibility = "hidden";
      clone.style.width = `${el.clientWidth - 2}px`;
      clone.style.height = "auto";
      clone.style.minHeight = "0";
      document.body.appendChild(clone);
      const fullWidthHeight = clone.scrollHeight;
      const fullWidthScrollW = clone.scrollWidth;
      const fullWidthClientW = clone.clientWidth;
      clone.remove();
      // Collapse button labels only when the text itself overflows the
      // textarea at full width AND the row is tight (small screens keep full
      // labels by wrapping the buttons instead of hiding text).
      setQueueButtonsCollapsed(fullWidthScrollW > fullWidthClientW + 4 && rowWidth < 720);
      // Buttons wrap below only once the textarea grows past a single line
      // (multi-line input), so the default layout stays one row: textarea
      // filling the space + buttons on the right.
      setButtonsWrapped(fullWidthHeight > 30);
      // The wrap flags change the textarea's flex-basis (full width once the
      // buttons move to their own row), which re-wraps the text at a new
      // width. Re-sync the height after that re-render so an input box that
      // just expanded on a small screen is not left at a stale height.
      requestAnimationFrame(resizeTextarea);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [resizeTextarea, value, isStreaming]);

  useEffect(() => {
    return () => {
      attachedImagesRef.current.forEach(revokeImagePreview);
    };
  }, []);

  // 扩展聊天钩子统一入口：Enter 发送 / 插队（steer）/ 排队（follow-up）都走这里——
  // [元素N]/[回答N]/[错误N] 占位符任何发送路径都替换（aiti-devtools：候选内容 + 来源前缀）
  const applyChatHooks = useCallback((text: string): string => {
    const chatHooks = chatHooksRef.current ?? [];
    let finalMsg = text;
    for (const hk of chatHooks) {
      if (typeof hk.preSend === "function") {
        try {
          const r = hk.preSend(finalMsg);
          if (r && typeof r.text === "string") finalMsg = r.text;
        } catch { /* 钩子失败不阻塞发送 */ }
      }
    }
    return finalMsg;
  }, []);

  const handleSend = useCallback(async () => {
    const msg = value.trim();
    if (!msg && !attachedImages.length) return;
    onAudioUnlock?.();
    // Edited entry pulled out of the queue: sending puts it back at its
    // original position instead of dispatching it as a new prompt. Re-queueing
    // is a queue-only operation and must work even while the agent is
    // streaming (it does not start a new prompt), so this branch runs before
    // the isStreaming guard below.
    const recalled = recalledRef.current;
    if (recalled) {
      recalledRef.current = null;
      setRecalledVisible(false);
      if (onRequeueAt) {
        const ok = await onRequeueAt(recalled.kind, recalled.index, msg, attachedImages.length ? attachedImages : recalled.images);
        if (!ok) {
          // Failed to requeue: restore the edit state so the user can retry.
          recalledRef.current = { ...recalled, text: msg };
          setRecalledVisible(true);
        }
        clearInput();
        return;
      }
    }
    if (isStreaming) return;
    if (!attachedImages.length && msg.startsWith("/") && onBuiltinCommand) {
      const result = await onBuiltinCommand(msg);
      if (result.handled) {
        // Slash commands can block for a long time (e.g. /compact takes tens
        // of seconds) and the user may keep typing meanwhile. Only clear the
        // command text itself when the input was left untouched — never wipe
        // a draft typed while the command ran (and its localStorage slot).
        const inputUntouched = valueRef.current.trim() === msg && attachedImagesRef.current.length === 0;
        if (!result.error && inputUntouched) clearInput();
        return;
      }
    }
    // 扩展聊天钩子（aiti-devtools）：发送前 [元素N]/[回答N]/[错误N] → 真实候选内容（Enter/steer/queue 统一走 applyChatHooks）
    const finalMsg = applyChatHooks(msg);
    onSend(finalMsg, attachedImages.length ? attachedImages : undefined);
    clearInput();
  }, [value, attachedImages, isStreaming, onBuiltinCommand, onSend, clearInput, onAudioUnlock, onRequeueAt, applyChatHooks]);

  /** 扩展程序化发送（aiti-prompts 等）：与用户输入同链路——applyChatHooks 钩子生效；
   *  agent 流式时按 mode 插队(steer)/排队(followUp)（与 sendQueued 同分支），空闲时直接触发（等同 Enter）。
   *  不清空输入框：发的是扩展内容，不动用户正在输入的内容。 */
  const handleExtensionSend = useCallback((text: string, mode: "steer" | "followUp") => {
    if (!text || !text.trim()) return;
    const finalMsg = applyChatHooks(text);
    if (finalMsg.startsWith("/") && onPromptWithStreamingBehavior) {
      onPromptWithStreamingBehavior(finalMsg, mode, undefined);
      return;
    }
    if (mode === "steer" && onSteer) {
      onSteer(finalMsg, undefined);
    } else if (mode === "followUp" && onFollowUp) {
      onFollowUp(finalMsg, undefined);
    } else {
      // 空闲（onSteer/onFollowUp 仅在 agent 运行时传入）→ 立即触发一轮
      onSend?.(finalMsg, undefined);
    }
  }, [applyChatHooks, onSend, onSteer, onFollowUp, onPromptWithStreamingBehavior]);

  useEffect(() => {
    registerChatSend(handleExtensionSend);
    return () => registerChatSend(null);
  }, [handleExtensionSend]);

  const slashQuery = value.startsWith("/") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;

  const filteredSlashCommands = (() => {
    if (slashQuery === null) return [];
    const commands = [...(isStreaming ? [] : BUILTIN_SLASH_COMMANDS), ...(slashCommands ?? [])];
    return [...commands]
      .filter((command) => {
        const name = command.name.toLowerCase();
        const description = getSlashDescription(command, t).toLowerCase();
        return name.includes(slashQuery) || description.includes(slashQuery);
      })
      .sort((a, b) => {
        const rankDelta = slashMatchRank(a, slashQuery, t) - slashMatchRank(b, slashQuery, t);
        if (rankDelta !== 0) return rankDelta;
        return SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source]
          || MODEL_OPTION_COLLATOR.compare(a.name, b.name);
      });
  })();

  const {
    commands: displayedSlashCommands,
    groups: groupedSlashCommands,
  } = buildSlashCommandLayout(filteredSlashCommands, skillDormancy);

  const slashCommandCountLabel = filteredSlashCommands.length === 1
    ? t(slashQuery ? "chat.match" : "chat.command")
    : t(slashQuery ? "chat.matches" : "chat.commands", { count: filteredSlashCommands.length });
  const hasInputText = Boolean(value.trim());
  const canQueueStreamingMessage = hasInputText && attachedImages.length === 0;
  // With no typed text, the steer button still works when the queue holds a
  // follow-up: clicking it dispatches the FIRST queued follow-up as a steer
  // (same action as the row/collapsed-bar steer button).
  const canSteerFromQueue = !hasInputText && !attachedImages.length && (queuedMessages?.followUp?.length ?? 0) > 0;
  // 插队/排队按钮的 hover 提示按状态区分：AI 处理中且输入框为空（无消息、无图片、
  // 队列里也没有可插队的 follow-up）时两个按钮同时灰掉——此时提示要先输入消息，
  // 而不是笼统的动作说明。图片不能排队是另一条独立原因。
  const queueDisabledImages = attachedImages.length > 0;
  const queueDisabledNoInput = !hasInputText && !queueDisabledImages;

  // ── @ file autocomplete ──────────────────────────────────────────────────
  // Recomputed from the text before the caret on every change/caret move.
  // Disabled entirely when there is no cwd (new session without a directory).
  const updateAtQuery = useCallback((text: string, cursor: number | null) => {
    if (!cwd) {
      setAtQuery(null);
      return;
    }
    const pos = cursor ?? text.length;
    setAtQuery(extractAtQuery(text.slice(0, pos)));
  }, [cwd]);

  const atQueryText = atQuery?.query ?? null;
  const atLocalMatches: FileIndexEntry[] = React.useMemo(() => (
    atQueryText !== null && fileIndex && fileIndex.cwd === cwd
      ? filterFileEntries(fileIndex.entries, atQueryText)
      : []
  ), [atQueryText, fileIndex, cwd]);

  // When the client index is truncated (repo larger than the index cap),
  // local filtering cannot see deep files, so queries are also ranked
  // server-side against the full listing. Local matches render immediately
  // and are replaced when the (debounced) server result for the current
  // query arrives; stale responses are ignored via the query/cwd tag.
  const needsServerSearch = Boolean(atQueryText && fileIndex?.truncated && fileIndex.cwd === cwd);
  useEffect(() => {
    if (!needsServerSearch || !cwd || !atQueryText) return;
    const fetchCwd = cwd;
    const query = atQueryText;
    const timer = setTimeout(() => {
      fetch(apiUrl(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}&q=${encodeURIComponent(query)}`))
        .then((res) => {
          if (!res.ok) throw new Error(`file search failed: ${res.status}`);
          return res.json() as Promise<{ matches?: FileIndexEntry[] }>;
        })
        .then((data) => setAtServerResult({ cwd: fetchCwd, query, matches: data.matches ?? [] }))
        .catch(() => {
          // Keep showing local matches; the next keystroke retries.
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [needsServerSearch, atQueryText, cwd]);

  const serverResultInUse = needsServerSearch
    && atServerResult !== null
    && atServerResult.cwd === cwd
    && atServerResult.query === atQueryText;
  const atMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches;

  // Open/reset the menu whenever the @token appears or changes (mirrors the
  // slash menu: Escape closes it, the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false);
      setAtActiveIndex(0);
      return;
    }
    setAtMenuOpen(true);
    setAtActiveIndex(0);
  }, [atTokenKey]);

  // Fetch the file index when the menu opens. The server caches per cwd for
  // ~10s, so re-opening refreshes cheaply; while typing nothing refetches.
  const atTokenActive = atQuery !== null;
  useEffect(() => {
    if (!atTokenActive || !cwd) return;
    const meta = fileIndexMetaRef.current;
    if (meta && meta.cwd === cwd && Date.now() - meta.fetchedAt < 10_000) return;
    if (fileIndexFetchingRef.current === cwd) return;
    fileIndexFetchingRef.current = cwd;
    const fetchCwd = cwd;
    setFileIndexLoading(true);
    fetch(apiUrl(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}`))
      .then((res) => {
        if (!res.ok) throw new Error(`file index failed: ${res.status}`);
        return res.json() as Promise<{ files?: string[]; truncated?: boolean }>;
      })
      .then((data) => {
        setFileIndex({ cwd: fetchCwd, entries: buildEntriesFromFiles(data.files ?? []), truncated: !!data.truncated });
        fileIndexMetaRef.current = { cwd: fetchCwd, fetchedAt: Date.now() };
      })
      .catch(() => {
        // Leave any previous index in place; next open retries.
        fileIndexMetaRef.current = null;
      })
      .finally(() => {
        fileIndexFetchingRef.current = null;
        setFileIndexLoading(false);
      });
  }, [atTokenActive, cwd]);

  const applyAtCompletion = useCallback((entry: FileIndexEntry) => {
    if (!atQuery) return;
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? value.length;
    const before = value.slice(0, atQuery.start);
    let after = value.slice(cursor);
    // Completing inside a quoted token (@"my dir/… with the caret before the
    // closing quote): the replacement carries its own closing quote, so drop
    // the old one right after the caret (mirrors the TUI's applyCompletion).
    if (atQuery.quoted && after.startsWith('"')) {
      after = after.slice(1);
    }
    const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
    const newValue = before + insert.text + after;
    const newPos = before.length + insert.cursorOffset;
    setValue(newValue);
    // setValue alone does not fire onChange — re-derive the token here. Files
    // end with a space (token closes, menu hides); directories end with "/"
    // before the caret (token stays open for drill-down into the directory).
    setAtQuery(extractAtQuery(newValue.slice(0, newPos)));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newPos, newPos);
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    });
  }, [atQuery, value]);

  useEffect(() => {
    if (atActiveIndex >= atMatches.length) {
      setAtActiveIndex(Math.max(0, atMatches.length - 1));
    }
  }, [atMatches.length, atActiveIndex]);

  useEffect(() => {
    atItemRefs.current.length = atMatches.length;
  }, [atMatches.length]);

  useEffect(() => {
    if (!atMenuOpen) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [atActiveIndex, atMenuOpen]);

  useEffect(() => {
    if (historyActiveIndex >= inputHistory.length) {
      setHistoryActiveIndex(Math.max(0, inputHistory.length - 1));
    }
  }, [inputHistory.length, historyActiveIndex]);

  useEffect(() => {
    historyItemRefs.current.length = inputHistory.length;
  }, [inputHistory.length]);

  useEffect(() => {
    if (!historyMenuOpen) return;
    historyItemRefs.current[historyActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [historyActiveIndex, historyMenuOpen]);

  const applyHistoryInput = useCallback((text: string) => {
    setValue(text);
    setHistoryMenuOpen(false);
    setHistoryActiveIndex(0);
    setAtQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  const applySlashCommand = useCallback((command: SlashCommandPaletteItem) => {
    const nextValue = `/${command.name} `;
    setValue(nextValue);
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  const sendQueued = useCallback((mode: "steer" | "followup") => {
    const msg = value.trim();
    // No typed text: the steer button dispatches the first queued follow-up
    // as a steer (interrupt now) instead of doing nothing.
    if (!msg && !attachedImages.length) {
      if (mode === "steer") {
        const fu = queuedMessages?.followUp?.[0];
        if (fu && onQueueSteerSend) {
          onAudioUnlock?.();
          recalledRef.current = null;
          setRecalledVisible(false);
          onQueueSteerSend(fu);
          void handleRemoveQueueItem("followUp", 0, { permanent: true });
        }
      }
      return;
    }
    if (attachedImages.length) return;
    onAudioUnlock?.();
    // The user explicitly chose a send mode (steer / followUp): dispatch as
    // such instead of putting the recalled entry back into the queue.
    recalledRef.current = null;
    setRecalledVisible(false);
    // 扩展聊天钩子：插队（steer）/ 排队（follow-up）发送同样转换 [元素N]/[回答N]/[错误N]（与 Enter 一致）
    const finalMsg = applyChatHooks(msg);
    const streamingBehavior = mode === "steer" ? "steer" : "followUp";
    if (finalMsg.startsWith("/") && onPromptWithStreamingBehavior) {
      onPromptWithStreamingBehavior(finalMsg, streamingBehavior, attachedImages.length ? attachedImages : undefined);
      clearInput();
      return;
    }
    clearInput();
    if (mode === "steer" && onSteer) {
      onSteer(finalMsg, attachedImages.length ? attachedImages : undefined);
    } else if (mode === "followup" && onFollowUp) {
      onFollowUp(finalMsg, attachedImages.length ? attachedImages : undefined);
    }
    clearInput();
  }, [value, attachedImages, queuedMessages, onPromptWithStreamingBehavior, onSteer, onFollowUp, onQueueSteerSend, handleRemoveQueueItem, clearInput, onAudioUnlock, applyChatHooks]);

  const getNextSlashIndex = useCallback((direction: "up" | "down" | "left" | "right") => {
    const lastIndex = displayedSlashCommands.length - 1;
    if (lastIndex < 0) return 0;

    if (direction === "left") return Math.max(0, slashActiveIndex - 1);
    if (direction === "right") return Math.min(lastIndex, slashActiveIndex + 1);

    const currentNode = slashItemRefs.current[slashActiveIndex];
    if (!currentNode) {
      return direction === "down"
        ? Math.min(lastIndex, slashActiveIndex + 1)
        : Math.max(0, slashActiveIndex - 1);
    }

    const currentRect = currentNode.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = 0; index <= lastIndex; index += 1) {
      if (index === slashActiveIndex) continue;
      const node = slashItemRefs.current[index];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const candidateY = rect.top + rect.height / 2;
      const verticalDelta = candidateY - currentY;
      if (direction === "down" ? verticalDelta <= 4 : verticalDelta >= -4) continue;

      const candidateX = rect.left + rect.width / 2;
      const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX);
      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex >= 0) return bestIndex;
    return direction === "down"
      ? Math.min(lastIndex, slashActiveIndex + 1)
      : Math.max(0, slashActiveIndex - 1);
  }, [displayedSlashCommands.length, slashActiveIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;
      const sendShortcut = e.key === "Enter" && !e.shiftKey && (!isMobile || e.ctrlKey || e.metaKey);
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229;

      if (sendShortcut && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      if (historyMenuOpen && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.min(Math.max(0, inputHistory.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setHistoryMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || sendShortcut) && inputHistory[historyActiveIndex]) {
          e.preventDefault();
          applyHistoryInput(inputHistory[historyActiveIndex]);
          return;
        }
      }

      if (slashMenuOpen && slashQuery !== null) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("down"));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("up"));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("right"));
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("left"));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || sendShortcut) && displayedSlashCommands[slashActiveIndex]) {
          e.preventDefault();
          applySlashCommand(displayedSlashCommands[slashActiveIndex]);
          return;
        }
      }

      // @ file menu — skip while composing so IME candidate navigation
      // (arrows/Enter/Tab) is never intercepted.
      if (atMenuOpen && atQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.min(Math.max(0, atMatches.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || sendShortcut) && atMatches[atActiveIndex]) {
          e.preventDefault();
          applyAtCompletion(atMatches[atActiveIndex]);
          return;
        }
      }

      if (e.key === "ArrowUp" && !isComposing && !isStreaming && inputHistory.length > 0 && value.trim().length === 0) {
        e.preventDefault();
        setSlashMenuOpen(false);
        setAtMenuOpen(false);
        setHistoryActiveIndex(inputHistory.length - 1);
        setHistoryMenuOpen(true);
        return;
      }

      // Esc stops the agent when no slash/@/history menu or IME composition is active.
      if (e.key === "Escape" && !isComposing && isStreaming && onAbort) {
        e.preventDefault();
        onAbort();
        return;
      }

      if (sendShortcut) {
        e.preventDefault();
        if (isStreaming && (onSteer || onFollowUp)) {
          // Default Enter queues as a follow-up (the non-destructive action).
          // With an empty input, a second Enter promotes the first queued
          // follow-up to a steer (delivered at the next turn boundary instead
          // of waiting for the run to end) — so "Enter to queue, Enter again
          // to insert". Steering with typed text is still the steer button.
          if (value.trim()) {
            sendQueued(onFollowUp ? "followup" : "steer");
          } else {
            sendQueued("steer");
          }
        } else {
          handleSend();
        }
      }
    },
    [isMobile, isStreaming, onSteer, onFollowUp, onAbort, slashMenuOpen, slashQuery, displayedSlashCommands, slashActiveIndex, applySlashCommand, sendQueued, handleSend, getNextSlashIndex, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion, historyMenuOpen, inputHistory, historyActiveIndex, applyHistoryInput, value]
  );

  const handleInput = resizeTextarea;

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (!imageItems.length) return;
    e.preventDefault();
    const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
    processImageFiles(files);
  }, [processImageFiles]);

  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      slashCommandsRequestedRef.current = false;
      return;
    }
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [slashQuery, onLoadSlashCommands]);

  // Lazy-load skill dormancy (disable-model-invocation) each time the slash
  // palette opens, so toggles made in the skills panel are reflected on the
  // next open. Failures degrade silently to the unannotated palette.
  useEffect(() => {
    if (!slashMenuOpen || !cwd) return;
    const requestCwd = cwd;
    let cancelled = false;
    setSkillDormancyState({ cwd: requestCwd, values: {} });
    fetch(apiUrl(`/api/skills?cwd=${encodeURIComponent(requestCwd)}`))
      .then((res) => {
        if (!res.ok) throw new Error(`skills fetch failed: ${res.status}`);
        return res.json() as Promise<Partial<SkillsResponse>>;
      })
      .then((data) => {
        if (cancelled) return;
        const dormancy: Record<string, boolean> = {};
        for (const skill of data.skills ?? []) dormancy[skill.name] = skill.disableModelInvocation;
        setSkillDormancyState({ cwd: requestCwd, values: dormancy });
      })
      .catch(() => {
        if (!cancelled) setSkillDormancyState({ cwd: requestCwd, values: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [slashMenuOpen, cwd]);

  useEffect(() => {
    if (slashActiveIndex >= displayedSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, displayedSlashCommands.length - 1));
    }
  }, [displayedSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    slashItemRefs.current.length = displayedSlashCommands.length;
  }, [displayedSlashCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [slashActiveIndex, slashMenuOpen]);

  useLayoutEffect(() => {
    if (!slashMenuOpen || slashQuery === null) {
      setSlashMenuMaxHeight(null);
      return;
    }

    const menu = slashMenuRef.current;
    if (!menu) return;

    let frameId: number | null = null;
    const update = () => {
      frameId = null;
      const nextHeight = getUpwardMenuMaxHeight(
        menu.getBoundingClientRect().bottom,
        getVisibleTopBoundary(menu),
      );
      setSlashMenuMaxHeight((current) => current === nextHeight ? current : nextHeight);
    };
    const scheduleUpdate = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(update);
    };

    update();
    const anchorObserver = typeof ResizeObserver === "undefined" || !menu.parentElement
      ? null
      : new ResizeObserver(scheduleUpdate);
    if (menu.parentElement) anchorObserver?.observe(menu.parentElement);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", scheduleUpdate);
    viewport?.addEventListener("scroll", scheduleUpdate);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);

    return () => {
      anchorObserver?.disconnect();
      viewport?.removeEventListener("resize", scheduleUpdate);
      viewport?.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [slashMenuOpen, slashQuery]);

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name })).sort(compareModelOptions);
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    })).sort(compareModelOptions);
  })();
  const filteredModelOptions = filterModelOptions(modelOptions, modelFilter);
  const showModelFilter = modelOptions.length > MODEL_FILTER_THRESHOLD;

  // Group options by provider, preserving insertion order
  const modelsByProvider: { provider: string; options: ModelOption[] }[] = [];
  for (const opt of filteredModelOptions) {
    const group = modelsByProvider.find((g) => g.provider === opt.provider);
    if (group) group.options.push(opt);
    else modelsByProvider.push({ provider: opt.provider, options: [opt] });
  }

  const displayModelName = model
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name ?? model.modelId)
    : null;
  const currentName = displayModelName;

  const compactSavedTokens = compactResult
    ? Math.max(0, compactResult.tokensBefore - compactResult.estimatedTokensAfter)
    : 0;
  const compactResultText = compactResult
    ? `${compactResult.reason && compactResult.reason !== "manual" ? `${compactResult.reason[0].toUpperCase()}${compactResult.reason.slice(1)} ` : t("chat.compacted")} ${formatTokenCount(compactResult.tokensBefore)} -> ${formatTokenCount(compactResult.estimatedTokensAfter)} tokens (${t("chat.tokensSaved", { saved: formatTokenCount(compactSavedTokens) })})`
    : null;
  const thinkingDisplayLabel = (() => {
    const lvl = thinkingLevel ?? "auto";
    if (lvl === "auto" || !thinkingLevelMap) return lvl;
    return thinkingLevelMap[lvl] ?? lvl;
  })();
  const toolPresetLabel = Object.entries(TOOL_PRESET_MAP).find(([, v]) => v === (toolPreset ?? "default"))?.[0] ?? "default";

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        modelDropdownPanelRef.current && !modelDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
        setModelFilter("");
      }
      if (toolDropdownRef.current && !toolDropdownRef.current.contains(e.target as Node)) {
        setToolDropdownOpen(false);
      }
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(e.target as Node)) {
        setThinkingDropdownOpen(false);
      }
      if (controlsMenuRef.current && !controlsMenuRef.current.contains(e.target as Node)) {
        setControlsMenuOpen(false);
      }
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target as Node) && !textareaRef.current?.contains(e.target as Node)) {
        setHistoryMenuOpen(false);
      }
      if (
        trashOpen &&
        trashPanelRef.current && !trashPanelRef.current.contains(e.target as Node) &&
        trashButtonRef.current && !trashButtonRef.current.contains(e.target as Node)
      ) {
        setTrashOpen(false);
        setPurgeConfirmId(null);
        setPurgeAllConfirm(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [trashOpen]);

  // Clear the undo-toast timer on unmount so a late timeout cannot touch state.
  useEffect(() => () => {
    if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
  }, []);

  useEffect(() => {
    if (!isMobile) setControlsMenuOpen(false);
  }, [isMobile]);



  return (
    <div
      style={{
        position: "relative",
        flexShrink: 0,
        background: "transparent",
        padding: "0 16px 8px",
        paddingRight: isMobile ? 16 : 52, // desktop: 16px base + 36px for ChatMinimap alignment
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      {/* Swipe direction hint (mobile) */}
      {swipeHint && (
        <div style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: "calc(100% - 6px)",
          display: "flex",
          justifyContent: "center",
          pointerEvents: "none",
          zIndex: 70,
        }}>
          <div style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "4px 10px",
            borderRadius: 999,
            background: "color-mix(in srgb, var(--bg-panel) 92%, var(--bg))",
            border: "1px solid var(--border)",
            boxShadow: "0 4px 14px rgba(0,0,0,0.12)",
            fontSize: 11.5,
            color: "var(--text)",
            whiteSpace: "nowrap",
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: swipeHint === "down" ? "rotate(180deg)" : undefined }}>
              <polyline points="6 15 12 9 18 15" />
            </svg>
            {swipeHint === "down" ? t("chat.swipeCollapse") : t("chat.swipeExpand")}
          </div>
        </div>
      )}
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processImageFiles(files);
          e.target.value = "";
        }}
      />
      {/* Hidden queue-import file input */}
      <input
        ref={queueImportFileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file || !onStageImport) return;
          try {
            const entries = parseQueueImport(await file.text());
            if (entries.length === 0) {
              showQueueNotice(t("chat.queueImportEmpty"), false);
              return;
            }
            const staged = await onStageImport(entries);
            if (staged !== null && staged > 0) {
              showQueueNotice(t("chat.queueImported", { count: String(staged) }), true);
            }
          } catch {
            showQueueNotice(t("chat.queueImportEmpty"), false);
          }
        }}
      />
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        <ModelErrorBanner error={modelError} />
        <ModelScopeWarningBanner warnings={modelScopeWarnings} />
        {/* Queue import/export feedback — rendered outside the banner so it is
            visible even when the queue is empty (import history entry point). */}
        {queueNotice && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
            <span style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              color: queueNotice.ok ? "#16a34a" : "#ef4444",
              whiteSpace: "nowrap",
            }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                {queueNotice.ok
                  ? <><polyline points="20 6 9 17 4 12" /></>
                  : <><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>}
              </svg>
              {queueNotice.text}
            </span>
          </div>
        )}
        {/* Queued steering / follow-up messages (delivered by pi on upcoming turns).
            Also shown (slim header) when only the trash has entries, so the
            trash bin stays reachable after the last queued message is deleted. */}
        {bottomMode === "full" && (queueCount > 0 || trashCount > 0) && (
          <div style={{
            position: "relative",
            marginBottom: 8,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            padding: "5px 0",
          }}>
          <div style={{
            display: "flex",
            flexDirection: isMobile ? "column" : "row",
            alignItems: isMobile ? "stretch" : "center",
            justifyContent: "space-between",
            gap: isMobile ? 2 : 8,
            padding: isMobile ? "6px 10px 4px" : "2px 10px 2px",
          }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minHeight: 24,
            }}>
              {queueCount > 0 && (
              <button
                onClick={toggleQueueCollapsed}
                title={queueCollapsed ? t("chat.queueExpand") : t("chat.queueCollapse")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "4px 6px",
                  border: "none",
                  background: "transparent",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  borderRadius: 5,
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ transition: "transform 0.12s", transform: queueCollapsed ? "rotate(-90deg)" : undefined, flexShrink: 0 }}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
                {/* Queued-count label next to the collapse button so the header
                    is not a lone chevron on any screen size. */}
                <span style={{ fontSize: 11.5, color: "var(--text-dim)", whiteSpace: "nowrap", lineHeight: 1 }}>
                  {t("chat.queued", { count: String(queueCount) })}
                </span>
              </button>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end", marginTop: isMobile ? 2 : 0 }}>
                {onRecallQueue && (
                  <button
                    onClick={onRecallQueue}
                    title={t("chat.recallTitle")}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "3px 10px",
                      fontSize: 12,
                      color: "var(--text)",
                      background: "transparent",
                      border: "1px solid var(--border)",
                      borderRadius: 7,
                      cursor: "pointer",
                      transition: "background 0.12s, border-color 0.12s",
                      whiteSpace: "nowrap",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 45%, var(--border))";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                      e.currentTarget.style.borderColor = "var(--border)";
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 14 4 9 9 4" />
                      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                    </svg>
                    {t("chat.recall")}
                  </button>
                )}
                {(onExportQueue || onImportQueue) && (
                  <>
                    {onExportQueue && (
                      <button
                        title={t("chat.queueExport")}
                        onClick={async () => {
                          const data = await onExportQueue();
                          if (!data) return;
                          downloadQueueExport(data.live, { source: "live" }, "json");
                          showQueueNotice(
                            t("chat.queueExported", {
                              count: String((queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0)),
                            }),
                            true,
                          );
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "3px 10px",
                          fontSize: 12,
                          color: "var(--text)",
                          background: "transparent",
                          border: "1px solid var(--border)",
                          borderRadius: 7,
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        {t("chat.queueExport")}
                      </button>
                    )}
                    {onImportQueue && (
                      <button
                        title={t("chat.queueImport")}
                        onClick={() => queueImportFileRef.current?.click()}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "3px 10px",
                          fontSize: 12,
                          color: "var(--text)",
                          background: "transparent",
                          border: "1px solid var(--border)",
                          borderRadius: 7,
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="17 8 12 3 7 8" />
                          <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                        {t("chat.queueImport")}
                      </button>
                    )}
                  </>
                )}
                {trashCount > 0 && onPurgeQueueTrash && (
                  <button
                    ref={trashButtonRef}
                    title={t("chat.queueTrashTitle")}
                    onClick={() => { setTrashOpen((v) => !v); setPurgeConfirmId(null); setPurgeAllConfirm(false); }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "3px 10px",
                      fontSize: 12,
                      color: trashOpen ? "var(--accent)" : "var(--text)",
                      background: trashOpen ? "var(--bg-hover)" : "transparent",
                      border: "1px solid var(--border)",
                      borderRadius: 7,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                    {t("chat.queueTrash")}
                    <span style={{
                      fontSize: 10,
                      color: "var(--text-muted)",
                      background: "var(--bg-hover)",
                      border: "1px solid var(--border)",
                      padding: "0 6px",
                      borderRadius: 999,
                      lineHeight: "15px",
                    }}>
                      {trashCount}
                    </span>
                  </button>
                )}
              </div>
          </div>
          {queueCollapsed && queueCount > 0 && (
            <div
              onClick={toggleQueueCollapsed}
              title={t("chat.queueExpand")}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleQueueCollapsed();
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                margin: "0 6px 4px",
                padding: "3px 6px",
                borderRadius: 6,
                fontSize: 11.5,
                color: "var(--text-dim)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                cursor: "pointer",
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "";
                e.currentTarget.style.color = "var(--text-dim)";
              }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: "rotate(-90deg)" }}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>
                {(queuedMessages?.steering?.[0] ?? queuedMessages?.followUp?.[0] ?? "")}
              </span>
              {queueCount > 1 && (
                <span style={{
                  flexShrink: 0,
                  fontSize: 10,
                  color: "var(--text-muted)",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  padding: "0 6px",
                  borderRadius: 999,
                  lineHeight: "16px",
                }}>
                  +{queueCount - 1}
                </span>
              )}
              {/* First message is a follow-up: expose a steer-send button right in
                  the collapsed bar (same action as the row button), always
                  clickable without expanding. */}
              {!queuedMessages?.steering?.[0] && queuedMessages?.followUp?.[0] && (
                <button
                  aria-label="queueSteerSendFirst"
                  title={t("chat.queueSteerSend")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onQueueSteerSend?.(queuedMessages?.followUp?.[0] ?? "");
                    void handleRemoveQueueItem("followUp", 0, { permanent: true });
                  }}
                  style={{
                    flexShrink: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 20,
                    height: 20,
                    padding: 0,
                    border: "none",
                    borderRadius: 5,
                    background: "transparent",
                    color: "rgba(180,130,0,1)",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(234,179,8,0.12)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14" /><polyline points="12 5 19 12 12 19" />
                  </svg>
                </button>
              )}
            </div>
          )}
            {!queueCollapsed && queuedMessages?.steering.map((text, i) => (
              <QueuedMessageRow
                key={`steer-${i}`}
                kind="steer"
                text={text}
                index={i}
                total={queuedMessages?.steering.length ?? 0}
                onMove={(dir) => void handleMoveQueue("steer", i, dir)}
                onRecall={() => void handleRecallOne("steer", i)}
                onRemove={() => void handleRemoveQueueItem("steer", i)}
                onConvertToFollowUp={() => void onConvertQueueItem?.("steer", i, "followUp")}
                onDragStart={(idx) => handleDragStart("steer", idx)}
                onDragOver={(idx) => handleDragOver("steer", idx)}
                onDrop={(idx) => handleDrop("steer", idx)}
                onTouchMoveTo={(to) => void handleMoveQueue("steer", i, (to - i) as 1 | -1)}
                dragging={dragOverIndex?.kind === "steer" && dragOverIndex.index === i}
              />
            ))}
            {!queueCollapsed && queuedMessages?.followUp.map((text, i) => (
              <QueuedMessageRow
                key={`followup-${i}`}
                kind="follow-up"
                text={text}
                index={i}
                total={queuedMessages?.followUp.length ?? 0}
                onMove={(dir) => void handleMoveQueue("followUp", i, dir)}
                onRecall={() => void handleRecallOne("followUp", i)}
                onRemove={() => void handleRemoveQueueItem("followUp", i)}
                onSteerSend={() => { onQueueSteerSend?.(text); void handleRemoveQueueItem("followUp", i, { permanent: true }); }}
                onDragStart={(idx) => handleDragStart("followUp", idx)}
                onDragOver={(idx) => handleDragOver("followUp", idx)}
                onDrop={(idx) => handleDrop("followUp", idx)}
                onTouchMoveTo={(to) => void handleMoveQueue("followUp", i, (to - i) as 1 | -1)}
                dragging={dragOverIndex?.kind === "followUp" && dragOverIndex.index === i}
              />
            ))}
          {lastDeleted && !trashOpen && onRestoreQueueItem && (
            <div style={{
              position: "absolute",
              bottom: "calc(100% + 6px)",
              right: 8,
              zIndex: 55,
              display: "flex",
              alignItems: "center",
              gap: 8,
              maxWidth: "calc(100% - 16px)",
              padding: "5px 8px 5px 10px",
              background: "var(--bg-panel)",
              border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
              borderRadius: 7,
              boxShadow: "0 6px 20px rgba(0,0,0,0.3)",
              fontSize: 11.5,
              color: "var(--text)",
            }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }}>
                {t("chat.queueUndoDeleted")}{lastDeleted.text ? `: ${lastDeleted.text}` : ""}
              </span>
              <button
                onClick={() => void handleUndoDelete()}
                title={t("chat.queueUndoTitle")}
                style={{
                  flexShrink: 0,
                  border: "none",
                  background: "transparent",
                  color: "var(--accent)",
                  cursor: "pointer",
                  fontSize: 11.5,
                  fontWeight: 600,
                  padding: "2px 6px",
                  borderRadius: 5,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                {t("chat.queueUndo")}
              </button>
            </div>
          )}
          {trashOpen && onPurgeQueueTrash && (
            <div ref={trashPanelRef} style={{
              position: "absolute",
              bottom: "calc(100% + 6px)",
              right: 8,
              width: "min(430px, calc(100% - 16px))",
              zIndex: 50,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
              padding: 8,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px 6px" }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)", flex: 1 }}>
                  {t("chat.queueTrashCount", { count: String(trashCount) })}
                </span>
                <button
                  onClick={() => { setTrashOpen(false); resetTrashConfirms(); }}
                  title={t("chat.close")}
                  style={{ border: "none", background: "transparent", color: "var(--text-dim)", cursor: "pointer", padding: 2, display: "flex", borderRadius: 4 }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
              {trashCount === 0 ? (
                <div style={{ padding: "14px 6px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
                  {t("chat.queueTrashEmpty")}
                </div>
              ) : (
                <div style={{ maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                  {(queueTrash ?? []).map((item) => (
                    <div
                      key={item.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "4px 6px",
                        borderRadius: 6,
                        background: "transparent",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <span style={{
                        flexShrink: 0,
                        fontSize: 9.5,
                        textTransform: "uppercase",
                        letterSpacing: 0.4,
                        color: "var(--text-muted)",
                        background: "var(--bg-hover)",
                        border: "1px solid var(--border)",
                        borderRadius: 4,
                        padding: "0 5px",
                        lineHeight: "16px",
                      }}>
                        {item.kind === "steer" ? t("chat.queueRecoveryKindSteer") : t("chat.queueRecoveryKindFollowUp")}
                      </span>
                      <span
                        title={item.text || t("chat.queueRecoveryNoText")}
                        style={{
                          flex: 1,
                          fontSize: 11.5,
                          color: "var(--text)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {item.text || t("chat.queueRecoveryNoText")}
                        {item.hasImages && <span style={{ color: "var(--text-dim)", marginLeft: 4 }}>🖼</span>}
                      </span>
                      <button
                        title={t("chat.queueTrashRestore")}
                        onClick={() => void handleRestoreTrashItem(item)}
                        style={{
                          flexShrink: 0,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          border: "1px solid var(--border)",
                          background: "transparent",
                          color: "var(--text)",
                          borderRadius: 6,
                          padding: "2px 8px",
                          fontSize: 11,
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 14 4 9 9 4" />
                          <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                        </svg>
                        {t("chat.queueTrashRestore")}
                      </button>
                      {purgeConfirmId === item.id ? (
                        <button
                          onClick={() => void handlePurgeTrashItem(item.id)}
                          style={{
                            flexShrink: 0,
                            border: "1px solid #ef4444",
                            background: "rgba(239,68,68,0.12)",
                            color: "#ef4444",
                            borderRadius: 6,
                            padding: "2px 8px",
                            fontSize: 11,
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {t("chat.confirm")}
                        </button>
                      ) : (
                        <button
                          title={t("chat.queueTrashPurge")}
                          onClick={() => {
                            setPurgeConfirmId(item.id);
                            setTimeout(() => setPurgeConfirmId((cur) => (cur === item.id ? null : cur)), 3000);
                          }}
                          style={{
                            flexShrink: 0,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 24,
                            height: 24,
                            border: "none",
                            background: "transparent",
                            color: "var(--text-dim)",
                            borderRadius: 5,
                            cursor: "pointer",
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            <line x1="10" y1="11" x2="10" y2="17" />
                            <line x1="14" y1="11" x2="14" y2="17" />
                          </svg>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end", paddingTop: 6, borderTop: "1px solid var(--border)", marginTop: 6 }}>
                <button
                  onClick={() => void handleRestoreAllTrash()}
                  disabled={trashCount === 0}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    border: "1px solid var(--border)",
                    background: "transparent",
                    color: "var(--text)",
                    borderRadius: 6,
                    padding: "3px 10px",
                    fontSize: 11.5,
                    cursor: trashCount === 0 ? "default" : "pointer",
                    opacity: trashCount === 0 ? 0.5 : 1,
                    whiteSpace: "nowrap",
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 14 4 9 9 4" />
                    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                  </svg>
                  {t("chat.queueTrashRestoreAll")}
                </button>
                {purgeAllConfirm ? (
                  <button
                    onClick={() => void handlePurgeAllTrash()}
                    style={{
                      border: "1px solid #ef4444",
                      background: "rgba(239,68,68,0.12)",
                      color: "#ef4444",
                      borderRadius: 6,
                      padding: "3px 10px",
                      fontSize: 11.5,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t("chat.queueTrashPurgeAllConfirm")}
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      setPurgeAllConfirm(true);
                      setTimeout(() => setPurgeAllConfirm(false), 3000);
                    }}
                    disabled={trashCount === 0}
                    title={t("chat.queueTrashPurgeAll")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      border: "1px solid var(--border)",
                      background: "transparent",
                      color: "var(--text-dim)",
                      borderRadius: 6,
                      padding: "3px 10px",
                      fontSize: 11.5,
                      cursor: trashCount === 0 ? "default" : "pointer",
                      opacity: trashCount === 0 ? 0.5 : 1,
                      whiteSpace: "nowrap",
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                    {t("chat.queueTrashPurgeAll")}
                  </button>
                )}
              </div>
            </div>
          )}
          </div>
        )}
        {/* Retry banner */}
        {retryInfo && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.25)",
            borderRadius: 6, fontSize: 12, color: "rgba(180,130,0,0.9)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
             {t("chat.retrying", { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })}{retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {compactResultText && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.24)",
            borderRadius: 6, fontSize: 12, color: "rgba(5,150,105,0.95)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {compactResultText}
          </div>
        )}
        {compactError && (
          <div
            role="alert"
            style={{
              marginBottom: 8,
              padding: "7px 10px",
              background: "rgba(239,68,68,0.07)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 6,
              color: "#ef4444",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {compactError}
          </div>
        )}
        {/* Image previews */}
        {attachedImages.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedImages.map((img, i) => (
              <div key={i} style={{ position: "relative", flexShrink: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.previewUrl}
                  alt=""
                  style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                />
                <button
                  onClick={() => removeImage(i)}
                  style={{
                    position: "absolute", top: -4, right: -4,
                    width: 16, height: 16, borderRadius: "50%",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                  }}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Main input */}
        <div style={{ position: "relative", minWidth: 0 }}>
          {historyMenuOpen && inputHistory.length > 0 && (
            <div
              ref={historyMenuRef}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                overflow: "hidden",
                maxHeight: "min(44vh, 360px)",
              }}
            >
              <div
                title="Input history"
                style={{
                  height: 30,
                  padding: "0 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  color: "var(--text-dim)",
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </div>
              <div style={{ maxHeight: "calc(min(44vh, 360px) - 31px)", overflowY: "auto", padding: 4 }}>
                {inputHistory.map((item, index) => {
                  const active = index === historyActiveIndex;
                  return (
                    <button
                      key={`${index}:${item}`}
                      ref={(node) => {
                        historyItemRefs.current[index] = node;
                      }}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyHistoryInput(item);
                      }}
                      onMouseEnter={() => setHistoryActiveIndex(index)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        padding: "7px 8px",
                        border: "none",
                        borderRadius: 6,
                        background: active ? "var(--bg-selected)" : "none",
                        color: "var(--text)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12.5,
                        lineHeight: 1.45,
                      }}
                    >
                      <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", paddingTop: 1 }}>
                        {index + 1}
                      </span>
                      <span style={{ minWidth: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", overflowWrap: "anywhere" }}>
                        {item}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {slashMenuOpen && slashQuery !== null && (
            <div
              ref={slashMenuRef}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                overflow: "hidden",
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                maxHeight: slashMenuMaxHeight === null
                  ? "min(72.8vh, 598px)"
                  : `min(72.8vh, 598px, ${slashMenuMaxHeight}px)`,
              }}
            >
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 11,
                  color: "var(--text-dim)",
                  flexShrink: 0,
                }}
              >
                 <span>{slashCommandsLoading ? t("chat.loadingCommands") : t("chat.slashCommands", { label: slashCommandCountLabel })}</span>
                 <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
              </div>
              <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 10 }}>
                {!slashCommandsLoading && filteredSlashCommands.length === 0 ? (
                  <div style={{ padding: "2px 2px 4px", fontSize: 12, color: "var(--text-dim)" }}>
                     {t("chat.noCommands")}
                  </div>
                ) : (
                  groupedSlashCommands.map((group) => (
                    <section key={group.source} style={{ marginBottom: 12 }}>
                      <div
                        style={{
                          position: "sticky",
                          top: -10,
                          zIndex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "4px 0 6px",
                          background: "var(--bg)",
                          color: "var(--text-dim)",
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: "uppercase",
                        }}
                      >
                           <span>{t(SLASH_SOURCE_GROUP_LABEL_KEYS[group.source])}</span>
                        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>{group.items.length}</span>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                          gap: 8,
                        }}
                      >
                        {group.items.map(({ command, index }) => {
                          const active = index === slashActiveIndex;
                          const dormant = isDormantSkillCommand(command, skillDormancy);
                          return (
                            <button
                              key={`${command.source}:${command.name}`}
                              ref={(node) => {
                                slashItemRefs.current[index] = node;
                              }}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                applySlashCommand(command);
                              }}
                              onMouseEnter={() => setSlashActiveIndex(index)}
                              style={{
                                width: "100%",
                                minWidth: 0,
                                minHeight: 58,
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                                justifyContent: "center",
                                padding: "9px 10px",
                                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                                borderRadius: 7,
                                background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                                color: "var(--text)",
                                cursor: "pointer",
                                textAlign: "left",
                                boxShadow: active ? "0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)" : "none",
                              }}
                            >
                              <span style={{
                                fontSize: 13,
                                fontFamily: "var(--font-mono)",
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                color: dormant ? "var(--text-dim)" : undefined,
                              }}>
                                /{command.name}
                                {dormant && (
                                  <span style={{
                                    marginLeft: 6,
                                    padding: "0 4px",
                                    border: "1px solid var(--border)",
                                    borderRadius: 3,
                                    fontSize: 9,
                                    color: "var(--text-dim)",
                                    whiteSpace: "nowrap",
                                  }}>
                                    {t("chat.dormant")}
                                  </span>
                                )}
                              </span>
                               {command.description && (
                                <span style={{
                                  display: "-webkit-box",
                                  WebkitBoxOrient: "vertical",
                                  WebkitLineClamp: 2,
                                  overflow: "hidden",
                                  fontSize: 11,
                                  lineHeight: 1.35,
                                  color: "var(--text-dim)",
                                }}>
                                   {getSlashDescription(command, t)}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
          {atMenuOpen && atQuery !== null && (() => {
            const indexLoading = fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd);
             const matchCountLabel = atMatches.length === 1 ? t("chat.match") : t("chat.matches", { count: atMatches.length });
            // With a truncated index, local results are provisional — the
            // debounced server search over the full listing replaces them.
            const truncatedHint = fileIndex?.truncated && !serverResultInUse
               ? (atQuery.query ? t("chat.searchingAll") : t("chat.indexTruncated"))
              : "";
            return (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: "calc(100% + 8px)",
                  zIndex: 120,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                  overflow: "hidden",
                  maxHeight: "min(48vh, 400px)",
                }}
              >
                <div
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    color: "var(--text-dim)",
                  }}
                >
                  <span>
                    {indexLoading
                       ? t("chat.loadingFiles")
                       : t("chat.files", { label: matchCountLabel, hint: truncatedHint })}
                  </span>
                   <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
                </div>
                <div style={{ maxHeight: "calc(min(48vh, 400px) - 34px)", overflowY: "auto", padding: 4 }}>
                  {!indexLoading && atMatches.length === 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>
                       {needsServerSearch && !serverResultInUse ? t("chat.searching") : t("chat.noMatchingFiles")}
                    </div>
                  ) : (
                    atMatches.map((entry, index) => {
                      const active = index === atActiveIndex;
                      const name = entry.path.split("/").pop() ?? entry.path;
                      const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
                      return (
                        <button
                          key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                          ref={(node) => {
                            atItemRefs.current[index] = node;
                          }}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyAtCompletion(entry);
                          }}
                          onMouseEnter={() => setAtActiveIndex(index)}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px",
                            border: "none",
                            borderRadius: 6,
                            background: active ? "var(--bg-selected)" : "none",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                            {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {dirPrefix && <span style={{ color: "var(--text-dim)" }}>{dirPrefix}</span>}
                            {name}
                            {entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}
          {bottomMode !== "minimal" && recalledVisible && recalledRef.current && (
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 6,
              padding: "6px 10px",
              borderRadius: 8,
              fontSize: 12,
              color: "var(--text-muted)",
              background: "color-mix(in srgb, var(--accent) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--accent) 30%, var(--border))",
              flexWrap: "wrap",
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--accent)" }}>
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              <span style={{ minWidth: 0, flex: 1 }}>
                {t("chat.recalledEditing", { pos: String(recalledRef.current.index + 1) })}
              </span>
              <button
                onClick={() => void handleSend()}
                title={t("chat.recalledRequeue")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "3px 10px",
                  borderRadius: 6,
                  border: "1px solid color-mix(in srgb, var(--accent) 50%, var(--border))",
                  background: "var(--accent)",
                  color: "#fff",
                  fontSize: 11.5,
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {t("chat.recalledRequeue")}
              </button>
              <button
                onClick={cancelRecall}
                title={t("chat.recalledCancel")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "3px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-muted)",
                  fontSize: 11.5,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {t("chat.recalledCancel")}
              </button>
            </div>
          )}
          {bottomMode === "minimal" ? (
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 8,
              minHeight: 44,
              paddingRight: 4,
            }}>
              {queueCount > 0 && (
                <button
                  onClick={() => cycleBottomMode()}
                  title={t("chat.restoreBottom")}
                  style={{
                    fontSize: 11,
                    color: "var(--text-dim)",
                    whiteSpace: "nowrap",
                    background: "none",
                    border: "none",
                    padding: "4px 6px",
                    borderRadius: 6,
                    cursor: "pointer",
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "none";
                    e.currentTarget.style.color = "var(--text-dim)";
                  }}
                >
                  {t("chat.queued", { count: String(queueCount) })}
                </button>
              )}
              <BottomModeBar mode="minimal" onClick={() => cycleBottomMode()} height={44} count={queueCount} />
            </div>
          ) : (
          <div
            ref={inputRowRef}
            style={{
              minWidth: 0,
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
              background: "var(--bg)",
              border: `1px solid ${bashMode ? "var(--tool-bg)" : isStreaming && (onSteer || onFollowUp)
                ? "rgba(234,179,8,0.4)"
                : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
              borderRadius: 14,
              padding: "10px 10px 10px 14px",
              boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
            } as React.CSSProperties}
          >
          <ExtSlot name="chatInputTop" extra={{ inputValue: value }} />
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              valueRef.current = e.target.value;
              setValue(e.target.value);
              setHistoryMenuOpen(false);
              updateAtQuery(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onInput={handleInput}
            onFocus={handleFocus}
            onPaste={handlePaste}
            placeholder={
              isStreaming && (onSteer || onFollowUp)
                ? t("chat.steerPlaceholder")
                : isStreaming ? t("chat.agentPlaceholder")
                : t("chat.messagePlaceholder")
            }
            rows={1}
            style={{
              flex: buttonsWrapped ? "1 1 100%" : "1 1 0",
              minWidth: 0,
              background: "none",
              border: "none",
              outline: "none",
              resize: "none",
              color: "var(--text)",
              fontSize: 14,
              lineHeight: 1.6,
              fontFamily: "inherit",
              minHeight: 24,
              maxHeight: 200,
              overflow: "auto",
            }}
          />

          {isStreaming ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, alignSelf: "flex-end", marginLeft: "auto" }}>
              {onSteer && (
                <StreamingActionButton
                  label={t("chat.steer")}
                  hint={queueDisabledImages ? t("chat.imagesCannotQueue")
                    : canSteerFromQueue ? t("chat.steerFromQueueHint")
                    : queueDisabledNoInput ? t("chat.steerNoInput")
                    : t("chat.steerHint")}
                  disabled={!canQueueStreamingMessage && !canSteerFromQueue}
                  onClick={() => sendQueued("steer")}
                  bg="rgba(234,179,8,0.12)"
                  border="rgba(234,179,8,0.35)"
                  fg="rgba(180,130,0,1)"
                >
                  <svg width="13" height="13" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 1 L9 5 L5 9" /><line x1="1" y1="5" x2="9" y2="5" />
                  </svg>
                </StreamingActionButton>
              )}
              {/* follow-up：小屏空输入时隐藏（换成 Stop）；大屏始终显示（空输入灰掉）。 */}
              {onFollowUp && (hasInputText || !isMobile) && (
                <StreamingActionButton
                  label={t("chat.followUp")}
                  hint={queueDisabledImages ? t("chat.imagesCannotQueue")
                    : queueDisabledNoInput ? t("chat.followUpNoInput")
                    : t("chat.followUpHint")}
                  disabled={!canQueueStreamingMessage}
                  onClick={() => sendQueued("followup")}
                  bg="rgba(129,140,248,0.16)"
                  border="rgba(129,140,248,0.45)"
                  fg="rgba(99,102,241,1)"
                >
                  <svg width="13" height="13" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="2" y1="1.5" x2="8" y2="1.5" />
                    <path d="M2 1.5 L2 2.5 L5 5 L2 7.5 L2 8.5" />
                    <path d="M8 1.5 L8 2.5 L5 5 L8 7.5 L8 8.5" />
                    <line x1="2" y1="8.5" x2="8" y2="8.5" />
                  </svg>
                </StreamingActionButton>
              )}
              {/* 输入框无消息时 follow-up 隐藏——小屏（底部工具栏被折叠）时换成 Stop 按钮；
                  大屏底部工具栏恒有 Stop，无需重复。 */}
              {!hasInputText && onAbort && isMobile && (
                <StreamingActionButton
                  label={t("chat.stop")}
                  hint={t("chat.stopAgent")}
                  onClick={onAbort}
                  bg="rgba(239,68,68,0.1)"
                  border="rgba(239,68,68,0.35)"
                  fg="#ef4444"
                >
                  <svg width="11" height="11" viewBox="0 0 10 10" fill="none">
                    <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                  </svg>
                </StreamingActionButton>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, alignSelf: "flex-end", marginLeft: "auto" }}>
              {/* 继续：AI 完全停止（无任何 streaming）且输入框为空时出现——点击快速发送
                  “继续”，触发 agent 继续运行（streaming 中无意义——agent 本来就在工作）。
                  队列非空（如重启后恢复了队列但未继续）时同样显示：点击投递整个队列。 */}
              {onContinue && canContinue && !hasInputText && !attachedImages.length && (
                <StreamingActionButton
                  label={t("chat.continue")}
                  hint={t(queueCount > 0 ? "chat.continueQueueHint" : "chat.continueHint")}
                  onClick={onContinue}
                  bg="rgba(16,185,129,0.14)"
                  border="rgba(16,185,129,0.4)"
                  fg="rgba(5,150,105,1)"
                >
                  <svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="1.5 2.5 5.5 6 1.5 9.5" />
                    <polyline points="6.5 2.5 10.5 6 6.5 9.5" />
                  </svg>
                </StreamingActionButton>
              )}
              <button
              onClick={handleSend}
              disabled={!value.trim() && !attachedImages.length}
              style={{
                flexShrink: 0,
                alignSelf: "flex-end",
                marginLeft: "auto",
                display: "flex", alignItems: "center", gap: isMobile ? 7 : 6,
                padding: isMobile ? "8px 17px" : "7px 14px",
                background: (value.trim() || attachedImages.length) ? "var(--accent)" : "var(--bg-panel)",
                border: "none",
                borderRadius: isMobile ? 10 : 8,
                color: (value.trim() || attachedImages.length) ? "#fff" : "var(--text-dim)",
                cursor: (value.trim() || attachedImages.length) ? "pointer" : "not-allowed",
                fontSize: isMobile ? 16 : 13,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                boxShadow: (value.trim() || attachedImages.length) ? "0 1px 3px rgba(37,99,235,0.25)" : "none",
                transition: "background 0.15s, box-shadow 0.15s",
              }}
            >
              <svg width={isMobile ? 17 : 14} height={isMobile ? 17 : 14} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="2" y1="7" x2="11" y2="7" />
                <polyline points="7.5 3 12 7 7.5 11" />
              </svg>
              {!queueButtonsCollapsed && t("chat.send")}
            </button>
            </div>
          )}
          </div>
          )}
        </div>

        {/* Bash mode status label */}
        {bottomMode !== "minimal" && bashMode && (
          <div className="text-xs px-2 py-1" style={{ color: bashExcluded ? "var(--text-muted)" : "var(--accent)", marginTop: 4 }}>
             {t("chat.shell")} · {bashExcluded ? t("chat.outputLocal") : t("chat.outputModel")}
          </div>
        )}

        {/* Bottom bar: left | center (context) | right */}
        {bottomMode !== "minimal" && (
        <div style={{
          marginTop: 8,
          display: isMobile ? "grid" : "flex",
          gridTemplateColumns: isMobile ? "minmax(0, 1fr) auto" : undefined,
          alignItems: "center",
          gap: 6,
        }}>

          {/* LEFT: attach + model selector (idle) or steer/followup toggle (streaming) */}
          <div style={{ flex: isMobile ? "1 1 auto" : "0 0 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 2 }}>
            <button
              onClick={() => fileInputRef.current?.click()}
             title={t("chat.attachImage")}
              style={{
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                width: 32, height: 32, padding: 0,
                background: "none", border: "none",
                borderRadius: 9,
                color: attachedImages.length ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
                opacity: 1,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = attachedImages.length ? "var(--accent)" : "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "none";
                e.currentTarget.style.color = attachedImages.length ? "var(--accent)" : "var(--text-muted)";
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
            {/* Model selector — visible always; only locked while a switch request is in flight. Streaming stays clickable: switching mid-run applies next turn (modelSwitchPending badge). */}
            {(modelOptions.length > 0 || currentName || modelError) && onModelChange && (
                <div ref={dropdownRef} style={{ position: "relative", flex: isMobile ? "1 1 auto" : undefined, minWidth: 0 }}>
                  <button
                    onClick={(e) => {
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setModelDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                      setModelDropdownOpen((open) => {
                        if (open) setModelFilter("");
                        return !open;
                      });
                    }}
                    disabled={modelSwitching}
                    aria-busy={modelSwitching || undefined}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      justifyContent: isMobile ? "flex-start" : undefined,
                      padding: isMobile ? "8px 10px" : "8px 12px",
                      height: 32,
                      width: isMobile ? "100%" : undefined,
                      maxWidth: isMobile ? "100%" : 220,
                      overflow: "hidden",
                      background: modelDropdownOpen ? "var(--bg-hover)" : "none",
                      border: "none",
                      borderRadius: 9,
                      color: "var(--text-muted)",
                      cursor: modelSwitching ? "not-allowed" : "pointer",
                      fontSize: 12,
                      opacity: 1,
                      transition: "background 0.12s, color 0.12s",
                    }}
                    onMouseEnter={(e) => {
                      if (modelSwitching) return;
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.color = "var(--text)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = modelDropdownOpen ? "var(--bg-hover)" : "none";
                      e.currentTarget.style.color = "var(--text-muted)";
                    }}
                    title={modelSwitching || isStreaming ? t("chat.modelSwitchStreaming") : modelOptions.length > 0 ? t("chat.changeModel") : t("chat.noModels")}
                  >
                    {modelSwitching ? (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} aria-hidden="true">
                        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                      </svg>
                    ) : (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="4" y="4" width="16" height="16" rx="2" />
                        <rect x="9" y="9" width="6" height="6" />
                        <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                        <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                        <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                        <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                      </svg>
                    )}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                      {currentName ?? (modelOptions.length > 0 ? "Select model" : "No models")}
                    </span>
                    {modelSwitchPending && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0, marginLeft: 4, fontSize: 10, color: "#d97706", whiteSpace: "nowrap", fontWeight: 600 }}>
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                        {t("chat.modelSwitchPendingBadge")}
                      </span>
                    )}
                  </button>
                  {modelDropdownOpen && modelDropdownRect && (() => {
                    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
                    const bottom = viewportHeight - modelDropdownRect.top + 6;
                    const maxH = Math.max(120, Math.min(modelDropdownRect.top - 8, viewportHeight * 0.6));
                    // On mobile, pin to a small left margin and cap width to the
                    // viewport so long model names never push the panel off-screen.
                    const panelPos: React.CSSProperties = isMobile
                      ? { left: 8, right: 8, maxWidth: "calc(100vw - 16px)" }
                      : { left: modelDropdownRect.left, width: "max-content", minWidth: modelDropdownRect.width };
                    return (
                      <div ref={modelDropdownPanelRef} style={{
                      position: "fixed",
                      bottom,
                      ...panelPos,
                      zIndex: 500, background: "var(--bg)", border: "1px solid var(--border)",
                      borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                      overflow: "hidden", maxHeight: maxH, display: "flex", flexDirection: "column",
                      }}>
                      {showModelFilter && (
                        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
                          <input
                            value={modelFilter}
                            onChange={(e) => setModelFilter(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                setModelFilter("");
                                setModelDropdownOpen(false);
                              }
                            }}
                            placeholder={t("chat.filterModels")}
                            aria-label={t("chat.filterModels")}
                            autoFocus
                            autoComplete="off"
                            spellCheck={false}
                            style={{
                              width: "100%",
                              minWidth: isMobile ? 0 : 220,
                              fontSize: 11,
                              fontFamily: "var(--font-mono)",
                              padding: "5px 8px",
                              border: "1px solid var(--border)",
                              borderRadius: 5,
                              outline: "none",
                              background: "var(--bg)",
                              color: "var(--text)",
                              boxSizing: "border-box",
                            }}
                          />
                        </div>
                      )}
                      <div style={{ minHeight: 0, overflowY: "auto" }}>
                        {modelsByProvider.length === 0 ? (
                          <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 12, whiteSpace: "nowrap" }}>
                            {modelFilter.trim() ? t("chat.noMatchingModels") : "No available models"}
                          </div>
                        ) : modelsByProvider.map((group, gi) => (
                          <div key={group.provider}>
                            {(modelsByProvider.length > 1) && (
                              <div style={{
                                padding: "6px 12px 4px",
                                fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                                textTransform: "uppercase", letterSpacing: "0.07em",
                                borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                              }}>
                                {group.provider}
                              </div>
                            )}
                            {group.options.map((opt) => {
                              const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                              return (
                                <button
                                  key={`${opt.provider}:${opt.modelId}`}
                                  onClick={() => {
                                    setModelDropdownOpen(false);
                                    setModelFilter("");
                                    if (!isActive || isAutoModelSelection) onModelChange(opt.provider, opt.modelId);
                                  }}
                                  style={{
                                    display: "flex", alignItems: "center", gap: 8,
                                    width: "100%", padding: "7px 12px",
                                    background: isActive ? "var(--bg-selected)" : "none",
                                    border: "none",
                                    color: isActive ? "var(--text)" : "var(--text-muted)",
                                    cursor: "pointer", fontSize: 12, textAlign: "left",
                                    fontWeight: isActive ? 600 : 400,
                                    whiteSpace: "nowrap",
                                  }}
                                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                                >
                                  {isActive
                                    ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                                    : <span style={{ width: 10, flexShrink: 0 }} />}
                                  {opt.name}
                                </button>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                    );
                  })()}
                </div>
            )}
          </div>

          {/* spacer */}
          {!isMobile && <div style={{ flex: 1 }} />}

          {/* RIGHT: thinking + tools preset + compact + sound (idle) | Stop + sound (streaming) */}
          <div ref={controlsMenuRef} style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            position: "relative",
            marginLeft: isMobile ? 0 : "auto",
          }}>
            {isMobile && (
              <button
                type="button"
                 title={controlsMenuOpen ? undefined : t("chat.moreControls")}
                 aria-label={t("chat.moreControls")}
                aria-expanded={controlsMenuOpen}
                aria-hidden={controlsMenuOpen || undefined}
                tabIndex={controlsMenuOpen ? -1 : undefined}
                onClick={() => {
                  setModelDropdownOpen(false);
                  setModelFilter("");
                  setControlsMenuOpen(true);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "100%",
                  height: 32,
                  padding: "8px 10px",
                  background: "none",
                  border: "none",
                  borderRadius: 9,
                  color: "var(--text-muted)",
                  cursor: controlsMenuOpen ? "default" : "pointer",
                  fontSize: 12,
                  fontWeight: 500,
                  visibility: controlsMenuOpen ? "hidden" : "visible",
                  pointerEvents: controlsMenuOpen ? "none" : "auto",
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  if (controlsMenuOpen) return;
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                }}
                onMouseLeave={(e) => {
                  if (controlsMenuOpen) return;
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                {t("chat.moreControls")}
              </button>
            )}
            <div style={{
              display: isMobile ? (controlsMenuOpen ? "flex" : "none") : "flex",
              alignItems: "center",
              gap: isMobile ? 1 : 2,
              ...(isMobile ? {
                position: "absolute",
                right: 0,
                bottom: 0,
                zIndex: 60,
                padding: 1,
                width: "max-content",
                maxWidth: "calc(100vw - 32px)",
                flexWrap: "nowrap",
                justifyContent: "flex-end",
                border: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                borderRadius: 10,
                background: "color-mix(in srgb, var(--bg-panel) 92%, var(--bg))",
                boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
                backdropFilter: "blur(10px)",
              } : null),
            }}>
            {!isStreaming && onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} style={{ position: "relative" }}>
                <button
                  onClick={() => !isStreaming && setThinkingDropdownOpen((v) => !v)}
                  disabled={isStreaming}
                   title={t("chat.changeReasoning", { level: thinkingDisplayLabel })}
                   aria-label={t("chat.changeReasoningLabel")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: isMobile ? "0 6px" : "8px 12px",
                    width: isMobile ? "auto" : undefined,
                    height: 32,
                    background: thinkingDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 9,
                    color: "var(--text-muted)",
                    cursor: isStreaming ? "not-allowed" : "pointer",
                    fontSize: 12,
                    opacity: isStreaming ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = thinkingDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                    <line x1="7" y1="18" x2="12" y2="18" />
                    <line x1="8" y1="21" x2="11" y2="21" />
                  </svg>
                  {(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap" }}>{thinkingDisplayLabel}</span>}
                </button>
                {thinkingDropdownOpen && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)",
                    ...(isMobile ? { left: 0 } : { right: 0 }),
                    zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                    overflow: "hidden", minWidth: 180,
                  }}>
                    {THINKING_LEVELS.filter((lvl) => {
                      if (!availableThinkingLevels) return true;
                      if (lvl === "auto") return true;
                      return availableThinkingLevels.includes(lvl);
                    }).map((lvl) => {
                      const isActive = (thinkingLevel ?? "auto") === lvl;
                       const desc = t(THINKING_LEVEL_DESC_KEYS[lvl]);
                      const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                      const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                      const showOriginal = mappedVal != null && mappedVal !== lvl;
                      return (
                        <button
                          key={lvl}
                          onClick={() => { setThinkingDropdownOpen(false); if (!isActive) onThinkingLevelChange(lvl); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "7px 12px",
                            background: isActive ? "var(--bg-selected)" : "none",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>
                            {displayLabel}
                            {showOriginal && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginLeft: 5 }}>({lvl})</span>}
                          </span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {!isStreaming && onToolPresetChange && (
              <div ref={toolDropdownRef} style={{ position: "relative" }}>
                <button
                  onClick={() => !isStreaming && setToolDropdownOpen((v) => !v)}
                  disabled={isStreaming}
                   title={t("chat.changeToolPreset") + `: ${toolPresetLabel}`}
                   aria-label={t("chat.changeToolPreset")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: isMobile ? "0 6px" : "8px 12px",
                    width: isMobile ? "auto" : undefined,
                    height: 32,
                    background: toolDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 9,
                    color: "var(--text-muted)",
                    cursor: isStreaming ? "not-allowed" : "pointer",
                    fontSize: 12,
                    opacity: isStreaming ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = toolDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                  </svg>
                  {(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap" }}>{toolPresetLabel}</span>}
                </button>
                {toolDropdownOpen && (
                  <div style={{
                    position: "absolute",
                    bottom: "calc(100% + 6px)",
                    right: isMobile ? undefined : 0,
                    left: isMobile ? 0 : undefined,
                    zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                    overflow: "hidden", minWidth: 120,
                  }}>
                    {TOOL_PRESETS.map((lvl) => {
                      const preset = TOOL_PRESET_MAP[lvl];
                      const isActive = (toolPreset ?? "default") === preset;
                      let desc: string;
                      if (lvl === "off") desc = t("chat.noTools");
                      else if (lvl === "read-only") desc = t("chat.readOnlyTools", { count: 4 });
                      else if (lvl === "default") desc = t("chat.builtInTools", { count: 4 });
                      else desc = t("chat.allBuiltInTools");
                      return (
                        <button
                          key={lvl}
                          onClick={() => { setToolDropdownOpen(false); if (!isActive) onToolPresetChange(preset); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "7px 12px",
                            background: isActive ? "var(--bg-selected)" : "none",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>{lvl}</span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {onCompact && (
              <div>
                <button
                  onClick={() => {
                    if (isCompacting) onAbortCompaction?.();
                    else if (compactQueued) onCancelCompactQueue?.();
                    else onCompact();
                  }}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: isMobile ? "0 6px" : "8px 12px",
                    width: isMobile ? "auto" : undefined,
                    height: 32,
                    background: isCompacting ? "rgba(239,68,68,0.08)" : compactQueued ? "rgba(217,119,6,0.1)" : "none",
                    border: "none",
                    borderRadius: 9,
                    color: isCompacting ? "#ef4444" : compactQueued ? "#d97706" : "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12, opacity: 1,
                    whiteSpace: "nowrap",
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.16)" : compactQueued ? "rgba(217,119,6,0.2)" : "var(--bg-hover)";
                    e.currentTarget.style.color = isCompacting ? "#ef4444" : compactQueued ? "#d97706" : "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.08)" : compactQueued ? "rgba(217,119,6,0.1)" : "none";
                    e.currentTarget.style.color = isCompacting ? "#ef4444" : compactQueued ? "#d97706" : "var(--text-muted)";
                  }}
                   title={isCompacting ? t("chat.stopCompaction") : compactQueued ? t("chat.cancelCompactQueue") : t("chat.compactContext")}
                   aria-label={isCompacting ? t("chat.stopCompaction") : compactQueued ? t("chat.cancelCompactQueue") : t("chat.compactContext")}
                >
                  {isCompacting ? (
                    <><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" /></svg>{(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap" }}>{t("chat.compacting")}</span>}</>
                  ) : compactQueued ? (
                    <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>{(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap" }}>{t("chat.compactQueued")}</span>}</>
                  ) : (
                    <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
                      <line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" />
                    </svg>{(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap" }}>{t("chat.compact")}</span>}</>
                  )}
                </button>
              </div>
            )}

            {isStreaming && (
              <button
                onClick={onAbort}
                 title={t("chat.stopAgent")}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "8px 14px",
                  height: 32,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: 9,
                  color: "#ef4444",
                  cursor: "pointer",
                  fontSize: 12, fontWeight: 600,
                  whiteSpace: "nowrap", letterSpacing: "-0.01em",
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.16)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                </svg>
                 {t("chat.stop")}
              </button>
            )}

            {onSoundToggle !== undefined && (
              <button
                onClick={onSoundToggle}
                 title={soundEnabled ? t("chat.disableSound") : t("chat.enableSound")}
                 aria-label={soundEnabled ? t("chat.disableSound") : t("chat.enableSound")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                  width: isMobile ? 32 : 32,
                  height: 32,
                  padding: 0,
                  background: "none",
                  border: "none",
                  borderRadius: 9,
                  color: soundEnabled ? "var(--text-muted)" : "var(--text-dim)",
                  cursor: "pointer",
                  opacity: soundEnabled ? 1 : 0.55,
                  transition: "background 0.12s, color 0.12s, opacity 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                  e.currentTarget.style.opacity = "1";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.color = soundEnabled ? "var(--text-muted)" : "var(--text-dim)";
                  e.currentTarget.style.opacity = soundEnabled ? "1" : "0.55";
                }}
              >
                {soundEnabled ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="23" y1="9" x2="17" y2="15" />
                    <line x1="17" y1="9" x2="23" y2="15" />
                  </svg>
                )}
              </button>
            )}
            {/* Import queue history — always available, even with an empty queue. */}
            {onImportQueue !== undefined && (
              <button
                onClick={() => queueImportFileRef.current?.click()}
                title={t("chat.queueImport")}
                aria-label={t("chat.queueImport")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                  width: isMobile ? 32 : 32,
                  height: 32,
                  padding: 0,
                  background: "none",
                  border: "none",
                  borderRadius: 9,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </button>
            )}
            {isMobile && controlsMenuOpen && (
              <button
                type="button"
                 title={t("chat.collapseControls")}
                 aria-label={t("chat.collapseControls")}
                aria-expanded={true}
                onClick={() => {
                  setToolDropdownOpen(false);
                  setThinkingDropdownOpen(false);
                  setControlsMenuOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 36,
                  height: 32,
                  padding: 0,
                  marginLeft: 0,
                  background: "var(--bg-hover)",
                  borderTop: "none", borderRight: "none", borderBottom: "none",
                  borderLeft: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                  borderRadius: "0 9px 9px 0",
                  color: "var(--text)",
                  cursor: "pointer",
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
            </div>
            <BottomModeBar
              mode={bottomMode}
              onClick={isMobile ? () => cycleBottomMode() : toggleQueueCollapsed}
              label={isMobile ? undefined : (queueCollapsed ? t("chat.queueExpand") : t("chat.queueCollapse"))}
              count={queueCount}
            />
          </div>
        </div>
        )}

        </div>
      </div>
  );
});

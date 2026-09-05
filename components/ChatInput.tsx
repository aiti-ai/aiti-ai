"use client";

import React, { useRef, useState, useCallback, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, useSyncExternalStore, KeyboardEvent } from "react";
import type { BuiltinSlashCommandResult, CompactResultInfo, QueuedMessages, SlashCommandInfo } from "@/hooks/useAgentSession";
import type { QueueTrashItem } from "@/lib/queue-store";
import type { QueueEntry, QueueEntryInput } from "@/lib/composer/queue-api";
import { downloadQueueExport, parseQueueImport } from "@/lib/queue-export";
import type { SkillsResponse } from "@/lib/api-types";
import type { TextContent, UserMessage } from "@/lib/types";
import {
  type ChatDraftImage,
  type DraftSnapshot as ChatDraft,
} from "@/lib/composer/draft-api";
import { apiUrl } from "@/lib/base-path";
import { useChatHooks, ExtSlot, registerChatSend, useExtSlotItems } from "@/components/ExtSlots";

import {
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "@/lib/image-attachments";
import {
  buildEntriesFromFiles, buildAtInsertText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import {
  emitComposerChange, emitComposerKeyChange, runComposerSubmit,
  setComposerWriter, subscribeComposerEnhancers, getComposerEnhancersVersion,
} from "@/lib/composer/bus";
import type { QueuePanelActions, QueuePanelProps } from "@/lib/composer/queue-api";
import { getQueuePanelController } from "@/lib/composer/queue-api";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { useIsMobile, useIsCompact, useIsCoarsePointer } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";
import type { ToolPreset } from "@/lib/tool-presets";
import { ModelSelector, type ModelSelectorOption } from "./ModelSelector";

import { filterModelOptions } from "./ModelSelector";
export { filterModelOptions } from "./ModelSelector";

/**
 * Write a textarea value through the native setter AND resync React's internal
 * value tracker (_valueTracker). The composer is uncontrolled (`defaultValue`,
 * de8c80f streaming-perf), so programmatic writes that bypass the tracker
 * leave it stale; React's ChangeEventPlugin then treats the next real user
 * edit landing on the tracked (stale) value as "no change" and suppresses
 * onChange. Concrete failure: restore a draft into the box (tracker still
 * ""), user selects all + deletes (DOM becomes "") → no onChange → state
 * keeps the draft text → the draft store is never cleared → the deleted
 * draft resurrects on the next session load (and Enter can re-send stale text).
 */
function writeTextareaValue(ta: HTMLTextAreaElement, nextValue: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  if (descriptor?.set) descriptor.set.call(ta, nextValue);
  else ta.value = nextValue;
  const tracker = (ta as unknown as { _valueTracker?: { setValue(v: string): void } })._valueTracker;
  tracker?.setValue(nextValue);
  // 扩展点通知（pi-web:* 惯例）：程序化写值刻意不经 input 事件（防 React onChange/tracker
  // 回环），但扩展无法感知输入框被宿主改了（发送清空/草稿还原/composer 契约写值）——
  // 这里统一广播 window 自定义事件，不进 React 链路；消费方如 aiti-ai-input 占位符 chips。
  try { window.dispatchEvent(new CustomEvent("pi-web:composer-value-written")); } catch {}
}

/** 合并提交文本到现有文本（submitted 在前，current 在后，空行分隔）。 */
export function mergeText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}
/** 合并提交文本+图片到现有草稿（图片封顶 10）。 */
export function mergeSubmission(
  submittedText: string,
  submittedImages: ChatDraftImage[] | undefined,
  currentText: string,
  currentImages: ChatDraftImage[],
): ChatDraft {
  const images = [...(submittedImages ?? []), ...currentImages].slice(0, 10)
    .map(({ data, mimeType }) => ({ data, mimeType }));
  return { value: mergeText(submittedText, currentText), images };
}

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}

/** 非图片文件附件（PDF/文档等）——仅后端会话支持（fileAttachments 能力）。 */
export interface AttachedFile {
  data: string;   // base64, no prefix
  mimeType: string;
  filename: string;
}

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

interface Props {
  onSend: (message: string, images?: AttachedImage[], files?: AttachedFile[]) => void;
  onAbort: () => void;
  /** 当前会话 id：透传给 chatInputTop 扩展槽（如 aiti-ai-input 的 AI 用量按会话记账） */
  sessionId?: string | null;
  onSteer?: (message: string, images?: AttachedImage[], files?: AttachedFile[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[], files?: AttachedFile[]) => void;
  /** 仅入队不触发（草稿恢复「Re-queue」语义）：空闲也只进 follow-up 队列，不直发。
   *  与 onFollowUp 区别：后者仅在 agent 运行时由 ChatWindow 接入（隐藏按钮用）；
   *  onQueueFollowUp 始终接入（恢复路径需要空闲也能入队）。 */
  onQueueFollowUp?: (message: string, images?: AttachedImage[], files?: AttachedFile[]) => void;
  /** Send a queued follow-up as a steer (interrupt now). Available even when idle. */
  onQueueSteerSend?: (message: string) => void;
  /** 显示「继续」按钮：AI 完全停止（无任何 streaming）且输入框为空时出现。 */
  canContinue?: boolean;
  /** 点「继续」：发送一条“继续”消息，触发 agent 继续运行。 */
  onContinue?: () => void;
  /** Convert a queued message's kind (steer ↔ follow-up) without dispatching it. */
  onConvertQueueItem?: (kind: "steer" | "followUp", index: number, targetKind: "steer" | "followUp") => Promise<boolean>;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[], files?: AttachedFile[]) => void;
  /** 后端会话能力（capability-aware 控件渲染；null = 本地会话） */
  sessionCapabilities?: Record<string, boolean> | null;
  /** 当前权限模式（后端会话；本地会话无） */
  permissionMode?: string;
  /** 切换权限模式（setPermissionMode 能力时可用） */
  onSwitchPermissionMode?: (mode: string) => void;
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
  /** 「编辑从此处」待发送标记期间为 true：禁止把预填内容写入草稿（切走/刷新即自动还原） */
  suppressDraft?: boolean;
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
  /** 程序化写值（composer 契约受控路径：state → DOM 同步 effect，tracker 同步） */
  setValueTracked: (text: string) => void;
  /** 清空输入框（含预填/草稿/图片预览）——「取消 编辑从此处」用 */
  clearInput: () => void;
  /** Force the queue panel to expand (used after recovery/import resolution). */
  expandQueue: () => void;
}

const TOOL_PRESETS = ["chat-only", "read-only", "default", "full"] as const;
type ToolPresetLabel = typeof TOOL_PRESETS[number];
const TOOL_PRESET_MAP: Record<ToolPresetLabel, ToolPreset> = {
  "chat-only": "none",
  "read-only": "read-only",
  default: "default",
  full: "full",
};
const COMPOSITION_END_ENTER_GRACE_MS = 100;
const TEXT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
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

type BuiltinSlashCommand = {
  name: string;
  description: string;
  source: "builtin";
  availableWhileStreaming?: boolean;
};

type SlashCommandPaletteItem = SlashCommandInfo | BuiltinSlashCommand;

type SlashCommandSource = SlashCommandPaletteItem["source"];

const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
  { name: "compact", description: "chat.commandCompact", source: "builtin" },
  { name: "reload", description: "chat.commandReload", source: "builtin" },
  { name: "name", description: "chat.commandName", source: "builtin" },
  { name: "session", description: "chat.commandSession", source: "builtin", availableWhileStreaming: true },
  { name: "copy", description: "chat.commandCopy", source: "builtin", availableWhileStreaming: true },
  { name: "clone", description: "chat.commandClone", source: "builtin" },
];

function getBuiltinSlashCommand(message: string): BuiltinSlashCommand | undefined {
  const match = message.trim().match(/^\/([^\s]+)(?:\s|$)/);
  if (!match) return undefined;
  return BUILTIN_SLASH_COMMANDS.find((command) => command.name === match[1]);
}

const MODEL_FILTER_THRESHOLD = 8;

export function canRunBuiltinSlashCommandWhileStreaming(message: string): boolean {
  return getBuiltinSlashCommand(message)?.availableWhileStreaming === true;
}

export function isExactSlashCommand(message: string, command: SlashCommandPaletteItem): boolean {
  return command.source === "builtin" && message.trim() === `/${command.name}`;
}

export function canClearBuiltinCommandInput(message: string, imageCount: number, submittedMessage: string): boolean {
  return imageCount === 0 && message.trim() === submittedMessage;
}

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

const CLIENT_IMAGE_COMPRESSION_THRESHOLD_BYTES = 1024 * 1024;
const CLIENT_MAX_IMAGE_SIDE = 1024;
const CLIENT_JPEG_QUALITY = 0.85;

export function shouldCompressImageFile(file: Pick<File, "size" | "type">): boolean {
  return file.size > CLIENT_IMAGE_COMPRESSION_THRESHOLD_BYTES && file.type !== "image/gif";
}

function readImageFile(file: Blob, mimeType: string): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result.split(",")[1] : undefined;
      if (!data) {
        reject(new Error("Failed to read image"));
        return;
      }
      resolve({ data, mimeType });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function compressImageFile(file: File): Promise<{ data: string; mimeType: string }> {
  const original = () => readImageFile(file, file.type);
  if (!shouldCompressImageFile(file) || typeof createImageBitmap !== "function") return original();

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return original();

  try {
    const scale = Math.min(1, CLIENT_MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return original();
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", CLIENT_JPEG_QUALITY).split(",")[1];
    return data && data.length < Math.ceil(file.size / 3) * 4
      ? { data, mimeType: "image/jpeg" }
      : original();
  } catch {
    return original();
  } finally {
    bitmap.close();
  }
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

/** ↑/↓ 队列导航目标计算（纯函数）：导航范围为拍平后的队列 [steering…, followUp…]
 *  （与面板展示顺序一致）。越界（到顶/到底）返回 null——保持当前编辑不动。 */
export function adjacentQueueTarget(
  kind: "steer" | "followUp",
  index: number,
  steeringCount: number,
  followUpCount: number,
  dir: -1 | 1,
): { kind: "steer" | "followUp"; index: number } | null {
  const total = steeringCount + followUpCount;
  if (total === 0) return null;
  const curFlat = kind === "steer" ? index : steeringCount + index;
  const targetFlat = curFlat + dir;
  if (targetFlat < 0 || targetFlat >= total) return null;
  return targetFlat < steeringCount
    ? { kind: "steer", index: targetFlat }
    : { kind: "followUp", index: targetFlat - steeringCount };
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

/** 队列行只读兜底（上游同形：计数 + Recall all + 只读行；完整行操作 UI 在
 *  aiti-queue-keeper 扩展的 queuePanel 插槽渲染——去 fork 化 P3，
 *  docs/pi-web-queue-cluster-ext-plan.md）。
 *  无接管（扩展未装/禁用）时 core 渲染本行 + Recall all + 计数兜底 banner。 */
function FallbackQueueRow({ kind, text }: { kind: "steer" | "follow-up"; text: string }) {
  return (
    <div
      title={text}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "3px 10px",
        fontSize: 12,
        color: "var(--text-muted)",
        minWidth: 0,
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
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
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
  // Label describes what the NEXT cycle step does (full → queueHidden →
  // minimal → full; the queueHidden level is skipped when the queue is
  // empty, so "full" jumps straight to "minimal" = collapse input).
  const nextLevel = mode === "full" ? (count ? "queueHidden" : "minimal") : mode === "queueHidden" ? "minimal" : "full";
  const defaultLabel = nextLevel === "queueHidden" ? t("chat.minimizeQueue") : nextLevel === "minimal" ? t("chat.minimizeInput") : t("chat.restoreBottom");
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

/** 新建会话提升判定：provisional 草稿 key（`new:<draftId>:<cwd>`）→ 真实会话 id。
 *  这不是「切会话」——切会话走 AppShell 的 sessionKey 自增，整个 ChatWindow 重挂载，
 *  本实例的 previousDraftKey 是 undefined；只有同一棵 composer 树活着时发生的
 *  `new:…` → sid 迁移才是提升。 */
export function isDraftKeyPromotion(previous: string | undefined, next: string | undefined): boolean {
  return typeof previous === "string" && previous.startsWith("new:")
    && typeof next === "string" && !next.startsWith("new:");
}

// 焦点交接：新建会话发送的那一刻，composer 从「欢迎页居中」搬到「消息流底部」——
// 两个不同 DOM 位置，整棵 ChatInput 重挂载，焦点随旧节点销毁 → 手机键盘收起、
// 输入法组合被丢。旧实例销毁时把「焦点在我身上」记到模块作用域，新实例挂载即接回
// （既有会话发送后焦点本就留在框里，两分支行为对齐）。
let composerLiveFocused = false;
let pendingFocusHandoff = false;

const ChatInputInner = forwardRef<ChatInputHandle, Props>(function ChatInput({
  sessionId,
  onSend, onAbort, onSteer, onFollowUp, onQueueFollowUp, onQueueSteerSend, canContinue, onContinue, onConvertQueueItem, isStreaming, model, isAutoModelSelection, modelNames, modelList, modelError, modelScopeWarnings, onModelChange, modelSwitching,
  sessionCapabilities, onSwitchPermissionMode, permissionMode,
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
  suppressDraft,
}: Props, ref) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const isCompact = useIsCompact();
  const isCoarsePointer = useIsCoarsePointer();
  const [value, setValue] = useState("");
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  // Per-provider collapse state in the model dropdown. Providers are collapsed
  // by default when there are many (>2 providers & >6 models total); the
  // provider that holds the currently-selected model is always expanded so the
  // active selection stays visible. Users can toggle each group afterwards.
  const [collapsedProviders, setCollapsedProviders] = useState<Record<string, boolean>>({});
  const collapsedProvidersInitializedRef = useRef(false);
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [controlsMenuOpen, setControlsMenuOpen] = useState(false);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const anyFileInputRef = useRef<HTMLInputElement>(null);
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
  // 会话历史直接翻阅（shell 式 ↑/↓，无排队消息时）：null = 未在翻阅；翻阅中记录
  // 当前命中的历史下标 + 我们写入输入框的原文（用于检测用户手动编辑 → 自动退出翻阅）。
  const historyNavIndexRef = useRef<number | null>(null);
  const historyNavTextRef = useRef<string>("");
  // 取回（recall）操作互斥锁：↑/↓ 连击或行按钮连点期间禁止并发取回/放回，
  // 防止同一条目被重复放回/孤儿化。
  const recallBusyRef = useRef(false);
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
  // Cycle the bottom panels (queue banner + input + toolbar) to leave more
  // room for the conversation during long runs. Persisted so the choice
  // survives reloads. Clicking the thin BottomModeBar cycles on every screen
  // size; the swipe gestures below are touch-only.
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
    let idx = order.indexOf(prev);
    if (idx === -1) {
      // 持久化的 queueHidden 在队列清空后不在 order 里（indexOf=-1）——按它的上一级
      // （full）归一化：+1 方向 → minimal（与 BottomModeBar 标签一致），-1 方向 → 保持展开。
      idx = order.indexOf("full");
    }
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
  // ── 队列面板（aiti-queue-keeper 扩展经 queuePanel 插槽渲染；core 只留计数与 edit-intent）──
  const queueCount = (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0);
  const trashCount = queueTrash?.length ?? 0;
  // 附件过大提示（core 专属轻量通知；队列面板的通知已随 UI 外迁到扩展）
  const [fileNotice, setFileNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const fileNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showFileNotice = useCallback((text: string, ok: boolean) => {
    setFileNotice({ text, ok });
    if (fileNoticeTimerRef.current) clearTimeout(fileNoticeTimerRef.current);
    fileNoticeTimerRef.current = setTimeout(() => setFileNotice(null), 3000);
  }, []);

  // P3 接管判定：queuePanel 插槽有实际 item（扩展已 materialize 且 feature 开启）→
  // 隐藏 core 兜底 banner，完整 UI 由扩展经插槽渲染。能力契约 EXT_PROVIDES.queuePanel
  // 仍登记在 lib/ext/types.ts（文档），运行时以实际插槽项为准——feature 关闭/卸载/异步
  // 加载未完成时回落兜底 banner（零数据迁移，sidecar/trash 全在 core）。
  const extOwnsQueuePanel = useExtSlotItems("queuePanel").length > 0;

  // 组装 queuePanel 插槽 props（core → ext：live 视图 + trash + actions 原语）。
  // actions 全部转发 ChatInput 既有 RPC 处理器；parseImport/downloadExport 直接透传
  // core 纯函数（单实现，扩展零逻辑）。
  const queuePanelExtra: QueuePanelProps = {
    live: {
      steering: (queuedMessages?.steering ?? []).map((text, i) => ({
        id: `steer:${i}`, kind: "steer" as const, text, hasImages: false, queuedAt: 0, index: i,
      })),
      followUp: (queuedMessages?.followUp ?? []).map((text, i) => ({
        id: `followUp:${i}`, kind: "followUp" as const, text, hasImages: false, queuedAt: 0, index: i,
      })),
    },
    trash: queueTrash ?? null,
    queueCount,
    trashCount,
    actions: {
      move: (kind, from, to) => onMoveQueue?.(kind, from, to) ?? Promise.resolve(false),
      convert: (kind, index, target) => onConvertQueueItem?.(kind, index, target) ?? Promise.resolve(false),
      // 取回进输入框（edit-intent 状态机收口 core；ext 只触发）——返回文本供展示
      recallOne: async (kind, index) => {
        const text = await handleRecallOne(kind, index);
        return text ? { text } : null;
      },
      requeueAt: (kind, index, text, images) => onRequeueAt?.(kind, index, text, images) ?? Promise.resolve(false),
      // 软删（→ trash，触发 core 侧 edit-intent 不相关路径；undo toast 在 ext 内管理）
      remove: (kind, index, opts) => handleRemoveQueueItem(kind, index, opts) ?? Promise.resolve(null),
      restore: (id, index) => onRestoreQueueItem?.(id, index) ?? Promise.resolve(false),
      purge: (ids) => onPurgeQueueTrash?.(ids) ?? Promise.resolve(false),
      recallAll: () => onRecallQueue?.(),
      steerSend: (text) => onQueueSteerSend?.(text),
      exportAll: () => onExportQueue?.() ?? Promise.resolve(null),
      downloadExport: (entries, meta, format) => downloadQueueExport(entries, meta, format),
      parseImport: (content) => parseQueueImport(content),
      importEntries: (entries) => onImportQueue?.(entries) ?? Promise.resolve(null),
      stageImport: (entries) => onStageImport?.(entries) ?? Promise.resolve(null),
    },
    isMobile,
    isCoarsePointer,
  };
  // Entry pulled out for editing; sending re-inserts it at its original spot.
  const recalledRef = useRef<{ kind: "steer" | "followUp"; index: number; text: string; images?: ChatDraftImage[] } | null>(null);
  const [recalledVisible, setRecalledVisible] = useState(false);
  // When the input is crowded (small screens / lots of text), the
  // steer/followUp buttons collapse to icons so they don't push the textarea
  // or wrap awkwardly. Measured from the input row container.
  const [queueButtonsCollapsed, setQueueButtonsCollapsed] = useState(false);
  const [buttonsWrapped, setButtonsWrapped] = useState(false);
  const inputRowRef = useRef<HTMLDivElement>(null);
  /** 取回核心（不带互斥锁）。mode="append"（默认）：与输入框已有内容合并（行内取回按钮）；
   *  mode="replace"：整体替换输入框内容（↑/↓ 队列导航时逐条切换）。
   *  返回取回的文本（无取回/失败返回 null）——队列面板契约 actions.recallOne 消费。 */
  const doRecallOne = useCallback(async (kind: "steer" | "followUp", index: number, mode: "append" | "replace" = "append"): Promise<string | null> => {
    if (!onRecallOne) return null;
    const entry = await onRecallOne(kind, index);
    if (!entry) return null;
    recalledRef.current = { kind, index, text: entry.text, images: entry.images };
    setRecalledVisible(true);
    const ta = textareaRef.current;
    const current = mode === "replace" ? "" : (ta ? ta.value : value);
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
    // 取回进框后展开队列面板（扩展接管时经 controller；无接管无折叠态 no-op）
    getQueuePanelController()?.expand();
    return entry.text;
  }, [onRecallOne, value]);
  /** 取回一条排队消息进输入框继续编辑（互斥：连击/连按期间忽略新请求）。返回取回文本。 */
  const handleRecallOne = useCallback(async (kind: "steer" | "followUp", index: number, mode: "append" | "replace" = "append") => {
    if (recallBusyRef.current) return null;
    recallBusyRef.current = true;
    try {
      return await doRecallOne(kind, index, mode);
    } finally {
      recallBusyRef.current = false;
    }
  }, [doRecallOne]);
  const cancelRecall = useCallback(() => {
    recalledRef.current = null;
    setRecalledVisible(false);
  }, []);
  /** 软删单条（core 原语：转发 RPC + edit-intent 清理；undo toast 在扩展面板内部管理）。
   *  被发送流（空框 Enter 提升首条）与扩展 actions.remove 共用。 */
  const handleRemoveQueueItem = useCallback(async (
    kind: "steer" | "followUp",
    index: number,
    opts?: { permanent?: boolean },
  ): Promise<QueueTrashItem | null> => {
    if (!onRemoveQueueItem) return null;
    return onRemoveQueueItem(kind, index, opts);
  }, [onRemoveQueueItem]);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  // 初始 undefined：让 draftKey effect 在首次挂载也走一遍 → emitComposerKeyChange
  // 广播初始 key（composer 增强契约：扩展需知道当前 key 才能落草稿）
  const draftKeyRef = useRef<string | undefined>(undefined);
  const valueRef = useRef(value);
  const attachedImagesRef = useRef(attachedImages);
  // True once the user (or a draft restore) put content into the box — the
  // save effect must NOT touch the stored draft while the box is merely empty
  // on open (that draft may be awaiting recovery in the dialog).
  const pendingImageCountRef = useRef(0);
  valueRef.current = value;
  attachedImagesRef.current = attachedImages;
  queueCountRef.current = (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0);

  // 受控写入（扩展用：自动补全落字等）：同步 valueRef + 触发 React 状态更新。
  // 与 onSend/appendText 等现有写入路径一致（valueRef 先行，setValue 随后）。
  const setInputValue = useCallback((text: string) => {
    valueRef.current = text;
    setValue(text);
  }, []);

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
      // 同步把新值写进 DOM：React 18 的受控提交是异步调度的，若只 setValue 就排队
      // rAF 定位光标，rAF 可能抢在 React commit 之前跑——此时 ta.value 还是旧（空）值，
      // setSelectionRange(combined.length) 会被钳到 0，随后 commit 虽把光标移到末尾
      // 却不会滚动——长引用时就停在第一行。同步写后 React 受控提交发现 node.value
      // 已等于新值会跳过覆写（不打断我们刚设的光标）。
      // 必须经 writeTextareaValue（原生 setter + 同步 _valueTracker）：裸写 ta.value
      // 会绕过 React 的值跟踪器，用户随后落到同值的编辑会被去重吞掉。
      if (ta) writeTextareaValue(ta, combined);
      valueRef.current = combined;
      setValue(combined);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(combined.length, combined.length);
        // 光标落点（末尾）可能超出可视区：值刚写入的那一帧浏览器不保证 setSelectionRange
        // 自动滚动到光标，显式滚到底部保证用户看到回复落点（长引用时输入框停在最后一行）。
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
        ta.scrollTop = ta.scrollHeight;
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
      // 同步写 DOM + tracker（不赌 React commit 与 rAF 的时序——异步 setValue 后
      // rAF 可能跑在 commit 之前，此时 DOM 还是旧值，光标会落在开头）
      const taNow = textareaRef.current;
      valueRef.current = draft.value;
      if (taNow) writeTextareaValue(taNow, draft.value);
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
        // 光标落到还原文本末尾
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    hasInput() {
      return Boolean(value.trim()) || attachedImagesRef.current.length > 0;
    },
    clearInput: () => clearInput(),
    /** 程序化写值（composer 契约受控路径：state → DOM 同步 effect，tracker 同步） */
    setValueTracked: (text: string) => setInputValue(text),
    runChatHooks(text: string) {
      return applyChatHooks(text);
    },
    expandQueue() {
      // P3：扩展接管折叠态，core 恢复/导入解析后经 controller 展开（无接管 no-op）
      getQueuePanelController()?.expand();
    },
  }));

  const MAX_ATTACHED_FILE_BYTES = 10 * 1024 * 1024;
  const processDocFiles = useCallback(async (files: File[]) => {
    const remaining = Math.max(0, MAX_ATTACHED_IMAGES - attachedFiles.length);
    const docs = files
      .filter((f) => f.size <= MAX_ATTACHED_FILE_BYTES)
      .slice(0, remaining);
    const skipped = files.length - docs.length;
    if (skipped > 0) showFileNotice(t("chat.fileTooLarge"), false);
    if (!docs.length) return;
    try {
      const newFiles = await Promise.all(
        docs.map(
          (file) =>
            new Promise<AttachedFile>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                const result = reader.result as string;
                resolve({
                  data: result.split(",")[1],
                  mimeType: file.type || "application/octet-stream",
                  filename: file.name,
                });
              };
              reader.onerror = reject;
              reader.readAsDataURL(file);
            }),
        ),
      );
      setAttachedFiles((prev) => [...prev, ...newFiles].slice(0, MAX_ATTACHED_IMAGES));
    } catch (e) {
      console.error("Failed to read file attachment:", e);
    }
  }, [attachedFiles.length, t]);

  const removeAttachedFile = useCallback((index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

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
        imageFiles.map(async (file) => ({
          ...await compressImageFile(file),
          previewUrl: URL.createObjectURL(file),
        }))
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
    // 草稿清空唯一路径 = aiti-draft-keeper 的 onChange("") 清空确认链（单一所有者）；
    // core 不再直接 clearDraft（与清空确认链/promote 搬运交叠曾是竞态源头）
    clearImages();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    historyNavIndexRef.current = null;
    historyNavTextRef.current = "";
  }, [clearImages]);

  /** 取回编辑中的 ↑/↓ 队列导航：把当前编辑放回队列原位，再取回相邻一条继续编辑
   * （与行内取回按钮完全同一链路）。导航范围为拍平后的队列 [steering…, followUp…]
   * （与面板展示顺序一致）。编辑框被清空时保底放回原文——导航绝不丢失队列条目。 */
  const navigateRecalled = useCallback(async (dir: -1 | 1) => {
    const recalled = recalledRef.current;
    if (!recalled || !onRequeueAt || !onRecallOne || recallBusyRef.current) return;
    const steeringCount = queuedMessages?.steering.length ?? 0;
    const target = adjacentQueueTarget(recalled.kind, recalled.index, steeringCount, queuedMessages?.followUp.length ?? 0, dir);
    if (!target) return;
    recallBusyRef.current = true;
    try {
      const edited = valueRef.current.trim();
      const msg = edited || recalled.text;
      const images = attachedImagesRef.current.length ? attachedImagesRef.current : recalled.images;
      const ok = await onRequeueAt(recalled.kind, recalled.index, msg, images);
      if (!ok) return; // 放回失败：保持取回编辑态，用户可重试
      recalledRef.current = null;
      setRecalledVisible(false);
      clearInput();
      await doRecallOne(target.kind, target.index, "replace");
    } finally {
      recallBusyRef.current = false;
    }
  }, [queuedMessages, onRequeueAt, onRecallOne, doRecallOne, clearInput]);

  // 注意顺序：[draftKey] effect 必须在 [value] 广播 effect 之前——
  // 挂载/切会话时 keyChange 先行（keeper 记 pendingScan），随后的 onChange("")
  // 才会触发扫描恢复；反序时 onChange 先发（currentKey 未定被忽略），
  // pendingScan 永远等不到下一次 onChange，恢复永不执行。
  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey) return;
    // 旧 key 的草稿落盘/清理由 keeper 经 onKeyChange 接管（writeNow 旧 key + 换 key 扫描）；
    // core 不再自行 setDraft(previousDraftKey)（避免散落）
    draftKeyRef.current = draftKey;
    // composer 增强契约：key 切换广播（草稿持久化换 key 扫描等扩展消费）
    emitComposerKeyChange(previousDraftKey, draftKey);
    // 提升不换稿：那一刻框里往往是用户在 AI 回答期间刚打下的下一条输入，清空 =
    // 当面吞字 + 打断输入法组合（小屏上就是「AI 正在显示时打断我打字」）。值留着，
    // 随后的 onChange 广播会把它落到 sid 槽位（keeper 已在 sessionCreated 意图里
    // 把 currentKey 重定向到 sid）。
    if (isDraftKeyPromotion(previousDraftKey, draftKey)) return;
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

  // [aiti] 跨会话预填（「@到新session」类功能）：扩展先写
  // window.__piWebPendingComposer = { text, at }，再派发 pi-web:new-session / pi-web:open-session；
  // 目标输入框挂载/换 key 后在此消费插入。带 15s 时效防陈文误投；一次性短延迟定时器
  // 避开同 commit 的 [draftKey] 清空 effect（上方的 setValue("")）与扩展恢复链，非轮询。
  useEffect(() => {
    const w = window as any;
    const pending = w.__piWebPendingComposer;
    if (!pending || typeof pending.text !== "string" || !pending.text) return;
    if (Date.now() - (Number(pending.at) || 0) > 15000) { delete w.__piWebPendingComposer; return; }
    const timer = setTimeout(() => {
      const cur = w.__piWebPendingComposer;
      if (!cur || cur !== pending) return; // 已被更新/消费
      delete w.__piWebPendingComposer;
      const combined = pending.text;
      valueRef.current = combined;
      setValue(combined);
      setAtQuery(null);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(combined.length, combined.length);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [draftKey]);

  // composer 增强契约：值变化广播（草稿落槽位/队列横幅等扩展消费）
  // 草稿落盘由 aiti-draft-keeper 经 onChange 接管；core 不再自行落盘（已删原 save effect）
  useEffect(() => {
    emitComposerChange({
      value,
      images: attachedImages.map(imageToDraftImage),
      imageCount: attachedImages.length,
      hasInput: Boolean(value.trim()) || attachedImages.length > 0,
      suppress: suppressDraft,
    });
  }, [value, attachedImages, suppressDraft]);

  // 增强器晚注册补偿：扩展 client 异步加载，注册前的 keyChange/onChange 广播
  // 会丢失（keeper 拿不到 currentKey 则完全瘫痪）。增强器集合变化时补发当前
  // key 与快照（draftKeyRef 已是当前值，直接重发）。
  const enhancersVersion = useSyncExternalStore(subscribeComposerEnhancers, getComposerEnhancersVersion, () => 0);
  useEffect(() => {
    if (enhancersVersion === 0) return;
    emitComposerKeyChange(draftKeyRef.current, draftKeyRef.current);
    emitComposerChange({
      value: valueRef.current,
      images: attachedImagesRef.current.map(imageToDraftImage),
      imageCount: attachedImagesRef.current.length,
      hasInput: Boolean(valueRef.current.trim()) || attachedImagesRef.current.length > 0,
      suppress: suppressDraft,
    });
  }, [enhancersVersion, suppressDraft]);

  // （已删 flushAllDrafts 卸载 effect——keeper 的 beforeunload/pagehide/visibilitychange
  // 监听负责落盘；SPA unmount 时 keeper drafts map 持续，onKeyChange 已 flush 旧 key）

  // composer 增强契约：装配受控写入口（程序化写值统一走 state → 既有 [value]
  // DOM 同步 effect，tracker 同步在那边保证）。卸载时置空。
  useEffect(() => {
    setComposerWriter({
      snapshot: () => ({
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
        imageCount: attachedImagesRef.current.length,
        hasInput: Boolean(valueRef.current.trim()) || attachedImagesRef.current.length > 0,
        suppress: suppressDraft,
      }),
      setValue: (text) => setInputValue(text),
    });
    return () => setComposerWriter(null);
  }, [setInputValue]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // 非受控同步：React state 变化（草稿恢复/扩展注入/发送清空/召回等）写回 DOM。
    // 语音/IME 组合输入期间跳过——组合文本由输入法独占，React 不覆写（防语音输入被打断）。
    // 经 writeTextareaValue 同步 _valueTracker：裸写 ta.value 会留下过期的跟踪值，
    // 恢复草稿后用户全选删除时 React 认为「值没变」吞掉 onChange —— state 残留旧稿、
    // 草稿清不掉、下次加载又复活，回车还会把残留旧稿重新发出去。
    if (!isComposingRef.current && ta.value !== value) {
      writeTextareaValue(ta, value);
    }
    // React 对 defaultValue 的提交走 textContent 路径（不经 value setter），同样绕过
    // _valueTracker —— 每次提交后强制把跟踪值对齐到真实 DOM 值，保证后续用户编辑
    // （尤其全选删除回到跟踪旧值的场景）总能正常触发 onChange。
    const tracker = (ta as unknown as { _valueTracker?: { setValue(v: string): void } })._valueTracker;
    tracker?.setValue(ta.value);
    ta.style.height = "auto";
    if (value) ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  // （值变化广播只在上方带 suppress 的一处发——曾有一个无 suppress 的旧广播残留，
  //  每次变化双发，把 suppressDraft 击穿：「从这里编辑」预填文本借它漏进草稿槽位，
  //  发送时经 scan「恢复」回框且清空确认被污染失效。已删，勿再加第二个广播点。）

  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  const handleFocus = useCallback(() => {
    composerLiveFocused = true;
    // Re-measure once the focus-driven layout settles. Focusing alone does not
    // fire onChange/onInput, so a height computed at an earlier width (mobile
    // keyboard opening, buttons wrapping onto their own row) stays stale
    // until the next keystroke — e.g. after pasting text and tapping back in.
    requestAnimationFrame(resizeTextarea);
  }, [resizeTextarea]);

  const handleBlur = useCallback(() => {
    composerLiveFocused = false;
  }, []);

  // 焦点跨重挂载交接（见 pendingFocusHandoff）。layout 阶段成对执行：旧实例销毁
  // 先记下焦点归属，新实例挂载立刻接回，用户看不出断点。preventScroll 防「为了
  // 还焦点反而把页面滚了一下」。
  useLayoutEffect(() => {
    if (pendingFocusHandoff) {
      pendingFocusHandoff = false;
      const ta = textareaRef.current;
      if (ta && document.activeElement !== ta) {
        ta.focus({ preventScroll: true });
        composerLiveFocused = true;
      }
    }
    return () => {
      pendingFocusHandoff = composerLiveFocused;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // Batch resize notifications into the next frame: the measure() clones the
    // textarea, appends it to the document, and reads its metrics — running it
    // on every ResizeObserver callback (fired multiple times per streaming
    // turn as buttons wrap/unwrap) forces repeated synchronous layouts. A
    // trailing rAF coalesces all changes in one frame into a single measure.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
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

  const runBuiltinCommand = useCallback(async (msg: string): Promise<boolean> => {
    if (attachedImages.length || !msg.startsWith("/") || !onBuiltinCommand) return false;
    const result = await onBuiltinCommand(msg);
    if (!result.handled) return false;
    if (!result.error && canClearBuiltinCommandInput(valueRef.current, attachedImagesRef.current.length, msg)) clearInput();
    return true;
  }, [attachedImages.length, clearInput, onBuiltinCommand]);

  const handleSend = useCallback(async () => {
    const msg = value.trim();
    // 取回编辑中：Enter 一律 = 放回队列原处（不改变顺序）；编辑被清空时放回原文，绝不丢条目。
    // 放回是纯队列操作，流式中同样成立。
    const recalled = recalledRef.current;
    if (!msg && !attachedImages.length && !(recalled && recalled.text)) return;
    onAudioUnlock?.();
    if (recalled) {
      recalledRef.current = null;
      setRecalledVisible(false);
      if (onRequeueAt) {
        const ok = await onRequeueAt(recalled.kind, recalled.index, msg || recalled.text, attachedImages.length ? attachedImages : recalled.images);
        if (!ok) {
          // Failed to requeue: restore the edit state so the user can retry.
          recalledRef.current = { ...recalled, text: msg || recalled.text };
          setRecalledVisible(true);
        }
        clearInput();
        return;
      }
      // 无 onRequeueAt 的宿主且编辑被清空：无事可做，不发出空消息
      if (!msg && !attachedImages.length) return;
    }
    // 上游 v0.8.10：builtin 斜杠命令在流式期间也可运行（白名单内命令不打断 agent）
    const builtinAllowed = !isStreaming || canRunBuiltinSlashCommandWhileStreaming(msg);
    if (builtinAllowed && await runBuiltinCommand(msg)) return;
    if (isStreaming) return;
    // composer 增强契约：发送前链式钩子 → 扩展聊天钩子（既有 [元素N]/[回答N]/[错误N] 替换）
    const submittedMsg = runComposerSubmit(msg, attachedImages.length);
    const finalMsg = applyChatHooks(submittedMsg);
    onSend(finalMsg, attachedImages.length ? attachedImages : undefined, attachedFiles.length ? attachedFiles : undefined);
    setAttachedFiles([]);

    clearInput();
  }, [value, attachedImages, attachedFiles, isStreaming, runBuiltinCommand, onSend, clearInput, onAudioUnlock, onRequeueAt, applyChatHooks]);

  /** 扩展程序化发送（aiti-prompts 等）：与用户输入同链路——applyChatHooks 钩子生效；
   *  agent 流式时按 mode 插队(steer)/排队(followUp)（与 sendQueued 同分支），空闲时直接触发（等同 Enter）。
   *  不清空输入框：发的是扩展内容，不动用户正在输入的内容。 */
  const handleExtensionSend = useCallback((text: string, mode: "steer" | "followUp" | "queue", images?: { data: string; mimeType: string }[]) => {
    if (!text || !text.trim()) return;
    const finalMsg = applyChatHooks(text);
    // 草稿恢复多条残留等：携带图片的 follow-up 排队（base64 → AttachedImage）
    const attached = images?.length
      ? images.map((im) => ({ data: im.data, mimeType: im.mimeType, previewUrl: `data:${im.mimeType};base64,${im.data}` }))
      : undefined;
    if (mode === "queue") {
      // 仅入队不触发：空闲也只进 follow-up 队列（草稿恢复「Re-queue」语义）
      onQueueFollowUp?.(finalMsg, attached);
      return;
    }
    if (finalMsg.startsWith("/") && onPromptWithStreamingBehavior) {
      onPromptWithStreamingBehavior(finalMsg, mode, attached);
      return;
    }
    if (mode === "steer" && onSteer) {
      onSteer(finalMsg, attached);
    } else if (mode === "followUp" && onFollowUp) {
      onFollowUp(finalMsg, attached);
    } else {
      // 空闲（onSteer/onFollowUp 仅在 agent 运行时传入）→ 立即触发一轮
      onSend?.(finalMsg, attached);
    }
  }, [applyChatHooks, onSend, onSteer, onFollowUp, onQueueFollowUp, onPromptWithStreamingBehavior]);

  useEffect(() => {
    registerChatSend(handleExtensionSend);
    return () => registerChatSend(null);
  }, [handleExtensionSend]);

  const slashQuery = value.startsWith("/") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;

  const filteredSlashCommands = (() => {
    if (slashQuery === null) return [];
    const builtinCommands = isStreaming
      ? BUILTIN_SLASH_COMMANDS.filter((command) => command.availableWhileStreaming)
      : BUILTIN_SLASH_COMMANDS;
    const commands = [...builtinCommands, ...(slashCommands ?? [])];
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
          || TEXT_COLLATOR.compare(a.name, b.name);
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
    // 菜单选用历史 → 退出直接翻阅模式（两套机制互斥）
    historyNavIndexRef.current = null;
    historyNavTextRef.current = "";
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

  /** shell 式会话历史翻阅：把第 index 条历史复制进输入框（可编辑后重新发送）。 */
  const applyHistoryNav = useCallback((index: number) => {
    if (index < 0 || index >= inputHistory.length) {
      historyNavIndexRef.current = null;
      historyNavTextRef.current = "";
      return;
    }
    const text = inputHistory[index];
    historyNavIndexRef.current = index;
    historyNavTextRef.current = text;
    valueRef.current = text;
    setValue(text);
    setAtQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, [inputHistory]);

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

  /** 按钮点击（含 Tab 聚焦后按 Enter 触发）后把焦点还给输入框——否则焦点留在按钮上，
   *  用户继续打字不会进入输入框。rAF 等一轮渲染（clearInput 等状态更新）后再聚焦。 */
  const refocusInput = useCallback(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const sendQueued = useCallback((mode: "steer" | "followup") => {
    const msg = value.trim();
    // No typed text: the steer button dispatches the first queued follow-up
    // as a steer (interrupt now) instead of doing nothing.
    if (!msg && !attachedImages.length) {
      if (mode === "steer") {
        // 取回编辑中（输入被清空）：不抢发队列首条——先按 Enter 放回当前编辑，避免孤儿化
        if (recalledRef.current) return;
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
    if (!attachedImages.length && onBuiltinCommand && canRunBuiltinSlashCommandWhileStreaming(msg)) {
      void runBuiltinCommand(msg);
      return;
    }
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
  }, [value, attachedImages, queuedMessages, onPromptWithStreamingBehavior, onSteer, onFollowUp, onQueueSteerSend, handleRemoveQueueItem, clearInput, onAudioUnlock, applyChatHooks, onBuiltinCommand, runBuiltinCommand]);

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
      const sendShortcut = e.key === "Enter" && !e.shiftKey && !e.repeat;
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
        const selectedCommand = displayedSlashCommands[slashActiveIndex];
        if (e.key === "Tab" && selectedCommand) {
          e.preventDefault();
          applySlashCommand(selectedCommand);
          return;
        }
        if (sendShortcut && selectedCommand) {
          e.preventDefault();
          const canSubmitNow = !isStreaming
            || (selectedCommand.source === "builtin" && selectedCommand.availableWhileStreaming === true);
          if (canSubmitNow && isExactSlashCommand(value, selectedCommand)) {
            setSlashMenuOpen(false);
            void handleSend();
          } else {
            applySlashCommand(selectedCommand);
          }
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

      // ── 取回编辑中的队列导航（↑/↓）：把当前编辑放回队列原位，取回相邻一条继续编辑。──
      // 与行内取回按钮完全同一链路；置底/置顶时不动（保留当前编辑）。
      if (!isComposing && recalledRef.current && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        void navigateRecalled(e.key === "ArrowUp" ? -1 : 1);
        return;
      }

      // ── 会话历史直接翻阅进行中（无排队消息时的 shell 式 ↑/↓）──
      // ↑ 上一条（更旧）；↓ 下一条（更新），翻过最新一条回到空输入。
      // 用户手动改动过文本（value ≠ 我们写入的原文）→ 视为退出翻阅，恢复正常光标移动。
      if (!isComposing && historyNavIndexRef.current !== null && valueRef.current === historyNavTextRef.current
        && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const navIdx = historyNavIndexRef.current;
        if (e.key === "ArrowDown") {
          if (navIdx + 1 >= inputHistory.length) {
            // 翻过最新一条：清空输入框（翻阅只从空输入进入，恢复原稿 = 空白）
            historyNavIndexRef.current = null;
            historyNavTextRef.current = "";
            valueRef.current = "";
            setValue("");
            setAtQuery(null);
          } else {
            applyHistoryNav(navIdx + 1);
          }
        } else {
          applyHistoryNav(Math.max(0, navIdx - 1));
        }
        return;
      }

      // 空输入 ↑：有排队消息 → 取回最后一条进输入框继续编辑（followUp 优先，
      // 无 followUp 时取最后一条 steering；流式中也可用，发送时放回队列原处）；
      // 无排队消息但有会话历史 → 直接开始翻阅（最新一条先入框，可重复发送）。
      if (e.key === "ArrowUp" && !isComposing && !e.shiftKey && value.trim().length === 0 && !recalledRef.current) {
        const steerCount = queuedMessages?.steering.length ?? 0;
        const followUpCount = queuedMessages?.followUp.length ?? 0;
        if (followUpCount > 0 || steerCount > 0) {
          e.preventDefault();
          setSlashMenuOpen(false);
          setAtMenuOpen(false);
          setHistoryMenuOpen(false);
          const useFollowUp = followUpCount > 0;
          void handleRecallOne(useFollowUp ? "followUp" : "steer", (useFollowUp ? followUpCount : steerCount) - 1, "replace");
          return;
        }
        if (inputHistory.length > 0) {
          e.preventDefault();
          setSlashMenuOpen(false);
          setAtMenuOpen(false);
          setHistoryMenuOpen(false);
          applyHistoryNav(inputHistory.length - 1);
          return;
        }
      }
      // Shift+↑：打开历史菜单（原空输入 ↑ 行为，可视化浏览，Enter/Tab 选用）。
      if (e.key === "ArrowUp" && e.shiftKey && !isComposing && !isStreaming && inputHistory.length > 0 && value.trim().length === 0) {
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
        // 取回编辑中：Enter = 放回队列原处（等同「放回队列」按钮，不改顺序）——
        // 流式期间也走 handleSend 的取回分支，而不是把文本追加成新 follow-up。
        if (recalledRef.current) {
          void handleSend();
        } else if (isStreaming && (onSteer || onFollowUp)) {
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
    [isStreaming, onSteer, onFollowUp, onAbort, slashMenuOpen, slashQuery, displayedSlashCommands, slashActiveIndex, applySlashCommand, sendQueued, handleSend, getNextSlashIndex, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion, historyMenuOpen, inputHistory, historyActiveIndex, applyHistoryInput, applyHistoryNav, navigateRecalled, handleRecallOne, queuedMessages, value]
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
  const modelOptions: ModelSelectorOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name }));
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    }));
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

  // 防呆标注：同名模型出现在多个 provider 分组时（如 opencode-go 与 opencode-go-2
  // 都列出 ox-alpha-free），相邻分组的选项标签完全一样，极易点错——而 set_model 按
  // provider+id 精确匹配，点错等于静默切到了另一个 provider。对这些重名选项在名称后
  // 追加 provider 小字。按完整列表计算（非过滤结果），避免输入过滤词时标注闪烁。
  const ambiguousModelNames = (() => {
    const providersByName = new Map<string, Set<string>>();
    for (const opt of modelOptions) {
      let provs = providersByName.get(opt.name);
      if (!provs) { provs = new Set(); providersByName.set(opt.name, provs); }
      provs.add(opt.provider);
    }
    const names = new Set<string>();
    for (const [name, provs] of providersByName) {
      if (provs.size > 1) names.add(name);
    }
    return names;
  })();

  // Decide whether providers should be auto-collapsed: when there are more
  // than 2 providers and the (unfiltered) model list has more than 6 entries.
  // The provider holding the active model stays expanded so the user can see
  // what is currently selected. Computed from the full option list so that
  // typing a filter doesn't flip the trigger mid-session.
  const fullProviderCount = (() => {
    const seen = new Set<string>();
    for (const opt of modelOptions) seen.add(opt.provider);
    return seen.size;
  })();
  const autoCollapseProviders = fullProviderCount > 2 && modelOptions.length > 6;

  // (Re)initialize the per-provider collapse state when the dropdown opens
  // (or when it was never initialized). Reset to defaults so the toggle is
  // deterministic each time the panel is opened.
  useEffect(() => {
    if (!modelDropdownOpen) {
      collapsedProvidersInitializedRef.current = false;
      return;
    }
    if (collapsedProvidersInitializedRef.current) return;
    if (autoCollapseProviders) {
      const activeProvider = model?.provider ?? null;
      const next: Record<string, boolean> = {};
      for (const g of modelsByProvider) next[g.provider] = g.provider !== activeProvider;
      setCollapsedProviders(next);
    } else {
      setCollapsedProviders({});
    }
    collapsedProvidersInitializedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelDropdownOpen, autoCollapseProviders]);

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
  const rawToolPresetLabel = Object.entries(TOOL_PRESET_MAP).find(([, v]) => v === (toolPreset ?? "default"))?.[0] ?? "default";
  const toolPresetLabel = rawToolPresetLabel === "chat-only" ? t("chat.chatOnly") : rawToolPresetLabel;

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
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
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
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
        paddingRight: isMobile || isCompact ? 16 : 52, // desktop: 16px base + 36px for ChatMinimap alignment
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
      {/* Hidden generic-file input（文件附件：PDF/文档等，后端 fileAttachments 能力） */}
      <input
        ref={anyFileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          const imgs = picked.filter((f) => f.type.startsWith("image/"));
          const docs = picked.filter((f) => !f.type.startsWith("image/"));
          if (imgs.length) processImageFiles(imgs);
          processDocFiles(docs);
          e.target.value = "";
        }}
      />
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        <ModelErrorBanner error={modelError} />
        <ModelScopeWarningBanner warnings={modelScopeWarnings} />
        {/* 队列面板：aiti-queue-keeper 扩展经 queuePanel 插槽渲染完整 UI
            （横幅/行操作/回收站/撤销条/导入导出/通知）。无接管时（扩展未装/禁用
            或 feature 关闭）渲染上游同形兜底 banner（计数 + Recall all + 只读行）——
            去 fork 化 P3，docs/pi-web-queue-cluster-ext-plan.md。 */}
        {fileNotice && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11,
              color: fileNotice.ok ? "#16a34a" : "#ef4444", whiteSpace: "nowrap",
            }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                {fileNotice.ok
                  ? <><polyline points="20 6 9 17 4 12" /></>
                  : <><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>}
              </svg>
              {fileNotice.text}
            </span>
          </div>
        )}
        {/* 队列面板仅在 bottomMode 展开态渲染（queueHidden/minimal 时连同扩展面板一起隐藏，
            与 core bottomMode 三态语义一致——计划 §4-④ 留核） */}
        {bottomMode === "full" && <ExtSlot name="queuePanel" extra={queuePanelExtra} />}
        {!extOwnsQueuePanel && bottomMode === "full" && (queueCount > 0 || trashCount > 0) && (
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
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "2px 8px 4px 10px",
            }}>
              <span style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--text-dim)",
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}>
                {t("chat.queued", { count: String(queueCount) })}
              </span>
              {onRecallQueue && (
                <button
                  onClick={onRecallQueue}
                  title={t("chat.recallTitle")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 12px",
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
            </div>
            {queuedMessages?.steering.map((text, i) => (
              <FallbackQueueRow key={`steer-${i}`} kind="steer" text={text} />
            ))}
            {queuedMessages?.followUp.map((text, i) => (
              <FallbackQueueRow key={`followup-${i}`} kind="follow-up" text={text} />
            ))}
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
        {attachedFiles.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedFiles.map((f, i) => (
              <div key={`${f.filename}-${i}`} style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "5px 9px", borderRadius: 6,
                background: "var(--bg-hover)", border: "1px solid var(--border)",
                fontSize: 11, color: "var(--text)", maxWidth: 220,
              }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  📎 {f.filename}
                </span>
                <button
                  onClick={() => removeAttachedFile(i)}
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "var(--text-muted)", display: "flex" }}
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
                onClick={() => { void handleSend(); refocusInput(); }}
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
          <ExtSlot name="chatInputTop" extra={{ inputValue: value, cwd, sessionId, textareaRef, setInputValue, isStreaming, menuOpen: historyMenuOpen || slashMenuOpen || atMenuOpen, model }} />
          <textarea
            ref={textareaRef}
            data-chat-input="1"
            enterKeyHint="send"
            defaultValue={value}
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
              // 组合结束：把输入法最终写入 DOM 的值收进 state（防 state 落后 DOM 导致草稿/后续写入丢字）
              valueRef.current = el.value;
              setValue(el.value);
              updateAtQuery(el.value, el.selectionStart);
            }}
            onInput={handleInput}
            onFocus={handleFocus}
            onBlur={handleBlur}
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
                  onClick={() => { sendQueued("steer"); refocusInput(); }}
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
                  onClick={() => { sendQueued("followup"); refocusInput(); }}
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
                  onClick={() => { onAbort(); refocusInput(); }}
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
                  onClick={() => { onContinue(); refocusInput(); }}
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
              onClick={() => { void handleSend(); refocusInput(); }}
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
              onClick={() => anyFileInputRef.current?.click()}
              title={t("chat.attachFile")}
              style={{
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                width: 32, height: 32, padding: 0,
                background: "none", border: "none",
                borderRadius: 9,
                color: attachedFiles.length ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = attachedFiles.length ? "var(--accent)" : "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "none";
                e.currentTarget.style.color = attachedFiles.length ? "var(--accent)" : "var(--text-muted)";
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </button>
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
            {/* Model selector — visible always; only locked while a switch request is in flight. Streaming stays clickable: switching mid-run applies next turn (modelSwitchPending badge).
                ⚠ 条件收紧（2026-08-27）：去掉 modelOptions/model 依赖——数据到达前首帧是空，
                触发会消失且不重渲染（attach 会话 models cwd 异常时尤甚）。恒渲染，空态由
                ModelSelector 兜底（No models/Select model title 挡位）。 */}
            {onModelChange && (
              <ModelSelector
                options={modelOptions}
                value={model}
                onChange={onModelChange}
                disabled={false}
                busy={modelSwitching}
                pending={modelSwitchPending != null}
                isAutoSelection={isAutoModelSelection}
              />
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
            {!isStreaming && onSwitchPermissionMode && sessionCapabilities?.setPermissionMode && (
              <PermissionModeDropdown
                currentMode={permissionMode ?? "default"}
                onSwitch={(mode) => onSwitchPermissionMode(mode)}
              />
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
                      if (lvl === "chat-only") desc = t("chat.chatOnly");
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
            {/* 扩展入口（composerTools slot）：与压缩/导入同排的 32×32 图标按钮（aiti-git-trace：时间线主入口）；streaming 供 plan chip 等 turn 末刷新状态 */}
            <ExtSlot name="composerTools" extra={{
              sessionId, cwd, streaming: isStreaming,
              // 队列 actions（P3）：composerTools 行的导入按钮经此触发 stageImport——
              // 导入入口回到底部控制行（与压缩/导入同排），队列空时不再孤零零浮在上方。
              queueActions: queuePanelExtra.actions,
            }} />
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
            {/* Desktop and mobile cycle identically: click walks the bottom
                modes (full → queueHidden → minimal → full, queueHidden skipped
                when the queue is empty). Collapsing the queue rows themselves
                stays on the queue header chevron button. */}
            <BottomModeBar
              mode={bottomMode}
              onClick={() => cycleBottomMode()}
              count={queueCount}
            />
          </div>
        </div>
        )}

        </div>
      </div>
  );
});
// ============================================================================
// PermissionModeDropdown — 后端会话的运行时权限模式切换（cc-connect ModeSwitcher 对齐）
// ============================================================================

const PERMISSION_MODES: Array<{ value: string; label: string }> = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept Edits" },
  { value: "plan", label: "Plan" },
  { value: "dontAsk", label: "Don't Ask" },
  { value: "bypassPermissions", label: "Bypass" },
];

function PermissionModeDropdownInner({ currentMode, onSwitch }: {
  currentMode: string;
  onSwitch: (mode: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);
  const label = PERMISSION_MODES.find((m) => m.value === currentMode)?.label ?? currentMode;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen((v) => !v)} title={`Permission mode: ${currentMode}`}
        style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "6px 10px", height: 30,
          background: open ? "var(--bg-hover)" : "none", border: "none", borderRadius: 9,
          color: currentMode !== "default" ? "#f59e0b" : "var(--text-muted)",
          cursor: "pointer", fontSize: 12,
          transition: "background 0.12s, color 0.12s",
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        <span>{label}</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 4px)", left: 0, minWidth: 160,
          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
          boxShadow: "0 -4px 16px rgba(0,0,0,0.15)", zIndex: 130, overflow: "hidden",
        }}>
          {PERMISSION_MODES.map((m) => (
            <button key={m.value} onClick={() => { onSwitch(m.value); setOpen(false); }}
              style={{
                display: "block", width: "100%", padding: "7px 14px", textAlign: "left",
                background: m.value === currentMode ? "var(--bg-selected)" : "none",
                border: "none", cursor: "pointer", fontSize: 12,
                color: m.value === currentMode ? "var(--accent)" : "var(--text)",
                fontWeight: m.value === currentMode ? 600 : 400,
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
const PermissionModeDropdown = React.memo(PermissionModeDropdownInner);

// memo：AI 流式期间 ChatWindow 每 token 重渲染（streamState 引用变），但传给本组件的
// props 全部是稳定引用（hook 内 useCallback/useState/useMemo）——memo 后流式期间
// 输入框不再被波及重渲染（性能 + 避免受控覆写打断语音组合输入）。
export const ChatInput = React.memo(ChatInputInner);

"use client";

import React, { useRef, useState, useCallback, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, useSyncExternalStore, useMemo, KeyboardEvent } from "react";
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
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import { stripAnsi } from "@/lib/ansi";
import { contextUrgency, CTX_BREATHE_CSS, type CtxUrgency } from "@/lib/context-urgency";
import type { ContextUsage } from "@/lib/pi-types";
import { formatExtensionStatusLine } from "./ExtensionStatusBar";
import { AnsiText } from "./AnsiText";
import { ImagePreview } from "./ImagePreview";
import { ExtensionWidgets } from "./ExtensionWidgets";
import { useChatHooks, ExtSlot, registerChatSend, useExtSlotItems, ExtItemBoundary, registerExtClientService } from "@/components/ExtSlots";
import { hasExtRender } from "@/lib/ext-ui-store";
import { HOST_COMPOSER_SERVICE } from "@/lib/ext/host-ui-contract";

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
  emitComposerChange, emitComposerKeyChange, emitComposerClearToTrash, runComposerSubmit,
  setComposerWriter, setComposerTrashWriter, subscribeComposerEnhancers, getComposerEnhancersVersion,
} from "@/lib/composer/bus";
import type { QueuePanelActions, QueuePanelProps } from "@/lib/composer/queue-api";
import { getQueuePanelController } from "@/lib/composer/queue-api";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { TaskListPanel, type SessionTask } from "./TaskListPanel";
import { useIsMobile, useIsCompact, useIsCoarsePointer } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";
import { useChatAppearance } from "@/hooks/useChatAppearance";
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
  // Extension-point notification (host custom-event convention): programmatic
  // writes deliberately skip the input event (to avoid a React onChange/tracker
  // loop), so extensions cannot observe host-driven writes (send-clear, draft
  // restore, composer-contract writes) — broadcast a window custom event here,
  // outside the React pipeline. Consumers include the AI-input extension's
  // placeholder chips.
  try { window.dispatchEvent(new CustomEvent("pi-web:composer-value-written")); } catch {}
}

/** Merge submitted text into existing text (submitted first, current after, blank-line separated). */
export function mergeText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}
/** Merge submitted text + images into the existing draft (images capped at 10). */
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

/** Non-image file attachments (PDF/documents etc.) — backend sessions only (fileAttachments capability). */
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
  /** "New session" fork (silent, in the background): clone a new session from the
   *  current full context and start it with the input content as its first user
   *  message (does not switch the current session; works while running or idle).
   *  Returns false = not created (nothing to fork / backend unsupported) — the
   *  input content is left untouched. */
  onForkNew?: (message: string, images?: AttachedImage[], files?: AttachedFile[]) => Promise<boolean> | boolean | void;
  onAbort: () => void;
  /** A stop request has been sent and the agent is winding down (the backend is
   *  fire-and-forget but still waits for agent_settled): the stop button switches
   *  to a "stopping" spinning hourglass + disabled to prevent double clicks. */
  aborting?: boolean;
  /** Current session id: forwarded to the chatInputTop extension slot (e.g. per-session AI usage accounting in the AI-input extension) */
  sessionId?: string | null;
  onSteer?: (message: string, images?: AttachedImage[], files?: AttachedFile[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[], files?: AttachedFile[]) => void;
  /** Enqueue only, no dispatch (draft-restore "Re-queue" semantics): even when
   *  idle the message only enters the follow-up queue. Unlike onFollowUp — which
   *  ChatWindow wires only while the agent runs (for the hidden button) —
   *  onQueueFollowUp is always wired (the recovery path must enqueue while idle). */
  onQueueFollowUp?: (message: string, images?: AttachedImage[], files?: AttachedFile[]) => void;
  /** Send a queued follow-up as a steer (interrupt now). Available even when idle. */
  onQueueSteerSend?: (message: string, images?: AttachedImage[]) => void;
  /** Show the "Continue" button: appears when the AI is fully stopped (no streaming at all) and the input is empty. */
  canContinue?: boolean;
  /** Clicking "Continue": sends a "continue" message that makes the agent resume running. */
  onContinue?: () => void;
  /** Convert a queued message's kind (steer ↔ follow-up) without dispatching it. */
  onConvertQueueItem?: (kind: "steer" | "followUp", index: number, targetKind: "steer" | "followUp") => Promise<boolean>;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[], files?: AttachedFile[]) => void;
  /** Backend session capabilities (capability-aware control rendering; null = local session) */
  sessionCapabilities?: Record<string, boolean> | null;
  /** Current permission mode (backend sessions only; absent for local sessions) */
  permissionMode?: string;
  /** Switch permission mode (available when the setPermissionMode capability is present) */
  onSwitchPermissionMode?: (mode: string) => void;
  isStreaming: boolean;
  /** Text-only composer without the session controls or outer spacing. */
  compact?: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; input?: string[]; avail?: "ok" | "rl" | "err" | "unprobed"; providerRL?: boolean }[];
  modelError?: string | null;
  /** Diagnostics from resolving `enabledModels`, e.g. a pattern that matched nothing. */
  modelScopeWarnings?: string[];
  /** Manually refresh the model catalog (passed by ChatWindow on the new-session page when the backend supports it; the refresh row is hidden by default) */
  onRefreshModels?: () => void;
  modelsRefreshing?: boolean;
  onModelChange?: (provider: string, modelId: string) => void;
  modelSwitching?: boolean;
  /** Current session context percentage (ChatWindow forwards contextUsage?.percent) — drives the urgency coloring of the compact button/dialog dot */
  contextPercent?: number | null;
  /** Full context snapshot (ChatWindow forwards contextUsage) — extra.context data source for the composerTools/modelInfoLead slots (the context-meter extension's ratio bar) */
  contextUsage?: ContextUsage | null;
  /** Open the session stats panel (AppShell openSessionStatsPanel) — slot extra.openSessionInfo */
  onSessionStatsPanelOpen?: () => void;
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
  /** New session has not committed a thinking level; the button still shows the resolved default. */
  isAutoThinkingSelection?: boolean;
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  queuedMessages?: QueuedMessages | null;
  /** Task list (read-only mirror of the agent working plan; empty arrays render nothing, see TaskListPanel) */
  tasks?: SessionTask[] | null;
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
  /**
   * Composer × clear path: write the cleared input content (text + images)
   * straight to the trash (trash_direct_add, bypassing the live queue).
   * Returns whether the write succeeded.
   */
  onTrashComposerInput?: (text: string, images?: ChatDraftImage[]) => Promise<boolean>;
  /**
   * Restore a composer (cleared-input) entry from the trash and return its full
   * content (including image base64); the input box refills it for continued
   * editing (it does not enter the queue).
   */
  onRestoreComposerTrash?: (id: string) => Promise<{ text: string; images: ChatDraftImage[] } | null>;
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
  /** True while an "edit from here" pending-send marker is active: the prefilled content must not be written to the draft (it auto-restores on navigation/refresh) */
  suppressDraft?: boolean;
  /** Mobile: scroll-follow state (inverted mirror of smartFollow's userScrolledAway) — consumed by the placeholder P3/P4 logic. */
  followStreaming?: boolean;
  /** Mobile ⓘ sheet "extension status" row data (the desktop status rack is unchanged and rendered directly by ChatWindow). */
  extensionStatuses?: ExtensionStatusItem[];
  /** Mobile ⓘ sheet "extension panels" row data (the desktop status rack is unchanged). */
  extensionWidgets?: ExtensionWidgetItem[];
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
  /** Failed-submit refills (quoted-branch): merge the text back into the current input (concatenating when input exists); the draft is persisted by the keeper via the onChange broadcast. */
  restoreSubmission: (text: string) => void;
  /** Run the extension chat hooks' preSend ([element N]/[answer N]/[error N] → real content); returns the text unchanged when no hooks are registered. */
  runChatHooks: (text: string) => string;
  /** True when the input box has text or images (used to tell a live draft from a recoverable one). */
  hasInput: () => boolean;
  /** Programmatic write (composer-contract controlled path: state → DOM sync effect, tracker kept in sync) */
  setValueTracked: (text: string) => void;
  /** Clear the input box (prefill/draft/image previews included) — used by "cancel edit-from-here" */
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

export function cycleListIndex(index: number, length: number, delta: number): number {
  if (length <= 0) return 0;
  return ((index + delta) % length + length) % length;
}

export function replaceLinksWithMarkdown(
  text: string,
  links: Iterable<{ label: string; href: string; occurrence: number }>,
): string | null {
  let result = "";
  let searchFrom = 0;
  let replaced = false;

  for (const { label, href, occurrence } of links) {
    if (!label || !href) continue;
    let index = 0;
    for (let match = 0; match <= occurrence; match++) {
      index = text.indexOf(label, match ? index + label.length : 0);
      if (index < 0) break;
    }
    if (index < searchFrom) continue;
    const escapedLabel = label.replace(/([\\[\]])/g, "\\$1");
    const escapedHref = href.replace(/([\\()])/g, "\\$1");
    result += `${text.slice(searchFrom, index)}[${escapedLabel}](${escapedHref})`;
    searchFrom = index + label.length;
    replaced = true;
  }

  return replaced ? result + text.slice(searchFrom) : null;
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

function subscribeUpwardMenuMaxHeight(
  menu: HTMLElement,
  onChange: (height: number) => void,
): () => void {
  let frameId: number | null = null;
  const update = () => {
    frameId = null;
    onChange(getUpwardMenuMaxHeight(
      menu.getBoundingClientRect().bottom,
      getVisibleTopBoundary(menu),
    ));
  };
  const scheduleUpdate = () => {
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(update);
  };

  update();
  const parent = menu.parentElement;
  const layoutContainer = parent?.parentElement;
  const anchorObserver = typeof ResizeObserver === "undefined" || !parent
    ? null
    : new ResizeObserver(scheduleUpdate);
  if (parent) anchorObserver?.observe(parent);
  if (layoutContainer) anchorObserver?.observe(layoutContainer);
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

/** ↑/↓ queue navigation target (pure function): navigation spans the flattened
 *  queue [steering…, followUp…] (matching the panel display order). Returns null
 *  at either end (top/bottom) — the current edit stays put. */
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

/** Read-only fallback queue rows (upstream-shaped: count + Recall all + read-only
 *  rows; the full row-action UI renders in the queue-keeper extension's queuePanel
 *  slot — de-forking P3).
 *  When no takeover exists (extension missing/disabled), core renders these rows
 *  plus Recall all and the count-only fallback banner. */
/** Queue row attachment icons (lucide image / paperclip, matching the inline
 *  action icon style). Shared visual language between the core fallback row and
 *  the extension queue row: marks a message as carrying images/files. */
export function QueueAttachIcons({ hasImages, hasFiles, imageTitle, fileTitle }: {
  hasImages?: boolean; hasFiles?: boolean; imageTitle?: string; fileTitle?: string;
}) {
  if (!hasImages && !hasFiles) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0, color: "var(--text-dim)" }}>
      {hasImages && (
        <span title={imageTitle} style={{ display: "inline-flex", alignItems: "center" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </span>
      )}
      {hasFiles && (
        <span title={fileTitle} style={{ display: "inline-flex", alignItems: "center" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </span>
      )}
    </span>
  );
}

function FallbackQueueRow({ kind, text, hasImages }: { kind: "steer" | "follow-up"; text: string; hasImages?: boolean }) {
  const { t } = useI18n();
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
      <QueueAttachIcons hasImages={hasImages} imageTitle={t("chat.queueHasImages")} fileTitle={t("chat.queueHasFiles")} />
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

/** Handle (shared since the v4 13th review): two states — a capsule (with an embedded count ⎯ N ⎯ when a queue exists) or a thin bar; tap cycles the three bottom modes. */
function NotchHandle({ capsule, count, onClick, title }: {
  capsule: boolean;
  count: number;
  onClick: () => void;
  title: string;
}) {
  if (!capsule) {
    return (
      <div
        aria-hidden="true"
        onClick={onClick}
        title={title}
        style={{ width: 28, height: 4, borderRadius: 2, background: "var(--border)", cursor: "pointer" }}
      />
    );
  }
  return (
    <button
      type="button"
      aria-label={title}
      onClick={onClick}
      title={title}
      style={{ display: "flex", alignItems: "center", padding: "3px 9px", background: "transparent", border: "none", cursor: "pointer" }}
    >
      {/* The capsule background wraps only the middle ⎯ N ⎯ content; the button ends stay transparent so the text below is not covered */}
      <span style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 99, background: "var(--border)", color: "var(--text-muted)", fontSize: 11, fontWeight: 700, lineHeight: 1.2 }}>
        <span aria-hidden="true" style={{ width: 9, height: 2, borderRadius: 1, background: "currentColor" }} />
        {count}
        <span aria-hidden="true" style={{ width: 9, height: 2, borderRadius: 1, background: "currentColor" }} />
      </span>
    </button>
  );
}

function ModelNoticeBanner({ tone, title, body, onClose }: { tone: "error" | "warning"; title: string; body: string; onClose?: () => void }) {
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
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{body}</div>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          style={{
            flexShrink: 0,
            background: "none",
            border: "none",
            padding: "0 2px",
            cursor: "pointer",
            color: "inherit",
            opacity: 0.7,
            fontSize: 13,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

export function ModelErrorBanner({ error }: { error?: string | null }) {
  const { t } = useI18n();
  if (!error) return null;
  return <ModelNoticeBanner tone="error" title={t("chat.modelError")} body={error} />;
}

/** True when the selected model is known to accept image input (#584). Unknown modality info never blocks the user. */
export function modelSupportsImageInput(
  model: { provider: string; modelId: string } | null | undefined,
  modelList: { id: string; name: string; provider: string; input?: string[] }[] | undefined
): boolean {
  if (!model) return true;
  const entry = modelList?.find((m) => m.provider === model.provider && m.id === model.modelId);
  if (!entry || !entry.input) return true;
  return entry.input.includes("image");
}

/** Surfaces `enabledModels` patterns that matched nothing, so a typo is visible (#307). */
export function ModelScopeWarningBanner({ warnings }: { warnings?: string[] }) {
  const { t } = useI18n();
  if (!warnings || warnings.length === 0) return null;
  return (
    <ModelNoticeBanner
      tone="warning"
      title={warnings.length > 1 ? t("chat.modelScopeWarnings") : t("chat.modelScopeWarning")}
      body={warnings.join("\n")}
    />
  );
}

/** Compact icon-only action button for the streaming input row, with a
 *  hover/focus popover that carries the label + hint. Keeping the inline text
 *  out of the row prevents the two queue buttons from squeezing the textarea —
 *  the meaning lives in the popup (popup-only styling), the button itself stays a
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
  // Mobile touch targets are uniformly enlarged 120% (30 → 36px); icons scale proportionally.
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

// ============================================================================
// Mobile "WeChat-style" input-area helpers (mobile input plan v3)
// ============================================================================

/** base64 → Blob (for rebuilding image previews on clear-undo/trash-restore: the snapshot holds only data references, previewUrl must be reconstructed). */
export function base64ToBlob(b64: string, mimeType: string): Blob {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mimeType });
}

// ============================================================================
// Mobile "WeChat-style" state matrix (mobile input plan §3/§7; dropped in the
// v4 10th review: the placeholder matrix is retired — same logic as desktop, no
// separately maintained levels) —
// pure function: the component renders from the result, and unit tests pin the
// matrix (P8).
// ============================================================================

/** Mobile right-side button matrix (v4, §19): the left group is gone, all buttons
 *  live on the right — ＋(info panel)/images are persistent, while the conditional
 *  buttons (clear/🎤/continue/send/stop/steer/queue) float in at the render layer
 *  when "focused or has content"; the matrix only decides existence.
 *  canSteerFromQueue (restored in the 11th review): with an empty input and a
 *  non-empty queue the steer button reappears — clicking dispatches the first
 *  queued follow-up as a steer (v3 S9a entry regression; the sendQueued
 *  empty-input path supports it natively). */
export interface MobileComposerMatrix {
  hasContent: boolean;
  /** steer/⏰ (while running) enabled when there is text or images (v4 9th review: images unblocked — the pipeline already forwards images). */
  steerReady: boolean;
  /** Send button enabled: idle = has content; running = has text and no images. */
  sendEnabled: boolean;
  /** ＋ info-panel entry (persistent; replaces the v3 ⓘ). */
  plus: boolean;
  /** Images (persistent; disabled while running). */
  image: boolean;
  /** Clear × (when there is content). */
  clear: boolean;
  /** Continue (empty input and not running; the render site also &&s onContinue && canContinue). */
  cont: boolean;
  /** Send (idle with content; not rendered while running — steer is the only entry point, avoiding a duplicate button since the v4 5th review). */
  send: boolean;
  /** Stop (while running; since v4 [user decision] no longer limited to empty input). */
  stop: boolean;
  /** Steer (running with content; the disable-with-images rule follows F3). */
  steer: boolean;
  /** Queue (running with content; the disable-with-images rule follows F3). */
  clock: boolean;
  /** Fork a new session (when there is content; shown running or idle, silent in the background without switching). */
  fork: boolean;
}

/** Context-meter extension seam: contextUsage → slot extra.context snapshot;
 *  null/undefined pass through as null (the extension's gray "no context data"
 *  state). urgency is the full contextUrgency(percent) result (level/color/bg/
 *  border — the host is the single source of the color scale; the extension
 *  ships no palette of its own). */
export function buildExtContextSnapshot(
  contextUsage: Pick<ContextUsage, "percent" | "contextWindow" | "tokens"> | null | undefined,
  urgency: CtxUrgency,
): { percent: number | null; contextWindow: number | null; tokens: number | null; urgency: CtxUrgency } | null {
  if (!contextUsage) return null;
  return {
    percent: contextUsage.percent ?? null,
    contextWindow: contextUsage.contextWindow ?? null,
    tokens: contextUsage.tokens ?? null,
    urgency,
  };
}

export function computeMobileComposerMatrix(opts: {
  isStreaming: boolean;
  hasInputText: boolean;
  imageCount: number;
  canSteerFromQueue?: boolean;
  hasSteerCapability: boolean;
  hasFollowUpCapability: boolean;
  hasAbortCapability: boolean;
}): MobileComposerMatrix {
  const { isStreaming, hasInputText, imageCount, canSteerFromQueue, hasSteerCapability, hasFollowUpCapability, hasAbortCapability } = opts;
  const hasContent = hasInputText || imageCount > 0;
  // v4 9th review: images unblocked — the steer/followUp pipeline already
  // forwards images (onSteer/onFollowUp/onPromptWithStreamingBehavior); the
  // disable was purely an old F3 UI-layer constraint. Any content can steer now.
  const steerReady = hasContent;
  if (!isStreaming) {
    return {
      hasContent,
      steerReady: false,
      sendEnabled: hasContent,
      plus: true,
      image: true,
      clear: hasContent,
      cont: !hasContent,
      send: hasContent,
      stop: false,
      steer: false,
      clock: false,
      fork: hasContent,
    };
  }
  return {
    hasContent,
    steerReady,
    sendEnabled: steerReady,
    plus: true,
    image: true,
    clear: hasContent,
    cont: false,
    // v4 5th review: no Send while running (duplicate of steer — both are sendQueued("steer"); steer is the single entry)
    send: false,
    stop: hasAbortCapability,
    // v4 11th review: with empty input but a non-empty queue, steer still appears — clicking dispatches the first queued entry as a steer (the empty-input sendQueued path supports it natively)
    steer: hasSteerCapability && (hasContent || Boolean(canSteerFromQueue)),
    clock: hasFollowUpCapability && hasContent,
    fork: hasContent,
  };
}

/** Fork-new-session icon (git-fork outline: three nodes converging) — shared by
 *  the desktop StreamingActionButton and the mobile MobileIconButton. Distinguish
 *  from "edit from here / branch": this one converges downward into a new node. */
function ForkNewIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
      <path d="M12 12v3" />
    </svg>
  );
}

/** Mobile matrix icon button: 32×32 hit area, no background, 120ms fade-in on
 *  entry (a lightweight take on the WeChat "＋↔send" transition). Pure display
 *  component; enable state and tint come from the caller. */
function MobileIconButton({ label, title, onClick, disabled, color, onPointerDown, children }: {
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  color?: string;
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onPointerDown={onPointerDown}
      onClick={onClick}
      className="ci-mobile-icon"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        padding: 0,
        background: "none",
        border: "none",
        borderRadius: 9,
        color: color ?? "var(--text-muted)",
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "opacity 0.12s, color 0.12s",
      }}
    >
      {children}
    </button>
  );
}

/** ⓘ sheet collapsible section row: header row (tap to toggle) + expandable body. Single-open behavior is controlled by parent state. */
function SheetSection({ label, summary, badge, open, onToggle, children }: {
  label: string;
  summary?: React.ReactNode;
  badge?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ borderBottom: "1px solid color-mix(in srgb, var(--border) 60%, transparent)" }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "11px 14px",
          background: "none",
          border: "none",
          color: "var(--text)",
          cursor: "pointer",
          fontSize: 13.5,
          textAlign: "left",
        }}
      >
        <span style={{ flexShrink: 0, display: "inline-flex", width: 7, height: 7, borderRadius: 99, background: "var(--accent)", opacity: 0.75 }} />
        <span style={{ flexShrink: 0, fontWeight: 600 }}>{label}</span>
        <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)", fontSize: 12.5, textAlign: "right" }}>{summary}</span>
        {badge}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : undefined, transition: "transform 0.15s" }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && <div style={{ padding: "0 14px 12px" }}>{children}</div>}
    </div>
  );
}

/** Option row (inside the sheet): check state + label + right-side description. */
function SheetOptionRow({ active, label, desc, onClick }: {
  active: boolean;
  label: React.ReactNode;
  desc?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        background: active ? "var(--bg-selected)" : "none",
        border: "none",
        borderRadius: 7,
        color: active ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer",
        fontSize: 12.5,
        textAlign: "left",
        fontWeight: active ? 600 : 400,
      }}
    >
      {active
        ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
        : <span style={{ width: 10, flexShrink: 0 }} />}
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      {desc != null && <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>}
    </button>
  );
}

/** Mini inline action button inside the sheet (queue recall/import/export). */
function sheetMiniBtn(): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "5px 10px",
    background: "none",
    border: "1px solid var(--border)",
    borderRadius: 7,
    color: "var(--text)",
    cursor: "pointer",
    fontSize: 11.5,
    whiteSpace: "nowrap",
  };
}

/** New-session promotion detection: provisional draft key (`new:<draftId>:<cwd>`)
 *  → real session id. This is not "switching sessions" — a session switch bumps
 *  AppShell's sessionKey and remounts the whole ChatWindow, so this instance's
 *  previousDraftKey is undefined; only a `new:…` → sid migration while the same
 *  composer tree stays alive counts as a promotion. */
export function isDraftKeyPromotion(previous: string | undefined, next: string | undefined): boolean {
  return typeof previous === "string" && previous.startsWith("new:")
    && typeof next === "string" && !next.startsWith("new:");
}

// Focus handoff: the moment a new session is sent, the composer moves from
// "centered on the welcome page" to "bottom of the message flow" — two different
// DOM positions, the whole ChatInput remounts, and focus dies with the old node
// → the mobile keyboard collapses and IME composition is lost. On unmount the
// old instance records "focus is on me" in module scope; the new instance picks
// it up on mount (after a send in an existing session focus already stays in the
// box, so both branches align).
let composerLiveFocused = false;
let pendingFocusHandoff = false;

const ChatInputInner = forwardRef<ChatInputHandle, Props>(function ChatInput({
  sessionId,
  onSend, onAbort, aborting, onForkNew, onSteer, onFollowUp, onQueueFollowUp, onQueueSteerSend, canContinue, onContinue, onConvertQueueItem, isStreaming, model, isAutoModelSelection, modelNames, modelList, modelError, modelScopeWarnings, onModelChange, modelSwitching, onRefreshModels, modelsRefreshing,
  sessionCapabilities, onSwitchPermissionMode, permissionMode,
  contextPercent, contextUsage, onSessionStatsPanelOpen, onCompact, onAbortCompaction, isCompacting, compactError, compactResult, compactQueued, onCancelCompactQueue, modelSwitchPending, toolPreset, onToolPresetChange,
  thinkingLevel, isAutoThinkingSelection = false, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  retryInfo, queuedMessages, tasks, inputHistory = [], onRecallQueue,
  onExportQueue, onImportQueue, onStageImport, onMoveQueue, onRecallOne, onRequeueAt, onRemoveQueueItem,
  queueTrash, onRestoreQueueItem, onPurgeQueueTrash, onTrashComposerInput, onRestoreComposerTrash,
  slashCommands, slashCommandsLoading, onLoadSlashCommands,
  onBuiltinCommand,
  soundEnabled, onSoundToggle, onAudioUnlock,
  onPromptWithStreamingBehavior,
  draftKey,
  cwd,
  suppressDraft,
  followStreaming = true,
  extensionStatuses = [],
  extensionWidgets = [],
  compact = false,
}: Props, ref) {
  const { t } = useI18n();
  // Context urgency (lib/context-urgency.ts is the single source): colors the
  // idle-state compact button/dialog dot; the critical-level breathe animation
  // applies only while idle (the compacting/queued states keep their red/yellow
  // action colors and add no animation).
  const ctxUrg = contextUrgency(contextPercent);
  const idleCtxColor = ctxUrg.color;
  const idleCtxBreathe = ctxUrg.level === "critical" ? CTX_BREATHE_CSS : undefined;
  // ── Context-meter extension seam (§4/§5): context snapshot + compaction tri-state
  //    + session-panel entry forwarded to composerTools / modelInfoLead — the host
  //    holds zero display logic; presentation/interaction live entirely in the extension.
  const extSeamContext = buildExtContextSnapshot(contextUsage, ctxUrg);
  const extSeamCompact = { onCompact, onAbortCompaction, onCancelCompactQueue, isCompacting, compactQueued };
  const { fontSize } = useChatAppearance();
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
  // Mobile ＋ panel (v4: ⓘ upgraded into the ＋ panel — model/thinking/tools/
  // compaction/sound/queue sections + extension status/extension panels (open by
  // default) + bottom action area (core: camera/files//commands; the composerTools
  // slot supplies the rest))
  const [infoSheetOpen, setInfoSheetOpen] = useState(false);
  const [infoSheetSections, setInfoSheetSections] = useState<Set<"model" | "thinking" | "tools" | "extStatus" | "extWidgets">>(new Set());
  const [infoSheetBottom, setInfoSheetBottom] = useState(12);
  const [infoSheetMaxHeight, setInfoSheetMaxHeight] = useState(480);
  const queueImportInputRef = useRef<HTMLInputElement>(null);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const anyFileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const trimmedValue = value.trimStart();
  const bashMode = attachedImages.length === 0 && trimmedValue.startsWith("!");
  const bashExcluded = bashMode && trimmedValue.startsWith("!!");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashMenuMaxHeight, setSlashMenuMaxHeight] = useState<number | null>(null);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atMenuMaxHeight, setAtMenuMaxHeight] = useState<number | null>(null);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [imageWarningDismissed, setImageWarningDismissed] = useState(false);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyActiveIndex, setHistoryActiveIndex] = useState(0);
  // Direct session-history paging (shell-style ↑/↓, when no queued messages):
  // null = not paging; while paging, tracks the matched history index plus the
  // original text we wrote into the box (to detect manual edits → auto-exit paging).
  const historyNavIndexRef = useRef<number | null>(null);
  const historyNavTextRef = useRef<string>("");
  // Recall mutex: forbids concurrent recall/requeue while ↑/↓ is held down or a
  // row button is tapped repeatedly, so one entry cannot be requeued twice or orphaned.
  const recallBusyRef = useRef(false);
  const [builtinCommandPending, setBuiltinCommandPending] = useState(false);
  const builtinCommandPendingRef = useRef(false);
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
    // Mobile new session (welcome page): enough space, don't fold — ignore persisted minimal/queueHidden.
    if (isMobile && sessionId == null) return "full";
    try {
      const v = window.localStorage.getItem("pi-chat-bottom-mode");
      return v === "queueHidden" || v === "minimal" ? v : "full";
    } catch { return "full"; }
  });
  const bottomModeRef = useRef(bottomMode);
  useEffect(() => { bottomModeRef.current = bottomMode; }, [bottomMode]);
  // Mobile new session (welcome page, no session id): input folding is disabled
  // entirely — no handle rendered, swipe gestures inert, bottom mode pinned to
  // full. Only the centered input bar exists and there is no message flow to make
  // room for, so folding is pure downside; once the first message is sent the
  // sessionId lands → the three-mode folding resumes automatically.
  const foldDisabled = isMobile && sessionId == null;
  const effectiveBottomMode: BottomMode = foldDisabled ? "full" : bottomMode;
  // Mobile folded to minimal: flash a one-time "swipe up from the bottom to pull
  // the input back" hint (auto-dismisses) plus a low-frequency handle pulse.
  // Fires on every entry into minimal; cleared on expand (effect cleanup cancels
  // the timer early).
  const [collapseHintVisible, setCollapseHintVisible] = useState(false);
  const prevEffectiveModeRef = useRef<BottomMode>(effectiveBottomMode);
  useEffect(() => {
    const prev = prevEffectiveModeRef.current;
    prevEffectiveModeRef.current = effectiveBottomMode;
    if (!isMobile || effectiveBottomMode !== "minimal" || prev === "minimal") return;
    setCollapseHintVisible(true);
    const timer = window.setTimeout(() => setCollapseHintVisible(false), 4000);
    return () => window.clearTimeout(timer);
  }, [isMobile, effectiveBottomMode]);
  // Mirrors the live queue count for cycleBottomMode (defined before queueCount).
  const queueCountRef = useRef(0);
  const cycleBottomMode = useCallback((dir: 1 | -1 = 1, wrap = true) => {
    if (foldDisabled) return;
    const prev = bottomModeRef.current;
    // With no queued messages the "queue hidden" level is pointless, so both
    // swipes and click-cycles skip it: full ↔ minimal directly.
    const order: BottomMode[] = queueCountRef.current === 0
      ? ["full", "minimal"]
      : ["full", "queueHidden", "minimal"];
    let idx = order.indexOf(prev);
    if (idx === -1) {
      // A persisted queueHidden is no longer in order once the queue empties
      // (indexOf=-1) — normalize toward its parent level (full): +1 → minimal
      // (matching the BottomModeBar label), -1 → stay expanded.
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
      setModelDropdownOpen(false);
    }
    setBottomMode(next);
  }, [foldDisabled]);

  // Swipe gestures on the bottom panels: swipe down collapses one level
  // (full → queueHidden → minimal), swipe up expands one level back.
  const SWIPE_THRESHOLD = 44;
  const touchStartRef = useRef<{ y: number; x: number; active: boolean } | null>(null);
  const [swipeHint, setSwipeHint] = useState<"up" | "down" | null>(null);
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!isMobile) return;
    if (foldDisabled) {
      // Mobile new-session (welcome page): collapsing fully disabled, swipe gestures not registered
      touchStartRef.current = null;
      return;
    }
    // Gestures disabled while the ⓘ sheet is open (a swipe on the overlay must not fold the bottom area)
    if (infoSheetOpen) {
      touchStartRef.current = null;
      return;
    }
    if (e.target instanceof Element) {
      // Text editing / scrolling inside the textarea takes priority.
      if (e.target.closest("textarea")) {
        touchStartRef.current = null;
        return;
      }
      // Affix-slot buttons (core × / extension 🎤): push-to-talk is a long-press gesture and must never be treated as a collapse swipe
      if (e.target.closest("[data-composer-affix]")) {
        touchStartRef.current = null;
        return;
      }
      // Popup panels floating above the input area (model list/ slash, @, history
      // menu/thinking, tools dropdown): scrolling the list inside a panel is a
      // normal action and must not be read as a downward fold gesture collapsing
      // the whole bottom input area.
      if (e.target.closest("[data-input-overlay]")) {
        touchStartRef.current = null;
        return;
      }
    }
    const t = e.touches[0];
    touchStartRef.current = { y: t.clientY, x: t.clientX, active: true };
  }, [isMobile, infoSheetOpen, foldDisabled]);
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
  // ── Queue panel (the queue-keeper extension renders it via the queuePanel slot; core keeps only the count and edit-intent) ──
  const queueCount = (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0);
  const trashCount = queueTrash?.length ?? 0;
  // v4 queue visibility (§19): any queue growth (enqueue/import/recovery/Re-queue —
  // a rising queueCount covers all paths) → force bottomMode back to full + pulse
  // the banner once. prevQueueCountRef starts at the current value on mount, so a
  // session's pre-existing restored queue does not trigger; recall/steer injection
  // shrinking the queue does not trigger either.
  const prevQueueCountRef = useRef<number | null>(null);
  const queueBannerRef = useRef<HTMLDivElement | null>(null);
  const [queueBannerPulse, setQueueBannerPulse] = useState(0);
  useEffect(() => {
    const prev = prevQueueCountRef.current;
    prevQueueCountRef.current = queueCount;
    if (prev == null || queueCount <= prev) return;
    setBottomMode((m) => {
      if (m !== "full") {
        try { window.localStorage.setItem("pi-chat-bottom-mode", "full"); } catch { /* ignore */ }
        return "full";
      }
      return m;
    });
    setQueueBannerPulse((p) => p + 1);
  }, [queueCount]);
  // Re-trigger the pulse animation via DOM class manipulation (the extension panel is not remounted — its expanded state/scroll position survive)
  useEffect(() => {
    if (queueBannerPulse === 0) return;
    const el = queueBannerRef.current;
    if (!el) return;
    el.classList.remove("queue-banner-pulse");
    void el.offsetWidth; // force a reflow to restart the animation
    el.classList.add("queue-banner-pulse");
  }, [queueBannerPulse]);
  // Oversized-attachment notice (a core-owned lightweight notice; queue-panel notifications moved to the extension along with the UI)
  const [fileNotice, setFileNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const fileNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showFileNotice = useCallback((text: string, ok: boolean) => {
    setFileNotice({ text, ok });
    if (fileNoticeTimerRef.current) clearTimeout(fileNoticeTimerRef.current);
    fileNoticeTimerRef.current = setTimeout(() => setFileNotice(null), 3000);
  }, []);

  // P3 takeover detection: an actual item in the queuePanel slot (extension
  // materialized and feature on) → hide the core fallback banner; the extension
  // renders the full UI through the slot. The capability contract
  // EXT_PROVIDES.queuePanel stays registered in lib/ext/types.ts (documentation);
  // at runtime the actual slot items decide — feature off/unloaded/async load
  // incomplete falls back to the banner (zero data migration; sidecar/trash all
  // live in core).
  const extOwnsQueuePanel = useExtSlotItems("queuePanel").length > 0;

  // Model button takeover (the model-wizard extension): an item with render in the
  // modelSelector slot → render the extension component in place of the native
  // ModelSelector (handed the same model/options/onChange contract); unregistered/
  // still loading → native dropdown fallback with zero regression (the same
  // springboard pattern as fileViewer). useExtSlotItems materializes on demand.
  const modelSelectorTakeover = useExtSlotItems("modelSelector").find(hasExtRender);

  // Assemble queuePanel slot props (core → extension: live view + trash + action
  // primitives). All actions forward ChatInput's existing RPC handlers;
  // parseImport/downloadExport pass core pure functions straight through (single
  // implementation, zero logic in the extension).
  const queuePanelExtra: QueuePanelProps = {
    live: {
      steering: (queuedMessages?.steering ?? []).map((text, i) => ({
        id: `steer:${i}`, kind: "steer" as const, text,
        hasImages: Boolean(queuedMessages?.steeringHasImages?.[i]), hasFiles: false, queuedAt: 0, index: i,
      })),
      followUp: (queuedMessages?.followUp ?? []).map((text, i) => ({
        id: `followUp:${i}`, kind: "followUp" as const, text,
        hasImages: Boolean(queuedMessages?.followUpHasImages?.[i]), hasFiles: false, queuedAt: 0, index: i,
      })),
    },
    trash: queueTrash ?? null,
    queueCount,
    trashCount,
    // External agent backends (session ids carry a provider prefix, e.g. zcode:/codex:)
    // have already injected their steer entries into the backend CLI process
    // (agent backend-queue modules); the protocol does not support recall/move/
    // convert — such operations always raise AgentCommandError. Mark readonly so
    // queuePanel hides steer row-level actions; exclude new: drafts (a new session
    // uses the built-in pi backend, where steer is manageable). Built-in pi session
    // ids are plain UUIDs without a prefix.
    steerReadonly: /^(?!new:)[a-z][\w-]*:/i.test(sessionId ?? ""),
    actions: {
      move: (kind, from, to) => kind !== "composer" ? (onMoveQueue?.(kind, from, to) ?? Promise.resolve(false)) : Promise.resolve(false),
      convert: (kind, index, target) => kind !== "composer" && target !== "composer" ? (onConvertQueueItem?.(kind, index, target) ?? Promise.resolve(false)) : Promise.resolve(false),
      // Recall into the input box (the edit-intent state machine lives in core; the extension only triggers) — returns the text for display
      recallOne: async (kind, index) => {
        if (kind === "composer") return null; // composer trash entries never go through queue recall (restoreToComposer only)
        const text = await handleRecallOne(kind, index);
        return text ? { text } : null;
      },
      requeueAt: (kind, index, text, images) => kind !== "composer" ? (onRequeueAt?.(kind, index, text, images) ?? Promise.resolve(false)) : Promise.resolve(false),
      // Soft delete (→ trash; touches no core edit-intent path; the undo toast is managed inside the extension)
      remove: (kind, index, opts) => kind !== "composer" ? (handleRemoveQueueItem(kind, index, opts) ?? Promise.resolve(null)) : Promise.resolve(null),
      restore: (id, index) => onRestoreQueueItem?.(id, index) ?? Promise.resolve(false),
      // Trash composer (cleared-input) entry → restore into the input box for continued editing (core fetches the full content and refills)
      restoreToComposer: (id) => handleRestoreComposerTrash(id),
      purge: (ids) => onPurgeQueueTrash?.(ids) ?? Promise.resolve(false),
      recallAll: () => onRecallQueue?.(),
      steerSend: (text, images) => onQueueSteerSend?.(text, images?.length ? images.map((im) => ({ data: im.data, mimeType: im.mimeType, previewUrl: `data:${im.mimeType};base64,${im.data}` })) : undefined),
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
  /** Recall core (no mutex). mode="append" (default): merge with the input box's
   *  existing content (inline recall button); mode="replace": replace the input
   *  content wholesale (↑/↓ queue navigation steps through entries).
   *  Returns the recalled text (null when nothing recalled/failed) — consumed by
   *  the queue panel contract's actions.recallOne. */
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
    // Expand the queue panel after recalling into the box (via the controller when the extension has taken over; no-op with no takeover/no folded state)
    getQueuePanelController()?.expand();
    return entry.text;
  }, [onRecallOne, value]);
  /** Recall one queued message into the input box for continued editing (mutex: new requests are ignored during rapid ↑/↓ or repeated taps). Returns the recalled text. */
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
  /** Soft-delete one entry (core primitive: forwards the RPC + edit-intent
   *  cleanup; the undo toast is managed inside the extension panel).
   *  Shared by the send flow (empty-box Enter promotes the first entry) and the
   *  extension's actions.remove. */
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
  const atMenuRef = useRef<HTMLDivElement>(null);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  // Starts undefined so the draftKey effect also runs on first mount →
  // emitComposerKeyChange broadcasts the initial key (composer enhancement
  // contract: extensions need the current key to store drafts)
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

  // Controlled write (for extensions: autocomplete insertion etc.): syncs
  // valueRef + triggers the React state update. Matches the existing write paths
  // (onSend/appendText etc.): valueRef first, setValue after.
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
      // Write the new value into the DOM synchronously: React 18's controlled
      // commit is asynchronously scheduled; if we only setValue and queue an rAF
      // to place the caret, the rAF can run before the React commit — ta.value is
      // then still the old (empty) value, setSelectionRange(combined.length) gets
      // clamped to 0, and the later commit moves the caret to the end without
      // scrolling — a long quote stays stuck on the first line. After the
      // synchronous write, React's controlled commit sees node.value already
      // equals the new value and skips the overwrite (leaving our caret alone).
      // Must go through writeTextareaValue (native setter + synced _valueTracker):
      // a bare ta.value write bypasses React's value tracker, and a user edit that
      // lands back on the same value would be deduped away.
      if (ta) writeTextareaValue(ta, combined);
      valueRef.current = combined;
      setValue(combined);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(combined.length, combined.length);
        // The caret target (the end) may be outside the viewport: in the frame
        // right after the value is written the browser does not guarantee that
        // setSelectionRange scrolls to the caret; scroll to the bottom explicitly
        // so the user sees where the reply landed (a long quote ends on its last line).
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
      // Sync-write DOM + tracker (do not gamble on the React commit vs rAF
      // ordering — after an async setValue the rAF can run before the commit,
      // leaving the DOM at the old value with the caret dropped at the start)
      const taNow = textareaRef.current;
      // Capture the caret before writing: once the DOM value is overwritten the browser shoves the caret to the end and it cannot be recovered afterwards.
      const wasFocused = !!taNow && taNow === document.activeElement;
      const caretBefore = taNow ? taNow.selectionStart : null;
      const lenBefore = taNow ? taNow.value.length : 0;
      // Same-value restore (draft text identical to the box, e.g. a failed-submit
      // refill) skips the DOM write: writing the same value would still push the
      // caret to the end — while typing mid-text it looks like "the caret got
      // yanked forward for no reason".
      const sameText = !!taNow && taNow.value === draft.value;
      valueRef.current = draft.value;
      if (!sameText && taNow) writeTextareaValue(taNow, draft.value);
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
        if (!sameText) {
          // User editing inside the box (focused, caret not at the end) → keep the
          // original caret position (clamped to the new length);
          // otherwise (empty box / caret already at the end / unfocused) the caret
          // lands at the end of the restored text.
          const pos = wasFocused && caretBefore !== null && caretBefore < lenBefore
            ? Math.min(caretBefore, ta.value.length)
            : ta.value.length;
          if (ta !== document.activeElement) ta.focus();
          ta.setSelectionRange(pos, pos);
        }
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    hasInput() {
      return Boolean(value.trim()) || attachedImagesRef.current.length > 0;
    },
    clearInput: () => clearInput(),
    /** Programmatic write (composer-contract controlled path: state → DOM sync effect, tracker kept in sync) */
    setValueTracked: (text: string) => setInputValue(text),
    runChatHooks(text: string) {
      return applyChatHooks(text);
    },
    restoreSubmission(text: string) {
      if (!text.trim()) return;
      const restored = valueRef.current.trim() ? `${valueRef.current}\n\n${text}` : text;
      valueRef.current = restored;
      setInputValue(restored);
      setAtQuery(null);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    expandQueue() {
      // P3: the extension owns the folded state; after core resolves recovery/import it expands via the controller (no-op without takeover)
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
    if (compact) return;
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
  }, [compact]);

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
    // The only path that clears the draft = the draft-keeper extension's onChange("") clear-confirmation chain
    // (single owner); core no longer calls clearDraft directly (its overlap with the clear-confirmation
    // chain/promote hand-off was once a race source)
    clearImages();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    historyNavIndexRef.current = null;
    historyNavTextRef.current = "";
  }, [clearImages]);

  // ── Clear undo + trash (v3 §3.1 + trash enhancement): before × clears, grab an
  // in-memory snapshot (zero-copy — images elements are held by reference and
  // clearImages only revokes previewUrl, data is untouched); a full undo stays
  // possible for 5s. At the same time the onClearToTrash enhancer (the
  // queue-keeper extension) writes the content straight to the trash
  // (trash_direct_add, bypassing the live queue) — a durable backstop so an
  // accidental clear can always be recovered.
  // The snapshot is memory-only: no localStorage and no draft-keeper involvement
  // (the draft mechanism remains the primary loss-prevention path).
  // Single level only: clearing again overwrites.
  const [undoSnapshot, setUndoSnapshot] = useState<{ text: string; images: AttachedImage[] } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Restore a {text, images} snapshot into the input box (shared by the in-memory
   *  undo and the trash→composer restore; previewUrl must be rebuilt). Programmatic
   *  writes go through setInputValue → the [value] DOM sync effect. */
  const restoreSnapshotToComposer = useCallback((text: string, images: ChatDraftImage[]) => {
    const restored = images.map((im) => ({ ...im, previewUrl: URL.createObjectURL(base64ToBlob(im.data, im.mimeType)) }));
    valueRef.current = text;
    setInputValue(text);
    setAtQuery(null);
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      attachedImagesRef.current = restored;
      return restored;
    });
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, [setInputValue]);

  const clearWithUndo = useCallback(() => {
    const snapshot = { text: valueRef.current, images: attachedImagesRef.current };
    // Hand to the queue-keeper extension's onClearToTrash enhancer to write the
    // trash (fire-and-forget; ignored when no enhancer is present — clearing
    // still has the immediate 5s in-memory undo as its backstop).
    emitComposerClearToTrash({
      value: snapshot.text,
      images: snapshot.images.map(imageToDraftImage),
      imageCount: snapshot.images.length,
      hasInput: Boolean(snapshot.text.trim()) || snapshot.images.length > 0,
    });
    clearInput();
    setUndoSnapshot(snapshot);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => setUndoSnapshot(null), 5000);
    // Refocus after clearing: the keyboard stays up (WeChat-style)
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [clearInput]);
  const undoClear = useCallback(() => {
    if (undoTimerRef.current) { clearTimeout(undoTimerRef.current); undoTimerRef.current = null; }
    const snap = undoSnapshot;
    setUndoSnapshot(null);
    if (!snap) return;
    restoreSnapshotToComposer(snap.text, snap.images.map((im) => ({ data: im.data, mimeType: im.mimeType })));
  }, [undoSnapshot, restoreSnapshotToComposer]);

  /** Trash "restore to composer": fetch the composer entry's full content from the server (including image base64) → refill for continued editing. */
  const handleRestoreComposerTrash = useCallback(async (id: string): Promise<boolean> => {
    if (!onRestoreComposerTrash) return false;
    const restored = await onRestoreComposerTrash(id);
    if (!restored) return false;
    // The restore rewrites the input content: invalidate any in-memory undo
    // snapshot still inside its 5s window, so clicking "Undo" cannot clobber the
    // freshly restored content back to the pre-clear value.
    if (undoTimerRef.current) { clearTimeout(undoTimerRef.current); undoTimerRef.current = null; }
    setUndoSnapshot(null);
    restoreSnapshotToComposer(restored.text, restored.images);
    return true;
  }, [onRestoreComposerTrash, restoreSnapshotToComposer]);

  // Trash-writer wiring: the enhancer (the queue-keeper extension's onClearToTrash)
  // picks this function up via getComposerTrashWriter() to write the trash
  // (fire-and-forget, failures silent).
  useEffect(() => {
    setComposerTrashWriter((snapshot) => {
      void onTrashComposerInput?.(snapshot.value, snapshot.images);
    });
    return () => setComposerTrashWriter(null);
  }, [onTrashComposerInput]);

  /** ↑/↓ queue navigation while recalling-to-edit: put the current edit back at
   *  its original queue position, then recall the adjacent entry to continue
   *  editing (exactly the same path as the inline recall button). Navigation spans
   *  the flattened queue [steering…, followUp…] (matching the panel display
   *  order). If the edit box was emptied, the original text is requeued as a
   *  fallback — navigation never loses a queue entry. */
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
      if (!ok) return; // requeue failed: keep the recall-edit state so the user can retry
      recalledRef.current = null;
      setRecalledVisible(false);
      clearInput();
      await doRecallOne(target.kind, target.index, "replace");
    } finally {
      recallBusyRef.current = false;
    }
  }, [queuedMessages, onRequeueAt, onRecallOne, doRecallOne, clearInput]);

  // Ordering matters: the [draftKey] effect must run before the [value] broadcast
  // effect — on mount/session switch keyChange fires first (the keeper records
  // pendingScan) and the subsequent onChange("") triggers the scan-restore. In the
  // reverse order onChange fires first (ignored because currentKey is unset),
  // pendingScan never sees another onChange, and recovery never runs.
  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey) return;
    // Persisting/clearing the old key's draft is owned by the keeper via
    // onKeyChange (writeNow for the old key + scan on key change);
    // core no longer calls setDraft(previousDraftKey) itself (avoid scattering)
    draftKeyRef.current = draftKey;
    // Composer enhancement contract: key-change broadcast (consumed by the draft
    // persistence scan-on-key-change and other extensions)
    emitComposerKeyChange(previousDraftKey, draftKey);
    // A promotion keeps the text: at that moment the box usually holds the next
    // input the user just typed while the AI was answering, and clearing it would
    // swallow their words in front of them + break IME composition (on mobile that
    // is exactly "interrupt my typing while the AI is still displaying"). The value
    // stays; the following onChange broadcast lands it in the sid slot (the keeper
    // already redirected currentKey to the sid in its sessionCreated intent).
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

  // Cross-session prefill ("open in a new session" style features): the extension first writes
  // window.__piWebPendingComposer = { text, at }, then dispatches pi-web:new-session / pi-web:open-session;
  // the target composer consumes and inserts it after mounting/key change. A 15s TTL keeps stale text from
  // being misdelivered; a one-shot short-delay timer avoids the same-commit [draftKey] clear effect
  // (the setValue("") above) and the extension restore chain — not polling.
  useEffect(() => {
    const w = window as Window & { __piWebPendingComposer?: { text?: unknown; at?: unknown } };
    const pending = w.__piWebPendingComposer;
    if (!pending || typeof pending.text !== "string" || !pending.text) return;
    const text = pending.text; // extract the narrowed value after the guard: the timer closure no longer relies on property narrowing
    if (Date.now() - (Number(pending.at) || 0) > 15000) { delete w.__piWebPendingComposer; return; }
    const timer = setTimeout(() => {
      const cur = w.__piWebPendingComposer;
      if (!cur || cur !== pending) return; // already replaced/consumed
      delete w.__piWebPendingComposer;
      const combined = text;
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

  // Composer enhancement contract: value-change broadcast (consumed by draft
  // slotting/queue banner and other extensions).
  // Draft persistence is owned by the draft-keeper extension via onChange; core no
  // longer persists drafts itself (the original save effect was removed)
  useEffect(() => {
    emitComposerChange({
      value,
      images: attachedImages.map(imageToDraftImage),
      imageCount: attachedImages.length,
      hasInput: Boolean(value.trim()) || attachedImages.length > 0,
      suppress: suppressDraft,
    });
  }, [value, attachedImages, suppressDraft]);

  // Late-enhancer compensation: extension clients load asynchronously, and
  // keyChange/onChange broadcasts made before registration are lost (without
  // currentKey the keeper is fully crippled). When the enhancer set changes,
  // re-emit the current key and snapshot (draftKeyRef already holds the current
  // value — just re-send).
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

  // (The flushAllDrafts unmount effect was removed — the keeper's
  // beforeunload/pagehide/visibilitychange listeners handle persistence; across
  // SPA unmounts the keeper's drafts map survives, and onKeyChange already flushes
  // the old key)

  // Composer enhancement contract: wire the controlled write entry (programmatic
  // writes uniformly go state → the existing [value] DOM sync effect; tracker sync
  // is guaranteed there). Cleared on unmount.
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

  // Upstream extracted height measurement into resizeTextarea (useLayoutEffect
  // [value,fontSize] + a width ResizeObserver reusing it); our fork folds in the
  // uncontrolled sync (writeTextareaValue + tracker alignment) — draft restores/
  // extension injections rewrite the DOM value outside React, so they must be
  // written back in sync here, or the stale tracker swallows onChange (draft
  // resurrection/cannot-clear, see the note below).
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // Uncontrolled sync: React state changes (draft restore/extension injection/
    // send-clear/recall etc.) are written back to the DOM. Skipped during voice/
    // IME composition — composition text belongs to the input method and React
    // must not overwrite it (protects voice input from interruption). Goes through
    // writeTextareaValue to sync _valueTracker: a bare ta.value write leaves a
    // stale tracked value, so a select-all+delete after restoring a draft makes
    // React think "nothing changed" and swallow onChange — state keeps the old
    // draft, the draft cannot be cleared, it resurrects on the next load, and
    // Enter can even resend the stale text.
    if (!isComposingRef.current && ta.value !== value) {
      // The write-back also pushes the caret to the end: while the user is editing
      // in the box (focused, caret not at the end) keep the original caret position
      // (clamped to the new length) — otherwise (caret already at the end/
      // unfocused) keep the old "land at the end" behavior.
      const wasFocused = ta === document.activeElement;
      const caretBefore = ta.selectionStart;
      const lenBefore = ta.value.length;
      writeTextareaValue(ta, value);
      if (wasFocused && caretBefore !== null && caretBefore < lenBefore) {
        const pos = Math.min(caretBefore, ta.value.length);
        ta.setSelectionRange(pos, pos);
      }
    }
    // React's defaultValue commit goes through the textContent path (not the value
    // setter) and bypasses _valueTracker the same way — after every commit, force
    // the tracked value back onto the real DOM value so subsequent user edits
    // (especially select-all+delete landing back on the stale tracked value)
    // always fire onChange normally.
    const tracker = (ta as unknown as { _valueTracker?: { setValue(v: string): void } })._valueTracker;
    tracker?.setValue(ta.value);
    ta.style.height = "auto";
    if (ta.value) ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  useLayoutEffect(resizeTextarea, [value, fontSize, resizeTextarea]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    let previousWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      // Height updates also notify the observer; only remeasure on width changes.
      if (entry.contentRect.width === previousWidth) return;
      previousWidth = entry.contentRect.width;
      resizeTextarea();
    });
    observer.observe(ta);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  // (The value-change broadcast is emitted in exactly one place above, with
  //  suppress — a stale second broadcast without suppress once double-fired on
  //  every change and punched through suppressDraft: "edit from here" prefill
  //  leaked into the draft slot through it, then got "restored" back into the box
  //  via the scan on send, and the clear confirmation was polluted into
  //  ineffectiveness. Removed — never add a second broadcast point.)

  const handleFocus = useCallback(() => {
    composerLiveFocused = true;
    setInputFocused(true);
    // Re-measure once the focus-driven layout settles. Focusing alone does not
    // fire onChange/onInput, so a height computed at an earlier width (mobile
    // keyboard opening, buttons wrapping onto their own row) stays stale
    // until the next keystroke — e.g. after pasting text and tapping back in.
    requestAnimationFrame(resizeTextarea);
  }, [resizeTextarea]);

  const handleBlur = useCallback(() => {
    composerLiveFocused = false;
    setInputFocused(false);
  }, []);

  // Focus hand-off across remounts (see pendingFocusHandoff). Runs as a pair during the layout phase: the
  // old instance records focus ownership on cleanup and the new instance takes it back right on mount, so
  // the user never sees the gap. preventScroll avoids "scrolling the page as a side effect of refocusing".
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
      // v4 8th review: placeholder wrapping must not count as content measurement —
      // with empty input the full-width placeholder wraps to 2 lines → scrollHeight
      // 51>30 → buttonsWrapped misfires true → an unfocused empty input sticks at
      // the two-line layout with an invisible extra button row at the bottom (real
      // device screenshot: input not flush with the bottom + blank band). What we
      // measure is whether the typed content wraps.
      clone.placeholder = "";
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

  // Unified entry for extension chat hooks: Enter send / steer / queue (follow-up)
  // all pass through here — [element N]/[answer N]/[error N] placeholders are
  // replaced on every send path (devtools extension: candidate content + source prefix)
  const applyChatHooks = useCallback((text: string): string => {
    const chatHooks = chatHooksRef.current ?? [];
    let finalMsg = text;
    for (const hk of chatHooks) {
      if (typeof hk.preSend === "function") {
        try {
          const r = hk.preSend(finalMsg);
          if (r && typeof r.text === "string") finalMsg = r.text;
        } catch { /* a failing hook must not block sending */ }
      }
    }
    return finalMsg;
  }, []);

  const runBuiltinCommand = useCallback(async (msg: string): Promise<boolean> => {
    if (attachedImages.length || !msg.startsWith("/") || !onBuiltinCommand) return false;
    if (builtinCommandPendingRef.current) return true;
    builtinCommandPendingRef.current = true;
    setBuiltinCommandPending(true);
    try {
      const result = await onBuiltinCommand(msg);
      if (!result.handled) return false;
      if (!result.error && canClearBuiltinCommandInput(valueRef.current, attachedImagesRef.current.length, msg)) clearInput();
      return true;
    } finally {
      builtinCommandPendingRef.current = false;
      setBuiltinCommandPending(false);
    }
  }, [attachedImages.length, clearInput, onBuiltinCommand]);

  const handleSend = useCallback(async () => {
    const msg = value.trim();
    // Recalling-to-edit: Enter always = put back at the original queue position
    // (order unchanged); if the edit was emptied, the original text is requeued —
    // an entry is never lost. Requeueing is a pure queue operation, equally valid
    // while streaming.
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
      // Host without onRequeueAt and the edit was emptied: nothing to do, do not send an empty message
      if (!msg && !attachedImages.length) return;
    }
    // Upstream v0.8.10: builtin slash commands may also run while streaming (whitelisted commands do not interrupt the agent)
    const builtinAllowed = !isStreaming || canRunBuiltinSlashCommandWhileStreaming(msg);
    if (builtinAllowed && await runBuiltinCommand(msg)) return;
    if (isStreaming) return;
    // Composer enhancement contract: pre-send chained hooks → extension chat hooks (the existing [element N]/[answer N]/[error N] replacement)
    const submittedMsg = runComposerSubmit(msg, attachedImages.length);
    const finalMsg = applyChatHooks(submittedMsg);
    onSend(finalMsg, attachedImages.length ? attachedImages : undefined, attachedFiles.length ? attachedFiles : undefined);
    setAttachedFiles([]);

    clearInput();
  }, [value, attachedImages, attachedFiles, isStreaming, runBuiltinCommand, onSend, clearInput, onAudioUnlock, onRequeueAt, applyChatHooks]);

  /** "New session" fork (right-edge group button in the input row): uses the
   *  current input as the new session's first user message, auto-run in the
   *  forked background session; the current session is not switched (the user
   *  stays in the original session). Click → busy state (spinning icon + disabled)
   *  until the new session is created; on failure the input is left as-is and the
   *  notice surfaces through the hook. */
  const [forkingNew, setForkingNew] = useState(false);
  const forkingNewRef = useRef(false);
  const handleForkNew = useCallback(async () => {
    const msg = value.trim();
    if ((!msg && !attachedImages.length) || forkingNewRef.current) return;
    onAudioUnlock?.();
    forkingNewRef.current = true;
    setForkingNew(true);
    // Snapshot: accepting the fork can take seconds, during which the user may
    // keep typing/changing attachments — on success only the submitted snapshot
    // content is cleared, never newer input.
    const snapshotValue = msg;
    const snapshotImages = attachedImages;
    try {
      const ok = await onForkNew?.(
        msg,
        attachedImages.length ? attachedImages : undefined,
        attachedFiles.length ? attachedFiles : undefined,
      );
      if (ok !== false
        && valueRef.current.trim() === snapshotValue
        && attachedImagesRef.current === snapshotImages) {
        setAttachedFiles([]);
        clearInput();
      }
    } finally {
      forkingNewRef.current = false;
      setForkingNew(false);
    }
  }, [value, attachedImages, attachedFiles, onForkNew, clearInput, onAudioUnlock]);

  /** Extension-driven programmatic send (prompts extension etc.): same pipeline as
   *  user input — applyChatHooks applies; while the agent streams, mode routes to
   *  steer/followUp (same branch as sendQueued), and when idle it fires directly
   *  (equivalent to Enter).
   *  The input box is not cleared: the extension's content is sent without
   *  touching what the user is typing. */
  const handleExtensionSend = useCallback((text: string, mode: "steer" | "followUp" | "queue", images?: { data: string; mimeType: string }[]) => {
    if (!text || !text.trim()) return;
    const finalMsg = applyChatHooks(text);
    // Draft-restore multi-entry leftovers etc.: queue a follow-up carrying images (base64 → AttachedImage)
    const attached = images?.length
      ? images.map((im) => ({ data: im.data, mimeType: im.mimeType, previewUrl: `data:${im.mimeType};base64,${im.data}` }))
      : undefined;
    if (mode === "queue") {
      // Enqueue only, no dispatch: even when idle it only enters the follow-up queue (draft-restore "Re-queue" semantics)
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
      // Idle (onSteer/onFollowUp are only passed while the agent runs) → fire a turn immediately
      onSend?.(finalMsg, attached);
    }
  }, [applyChatHooks, onSend, onSteer, onFollowUp, onQueueFollowUp, onPromptWithStreamingBehavior]);

  useEffect(() => {
    registerChatSend(handleExtensionSend);
    return () => registerChatSend(null);
  }, [handleExtensionSend]);

  const slashQuery = !compact && value.startsWith("/") && !/\s/.test(value.slice(1))
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
  const canQueueStreamingMessage = hasInputText || attachedImages.length > 0;
  // With no typed text, the steer button still works when the queue holds a
  // follow-up: clicking it dispatches the FIRST queued follow-up as a steer
  // (same action as the row/collapsed-bar steer button).
  const canSteerFromQueue = !hasInputText && !attachedImages.length && (queuedMessages?.followUp?.length ?? 0) > 0;
  // Steer/queue button hover hints differentiate by state: while the AI is
  // processing with an empty input (no message, no images, and no queueable
  // follow-up to steer from) both buttons gray out together — the hint then says
  // to type a message first.
  // (Images may queue along with a message — the queue-store/recall-edit/replay
  // pipeline supports it natively, #3 image queue recovery)
  const queueDisabledNoInput = !hasInputText && attachedImages.length === 0;
  // ── Mobile "WeChat-style" matrix derivation: the pure computeMobileComposerMatrix
  // (unit-test pinned) — re-derived automatically after draft restore (F14) and
  // send-clear (F15). Placeholder behaves exactly like desktop (v4 10th review).
  const mobileMatrix = computeMobileComposerMatrix({
    isStreaming,
    hasInputText,
    imageCount: attachedImages.length,
    canSteerFromQueue,
    hasSteerCapability: Boolean(onSteer),
    hasFollowUpCapability: Boolean(onFollowUp),
    hasAbortCapability: Boolean(onAbort),
  });
  const mobileSendEnabled = mobileMatrix.sendEnabled;
  const hasContent = mobileMatrix.hasContent;
  // v4 "float-in": the conditional button group (clear/🎤/continue/send/stop/steer/
  // queue) floats in only when focused or has content; ＋/images stay persistent.
  // composerAffixExtCount exists only to avoid an empty-slot placeholder (when 🎤
  // is not registered).
  const composerAffixExtCount = useExtSlotItems("composerAffix").length;
  const [inputFocused, setInputFocused] = useState(false);
  const mobileExpanded = !isMobile || inputFocused || hasContent || isStreaming;
  // Opening the ⓘ sheet: first close other popups + cancel recording (S28
  // mutual exclusion), then position bottom from the input row's location.
  // maxHeight tightens in sync to "the space above the input row" — on the
  // welcome page the input is centered and the space above is short; capping at
  // 60vh alone would push the sheet past the viewport top (✕ out of reach).
  const openInfoSheet = useCallback(() => {
    setHistoryMenuOpen(false);
    setModelDropdownOpen(false);
    setToolDropdownOpen(false);
    setThinkingDropdownOpen(false);
    try { window.dispatchEvent(new CustomEvent("pi-web:composer-affix-cancel")); } catch { /* fine with no listener */ }
    const rect = inputRowRef.current?.getBoundingClientRect();
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const bottom = rect && rect.height > 0 ? Math.max(8, vh - rect.top + 6) : 12;
    setInfoSheetBottom(bottom);
    setInfoSheetMaxHeight(Math.max(220, Math.floor(vh - bottom - 12)));
    setInfoSheetSections(new Set(["extStatus", "extWidgets"])); // v4: extension status/panels start expanded
    setInfoSheetOpen(true);
  }, []);
  // v4 second re-review (user verdict "＋ stays on the right" sent it back): ＋ sits
  // to the left of the textarea (first position on the left).
  // In the single-line state it renders before the textarea; in the wrapped state
  // (buttonsWrapped) and the compact quote box it joins the right-side button
  // cluster — otherwise, under flexWrap with the textarea owning the whole row,
  // ＋ would dangle on its own line.
  // Bottom-row taps must not steal the textarea focus on mobile (WeChat-style):
  // pointerdown preventDefault stops the browser from moving focus from the
  // textarea to the button (click still fires normally) — in the focused/expanded
  // state, tapping any bottom-row button (＋/model/🎤/images/continue/send/stop/
  // steer/queue) no longer blurs and collapses first, interrupting typing.
  // The handler hangs on the bottom-row container so it covers everything (the
  // model selector's mobile fullscreen panel also renders inside the container
  // DOM, so its buttons get the same treatment); only input/textarea/
  // contenteditable are exempt — the model panel's filter box must be able to
  // take focus and raise the keyboard normally.
  const suppressComposerBlurOnPress = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable]")) return;
    e.preventDefault();
  }, []);
  const mobilePlusButton = (
    <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      <MobileIconButton label={t("chat.plusPanel")} onClick={openInfoSheet}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" /></svg>
      </MobileIconButton>
      {modelSwitchPending && <span style={{ position: "absolute", top: 3, right: 3, width: 7, height: 7, borderRadius: 99, background: "#f59e0b" }} />}
    </span>
  );
  const handleSheetQueueExport = useCallback(async () => {
    if (!onExportQueue) return;
    const data = await onExportQueue();
    if (data) downloadQueueExport(data.live, { sessionId: sessionId ?? undefined, source: "live" }, "json");
  }, [onExportQueue, sessionId]);
  const extStatusLine = formatExtensionStatusLine(extensionStatuses);
  // Warn when images are attached but the selected model is known not to accept
  // image input (#584), including a resolved default. Unknown models stay silent.
  const showImageUnsupportedWarning = (
    attachedImages.length > 0
    && !modelSupportsImageInput(model, modelList)
    && !imageWarningDismissed
  );
  useEffect(() => {
    if (attachedImages.length === 0) setImageWarningDismissed(false);
  }, [attachedImages.length]);

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
      fetch(apiUrl("/api/file-index"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: fetchCwd, q: query }),
      })
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
    fetch(apiUrl("/api/file-index"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: fetchCwd }),
    })
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
    // History picked from the menu → exit direct-paging mode (the two mechanisms are mutually exclusive)
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

  /** Shell-style session-history paging: copy the index-th history entry into the input box (editable and re-sendable). */
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

  /** After a button click (including Enter on a Tab-focused button), hand focus
   *  back to the input box — otherwise focus stays on the button and continued
   *  typing never reaches the input. rAF waits one render pass (clearInput and
   *  other state updates) before focusing. */
  const refocusInput = useCallback(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // ── Host capability service "pi-web.composer" (slot-extra callback decoupling,
  //    batch B, 2026-09-16):
  //    reference-stable callbacks/refs are registered as a read-only service open
  //    to all extensions; slot render-site extras converge to pure data
  //    (fields whose values change per render stay in slot props — the service
  //    get is an imperative snapshot). Consumer resolution chain:
  //    rp first → getExtService("pi-web.composer") fallback (the folder
  //    extension's resolveHostFace pattern).
  //    impl delegates to the latest render closure via a ref (same as hostUiRef);
  //    registration happens once on mount and unregisters on unmount. ──
  const composerUiRef = useRef<Record<string, unknown>>({});
  composerUiRef.current = {
    setInputValue,
    focusComposer: refocusInput,
    textareaRef,
    // The entry inside the mobile InfoSheet must collapse the sheet before opening stats (no effect on desktop — InfoSheet is a mobile-only state)
    openSessionInfo: () => { setInfoSheetOpen(false); onSessionStatsPanelOpen?.(); },
    // Queue panel action primitives (same set as queuePanel extra.actions; consumed by the composerTools import entry etc.)
    queueActions: queuePanelExtra.actions,
  };
  useEffect(() => {
    return registerExtClientService(HOST_COMPOSER_SERVICE.provider, HOST_COMPOSER_SERVICE.name, {
      /** Fetch a composer capability by name (field contract in lib/ext/host-ui-contract.ts). */
      get: (name: string) => composerUiRef.current[name],
      /** List of field names. */
      names: () => Object.keys(composerUiRef.current),
    });
  }, []);

  // Pure-data extra shared by the three composerAffix render sites (previously 3
  // hand-assembled duplicates containing callbacks — now service-backed)
  const composerAffixExtra = useMemo(() => ({
    hasContent, hasInputText, isStreaming, focused: inputFocused, inputValue: value,
  }), [hasContent, hasInputText, isStreaming, inputFocused, value]);
  // Pure-data extra shared by the two modelInfoLead render sites (the 5176/4398
  // spellings had drifted; unified)
  const modelInfoLeadExtra = useMemo(() => ({
    sessionId, cwd, context: extSeamContext, compact: extSeamCompact, isMobile: true,
  }), [sessionId, cwd, extSeamContext, extSeamCompact]);

  const sendQueued = useCallback((mode: "steer" | "followup") => {
    const msg = value.trim();
    // No typed text: the steer button dispatches the first queued follow-up
    // as a steer (interrupt now) instead of doing nothing.
    if (!msg && !attachedImages.length) {
      if (mode === "steer") {
        // Recalling-to-edit (input emptied): do not grab-dispatch the first queued entry — press Enter first to requeue the current edit, avoiding orphaning
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
    onAudioUnlock?.();
    if (!attachedImages.length && onBuiltinCommand && canRunBuiltinSlashCommandWhileStreaming(msg)) {
      void runBuiltinCommand(msg);
      return;
    }
    // The user explicitly chose a send mode (steer / followUp): dispatch as
    // such instead of putting the recalled entry back into the queue.
    recalledRef.current = null;
    setRecalledVisible(false);
    // Extension chat hooks: steer/queue (follow-up) sends run the same
    // [element N]/[answer N]/[error N] replacement (consistent with Enter)
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
          setAtActiveIndex((i) => cycleListIndex(i, atMatches.length, 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtActiveIndex((i) => cycleListIndex(i, atMatches.length, -1));
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

      // ── Queue navigation while recalling-to-edit (↑/↓): put the current edit back
      // at its queue position, recall the adjacent entry to continue editing. ──
      // Exactly the same path as the inline recall button; at either end nothing
      // moves (the current edit is kept).
      if (!isComposing && recalledRef.current && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        void navigateRecalled(e.key === "ArrowUp" ? -1 : 1);
        return;
      }

      // ── Direct session-history paging in progress (shell-style ↑/↓ when no
      // messages are queued) ──
      // ↑ previous (older); ↓ next (newer); paging past the newest returns to an
      // empty input.
      // If the user edited the text by hand (value ≠ the original we wrote) →
      // treat as exiting paging and restore normal caret movement.
      if (!isComposing && historyNavIndexRef.current !== null && valueRef.current === historyNavTextRef.current
        && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const navIdx = historyNavIndexRef.current;
        if (e.key === "ArrowDown") {
          if (navIdx + 1 >= inputHistory.length) {
            // Paged past the newest: clear the input (paging only starts from an
            // empty input, so the "original draft" is blank)
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

      // ↑ on empty input: with queued messages → recall the last one into the box
      // for continued editing (followUp first; the last steering when there is no
      // followUp; also works while streaming — sending puts it back at its queue
      // position);
      // no queued messages but session history exists → start paging directly
      // (newest first into the box, re-sendable).
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
      // Shift+↑: open the history menu (the original empty-input ↑ behavior; visual browsing, Enter/Tab to pick).
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
        // Recalling-to-edit: Enter = put back at the original queue position (same
        // as the "requeue" button, order unchanged) —
        // while streaming this still takes handleSend's recall branch instead of
        // appending the text as a new follow-up.
        if (recalledRef.current) {
          void handleSend();
        } else if (isStreaming && (onSteer || onFollowUp)) {
          // Default Enter queues as a follow-up (the non-destructive action).
          // With an empty input, a second Enter promotes the first queued
          // follow-up to a steer (delivered at the next turn boundary instead
          // of waiting for the run to end) — so "Enter to queue, Enter again
          // to insert". Alt/Option+Enter is the exact inverse: with typed text
          // it steers immediately (interrupt), degrading to the other mode
          // when that capability is missing. An empty input has no queueable
          // text to invert, so both keys promote the queue to a steer.
          if (value.trim()) {
            const wants = e.altKey ? "steer" : "followup";
            const fallback = e.altKey ? "followup" : "steer";
            sendQueued((wants === "steer" ? onSteer : onFollowUp) ? wants : fallback);
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

  // onInput only measures height (upstream semantics) — never reuse resizeTextarea
  // here: it contains the uncontrolled value-write sync, and an input event where
  // state lags the DOM would wipe the characters the user just typed (losing
  // React onChange with them).
  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    if (ta.value) ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (!compact && imageItems.length) {
      e.preventDefault();
      const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
      processImageFiles(files);
      return;
    }

    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (!html || !text) return;
    const document = new DOMParser().parseFromString(html, "text/html");
    const links = Array.from(document.querySelectorAll("a[href]"), (link) => {
      const label = link.textContent ?? "";
      const range = document.createRange();
      range.setStart(document.body, 0);
      range.setEndBefore(link);
      return {
        label,
        href: link.getAttribute("href")?.trim() ?? "",
        occurrence: label ? range.toString().split(label).length - 1 : 0,
      };
    });
    const markdown = replaceLinksWithMarkdown(text, links);
    if (markdown === null) return;

    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const nextValue = ta.value.slice(0, start) + markdown + ta.value.slice(ta.selectionEnd);
    e.preventDefault();
    valueRef.current = nextValue;
    setValue(nextValue);
    setHistoryMenuOpen(false);
    updateAtQuery(nextValue, start + markdown.length);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + markdown.length, start + markdown.length);
    });
  }, [compact, processImageFiles, updateAtQuery]);

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
    fetch(apiUrl("/api/skills"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestCwd }),
    })
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
    return subscribeUpwardMenuMaxHeight(menu, (nextHeight) => {
      setSlashMenuMaxHeight((current) => current === nextHeight ? current : nextHeight);
    });
  }, [slashMenuOpen, slashQuery]);

  useLayoutEffect(() => {
    if (!atMenuOpen || atQuery === null) {
      setAtMenuMaxHeight(null);
      return;
    }
    const menu = atMenuRef.current;
    if (!menu) return;
    return subscribeUpwardMenuMaxHeight(menu, (nextHeight) => {
      setAtMenuMaxHeight((current) => current === nextHeight ? current : nextHeight);
    });
  }, [atMenuOpen, atQuery]);

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelSelectorOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name, status: m.avail, ...(m.providerRL ? { providerRL: true } : {}) }));
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

  // Ambiguity guard: when a model with the same name appears in multiple provider
  // groups (e.g. opencode-go and opencode-go-2 both listing ox-alpha-free), the
  // adjacent groups' option labels are identical and easy to mis-click — and since
  // set_model matches provider+id exactly, a mis-click silently switches to another
  // provider. Append the provider in small text after such duplicate names.
  // Computed from the full list (not the filtered result) so the annotation does
  // not flicker while typing a filter.
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
  const resolvedThinkingLevel = thinkingLevel && thinkingLevel !== "auto" ? thinkingLevel : null;
  const thinkingDisplayLabel = (() => {
    const lvl = resolvedThinkingLevel ?? "auto";
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
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target as Node) && !textareaRef.current?.contains(e.target as Node)) {
        setHistoryMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Companion to upstream #743: collapse the hover dropdowns when a new streaming turn starts, so an expanded state cannot leak across turns
  useEffect(() => {
    if (!isStreaming) return;
    setThinkingDropdownOpen(false);
    setToolDropdownOpen(false);
  }, [isStreaming]);




  return (
    <fieldset
      disabled={builtinCommandPending}
      aria-busy={builtinCommandPending}
      style={{
        position: "relative",
        flexShrink: 0,
        minWidth: 0,
        margin: 0,
        border: 0,
        background: "transparent",
        padding: compact ? 0 : "0 16px 8px",
        paddingRight: compact ? 0 : isMobile || isCompact ? 16 : 52, // desktop: 16px base + 36px for ChatMinimap alignment
        opacity: builtinCommandPending ? 0.5 : 1,
        transition: "opacity 0.15s",
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
      {/* Clear-undo toast (v3 §3.1 + trash): 5s window, single level. Shared by
          large and small screens (desktop keyboard deletes get the same undo).
          Positioned like swipeHint — hovering above the bottom area */}
      {undoSnapshot && (
        <div style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: "calc(100% + 8px)",
          display: "flex",
          justifyContent: "center",
          zIndex: 90,
        }}>
          <div style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            padding: "7px 8px 7px 14px",
            borderRadius: 999,
            background: "color-mix(in srgb, var(--bg-panel) 94%, var(--bg))",
            border: "1px solid var(--border)",
            boxShadow: "0 4px 14px rgba(0,0,0,0.14)",
            fontSize: 12.5,
            color: "var(--text)",
            whiteSpace: "nowrap",
          }}>
            {t("chat.clearedToast")}
            <button
              type="button"
              onClick={undoClear}
              style={{
                padding: "4px 12px",
                background: "none",
                border: "none",
                borderRadius: 999,
                color: "var(--accent)",
                fontWeight: 700,
                fontSize: 12.5,
                cursor: "pointer",
              }}
            >
              {t("chat.undoClear")}
            </button>
          </div>
        </div>
      )}
      {/* Hidden file input */}
      {!compact && <input
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
      />}
      {/* Hidden camera input (v4: ＋ panel "📷 Camera" — mobile invokes the rear camera directly, capture=environment) */}
      {!compact && <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processImageFiles(files);
          e.target.value = "";
        }}
      />}
      {/* Hidden generic-file input (file attachments: PDF/documents etc., backend fileAttachments capability) */}
      {!compact && <input
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
      />}
      {/* Hidden queue-import input (mobile ⓘ sheet queue "Import": .json → parse → stageImport) */}
      {!compact && <input
        ref={queueImportInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file || !onStageImport) return;
          try {
            const entries = parseQueueImport(await file.text());
            if (entries.length) await onStageImport(entries);
          } catch { /* parse failure stays silent — same lenient semantics as the desktop import */ }
        }}
      />}
      <div style={{ maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
        <ModelErrorBanner error={modelError} />
        <ModelScopeWarningBanner warnings={modelScopeWarnings} />
        {showImageUnsupportedWarning && (() => {
          const entry = modelList?.find((m) => m.provider === model?.provider && m.id === model?.modelId);
          return (
            <ModelNoticeBanner
              tone="warning"
              title={t("chat.imageNotSupportedTitle")}
              body={t("chat.imageNotSupportedBody", { model: entry?.name || model?.modelId || "" })}
              onClose={() => setImageWarningDismissed(true)}
            />
          );
        })()}
        {/* Queue panel: the queue-keeper extension renders the full UI through the
            queuePanel slot (banner/row actions/trash/undo bar/import-export/
            notices). Without a takeover (extension missing/disabled or feature
            off) the upstream-shaped fallback banner renders (count + Recall all +
            read-only rows) — de-forking P3. */}
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
        {/* Task list (read-only mirror of the agent working plan; same zone as
            queuePanel, empty lists render nothing;
            bottomMode expanded-state visibility — when collapsed it hides together
            with the queue instead of occupying space alone) */}
        {effectiveBottomMode === "full" && tasks && tasks.length > 0 && <TaskListPanel tasks={tasks} />}
        {/* The queue panel renders only in the expanded bottomMode (queueHidden/
            minimal hides it together with the extension panel, consistent with the
            core bottomMode tri-state semantics — plan §4-④ kept in core). The outer
            ref container carries the v4 queue pulse animation
            (queue-banner-pulse, globals.css). */}
        <div ref={queueBannerRef}>
        {effectiveBottomMode === "full" && <ExtSlot name="queuePanel" extra={queuePanelExtra} />}
        {!extOwnsQueuePanel && effectiveBottomMode === "full" && (queueCount > 0 || trashCount > 0) && (
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
                  {/* Pencil (square-pen) = move back to the input box for editing (same icon as the queue-keeper extension) */}
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
                  </svg>
                  {t("chat.recall")}
                </button>
              )}
            </div>
            {queuedMessages?.steering.map((text, i) => (
              <FallbackQueueRow key={`steer-${i}`} kind="steer" text={text}
                hasImages={Boolean(queuedMessages?.steeringHasImages?.[i])} />
            ))}
            {queuedMessages?.followUp.map((text, i) => (
              <FallbackQueueRow key={`followup-${i}`} kind="follow-up" text={text}
                hasImages={Boolean(queuedMessages?.followUpHasImages?.[i])} />
            ))}
          </div>
        )}
        </div>
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
                {/* v4 12th review: click the thumbnail to preview (reusing the same
                    ImagePreview as message images) — src passes a stable
                    data URL: the blob previewUrl gets revoked by revokeImagePreview
                    (attachment removal/send-clear) and would break inside the
                    file-editor extension's floating viewer (the image tab mechanism
                    is gone; see the image-preview unify plan) */}
                <ImagePreview src={`data:${img.mimeType};base64,${img.data}`} style={{ borderRadius: 6 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.previewUrl}
                    alt=""
                    style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                  />
                </ImagePreview>
                <button
                  type="button"
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
              data-input-overlay="1"
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
                title={t("chat.inputHistory")}
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
              data-input-overlay="1"
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
                data-input-overlay="1"
                ref={atMenuRef}
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
                  maxHeight: atMenuMaxHeight === null
                    ? "min(48vh, 400px)"
                    : `min(48vh, 400px, ${atMenuMaxHeight}px)`,
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
                  <span>
                    {indexLoading
                       ? t("chat.loadingFiles")
                       : t("chat.files", { label: matchCountLabel, hint: truncatedHint })}
                  </span>
                   <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
                </div>
                <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 4 }}>
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
          {effectiveBottomMode !== "minimal" && recalledVisible && recalledRef.current && (
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
          {effectiveBottomMode === "minimal" ? (
            /* v4 13th review: the minimal folded state = pure handle (same as the
                notch) — a thin bar without a queue, a count-embedded capsule ⎯ N ⎯
                with one; tap expands back to full; the old "N queued" text strip is
                retired.
                Mobile floating: a 44px spacer bar pushed the message flow up and
                exposed a white gap at the shell bottom (user feedback) —
                switch to an absolute overlay that takes no layout space, the flow
                extends to the bottom, and the sides stay fully transparent to touch
                (pointer-events converge onto the handle itself). Desktop keeps its
                in-flow spacer unchanged. */
            isMobile ? (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minHeight: 44,
                  pointerEvents: "none",
                  zIndex: 5,
                }}
              >
                <div style={{ pointerEvents: "auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                  {collapseHintVisible && (
                    <div
                      onClick={() => cycleBottomMode()}
                      title={t("chat.restoreBottom")}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        padding: "5px 11px",
                        borderRadius: 999,
                        background: "color-mix(in srgb, var(--bg-panel) 94%, var(--bg))",
                        border: "1px solid var(--border)",
                        boxShadow: "0 4px 14px rgba(0,0,0,0.14)",
                        fontSize: 11.5,
                        color: "var(--text)",
                        whiteSpace: "nowrap",
                        marginBottom: 2,
                        cursor: "pointer",
                      }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 15 12 9 18 15" />
                      </svg>
                      {t("chat.collapsedPullUpHint")}
                    </div>
                  )}
                  <div className="chat-collapse-handle-breathe">
                    <NotchHandle
                      capsule={queueCount > 0}
                      count={queueCount}
                      onClick={() => cycleBottomMode()}
                      title={t("chat.restoreBottom")}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 44 }}>
                <NotchHandle
                  capsule={queueCount > 0}
                  count={queueCount}
                  onClick={() => cycleBottomMode()}
                  title={t("chat.restoreBottom")}
                />
              </div>
            )
          ) : (
          <div
            ref={inputRowRef}
            style={{
              position: "relative",
              minWidth: 0,
              display: "flex",
              flexDirection: compact ? "column" : "row",
              flexWrap: compact ? "nowrap" : "wrap",
              gap: 8,
              alignItems: compact ? "stretch" : "center",
              background: "var(--bg)",
              border: compact ? "none" : `1px solid ${bashMode ? "var(--tool-bg)" : isStreaming && (onSteer || onFollowUp)
                ? "rgba(234,179,8,0.4)"
                : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
              borderRadius: compact ? 0 : 14,
              padding: compact ? 0 : "10px 10px 10px 14px",
              boxShadow: compact ? "none" : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
            } as React.CSSProperties}
          >
          {/* Notch handle (v3 merged into the input row's top edge; gesture area =
              the whole input row). v4: in a non-full mode with a queue it grows into
              a count-embedded mini capsule (⎯ 3 ⎯); tapping still cycles the three
              fold modes — a visible anchor while the queue is hidden. */}
          {isMobile && !foldDisabled && (effectiveBottomMode !== "full" && queueCount > 0 ? (
            <div style={{ position: "absolute", top: 3, left: "50%", transform: "translateX(-50%)", zIndex: 1 }}>
              <NotchHandle capsule count={queueCount} onClick={() => cycleBottomMode()} title={t("chat.restoreBottom")} />
            </div>
          ) : (
            <div style={{ position: "absolute", top: 4, left: "50%", transform: "translateX(-50%)", zIndex: 1 }}>
              <NotchHandle capsule={false} count={0} onClick={() => cycleBottomMode()} title={t(effectiveBottomMode === "full" ? (queueCount > 0 ? "chat.minimizeQueue" : "chat.minimizeInput") : "chat.restoreBottom")} />
            </div>
          ))}
          <ExtSlot name="chatInputTop" extra={{ inputValue: value, cwd, sessionId, isStreaming, menuOpen: historyMenuOpen || slashMenuOpen || atMenuOpen, model }} />
          {/* textarea wrapper: positioning context for the affix slot (inner right
              edge); the flex contract moved from the textarea to this wrapper.
              v4 3rd review (user verdict: focused or has input → the input box and
              the bottom-most row are **separate**):
              in the expanded state (mobileExpanded = focused or has content) the
              textarea owns the whole row (flex 100%) and
              all buttons pin to the bottom row; collapsed state is the single line
              [＋|textarea|images]. */}
          <div style={{ position: "relative", flex: compact ? "none" : buttonsWrapped || (isMobile && mobileExpanded) ? "1 1 100%" : "1 1 0", minWidth: 0, display: "flex" }}>
          {isMobile && !compact && !mobileExpanded && mobilePlusButton}
          <textarea
            ref={textareaRef}
            data-chat-input="1"
            enterKeyHint="send"
            className="chat-input-textarea"
            aria-label={compact ? t("chat.quoteQuestion") : undefined}
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
              // Composition ended: fold the value the IME finally wrote into the DOM back into state (prevents state lagging the DOM and dropping characters from drafts/subsequent writes)
              valueRef.current = el.value;
              setValue(el.value);
              updateAtQuery(el.value, el.selectionStart);
            }}
            onInput={handleInput}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onPaste={handlePaste}
            placeholder={isStreaming && (onSteer || onFollowUp)
              ? t("chat.steerPlaceholder")
              : isStreaming ? t("chat.agentPlaceholder")
              : t("chat.messagePlaceholder")}
            rows={1}
            style={{
              flex: "1 1 auto",
              minWidth: 0,
              background: "none",
              border: "none",
              outline: "none",
              resize: "none",
              color: "var(--text)",
              fontSize: "var(--chat-content-font-size, 14px)",
              lineHeight: 1.6,
              fontFamily: "inherit",
              minHeight: compact ? 96 : 24,
              maxHeight: 200,
              // Trailing affix clearance: desktop inner-right-edge [×clear|🎤] group
              // (62px reserved when 🎤 is registered;
              // 30px for the content-only × single button when not; none when
              // neither) — keeps text from flowing under the buttons
              paddingRight: isMobile ? 34 : composerAffixExtCount > 0 ? 62 : hasContent ? 30 : undefined,
              overflow: "auto",
            }}
          />
          {/* Collapsed-state composerAffix (🎤 voice, registered by an extension):
              side by side with images/continue — with voice enabled the collapsed
              icon count matches the expanded float-in set (＋ persistent left +
              [🎤][images][continue?]); when the feature is off the component renders
              null with zero footprint; the button carries its own
              data-composer-affix (the long-press gesture is not hijacked by the
              fold gesture).
              The expanded state is handled by the conditional group slot; the two
              render sites are mutually exclusive, never duplicated (images follow
              the same pattern) */}
          {isMobile && !compact && !mobileExpanded && (
            <ExtSlot name="composerAffix" extra={composerAffixExtra} />
          )}
          {/* v4 8th review: persistent collapsed-state slot for images (textarea's
              right edge, the unfocused+empty single-line state);
              the expanded state is handled by the conditional group slot (after
              voice), mutually exclusive, never duplicated */}
          {isMobile && !compact && !mobileExpanded && (
            <MobileIconButton
              label={t("chat.addImage")}
              onClick={() => fileInputRef.current?.click()}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2.5" /><circle cx="8.7" cy="8.7" r="1.6" /><path d="M21 15.5l-4.5-4.5L6 21.5" /></svg>
            </MobileIconButton>
          )}
          {/* Collapsed-state "Continue": when idle (unfocused+empty input+not
              running, matrix.cont always true) it sits beside images —
              previously Continue only lived in the expanded conditional group, so
              the collapsed single line [＋|textarea|images] missed it;
              the expanded state is still handled by the conditional group slot, the
              two render sites are mutually exclusive, never duplicated */}
          {isMobile && !compact && !mobileExpanded && mobileMatrix.cont && onContinue && canContinue && (
            <MobileIconButton
              label={t("chat.continue")}
              onClick={() => { onContinue(); refocusInput(); }}
              color="rgba(5,150,105,1)"
            >
              <svg width="15" height="15" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1.5 2.5 5.5 6 1.5 9.5" />
                <polyline points="6.5 2.5 10.5 6 6.5 9.5" />
              </svg>
            </MobileIconButton>
          )}
          {/* v4 5th review: the × clear button pins to the input box's tail (inner
              right edge, vertically centered) — always follows the input box (shows
              with content, never floats with the bottom row); clicking runs
              clearWithUndo (the undo toast remains). Mobile only (desktop has a
              keyboard).
              v4 15th review: styling aligned with the system type=search native
              clear button — thin × with no fill, small hit area. */}
          {isMobile && mobileMatrix.clear && (
            <button
              type="button"
              aria-label={t("chat.clearComposer")}
              onClick={clearWithUndo}
              style={{
                position: "absolute",
                right: 8,
                top: "50%",
                transform: "translateY(-50%)",
                width: 20,
                height: 20,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
                background: "none",
                border: "none",
                borderRadius: 99,
                color: "var(--text-dim)",
                cursor: "pointer",
                zIndex: 1,
                touchAction: "manipulation",
                WebkitTouchCallout: "none",
                userSelect: "none",
                transition: "opacity 0.12s, color 0.12s",
              }}
            >
              <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><line x1="3.5" y1="3.5" x2="10.5" y2="10.5" /><line x1="10.5" y1="3.5" x2="3.5" y2="10.5" /></svg>
            </button>
          )}
          {/* Desktop input-box trailing affix group: [×clear | 🎤voice] — semantics
              aligned with mobile:
              × is a thin clear button with a 20px hit area and an 11px unfilled
              glyph (aligned to the text line height, clearWithUndo same as mobile);
              🎤 is 32px to match the button height (composerAffix slot; the
              extension's feature gating lives inside its own component,
              zero footprint when unregistered). Mutually exclusive with the mobile
              pair of ExtSlots (collapsed wrapper slot / expanded conditional group
              slot) via isMobile — exactly one instance mounted at any moment. */}
          {!isMobile && (hasContent || composerAffixExtCount > 0) && (
            <div
              data-composer-affix="1"
              style={{
                position: "absolute",
                right: 8,
                top: "50%",
                transform: "translateY(-50%)",
                display: "flex",
                alignItems: "center",
                gap: 2,
                zIndex: 1,
              }}
            >
              {hasContent && (
                <button
                  type="button"
                  aria-label={t("chat.clearComposer")}
                  onClick={clearWithUndo}
                  style={{
                    width: 20,
                    height: 20,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 0,
                    background: "none",
                    border: "none",
                    borderRadius: 99,
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    touchAction: "manipulation",
                    userSelect: "none",
                    transition: "opacity 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><line x1="3.5" y1="3.5" x2="10.5" y2="10.5" /><line x1="10.5" y1="3.5" x2="3.5" y2="10.5" /></svg>
                </button>
              )}
              <ExtSlot name="composerAffix" extra={composerAffixExtra} />
            </div>
          )}
          </div>

          {/* v4 right-edge group (§19): the conditional button group floats in when
              "focused or has content" (120ms transition, zero footprint collapsed).
              v4 6th review (final order): bottom row [＋ fixed left|flexible
              spacer|🎤voice|images|continue/send/stop/steer/queue] —
              ＋ does not shift between the two states; images sit at the single-line
              textarea's right edge collapsed and after voice expanded.
              The collapsed single line [＋|textarea|images] is unchanged. The
              data-composer-affix marker moves with the group — 🎤 gestures are not
              hijacked. */}
          {isMobile && (
            <div
              onPointerDown={suppressComposerBlurOnPress}
              /* v4 17th review (user verdict: pin both ends, adapt the middle): the
                 left group (＋/ctx) hugs left, the
                 right group (voice/images/send…) hugs right — the model wrapper's
                 flex:1 1 0 absorbs all the remaining middle space,
                 so model name length only affects its own ellipsis truncation and
                 no longer shoves the right-side buttons (nor gets pushed off
                 screen);
                 the flexible spacer span retires with it. The group keeps
                 minWidth 0/flexShrink 1 for ultra-narrow screens. */
              style={{ display: "flex", alignItems: "center", gap: 2, minWidth: 0, flexShrink: 1, flexGrow: (isMobile && mobileExpanded) ? 1 : 0 }}
            >
              {(compact || (isMobile && mobileExpanded)) && mobilePlusButton}
              {/* Mobile expanded state: model selection shows directly (right of ＋)
                  — v4 once folded it into the ⓘ sheet and the user asked to restore
                  the direct display;
                  the sheet copy stays too (dual entry points coexist). Width
                  constraints keep a long model name from bursting the button row;
                  the trigger is 32 tall, flush with
                  MobileIconButton, and the pending badge ships with the component.
                  Hidden in the compact quote box (same condition as the flexible
                  spacer). */}
              {/* Context-meter extension widget: model-info leading slot — shown whenever model info is shown */}
              {isMobile && mobileExpanded && !compact && onModelChange && (
                <ExtSlot name="modelInfoLead" extra={modelInfoLeadExtra} />
              )}
              {isMobile && mobileExpanded && !compact && onModelChange && (
                /* v4 17th review: absorb the remaining middle space (flex 1 1 0 /
                   minWidth 0); long names truncate via ellipsis —
                   right-side button positions stay constant, unaffected by model
                   name length. */
                <div style={{ flex: "1 1 0", minWidth: 0, display: "flex" }}>
                  <ModelSelector
                    options={modelOptions}
                    value={model}
                    onChange={(provider, modelId) => { onModelChange(provider, modelId); refocusInput(); }}
                    disabled={false}
                    busy={modelSwitching}
                    pending={modelSwitchPending != null}
                    isAutoSelection={isAutoModelSelection}
                    onRefresh={onRefreshModels}
                    refreshing={modelsRefreshing}
                    hideIcon
                  />
                </div>
              )}
              <div
                data-composer-affix="1"
                style={{
                  display: "flex", alignItems: "center", gap: 2,
                  opacity: mobileExpanded ? 1 : 0,
                  maxWidth: mobileExpanded ? 340 : 0,
                  overflow: "hidden",
                  transition: "opacity 0.12s, max-width 0.15s",
                }}
              >
                {/* 16th/17th review: composerAffix (🎤) mounts only in the expanded
                    state — the collapsed state is handled by the wrapper's collapsed
                    slot; the two slots mount mutually exclusively (one instance at
                    any moment), same pattern as images */}
                {mobileExpanded && <ExtSlot name="composerAffix" extra={composerAffixExtra} />}
                {/* v4 6th/8th review: images sit after 🎤 voice and before the remaining buttons; rendered only in the expanded state (the collapsed state is handled by the wrapper's right-edge slot — persistent, never duplicated) */}
                {mobileExpanded && (
                <MobileIconButton
                  label={t("chat.addImage")}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2.5" /><circle cx="8.7" cy="8.7" r="1.6" /><path d="M21 15.5l-4.5-4.5L6 21.5" /></svg>
                </MobileIconButton>
                )}
                {mobileMatrix.cont && onContinue && canContinue && (
                  <MobileIconButton label={t("chat.continue")} onClick={() => { onContinue(); refocusInput(); }} color="rgba(5,150,105,1)">
                    <svg width="15" height="15" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="1.5 2.5 5.5 6 1.5 9.5" />
                      <polyline points="6.5 2.5 10.5 6 6.5 9.5" />
                    </svg>
                  </MobileIconButton>
                )}
                {mobileMatrix.fork && onForkNew && (
                  <MobileIconButton
                    label={t("chat.forkNew")}
                    title={forkingNew ? t("chat.forkNewBusy") : `${t("chat.forkNew")} — ${t("chat.forkNewHint")}`}
                    disabled={forkingNew}
                    onClick={() => { void handleForkNew(); refocusInput(); }}
                    color={forkingNew ? "var(--text-dim)" : "rgba(37,99,235,1)"}
                  >
                    <span style={{ display: "inline-flex", ...(forkingNew ? { animation: "spin 1s linear infinite" } : {}) }}>
                      <ForkNewIcon size={15} />
                    </span>
                  </MobileIconButton>
                )}
                {mobileMatrix.send && (
                  <button
                    type="button"
                    onClick={() => { void handleSend(); refocusInput(); }}
                    disabled={!mobileSendEnabled}
                    style={{
                      flexShrink: 0,
                      display: "flex", alignItems: "center", gap: 7,
                      padding: "8px 17px",
                      background: mobileSendEnabled ? "var(--accent)" : "var(--bg-panel)",
                      border: "none",
                      borderRadius: 10,
                      color: mobileSendEnabled ? "#fff" : "var(--text-dim)",
                      cursor: mobileSendEnabled ? "pointer" : "not-allowed",
                      fontSize: 16,
                      fontWeight: 600,
                      letterSpacing: "-0.01em",
                      boxShadow: mobileSendEnabled ? "0 1px 3px rgba(37,99,235,0.25)" : "none",
                      opacity: mobileSendEnabled ? 1 : 0.6,
                      transition: "background 0.15s, box-shadow 0.15s, opacity 0.12s",
                    }}
                  >
                    <svg width="17" height="17" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="2" y1="7" x2="11" y2="7" />
                      <polyline points="7.5 3 12 7 7.5 11" />
                    </svg>
                    {t("chat.send")}
                  </button>
                )}
                {mobileMatrix.stop && (
                  <MobileIconButton label={t("chat.stop")} onClick={() => { onAbort(); refocusInput(); }} color="#ef4444">
                    <svg width="13" height="13" viewBox="0 0 10 10" fill="none"><rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" /></svg>
                  </MobileIconButton>
                )}
                {mobileMatrix.steer && (
                  <MobileIconButton
                    label={t("chat.steer")}
                    onClick={() => { sendQueued("steer"); refocusInput(); }}
                    color="rgba(180,130,0,1)"
                  >
                    <svg width="15" height="15" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 1 L9 5 L5 9" /><line x1="1" y1="5" x2="9" y2="5" /></svg>
                  </MobileIconButton>
                )}
                {mobileMatrix.clock && (
                  <MobileIconButton
                    label={t("chat.delayedTask")}
                    onClick={() => { sendQueued("followup"); refocusInput(); }}
                    color="rgba(99,102,241,1)"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 22h14" /><path d="M5 2h14" /><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" /><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 10l4.414-4.414A2 2 0 0 0 17 4.172V2" /></svg>
                  </MobileIconButton>
                )}
              </div>
            </div>
          )}
          {!isMobile && (isStreaming ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, alignSelf: "flex-end", marginLeft: "auto" }}>
              {/* Fork new session (silent background, current session untouched):
                  shown left of steer/queue when there is content;
                  click → busy (spinning icon + disabled) until the new session is
                  created or fails */}
              {hasContent && onForkNew && (
                <StreamingActionButton
                  label={t("chat.forkNew")}
                  hint={forkingNew ? t("chat.forkNewBusy") : t("chat.forkNewHint")}
                  disabled={forkingNew}
                  onClick={() => { void handleForkNew(); refocusInput(); }}
                  bg="rgba(37,99,235,0.12)"
                  border="rgba(37,99,235,0.35)"
                  fg="rgba(37,99,235,1)"
                >
                  <span style={{ display: "inline-flex", ...(forkingNew ? { animation: "spin 1s linear infinite" } : {}) }}>
                    <ForkNewIcon />
                  </span>
                </StreamingActionButton>
              )}
              {onSteer && (
                <StreamingActionButton
                  label={t("chat.steer")}
                  hint={canSteerFromQueue ? t("chat.steerFromQueueHint")
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
              {/* follow-up: hidden on mobile with empty input (replaced by Stop); always shown on desktop (grayed out with empty input). */}
              {onFollowUp && (hasInputText || !isMobile) && (
                <StreamingActionButton
                  label={t("chat.followUp")}
                  hint={queueDisabledNoInput ? t("chat.followUpNoInput")
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
              {/* follow-up hides when the input has no message — on mobile (bottom
                  toolbar folded) it is replaced by the Stop button;
                  the desktop bottom toolbar always has Stop, so no duplicate is
                  needed. */}
              {!hasInputText && onAbort && isMobile && (
                <StreamingActionButton
                  label={aborting ? t("chat.stopping") : t("chat.stop")}
                  hint={aborting ? t("chat.stopping") : t("chat.stopAgent")}
                  disabled={aborting}
                  onClick={() => { onAbort(); refocusInput(); }}
                  bg="rgba(239,68,68,0.1)"
                  border="rgba(239,68,68,0.35)"
                  fg="#ef4444"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
                    style={aborting ? { animation: "spin 1s linear infinite" } : undefined}>
                    <path d="M12 3a9 9 0 0 1 9 9" />
                    <path d="M12 21a9 9 0 0 1-9-9" opacity="0.45" />
                  </svg>
                </StreamingActionButton>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, alignSelf: "flex-end", marginLeft: "auto" }}>
              {/* Continue: appears when the AI is fully stopped (no streaming at
                  all) and the input is empty — clicking quickly sends
                  "continue" to make the agent resume (meaningless while streaming —
                  the agent is already working).
                  Also shown when the queue is non-empty (e.g. a queue restored
                  after a restart but not resumed): clicking dispatches the whole
                  queue. */}
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
              {/* Fork new session (silent background, current session untouched):
                  shown left of Send when there is content;
                  click → busy (spinning icon + disabled) until the new session is
                  created or fails */}
              {hasContent && onForkNew && (
                <StreamingActionButton
                  label={t("chat.forkNew")}
                  hint={forkingNew ? t("chat.forkNewBusy") : t("chat.forkNewHint")}
                  disabled={forkingNew}
                  onClick={() => { void handleForkNew(); refocusInput(); }}
                  bg="rgba(37,99,235,0.12)"
                  border="rgba(37,99,235,0.35)"
                  fg="rgba(37,99,235,1)"
                >
                  <span style={{ display: "inline-flex", ...(forkingNew ? { animation: "spin 1s linear infinite" } : {}) }}>
                    <ForkNewIcon />
                  </span>
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
                color: (value.trim() || attachedImages.length) ? "var(--accent-contrast)" : "var(--text-dim)",
                cursor: (value.trim() || attachedImages.length) ? "pointer" : "not-allowed",
                fontSize: isMobile ? 16 : 13,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                boxShadow: (value.trim() || attachedImages.length) ? "0 1px 3px color-mix(in srgb, var(--accent) 25%, transparent)" : "none",
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
          ))}
          </div>
          )}
        </div>

        {/* Bash mode status label (v3: the row is removed on mobile — the info is
            embedded in the placeholder (P5/P5b); desktop unchanged) */}
        {effectiveBottomMode !== "minimal" && bashMode && !isMobile && (
          <div className="text-xs px-2 py-1" style={{ color: bashExcluded ? "var(--text-muted)" : "var(--accent)", marginTop: 4 }}>
             {t("chat.shell")} · {bashExcluded ? t("chat.outputLocal") : t("chat.outputModel")}
          </div>
        )}

        {/* Bottom bar: left | center (context) | right
            v3: the whole row is removed on mobile (attachments/model/thinking/tools/
            compaction/sound/queue operations fold into the ⓘ InfoSheet, and
            BottomModeBar merges into the input row's top-edge notch) — the input row
            becomes the mobile bottom-most persistent element. */}
        {!compact && !isMobile && effectiveBottomMode !== "minimal" && (
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
                ⚠ Tightened condition (2026-08-27): drop the modelOptions/model
                dependency — the first frame is empty before data arrives, the trigger
                would vanish and never re-render (worst when an attached session's
                models/cwd misbehave). Always render; the empty state is handled by
                ModelSelector (No models/Select model title fallback).
                ⚠ Takeover (2026-09): an extension takeover item in the modelSelector
                slot → hand rendering to the extension (with the same
                model/options/onChange contract); unregistered → native dropdown
                fallback. */}
            {onModelChange && (
              modelSelectorTakeover ? (
                <ExtItemBoundary extId={modelSelectorTakeover.extId} slot="modelSelector" itemId={modelSelectorTakeover.id}>
                  <modelSelectorTakeover.render
                    currentSession={sessionId ? { id: sessionId, cwd: "" } : null}
                    model={model}
                    options={modelOptions}
                    onChange={onModelChange}
                    busy={modelSwitching}
                    pending={modelSwitchPending != null}
                    isAutoSelection={isAutoModelSelection}
                    onRefresh={onRefreshModels}
                    refreshing={modelsRefreshing}
                  />
                </ExtItemBoundary>
              ) : (
                <ModelSelector
                  options={modelOptions}
                  value={model}
                  onChange={onModelChange}
                  disabled={false}
                  busy={modelSwitching}
                  pending={modelSwitchPending != null}
                  isAutoSelection={isAutoModelSelection}
                  onRefresh={onRefreshModels}
                  refreshing={modelsRefreshing}
                />
              )
            )}
          </div>

          {/* spacer */}
          {!isMobile && <div style={{ flex: 1 }} />}

          {/* RIGHT: thinking + tools preset + compact + sound (idle) | Stop + sound (streaming) */}
          <div style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            position: "relative",
            marginLeft: "auto",
          }}>
            <div data-input-overlay="1" style={{
              display: "flex",
              alignItems: "center",
              gap: 2,
            }}>
            {onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} style={{ position: "relative" }}>
                <button
                  onClick={() => !isStreaming && setThinkingDropdownOpen((v) => !v)}
                  disabled={isStreaming}
                  title={isStreaming
                    ? t("chat.currentReasoning", { level: thinkingDisplayLabel })
                    : t("chat.changeReasoning", { level: thinkingDisplayLabel })}
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
                  <span style={{ whiteSpace: "nowrap" }}>{thinkingDisplayLabel}</span>
                </button>
                {thinkingDropdownOpen && (
                  <div data-input-overlay="1" style={{
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
                      const isActive = lvl === "auto"
                        ? isAutoThinkingSelection
                        : !isAutoThinkingSelection && resolvedThinkingLevel === lvl;
                      const desc = t(THINKING_LEVEL_DESC_KEYS[lvl]);
                      const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                      const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                      const showOriginal = mappedVal != null && mappedVal !== lvl;
                      return (
                        <button
                          key={lvl}
                          onClick={() => {
                            setThinkingDropdownOpen(false);
                            if (lvl === "auto") {
                              if (!isAutoThinkingSelection) onThinkingLevelChange("auto");
                              return;
                            }
                            if (!isActive || isAutoThinkingSelection) onThinkingLevelChange(lvl);
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
                  <span style={{ whiteSpace: "nowrap" }}>{toolPresetLabel}</span>
                </button>
                {toolDropdownOpen && (
                  <div data-input-overlay="1" style={{
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

            {/* Context-meter extension ratio bar: the slot just left of the compact button (§4.3; zero footprint when no extension is registered) */}
            <ExtSlot name="compactLead" extra={{ sessionId, cwd, context: extSeamContext, compact: extSeamCompact }} />

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
                    color: isCompacting ? "#ef4444" : compactQueued ? "#d97706" : idleCtxColor,
                    cursor: "pointer",
                    fontSize: 12, opacity: 1,
                    whiteSpace: "nowrap",
                    animation: !isCompacting && !compactQueued ? idleCtxBreathe : undefined,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.16)" : compactQueued ? "rgba(217,119,6,0.2)" : "var(--bg-hover)";
                    e.currentTarget.style.color = isCompacting ? "#ef4444" : compactQueued ? "#d97706" : "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.08)" : compactQueued ? "rgba(217,119,6,0.1)" : "none";
                    e.currentTarget.style.color = isCompacting ? "#ef4444" : compactQueued ? "#d97706" : idleCtxColor;
                  }}
                   title={isCompacting ? t("chat.stopCompaction") : compactQueued ? t("chat.cancelCompactQueue") : t("chat.compactContext")}
                   aria-label={isCompacting ? t("chat.stopCompaction") : compactQueued ? t("chat.cancelCompactQueue") : t("chat.compactContext")}
                >
                  {isCompacting ? (
                    <><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" /></svg><span style={{ whiteSpace: "nowrap" }}>{t("chat.compacting")}</span></>
                  ) : compactQueued ? (
                    <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg><span style={{ whiteSpace: "nowrap" }}>{t("chat.compactQueued")}</span></>
                  ) : (
                    <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
                      <line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" />
                    </svg><span style={{ whiteSpace: "nowrap" }}>{t("chat.compact")}</span></>
                  )}
                </button>
              </div>
            )}

            {isStreaming && (
              <button
                onClick={onAbort}
                disabled={aborting}
                 title={aborting ? t("chat.stopping") : t("chat.stopAgent")}
                 aria-label={aborting ? t("chat.stopping") : t("chat.stopAgent")}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "8px 14px",
                  height: 32,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: 9,
                  color: "#ef4444",
                  cursor: aborting ? "default" : "pointer",
                  fontSize: 12, fontWeight: 600,
                  whiteSpace: "nowrap", letterSpacing: "-0.01em",
                  transition: "background 0.12s",
                  opacity: aborting ? 0.85 : 1,
                }}
                onMouseEnter={(e) => { if (!aborting) e.currentTarget.style.background = "rgba(239,68,68,0.16)"; }}
                onMouseLeave={(e) => { if (!aborting) e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
              >
                {aborting ? (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" style={{ animation: "spin 1s linear infinite" }}>
                    <path d="M12 3a9 9 0 0 1 9 9" />
                    <path d="M12 21a9 9 0 0 1-9-9" opacity="0.45" />
                  </svg>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                  </svg>
                )}
                {aborting ? t("chat.stopping") : t("chat.stop")}
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
            {/* Extension entries (composerTools slot): 32×32 icon buttons on the
                same row as compact/import (git-trace extension: timeline main
                entry); streaming lets plan chips etc. refresh end-of-turn state.
                Callbacks are service-backed (pi-web.composer: queueActions/
                openSessionInfo), so extra carries data only */}
            <ExtSlot name="composerTools" extra={{
              sessionId, cwd, streaming: isStreaming,
              // Context-meter extension seam: context ratio bar + compaction tri-state + session-panel entry
              context: extSeamContext,
              compact: extSeamCompact,
            }} />
            </div>
            {/* Desktop cycle: click walks the bottom
                modes (full → queueHidden → minimal → full, queueHidden skipped
                when the queue is empty). Collapsing the queue rows themselves
                stays on the queue header chevron button. Mobile: BottomModeBar
                merges into the input row's top-edge notch (v3) and this row does
                not render at all. */}
            <BottomModeBar
              mode={effectiveBottomMode}
              onClick={() => cycleBottomMode()}
              count={queueCount}
            />
          </div>
        </div>
        )}

        {/* Mobile ⓘ InfoSheet: a bottom sheet with a WeChat "+" panel feel — model/
            thinking/tools/compaction/sound/
            queue/extension status/extension panels (§5). fixed positioning with
            bottom computed from the input row's top edge; overlay click closes. */}
        {infoSheetOpen && (
          <>
            <div
              data-input-overlay="1"
              onClick={() => setInfoSheetOpen(false)}
              style={{ position: "fixed", inset: 0, zIndex: 118, background: "rgba(0,0,0,0.28)" }}
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-label={t("chat.plusPanel")}
              data-input-overlay="1"
              style={{
                position: "fixed",
                left: 8,
                right: 8,
                bottom: infoSheetBottom,
                zIndex: 119,
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 14,
                boxShadow: "0 -8px 30px rgba(0,0,0,0.22)",
                maxHeight: `min(60vh, ${infoSheetMaxHeight}px)`,
                overflowY: "auto",
                overscrollBehavior: "contain",
              }}
            >
              <div style={{ position: "sticky", top: 0, zIndex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "9px 12px 3px", background: "var(--bg-panel)", borderBottom: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
                <span style={{ width: 36, height: 4, borderRadius: 2, background: "var(--border)" }} />
                <button
                  type="button"
                  aria-label={t("chat.collapseControls")}
                  onClick={() => setInfoSheetOpen(false)}
                  style={{ position: "absolute", right: 10, top: 5, width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", borderRadius: 8, color: "var(--text-muted)", cursor: "pointer", fontSize: 15, lineHeight: 1 }}
                >
                  ✕
                </button>
              </div>
              {/* Model: the same ModelSelector as desktop (v4 7th review — the
                  sheet's hand-rolled list was retired; the user asked for the same
                  component instead of a custom one).
                  Recents/filtering/duplicate-name guard/geometry re-anchoring all
                  ship with the component; the panel's fixed zIndex 500 covers the
                  sheet. */}
              {onModelChange && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", borderBottom: "1px solid color-mix(in srgb, var(--border) 60%, transparent)" }}>
                  <span style={{ flexShrink: 0, display: "inline-flex", width: 7, height: 7, borderRadius: 99, background: "var(--accent)", opacity: 0.75 }} />
                  <span style={{ flexShrink: 0, fontWeight: 600, fontSize: 13.5 }}>{t("chat.sheetModel")}</span>
                  {modelSwitchPending && <span style={{ flexShrink: 0, width: 7, height: 7, borderRadius: 99, background: "#f59e0b" }} />}
                  <div style={{ marginLeft: "auto", minWidth: 0, display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
                    {/* Context-meter extension widget: the sheet's leading slot — clicking collapses the sheet before opening the session panel */}
                    <ExtSlot name="modelInfoLead" extra={modelInfoLeadExtra} />
                    <ModelSelector
                      options={modelOptions}
                      value={model}
                      onChange={onModelChange}
                      disabled={false}
                      busy={modelSwitching}
                      pending={modelSwitchPending != null}
                      isAutoSelection={isAutoModelSelection}
                      onRefresh={onRefreshModels}
                      refreshing={modelsRefreshing}
                      hideIcon
                    />
                  </div>
                </div>
              )}
              {/* Thinking level (locked while running, same as the desktop dropdown) */}
              {onThinkingLevelChange && !isStreaming && (
                <SheetSection
                  label={t("chat.sheetThinking")}
                  summary={thinkingDisplayLabel}
                  open={infoSheetSections.has("thinking")}
                  onToggle={() => setInfoSheetSections((s) => { const n = new Set(s); n.has("thinking") ? n.delete("thinking") : n.add("thinking"); return n; })}
                >
                  {THINKING_LEVELS.filter((lvl) => {
                    if (!availableThinkingLevels) return true;
                    if (lvl === "auto") return true;
                    return availableThinkingLevels.includes(lvl);
                  }).map((lvl) => {
                    const isActive = (thinkingLevel ?? "auto") === lvl;
                    const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                    const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                    return (
                      <SheetOptionRow
                        key={lvl}
                        active={isActive}
                        label={<>{displayLabel}{mappedVal != null && mappedVal !== lvl && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginLeft: 5 }}>({lvl})</span>}</>}
                        desc={t(THINKING_LEVEL_DESC_KEYS[lvl])}
                        onClick={() => { if (!isActive) onThinkingLevelChange(lvl); }}
                      />
                    );
                  })}
                </SheetSection>
              )}
              {/* Tool preset (locked while running, same as the desktop dropdown) */}
              {onToolPresetChange && !isStreaming && (
                <SheetSection
                  label={t("chat.sheetTools")}
                  summary={toolPresetLabel}
                  open={infoSheetSections.has("tools")}
                  onToggle={() => setInfoSheetSections((s) => { const n = new Set(s); n.has("tools") ? n.delete("tools") : n.add("tools"); return n; })}
                >
                  {TOOL_PRESETS.map((lvl) => {
                    const preset = TOOL_PRESET_MAP[lvl];
                    const isActive = (toolPreset ?? "default") === preset;
                    let desc: string;
                    if (lvl === "chat-only") desc = t("chat.chatOnly");
                    else if (lvl === "read-only") desc = t("chat.readOnlyTools", { count: 4 });
                    else if (lvl === "default") desc = t("chat.builtInTools", { count: 4 });
                    else desc = t("chat.allBuiltInTools");
                    return (
                      <SheetOptionRow
                        key={lvl}
                        active={isActive}
                        label={lvl}
                        desc={desc}
                        onClick={() => { if (!isActive) onToolPresetChange(preset); }}
                      />
                    );
                  })}
                </SheetSection>
              )}
              {/* Compaction: tri-state single row (compacting→stop; queued→cancel; idle→compact) */}
              {onCompact && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 14px", borderBottom: "1px solid color-mix(in srgb, var(--border) 60%, transparent)" }}>
                  <span style={{ flexShrink: 0, display: "inline-flex", width: 7, height: 7, borderRadius: 99, background: idleCtxColor, opacity: 0.75, animation: idleCtxBreathe }} />
                  <span style={{ flexShrink: 0, fontWeight: 600, fontSize: 13.5 }}>{t("chat.sheetCompact")}</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (isCompacting) onAbortCompaction?.();
                      else if (compactQueued) onCancelCompactQueue?.();
                      else onCompact();
                    }}
                    style={{
                      marginLeft: "auto",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      padding: "6px 12px",
                      background: isCompacting ? "rgba(239,68,68,0.08)" : compactQueued ? "rgba(217,119,6,0.1)" : "none",
                      border: `1px solid ${isCompacting ? "rgba(239,68,68,0.35)" : compactQueued ? "rgba(217,119,6,0.4)" : "var(--border)"}`,
                      borderRadius: 8,
                      color: isCompacting ? "#ef4444" : compactQueued ? "#d97706" : idleCtxColor,
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      animation: !isCompacting && !compactQueued ? idleCtxBreathe : undefined,
                    }}
                  >
                    {isCompacting ? t("chat.stopCompaction") : compactQueued ? t("chat.cancelCompactQueue") : t("chat.compactContext")}
                  </button>
                </div>
              )}
              {/* Sound: on/off switch row */}
              {onSoundToggle !== undefined && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 14px", borderBottom: "1px solid color-mix(in srgb, var(--border) 60%, transparent)" }}>
                  <span style={{ flexShrink: 0, display: "inline-flex", width: 7, height: 7, borderRadius: 99, background: "var(--accent)", opacity: 0.75 }} />
                  <span style={{ flexShrink: 0, fontWeight: 600, fontSize: 13.5 }}>{t("chat.sheetSound")}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={soundEnabled}
                    aria-label={soundEnabled ? t("chat.disableSound") : t("chat.enableSound")}
                    onClick={onSoundToggle}
                    style={{
                      marginLeft: "auto",
                      display: "inline-flex",
                      alignItems: "center",
                      padding: 2,
                      width: 40,
                      height: 22,
                      background: soundEnabled ? "var(--accent)" : "var(--border)",
                      border: "none",
                      borderRadius: 99,
                      cursor: "pointer",
                      justifyContent: soundEnabled ? "flex-end" : "flex-start",
                      transition: "background 0.15s",
                    }}
                  >
                    <span style={{ width: 18, height: 18, borderRadius: 99, background: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "var(--text-muted)", fontWeight: 700 }} />
                  </button>
                  <span style={{ flexShrink: 0, fontSize: 12, color: "var(--text-muted)", minWidth: 16, textAlign: "center" }}>{soundEnabled ? t("chat.soundOn") : t("chat.soundOff")}</span>
                </div>
              )}
              {/* Queue: count + recall/export/import. v4 re-review (hidden when the
                  queue is empty, consistent with desktop):
                  the whole row hides when the queue is empty — the desktop
                  queue-keeper QueuePanel and the core fallback banner share the same
                  hasAny=queueCount>0||trashCount>0 gate; import is unaffected (the
                  queue-keeper import button in the bottom action area's
                  composerTools comes from the same source as desktop and is always
                  present). */}
              {(queueCount > 0 || trashCount > 0) && (onRecallQueue || onExportQueue || onStageImport) && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "11px 14px", borderBottom: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", flexWrap: "wrap" }}>
                  <span style={{ flexShrink: 0, display: "inline-flex", width: 7, height: 7, borderRadius: 99, background: "var(--accent)", opacity: 0.75 }} />
                  <span style={{ flexShrink: 0, fontWeight: 600, fontSize: 13.5 }}>{t("chat.sheetQueue")}</span>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("chat.queued", { count: String(queueCount) })}</span>
                  <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
                    {onRecallQueue && (
                      <button type="button" onClick={() => { onRecallQueue(); setInfoSheetOpen(false); }} style={sheetMiniBtn()}>{t("chat.queueRecall")}</button>
                    )}
                    {onExportQueue && (
                      <button type="button" onClick={() => { void handleSheetQueueExport(); }} style={sheetMiniBtn()}>{t("chat.queueExport")}</button>
                    )}
                    {onStageImport && (
                      <button type="button" onClick={() => queueImportInputRef.current?.click()} style={sheetMiniBtn()}>{t("chat.queueImport")}</button>
                    )}
                  </span>
                </div>
              )}
              {/* Extension status: full ANSI statuses (where the desktop status rack ends up) */}
              {extensionStatuses.length > 0 && (
                <SheetSection
                  label={t("chat.sheetExtStatus")}
                  summary={String(extensionStatuses.length)}
                  open={infoSheetSections.has("extStatus")}
                  onToggle={() => setInfoSheetSections((s) => { const n = new Set(s); n.has("extStatus") ? n.delete("extStatus") : n.add("extStatus"); return n; })}
                >
                  <div style={{ fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    <AnsiText text={extStatusLine} />
                  </div>
                </SheetSection>
              )}
              {/* Extension panels: full extensionWidgets (v2 gap closed — the widgets' home) */}
              {extensionWidgets.length > 0 && (
                <SheetSection
                  label={t("chat.sheetExtWidgets")}
                  summary={String(extensionWidgets.length)}
                  open={infoSheetSections.has("extWidgets")}
                  onToggle={() => setInfoSheetSections((s) => { const n = new Set(s); n.has("extWidgets") ? n.delete("extWidgets") : n.add("extWidgets"); return n; })}
                >
                  <ExtensionWidgets widgets={extensionWidgets} />
                </SheetSection>
              )}
              {/* v4 bottom action area: core-fixed (📷 camera / 📄 files / /
                  commands) + the full composerTools slot (git-trace timeline /
                  queue-keeper import / plan chip — same extra and items as
                  desktop). */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px 14px", flexWrap: "wrap", borderTop: "1px solid color-mix(in srgb, var(--border) 60%, transparent)" }}>
                <button
                  type="button"
                  onClick={() => { setInfoSheetOpen(false); requestAnimationFrame(() => cameraInputRef.current?.click()); }}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
                  {t("chat.camera")}
                </button>
                <button
                  type="button"
                  onClick={() => { setInfoSheetOpen(false); requestAnimationFrame(() => anyFileInputRef.current?.click()); }}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                  {t("chat.attachFiles")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setInfoSheetOpen(false);
                    setInputValue("/");
                    requestAnimationFrame(() => { const ta = textareaRef.current; if (!ta) return; ta.focus(); ta.setSelectionRange(1, 1); });
                  }}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
                >
                  <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}>/</span>
                  {t("chat.insertCommand")}
                </button>
                <ExtSlot name="composerTools" extra={{ sessionId, cwd, streaming: isStreaming, context: extSeamContext, compact: extSeamCompact, isMobile: true }} />
              </div>
            </div>
          </>
        )}
        </div>
    </fieldset>
  );
});
// ============================================================================
// PermissionModeDropdown — runtime permission-mode switching for backend
// sessions (aligned with the cc-connect ModeSwitcher)
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

// memo: while the AI streams, ChatWindow re-renders on every token (streamState
// reference changes), but every prop passed to this component is a stable
// reference (useCallback/useState/useMemo inside the hook) — with memo, the input
// box no longer re-renders along with the stream (performance + keeps controlled
// overwrites from interrupting voice/IME composition).
export const ChatInput = React.memo(ChatInputInner);

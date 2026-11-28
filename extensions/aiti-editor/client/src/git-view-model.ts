/**
 * Git change view state machine (pure functions, no DOM).
 *
 * Model: rendering (latest / side / inline) is one axis, the outline panel is
 * an orthogonal navigation toggle. Research on VSCode / GitHub Desktop /
 * Sublime Merge / JetBrains confirms this split; see
 * docs/aiti-editor-diff-ux-research.md.
 *
 * Plan: docs/aiti-editor-git-diff-eol-normalize-plan.md
 */

export type GitView = "latest" | "side" | "inline";
export type DiffRenderMode = "latest" | "side" | "inline";
export type BaselineState = "pending" | "ready" | "error";

/** VSCode uses 900px as the Automatic-layout breakpoint. */
export const AUTO_INLINE_BREAKPOINT = 900;
/** Below this the outline docks at the bottom instead of the right edge. */
export const OUTLINE_BOTTOM_BREAKPOINT = 640;

export interface GitViewInput {
  isRepo: boolean;
  binary: boolean;
  ready: boolean;
  changed: boolean;
  dirty: boolean;
  status?: string;
  baseline: BaselineState;
  /** null = probe failed/unknown, true = HEAD blob exists, false = no baseline. */
  hasBaseline: boolean | null;
  view: GitView;
  outlineOpen: boolean;
  /** Markdown preview/split: the outline is replaced by the in-preview change-navigation button. */
  outlineSuppressed?: boolean;
  width: number;
}

export interface GitViewState {
  hasDelta: boolean;
  isNewFile: boolean;
  /** A non-new file whose HEAD baseline could not be read. */
  baselineMissing: boolean;
  /** Rendering switch (latest/side/inline) is usable. */
  inspectable: boolean;
  /** Badge is shown (also for new files, where the selector is hidden). */
  controlsVisible: boolean;
  /** Render-mode selector is shown. */
  selectVisible: boolean;
  /** A render mode can be requested (baseline may still be loading). */
  diffSelectable: boolean;
  outlineToggleVisible: boolean;
  outlineVisible: boolean;
  diffActive: boolean;
  renderMode: DiffRenderMode;
  /** `side` degraded to inline because the viewport is too narrow. */
  autoInlined: boolean;
}

export function deriveGitViewState(i: GitViewInput): GitViewState {
  const isNewFile = i.status === "A";
  const hasDelta = !!i.isRepo && !i.binary && !!i.ready && (i.changed || i.dirty);
  const baselineMissing = hasDelta && !isNewFile && i.baseline === "error";
  const inspectable = hasDelta && !isNewFile && !baselineMissing && i.baseline === "ready";
  const diffSelectable = hasDelta && !isNewFile && !baselineMissing;
  const controlsVisible = hasDelta && !isNewFile;
  const selectVisible = diffSelectable;
  const outlineAllowed = !i.outlineSuppressed;
  const outlineVisible = inspectable && outlineAllowed && i.outlineOpen;
  const renderMode = resolveRenderMode(i.view, i.width);
  return {
    hasDelta,
    isNewFile,
    baselineMissing,
    inspectable,
    controlsVisible,
    selectVisible,
    diffSelectable,
    outlineToggleVisible: inspectable && outlineAllowed,
    outlineVisible,
    diffActive: diffSelectable && i.view !== "latest",
    renderMode,
    autoInlined: i.view === "side" && renderMode === "inline",
  };
}

/**
 * Side-by-side auto-degrades to inline on narrow viewports (VSCode Automatic).
 * An explicit "inline" choice is never upgraded back to side-by-side.
 */
export function resolveRenderMode(
  view: GitView,
  width: number | null | undefined,
  breakpoint: number = AUTO_INLINE_BREAKPOINT,
): DiffRenderMode {
  if (view === "latest") return "latest";
  if (view === "inline") return "inline";
  return (width ?? 0) >= breakpoint ? "side" : "inline";
}

export interface JumpTarget {
  kind: "editor" | "diff";
  line: number;
}

/** Outline click dispatch: editable editor vs read-only diff editor. */
export function pickJumpTarget(renderMode: DiffRenderMode, newStart: number): JumpTarget {
  const line = Math.max(1, Math.floor(Number(newStart) || 1));
  return { kind: renderMode === "latest" ? "editor" : "diff", line };
}

export type OutlinePlacement = "right" | "bottom";

/** Narrow viewports dock the outline at the bottom to keep the editor readable. */
export function outlinePlacement(width: number | null | undefined, breakpoint: number = OUTLINE_BOTTOM_BREAKPOINT): OutlinePlacement {
  return (width ?? 0) < breakpoint ? "bottom" : "right";
}

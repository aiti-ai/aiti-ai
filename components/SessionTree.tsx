"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { SessionFamily } from "@/lib/session-family";
import {
  PINNED_MORE_KEY,
  getRowOffsets,
  getVisibleRowIndices,
  type SidebarLayout,
  type SidebarProject,
  type SidebarRow,
} from "@/lib/session-tree";
import type { SessionInfo } from "@/lib/types";
import { formatRelativeTime, formatShortRelativeTime } from "@/lib/i18n/format";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { useI18n } from "@/hooks/useI18n";
import { useScrollbarVisibility } from "@/hooks/useScrollbarVisibility";
import type { SidebarMenuAnchor } from "./SidebarMenu";
import {
  ArchiveIcon,
  ChevronIcon,
  FolderPlusIcon,
  MoreIcon,
  PinIcon,
  PlusIcon,
  RestoreIcon,
  SpinnerIcon,
  TrashIcon,
} from "./SidebarIcons";

/**
 * The sessions tab's tree: the pinned section, every project as a group of
 * session families, and the footer links, or the archive view's rows. It
 * renders the flat rows of lib/session-tree.ts in one virtualized scroll and
 * owns nothing but scroll position, viewport size and which row has focus;
 * every decision (what is shown, what is open, what is being renamed) comes
 * in through props, so a row scrolled out of view loses no state.
 */

type SessionRow = Extract<SidebarRow, { kind: "session" }>;

export interface SessionTreeProps {
  rows: SidebarRow[];
  layout: SidebarLayout;
  /** Shown above the footer rows when there are no session/group rows; null = none. */
  emptyLabel: string | null;
  /** Shows t("sidebar.loading") instead of rows. */
  loading: boolean;
  error: string | null;
  renamingRootId: string | null;
  confirmDeleteRootId: string | null;
  /** Row whose menu is open: kept mounted, its ⋯ shown pressed. A group row's key works too. */
  activeMenuRowKey: string | null;
  /** Which button of the `activeMenuRowKey` group opened the menu; defaults to its ⋯. */
  activeGroupMenu?: "new" | "more" | null;
  /** Project key whose "+" is still looking up worktrees: that button is disabled meanwhile. */
  pendingGroupKey?: string | null;
  onSelectFamily(family: SessionFamily): void;
  onToggleGroup(projectKey: string): void;
  /** projectKey or PINNED_MORE_KEY. */
  onToggleMore(key: string): void;
  onTogglePinned(): void;
  onArchiveFamily(family: SessionFamily): void;
  onRestoreFamily(family: SessionFamily): void;
  onOpenRowMenu(row: SessionRow, anchor: SidebarMenuAnchor, opener: HTMLElement | null): void;
  /** The sidebar dispatches the downstream event first. */
  onRowContextMenu(row: SessionRow, event: ReactMouseEvent): void;
  /** `value` is the raw input text; the caller trims and skips unchanged titles. */
  onRenameCommit(family: SessionFamily, value: string): void;
  onRenameCancel(): void;
  onDeleteConfirm(family: SessionFamily, event: ReactMouseEvent): void;
  onDeleteCancel(): void;
  onGroupNew(project: SidebarProject, opener: HTMLElement): void;
  onGroupMenu(project: SidebarProject, opener: HTMLElement): void;
  onOpenOtherProject(opener: HTMLElement): void;
  onOpenArchive(): void;
}

/** Rows rendered beyond each edge of the viewport. */
const OVERSCAN_PX = 240;
/** How often relative times ("5m") move on while nothing else re-renders. */
const CLOCK_TICK_MS = 60_000;
const DELETE_TITLE_MAX = 22;

/**
 * A session's display title: its stored name, else its first message (an
 * SDK-expanded <skill> block collapsed back to the /skill:name command the
 * user typed, as MessageView shows it), else its id.
 */
export function sessionRowTitle(session: SessionInfo): string {
  const displayFirstMessage = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  return session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12);
}

function isImeKey(event: ReactKeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

function anchorOf(button: HTMLElement): SidebarMenuAnchor {
  const rect = button.getBoundingClientRect();
  return { kind: "rect", rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, align: "end" };
}

export function SessionTree(props: SessionTreeProps): ReactNode {
  const {
    rows,
    layout,
    emptyLabel,
    loading,
    error,
    renamingRootId,
    confirmDeleteRootId,
    activeMenuRowKey,
    activeGroupMenu,
    pendingGroupKey,
  } = props;
  const { t } = useI18n();
  // Rows read the handlers at event time, so memoized rows need not re-render
  // when the parent passes new callbacks.
  const handlersRef = useRef(props);
  handlersRef.current = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollbarVisibility(scrollRef);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const scrollFrameRef = useRef<number | null>(null);

  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const element = scrollRef.current;
      if (element) setScrollTop(element.scrollTop);
    });
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    setViewportHeight(element.clientHeight);
    setScrollTop(element.scrollTop);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setViewportHeight(element.clientHeight);
      // Inside a hidden tab the height was 0; coming back, the position may
      // have changed without a scroll event.
      setScrollTop(element.scrollTop);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Focus is tracked by row key, so a focused row stays mounted while it is
  // scrolled away (an inline rename, a keyboard user on ⋯).
  const handleFocus = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    const row = event.target instanceof Element ? event.target.closest("[data-row-key]") : null;
    setFocusedRowKey(row?.getAttribute("data-row-key") ?? null);
  }, []);
  const handleBlur = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    // Moving within the tree: the next focus event names the new row.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setFocusedRowKey(null);
  }, []);

  const offsets = useMemo(() => getRowOffsets(rows, layout), [rows, layout]);
  const keepMounted = useMemo(() => {
    const indices: number[] = [];
    rows.forEach((row, index) => {
      if (row.key === focusedRowKey || row.key === activeMenuRowKey) indices.push(index);
      else if (row.kind === "session" && (row.family.root.id === renamingRootId || row.family.root.id === confirmDeleteRootId)) indices.push(index);
    });
    return indices;
  }, [rows, focusedRowKey, activeMenuRowKey, renamingRootId, confirmDeleteRootId]);
  const visibleIndices = useMemo(
    () => (loading ? [] : getVisibleRowIndices(offsets, scrollTop, viewportHeight, OVERSCAN_PX, keepMounted)),
    [loading, offsets, scrollTop, viewportHeight, keepMounted],
  );

  const hasTreeRows = rows.some((row) => row.kind === "session" || row.kind === "group");
  const showEmpty = !loading && !error && emptyLabel !== null && !hasTreeRows;

  return (
    <div className={`session-tree${layout === "mobile" ? " is-mobile" : ""}`}>
      {loading && <div className="session-tree-message">{t("sidebar.loading")}</div>}
      {error && <div className="session-tree-message is-error">{error}</div>}
      {showEmpty && <div className="session-tree-message">{emptyLabel}</div>}
      <div
        ref={scrollRef}
        className="session-tree-scroll scrollbar-subtle"
        onScroll={handleScroll}
        onFocus={handleFocus}
        onBlur={handleBlur}
      >
        {!loading && (
          <div className="session-tree-inner" style={{ height: offsets[rows.length] }}>
            {visibleIndices.map((index) => {
              const row = rows[index];
              if (row.kind === "spacer") return null;
              const top = offsets[index];
              const height = offsets[index + 1] - top;
              const menuOpen = row.key === activeMenuRowKey;
              if (row.kind === "session") {
                return (
                  <SessionRowView
                    key={row.key}
                    row={row}
                    layout={layout}
                    top={top}
                    height={height}
                    now={now}
                    renaming={row.family.root.id === renamingRootId}
                    confirming={row.family.root.id === confirmDeleteRootId}
                    menuOpen={menuOpen}
                    handlers={handlersRef}
                  />
                );
              }
              if (row.kind === "group") {
                return (
                  <GroupRowView
                    key={row.key}
                    row={row}
                    top={top}
                    height={height}
                    openMenu={menuOpen ? activeGroupMenu ?? "more" : null}
                    pending={row.project.key === pendingGroupKey}
                    handlers={handlersRef}
                  />
                );
              }
              return <PlainRowView key={row.key} row={row} top={top} height={height} handlers={handlersRef} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

type Handlers = RefObject<SessionTreeProps>;

function rowStyle(top: number, height: number) {
  return { top, height };
}

const SessionRowView = memo(function SessionRowView({
  row,
  layout,
  top,
  height,
  now,
  renaming,
  confirming,
  menuOpen,
  handlers,
}: {
  row: SessionRow;
  layout: SidebarLayout;
  top: number;
  height: number;
  now: number;
  renaming: boolean;
  confirming: boolean;
  menuOpen: boolean;
  handlers: Handlers;
}) {
  const { locale, t } = useI18n();
  const { family, context, status } = row;
  const root = family.root;
  const title = sessionRowTitle(root);
  const nowDate = new Date(now);
  const className = [
    "session-tree-row session-tree-session",
    status.selected ? "is-selected" : "",
    context === "archive" ? "is-archived" : "",
    menuOpen ? "is-menu-open" : "",
    confirming ? "is-confirming" : "",
    renaming ? "is-renaming" : "",
  ].filter(Boolean).join(" ");

  if (confirming) {
    const shortTitle = title.slice(0, DELETE_TITLE_MAX) + (title.length > DELETE_TITLE_MAX ? "…" : "");
    return (
      <div
        className={className}
        style={rowStyle(top, height)}
        data-row-key={row.key}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || isImeKey(event)) return;
          event.preventDefault();
          event.stopPropagation();
          handlers.current.onDeleteCancel();
        }}
      >
        <DeleteConfirm
          label={t("sidebar.deleteSession", { title: shortTitle })}
          deleteLabel={t("sidebar.delete")}
          cancelLabel={t("sidebar.cancel")}
          onConfirm={(event) => {
            event.stopPropagation();
            handlers.current.onDeleteConfirm(family, event);
          }}
          onCancel={(event) => {
            event.stopPropagation();
            handlers.current.onDeleteCancel();
          }}
        />
      </div>
    );
  }

  if (renaming) {
    return (
      <div className={className} style={rowStyle(top, height)} data-row-key={row.key}>
        <RenameInput
          initialValue={title}
          label={t("sidebar.rename")}
          onCommit={(value) => handlers.current.onRenameCommit(family, value)}
          onCancel={() => handlers.current.onRenameCancel()}
        />
      </div>
    );
  }

  const branch = root.isWorktree && root.branch ? root.branch : null;
  const details = root.detailsPending ? "…" : t("sidebar.messagesCount", { count: root.messageCount });
  const tooltip = `${title}\n${details} · ${formatRelativeTime(root.modified, locale, nowDate)}${branch ? ` · ⑂ ${branch}` : ""}`;

  let slot: ReactNode = null;
  if (status.running) {
    slot = (
      <span className="session-tree-slot is-running" title={t("sidebar.agentRunning")}>
        <SpinnerIcon size={12} label={t("sidebar.agentRunning")} />
      </span>
    );
  } else if (status.unread) {
    slot = (
      <span className="session-tree-slot" title={t("sidebar.newActivity")}>
        <span className="session-tree-unread" role="img" aria-label={t("sidebar.newSessionActivity")} />
      </span>
    );
  } else if (context === "archive") {
    slot = <span className="session-tree-slot is-archived"><ArchiveIcon size={11} /></span>;
  } else {
    slot = <span className="session-tree-slot" />;
  }

  let meta: ReactNode;
  if (context === "pinned") {
    meta = <span className="session-tree-project">{row.project.name}</span>;
  } else if (context === "archive" && row.archivedAt !== null) {
    meta = formatShortRelativeTime(new Date(row.archivedAt), locale, nowDate);
  } else {
    meta = formatShortRelativeTime(family.latestModified, locale, nowDate);
  }

  // Archive (or restore) one click away: desktop only, never for a running
  // family, which would come straight back.
  const quickAction = layout === "desktop" && (context === "archive" || !status.running);

  return (
    <div
      className={className}
      style={rowStyle(top, height)}
      data-row-key={row.key}
      onClick={() => handlers.current.onSelectFamily(family)}
      onContextMenu={(event) => handlers.current.onRowContextMenu(row, event)}
    >
      <button type="button" className="session-tree-main" title={tooltip} aria-current={status.selected ? "true" : undefined}>
        {slot}
        <span className="session-tree-title">{title}</span>
        {branch && <span className="session-tree-branch">⑂ {branch}</span>}
        <span className="session-tree-meta">{meta}</span>
      </button>
      {!status.transient && (
        <span className="session-tree-actions">
          {quickAction && (context === "archive" ? (
            <button
              type="button"
              className="session-tree-action session-tree-quick-action"
              aria-label={t("sidebar.restore")}
              title={t("sidebar.restore")}
              onClick={(event) => {
                event.stopPropagation();
                handlers.current.onRestoreFamily(family);
              }}
            >
              <RestoreIcon size={13} />
            </button>
          ) : (
            <button
              type="button"
              className="session-tree-action session-tree-quick-action"
              aria-label={t("sidebar.archive")}
              title={t("sidebar.archive")}
              onClick={(event) => {
                event.stopPropagation();
                handlers.current.onArchiveFamily(family);
              }}
            >
              <ArchiveIcon size={13} />
            </button>
          ))}
          <button
            type="button"
            className={`session-tree-action session-tree-more-action${menuOpen ? " is-active" : ""}`}
            aria-label={t("sidebar.moreActions")}
            title={t("sidebar.moreActions")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => {
              event.stopPropagation();
              const button = event.currentTarget;
              handlers.current.onOpenRowMenu(row, anchorOf(button), button);
            }}
          >
            <MoreIcon size={14} />
          </button>
        </span>
      )}
    </div>
  );
});

function RenameInput({
  initialValue,
  label,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  label: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter or Escape ends the rename; the blur that follows when the input
  // goes away must not commit a second time (or after a cancel).
  const doneRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const commit = (text: string) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(text);
  };

  return (
    <input
      ref={inputRef}
      className="session-tree-rename"
      value={value}
      aria-label={label}
      onChange={(event) => setValue(event.target.value)}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (isImeKey(event)) return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit(event.currentTarget.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (doneRef.current) return;
          doneRef.current = true;
          onCancel();
        }
      }}
    />
  );
}

function DeleteConfirm({
  label,
  deleteLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  label: string;
  deleteLabel: string;
  cancelLabel: string;
  onConfirm: (event: ReactMouseEvent) => void;
  onCancel: (event: ReactMouseEvent) => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Opened from a menu, focus has nowhere to be (the menu and the row's ⋯ are
  // gone): put it on the safe choice so the keyboard can answer.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) cancelRef.current?.focus();
  }, []);

  return (
    <>
      <span className="session-tree-confirm-text">{label}</span>
      <button type="button" className="session-tree-confirm-delete" onClick={onConfirm}>
        <TrashIcon size={12} />
        {deleteLabel}
      </button>
      <button ref={cancelRef} type="button" className="session-tree-confirm-cancel" onClick={onCancel}>
        {cancelLabel}
      </button>
    </>
  );
}

/** Spinner + count and dot + count; the label carries the count for screen readers. */
function ActivitySummary({ running, unread, t }: { running: number; unread: number; t: (key: string) => string }) {
  if (running === 0 && unread === 0) return null;
  return (
    <span className="session-tree-summary">
      {running > 0 && (
        <span
          className="session-tree-summary-running"
          role="img"
          title={t("sidebar.agentRunning")}
          aria-label={`${t("sidebar.agentRunning")} (${running})`}
        >
          <SpinnerIcon size={10} />
          {running}
        </span>
      )}
      {unread > 0 && (
        <span
          className="session-tree-summary-unread"
          role="img"
          title={t("sidebar.newSessionActivity")}
          aria-label={`${t("sidebar.newSessionActivity")} (${unread})`}
        >
          <span className="session-tree-summary-dot" />
          {unread}
        </span>
      )}
    </span>
  );
}

const GroupRowView = memo(function GroupRowView({
  row,
  top,
  height,
  openMenu,
  pending,
  handlers,
}: {
  row: Extract<SidebarRow, { kind: "group" }>;
  top: number;
  height: number;
  openMenu: "new" | "more" | null;
  pending: boolean;
  handlers: Handlers;
}) {
  const { t } = useI18n();
  const { project, expanded } = row;
  const className = [
    "session-tree-row session-tree-group",
    project.current ? "is-current" : "",
    openMenu || pending ? "is-active" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={className} style={rowStyle(top, height)} data-row-key={row.key}>
      <button
        type="button"
        className="session-tree-group-toggle"
        aria-expanded={expanded}
        title={project.root}
        onClick={() => handlers.current.onToggleGroup(project.key)}
      >
        <ChevronIcon size={10} className={`session-tree-chevron${expanded ? " is-open" : ""}`} />
        <span className="session-tree-group-name">{project.name}</span>
        {project.pinned && <PinIcon size={10} className="session-tree-group-pin" label={t("sidebar.pinnedProject")} />}
        {!expanded && <ActivitySummary running={row.running} unread={row.unread} t={t} />}
      </button>
      <span className="session-tree-group-actions">
        <button
          type="button"
          className={`session-tree-group-action${openMenu === "new" ? " is-active" : ""}`}
          aria-label={t("sidebar.newSessionInProject", { name: project.name })}
          title={t("sidebar.newSessionInProject", { name: project.name })}
          aria-expanded={openMenu === "new" ? true : undefined}
          aria-busy={pending || undefined}
          disabled={pending}
          onClick={(event) => {
            event.stopPropagation();
            handlers.current.onGroupNew(project, event.currentTarget);
          }}
        >
          {pending ? <SpinnerIcon size={12} /> : <PlusIcon size={13} />}
        </button>
        <button
          type="button"
          className={`session-tree-group-action${openMenu === "more" ? " is-active" : ""}`}
          aria-label={t("sidebar.projectActions", { name: project.name })}
          title={t("sidebar.projectActions", { name: project.name })}
          aria-haspopup="menu"
          aria-expanded={openMenu === "more"}
          onClick={(event) => {
            event.stopPropagation();
            handlers.current.onGroupMenu(project, event.currentTarget);
          }}
        >
          <MoreIcon size={13} />
        </button>
      </span>
    </div>
  );
});

/** The rows with at most one control: section headers, "show more", footer links. */
const PlainRowView = memo(function PlainRowView({
  row,
  top,
  height,
  handlers,
}: {
  row: Exclude<SidebarRow, { kind: "session" | "group" | "spacer" }>;
  top: number;
  height: number;
  handlers: Handlers;
}) {
  const { t } = useI18n();
  const style = rowStyle(top, height);

  switch (row.kind) {
    case "pinned-header":
      return (
        <div className="session-tree-row session-tree-pinned-header" style={style} data-row-key={row.key}>
          <button
            type="button"
            className="session-tree-pinned-toggle"
            aria-expanded={!row.collapsed}
            onClick={() => handlers.current.onTogglePinned()}
          >
            <ChevronIcon size={9} className={`session-tree-chevron${row.collapsed ? "" : " is-open"}`} />
            <span className="session-tree-pinned-label">{t("sidebar.pinned")}</span>
            <span className="session-tree-pinned-count">· {row.count}</span>
            {row.collapsed && row.running > 0 && (
              <span
                className="session-tree-pinned-dot is-running"
                role="img"
                title={t("sidebar.agentRunning")}
                aria-label={`${t("sidebar.agentRunning")} (${row.running})`}
              />
            )}
            {row.collapsed && row.unread > 0 && (
              <span
                className="session-tree-pinned-dot is-unread"
                role="img"
                title={t("sidebar.newSessionActivity")}
                aria-label={`${t("sidebar.newSessionActivity")} (${row.unread})`}
              />
            )}
          </button>
        </div>
      );
    case "pinned-more":
    case "group-more":
      return (
        <div className="session-tree-row session-tree-more" style={style} data-row-key={row.key}>
          <button
            type="button"
            className="session-tree-more-toggle"
            onClick={() => handlers.current.onToggleMore(row.kind === "pinned-more" ? PINNED_MORE_KEY : row.projectKey)}
          >
            {row.expanded ? t("sidebar.showLess") : t("sidebar.showMore", { count: row.hidden })}
          </button>
        </div>
      );
    case "group-empty":
      return (
        <div className="session-tree-row session-tree-group-empty" style={style} data-row-key={row.key}>
          {t("sidebar.noLiveSessions")}
        </div>
      );
    case "footer-open":
      return (
        <div className="session-tree-row session-tree-footer" style={style} data-row-key={row.key}>
          <button
            type="button"
            className="session-tree-footer-button"
            onClick={(event) => handlers.current.onOpenOtherProject(event.currentTarget)}
          >
            <FolderPlusIcon size={12} />
            <span className="session-tree-footer-label">{t("sidebar.openOtherProject")}</span>
          </button>
        </div>
      );
    case "footer-archived":
      return (
        <div className="session-tree-row session-tree-footer" style={style} data-row-key={row.key}>
          <button type="button" className="session-tree-footer-button" onClick={() => handlers.current.onOpenArchive()}>
            <ArchiveIcon size={12} />
            <span className="session-tree-footer-label">{t("sidebar.archivedCount", { count: row.count })}</span>
            <ChevronIcon size={10} className="session-tree-footer-chevron" />
          </button>
        </div>
      );
    case "archive-group":
      return (
        <div className="session-tree-row session-tree-archive-group" style={style} data-row-key={row.key} title={row.project.root}>
          <span className="session-tree-archive-group-name">{row.project.name}</span>
          <span className="session-tree-archive-group-count">· {row.count}</span>
        </div>
      );
  }
});
